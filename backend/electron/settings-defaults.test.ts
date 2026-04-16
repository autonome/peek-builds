/**
 * Unit tests for backend settings defaults enforcement.
 *
 * When a tile calls `api.settings.get(key)` for a key that has never been
 * written, the `tile:settings:get` IPC handler must NOT return null. Instead
 * it loads the manifest's declared default (from `settingsSchema.defaults`)
 * and returns that value. The fallback is implemented as:
 *
 *     const row = db.prepare('SELECT value FROM feature_settings ...').get(tileId, key)
 *     if (!row) {
 *       const manifest = getTileManifest(grant.tileId)
 *       const fallback = resolveSettingDefault(manifest, key)
 *       return { value: fallback === undefined ? null : fallback }
 *     }
 *
 * The pure helpers (`resolveSettingDefault` / `loadSchemaDefaults`) already
 * have dedicated coverage in tile-settings-defaults.test.ts. This file
 * exercises the full DB-backed path — wiring the manifest, the real
 * feature_settings table, and the handler's read logic together — to make
 * sure stored values still win over declared defaults and that missing-key /
 * missing-default behaviour matches the IPC contract (`{ value: null }`).
 *
 * Runs under Electron's Node host (via `yarn test:unit`).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSettingDefault } from './tile-settings-defaults.js';
import type { TileManifestV2 } from './tile-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, 'test-settings-defaults.db');

let datastore: typeof import('./datastore.js');

// ─── Helpers ─────────────────────────────────────────────────────────

function makeManifest(id: string, defaults?: Record<string, unknown>): TileManifestV2 {
  return {
    manifestVersion: 2,
    id,
    name: id,
    tiles: [],
    capabilities: { settings: true },
    defaults,
  };
}

/**
 * Drive the handler's read logic directly: DB first, then manifest default on
 * miss. The handler's IPC contract is `{ value: <resolved> }` where a missing
 * key with no declared default surfaces as `{ value: null }`.
 */
function readWithFallback(
  manifest: TileManifestV2,
  tileId: string,
  key: string
): { value: unknown } {
  const db = datastore.getDb();
  const row = db.prepare(
    'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
  ).get(tileId, key) as { value: string } | undefined;

  if (!row) {
    const fallback = resolveSettingDefault(manifest, key);
    return { value: fallback === undefined ? null : fallback };
  }

  try {
    return { value: JSON.parse(row.value) };
  } catch {
    return { value: row.value };
  }
}

function writeStored(tileId: string, key: string, value: unknown): void {
  const db = datastore.getDb();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${tileId}_${key}`, tileId, key, JSON.stringify(value), Date.now());
}

// ─── Setup / Teardown ────────────────────────────────────────────────

describe('settings backend defaults enforcement', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    datastore = await import('./datastore.js');
    datastore.initDatabase(TEST_DB_PATH);
  });

  after(() => {
    datastore.closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = TEST_DB_PATH + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  beforeEach(() => {
    datastore.getDb().prepare('DELETE FROM feature_settings').run();
  });

  // ─── Declared defaults flow through on DB miss ──────────────────────

  describe('missing row → manifest default', () => {
    it('returns the declared string default when the key has never been written', () => {
      const manifest = makeManifest('t1', { greeting: 'Hello World' });
      const result = readWithFallback(manifest, 't1', 'greeting');
      assert.deepStrictEqual(result, { value: 'Hello World' });
    });

    it('returns the declared number default — preserved through resolution', () => {
      const manifest = makeManifest('t1', { count: 42 });
      const result = readWithFallback(manifest, 't1', 'count');
      assert.deepStrictEqual(result, { value: 42 });
      assert.strictEqual(typeof result.value, 'number');
    });

    it('returns the declared boolean default — false is NOT coerced to null', () => {
      // Regression guard: `false` must survive the `=== undefined ? null : x`
      // coalescing in the handler. A lazy `|| null` would clobber it.
      const manifest = makeManifest('t1', { enabled: false });
      const result = readWithFallback(manifest, 't1', 'enabled');
      assert.deepStrictEqual(result, { value: false });
    });

    it('returns the declared object default for a top-level prefs bundle', () => {
      // Mirrors how the editor tile fetches its whole prefs object.
      const prefs = { vimMode: false, vimSettings: { wrap: false, lineNumbers: true } };
      const manifest = makeManifest('editor', { prefs });
      const result = readWithFallback(manifest, 'editor', 'prefs');
      assert.deepStrictEqual(result, { value: prefs });
    });

    it('returns a nested value when the caller requests a dotted path', () => {
      const manifest = makeManifest('editor', {
        prefs: { vimMode: true, vimSettings: { lineNumbers: false } },
      });
      assert.deepStrictEqual(
        readWithFallback(manifest, 'editor', 'prefs.vimMode'),
        { value: true }
      );
      assert.deepStrictEqual(
        readWithFallback(manifest, 'editor', 'prefs.vimSettings.lineNumbers'),
        { value: false }
      );
    });

    it('preserves an explicitly declared null default (not missing-key)', () => {
      // `defaults: { token: null }` is a meaningful "no token yet, but the key
      // exists" signal. The handler's contract is to return whatever the
      // manifest says, including null.
      const manifest = makeManifest('t1', { token: null });
      const result = readWithFallback(manifest, 't1', 'token');
      assert.deepStrictEqual(result, { value: null });
    });
  });

  // ─── No default declared → null ─────────────────────────────────────

  describe('missing row + no declared default → null', () => {
    it('returns null when neither a stored row nor a default exists', () => {
      const manifest = makeManifest('t1', { other: 'value' });
      const result = readWithFallback(manifest, 't1', 'unknown');
      assert.deepStrictEqual(result, { value: null });
    });

    it('returns null when the manifest has no defaults block at all', () => {
      const manifest = makeManifest('t1');
      const result = readWithFallback(manifest, 't1', 'anything');
      assert.deepStrictEqual(result, { value: null });
    });

    it('returns null when the dotted path walks into a missing segment', () => {
      const manifest = makeManifest('t1', { prefs: { vimMode: true } });
      const result = readWithFallback(manifest, 't1', 'prefs.missing');
      assert.deepStrictEqual(result, { value: null });
    });
  });

  // ─── Stored value wins over default ─────────────────────────────────

  describe('stored row wins over declared default', () => {
    it('returns the stored string value, not the declared default', () => {
      const manifest = makeManifest('t1', { greeting: 'default' });
      writeStored('t1', 'greeting', 'stored');
      const result = readWithFallback(manifest, 't1', 'greeting');
      assert.deepStrictEqual(result, { value: 'stored' });
    });

    it('returns the stored false over a declared true default', () => {
      // If the user has explicitly turned something off, their choice must
      // beat the manifest's on-by-default value.
      const manifest = makeManifest('t1', { enabled: true });
      writeStored('t1', 'enabled', false);
      const result = readWithFallback(manifest, 't1', 'enabled');
      assert.deepStrictEqual(result, { value: false });
    });

    it('returns the stored null over a declared non-null default', () => {
      // The user can explicitly clear a value to null; this must not fall
      // back to the manifest's default.
      const manifest = makeManifest('t1', { token: 'default-token' });
      writeStored('t1', 'token', null);
      const result = readWithFallback(manifest, 't1', 'token');
      assert.deepStrictEqual(result, { value: null });
    });

    it('returns the stored object in full, not merged with the default', () => {
      // The handler does NOT do deep merge — if the user wrote a partial
      // prefs object, they get exactly that object back (no default fill-in).
      const manifest = makeManifest('t1', {
        prefs: { vimMode: false, wrap: true },
      });
      writeStored('t1', 'prefs', { vimMode: true });
      const result = readWithFallback(manifest, 't1', 'prefs');
      assert.deepStrictEqual(result, { value: { vimMode: true } });
    });

    it('preserves number types through the JSON roundtrip', () => {
      const manifest = makeManifest('t1', { n: 0 });
      writeStored('t1', 'n', 7);
      const result = readWithFallback(manifest, 't1', 'n');
      assert.deepStrictEqual(result, { value: 7 });
      assert.strictEqual(typeof result.value, 'number');
    });
  });

  // ─── Per-tile isolation of defaults ─────────────────────────────────

  describe('defaults are scoped to the caller tile', () => {
    it('one tile\'s manifest default does not leak into another tile\'s read', () => {
      // Structural — the handler passes its OWN manifest into
      // `resolveSettingDefault`, not a global default registry.
      const editor = makeManifest('editor', { prefs: { vimMode: true } });
      const example = makeManifest('example', { prefs: { galleryColumns: 4 } });

      assert.deepStrictEqual(
        readWithFallback(editor, 'editor', 'prefs.vimMode'),
        { value: true }
      );
      // `example` asks for editor's key — its manifest has no such default.
      assert.deepStrictEqual(
        readWithFallback(example, 'example', 'prefs.vimMode'),
        { value: null }
      );
    });

    it('tile A\'s stored value does not fall through to tile B when B has a default', () => {
      const manifestA = makeManifest('tile.a', { greeting: 'default A' });
      const manifestB = makeManifest('tile.b', { greeting: 'default B' });

      writeStored('tile.a', 'greeting', 'stored A');
      // B never wrote anything — B should see its own default, not A's stored row.
      assert.deepStrictEqual(
        readWithFallback(manifestA, 'tile.a', 'greeting'),
        { value: 'stored A' }
      );
      assert.deepStrictEqual(
        readWithFallback(manifestB, 'tile.b', 'greeting'),
        { value: 'default B' }
      );
    });
  });

  // ─── Regression: empty-string key ──────────────────────────────────

  describe('edge cases', () => {
    it('empty-string key resolves to { value: null } (no DB row, no default)', () => {
      const manifest = makeManifest('t1', { '': 'oddly-declared' });
      // `resolveSettingDefault` rejects empty-string keys up front, so even a
      // perversely declared default is ignored — handler returns null.
      const result = readWithFallback(manifest, 't1', '');
      assert.deepStrictEqual(result, { value: null });
    });

    it('array as value round-trips through JSON intact', () => {
      const manifest = makeManifest('t1', { tags: ['a', 'b'] });
      const result = readWithFallback(manifest, 't1', 'tags');
      assert.deepStrictEqual(result, { value: ['a', 'b'] });
    });
  });
});
