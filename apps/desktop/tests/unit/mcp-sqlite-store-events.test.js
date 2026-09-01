/**
 * sqlite-store.js: recordEventSync()'s content/occurredAt/metadata additions,
 * and the new listEventsSync()/deleteEventSync()/deleteEventsSync() parity
 * methods (apps/server/mcp-items.js recordEvent()/listEvents()/deleteEvent()/
 * deleteEvents() are the server-side twins — see that file's comments for the
 * shared rules this file pins on the local store).
 *
 * Follows the same mkdtempSync/DatabaseSync-schema/openSqliteStore structure
 * mcp-db-tags-unique-index.test.js and
 * mcp-sqlite-store-create-item-type.test.js established.
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

const SQLITE_STORE_PATH = join(__dirname, '..', '..', 'features', 'mcp-server', 'store', 'sqlite-store.js');

// Minimal schema openSqliteStore() needs (it runs the tags-index migration
// unconditionally on open) plus item_events for the methods under test.
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

function readEventRow(dbPath, itemId) {
  const d = new DatabaseSync(dbPath);
  const row = d.prepare('SELECT * FROM item_events WHERE itemId = ?').get(itemId);
  d.close();
  return row;
}

describe('mcp sqlite-store.js: recordEventSync()/listEventsSync()/deleteEventSync()/deleteEventsSync()', () => {
  let tmpDir;
  let openSqliteStore;
  let store;
  let dbPath;
  let counter = 0;
  const ITEM_ID = 'item-1';

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-mcp-events-test-'));
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
    const now = Date.now();
    const d = new DatabaseSync(dbPath);
    d.prepare(
      `INSERT INTO items (id, type, content, createdAt, updatedAt) VALUES (?, 'text', 'body', ?, ?)`
    ).run(ITEM_ID, now, now);
    d.close();
    store = await openSqliteStore({ dbPath });
  });

  it('a (id, type, value) call writes the exact legacy row: content=type, value=0, metadata={notes:value}', async () => {
    const result = await store.recordEvent(ITEM_ID, 'started', 'kicked off');
    assert.equal(result.success, true);
    assert.equal(result.type, 'started');

    const row = readEventRow(dbPath, ITEM_ID);
    assert.equal(row.content, 'started');
    assert.equal(row.value, 0);
    assert.deepEqual(JSON.parse(row.metadata), { notes: 'kicked off' });
  });

  it('a (id, type) call with no value writes metadata "{}"', async () => {
    await store.recordEvent(ITEM_ID, 'started');
    const row = readEventRow(dbPath, ITEM_ID);
    assert.equal(row.content, 'started');
    assert.equal(row.value, 0);
    assert.equal(row.metadata, '{}');
  });

  it('opts.content/occurredAt/metadata store directly into the columns of those names', async () => {
    const occurredAt = 1700000000000;
    await store.recordEvent(ITEM_ID, 'feed_entry', undefined, {
      content: 'https://example.com/article',
      occurredAt,
      metadata: { guid: 'abc123' },
    });
    const row = readEventRow(dbPath, ITEM_ID);
    assert.equal(row.content, 'https://example.com/article');
    assert.equal(row.occurredAt, occurredAt);
    assert.deepEqual(JSON.parse(row.metadata), { guid: 'abc123' });
  });

  it('an explicit opts.metadata switches value to a real number instead of notes-wrapped text', async () => {
    await store.recordEvent(ITEM_ID, 'score', 42, { metadata: { source: 'test' } });
    const row = readEventRow(dbPath, ITEM_ID);
    assert.equal(row.value, 42);
  });

  it('listEvents pages, ordered by occurredAt descending', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordEvent(ITEM_ID, `evt-${i}`, '', { occurredAt: 1000 + i });
    }
    const page = await store.listEvents(ITEM_ID, { limit: 2, offset: 1 });
    assert.equal(page.length, 2);
    // Descending: index 0 -> evt-4 (1004), skip it (offset 1) -> evt-3, evt-2.
    assert.equal(page[0].type, 'evt-3');
    assert.equal(page[1].type, 'evt-2');
  });

  it('deleteEvent removes one event and reports success', async () => {
    const created = await store.recordEvent(ITEM_ID, 'started');
    const result = await store.deleteEvent(ITEM_ID, created.id);
    assert.equal(result.success, true);
    const remaining = await store.listEvents(ITEM_ID);
    assert.equal(remaining.length, 0);
  });

  it('deleteEvent reports success:false for an eventId that is not there', async () => {
    const result = await store.deleteEvent(ITEM_ID, 'no-such-event');
    assert.equal(result.success, false);
  });

  it('deleteEvents removes every event under the item and reports the count', async () => {
    for (let i = 0; i < 3; i++) {
      await store.recordEvent(ITEM_ID, `evt-${i}`);
    }
    const result = await store.deleteEvents(ITEM_ID);
    assert.equal(result.success, true);
    assert.equal(result.deleted, 3);
    const remaining = await store.listEvents(ITEM_ID);
    assert.equal(remaining.length, 0);
  });
});
