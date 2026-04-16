/**
 * Unit tests for `tile:datastore:*` scoped per-table enforcement.
 *
 * These tests cover `validateTileDatastoreRequest` — the shared helper every
 * handler calls before delegating to the real datastore module. The helper
 * enforces:
 *
 *   1. Token must resolve to a grant (via tile-tokens)
 *   2. Grant must include the `datastore` capability
 *   3. Every table in the operation's required list must be in the grant
 *   4. Unknown tables (not in the core allow-list) are rejected
 *
 * Testing the IPC handlers end-to-end requires the Electron ipcMain machinery
 * plus a real BrowserWindow. The helper is the correctness boundary — if it
 * is right, each handler that delegates to it is right by construction.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import { validateTileDatastoreRequest } from './tile-datastore-scope.js';
import {
  generateToken,
  clearAllTokens,
} from './tile-tokens.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function grantTokenFor(tileId: string, caps: TileCapabilities, builtin = true): string {
  const grant = resolveCapabilities(tileId, caps, builtin);
  return generateToken(tileId, 'background', grant);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('validateTileDatastoreRequest — token validation', () => {
  beforeEach(() => clearAllTokens());

  it('rejects undefined token', () => {
    const result = validateTileDatastoreRequest(undefined, ['items']);
    assert.ok('error' in result);
    assert.match(result.error, /Invalid token/);
  });

  it('rejects empty-string token', () => {
    const result = validateTileDatastoreRequest('', ['items']);
    assert.ok('error' in result);
    assert.match(result.error, /Invalid token/);
  });

  it('rejects unknown token', () => {
    const result = validateTileDatastoreRequest('tile-does-not-exist', ['items']);
    assert.ok('error' in result);
    assert.match(result.error, /Invalid token/);
  });

  it('rejects non-string token', () => {
    // Pretend the caller passed a number — be defensive.
    const result = validateTileDatastoreRequest(123 as unknown as string, ['items']);
    assert.ok('error' in result);
    assert.match(result.error, /Invalid token/);
  });
});

describe('validateTileDatastoreRequest — capability check', () => {
  beforeEach(() => clearAllTokens());

  it('rejects a tile with no datastore capability', () => {
    const token = grantTokenFor('t-nods', {
      pubsub: { scopes: ['self'] },
    });
    const result = validateTileDatastoreRequest(token, ['items']);
    assert.ok('error' in result);
    assert.match(result.error, /Datastore capability not granted/);
  });

  it('accepts a tile with datastore capability + granted table', () => {
    const token = grantTokenFor('t-ok', {
      datastore: { tables: ['items'] },
    });
    const result = validateTileDatastoreRequest(token, ['items']);
    assert.ok('grant' in result);
    assert.strictEqual(result.grant.tileId, 't-ok');
  });
});

describe('validateTileDatastoreRequest — per-table scoping', () => {
  beforeEach(() => clearAllTokens());

  it('accepts a single granted table', () => {
    const token = grantTokenFor('t-tables', {
      datastore: { tables: ['items', 'tags'] },
    });
    const result = validateTileDatastoreRequest(token, ['items']);
    assert.ok('grant' in result);
  });

  it('rejects a single non-granted table', () => {
    const token = grantTokenFor('t-tables2', {
      datastore: { tables: ['items'] },
    });
    const result = validateTileDatastoreRequest(token, ['tags']);
    assert.ok('error' in result);
    assert.match(result.error, /Table not allowed: tags/);
  });

  it('rejects an invalid/unknown table name', () => {
    const token = grantTokenFor('t-tables3', {
      datastore: { tables: ['not_a_real_table'] },
    });
    const result = validateTileDatastoreRequest(token, ['not_a_real_table']);
    assert.ok('error' in result);
    assert.match(result.error, /Invalid table/);
  });
});

describe('validateTileDatastoreRequest — multi-table operations', () => {
  beforeEach(() => clearAllTokens());

  it('accepts when every required table is granted', () => {
    const token = grantTokenFor('t-multi-ok', {
      datastore: { tables: ['items', 'tags', 'item_tags'] },
    });
    const result = validateTileDatastoreRequest(token, ['tags', 'item_tags']);
    assert.ok('grant' in result);
  });

  it('rejects when any required table is missing — first table missing', () => {
    const token = grantTokenFor('t-multi-miss1', {
      datastore: { tables: ['item_tags'] }, // missing 'tags'
    });
    const result = validateTileDatastoreRequest(token, ['tags', 'item_tags']);
    assert.ok('error' in result);
    assert.match(result.error, /Table not allowed: tags/);
  });

  it('rejects when any required table is missing — second table missing', () => {
    const token = grantTokenFor('t-multi-miss2', {
      datastore: { tables: ['tags'] }, // missing 'item_tags'
    });
    const result = validateTileDatastoreRequest(token, ['tags', 'item_tags']);
    assert.ok('error' in result);
    assert.match(result.error, /Table not allowed: item_tags/);
  });

  it('reports the first missing table deterministically', () => {
    const token = grantTokenFor('t-multi-miss-all', {
      datastore: { tables: [] }, // none granted
    });
    const result = validateTileDatastoreRequest(token, ['items', 'tags', 'item_tags']);
    assert.ok('error' in result);
    // Should complain about 'items' first, not 'tags' or 'item_tags'.
    assert.match(result.error, /Table not allowed: items/);
  });

  it('accepts the three-table combo used by tag-related ops', () => {
    // Mirrors what features/tags and features/groups declare.
    const token = grantTokenFor('t-triple', {
      datastore: { tables: ['items', 'tags', 'item_tags', 'item_events'] },
    });
    // tag-item path
    assert.ok('grant' in validateTileDatastoreRequest(token, ['tags', 'item_tags']));
    // get-items-by-tag path
    assert.ok('grant' in validateTileDatastoreRequest(token, ['items', 'item_tags']));
    // add-item path
    assert.ok('grant' in validateTileDatastoreRequest(token, ['items']));
    // add-item-event path
    assert.ok('grant' in validateTileDatastoreRequest(token, ['item_events']));
  });
});

describe('validateTileDatastoreRequest — denial for non-builtin', () => {
  beforeEach(() => clearAllTokens());

  it('still accepts datastore for non-builtin tiles (resolveCapabilities does not deny datastore)', () => {
    // Non-builtin may request datastore; only filesystem/sync are restricted.
    const token = grantTokenFor('t-3p', { datastore: { tables: ['items'] } }, /* builtin */ false);
    const result = validateTileDatastoreRequest(token, ['items']);
    assert.ok('grant' in result);
    assert.strictEqual(result.grant.tileId, 't-3p');
  });
});
