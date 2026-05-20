/**
 * Unit tests for strict `tile:dialogs:*` capability enforcement.
 *
 * Covers the pure-helper `checkDialogAllowed` used by the
 * `tile:dialogs:save` / `tile:dialogs:open` IPC handlers in
 * `tile-ipc.ts`. See `docs/tile-preload-trimming-plan.md` §2.4.
 *
 * Imports from the pure module (`tile-dialogs-enforcement`) so the
 * test does not pull in `tile-ipc`'s Electron dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkDialogAllowed } from './tile-dialogs-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkDialogAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkDialogAllowed(null, 'save');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no dialogs capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkDialogAllowed(grant, 'save');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /dialogs capability not granted/i);
    }
  });

  it('rejects when dialogs capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { dialogs: false as unknown as boolean },
      denied: [],
    };
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, false);
  });
});

// ─── dialogs: true (unrestricted) ────────────────────────────────────

describe('checkDialogAllowed — dialogs: true', () => {
  it('allows save when dialogs is true', () => {
    const grant = makeGrant({ dialogs: true });
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, true);
  });

  it('allows open when dialogs is true', () => {
    const grant = makeGrant({ dialogs: true });
    assert.strictEqual(checkDialogAllowed(grant, 'open').ok, true);
  });
});

// ─── dialogs.types allowlist ─────────────────────────────────────────

describe('checkDialogAllowed — types allowlist', () => {
  it('allows a type that appears in the types allowlist', () => {
    const grant = makeGrant({ dialogs: { types: ['save'] } });
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, true);
  });

  it('rejects a type not in the types allowlist', () => {
    const grant = makeGrant({ dialogs: { types: ['save'] } });
    const result = checkDialogAllowed(grant, 'open');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not in capability types allowlist/i);
      assert.match(result.error, /open/);
    }
  });

  it('rejects every type when allowlist is empty', () => {
    const grant = makeGrant({ dialogs: { types: [] } });
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, false);
    assert.strictEqual(checkDialogAllowed(grant, 'open').ok, false);
  });

  it('allows both types when both are in the allowlist', () => {
    const grant = makeGrant({ dialogs: { types: ['save', 'open'] } });
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, true);
    assert.strictEqual(checkDialogAllowed(grant, 'open').ok, true);
  });

  it('allows any type when object form omits types', () => {
    const grant = makeGrant({ dialogs: {} });
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, true);
    assert.strictEqual(checkDialogAllowed(grant, 'open').ok, true);
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — dialogs shape preservation', () => {
  it('preserves dialogs: true across resolution', () => {
    const grant = resolveCapabilities('t', { dialogs: true }, false);
    assert.strictEqual(grant.capabilities.dialogs, true);
  });

  it('preserves dialogs object (with types) across resolution', () => {
    const grant = resolveCapabilities('t', { dialogs: { types: ['save'] } }, false);
    const dc = grant.capabilities.dialogs;
    assert.ok(dc && typeof dc === 'object', 'dialogs should remain an object');
    assert.deepStrictEqual((dc as { types: string[] }).types, ['save']);
  });

  it('end-to-end: resolved grant enforces types allowlist at IPC enforcement point', () => {
    const caps: TileCapabilities = { dialogs: { types: ['save'] } };
    const grant = resolveCapabilities('my-tile', caps, false);
    assert.strictEqual(checkDialogAllowed(grant, 'save').ok, true);
    assert.strictEqual(checkDialogAllowed(grant, 'open').ok, false);
  });
});
