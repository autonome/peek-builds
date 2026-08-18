/**
 * Unit tests for migrateEmptyTextCleanup.
 *
 * Drives the migration directly against an in-memory sqlite DB so we get
 * real coverage without booting Electron. Imports the function from
 * datastore.ts (which is exported precisely so tests can wire a db arg) —
 * same harness as migrate-loading-titles.test.ts.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { migrateEmptyTextCleanup, wrapDb } from './datastore.js';

function makeFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT,
      title TEXT,
      deletedAt INTEGER DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function insertItem(db: DatabaseSync, row: {
  id: string; type: string; content?: string | null;
  title?: string | null; deletedAt?: number; updatedAt?: number;
}): void {
  db.prepare(
    `INSERT INTO items (id, type, content, title, deletedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.type,
    row.content ?? null,
    row.title ?? null,
    row.deletedAt ?? 0,
    row.updatedAt ?? Date.now(),
  );
}

function getRow(db: DatabaseSync, id: string): { deletedAt: number; updatedAt: number } | undefined {
  return db.prepare('SELECT deletedAt, updatedAt FROM items WHERE id = ?').get(id) as
    { deletedAt: number; updatedAt: number } | undefined;
}

describe('migrateEmptyTextCleanup', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeFixtureDb();
  });

  it('soft-deletes an empty-content, empty-title text item', () => {
    insertItem(db, { id: '1', type: 'text', content: '', title: '' });
    migrateEmptyTextCleanup(wrapDb(db));
    const row = getRow(db, '1');
    assert.ok(row);
    assert.notStrictEqual(row!.deletedAt, 0, 'deletedAt should be set');
  });

  it('leaves a text item with content untouched', () => {
    insertItem(db, { id: '2', type: 'text', content: 'has content', title: '' });
    migrateEmptyTextCleanup(wrapDb(db));
    const row = getRow(db, '2');
    assert.strictEqual(row!.deletedAt, 0);
  });

  it('leaves a text item with a title but no content untouched', () => {
    insertItem(db, { id: '3', type: 'text', content: '', title: 'My Note' });
    migrateEmptyTextCleanup(wrapDb(db));
    const row = getRow(db, '3');
    assert.strictEqual(row!.deletedAt, 0);
  });

  it('leaves a non-text item with empty content untouched', () => {
    insertItem(db, { id: '4', type: 'url', content: '', title: '' });
    migrateEmptyTextCleanup(wrapDb(db));
    const row = getRow(db, '4');
    assert.strictEqual(row!.deletedAt, 0);
  });

  it('is one-shot — running it twice does not re-run', () => {
    insertItem(db, { id: '5', type: 'text', content: '', title: '' });
    migrateEmptyTextCleanup(wrapDb(db));

    const flagAfterFirst = db.prepare('SELECT value FROM settings WHERE key = ?').get('empty_text_cleanup_v1');
    assert.ok(flagAfterFirst, 'flag should be set after first run');

    // Simulate a fresh empty-text row appearing after the flag is set —
    // a second run must not touch it, proving the gate short-circuits.
    insertItem(db, { id: '6', type: 'text', content: '', title: '' });
    migrateEmptyTextCleanup(wrapDb(db));

    const row6 = getRow(db, '6');
    assert.strictEqual(row6!.deletedAt, 0, 'second run should be a no-op');
  });

  it('does not touch an already-deleted row', () => {
    const deletedAt = Date.now() - 1_000_000;
    insertItem(db, { id: '7', type: 'text', content: '', title: '', deletedAt });
    migrateEmptyTextCleanup(wrapDb(db));
    const row = getRow(db, '7');
    assert.strictEqual(row!.deletedAt, deletedAt, 'deletedAt should be unchanged');
  });
});
