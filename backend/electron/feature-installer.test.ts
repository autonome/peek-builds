/**
 * Unit tests for Feature Installer
 *
 * Pure Node tests — no Electron dependency.
 * Creates temp directories with fake feature structures.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeatureRegistry } from './feature-registry.js';
import {
  scanBuiltinFeatures,
  installFromLocalDirectory,
  syncBuiltinFeatures,
  computeManifestHash,
} from './feature-installer.js';

// ─── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let registryDir: string;
let featuresDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feature-installer-test-'));
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
}

function makeTileManifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 3,
    id,
    name: `Feature ${id}`,
    version: '1.0.0',
    tiles: [
      { id: 'background', url: 'background.html', resident: true },
    ],
    capabilities: {
      pubsub: { scopes: ['self', 'global'] },
      commands: true,
    },
    commands: [
      { name: `${id} command`, action: { type: 'execute' } },
    ],
    ...overrides,
  };
}

function makeV1Manifest(id: string): Record<string, unknown> {
  return {
    id,
    name: `Legacy ${id}`,
    version: '1.0.0',
    background: 'background.html',
    builtin: true,
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────

beforeEach(() => {
  tmpDir = makeTmpDir();
  registryDir = path.join(tmpDir, 'appdata');
  featuresDir = path.join(tmpDir, 'features');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(featuresDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Content Hashing ────────────────────────────────────────────────

describe('computeManifestHash', () => {
  it('should produce a hex string', () => {
    const hash = computeManifestHash('{"id":"test"}');
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it('should produce different hashes for different content', () => {
    const h1 = computeManifestHash('{"id":"a"}');
    const h2 = computeManifestHash('{"id":"b"}');
    assert.notStrictEqual(h1, h2);
  });

  it('should produce same hash for same content', () => {
    const h1 = computeManifestHash('{"id":"same"}');
    const h2 = computeManifestHash('{"id":"same"}');
    assert.strictEqual(h1, h2);
  });
});

// ─── Builtin Source ─────────────────────────────────────────────────

describe('scanBuiltinFeatures', () => {
  it('should register tile features from features dir', () => {
    writeManifest(path.join(featuresDir, 'alpha'), makeTileManifest('alpha'));
    writeManifest(path.join(featuresDir, 'beta'), makeTileManifest('beta'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const ids = scanBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(ids.sort(), ['alpha', 'beta']);
    assert.strictEqual(registry.size, 2);

    const alpha = registry.getFeature('alpha');
    assert.ok(alpha);
    assert.strictEqual(alpha.source.type, 'builtin');
    assert.strictEqual(alpha.userApproved, true);
    assert.ok(alpha.path.endsWith('/alpha'));
  });

  it('should skip v1 manifests', () => {
    writeManifest(path.join(featuresDir, 'legacy'), makeV1Manifest('legacy'));
    writeManifest(path.join(featuresDir, 'modern'), makeTileManifest('modern'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const ids = scanBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(ids, ['modern']);
    assert.strictEqual(registry.size, 1);
  });

  it('should skip invalid manifests', () => {
    const invalidDir = path.join(featuresDir, 'broken');
    writeManifest(invalidDir, { manifestVersion: 3 }); // missing required fields

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const ids = scanBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(ids, []);
    assert.strictEqual(registry.size, 0);
  });

  it('should skip directories without manifest.json', () => {
    fs.mkdirSync(path.join(featuresDir, 'empty-dir'), { recursive: true });

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const ids = scanBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(ids, []);
  });

  it('should handle non-existent features dir', () => {
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const ids = scanBuiltinFeatures('/nonexistent/path', registry);
    assert.deepStrictEqual(ids, []);
  });

  it('should resolve capabilities as builtin (all granted)', () => {
    writeManifest(path.join(featuresDir, 'priv'), makeTileManifest('priv', {
      capabilities: {
        pubsub: { scopes: ['self', 'global', 'system'] },
        sync: true,
        filesystem: { read: ['/tmp/*'] },
      },
    }));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();
    scanBuiltinFeatures(featuresDir, registry);

    const entry = registry.getFeature('priv');
    assert.ok(entry);
    // Builtins get system scope, sync, and filesystem
    assert.ok(entry.grantedCapabilities.pubsub);
    assert.ok(entry.grantedCapabilities.pubsub.scopes.includes('system'));
    assert.strictEqual(entry.grantedCapabilities.sync, true);
    assert.ok(entry.grantedCapabilities.filesystem);
  });
});

// ─── Local File Source ──────────────────────────────────────────────

describe('installFromLocalDirectory', () => {
  it('should install a valid feature from directory', () => {
    const sourceDir = path.join(tmpDir, 'source-feature');
    writeManifest(sourceDir, makeTileManifest('local-feat'));
    fs.writeFileSync(path.join(sourceDir, 'background.html'), '<html></html>', 'utf-8');

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(result.success, true);
    assert.ok(result.entry);
    assert.strictEqual(result.entry.id, 'local-feat');
    assert.strictEqual(result.entry.source.type, 'local');
    assert.strictEqual(result.entry.userApproved, false);
    assert.ok(result.entry.manifestCid);

    // Files should be copied to features dir
    const installedManifest = path.join(registryDir, 'features', 'local-feat', 'manifest.json');
    assert.ok(fs.existsSync(installedManifest));
    const installedHtml = path.join(registryDir, 'features', 'local-feat', 'background.html');
    assert.ok(fs.existsSync(installedHtml));
  });

  it('should reject missing manifest', () => {
    const emptyDir = path.join(tmpDir, 'no-manifest');
    fs.mkdirSync(emptyDir, { recursive: true });

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = installFromLocalDirectory(emptyDir, registry);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('No manifest.json'));
  });

  it('should reject v1 manifests', () => {
    const sourceDir = path.join(tmpDir, 'v1-source');
    writeManifest(sourceDir, makeV1Manifest('old'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('tile manifests'));
  });

  it('should reject invalid manifests', () => {
    const sourceDir = path.join(tmpDir, 'invalid-source');
    writeManifest(sourceDir, { manifestVersion: 3 }); // missing id, name, etc.

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Invalid manifest'));
  });

  it('should reject duplicate id without force', () => {
    const sourceDir = path.join(tmpDir, 'dup-source');
    writeManifest(sourceDir, makeTileManifest('dup-id'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    // First install succeeds
    const r1 = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(r1.success, true);

    // Second install fails
    const r2 = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(r2.success, false);
    assert.ok(r2.error?.includes('already installed'));
  });

  it('should allow duplicate id with force', () => {
    const sourceDir = path.join(tmpDir, 'force-source');
    writeManifest(sourceDir, makeTileManifest('force-id'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    installFromLocalDirectory(sourceDir, registry);
    const r2 = installFromLocalDirectory(sourceDir, registry, { force: true });
    assert.strictEqual(r2.success, true);
  });

  it('should report denied capabilities for non-builtin', () => {
    const sourceDir = path.join(tmpDir, 'priv-source');
    writeManifest(sourceDir, makeTileManifest('priv-local', {
      capabilities: {
        filesystem: { read: ['/tmp/*'] },
        sync: true,
      },
    }));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(result.success, true);
    assert.ok(result.pendingApproval);
    assert.ok(result.pendingApproval.includes('filesystem'));
    assert.ok(result.pendingApproval.includes('sync'));
  });

  it('should copy nested directories', () => {
    const sourceDir = path.join(tmpDir, 'nested-source');
    writeManifest(sourceDir, makeTileManifest('nested'));
    const subDir = path.join(sourceDir, 'assets', 'icons');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'icon.png'), 'fake-png', 'utf-8');

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = installFromLocalDirectory(sourceDir, registry);
    assert.strictEqual(result.success, true);

    const copiedIcon = path.join(registryDir, 'features', 'nested', 'assets', 'icons', 'icon.png');
    assert.ok(fs.existsSync(copiedIcon));
  });
});

// ─── Builtin Sync ───────────────────────────────────────────────────

describe('syncBuiltinFeatures', () => {
  it('should add new builtins to empty registry', () => {
    writeManifest(path.join(featuresDir, 'sync'), makeTileManifest('sync'));
    writeManifest(path.join(featuresDir, 'tags'), makeTileManifest('tags'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = syncBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(result.added.sort(), ['sync', 'tags']);
    assert.deepStrictEqual(result.removed, []);
    assert.deepStrictEqual(result.updated, []);
    assert.strictEqual(registry.size, 2);

    // Should have saved
    const reg2 = new FeatureRegistry(registryDir);
    reg2.loadRegistry();
    assert.strictEqual(reg2.size, 2);
  });

  it('should remove builtins no longer on disk', () => {
    writeManifest(path.join(featuresDir, 'stays'), makeTileManifest('stays'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    // Pre-populate registry with a builtin that no longer exists
    registry.registerFeature({
      id: 'gone',
      name: 'Gone Feature',
      path: path.join(featuresDir, 'gone'),
      source: { type: 'builtin' },
      grantedCapabilities: {},
      userApproved: true,
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    registry.saveRegistry();

    const result = syncBuiltinFeatures(featuresDir, registry);
    assert.ok(result.added.includes('stays'));
    assert.ok(result.removed.includes('gone'));
    assert.strictEqual(registry.getFeature('gone'), undefined);
  });

  it('should update path for moved builtins', () => {
    writeManifest(path.join(featuresDir, 'moved'), makeTileManifest('moved'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    // Pre-populate with old path
    registry.registerFeature({
      id: 'moved',
      name: 'Feature moved',
      path: '/old/path/moved',
      source: { type: 'builtin' },
      grantedCapabilities: {},
      userApproved: true,
      installedAt: '2025-01-01T00:00:00.000Z',
    });

    const result = syncBuiltinFeatures(featuresDir, registry);
    assert.ok(result.updated.includes('moved'));

    const entry = registry.getFeature('moved');
    assert.ok(entry);
    assert.ok(entry.path.includes(featuresDir));
  });

  it('should not touch non-builtin entries with same id', () => {
    writeManifest(path.join(featuresDir, 'conflict'), makeTileManifest('conflict'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    // Pre-populate as local (not builtin)
    registry.registerFeature({
      id: 'conflict',
      name: 'Local Conflict',
      path: '/local/conflict',
      source: { type: 'local' },
      grantedCapabilities: {},
      userApproved: false,
      installedAt: '2025-01-01T00:00:00.000Z',
    });

    const result = syncBuiltinFeatures(featuresDir, registry);
    // Should not be added (already exists as local) or updated (not builtin source)
    assert.ok(!result.added.includes('conflict'));
    assert.ok(!result.updated.includes('conflict'));

    // Local entry should be preserved
    const entry = registry.getFeature('conflict');
    assert.ok(entry);
    assert.strictEqual(entry.source.type, 'local');
  });

  it('should handle empty features dir', () => {
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = syncBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(result.added, []);
    assert.deepStrictEqual(result.removed, []);
    assert.deepStrictEqual(result.updated, []);
  });

  it('should skip v1 manifests during sync', () => {
    writeManifest(path.join(featuresDir, 'oldstyle'), makeV1Manifest('oldstyle'));

    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    const result = syncBuiltinFeatures(featuresDir, registry);
    assert.deepStrictEqual(result.added, []);
  });
});
