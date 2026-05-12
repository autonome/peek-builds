/**
 * Regression guard: db.js ensureTagsUniqueIndex() migration.
 *
 * Verifies that openDb() creates idx_tags_name_unique on an existing database
 * that lacks it — including when duplicate tags.name rows are present. This
 * mirrors the real-world scenario where a database was created before commit
 * 01392807 added the UNIQUE index to the DDL.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to db.js under test.
const DB_JS_PATH = join(__dirname, '..', '..', 'features', 'mcp-server', 'db.js');

// Minimal schema that mirrors the real one but WITHOUT the UNIQUE index on
// tags.name — this is what older databases looked like before the fix.
const LEGACY_SCHEMA_SQL = `
  CREATE TABLE items (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    mimeType TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    syncId TEXT DEFAULT '',
    syncedAt INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    deletedAt INTEGER DEFAULT 0,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    visitCount INTEGER DEFAULT 0,
    lastVisitAt INTEGER DEFAULT 0,
    frecencyScore INTEGER DEFAULT 0,
    title TEXT DEFAULT '',
    domain TEXT DEFAULT '',
    favicon TEXT DEFAULT ''
  );

  CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    frequency INTEGER DEFAULT 1,
    lastUsed INTEGER NOT NULL,
    frecencyScore REAL DEFAULT 0.0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    slug TEXT,
    color TEXT DEFAULT '#999999',
    parentId TEXT DEFAULT '',
    description TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}'
  );
  CREATE INDEX idx_tags_name ON tags(name);

  CREATE TABLE item_tags (
    id TEXT PRIMARY KEY NOT NULL,
    itemId TEXT NOT NULL,
    tagId TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_item_tags_unique ON item_tags(itemId, tagId);

  CREATE TABLE item_events (
    id TEXT PRIMARY KEY NOT NULL,
    itemId TEXT NOT NULL,
    content TEXT,
    value REAL,
    occurredAt INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER NOT NULL
  );
`;

function createLegacyDb(dbPath, extraSql = '') {
  const d = new DatabaseSync(dbPath);
  d.exec(LEGACY_SCHEMA_SQL);
  if (extraSql) d.exec(extraSql);
  d.close();
}

function getIndexes(dbPath) {
  const d = new DatabaseSync(dbPath);
  const rows = d.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tags'`
  ).all();
  d.close();
  return rows.map(r => r.name);
}

function getTagNames(dbPath) {
  const d = new DatabaseSync(dbPath);
  const rows = d.prepare(`SELECT name FROM tags ORDER BY name`).all();
  d.close();
  return rows.map(r => r.name);
}

function getItemTagPairs(dbPath) {
  const d = new DatabaseSync(dbPath);
  const rows = d.prepare(
    `SELECT it.itemId, t.name FROM item_tags it JOIN tags t ON t.id = it.tagId ORDER BY it.itemId, t.name`
  ).all();
  d.close();
  return rows;
}

describe('mcp db.js: ensureTagsUniqueIndex', () => {
  let tmpDir;
  let dbModule;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-mcp-tag-idx-test-'));
    dbModule = await import(DB_JS_PATH);
  });

  after(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('creates idx_tags_name_unique on a legacy DB with no duplicates', async () => {
    const dbPath = join(tmpDir, 'no-dupes.sqlite');
    const now = Date.now();
    createLegacyDb(dbPath, `
      INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
      VALUES ('tag-1', 'todo', 1, ${now}, 0, ${now}, ${now}),
             ('tag-2', 'peek', 1, ${now}, 0, ${now}, ${now});
    `);

    // Index must not exist before open.
    assert.ok(!getIndexes(dbPath).includes('idx_tags_name_unique'), 'should not exist before');

    dbModule.openDb(dbPath);
    dbModule.closeDb();

    const indexes = getIndexes(dbPath);
    assert.ok(indexes.includes('idx_tags_name_unique'), 'idx_tags_name_unique should exist after openDb');
  });

  it('creates idx_tags_name_unique on a legacy DB with duplicate tag names', async () => {
    const dbPath = join(tmpDir, 'with-dupes.sqlite');
    const now = Date.now();
    // item-1 is tagged with tag-a only (dupe of 'todo').
    // item-2 is tagged with BOTH tag-a and tag-b (two dupes of 'todo').
    // After dedupe: canonical for 'todo' = tag-a (lowest id).
    // item-2 already has canonical tag-a, so the tag-b ref should be collapsed away.
    createLegacyDb(dbPath, `
      INSERT INTO items (id, type, content, createdAt, updatedAt)
      VALUES ('item-1', 'text', 'hello', ${now}, ${now}),
             ('item-2', 'text', 'world', ${now}, ${now});

      INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
      VALUES ('tag-a', 'todo', 2, ${now}, 0, ${now}, ${now}),
             ('tag-b', 'todo', 1, ${now}, 0, ${now}, ${now}),
             ('tag-c', 'peek', 1, ${now}, 0, ${now}, ${now});

      INSERT INTO item_tags (id, itemId, tagId, createdAt)
      VALUES ('it-1', 'item-1', 'tag-a', ${now}),
             ('it-2', 'item-2', 'tag-a', ${now}),
             ('it-3', 'item-2', 'tag-b', ${now});
    `);

    dbModule.openDb(dbPath);
    dbModule.closeDb();

    // Index must now exist.
    const indexes = getIndexes(dbPath);
    assert.ok(indexes.includes('idx_tags_name_unique'), 'idx_tags_name_unique should exist after openDb');

    // 'todo' should appear exactly once.
    const names = getTagNames(dbPath);
    const todoCount = names.filter(n => n === 'todo').length;
    assert.equal(todoCount, 1, 'todo should appear exactly once after dedup');

    // item_tags integrity: item-2 should still be tagged 'todo' (via canonical tag-a).
    const pairs = getItemTagPairs(dbPath);
    const item2Tags = pairs.filter(p => p.itemId === 'item-2').map(p => p.name);
    assert.ok(item2Tags.includes('todo'), 'item-2 should still be tagged todo after dedup');
    assert.equal(item2Tags.filter(t => t === 'todo').length, 1, 'todo should appear exactly once for item-2');
  });

  it('is idempotent — calling openDb twice does not break the index', async () => {
    const dbPath = join(tmpDir, 'idempotent.sqlite');
    const now = Date.now();
    createLegacyDb(dbPath, `
      INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
      VALUES ('tag-1', 'hello', 1, ${now}, 0, ${now}, ${now});
    `);

    dbModule.openDb(dbPath);
    dbModule.closeDb();

    // Second open must not throw.
    dbModule.openDb(dbPath);
    dbModule.closeDb();

    const indexes = getIndexes(dbPath);
    assert.ok(indexes.includes('idx_tags_name_unique'), 'index should still exist after second open');
  });

  it('tag_item succeeds after index is created (ON CONFLICT upsert works)', async () => {
    const dbPath = join(tmpDir, 'tag-item.sqlite');
    const now = Date.now();
    createLegacyDb(dbPath, `
      INSERT INTO items (id, type, content, createdAt, updatedAt)
      VALUES ('item-1', 'text', 'test', ${now}, ${now});
    `);

    dbModule.openDb(dbPath);

    // This should not throw — the ON CONFLICT(name) upsert requires the UNIQUE index.
    assert.doesNotThrow(() => {
      dbModule.tagItem('item-1', 'newtag');
    }, 'tagItem should succeed after ensureTagsUniqueIndex runs');

    // Calling again (idempotent via INSERT OR IGNORE on item_tags).
    assert.doesNotThrow(() => {
      dbModule.tagItem('item-1', 'newtag');
    }, 'second tagItem call should also succeed');

    dbModule.closeDb();
  });
});
