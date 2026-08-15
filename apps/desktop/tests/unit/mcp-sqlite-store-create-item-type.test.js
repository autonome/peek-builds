/**
 * Regression guard: sqlite-store.js createItemSync() type validation.
 *
 * Before this test existed, createItemSync() inserted whatever `type` string
 * it was given — a misspelled type (e.g. "urll") silently became a
 * permanent row instead of failing. apps/server/mcp-items.js createItem()
 * already rejects an unknown type via CREATABLE_ITEM_TYPES; this file pins
 * the local store to the same behavior, matching sqlite-store.js's own
 * CREATABLE_ITEM_TYPES list (server's list + "image" — see the comment on
 * that list for why the local store is allowed to diverge on "image").
 *
 * remote-store.test.js covers the *remote* store only; this is the local
 * (sqlite) store's first test file, and follows the same
 * mkdtempSync/DatabaseSync-schema/openSqliteStore structure
 * mcp-db-tags-unique-index.test.js established.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to sqlite-store.js under test.
const SQLITE_STORE_PATH = join(__dirname, '..', '..', 'features', 'mcp-server', 'store', 'sqlite-store.js');

// Minimal schema createItemSync() needs — mirrors the relevant columns from
// mcp-db-tags-unique-index.test.js's LEGACY_SCHEMA_SQL (this test doesn't
// exercise the tags-index migration, but openSqliteStore() runs it
// unconditionally on open, so the tags/item_tags tables must exist).
const SCHEMA_SQL = `
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
  CREATE UNIQUE INDEX idx_tags_name_unique ON tags(name);

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

function createDb(dbPath) {
  const d = new DatabaseSync(dbPath);
  d.exec(SCHEMA_SQL);
  d.close();
}

function countItems(dbPath) {
  const d = new DatabaseSync(dbPath);
  const row = d.prepare('SELECT COUNT(*) AS n FROM items').get();
  d.close();
  return row.n;
}

// Same list sqlite-store.js's createItemSync() validates against — the
// remote's CREATABLE_ITEM_TYPES (apps/server/mcp-items.js) plus "image".
const LOCAL_CREATABLE_ITEM_TYPES = ['url', 'text', 'tagset', 'image', 'series', 'feed', 'entity'];

describe('mcp sqlite-store.js: createItemSync() type validation', () => {
  let tmpDir;
  let openSqliteStore;
  let store;
  let dbPath;
  let counter = 0;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-mcp-create-item-type-test-'));
    ({ openSqliteStore } = await import(SQLITE_STORE_PATH));
  });

  after(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  beforeEach(async () => {
    dbPath = join(tmpDir, `db-${counter++}.sqlite`);
    createDb(dbPath);
    store = await openSqliteStore({ dbPath });
  });

  it('rejects an unknown type and writes no row', async () => {
    await assert.rejects(
      () => store.createItem({ type: 'urll', content: 'hello' }),
      /type must be one of:/,
    );
    assert.equal(countItems(dbPath), 0, 'no row should be written for a rejected type');
    await store.close();
  });

  it('rejects a missing type', async () => {
    await assert.rejects(
      () => store.createItem({ content: 'hello' }),
      /type is required/,
    );
    assert.equal(countItems(dbPath), 0);
    await store.close();
  });

  for (const type of LOCAL_CREATABLE_ITEM_TYPES) {
    it(`accepts type "${type}"`, async () => {
      const item = await store.createItem({ type, content: 'hello', title: type });
      assert.equal(item.type, type);
      assert.equal(countItems(dbPath), 1);
      await store.close();
    });
  }

  it('accepts "image" locally — pins the deliberate divergence from the remote store, which refuses it', async () => {
    const item = await store.createItem({ type: 'image', content: 'binary-ish content' });
    assert.equal(item.type, 'image');
    assert.equal(countItems(dbPath), 1);
    await store.close();
  });
});
