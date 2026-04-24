/**
 * Unit tests for Tile Manifest v2 — parsing, validation, capability resolution
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  detectManifestVersion,
  validateTileManifest,
  parseManifestJSON,
  resolveCapabilities,
  convertV1ToV2,
  type TileCapabilities,
} from './tile-manifest.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const VALID_V2_MANIFEST = {
  manifestVersion: 3,
  id: 'test-tile',
  name: 'Test Tile',
  description: 'A test tile',
  version: '1.0.0',
  builtin: false,
  tiles: [
    {
      id: 'background',
      url: 'background.html',
      resident: true,
    },
  ],
  capabilities: {
    pubsub: { scopes: ['self', 'global'] },
    commands: true,
  },
  commands: [
    {
      name: 'test command',
      description: 'A test command',
      action: { type: 'execute' },
    },
  ],
};

const VALID_V1_MANIFEST = {
  id: 'legacy-ext',
  name: 'Legacy Extension',
  version: '1.0.0',
  background: 'background.html',
  builtin: true,
  commands: [
    {
      name: 'legacy cmd',
      action: { type: 'execute' },
    },
  ],
};

// ─── Version Detection ───────────────────────────────────────────────

describe('detectManifestVersion', () => {
  it('should detect v2 by manifestVersion field (current schema = 3)', () => {
    assert.strictEqual(detectManifestVersion({ manifestVersion: 3 }), 'v2');
  });

  it('should detect v2 by tiles + capabilities', () => {
    assert.strictEqual(
      detectManifestVersion({ tiles: [], capabilities: {} }),
      'v2'
    );
  });

  it('should detect v1 for legacy manifest', () => {
    assert.strictEqual(
      detectManifestVersion(VALID_V1_MANIFEST as Record<string, unknown>),
      'v1'
    );
  });

  it('should detect v1 when only tiles present (no capabilities)', () => {
    assert.strictEqual(
      detectManifestVersion({ tiles: [] }),
      'v1'
    );
  });

  it('should detect v1 when only capabilities present (no tiles)', () => {
    assert.strictEqual(
      detectManifestVersion({ capabilities: {} }),
      'v1'
    );
  });

  it('should detect v1 for empty object', () => {
    assert.strictEqual(detectManifestVersion({}), 'v1');
  });

  it('should detect v1 for manifestVersion 1', () => {
    assert.strictEqual(detectManifestVersion({ manifestVersion: 1 }), 'v1');
  });

  it('should detect v1 for legacy manifestVersion 2 (pre-v1-removal compat fields)', () => {
    assert.strictEqual(detectManifestVersion({ manifestVersion: 2 }), 'v1');
  });
});

// ─── Validation ──────────────────────────────────────────────────────

describe('validateTileManifest', () => {
  it('should pass for valid v2 manifest', () => {
    const errors = validateTileManifest(VALID_V2_MANIFEST as Record<string, unknown>);
    assert.strictEqual(errors.length, 0);
  });

  it('should reject missing id', () => {
    const manifest = { ...VALID_V2_MANIFEST, id: undefined };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path === 'id'));
  });

  it('should reject missing name', () => {
    const manifest = { ...VALID_V2_MANIFEST, name: undefined };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path === 'name'));
  });

  it('should reject missing tiles array', () => {
    const manifest = { ...VALID_V2_MANIFEST, tiles: 'not-array' };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path === 'tiles'));
  });

  it('should reject too many tiles', () => {
    const tiles = Array.from({ length: 11 }, (_, i) => ({
      id: `tile-${i}`, url: 'index.html',
    }));
    const manifest = { ...VALID_V2_MANIFEST, tiles };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path === 'tiles' && e.message.includes('maximum')));
  });

  it('should reject duplicate tile ids', () => {
    const tiles = [
      { id: 'dup', url: 'a.html' },
      { id: 'dup', url: 'b.html', resident: true },
    ];
    const manifest = { ...VALID_V2_MANIFEST, tiles };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.message.includes('duplicate')));
  });

  it('should reject removed tile.type field (compat dropped in manifestVersion 3)', () => {
    const tiles = [{ id: 'bad', type: 'background', url: 'index.html' }];
    const manifest = { ...VALID_V2_MANIFEST, tiles };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path.endsWith('.type')));
  });

  it('should reject removed tile.windowHints field (compat dropped in manifestVersion 3)', () => {
    const tiles = [{ id: 'bad', url: 'index.html', windowHints: { width: 100 } }];
    const manifest = { ...VALID_V2_MANIFEST, tiles };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path.endsWith('.windowHints')));
  });

  it('should reject tile without url', () => {
    const tiles = [{ id: 'no-url' }];
    const manifest = { ...VALID_V2_MANIFEST, tiles };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.message.includes('url')));
  });

  it('should reject missing capabilities object', () => {
    const manifest = { ...VALID_V2_MANIFEST, capabilities: null };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path === 'capabilities'));
  });

  it('should reject invalid pubsub scope', () => {
    const manifest = {
      ...VALID_V2_MANIFEST,
      capabilities: { pubsub: { scopes: ['invalid'] } },
    };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.message.includes('invalid scope')));
  });

  it('should reject too many network domains', () => {
    const domains = Array.from({ length: 51 }, (_, i) => `domain${i}.com`);
    const manifest = {
      ...VALID_V2_MANIFEST,
      capabilities: { network: { domains } },
    };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.message.includes('maximum')));
  });

  it('should reject commands without name', () => {
    const manifest = {
      ...VALID_V2_MANIFEST,
      commands: [{ action: { type: 'execute' } }],
    };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path.includes('commands')));
  });

  it('should reject commands without action', () => {
    const manifest = {
      ...VALID_V2_MANIFEST,
      commands: [{ name: 'test' }],
    };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.ok(errors.some(e => e.path.includes('commands')));
  });

  it('should accept empty tiles array', () => {
    const manifest = { ...VALID_V2_MANIFEST, tiles: [] };
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.strictEqual(errors.length, 0);
  });

  it('should accept manifest with no commands', () => {
    const { commands, ...manifest } = VALID_V2_MANIFEST;
    const errors = validateTileManifest(manifest as Record<string, unknown>);
    assert.strictEqual(errors.length, 0);
  });
});

// ─── Parsing ─────────────────────────────────────────────────────────

describe('parseManifestJSON', () => {
  it('should parse valid v2 manifest', () => {
    const result = parseManifestJSON(VALID_V2_MANIFEST as Record<string, unknown>);
    assert.ok(result);
    assert.strictEqual(result.version, 'v2');
    assert.ok(result.v2);
    assert.strictEqual(result.v2.id, 'test-tile');
  });

  it('should parse v1 manifest', () => {
    const result = parseManifestJSON(VALID_V1_MANIFEST as Record<string, unknown>);
    assert.ok(result);
    assert.strictEqual(result.version, 'v1');
    assert.strictEqual(result.v2, undefined);
  });

  it('should return null for invalid v2 manifest', () => {
    const result = parseManifestJSON({
      manifestVersion: 3,
      // missing required fields
    });
    assert.strictEqual(result, null);
  });
});

// ─── Capability Resolution ───────────────────────────────────────────

describe('resolveCapabilities', () => {
  it('should grant pubsub self and global for non-builtin', () => {
    const requested: TileCapabilities = {
      pubsub: { scopes: ['self', 'global'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.ok(grant.capabilities.pubsub);
    assert.ok(grant.capabilities.pubsub.scopes.includes('self'));
    assert.ok(grant.capabilities.pubsub.scopes.includes('global'));
    assert.strictEqual(grant.denied.length, 0);
  });

  it('should deny pubsub system scope for non-builtin', () => {
    const requested: TileCapabilities = {
      pubsub: { scopes: ['self', 'global', 'system'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.ok(grant.capabilities.pubsub);
    assert.ok(!grant.capabilities.pubsub.scopes.includes('system'));
    assert.ok(grant.denied.includes('pubsub.system'));
  });

  it('should grant pubsub system scope for builtin', () => {
    const requested: TileCapabilities = {
      pubsub: { scopes: ['self', 'global', 'system'] },
    };
    const grant = resolveCapabilities('test', requested, true);
    assert.ok(grant.capabilities.pubsub);
    assert.ok(grant.capabilities.pubsub.scopes.includes('system'));
    assert.strictEqual(grant.denied.length, 0);
  });

  it('should always include self scope in pubsub', () => {
    const requested: TileCapabilities = {
      pubsub: { scopes: ['global'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.ok(grant.capabilities.pubsub);
    assert.ok(grant.capabilities.pubsub.scopes.includes('self'));
  });

  it('should grant network domains as requested', () => {
    const requested: TileCapabilities = {
      network: { domains: ['api.github.com', '*.example.com'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.ok(grant.capabilities.network);
    assert.deepStrictEqual(grant.capabilities.network.domains, ['api.github.com', '*.example.com']);
  });

  it('should grant datastore tables as requested', () => {
    const requested: TileCapabilities = {
      datastore: { tables: ['items', 'tags'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.ok(grant.capabilities.datastore);
    assert.deepStrictEqual(grant.capabilities.datastore.tables, ['items', 'tags']);
  });

  it('should deny filesystem for non-builtin', () => {
    const requested: TileCapabilities = {
      filesystem: { read: ['/tmp/*'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.strictEqual(grant.capabilities.filesystem, undefined);
    assert.ok(grant.denied.includes('filesystem'));
  });

  it('should grant filesystem for builtin', () => {
    const requested: TileCapabilities = {
      filesystem: { read: ['/tmp/*'] },
    };
    const grant = resolveCapabilities('test', requested, true);
    assert.ok(grant.capabilities.filesystem);
    assert.deepStrictEqual(grant.capabilities.filesystem.read, ['/tmp/*']);
  });

  it('should deny sync for non-builtin', () => {
    const requested: TileCapabilities = {
      sync: true,
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.strictEqual(grant.capabilities.sync, undefined);
    assert.ok(grant.denied.includes('sync'));
  });

  it('should grant sync for builtin', () => {
    const requested: TileCapabilities = {
      sync: true,
    };
    const grant = resolveCapabilities('test', requested, true);
    assert.strictEqual(grant.capabilities.sync, true);
  });

  it('should grant commands as requested', () => {
    const requested: TileCapabilities = {
      commands: true,
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.strictEqual(grant.capabilities.commands, true);
  });

  it('should grant window capabilities as requested', () => {
    const requested: TileCapabilities = {
      window: { create: true, query: true },
    };
    const grant = resolveCapabilities('test', requested, false);
    const wc = grant.capabilities.window;
    assert.ok(wc && typeof wc === 'object', 'window should be an object after resolution');
    assert.strictEqual((wc as { create: boolean }).create, true);
    assert.strictEqual((wc as { query: boolean }).query, true);
  });

  it('should grant theme and settings as requested', () => {
    const requested: TileCapabilities = {
      theme: true,
      settings: true,
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.strictEqual(grant.capabilities.theme, true);
    assert.strictEqual(grant.capabilities.settings, true);
  });

  it('should handle empty capabilities', () => {
    const grant = resolveCapabilities('test', {}, false);
    assert.strictEqual(grant.denied.length, 0);
    assert.deepStrictEqual(grant.capabilities, {});
  });

  it('should preserve pubsub topics allowlist', () => {
    const requested: TileCapabilities = {
      pubsub: { scopes: ['global'], topics: ['sync:*', 'item:created'] },
    };
    const grant = resolveCapabilities('test', requested, false);
    assert.ok(grant.capabilities.pubsub);
    assert.deepStrictEqual(grant.capabilities.pubsub.topics, ['sync:*', 'item:created']);
  });
});

// ─── V1 to V2 Conversion ────────────────────────────────────────────

describe('convertV1ToV2', () => {
  it('should convert basic v1 manifest', () => {
    const v2 = convertV1ToV2(VALID_V1_MANIFEST as Record<string, unknown>);
    assert.strictEqual(v2.manifestVersion, 3);
    assert.strictEqual(v2.id, 'legacy-ext');
    assert.strictEqual(v2.name, 'Legacy Extension');
    assert.strictEqual(v2.builtin, true);
    assert.strictEqual(v2.tiles.length, 1);
    assert.strictEqual(v2.tiles[0].resident, true);
    assert.strictEqual(v2.tiles[0].url, 'background.html');
  });

  it('should convert manifest with no background', () => {
    const v1 = { id: 'no-bg', name: 'No Background', background: false };
    const v2 = convertV1ToV2(v1 as Record<string, unknown>);
    assert.strictEqual(v2.tiles.length, 0);
  });

  it('should carry over commands', () => {
    const v2 = convertV1ToV2(VALID_V1_MANIFEST as Record<string, unknown>);
    assert.ok(v2.commands);
    assert.strictEqual(v2.commands!.length, 1);
    assert.strictEqual(v2.commands![0].name, 'legacy cmd');
  });

  it('should infer pubsub capabilities', () => {
    const v2 = convertV1ToV2(VALID_V1_MANIFEST as Record<string, unknown>);
    assert.ok(v2.capabilities.pubsub);
    assert.ok(v2.capabilities.pubsub.scopes.includes('self'));
    assert.ok(v2.capabilities.pubsub.scopes.includes('global'));
  });

  it('should infer commands capability from commands array', () => {
    const v2 = convertV1ToV2(VALID_V1_MANIFEST as Record<string, unknown>);
    assert.strictEqual(v2.capabilities.commands, true);
  });

  it('should mark lazy if v1 was lazy', () => {
    const v1 = { ...VALID_V1_MANIFEST, lazy: true };
    const v2 = convertV1ToV2(v1 as Record<string, unknown>);
    assert.strictEqual(v2.tiles[0].lazy, true);
    assert.strictEqual(v2.tiles[0].resident, false);
  });
});
