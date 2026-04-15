/**
 * Database helper for Peek MCP Server.
 * Uses sqlite3 CLI via child_process to query Peek's SQLite database.
 * This avoids native module issues (better-sqlite3 is compiled for Electron's Node ABI).
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

let dbPath = null;

/**
 * Open/configure the database path.
 * @param {string} path - Absolute path to Peek's datastore.sqlite
 */
export function openDb(path) {
  if (!existsSync(path)) {
    throw new Error(`Database not found: ${path}`);
  }
  dbPath = path;
}

/**
 * Run a SQL query via sqlite3 CLI and return parsed JSON results.
 * @param {string} sql - SQL query
 * @param {object} [opts] - Options
 * @param {boolean} [opts.single] - Return first row only
 * @returns {Array|object|null}
 */
function query(sql, opts = {}) {
  if (!dbPath) throw new Error('Database not opened. Call openDb() first.');

  // sqlite3 with JSON output mode
  const cmd = `sqlite3 -json "${dbPath}"`;
  try {
    const result = execSync(cmd, {
      input: sql,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = result.trim();
    if (!trimmed) return opts.single ? null : [];
    const rows = JSON.parse(trimmed);
    return opts.single ? (rows[0] || null) : rows;
  } catch (err) {
    // sqlite3 returns exit code 1 for errors
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`SQLite error: ${stderr || err.message}`);
  }
}

/**
 * Execute a write statement (INSERT, UPDATE, DELETE) via sqlite3 CLI.
 * @param {string} sql - SQL statement
 */
function execute(sql) {
  if (!dbPath) throw new Error('Database not opened. Call openDb() first.');

  const cmd = `sqlite3 "${dbPath}"`;
  try {
    execSync(cmd, {
      input: sql,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`SQLite error: ${stderr || err.message}`);
  }
}

/**
 * Escape a string for use in SQL (single-quote escaping).
 */
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Query items with optional filtering.
 */
export function queryItems({ tags, type, limit = 50, offset = 0, sort = 'recent' } = {}) {
  let sql;

  if (tags && tags.length > 0) {
    const tagList = tags.map(t => esc(t)).join(',');
    const orderBy = sort === 'frecency' ? 'i.frecencyScore DESC' : 'i.createdAt DESC';
    sql = `
      SELECT i.id, i.type, i.content, i.title, i.domain, i.metadata,
             i.createdAt, i.updatedAt, i.starred, i.archived, i.visitCount, i.frecencyScore
      FROM items i
      JOIN item_tags it ON i.id = it.itemId
      JOIN tags t ON it.tagId = t.id
      WHERE t.name IN (${tagList}) AND i.deletedAt = 0
      GROUP BY i.id
      HAVING COUNT(DISTINCT t.id) = ${tags.length}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset};
    `;
  } else {
    const orderBy = sort === 'frecency' ? 'frecencyScore DESC' : 'createdAt DESC';
    let where = 'deletedAt = 0';
    if (type) where += ` AND type = ${esc(type)}`;
    sql = `
      SELECT id, type, content, title, domain, metadata,
             createdAt, updatedAt, starred, archived, visitCount, frecencyScore
      FROM items
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset};
    `;
  }

  const items = query(sql);
  // Attach tags to each item
  return items.map(item => {
    item.tags = getItemTags(item.id);
    if (item.metadata && typeof item.metadata === 'string') {
      try { item.metadata = JSON.parse(item.metadata); } catch { /* keep as string */ }
    }
    return item;
  });
}

/**
 * Get a single item by ID.
 */
export function getItem(id) {
  const sql = `
    SELECT id, type, content, title, domain, metadata, mimeType,
           createdAt, updatedAt, starred, archived, visitCount, frecencyScore,
           lastVisitAt, favicon, deletedAt
    FROM items WHERE id = ${esc(id)};
  `;
  const item = query(sql, { single: true });
  if (!item) return null;
  item.tags = getItemTags(id);
  if (item.metadata && typeof item.metadata === 'string') {
    try { item.metadata = JSON.parse(item.metadata); } catch { /* keep as string */ }
  }
  return item;
}

/**
 * Get tags for an item.
 */
export function getItemTags(itemId) {
  const sql = `
    SELECT t.name FROM tags t
    JOIN item_tags it ON t.id = it.tagId
    WHERE it.itemId = ${esc(itemId)};
  `;
  return query(sql).map(r => r.name);
}

/**
 * Create a new item, optionally with tags.
 */
export function createItem({ type, url, title = '', content = '', metadata = {}, tags = [] }) {
  const id = randomUUID();
  const now = Date.now();
  const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

  // For URL items, content holds the URL; domain is extracted
  let domain = '';
  let itemContent = content;
  if (type === 'url' && url) {
    itemContent = url;
    try { domain = new URL(url).hostname; } catch { /* ignore */ }
  }

  execute(`
    INSERT INTO items (id, type, content, title, domain, metadata, createdAt, updatedAt, deletedAt)
    VALUES (${esc(id)}, ${esc(type)}, ${esc(itemContent)}, ${esc(title)}, ${esc(domain)}, ${esc(metaStr)}, ${now}, ${now}, 0);
  `);

  // Add tags
  for (const tagName of tags) {
    tagItem(id, tagName);
  }

  return getItem(id);
}

/**
 * Update an existing item.
 */
export function updateItem(id, { title, content, metadata } = {}) {
  const sets = [];
  if (title !== undefined) sets.push(`title = ${esc(title)}`);
  if (content !== undefined) sets.push(`content = ${esc(content)}`);
  if (metadata !== undefined) {
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    sets.push(`metadata = ${esc(metaStr)}`);
  }
  if (sets.length === 0) return getItem(id);

  sets.push(`updatedAt = ${Date.now()}`);
  execute(`UPDATE items SET ${sets.join(', ')} WHERE id = ${esc(id)};`);
  return getItem(id);
}

/**
 * Soft-delete an item.
 */
export function deleteItem(id) {
  execute(`UPDATE items SET deletedAt = ${Date.now()} WHERE id = ${esc(id)};`);
  return { success: true, id };
}

/**
 * List tags, optionally filtered by search term.
 */
export function listTags({ search, limit = 100 } = {}) {
  let where = '1=1';
  if (search) {
    where = `t.name LIKE ${esc('%' + search + '%')}`;
  }

  const sql = `
    SELECT t.id, t.name, t.color, t.description, COUNT(it.id) as itemCount
    FROM tags t
    LEFT JOIN item_tags it ON t.id = it.tagId
    LEFT JOIN items i ON it.itemId = i.id AND i.deletedAt = 0
    WHERE ${where}
    GROUP BY t.id
    ORDER BY t.frecencyScore DESC
    LIMIT ${limit};
  `;
  return query(sql);
}

/**
 * Add a tag to an item. Creates the tag if it doesn't exist.
 */
export function tagItem(itemId, tagName) {
  const now = Date.now();

  // Ensure tag exists
  const existing = query(`SELECT id FROM tags WHERE name = ${esc(tagName)};`, { single: true });
  let tagId;
  if (existing) {
    tagId = existing.id;
    execute(`UPDATE tags SET frequency = frequency + 1, lastUsed = ${now}, updatedAt = ${now} WHERE id = ${esc(tagId)};`);
  } else {
    tagId = randomUUID();
    execute(`
      INSERT INTO tags (id, name, frequency, lastUsed, createdAt, updatedAt)
      VALUES (${esc(tagId)}, ${esc(tagName)}, 1, ${now}, ${now}, ${now});
    `);
  }

  // Link item to tag (ignore if already exists)
  const linkId = randomUUID();
  execute(`
    INSERT OR IGNORE INTO item_tags (id, itemId, tagId, createdAt)
    VALUES (${esc(linkId)}, ${esc(itemId)}, ${esc(tagId)}, ${now});
  `);

  return { success: true, itemId, tagName };
}

/**
 * Remove a tag from an item.
 */
export function untagItem(itemId, tagName) {
  const tag = query(`SELECT id FROM tags WHERE name = ${esc(tagName)};`, { single: true });
  if (!tag) return { success: false, error: 'Tag not found' };

  execute(`DELETE FROM item_tags WHERE itemId = ${esc(itemId)} AND tagId = ${esc(tag.id)};`);
  return { success: true, itemId, tagName };
}

/**
 * Record an event for an item.
 */
export function recordEvent(itemId, type, value = '') {
  const id = randomUUID();
  const now = Date.now();
  execute(`
    INSERT INTO item_events (id, itemId, content, value, occurredAt, createdAt)
    VALUES (${esc(id)}, ${esc(itemId)}, ${esc(type)}, ${value ? value : 0}, ${now}, ${now});
  `);
  return { success: true, id, itemId, type };
}

/**
 * List tasks (items tagged with specified tags, default: 'todo').
 */
export function listTasks({ tags = ['todo'], project } = {}) {
  const allTags = [...tags];
  if (project) allTags.push(project);
  return queryItems({ tags: allTags, sort: 'recent' });
}

/**
 * Complete a task: add 'done' tag, remove 'todo' tag, record event.
 */
export function completeTask(id, notes = '') {
  tagItem(id, 'done');
  untagItem(id, 'todo');
  recordEvent(id, 'completed', notes);
  return getItem(id);
}

/**
 * Get task context: item + tags + recent events.
 */
export function getTaskContext(id) {
  const item = getItem(id);
  if (!item) return null;

  const events = query(`
    SELECT id, content as type, value, occurredAt, metadata
    FROM item_events
    WHERE itemId = ${esc(id)}
    ORDER BY occurredAt DESC
    LIMIT 20;
  `);

  return { ...item, events };
}
