/**
 * Unit tests for Tile Launcher — token management
 *
 * Note: BrowserWindow creation cannot be tested in pure unit tests
 * (requires Electron app context). These tests cover the token
 * management and query functions that can run standalone.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import {
  generateToken,
  validateToken,
  revokeToken,
  getGrantForToken,
} from './tile-tokens.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { TileCapabilities, CapabilityGrant } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(tileId: string, caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities(tileId, caps, builtin);
}

// ─── Token Generation ────────────────────────────────────────────────

describe('generateToken', () => {
  it('should generate a unique token string', () => {
    const grant = makeGrant('test', { pubsub: { scopes: ['self'] } });
    const token = generateToken('test', 'bg', grant);
    assert.ok(typeof token === 'string');
    assert.ok(token.startsWith('tile-'));
    assert.ok(token.length > 10);
  });

  it('should generate different tokens each time', () => {
    const grant = makeGrant('test', {});
    const t1 = generateToken('test', 'bg', grant);
    const t2 = generateToken('test', 'bg', grant);
    assert.notStrictEqual(t1, t2);
  });
});

// ─── Token Validation ────────────────────────────────────────────────

describe('validateToken', () => {
  it('should validate a generated token', () => {
    const grant = makeGrant('test-validate', { commands: true });
    const token = generateToken('test-validate', 'bg', grant);
    const record = validateToken(token);
    assert.ok(record);
    assert.strictEqual(record.tileId, 'test-validate');
    assert.strictEqual(record.tileEntryId, 'bg');
  });

  it('should return null for invalid token', () => {
    const record = validateToken('invalid-token-123');
    assert.strictEqual(record, null);
  });

  it('should return null for empty string', () => {
    const record = validateToken('');
    assert.strictEqual(record, null);
  });
});

// ─── Token Revocation ────────────────────────────────────────────────

describe('revokeToken', () => {
  it('should revoke a valid token', () => {
    const grant = makeGrant('test-revoke', {});
    const token = generateToken('test-revoke', 'bg', grant);

    assert.ok(validateToken(token));
    assert.strictEqual(revokeToken(token), true);
    assert.strictEqual(validateToken(token), null);
  });

  it('should return false for already revoked token', () => {
    const grant = makeGrant('test-revoke2', {});
    const token = generateToken('test-revoke2', 'bg', grant);
    revokeToken(token);
    assert.strictEqual(revokeToken(token), false);
  });

  it('should return false for nonexistent token', () => {
    assert.strictEqual(revokeToken('does-not-exist'), false);
  });
});

// ─── Grant Retrieval ─────────────────────────────────────────────────

describe('getGrantForToken', () => {
  it('should return the grant for a valid token', () => {
    const caps: TileCapabilities = {
      pubsub: { scopes: ['self', 'global'] },
      commands: true,
      network: { domains: ['api.example.com'] },
    };
    const grant = makeGrant('test-grant', caps, false);
    const token = generateToken('test-grant', 'bg', grant);

    const retrieved = getGrantForToken(token);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.tileId, 'test-grant');
    assert.ok(retrieved.capabilities.pubsub);
    assert.strictEqual(retrieved.capabilities.commands, true);
    assert.ok(retrieved.capabilities.network);
  });

  it('should return null for invalid token', () => {
    assert.strictEqual(getGrantForToken('nope'), null);
  });

  it('should return null for revoked token', () => {
    const grant = makeGrant('test-revoked', {});
    const token = generateToken('test-revoked', 'bg', grant);
    revokeToken(token);
    assert.strictEqual(getGrantForToken(token), null);
  });

  it('should enforce denied capabilities are not in grant', () => {
    const caps: TileCapabilities = {
      filesystem: { read: ['/tmp/*'] },
      sync: true,
    };
    // Non-builtin: filesystem and sync should be denied
    const grant = makeGrant('test-denied', caps, false);
    const token = generateToken('test-denied', 'bg', grant);

    const retrieved = getGrantForToken(token);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.capabilities.filesystem, undefined);
    assert.strictEqual(retrieved.capabilities.sync, undefined);
    assert.ok(retrieved.denied.includes('filesystem'));
    assert.ok(retrieved.denied.includes('sync'));
  });

  it('should grant filesystem and sync for builtin', () => {
    const caps: TileCapabilities = {
      filesystem: { read: ['/tmp/*'] },
      sync: true,
    };
    const grant = makeGrant('test-builtin', caps, true);
    const token = generateToken('test-builtin', 'bg', grant);

    const retrieved = getGrantForToken(token);
    assert.ok(retrieved);
    assert.ok(retrieved.capabilities.filesystem);
    assert.strictEqual(retrieved.capabilities.sync, true);
    assert.strictEqual(retrieved.denied.length, 0);
  });
});
