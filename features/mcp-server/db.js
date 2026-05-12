/**
 * Database helper for Peek MCP Server.
 *
 * Uses node:sqlite (built-in since Node 22.5) with a single persistent
 * connection. Prepared statements, parameter binding, WAL-aware busy_timeout,
 * and transaction wrapping for multi-step ops. Replaces an earlier
 * `execSync('sqlite3 …')` shell-out which forked a CLI per statement and
 * collapsed under multi-agent concurrency (no busy_timeout, no retries,
 * SQLITE_BUSY surfaced as tool errors).
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

let db = null;

const BUSY_TIMEOUT_MS = 5000;

// --- Policy helpers ---
// These mirror behavior in backend/electron/datastore.ts. Duplicating them
// here is a known drift hazard (see Peek task 14efdd97). Column-set parity
// with schema/v1.json is asserted by features/mcp-server/schema-drift.test.js;
// formula parity by the policy tests in server.test.js.

// Tag frecency: matches datastore.ts `calculateFrecency` (line 510).
function calculateTagFrecency(frequency, lastUsed) {
  const daysSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
  const decayFactor = 1 / (1 + daysSinceUse / 7);
  return Math.round(frequency * 10 * decayFactor);
}

// Tag slug: matches datastore.ts `getOrCreateTag` / `renameTag` (lines 2908, 2942).
function slugifyTagName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-');
}

// Hashtag extraction: matches datastore.ts `syncContentHashtags` (line 3206).
function extractHashtags(content) {
  if (!content) return [];
  const matches = content.match(/(?:^|\s)#([^\s#]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.trim().slice(1)))];
}

export function openDb(path) {
  if (!existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }
  db = new DatabaseSync(path);
  // WAL is sticky in the file header (set by the Electron app at first init),
  // but busy_timeout is per-connection — must set explicitly.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  ensureTagsUniqueIndex();
}

/**
 * Ensure tags.name has a UNIQUE index (idx_tags_name_unique).
 *
 * Mirrors migrateTagsUniqueIndex() in backend/electron/datastore.ts.
 * Running here means the MCP server self-heals even before the Electron app
 * is rebuilt and restarted with the new DDL. Idempotent: no-op if index exists.
 */
function ensureTagsUniqueIndex() {
  const existing = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tags_name_unique'`
  ).get();
  if (existing) return;

  // Deduplicate tags.name before creating the UNIQUE index.
  // Canonical row = lowest id (earliest created). Duplicate item_tags refs are
  // rewritten to the canonical row; the duplicate tag rows are then deleted.
  const dupeGroups = db.prepare(`
    SELECT name, MIN(id) AS canonicalId
    FROM tags
    GROUP BY name
    HAVING COUNT(*) > 1
  `).all();

  if (dupeGroups.length > 0) {
    db.exec('BEGIN');
    try {
      for (const { name, canonicalId } of dupeGroups) {
        const dupeRows = db.prepare(
          `SELECT id FROM tags WHERE name = ? AND id != ?`
        ).all(name, canonicalId);

        for (const { id: dupeId } of dupeRows) {
          // Remove item_tags rows that would collide when we repoint
          // (item already has both the dupe and canonical tag).
          db.prepare(`
            DELETE FROM item_tags
            WHERE tagId = ?
            AND itemId IN (SELECT itemId FROM item_tags WHERE tagId = ?)
          `).run(dupeId, canonicalId);

          // Repoint remaining refs to the canonical row.
          db.prepare(`UPDATE item_tags SET tagId = ? WHERE tagId = ?`).run(canonicalId, dupeId);

          // Delete the duplicate tag row.
          db.prepare(`DELETE FROM tags WHERE id = ?`).run(dupeId);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_unique ON tags(name)`);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function requireDb() {
  if (!db) throw new Error('Database not opened. Call openDb() first.');
  return db;
}

function transaction(fn) {
  const d = requireDb();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function parseMetadata(item) {
  if (item && typeof item.metadata === 'string') {
    try { item.metadata = JSON.parse(item.metadata); } catch { /* keep as string */ }
  }
  return item;
}

// --- Queries ---

export function queryItems({ tags, type, limit = 50, offset = 0, sort = 'recent' } = {}) {
  const d = requireDb();
  const orderCol = sort === 'frecency' ? 'frecencyScore' : 'createdAt';

  let rows;
  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => '?').join(',');
    const sql = `
      SELECT i.id, i.type, i.content, i.title, i.domain, i.metadata,
             i.createdAt, i.updatedAt, i.starred, i.archived, i.visitCount, i.frecencyScore
      FROM items i
      JOIN item_tags it ON i.id = it.itemId
      JOIN tags t ON it.tagId = t.id
      WHERE t.name IN (${placeholders}) AND i.deletedAt = 0
      GROUP BY i.id
      HAVING COUNT(DISTINCT t.id) = ?
      ORDER BY i.${orderCol} DESC
      LIMIT ? OFFSET ?
    `;
    rows = d.prepare(sql).all(...tags, tags.length, limit, offset);
  } else {
    let sql = `
      SELECT id, type, content, title, domain, metadata,
             createdAt, updatedAt, starred, archived, visitCount, frecencyScore
      FROM items
      WHERE deletedAt = 0
    `;
    const params = [];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    sql += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    rows = d.prepare(sql).all(...params);
  }

  if (rows.length === 0) return [];

  // Single tag fetch for the whole result set — replaces N+1 fan-out
  // (prior CLI-based impl forked one sqlite3 process per row).
  const ids = rows.map(r => r.id);
  const tagPlaceholders = ids.map(() => '?').join(',');
  const tagRows = d.prepare(`
    SELECT it.itemId, t.name
    FROM item_tags it
    JOIN tags t ON t.id = it.tagId
    WHERE it.itemId IN (${tagPlaceholders})
  `).all(...ids);

  const tagsById = new Map();
  for (const tr of tagRows) {
    if (!tagsById.has(tr.itemId)) tagsById.set(tr.itemId, []);
    tagsById.get(tr.itemId).push(tr.name);
  }

  return rows.map(r => {
    r.tags = tagsById.get(r.id) || [];
    return parseMetadata(r);
  });
}

export function getItem(id) {
  const d = requireDb();
  const item = d.prepare(`
    SELECT id, type, content, title, domain, metadata, mimeType,
           createdAt, updatedAt, starred, archived, visitCount, frecencyScore,
           lastVisitAt, favicon, deletedAt
    FROM items WHERE id = ?
  `).get(id);
  if (!item) return null;
  item.tags = getItemTags(id);
  return parseMetadata(item);
}

export function getItemTags(itemId) {
  const d = requireDb();
  return d.prepare(`
    SELECT t.name FROM tags t
    JOIN item_tags it ON t.id = it.tagId
    WHERE it.itemId = ?
  `).all(itemId).map(r => r.name);
}

export function createItem({ type, url, title = '', content = '', metadata = {}, tags = [] }) {
  const id = randomUUID();
  const now = Date.now();
  const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

  let domain = '';
  let itemContent = content;
  if (type === 'url' && url) {
    itemContent = url;
    try { domain = new URL(url).hostname; } catch { /* ignore */ }
  }

  const d = requireDb();
  transaction(() => {
    d.prepare(`
      INSERT INTO items (id, type, content, title, domain, metadata, createdAt, updatedAt, deletedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(id, type, itemContent, title, domain, metaStr, now, now);

    // Mirror datastore.ts `syncContentHashtags`: for text items, treat
    // inline #hashtags as tags so the item is discoverable the same way
    // it would be if the user had created it through the app.
    const autoTags = type === 'text' ? extractHashtags(itemContent) : [];
    const allTags = [...new Set([...tags, ...autoTags])];

    for (const tagName of allTags) {
      tagItemInTx(id, tagName, now);
    }
  });

  return getItem(id);
}

export function updateItem(id, { title, content, metadata } = {}) {
  const sets = [];
  const params = [];
  if (title !== undefined) { sets.push('title = ?'); params.push(title); }
  if (content !== undefined) { sets.push('content = ?'); params.push(content); }
  if (metadata !== undefined) {
    sets.push('metadata = ?');
    params.push(typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  }
  if (sets.length === 0) return getItem(id);

  sets.push('updatedAt = ?');
  params.push(Date.now());
  params.push(id);

  requireDb().prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getItem(id);
}

export function deleteItem(id) {
  requireDb().prepare(`UPDATE items SET deletedAt = ? WHERE id = ?`).run(Date.now(), id);
  return { success: true, id };
}

export function listTags({ search, limit = 100 } = {}) {
  const d = requireDb();
  let sql = `
    SELECT t.id, t.name, t.color, t.description, COUNT(it.id) as itemCount
    FROM tags t
    LEFT JOIN item_tags it ON t.id = it.tagId
    LEFT JOIN items i ON it.itemId = i.id AND i.deletedAt = 0
  `;
  const params = [];
  if (search) {
    sql += ' WHERE t.name LIKE ?';
    params.push(`%${search}%`);
  }
  sql += ` GROUP BY t.id ORDER BY t.frecencyScore DESC LIMIT ?`;
  params.push(limit);
  return d.prepare(sql).all(...params);
}

// Internal: assumes a transaction is already open.
function tagItemInTx(itemId, tagName, now) {
  const d = requireDb();
  // ON CONFLICT closes the read-then-insert race two agents otherwise hit
  // when both create the same new tag at the same instant.
  // slug + frecencyScore match datastore.ts policy so MCP-created tags
  // behave identically in the app's frecency-ordered surfaces.
  const slug = slugifyTagName(tagName);
  const initialFrecency = calculateTagFrecency(1, now);
  d.prepare(`
    INSERT INTO tags (id, name, slug, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      frequency = frequency + 1,
      lastUsed = excluded.lastUsed,
      frecencyScore = ?,
      updatedAt = excluded.updatedAt
  `).run(randomUUID(), tagName, slug, now, initialFrecency, now, now, initialFrecency);

  // The frecencyScore in the ON CONFLICT branch above was computed assuming
  // frequency=1; for the increment path we need to recompute from the new
  // (post-increment) frequency. One extra round-trip, but parity matters.
  const tag = d.prepare(`SELECT id, frequency FROM tags WHERE name = ?`).get(tagName);
  d.prepare(`UPDATE tags SET frecencyScore = ? WHERE id = ?`)
    .run(calculateTagFrecency(tag.frequency, now), tag.id);

  d.prepare(`
    INSERT OR IGNORE INTO item_tags (id, itemId, tagId, createdAt)
    VALUES (?, ?, ?, ?)
  `).run(randomUUID(), itemId, tag.id, now);
}

export function tagItem(itemId, tagName) {
  transaction(() => tagItemInTx(itemId, tagName, Date.now()));
  return { success: true, itemId, tagName };
}

export function untagItem(itemId, tagName) {
  const d = requireDb();
  const tag = d.prepare(`SELECT id FROM tags WHERE name = ?`).get(tagName);
  if (!tag) return { success: false, error: 'Tag not found' };
  d.prepare(`DELETE FROM item_tags WHERE itemId = ? AND tagId = ?`).run(itemId, tag.id);
  return { success: true, itemId, tagName };
}

export function recordEvent(itemId, type, value = '') {
  const id = randomUUID();
  const now = Date.now();
  const metaStr = value ? JSON.stringify({ notes: value }) : '{}';
  requireDb().prepare(`
    INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(id, itemId, type, now, metaStr, now);
  return { success: true, id, itemId, type };
}

export function listTasks({ tags = ['todo'], project } = {}) {
  const allTags = [...tags];
  if (project) allTags.push(project);
  return queryItems({ tags: allTags, sort: 'recent' });
}

export function completeTask(id, notes = '') {
  // Wrap the three-step operation so an item can't end up with both
  // `todo` and `done` if a step fails mid-way.
  transaction(() => {
    const now = Date.now();
    tagItemInTx(id, 'done', now);

    const d = requireDb();
    const todo = d.prepare(`SELECT id FROM tags WHERE name = 'todo'`).get();
    if (todo) {
      d.prepare(`DELETE FROM item_tags WHERE itemId = ? AND tagId = ?`).run(id, todo.id);
    }

    const eventMeta = notes ? JSON.stringify({ notes }) : '{}';
    d.prepare(`
      INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
      VALUES (?, ?, 'completed', 0, ?, ?, ?)
    `).run(randomUUID(), id, now, eventMeta, now);
  });
  return getItem(id);
}

export function getTaskContext(id) {
  const item = getItem(id);
  if (!item) return null;

  const events = requireDb().prepare(`
    SELECT id, content as type, value, occurredAt, metadata
    FROM item_events
    WHERE itemId = ?
    ORDER BY occurredAt DESC
    LIMIT 20
  `).all(id);

  return { ...item, events };
}
