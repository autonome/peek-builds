/**
 * Unit tests for migrateLoadingTitles.
 *
 * Drives the migration directly against an in-memory sqlite DB so we get
 * real coverage without booting Electron. Imports the function from
 * datastore.ts (which is exported precisely so tests can wire a db arg).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { migrateLoadingTitles, wrapDb } from './datastore.js';

function makeFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Note: the `migrations` table is not created — this backfill is
  // explicitly NOT marker-gated (runs every boot to handle re-stick
  // from cross-backend sync), so no migrations row is ever read or
  // written.
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT,
      domain TEXT DEFAULT '',
      title TEXT,
      deletedAt INTEGER DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );
  `);
  return db;
}

function insertItem(db: DatabaseSync, row: {
  id: string; type: string; content?: string | null; domain?: string;
  title?: string | null; deletedAt?: number; updatedAt?: number;
}): void {
  db.prepare(
    `INSERT INTO items (id, type, content, domain, title, deletedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.type,
    row.content ?? null,
    row.domain ?? '',
    row.title ?? null,
    row.deletedAt ?? 0,
    row.updatedAt ?? Date.now(),
  );
}

function getTitle(db: DatabaseSync, id: string): string | null {
  const r = db.prepare('SELECT title FROM items WHERE id = ?').get(id) as { title: string | null } | undefined;
  return r?.title ?? null;
}

function getUpdatedAt(db: DatabaseSync, id: string): number | null {
  const r = db.prepare('SELECT updatedAt FROM items WHERE id = ?').get(id) as { updatedAt: number } | undefined;
  return r?.updatedAt ?? null;
}

describe('migrateLoadingTitles', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeFixtureDb();
  });

  it('replaces "Loading..." with row.domain when present', () => {
    insertItem(db, { id: '1', type: 'url', content: 'https://example.com/x', domain: 'example.com', title: 'Loading...' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '1'), 'example.com');
  });

  it('extracts hostname from content URL when domain is empty', () => {
    insertItem(db, { id: '2', type: 'url', content: 'https://foo.bar/page', domain: '', title: 'Loading...' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '2'), 'foo.bar');
  });

  it('backfills NULL titles too', () => {
    insertItem(db, { id: '3', type: 'url', content: 'https://qux.io/p', domain: 'qux.io', title: null });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '3'), 'qux.io');
  });

  it('backfills empty-string titles too', () => {
    insertItem(db, { id: '4', type: 'url', content: 'https://baz.io/p', domain: 'baz.io', title: '' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '4'), 'baz.io');
  });

  it('leaves real titles alone', () => {
    insertItem(db, { id: '5', type: 'url', content: 'https://example.com/x', domain: 'example.com', title: 'Real Title' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '5'), 'Real Title');
  });

  it('skips non-url types even if their title is "Loading..."', () => {
    insertItem(db, { id: '6', type: 'text', content: 'note body', domain: '', title: 'Loading...' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '6'), 'Loading...');
  });

  it('skips soft-deleted rows', () => {
    insertItem(db, { id: '7', type: 'url', content: 'https://gone.example/x', domain: 'gone.example', title: 'Loading...', deletedAt: Date.now() });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '7'), 'Loading...');
  });

  it('leaves rows alone when no usable hostname can be derived', () => {
    insertItem(db, { id: '8', type: 'url', content: 'not a url', domain: '', title: 'Loading...' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, '8'), 'Loading...');
  });

  it('does NOT bump updatedAt — backfill is local cosmetic, must not propagate via sync', () => {
    // If we bumped updatedAt, this row would beat any other device's
    // post-stuck real-title write on next sync, overwriting their good
    // title with our hostname placeholder.
    const originalUpdatedAt = Date.now() - 1_000_000;
    insertItem(db, {
      id: 'no-bump',
      type: 'url',
      content: 'https://example.com/x',
      domain: 'example.com',
      title: 'Loading...',
      updatedAt: originalUpdatedAt,
    });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, 'no-bump'), 'example.com');
    assert.strictEqual(getUpdatedAt(db, 'no-bump'), originalUpdatedAt);
  });

  it('re-applies on subsequent runs — handles re-stick from cross-backend sync', () => {
    // Tauri desktop / tauri-mobile do not run this backfill, so they
    // can sync a still-stuck "Loading..." row back to this device after
    // we've already fixed it. Without a migrations marker, the next
    // boot re-applies the fix.
    insertItem(db, { id: 're-stick', type: 'url', content: 'https://example.com/x', domain: 'example.com', title: 'Loading...' });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, 're-stick'), 'example.com');

    // Simulate sync re-pushing "Loading..." from another backend.
    db.prepare('UPDATE items SET title = ? WHERE id = ?').run('Loading...', 're-stick');

    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, 're-stick'), 'example.com');
  });

  it('is row-level idempotent within a single run — no extra writes for non-stuck titles', () => {
    // Real-titled rows are never touched. Capture updatedAt and verify
    // it is unchanged after the run.
    const ts = Date.now() - 500_000;
    insertItem(db, { id: 'real', type: 'url', content: 'https://example.com/x', domain: 'example.com', title: 'Real Title', updatedAt: ts });
    migrateLoadingTitles(wrapDb(db));
    assert.strictEqual(getTitle(db, 'real'), 'Real Title');
    assert.strictEqual(getUpdatedAt(db, 'real'), ts);
  });
});
