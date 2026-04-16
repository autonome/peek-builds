/**
 * Unit tests for strict `tile:context:*` capability enforcement.
 *
 * Covers the pure-helper `checkContextAllowed` used by the
 * `tile:context:*` IPC handlers in `tile-ipc.ts`. See
 * `docs/tile-preload-trimming-plan.md` §2.5 for the capability
 * design and §6 for the test strategy.
 *
 * Imports from the pure module (`tile-context-enforcement`) so the
 * test does not pull in `tile-ipc`'s Electron dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkContextAllowed } from './tile-context-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkContextAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkContextAllowed(null, 'get', 'foo');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no context capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkContextAllowed(grant, 'get', 'foo');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /context capability not granted/i);
    }
  });

  it('rejects when context capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { context: false as unknown as boolean },
      denied: [],
    };
    const result = checkContextAllowed(grant, 'get', 'foo');
    assert.strictEqual(result.ok, false);
  });
});

// ─── context: true (unrestricted) ────────────────────────────────────

describe('checkContextAllowed — context: true', () => {
  it('allows any read key when context is true', () => {
    const grant = makeGrant({ context: true });
    for (const key of ['foo', 'mode', 'bar.baz']) {
      assert.strictEqual(checkContextAllowed(grant, 'get', key).ok, true);
      assert.strictEqual(checkContextAllowed(grant, 'history', key).ok, true);
    }
  });

  it('allows any non-mode write key when context is true', () => {
    // context: true sugars to {} (no `modes` flag), so writing the
    // reserved `mode` key still requires explicit modes: true.
    const grant = makeGrant({ context: true });
    assert.strictEqual(checkContextAllowed(grant, 'set', 'foo').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'set', 'whatever').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'set', 'mode').ok, false);
  });

  it('allows snapshot when context is true', () => {
    const grant = makeGrant({ context: true });
    assert.strictEqual(checkContextAllowed(grant, 'snapshot').ok, true);
  });

  it('rejects windowsWithValue when queryWindows not set (context: true)', () => {
    // context: true does NOT imply queryWindows.
    const grant = makeGrant({ context: true });
    assert.strictEqual(checkContextAllowed(grant, 'windowsWithValue').ok, false);
    assert.strictEqual(checkContextAllowed(grant, 'windowsInSpace').ok, false);
  });
});

// ─── context.read allowlist ──────────────────────────────────────────

describe('checkContextAllowed — read allowlist', () => {
  it('allows read key in allowlist', () => {
    const grant = makeGrant({ context: { read: ['mode', 'space'] } });
    assert.strictEqual(checkContextAllowed(grant, 'get', 'mode').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'history', 'space').ok, true);
  });

  it('rejects read key not in allowlist', () => {
    const grant = makeGrant({ context: { read: ['mode'] } });
    const result = checkContextAllowed(grant, 'get', 'secrets');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not in read allowlist/i);
      assert.match(result.error, /secrets/);
    }
  });

  it('rejects every key when read allowlist is empty', () => {
    const grant = makeGrant({ context: { read: [] } });
    for (const key of ['mode', 'foo']) {
      assert.strictEqual(checkContextAllowed(grant, 'get', key).ok, false);
    }
  });

  it('omitting read allows any key', () => {
    const grant = makeGrant({ context: { write: ['x'] } });
    assert.strictEqual(checkContextAllowed(grant, 'get', 'anything').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'history', 'anything').ok, true);
  });

  it('rejects read without a key when allowlist is present', () => {
    const grant = makeGrant({ context: { read: ['mode'] } });
    const result = checkContextAllowed(grant, 'get');
    assert.strictEqual(result.ok, false);
  });
});

// ─── context.write allowlist ─────────────────────────────────────────

describe('checkContextAllowed — write allowlist', () => {
  it('allows write key in allowlist', () => {
    const grant = makeGrant({ context: { write: ['entities'] } });
    assert.strictEqual(checkContextAllowed(grant, 'set', 'entities').ok, true);
  });

  it('rejects write key not in allowlist', () => {
    const grant = makeGrant({ context: { write: ['entities'] } });
    const result = checkContextAllowed(grant, 'set', 'secrets');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not in write allowlist/i);
    }
  });

  it('rejects every write when write allowlist is empty', () => {
    const grant = makeGrant({ context: { write: [] } });
    assert.strictEqual(checkContextAllowed(grant, 'set', 'x').ok, false);
  });

  it('rejects set without a key', () => {
    const grant = makeGrant({ context: true });
    const result = checkContextAllowed(grant, 'set');
    assert.strictEqual(result.ok, false);
  });
});

// ─── mode key special case ───────────────────────────────────────────

describe('checkContextAllowed — mode key requires modes flag', () => {
  it('rejects writing mode when modes flag is false', () => {
    const grant = makeGrant({ context: { write: ['mode'] } });
    const result = checkContextAllowed(grant, 'set', 'mode');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /modes capability required/i);
    }
  });

  it('allows writing mode when both write allowlist and modes flag set', () => {
    const grant = makeGrant({ context: { write: ['mode'], modes: true } });
    assert.strictEqual(checkContextAllowed(grant, 'set', 'mode').ok, true);
  });

  it('allows writing mode when context is unrestricted and modes: true', () => {
    const grant = makeGrant({ context: { modes: true } });
    assert.strictEqual(checkContextAllowed(grant, 'set', 'mode').ok, true);
  });

  it('reading mode does not require modes flag', () => {
    const grant = makeGrant({ context: { read: ['mode'] } });
    assert.strictEqual(checkContextAllowed(grant, 'get', 'mode').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'history', 'mode').ok, true);
  });
});

// ─── queryWindows ────────────────────────────────────────────────────

describe('checkContextAllowed — queryWindows', () => {
  it('allows windowsWithValue with queryWindows: true', () => {
    const grant = makeGrant({ context: { queryWindows: true } });
    assert.strictEqual(checkContextAllowed(grant, 'windowsWithValue').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'windowsInSpace').ok, true);
  });

  it('rejects windowsWithValue without queryWindows', () => {
    const grant = makeGrant({ context: { read: ['mode'] } });
    const result = checkContextAllowed(grant, 'windowsWithValue');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /queryWindows capability required/i);
    }
  });

  it('rejects windowsInSpace without queryWindows', () => {
    const grant = makeGrant({ context: { read: ['mode'] } });
    assert.strictEqual(checkContextAllowed(grant, 'windowsInSpace').ok, false);
  });
});

// ─── snapshot ────────────────────────────────────────────────────────

describe('checkContextAllowed — snapshot', () => {
  it('allows snapshot whenever context capability is present', () => {
    assert.strictEqual(checkContextAllowed(makeGrant({ context: true }), 'snapshot').ok, true);
    assert.strictEqual(checkContextAllowed(makeGrant({ context: {} }), 'snapshot').ok, true);
    assert.strictEqual(checkContextAllowed(makeGrant({ context: { read: [] } }), 'snapshot').ok, true);
  });

  it('rejects snapshot without context capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    assert.strictEqual(checkContextAllowed(grant, 'snapshot').ok, false);
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — context shape preservation', () => {
  it('preserves context: true across resolution', () => {
    const grant = resolveCapabilities('t', { context: true }, false);
    assert.strictEqual(grant.capabilities.context, true);
  });

  it('preserves context object with lists and flags across resolution', () => {
    const grant = resolveCapabilities(
      't',
      { context: { read: ['mode'], write: ['mode'], modes: true, queryWindows: true } },
      false,
    );
    const cc = grant.capabilities.context;
    assert.ok(cc && typeof cc === 'object', 'context should remain an object');
    const obj = cc as { read?: string[]; write?: string[]; modes?: boolean; queryWindows?: boolean };
    assert.deepStrictEqual(obj.read, ['mode']);
    assert.deepStrictEqual(obj.write, ['mode']);
    assert.strictEqual(obj.modes, true);
    assert.strictEqual(obj.queryWindows, true);
  });

  it('end-to-end: resolved grant enforces write allowlist at IPC enforcement point', () => {
    const caps: TileCapabilities = { context: { write: ['entities'] } };
    const grant = resolveCapabilities('my-tile', caps, false);
    assert.strictEqual(checkContextAllowed(grant, 'set', 'entities').ok, true);
    assert.strictEqual(checkContextAllowed(grant, 'set', 'rogue').ok, false);
  });
});
