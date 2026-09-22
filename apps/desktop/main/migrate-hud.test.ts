/**
 * Unit tests for migrateHud.
 *
 * Drives the migration directly against an in-memory sqlite DB, same
 * harness as migrate-empty-text-cleanup.test.ts: no Electron boot, real
 * coverage of the SQL the migration runs.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { migrateHud } from './migrate-hud.js';
import { wrapDb } from './datastore.js';

const MIGRATION_ID = 'hud_profile_cleanup_v1';

function makeFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE feature_settings (
      id TEXT PRIMARY KEY,
      featureId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updatedAt INTEGER
    );
    CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      completedAt INTEGER
    );
    CREATE TABLE manifest_cache (
      featureId TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      manifest TEXT NOT NULL,
      commands TEXT,
      nouns TEXT,
      shortcuts TEXT,
      capabilities TEXT,
      lazyEvents TEXT,
      updatedAt INTEGER NOT NULL,
      disabledAt INTEGER
    );
    CREATE TABLE context_history (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT,
      metadata TEXT DEFAULT '{}',
      windowId INTEGER,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      prevEntryId TEXT DEFAULT NULL
    );
  `);
  return db;
}

function upsertFeatureSetting(db: DatabaseSync, id: string, featureId: string, key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt) VALUES (?, ?, ?, ?, ?)`
  ).run(id, featureId, key, value, Date.now());
}

/** Seeds the fixture with one HUD-tainted row per requirement-2 bullet, plus a
 *  non-HUD sibling row of the same shape so the assertions can prove the
 *  migration is surgical, not a blanket wipe. */
function seedHudProfile(db: DatabaseSync): void {
  // Session snapshot — one HUD window entry, one ordinary one.
  const sessionSnapshot = {
    version: 1,
    createdAt: Date.now(),
    reason: 'manual',
    windows: [
      { url: 'peek://hud/hud.html', key: undefined, title: 'HUD', bounds: { x: 20, y: 20, width: 242, height: 268 }, source: 'peek://app/background.html', params: {}, zOrder: 0, focused: false },
      { url: 'https://example.com', key: undefined, title: 'Example', bounds: { x: 0, y: 0, width: 800, height: 600 }, source: 'peek://app/background.html', params: {}, zOrder: 1, focused: true },
    ],
  };
  upsertFeatureSetting(db, 'session-snapshot', 'session', 'snapshot', JSON.stringify(sessionSnapshot));

  // Closed-window stack — one HUD widget entry, one ordinary one.
  const closedStack = [
    { url: 'peek://ext/hud/widgets/mode.html', source: 'peek://app/background.html', bounds: null, spaceMode: null, timestamp: Date.now() },
    { url: 'https://kept.example.com', source: 'peek://app/background.html', bounds: null, spaceMode: null, timestamp: Date.now() },
  ];
  upsertFeatureSetting(db, 'session-closed-window-stack', 'session', 'closed-window-stack', JSON.stringify(closedStack));

  // Per-workspace snapshot — one HUD window entry, one ordinary one.
  const workspaceSnapshot = {
    version: 1,
    spaceId: 'space1',
    spaceName: 'Space One',
    createdAt: Date.now(),
    windows: [
      { url: 'peek://hud/hud.html', bounds: { x: 20, y: 20, width: 242, height: 268 }, zOrder: 0, focused: false },
      { url: 'https://kept-in-space.example.com', bounds: { x: 0, y: 0, width: 800, height: 600 }, zOrder: 1, focused: true },
    ],
  };
  upsertFeatureSetting(db, 'space-workspaces:workspace:space1', 'space-workspaces', 'workspace:space1', JSON.stringify(workspaceSnapshot));

  // Stale HUD feature_settings rows.
  upsertFeatureSetting(db, 'hud-overlay_hud_sheet', 'hud-overlay', 'hud_sheet', JSON.stringify({ widgets: [] }));
  upsertFeatureSetting(db, 'hud-widget_layout', 'hud-widget', 'layout', JSON.stringify({}));
  upsertFeatureSetting(db, 'hud_enabled', 'hud', 'enabled', 'true');

  // A row that must survive — unrelated feature.
  upsertFeatureSetting(db, 'windows-misc', 'windows', 'misc', JSON.stringify({ ok: true }));

  // Builtin-feature toggle row for 'hud', plus one for an unrelated feature.
  db.prepare(
    `INSERT INTO manifest_cache (featureId, version, manifest, updatedAt, disabledAt) VALUES (?, ?, ?, ?, ?)`
  ).run('hud', '1.0.0', '{}', Date.now(), null);
  db.prepare(
    `INSERT INTO manifest_cache (featureId, version, manifest, updatedAt, disabledAt) VALUES (?, ?, ?, ?, ?)`
  ).run('windows', '1.0.0', '{}', Date.now(), null);

  // Context entry keyed by a HUD tile id, plus an unrelated 'mode' entry.
  db.prepare(
    `INSERT INTO context_history (id, key, value, metadata, windowId, source, timestamp, prevEntryId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ctx-hud-overlay', 'hud-overlay', '"some-value"', '{}', 7, 'test', Date.now(), null);
  db.prepare(
    `INSERT INTO context_history (id, key, value, metadata, windowId, source, timestamp, prevEntryId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ctx-mode', 'mode', '"default"', '{}', 9, 'test', Date.now(), null);
}

function getFeatureSettingsValue(db: DatabaseSync, featureId: string, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM feature_settings WHERE featureId = ? AND key = ?').get(featureId, key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('migrateHud', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeFixtureDb();
    seedHudProfile(db);
  });

  it('drops HUD window entries from the session snapshot but keeps ordinary ones', () => {
    migrateHud(wrapDb(db));
    const value = getFeatureSettingsValue(db, 'session', 'snapshot');
    assert.ok(value);
    const snapshot = JSON.parse(value!);
    assert.strictEqual(snapshot.windows.length, 1);
    assert.strictEqual(snapshot.windows[0].url, 'https://example.com');
  });

  it('drops HUD entries from the closed-window stack but keeps ordinary ones', () => {
    migrateHud(wrapDb(db));
    const value = getFeatureSettingsValue(db, 'session', 'closed-window-stack');
    assert.ok(value);
    const stack = JSON.parse(value!);
    assert.strictEqual(stack.length, 1);
    assert.strictEqual(stack[0].url, 'https://kept.example.com');
  });

  it('drops HUD entries from a per-workspace snapshot but keeps ordinary ones', () => {
    migrateHud(wrapDb(db));
    const value = getFeatureSettingsValue(db, 'space-workspaces', 'workspace:space1');
    assert.ok(value);
    const snapshot = JSON.parse(value!);
    assert.strictEqual(snapshot.windows.length, 1);
    assert.strictEqual(snapshot.windows[0].url, 'https://kept-in-space.example.com');
  });

  it('deletes every hud/hud-widget/hud-overlay feature_settings row, leaving unrelated ones', () => {
    migrateHud(wrapDb(db));
    assert.strictEqual(getFeatureSettingsValue(db, 'hud-overlay', 'hud_sheet'), undefined);
    assert.strictEqual(getFeatureSettingsValue(db, 'hud-widget', 'layout'), undefined);
    assert.strictEqual(getFeatureSettingsValue(db, 'hud', 'enabled'), undefined);
    assert.ok(getFeatureSettingsValue(db, 'windows', 'misc'), 'unrelated feature_settings row should survive');
  });

  it('deletes the builtin-feature toggle row for hud, leaving unrelated ones', () => {
    migrateHud(wrapDb(db));
    const hudRow = db.prepare('SELECT * FROM manifest_cache WHERE featureId = ?').get('hud');
    assert.strictEqual(hudRow, undefined);
    const otherRow = db.prepare('SELECT * FROM manifest_cache WHERE featureId = ?').get('windows');
    assert.ok(otherRow, 'unrelated manifest_cache row should survive');
  });

  it('deletes context_history rows keyed by a HUD tile id, leaving unrelated ones', () => {
    migrateHud(wrapDb(db));
    const hudCtx = db.prepare('SELECT * FROM context_history WHERE key = ?').get('hud-overlay');
    assert.strictEqual(hudCtx, undefined);
    const modeCtx = db.prepare('SELECT * FROM context_history WHERE key = ?').get('mode');
    assert.ok(modeCtx, 'unrelated context_history row should survive');
  });

  it('records itself as applied in the migrations table', () => {
    migrateHud(wrapDb(db));
    const record = db.prepare('SELECT status FROM migrations WHERE id = ?').get(MIGRATION_ID) as
      | { status: string }
      | undefined;
    assert.ok(record);
    assert.strictEqual(record!.status, 'complete');
  });

  it('is one-shot — running it twice does not re-run', () => {
    migrateHud(wrapDb(db));

    // Re-taint the profile the way a stale write could after the flag is
    // set — a second run must leave it alone, proving the gate short-circuits.
    upsertFeatureSetting(db, 'hud_enabled_again', 'hud', 'enabled-again', 'true');
    migrateHud(wrapDb(db));

    assert.ok(getFeatureSettingsValue(db, 'hud', 'enabled-again'), 'second run should be a no-op');
  });
});
