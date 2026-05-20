/**
 * Unit tests for strict `tile:commands:unregister` capability enforcement.
 *
 * The unregister path uses the existing `commands` boolean capability
 * (same gate as `tile:command:register`). The enforcement helper is
 * `hasCapability(grant, 'commands')` from tile-ipc.ts — covered here
 * via the resolveCapabilities round-trip to mirror the unit-test style
 * used by the other strict-path tests.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// The `commands` capability has no helper module yet — the check is
// inline `hasCapability(grant, 'commands')`. These tests exercise the
// resolveCapabilities contract that feeds that check.
describe('commands capability — resolveCapabilities shape', () => {
  it('omits commands when not requested', () => {
    const grant = makeGrant({});
    assert.strictEqual(grant.capabilities.commands, undefined);
  });

  it('preserves commands: true across resolution', () => {
    const grant = makeGrant({ commands: true });
    assert.strictEqual(grant.capabilities.commands, true);
  });

  it('omits commands when requested as false', () => {
    // Current resolveCapabilities only sets commands when truthy.
    const grant = makeGrant({ commands: false });
    assert.strictEqual(grant.capabilities.commands, undefined);
  });
});

describe('commands unregister gate — symmetry with register', () => {
  // Both `tile:command:register` and `tile:commands:unregister` share
  // the `commands` gate. These tests document that symmetry.

  it('register gate matches unregister gate (same capability)', () => {
    const withGrant = makeGrant({ commands: true });
    const withoutGrant = makeGrant({ pubsub: { scopes: ['self'] } });

    assert.strictEqual(withGrant.capabilities.commands, true);
    assert.strictEqual(withoutGrant.capabilities.commands, undefined);
  });

  it('commands: true is required for both ops', () => {
    const grant = makeGrant({ commands: true });
    // Tile code checks grant.capabilities.commands for both register
    // and unregister. The same check applies.
    assert.ok(grant.capabilities.commands);
  });
});
