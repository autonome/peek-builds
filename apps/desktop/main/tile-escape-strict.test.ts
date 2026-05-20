/**
 * Unit tests for strict `tile:escape:*` capability enforcement.
 *
 * Escape is a UX primitive — any tile with a valid token may register
 * an onEscape callback, regardless of declared capabilities. The
 * pure-module `checkEscapeAllowed` only rejects on invalid token.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkEscapeAllowed } from './tile-escape-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

describe('checkEscapeAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkEscapeAllowed(null);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });
});

describe('checkEscapeAllowed — no capability gate', () => {
  it('allows a tile with no capabilities at all', () => {
    const grant = makeGrant({});
    const result = checkEscapeAllowed(grant);
    assert.strictEqual(result.ok, true);
  });

  it('allows a tile with only pubsub', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkEscapeAllowed(grant);
    assert.strictEqual(result.ok, true);
  });

  it('allows a tile with rich capabilities', () => {
    const grant = makeGrant({
      pubsub: { scopes: ['self', 'global'] },
      commands: true,
      window: true,
      shortcuts: true,
    });
    const result = checkEscapeAllowed(grant);
    assert.strictEqual(result.ok, true);
  });

  it('allows a builtin tile', () => {
    const grant = makeGrant({}, true);
    const result = checkEscapeAllowed(grant);
    assert.strictEqual(result.ok, true);
  });
});
