/**
 * Unit tests for the network-fetch domain allowlist (isNetworkDomainAllowed).
 *
 * This is the enforcement that REPLACES `webSecurity:false`: non-CORS hosts
 * are reached via the main-process `tile:network:fetch` (net.fetch), which is
 * domain-gated here. Tightening webSecurity is only safe if this gate actually
 * rejects domains a tile didn't declare — these tests pin that contract.
 *
 * Note the deliberate asymmetry: a `trustedBuiltin` grant (e.g. Lex) BYPASSES
 * the allowlist entirely, so its manifest `network.domains` list is advisory
 * for builtins. Non-builtin tiles are strictly gated.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { isNetworkDomainAllowed } from './tile-network-enforcement.js';
import type { CapabilityGrant } from './tile-manifest.js';

function grantWith(domains: string[], trustedBuiltin = false): CapabilityGrant {
  return {
    tileId: 'fixture',
    capabilities: { network: { domains } },
    denied: [],
    trustedBuiltin,
  } as unknown as CapabilityGrant;
}

describe('isNetworkDomainAllowed', () => {
  it('allows a domain that is explicitly listed', () => {
    const grant = grantWith(['lexidex.bsky.dev']);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'lexidex.bsky.dev'), true);
  });

  it('rejects a domain outside a specific allowlist (non-builtin tile)', () => {
    const grant = grantWith(['lexidex.bsky.dev']);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'evil.example.com'), false);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'bsky.dev'), false);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'sub.lexidex.bsky.dev'), false);
  });

  it('supports *. wildcard suffix matching', () => {
    const grant = grantWith(['*.bsky.network']);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'morel.us-east.host.bsky.network'), true);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'bsky.dev'), false);
  });

  it('rejects everything when no network capability is granted (non-builtin)', () => {
    const grant = { tileId: 'x', capabilities: {}, denied: [] } as unknown as CapabilityGrant;
    assert.strictEqual(isNetworkDomainAllowed(grant, 'lexidex.bsky.dev'), false);
  });

  it('trustedBuiltin bypasses the allowlist (any domain allowed)', () => {
    const grant = grantWith(['lexidex.bsky.dev'], true);
    assert.strictEqual(isNetworkDomainAllowed(grant, 'lexidex.bsky.dev'), true);
    // outside the declared list, but trustedBuiltin → still allowed
    assert.strictEqual(isNetworkDomainAllowed(grant, 'anything.example.com'), true);
  });
});
