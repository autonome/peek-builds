/**
 * Unit tests for migrateVisitPushedAtColumn.
 *
 * Drives the migration directly against an in-memory sqlite DB so we get real
 * coverage of the upgrade path — the one path a fresh datastore never takes,
 * since a new database gets pushedAt from the CREATE TABLE. Same harness as
 * migrate-event-pushed-at.test.ts.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { migrateVisitPushedAtColumn, wrapDb } from './datastore.js';

/** The item_visits shape as it stood before pushedAt — what the migration upgrades. */
function makeFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE item_visits (
      id TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration INTEGER DEFAULT 0,
      source TEXT DEFAULT 'direct',
      sourceId TEXT DEFAULT '',
      windowType TEXT DEFAULT 'main',
      metadata TEXT DEFAULT '{}',
      scrollDepth INTEGER DEFAULT 0,
      interacted INTEGER DEFAULT 0,
      prevId TEXT DEFAULT NULL,
      nextId TEXT DEFAULT NULL
    );
  `);
  return db;
}

function insertVisit(db: DatabaseSync, id: string, timestamp: number): void {
  db.prepare(`INSERT INTO item_visits (id, itemId, timestamp) VALUES (?, 'item-1', ?)`).run(id, timestamp);
}

function pushedAt(db: DatabaseSync, id: string): number {
  const row = db.prepare('SELECT pushedAt FROM item_visits WHERE id = ?').get(id) as
    { pushedAt: number } | undefined;
  return row ? row.pushedAt : -1;
}

function pushedAtColumnCount(db: DatabaseSync): number {
  const columns = db.prepare('PRAGMA table_info(item_visits)').all() as { name: string }[];
  return columns.filter((col) => col.name === 'pushedAt').length;
}

describe('migrateVisitPushedAtColumn', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeFixtureDb();
  });

  it('adds the column once to a table that predates it', () => {
    assert.strictEqual(pushedAtColumnCount(db), 0, 'sanity: the fixture is the pre-migration shape');

    migrateVisitPushedAtColumn(wrapDb(db));

    assert.strictEqual(pushedAtColumnCount(db), 1);
  });

  it('is idempotent: a second run changes nothing', () => {
    insertVisit(db, 'v-a', 1000);
    migrateVisitPushedAtColumn(wrapDb(db));
    db.prepare('UPDATE item_visits SET pushedAt = ? WHERE id = ?').run(5000, 'v-a');

    migrateVisitPushedAtColumn(wrapDb(db));

    assert.strictEqual(pushedAtColumnCount(db), 1);
    assert.strictEqual(pushedAt(db, 'v-a'), 5000, 'the column already exists, so the migration is a no-op');
  });

  it('leaves existing rows at pushedAt = 0 so the first sync sends the whole history', () => {
    insertVisit(db, 'v-1', 1000);
    insertVisit(db, 'v-2', 2000);

    migrateVisitPushedAtColumn(wrapDb(db));

    assert.strictEqual(pushedAt(db, 'v-1'), 0);
    assert.strictEqual(pushedAt(db, 'v-2'), 0);
  });
});
