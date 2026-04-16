/**
 * Unit tests for strict `tile:izui:*` capability enforcement.
 *
 * Covers the pure helper `checkIzuiAllowed` used by the `tile:izui:*`
 * IPC handlers in `tile-ipc.ts`. Imports from the pure module
 * (`tile-izui-enforcement`) so the test does not pull in `tile-ipc`'s
 * Electron dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkIzuiAllowed } from './tile-izui-enforcement.js';
import { resolveCapabilities, validateTileManifest } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkIzuiAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkIzuiAllowed(null);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /invalid token/i);
  });

  it('rejects when grant has no izui capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkIzuiAllowed(grant);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /izui capability not granted/i);
  });

  it('rejects when izui is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { izui: false as unknown as true },
      denied: [],
    };
    const result = checkIzuiAllowed(grant);
    assert.strictEqual(result.ok, false);
  });
});

// ─── izui: true (full grant) ─────────────────────────────────────────

describe('checkIzuiAllowed — izui: true', () => {
  it('allows when izui is true', () => {
    const grant = makeGrant({ izui: true });
    assert.strictEqual(checkIzuiAllowed(grant).ok, true);
  });

  it('passes through resolveCapabilities unchanged', () => {
    const grant = resolveCapabilities('t', { izui: true }, false);
    assert.strictEqual(grant.capabilities.izui, true);
  });

  it('resolveCapabilities does not fabricate izui when omitted', () => {
    const grant = resolveCapabilities('t', { pubsub: { scopes: ['self'] } }, false);
    assert.strictEqual(grant.capabilities.izui, undefined);
  });
});

// ─── Manifest validation ─────────────────────────────────────────────

describe('tile-manifest validation — izui capability shape', () => {
  it('accepts izui: true', () => {
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: { izui: true },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('accepts izui: false (declared but off)', () => {
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: { izui: false },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('rejects non-boolean izui value', () => {
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: { izui: 'yes' as unknown as boolean },
    });
    assert.ok(
      errors.some(e => e.path === 'capabilities.izui'),
      'expected an izui validation error',
    );
  });
});
