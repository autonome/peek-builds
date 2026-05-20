/**
 * Unit tests for Feature Registry
 *
 * Pure Node tests — no Electron dependency.
 * Uses temp directories for registry persistence.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeatureRegistry, type FeatureRegistryEntry } from './feature-registry.js';

// ─── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feature-registry-test-'));
}

function makeEntry(id: string, overrides: Partial<FeatureRegistryEntry> = {}): FeatureRegistryEntry {
  return {
    id,
    name: overrides.name ?? `Feature ${id}`,
    path: overrides.path ?? `/fake/path/${id}`,
    source: overrides.source ?? { type: 'builtin' },
    grantedCapabilities: overrides.grantedCapabilities ?? {},
    userApproved: overrides.userApproved ?? true,
    installedAt: overrides.installedAt ?? new Date().toISOString(),
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────────

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Load / Save ────────────────────────────────────────────────────

describe('FeatureRegistry load/save', () => {
  it('should load empty registry when file does not exist', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    assert.strictEqual(reg.size, 0);
    assert.deepStrictEqual(reg.listFeatures(), []);
  });

  it('should save and load registry', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    reg.registerFeature(makeEntry('test-feature'));
    reg.saveRegistry();

    // Load in a new instance
    const reg2 = new FeatureRegistry(tmpDir);
    reg2.loadRegistry();
    assert.strictEqual(reg2.size, 1);
    const entry = reg2.getFeature('test-feature');
    assert.ok(entry);
    assert.strictEqual(entry.name, 'Feature test-feature');
  });

  it('should create parent directories when saving', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'dir');
    const reg = new FeatureRegistry(nested);
    reg.loadRegistry();
    reg.registerFeature(makeEntry('deep-feature'));
    reg.saveRegistry();

    assert.ok(fs.existsSync(path.join(nested, 'registry.json')));
  });

  it('should handle corrupt registry file gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'registry.json'), 'not valid json', 'utf-8');
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    assert.strictEqual(reg.size, 0);
  });

  it('should handle unknown registry version gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'registry.json'),
      JSON.stringify({ version: 99, features: {} }),
      'utf-8'
    );
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    assert.strictEqual(reg.size, 0);
  });

  it('should track dirty state', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    assert.strictEqual(reg.isDirty(), false);

    reg.registerFeature(makeEntry('dirty-test'));
    assert.strictEqual(reg.isDirty(), true);

    reg.saveRegistry();
    assert.strictEqual(reg.isDirty(), false);
  });
});

// ─── CRUD ───────────────────────────────────────────────────────────

describe('FeatureRegistry CRUD', () => {
  it('should register and retrieve a feature', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    const entry = makeEntry('my-feature', { name: 'My Feature' });
    reg.registerFeature(entry);

    const got = reg.getFeature('my-feature');
    assert.ok(got);
    assert.strictEqual(got.name, 'My Feature');
    assert.strictEqual(got.id, 'my-feature');
  });

  it('should return undefined for unknown feature', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    assert.strictEqual(reg.getFeature('nonexistent'), undefined);
  });

  it('should update existing feature and preserve installedAt', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    const original = makeEntry('updatable', {
      name: 'Original',
      installedAt: '2025-01-01T00:00:00.000Z',
    });
    reg.registerFeature(original);

    const updated = makeEntry('updatable', {
      name: 'Updated',
      installedAt: '2026-06-06T00:00:00.000Z', // should be ignored
    });
    reg.registerFeature(updated);

    const got = reg.getFeature('updatable');
    assert.ok(got);
    assert.strictEqual(got.name, 'Updated');
    assert.strictEqual(got.installedAt, '2025-01-01T00:00:00.000Z');
    assert.ok(got.updatedAt); // should be set
  });

  it('should unregister a feature', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    reg.registerFeature(makeEntry('removable'));
    assert.strictEqual(reg.size, 1);

    const removed = reg.unregisterFeature('removable');
    assert.strictEqual(removed, true);
    assert.strictEqual(reg.size, 0);
    assert.strictEqual(reg.getFeature('removable'), undefined);
  });

  it('should return false when unregistering unknown feature', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();
    assert.strictEqual(reg.unregisterFeature('ghost'), false);
  });

  it('should list all features', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    reg.registerFeature(makeEntry('a'));
    reg.registerFeature(makeEntry('b'));
    reg.registerFeature(makeEntry('c'));

    const all = reg.listFeatures();
    assert.strictEqual(all.length, 3);
    const ids = all.map(e => e.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b', 'c']);
  });
});

// ─── Filtering ──────────────────────────────────────────────────────

describe('FeatureRegistry filtering', () => {
  it('should filter by source type', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    reg.registerFeature(makeEntry('builtin-1', { source: { type: 'builtin' } }));
    reg.registerFeature(makeEntry('builtin-2', { source: { type: 'builtin' } }));
    reg.registerFeature(makeEntry('local-1', { source: { type: 'local' } }));
    reg.registerFeature(makeEntry('atproto-1', { source: { type: 'atproto', publisher: 'did:plc:abc' } }));

    const builtins = reg.listFeatures({ sourceType: 'builtin' });
    assert.strictEqual(builtins.length, 2);

    const locals = reg.listFeatures({ sourceType: 'local' });
    assert.strictEqual(locals.length, 1);
    assert.strictEqual(locals[0].id, 'local-1');

    const atproto = reg.listFeatures({ sourceType: 'atproto' });
    assert.strictEqual(atproto.length, 1);

    const urls = reg.listFeatures({ sourceType: 'url' });
    assert.strictEqual(urls.length, 0);
  });

  it('should return all when no filter', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    reg.registerFeature(makeEntry('a', { source: { type: 'builtin' } }));
    reg.registerFeature(makeEntry('b', { source: { type: 'local' } }));

    assert.strictEqual(reg.listFeatures().length, 2);
    assert.strictEqual(reg.listFeatures({}).length, 2);
  });
});

// ─── Path Helpers ───────────────────────────────────────────────────

describe('FeatureRegistry paths', () => {
  it('should return correct registry path', () => {
    const reg = new FeatureRegistry('/app/data');
    assert.strictEqual(reg.getRegistryPath(), '/app/data/registry.json');
  });

  it('should return correct features dir', () => {
    const reg = new FeatureRegistry('/app/data');
    assert.strictEqual(reg.getFeaturesDir(), '/app/data/features');
  });
});

// ─── Duplicate ID Handling ──────────────────────────────────────────

describe('FeatureRegistry duplicate IDs', () => {
  it('should replace entry with same id', () => {
    const reg = new FeatureRegistry(tmpDir);
    reg.loadRegistry();

    reg.registerFeature(makeEntry('dup', { name: 'First', path: '/first' }));
    reg.registerFeature(makeEntry('dup', { name: 'Second', path: '/second' }));

    assert.strictEqual(reg.size, 1);
    const got = reg.getFeature('dup');
    assert.ok(got);
    assert.strictEqual(got.name, 'Second');
    assert.strictEqual(got.path, '/second');
  });
});
