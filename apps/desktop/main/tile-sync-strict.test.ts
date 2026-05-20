/**
 * Unit tests for strict `tile:sync:sync-all` capability enforcement.
 *
 * Covers the pure helper `checkSyncAllowed` used by the
 * `tile:sync:sync-all` IPC handler in `tile-ipc.ts`. Imports from the
 * pure module (`tile-sync-enforcement`) so the test does not pull in
 * `tile-ipc`'s Electron dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkSyncAllowed } from './tile-sync-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin: boolean): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkSyncAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkSyncAllowed(null);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no sync capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } }, false);
    const result = checkSyncAllowed(grant);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /sync capability not granted/i);
    }
  });

  it('rejects when sync capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { sync: false as boolean },
      denied: [],
    };
    const result = checkSyncAllowed(grant);
    assert.strictEqual(result.ok, false);
  });
});

// ─── sync: true (builtin-only) ──────────────────────────────────────

describe('checkSyncAllowed — sync: true', () => {
  it('allows when sync is true and tile is builtin', () => {
    const grant = makeGrant({ sync: true }, true);
    assert.strictEqual(checkSyncAllowed(grant).ok, true);
  });

  it('rejects when sync was requested by non-builtin (denied at resolution)', () => {
    // resolveCapabilities denies sync for external tiles.
    const grant = makeGrant({ sync: true }, false);
    assert.strictEqual(grant.capabilities.sync, undefined);
    assert.ok(grant.denied.includes('sync'));
    assert.strictEqual(checkSyncAllowed(grant).ok, false);
  });
});

// ─── Grant-resolution interop ───────────────────────────────────────

describe('resolveCapabilities — sync builtin gate', () => {
  it('grants sync to builtin tiles', () => {
    const grant = resolveCapabilities('sync-feature', { sync: true }, true);
    assert.strictEqual(grant.capabilities.sync, true);
    assert.deepStrictEqual(grant.denied, []);
  });

  it('denies sync to external tiles', () => {
    const grant = resolveCapabilities('external-tile', { sync: true }, false);
    assert.strictEqual(grant.capabilities.sync, undefined);
    assert.ok(grant.denied.includes('sync'));
  });

  it('end-to-end: builtin grant passes IPC enforcement', () => {
    const caps: TileCapabilities = { sync: true };
    const grant = resolveCapabilities('sync', caps, true);
    assert.strictEqual(checkSyncAllowed(grant).ok, true);
  });

  it('end-to-end: external grant fails IPC enforcement', () => {
    const caps: TileCapabilities = { sync: true };
    const grant = resolveCapabilities('rogue-tile', caps, false);
    assert.strictEqual(checkSyncAllowed(grant).ok, false);
  });
});
