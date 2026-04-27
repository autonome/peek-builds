/**
 * Unit tests for permission-store.ts — the persistence layer for the web
 * permission handler (Phase 3).
 *
 * Uses an in-memory better-sqlite3 with the same `feature_settings` schema
 * shape as production. Runs under Electron-as-node via the standard
 * dist-compile + ELECTRON_RUN_AS_NODE pipeline.
 */

import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import Database from 'better-sqlite3';

import {
  getDecision,
  setDecision,
  forgetDecision,
  forgetAllDecisions,
  listDecisions,
  type PermissionDb,
} from './permission-store.js';

let db: Database.Database;

function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE feature_settings (
      id TEXT PRIMARY KEY,
      featureId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updatedAt INTEGER
    );
    CREATE UNIQUE INDEX idx_feature_settings_unique ON feature_settings(featureId, key);
  `);
  return d;
}

describe('permission-store: getDecision', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM feature_settings'); });

  it('returns null when no decision is stored', () => {
    assert.strictEqual(
      getDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation'),
      null,
    );
  });

  it('returns the stored decision when present', () => {
    setDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation', true, 1000);
    const d = getDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation');
    assert.deepStrictEqual(d, { allowed: true, timestamp: 1000 });
  });

  it('distinguishes by both origin and permission', () => {
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation', true, 1);
    setDecision(db as unknown as PermissionDb, 'https://b.com', 'geolocation', false, 2);
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'media', false, 3);

    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation')?.allowed, true);
    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://b.com', 'geolocation')?.allowed, false);
    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://a.com', 'media')?.allowed, false);
    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://b.com', 'media'), null);
  });

  it('returns null for malformed JSON', () => {
    db.prepare(
      `INSERT INTO feature_settings (id, featureId, key, value, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('bad-id', 'page-permissions', 'geolocation:https://bad.com', '{not valid json', 0);
    assert.strictEqual(
      getDecision(db as unknown as PermissionDb, 'https://bad.com', 'geolocation'),
      null,
    );
  });

  it('returns null when stored payload lacks an `allowed` boolean', () => {
    db.prepare(
      `INSERT INTO feature_settings (id, featureId, key, value, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('partial-id', 'page-permissions', 'geolocation:https://partial.com', '{"timestamp":123}', 123);
    assert.strictEqual(
      getDecision(db as unknown as PermissionDb, 'https://partial.com', 'geolocation'),
      null,
    );
  });
});

describe('permission-store: setDecision', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM feature_settings'); });

  it('overwrites a previous decision for the same (origin, permission)', () => {
    setDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation', true, 1);
    setDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation', false, 2);
    const d = getDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation');
    assert.deepStrictEqual(d, { allowed: false, timestamp: 2 });
  });

  it('uses the provided timestamp', () => {
    setDecision(db as unknown as PermissionDb, 'https://example.com', 'media', true, 12345);
    const d = getDecision(db as unknown as PermissionDb, 'https://example.com', 'media');
    assert.strictEqual(d?.timestamp, 12345);
  });
});

describe('permission-store: forgetDecision', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM feature_settings'); });

  it('removes a stored decision', () => {
    setDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation', true);
    forgetDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation');
    assert.strictEqual(
      getDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation'),
      null,
    );
  });

  it('does not affect other origins or permissions', () => {
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation', true);
    setDecision(db as unknown as PermissionDb, 'https://b.com', 'geolocation', true);
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'media', true);

    forgetDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation');

    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation'), null);
    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://b.com', 'geolocation')?.allowed, true);
    assert.strictEqual(getDecision(db as unknown as PermissionDb, 'https://a.com', 'media')?.allowed, true);
  });

  it('is a no-op when no entry exists', () => {
    // Just shouldn't throw.
    forgetDecision(db as unknown as PermissionDb, 'https://nothing.com', 'geolocation');
  });
});

describe('permission-store: listDecisions', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM feature_settings'); });

  it('returns an empty list when no decisions stored', () => {
    assert.deepStrictEqual(listDecisions(db as unknown as PermissionDb), []);
  });

  it('returns all stored decisions with parsed origin/permission', () => {
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation', true, 100);
    setDecision(db as unknown as PermissionDb, 'https://b.com', 'media', false, 200);

    const list = listDecisions(db as unknown as PermissionDb);
    assert.strictEqual(list.length, 2);
    // Sorted by key — `geolocation:` comes before `media:` alphabetically.
    assert.deepStrictEqual(list[0], {
      permission: 'geolocation',
      origin: 'https://a.com',
      allowed: true,
      timestamp: 100,
    });
    assert.deepStrictEqual(list[1], {
      permission: 'media',
      origin: 'https://b.com',
      allowed: false,
      timestamp: 200,
    });
  });

  it('handles origins with colons (uses first colon as separator)', () => {
    // https URLs include `://` — listDecisions splits on the FIRST colon to
    // recover permission name; the rest is origin.
    setDecision(db as unknown as PermissionDb, 'https://a.com:8080', 'geolocation', true, 1);
    const list = listDecisions(db as unknown as PermissionDb);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].permission, 'geolocation');
    assert.strictEqual(list[0].origin, 'https://a.com:8080');
  });

  it('skips malformed entries instead of throwing', () => {
    setDecision(db as unknown as PermissionDb, 'https://good.com', 'geolocation', true, 1);
    db.prepare(
      `INSERT INTO feature_settings (id, featureId, key, value, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('bad-id', 'page-permissions', 'media:https://bad.com', 'not json', 2);

    const list = listDecisions(db as unknown as PermissionDb);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].origin, 'https://good.com');
  });

  it('only returns decisions for featureId page-permissions, not other features', () => {
    setDecision(db as unknown as PermissionDb, 'https://example.com', 'geolocation', true);
    db.prepare(
      `INSERT INTO feature_settings (id, featureId, key, value, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('other-id', 'system', 'datastore_version', '1', 0);

    const list = listDecisions(db as unknown as PermissionDb);
    assert.strictEqual(list.length, 1);
  });
});

describe('permission-store: forgetAllDecisions', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM feature_settings'); });

  it('clears every page-permissions decision', () => {
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation', true);
    setDecision(db as unknown as PermissionDb, 'https://b.com', 'media', false);
    forgetAllDecisions(db as unknown as PermissionDb);
    assert.deepStrictEqual(listDecisions(db as unknown as PermissionDb), []);
  });

  it('preserves other featureId rows', () => {
    setDecision(db as unknown as PermissionDb, 'https://a.com', 'geolocation', true);
    db.prepare(
      `INSERT INTO feature_settings (id, featureId, key, value, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('sys-id', 'system', 'datastore_version', '1', 0);

    forgetAllDecisions(db as unknown as PermissionDb);

    const sysRow = db
      .prepare(`SELECT key FROM feature_settings WHERE featureId = ?`)
      .get('system') as { key: string } | undefined;
    assert.ok(sysRow, 'system row should still exist');
    assert.strictEqual(sysRow!.key, 'datastore_version');
  });
});
