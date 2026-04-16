/**
 * Unit tests for strict `tile:session:*` capability enforcement.
 *
 * Covers `checkSessionAllowed` used by `tile:session:save-space-workspaces`.
 * The `session` capability is declared as a boolean — no sub-flags
 * for now, so all session ops require the same grant.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkSessionAllowed } from './tile-session-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

describe('checkSessionAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkSessionAllowed(null, 'save-space-workspaces');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no session capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkSessionAllowed(grant, 'save-space-workspaces');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /session capability not granted/i);
    }
  });

  it('rejects when session capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { session: false as unknown as boolean },
      denied: [],
    };
    const result = checkSessionAllowed(grant, 'save-space-workspaces');
    assert.strictEqual(result.ok, false);
  });
});

describe('checkSessionAllowed — session: true', () => {
  it('allows save-space-workspaces when session is true', () => {
    const grant = makeGrant({ session: true });
    const result = checkSessionAllowed(grant, 'save-space-workspaces');
    assert.strictEqual(result.ok, true);
  });
});

describe('resolveCapabilities — session shape preservation', () => {
  it('preserves session: true across resolution', () => {
    const grant = resolveCapabilities('t', { session: true }, false);
    assert.strictEqual(grant.capabilities.session, true);
  });

  it('omits session when not requested', () => {
    const grant = resolveCapabilities('t', {}, false);
    assert.strictEqual(grant.capabilities.session, undefined);
  });
});
