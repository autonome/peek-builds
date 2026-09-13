/**
 * Unit tests for migrateEventPushedAtColumn.
 *
 * Drives the migration directly against an in-memory sqlite DB so we get real
 * coverage of the upgrade path — the one path a fresh datastore never takes,
 * since a new database gets pushedAt from the CREATE TABLE. Same harness as
 * migrate-empty-text-cleanup.test.ts.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { migrateEventPushedAtColumn, wrapDb } from './datastore.js';

/** The item_events shape as it stood before pushedAt — what the migration upgrades. */
function makeFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE item_events (
      id TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      content TEXT,
      value REAL,
      occurredAt INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE feature_settings (
      id TEXT PRIMARY KEY,
      featureId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updatedAt INTEGER
    );
  `);
  return db;
}

function insertEvent(db: DatabaseSync, id: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
     VALUES (?, 'item-1', NULL, NULL, ?, '{}', ?)`
  ).run(id, createdAt, createdAt);
}

function setOldWatermark(db: DatabaseSync, watermark: number): void {
  db.prepare(
    `INSERT INTO feature_settings (id, featureId, key, value, updatedAt)
     VALUES ('sync-lastEventPushAt', 'sync', 'lastEventPushAt', ?, ?)`
  ).run(JSON.stringify(watermark), Date.now());
}

function pushedAt(db: DatabaseSync, id: string): number {
  const row = db.prepare('SELECT pushedAt FROM item_events WHERE id = ?').get(id) as
    { pushedAt: number } | undefined;
  return row ? row.pushedAt : -1;
}

function hasPushedAtColumn(db: DatabaseSync): boolean {
  const columns = db.prepare('PRAGMA table_info(item_events)').all() as { name: string }[];
  return columns.some((col) => col.name === 'pushedAt');
}

describe('migrateEventPushedAtColumn', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeFixtureDb();
  });

  it('adds the column to a table that predates it', () => {
    assert.strictEqual(hasPushedAtColumn(db), false, 'sanity: the fixture is the pre-migration shape');

    migrateEventPushedAtColumn(wrapDb(db));

    assert.strictEqual(hasPushedAtColumn(db), true);
  });

  it('stamps events at or below the retired watermark as delivered, and leaves the tail behind it eligible', () => {
    const watermark = 1_700_000_000_000;
    insertEvent(db, 'evt-older', watermark - 1000);
    insertEvent(db, 'evt-exactly-at', watermark);
    insertEvent(db, 'evt-newer', watermark + 1000);
    setOldWatermark(db, watermark);

    migrateEventPushedAtColumn(wrapDb(db));

    assert.strictEqual(pushedAt(db, 'evt-older'), watermark, 'an event the old watermark covered was already delivered');
    assert.strictEqual(
      pushedAt(db, 'evt-exactly-at'),
      watermark,
      'the boundary is inclusive — the old query was `createdAt > watermark`, so an event AT the watermark had been sent'
    );
    assert.strictEqual(
      pushedAt(db, 'evt-newer'),
      0,
      'the tail behind the watermark must stay eligible — it is what re-pushes once, idempotently, after the upgrade'
    );
  });

  it('leaves every event eligible when there is no watermark to backfill from', () => {
    insertEvent(db, 'evt-a', 1_700_000_000_000);
    insertEvent(db, 'evt-b', 1_700_000_001_000);

    migrateEventPushedAtColumn(wrapDb(db));

    assert.strictEqual(pushedAt(db, 'evt-a'), 0);
    assert.strictEqual(pushedAt(db, 'evt-b'), 0);
  });

  it('does not re-stamp anything on a second run', () => {
    const watermark = 1_700_000_000_000;
    insertEvent(db, 'evt-delivered', watermark - 1000);
    insertEvent(db, 'evt-newer', watermark + 1000);
    setOldWatermark(db, watermark);

    migrateEventPushedAtColumn(wrapDb(db));
    // A later push delivers the tail and stamps it with its own time; the
    // migration must not run again and overwrite that with the old watermark.
    db.prepare('UPDATE item_events SET pushedAt = ? WHERE id = ?').run(watermark + 5000, 'evt-newer');

    migrateEventPushedAtColumn(wrapDb(db));

    assert.strictEqual(pushedAt(db, 'evt-newer'), watermark + 5000, 'the column already exists, so the migration is a no-op');
  });
});
