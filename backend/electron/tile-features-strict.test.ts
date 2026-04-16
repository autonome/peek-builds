/**
 * Unit tests for strict `tile:features:*` capability enforcement.
 *
 * Covers the pure helpers `checkFeaturesAllowed` / `sourceTypeAllowed`
 * used by the `tile:features:*` IPC handlers in `tile-ipc.ts`.
 *
 * Imports from the pure module (`tile-features-enforcement`) so the
 * test does not pull in `tile-ipc`'s Electron dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  checkFeaturesAllowed,
  sourceTypeAllowed,
  type FeaturesAction,
} from './tile-features-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

const ALL_ACTIONS: FeaturesAction[] = ['read', 'install', 'manage'];

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkFeaturesAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    for (const action of ALL_ACTIONS) {
      const result = checkFeaturesAllowed(null, action);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /invalid token/i);
      }
    }
  });

  it('rejects when grant has no features capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    for (const action of ALL_ACTIONS) {
      const result = checkFeaturesAllowed(grant, action);
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /features capability not granted/i);
      }
    }
  });

  it('rejects when features capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { features: false as unknown as boolean },
      denied: [],
    };
    for (const action of ALL_ACTIONS) {
      assert.strictEqual(checkFeaturesAllowed(grant, action).ok, false);
    }
  });
});

// ─── features: true (shorthand → read-only) ──────────────────────────

describe('checkFeaturesAllowed — features: true (read-only shorthand)', () => {
  it('allows read when features is true', () => {
    const grant = makeGrant({ features: true });
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
  });

  it('rejects install when features is true (privileged, must be explicit)', () => {
    const grant = makeGrant({ features: true });
    const result = checkFeaturesAllowed(grant, 'install');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /features\.install capability not granted/i);
    }
  });

  it('rejects manage when features is true (privileged, must be explicit)', () => {
    const grant = makeGrant({ features: true });
    const result = checkFeaturesAllowed(grant, 'manage');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /features\.manage capability not granted/i);
    }
  });
});

// ─── Per-action gating ───────────────────────────────────────────────

describe('checkFeaturesAllowed — per-action flags', () => {
  it('features: { read: true } allows only read', () => {
    const grant = makeGrant({ features: { read: true } });
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'install').ok, false);
    assert.strictEqual(checkFeaturesAllowed(grant, 'manage').ok, false);
  });

  it('features: { install: true } allows install + read (read defaults true)', () => {
    const grant = makeGrant({ features: { install: true } });
    assert.strictEqual(checkFeaturesAllowed(grant, 'install').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'manage').ok, false);
  });

  it('features: { manage: true } allows manage + read (read defaults true)', () => {
    const grant = makeGrant({ features: { manage: true } });
    assert.strictEqual(checkFeaturesAllowed(grant, 'manage').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'install').ok, false);
  });

  it('features: { read: false } blocks reads even when capability is declared', () => {
    const grant = makeGrant({ features: { read: false, manage: true } });
    const result = checkFeaturesAllowed(grant, 'read');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /features\.read capability not granted/i);
    }
    // But manage is still allowed.
    assert.strictEqual(checkFeaturesAllowed(grant, 'manage').ok, true);
  });

  it('features: { read: true, install: true, manage: true } allows all', () => {
    const grant = makeGrant({
      features: { read: true, install: true, manage: true },
    });
    for (const action of ALL_ACTIONS) {
      assert.strictEqual(checkFeaturesAllowed(grant, action).ok, true);
    }
  });

  it('features: {} (empty object) defaults read true, install/manage false', () => {
    const grant = makeGrant({ features: {} });
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'install').ok, false);
    assert.strictEqual(checkFeaturesAllowed(grant, 'manage').ok, false);
  });
});

// ─── Source allowlist ────────────────────────────────────────────────

describe('checkFeaturesAllowed — sources allowlist', () => {
  it('allows any source when sources is omitted', () => {
    const grant = makeGrant({ features: { manage: true } });
    for (const src of ['builtin', 'local', 'atproto', 'url', 'dev'] as const) {
      assert.strictEqual(
        checkFeaturesAllowed(grant, 'manage', src).ok,
        true,
        `source ${src} should be allowed`,
      );
    }
  });

  it('rejects a source not in the allowlist', () => {
    const grant = makeGrant({
      features: { manage: true, sources: ['atproto'] },
    });
    const result = checkFeaturesAllowed(grant, 'manage', 'builtin');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /features source "builtin" not in capability sources allowlist/i);
    }
  });

  it('allows a source in the allowlist', () => {
    const grant = makeGrant({
      features: { install: true, sources: ['atproto', 'url'] },
    });
    assert.strictEqual(checkFeaturesAllowed(grant, 'install', 'atproto').ok, true);
    assert.strictEqual(checkFeaturesAllowed(grant, 'install', 'url').ok, true);
  });

  it('rejects every source when allowlist is empty', () => {
    const grant = makeGrant({
      features: { manage: true, sources: [] },
    });
    for (const src of ['builtin', 'local', 'atproto', 'url', 'dev'] as const) {
      assert.strictEqual(
        checkFeaturesAllowed(grant, 'manage', src).ok,
        false,
        `source ${src} should be rejected by empty allowlist`,
      );
    }
  });

  it('source check does not kick in when sourceType is omitted (collection queries)', () => {
    const grant = makeGrant({
      features: { read: true, sources: ['atproto'] },
    });
    // No source type supplied — gate passes at the action level.
    // Callers use `sourceTypeAllowed` to post-filter individual entries.
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
  });

  it('action gate runs before source gate', () => {
    // Even if the source is in the allowlist, a blocked action rejects first.
    const grant = makeGrant({
      features: { read: true, sources: ['atproto'] },
    });
    const result = checkFeaturesAllowed(grant, 'install', 'atproto');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /features\.install capability not granted/i);
    }
  });
});

// ─── sourceTypeAllowed helper ────────────────────────────────────────

describe('sourceTypeAllowed', () => {
  it('returns false when grant is null', () => {
    assert.strictEqual(sourceTypeAllowed(null, 'atproto'), false);
  });

  it('returns false when capability is missing', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    assert.strictEqual(sourceTypeAllowed(grant, 'atproto'), false);
  });

  it('returns true for any source when sources is omitted', () => {
    const grant = makeGrant({ features: { read: true } });
    for (const src of ['builtin', 'local', 'atproto', 'url', 'dev'] as const) {
      assert.strictEqual(sourceTypeAllowed(grant, src), true);
    }
  });

  it('returns true for listed sources, false for others', () => {
    const grant = makeGrant({
      features: { read: true, sources: ['atproto', 'local'] },
    });
    assert.strictEqual(sourceTypeAllowed(grant, 'atproto'), true);
    assert.strictEqual(sourceTypeAllowed(grant, 'local'), true);
    assert.strictEqual(sourceTypeAllowed(grant, 'builtin'), false);
    assert.strictEqual(sourceTypeAllowed(grant, 'url'), false);
    assert.strictEqual(sourceTypeAllowed(grant, 'dev'), false);
  });

  it('features: true shorthand has no sources allowlist (accepts all)', () => {
    const grant = makeGrant({ features: true });
    for (const src of ['builtin', 'local', 'atproto', 'url', 'dev'] as const) {
      assert.strictEqual(sourceTypeAllowed(grant, src), true);
    }
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — features shape preservation', () => {
  it('preserves features: true across resolution', () => {
    const grant = resolveCapabilities('t', { features: true }, false);
    assert.strictEqual(grant.capabilities.features, true);
  });

  it('preserves features object (with actions) across resolution', () => {
    const grant = resolveCapabilities(
      't',
      { features: { install: true, manage: true } },
      false,
    );
    const fc = grant.capabilities.features;
    assert.ok(fc && typeof fc === 'object', 'features should remain an object');
    const obj = fc as { install?: boolean; manage?: boolean };
    assert.strictEqual(obj.install, true);
    assert.strictEqual(obj.manage, true);
  });

  it('preserves features.sources across resolution', () => {
    const grant = resolveCapabilities(
      't',
      { features: { read: true, sources: ['atproto', 'url'] } },
      false,
    );
    const fc = grant.capabilities.features;
    assert.ok(fc && typeof fc === 'object');
    const obj = fc as { sources?: string[] };
    assert.deepStrictEqual(obj.sources, ['atproto', 'url']);
  });

  it('end-to-end: resolved grant enforces action + source gates at IPC check', () => {
    const caps: TileCapabilities = {
      features: { install: true, sources: ['atproto'] },
    };
    const grant = resolveCapabilities('my-tile', caps, false);

    // install from an allowed source → ok
    assert.strictEqual(checkFeaturesAllowed(grant, 'install', 'atproto').ok, true);
    // install from a disallowed source → rejected
    const badSource = checkFeaturesAllowed(grant, 'install', 'local');
    assert.strictEqual(badSource.ok, false);
    if (!badSource.ok) {
      assert.match(badSource.error, /not in capability sources allowlist/i);
    }
    // read is implicitly allowed
    assert.strictEqual(checkFeaturesAllowed(grant, 'read').ok, true);
    // manage is NOT granted
    assert.strictEqual(checkFeaturesAllowed(grant, 'manage').ok, false);
  });
});

// ─── Manifest validation (end-to-end for new capability shape) ──────

describe('tile-manifest validation — features capability shape', () => {
  it('accepts boolean form', async () => {
    const { validateTileManifest } = await import('./tile-manifest.js');
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: { features: true },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('accepts full object form', async () => {
    const { validateTileManifest } = await import('./tile-manifest.js');
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: {
        features: {
          read: true, install: true, manage: true,
          sources: ['atproto', 'local'],
        },
      },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('rejects invalid source type', async () => {
    const { validateTileManifest } = await import('./tile-manifest.js');
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: {
        features: { sources: ['atproto', 'unknown-source'] as unknown as string[] },
      },
    });
    assert.ok(
      errors.some(e => e.path.startsWith('capabilities.features.sources')),
      'expected a sources validation error',
    );
  });

  it('rejects non-boolean action flag', async () => {
    const { validateTileManifest } = await import('./tile-manifest.js');
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: {
        features: { read: 'yes' as unknown as boolean },
      },
    });
    assert.ok(
      errors.some(e => e.path === 'capabilities.features.read'),
      'expected a read validation error',
    );
  });

  it('rejects invalid features value (string)', async () => {
    const { validateTileManifest } = await import('./tile-manifest.js');
    const errors = validateTileManifest({
      id: 't', name: 'T',
      tiles: [{ id: 'bg', type: 'background', url: 'bg.html' }],
      capabilities: {
        features: 'yes' as unknown as boolean,
      },
    });
    assert.ok(
      errors.some(e => e.path === 'capabilities.features'),
      'expected a features validation error',
    );
  });
});
