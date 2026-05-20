/**
 * Unit tests for strict `tile:oauth:*` capability enforcement.
 *
 * Covers the pure helper `checkOAuthAllowed` used by the
 * `tile:oauth:start-loopback` / `tile:oauth:await-callback` IPC handlers
 * in `tile-ipc.ts`. Imports from the pure module (`tile-oauth-enforcement`)
 * so the test does not pull in `tile-ipc`'s Electron dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkOAuthAllowed, type OAuthOp } from './tile-oauth-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

const ALL_OPS: OAuthOp[] = ['start-loopback', 'await-callback'];

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkOAuthAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    for (const op of ALL_OPS) {
      const result = checkOAuthAllowed(null, op);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /invalid token/i);
      }
    }
  });

  it('rejects when grant has no oauth capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    for (const op of ALL_OPS) {
      const result = checkOAuthAllowed(grant, op);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /oauth capability not granted/i);
      }
    }
  });

  it('rejects when oauth capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { oauth: false as unknown as boolean },
      denied: [],
    };
    for (const op of ALL_OPS) {
      assert.strictEqual(checkOAuthAllowed(grant, op).ok, false);
    }
  });
});

// ─── oauth: true (unrestricted) ──────────────────────────────────────

describe('checkOAuthAllowed — oauth: true', () => {
  it('allows start-loopback for any provider when oauth is true', () => {
    const grant = makeGrant({ oauth: true });
    for (const p of ['google', 'soundcloud', 'reddit', 'unknown']) {
      const result = checkOAuthAllowed(grant, 'start-loopback', p);
      assert.strictEqual(result.ok, true, `expected ${p} to be allowed`);
    }
  });

  it('allows start-loopback without a provider hint', () => {
    const grant = makeGrant({ oauth: true });
    assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback').ok, true);
  });

  it('allows await-callback when oauth is true', () => {
    const grant = makeGrant({ oauth: true });
    assert.strictEqual(checkOAuthAllowed(grant, 'await-callback').ok, true);
  });
});

// ─── oauth.providers allowlist ──────────────────────────────────────

describe('checkOAuthAllowed — providers allowlist', () => {
  it('allows a provider that appears in the allowlist', () => {
    const grant = makeGrant({ oauth: { providers: ['google', 'reddit'] } });
    assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback', 'google').ok, true);
    assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback', 'reddit').ok, true);
  });

  it('rejects a provider not in the allowlist', () => {
    const grant = makeGrant({ oauth: { providers: ['google'] } });
    const result = checkOAuthAllowed(grant, 'start-loopback', 'reddit');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /reddit/);
      assert.match(result.error, /not in capability providers allowlist/i);
    }
  });

  it('rejects every provider when allowlist is empty', () => {
    const grant = makeGrant({ oauth: { providers: [] } });
    for (const p of ['google', 'reddit', 'soundcloud']) {
      assert.strictEqual(
        checkOAuthAllowed(grant, 'start-loopback', p).ok,
        false,
        `expected ${p} rejected by empty allowlist`,
      );
    }
  });

  it('treats "*" as blanket provider access', () => {
    const grant = makeGrant({ oauth: { providers: ['*'] } });
    for (const p of ['google', 'reddit', 'soundcloud', 'anything']) {
      assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback', p).ok, true);
    }
  });

  it('allows start-loopback without provider when allowlist declared (not consulted)', () => {
    // Consuming tiles that care about restrictions should always pass a
    // hint. When they don't, we grant (the capability's presence is
    // sufficient) — documented behaviour.
    const grant = makeGrant({ oauth: { providers: ['google'] } });
    assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback').ok, true);
  });

  it('await-callback ignores provider allowlist (port-keyed, no provider)', () => {
    // The callback is resolved by loopback port, not by provider.
    const grant = makeGrant({ oauth: { providers: ['google'] } });
    assert.strictEqual(checkOAuthAllowed(grant, 'await-callback').ok, true);
    // Even with a (meaningless) provider hint, await-callback passes.
    assert.strictEqual(checkOAuthAllowed(grant, 'await-callback', 'reddit').ok, true);
  });

  it('allows any provider when object form omits providers', () => {
    const grant = makeGrant({ oauth: {} });
    for (const p of ['google', 'reddit', 'soundcloud']) {
      assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback', p).ok, true);
    }
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — oauth shape preservation', () => {
  it('preserves oauth: true across resolution', () => {
    const grant = resolveCapabilities('t', { oauth: true }, false);
    assert.strictEqual(grant.capabilities.oauth, true);
  });

  it('preserves oauth.providers array across resolution', () => {
    const grant = resolveCapabilities(
      't',
      { oauth: { providers: ['google', 'reddit'] } },
      false,
    );
    const oc = grant.capabilities.oauth;
    assert.ok(oc && typeof oc === 'object', 'oauth should remain an object');
    assert.deepStrictEqual((oc as { providers: string[] }).providers, ['google', 'reddit']);
  });

  it('end-to-end: resolved grant enforces providers allowlist at IPC enforcement point', () => {
    const caps: TileCapabilities = { oauth: { providers: ['google'] } };
    const grant = resolveCapabilities('wonderwall', caps, false);
    assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback', 'google').ok, true);
    assert.strictEqual(checkOAuthAllowed(grant, 'start-loopback', 'reddit').ok, false);
  });
});
