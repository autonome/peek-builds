/**
 * Unit tests for settings per-tile isolation.
 *
 * The `tile:settings:get` / `tile:settings:set` IPC handlers in tile-ipc.ts
 * scope every read and write to `grant.tileId` — the tile ID is resolved from
 * the capability token, never passed in by the caller. Two guarantees follow:
 *
 *   1. Token → grant.tileId mapping is stable: a token for tile A can only
 *      ever resolve to tile A's ID.
 *   2. SQL scoping on `(featureId, key)` isolates rows between tiles: even
 *      though the table is shared, no tile's query can return another's rows.
 *
 * These tests exercise both guarantees directly against the pure modules the
 * handler uses (tile-tokens + datastore SQL). The handler itself is a thin
 * adapter — if the token map and SQL scoping are correct, it is correct by
 * construction.
 *
 * Runs under Electron's Node host (via `yarn test:unit`).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateToken,
  getGrantForToken,
  validateToken,
  revokeToken,
  revokeTokensForTile,
  clearAllTokens,
} from './tile-tokens.js';
import { resolveCapabilities } from './tile-manifest.js';
import { hasCapability } from './tile-datastore-scope.js';
import type { TileCapabilities } from './tile-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, 'test-settings-isolation.db');

// Lazy datastore import — the module initializes SQLite on first import.
let datastore: typeof import('./datastore.js');

// ─── Helpers ─────────────────────────────────────────────────────────

function tokenFor(tileId: string, caps: TileCapabilities, builtin = true): string {
  const grant = resolveCapabilities(tileId, caps, builtin);
  return generateToken(tileId, 'background', grant);
}

/**
 * Simulate the `tile:settings:set` handler's DB write path.
 * The handler uses `grant.tileId` as featureId — never the caller-supplied value.
 */
function simulateSet(token: string, key: string, value: unknown): { ok: true } | { error: string } {
  const grant = getGrantForToken(token);
  if (!grant) return { error: 'Invalid token' };
  if (!hasCapability(grant, 'settings')) return { error: 'Settings capability not granted' };

  const db = datastore.getDb();
  const jsonValue = JSON.stringify(value);
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${grant.tileId}_${key}`, grant.tileId, key, jsonValue, Date.now());
  return { ok: true };
}

/**
 * Simulate the `tile:settings:get` handler's DB read path (stored-value branch only).
 * Returns `{ value }` on hit, `{ missing: true }` on DB miss — the handler's
 * default-fallback branch is exercised separately in settings-defaults.test.ts.
 */
function simulateGet(token: string, key: string): { value: unknown } | { missing: true } | { error: string } {
  const grant = getGrantForToken(token);
  if (!grant) return { error: 'Invalid token' };
  if (!hasCapability(grant, 'settings')) return { error: 'Settings capability not granted' };

  const db = datastore.getDb();
  const row = db.prepare(
    'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
  ).get(grant.tileId, key) as { value: string } | undefined;

  if (!row) return { missing: true };
  try {
    return { value: JSON.parse(row.value) };
  } catch {
    return { value: row.value };
  }
}

/**
 * Simulate the `tile:settings:list` semantics — rows scoped to the caller's
 * tileId. There is no `tile:settings:list` IPC handler today; this helper
 * exists to assert the SQL scoping itself, independent of whether the IPC
 * exposes it.
 */
function simulateList(token: string): Array<{ key: string; value: unknown }> | { error: string } {
  const grant = getGrantForToken(token);
  if (!grant) return { error: 'Invalid token' };
  if (!hasCapability(grant, 'settings')) return { error: 'Settings capability not granted' };

  const db = datastore.getDb();
  const rows = db.prepare(
    'SELECT key, value FROM feature_settings WHERE featureId = ?'
  ).all(grant.tileId) as Array<{ key: string; value: string }>;

  return rows.map(r => {
    try {
      return { key: r.key, value: JSON.parse(r.value) };
    } catch {
      return { key: r.key, value: r.value };
    }
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────────

describe('settings per-tile isolation', () => {
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
    clearAllTokens();
    // Wipe the feature_settings table between tests so stored state from one
    // test can't accidentally satisfy another's isolation assertion.
    const db = datastore.getDb();
    db.prepare('DELETE FROM feature_settings').run();
  });

  // ─── Token → grant.tileId scoping ──────────────────────────────────

  describe('token → grant.tileId resolution', () => {
    it('resolves a token to the tile that requested it, not another tile', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      const grantA = getGrantForToken(tokenA);
      const grantB = getGrantForToken(tokenB);

      assert.ok(grantA, 'tokenA should resolve to a grant');
      assert.ok(grantB, 'tokenB should resolve to a grant');
      assert.strictEqual(grantA.tileId, 'tile.a');
      assert.strictEqual(grantB.tileId, 'tile.b');
      assert.notStrictEqual(grantA.tileId, grantB.tileId);
    });

    it('returns null for an unknown / fabricated token', () => {
      tokenFor('tile.a', { settings: true });
      assert.strictEqual(getGrantForToken('tile-does-not-exist'), null);
      // A caller who guesses a token shape gets nothing back.
      assert.strictEqual(getGrantForToken('tile-0000000000000000'), null);
    });

    it('returns null for empty / undefined tokens', () => {
      assert.strictEqual(getGrantForToken(''), null);
      assert.strictEqual(validateToken(''), null);
    });

    it('revoking tile A\'s token does not invalidate tile B\'s token', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      revokeToken(tokenA);

      assert.strictEqual(getGrantForToken(tokenA), null);
      const grantB = getGrantForToken(tokenB);
      assert.ok(grantB);
      assert.strictEqual(grantB.tileId, 'tile.b');
    });

    it('revokeTokensForTile only revokes the named tile\'s tokens', () => {
      const tokenA1 = tokenFor('tile.a', { settings: true });
      const tokenA2 = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      revokeTokensForTile('tile.a');

      assert.strictEqual(getGrantForToken(tokenA1), null);
      assert.strictEqual(getGrantForToken(tokenA2), null);
      assert.ok(getGrantForToken(tokenB));
    });
  });

  // ─── Settings capability gate ──────────────────────────────────────

  describe('settings capability gate', () => {
    it('hasCapability(grant, "settings") is true when granted', () => {
      const token = tokenFor('tile.a', { settings: true });
      const grant = getGrantForToken(token)!;
      assert.strictEqual(hasCapability(grant, 'settings'), true);
    });

    it('hasCapability(grant, "settings") is false when not requested', () => {
      const token = tokenFor('tile.a', { pubsub: { scopes: ['self'] } });
      const grant = getGrantForToken(token)!;
      assert.strictEqual(hasCapability(grant, 'settings'), false);
    });

    it('hasCapability(grant, "settings") is false when only datastore is granted', () => {
      // A tile with `datastore` but no `settings` must not be able to use the
      // settings IPC — different capability surfaces, different scoping rules.
      const token = tokenFor('tile.a', { datastore: { tables: ['feature_settings'] } });
      const grant = getGrantForToken(token)!;
      assert.strictEqual(hasCapability(grant, 'settings'), false);
    });

    it('set / get reject a tile with no settings capability', () => {
      const token = tokenFor('tile.nods', { pubsub: { scopes: ['self'] } });
      const setResult = simulateSet(token, 'foo', 'bar');
      assert.ok('error' in setResult);
      assert.match(setResult.error, /Settings capability not granted/);

      const getResult = simulateGet(token, 'foo');
      assert.ok('error' in getResult);
      assert.match(getResult.error, /Settings capability not granted/);
    });
  });

  // ─── Per-tile SQL scoping ───────────────────────────────────────────

  describe('per-tile SQL scoping on feature_settings', () => {
    it('tile B cannot read a key that tile A wrote', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      // A writes "greeting".
      assert.deepStrictEqual(simulateSet(tokenA, 'greeting', 'hello from A'), { ok: true });

      // A reads its own value.
      assert.deepStrictEqual(simulateGet(tokenA, 'greeting'), { value: 'hello from A' });

      // B reads the same key — misses (no row for featureId=tile.b).
      assert.deepStrictEqual(simulateGet(tokenB, 'greeting'), { missing: true });
    });

    it('tile A and tile B can hold independent values under the same key', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      simulateSet(tokenA, 'theme', 'dark');
      simulateSet(tokenB, 'theme', 'light');

      assert.deepStrictEqual(simulateGet(tokenA, 'theme'), { value: 'dark' });
      assert.deepStrictEqual(simulateGet(tokenB, 'theme'), { value: 'light' });
    });

    it('tile B writing does not overwrite tile A\'s existing value', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      simulateSet(tokenA, 'count', 1);
      simulateSet(tokenB, 'count', 99);
      simulateSet(tokenB, 'count', 100);

      // A's value untouched by B's repeated writes.
      assert.deepStrictEqual(simulateGet(tokenA, 'count'), { value: 1 });
      assert.deepStrictEqual(simulateGet(tokenB, 'count'), { value: 100 });
    });

    it('list returns only the caller tile\'s keys', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      simulateSet(tokenA, 'a1', 'one');
      simulateSet(tokenA, 'a2', 'two');
      simulateSet(tokenB, 'b1', 'uno');

      const listedForA = simulateList(tokenA);
      assert.ok(Array.isArray(listedForA));
      const keysA = (listedForA as Array<{ key: string }>).map(r => r.key).sort();
      assert.deepStrictEqual(keysA, ['a1', 'a2']);

      const listedForB = simulateList(tokenB);
      assert.ok(Array.isArray(listedForB));
      const keysB = (listedForB as Array<{ key: string }>).map(r => r.key).sort();
      assert.deepStrictEqual(keysB, ['b1']);
    });

    it('deleting tile A\'s key does not affect tile B', () => {
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      simulateSet(tokenA, 'shared-key', 'A value');
      simulateSet(tokenB, 'shared-key', 'B value');

      // Emulate a scoped delete: the handler would use grant.tileId as featureId.
      const grantA = getGrantForToken(tokenA)!;
      datastore.getDb().prepare(
        'DELETE FROM feature_settings WHERE featureId = ? AND key = ?'
      ).run(grantA.tileId, 'shared-key');

      assert.deepStrictEqual(simulateGet(tokenA, 'shared-key'), { missing: true });
      assert.deepStrictEqual(simulateGet(tokenB, 'shared-key'), { value: 'B value' });
    });

    it('INSERT OR REPLACE key collision uses the scoped primary key {tileId}_{key}', () => {
      // The handler builds the row id as `${grant.tileId}_${key}`. Two tiles
      // writing the same key produce two distinct primary keys, so neither
      // clobbers the other via PK collision.
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      simulateSet(tokenA, 'foo', 'A');
      simulateSet(tokenB, 'foo', 'B');

      const db = datastore.getDb();
      const rows = db.prepare(
        'SELECT id, featureId, key, value FROM feature_settings WHERE key = ? ORDER BY id'
      ).all('foo') as Array<{ id: string; featureId: string; key: string; value: string }>;

      assert.strictEqual(rows.length, 2, 'both tiles should have their own row');
      const ids = rows.map(r => r.id).sort();
      assert.deepStrictEqual(ids, ['tile.a_foo', 'tile.b_foo']);
      const byTile: Record<string, string> = {};
      for (const r of rows) byTile[r.featureId] = JSON.parse(r.value);
      assert.strictEqual(byTile['tile.a'], 'A');
      assert.strictEqual(byTile['tile.b'], 'B');
    });
  });

  // ─── Caller cannot forge featureId ──────────────────────────────────

  describe('caller cannot override featureId', () => {
    it('the handler uses grant.tileId — callers have no way to pass featureId in the IPC shape', () => {
      // The IPC args are { token, key, value } — there is no `featureId` field
      // to forge. This test encodes that structural guarantee as an assertion
      // on the token → tileId mapping: only the tile that owns the token can
      // ever write under its featureId.
      const tokenA = tokenFor('tile.a', { settings: true });
      const tokenB = tokenFor('tile.b', { settings: true });

      const grantA = getGrantForToken(tokenA)!;
      const grantB = getGrantForToken(tokenB)!;

      assert.strictEqual(grantA.tileId, 'tile.a');
      assert.strictEqual(grantB.tileId, 'tile.b');

      // Even if tile A's code tried to be malicious and remember tile B's
      // tileId, it cannot pass `grant.tileId` — the handler reads it from
      // the grant attached to *its own* token.
      simulateSet(tokenA, 'admin', 'pwned');
      assert.deepStrictEqual(simulateGet(tokenB, 'admin'), { missing: true });
    });
  });
});
