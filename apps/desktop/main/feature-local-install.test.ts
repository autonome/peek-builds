/**
 * Unit tests for installing a feature from a local folder, in place
 * (feature-installer.ts registerLocalDirectory / previewLocalDirectory) and
 * the load-time approval decision (feature-approval.ts).
 *
 * Pure Node tests — no Electron dependency. Temp directories with synthetic
 * feature folders.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeatureRegistry } from './feature-registry.js';
import {
  registerLocalDirectory,
  previewLocalDirectory,
  computeManifestHash,
} from './feature-installer.js';
import { evaluateFeatureApproval } from './feature-approval.js';
import { setFeatureEntryLookup, isBuiltinFeature, checkLaunchApproval } from './feature-trust.js';
import { resolveCapabilities, type TileManifest } from './tile-manifest.js';

let tmpDir: string;
let registryDir: string;

function makeManifest(id: string, capabilities: Record<string, unknown> = {
  pubsub: { scopes: ['self', 'global'] },
  commands: true,
}): Record<string, unknown> {
  return {
    manifestVersion: 3,
    id,
    name: `Feature ${id}`,
    version: '1.0.0',
    description: 'A synthetic feature',
    tiles: [{ id: 'background', url: 'background.html', resident: true }],
    capabilities,
    commands: [{ name: `${id} command`, action: { type: 'execute' } }],
  };
}

function writeFeatureDir(name: string, manifest: Record<string, unknown>): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'background.html'), '<html></html>', 'utf-8');
  return dir;
}

function newRegistry(): FeatureRegistry {
  const registry = new FeatureRegistry(registryDir);
  registry.loadRegistry();
  return registry;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-local-install-test-'));
  registryDir = path.join(tmpDir, 'appdata');
  fs.mkdirSync(registryDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('registerLocalDirectory', () => {
  it('registers the folder in place without copying or rewriting the manifest', () => {
    const dir = writeFeatureDir('my-feature-dir', makeManifest('local-feat'));
    const manifestPath = path.join(dir, 'manifest.json');
    const before = fs.readFileSync(manifestPath, 'utf-8');
    const mtimeBefore = fs.statSync(manifestPath).mtimeMs;
    const registry = newRegistry();

    const result = registerLocalDirectory(dir, registry, { userApproved: true });

    assert.strictEqual(result.success, true);
    const entry = registry.getFeature('local-feat');
    assert.ok(entry);
    assert.strictEqual(entry.path, dir);
    assert.strictEqual(entry.source.type, 'local');
    assert.strictEqual(entry.userApproved, true);
    assert.strictEqual(entry.manifestCid, computeManifestHash(before));
    // Nothing was copied into the registry's features dir
    assert.ok(!fs.existsSync(path.join(registry.getFeaturesDir(), 'local-feat')));
    // Manifest untouched
    assert.strictEqual(fs.readFileSync(manifestPath, 'utf-8'), before);
    assert.strictEqual(fs.statSync(manifestPath).mtimeMs, mtimeBefore);
  });

  it('refuses without approval and registers nothing', () => {
    const dir = writeFeatureDir('unapproved', makeManifest('unapproved-feat'));
    const registry = newRegistry();

    const result = registerLocalDirectory(dir, registry, { userApproved: false });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('approval'));
    assert.strictEqual(registry.getFeature('unapproved-feat'), undefined);
  });

  it('refuses an id already registered by a builtin', () => {
    const registry = newRegistry();
    registry.registerFeature({
      id: 'clash',
      name: 'Builtin clash',
      path: path.join(tmpDir, 'builtin-clash'),
      source: { type: 'builtin', version: '1.0.0' },
      grantedCapabilities: {},
      userApproved: true,
      installedAt: new Date().toISOString(),
    });
    const dir = writeFeatureDir('clash-dir', makeManifest('clash'));

    const result = registerLocalDirectory(dir, registry, { userApproved: true });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('builtin'));
    assert.strictEqual(registry.getFeature('clash')?.source.type, 'builtin');
  });

  it('re-registering an existing local entry refreshes its stored grant', () => {
    const dir = writeFeatureDir('refresh-dir', makeManifest('refresh-feat'));
    const registry = newRegistry();
    registerLocalDirectory(dir, registry, { userApproved: true });
    assert.strictEqual(registry.getFeature('refresh-feat')?.grantedCapabilities.theme, undefined);

    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(makeManifest('refresh-feat', { commands: true, theme: true })),
      'utf-8',
    );
    const result = registerLocalDirectory(dir, registry, { userApproved: true });

    assert.strictEqual(result.success, true);
    assert.ok(registry.getFeature('refresh-feat')?.grantedCapabilities.theme);
  });

  it('rejects an invalid manifest', () => {
    const dir = writeFeatureDir('bad-dir', { manifestVersion: 3 });
    const result = registerLocalDirectory(dir, newRegistry(), { userApproved: true });
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Invalid manifest'));
  });
});

describe('previewLocalDirectory', () => {
  it('reports the manifest summary, grant and existing source without registering', () => {
    const dir = writeFeatureDir('preview-dir', makeManifest('preview-feat', {
      commands: true,
      sync: true,
    }));
    const registry = newRegistry();

    const preview = previewLocalDirectory(dir, registry);

    assert.strictEqual(preview.success, true);
    assert.strictEqual(preview.manifest?.id, 'preview-feat');
    assert.strictEqual(preview.manifest?.description, 'A synthetic feature');
    assert.ok(preview.granted?.commands);
    assert.ok(preview.denied?.includes('sync'));
    assert.strictEqual(preview.alreadyInstalled, undefined);
    assert.strictEqual(registry.getFeature('preview-feat'), undefined);
  });
});

describe('evaluateFeatureApproval', () => {
  function registerWith(manifestOnRegister: Record<string, unknown>) {
    const dir = writeFeatureDir('approval-dir', manifestOnRegister);
    const registry = newRegistry();
    registerLocalDirectory(dir, registry, { userApproved: true });
    return registry.getFeature(manifestOnRegister.id as string)!;
  }

  it('skips a local entry whose manifest now expands its capabilities', () => {
    const entry = registerWith(makeManifest('grow-feat', { commands: true }));
    const edited = makeManifest('grow-feat', { commands: true, theme: true }) as unknown as TileManifest;

    const decision = evaluateFeatureApproval(entry, edited);

    assert.strictEqual(decision.allow, false);
    assert.ok(!decision.allow && decision.error.includes('needs re-approval: capabilities changed'));
  });

  it('loads a local entry whose manifest changed without expanding capabilities', () => {
    const entry = registerWith(makeManifest('same-feat', { commands: true, theme: true }));
    const edited = {
      ...makeManifest('same-feat', { commands: true }),
      version: '1.1.0',
      name: 'Renamed',
    } as unknown as TileManifest;

    assert.deepStrictEqual(evaluateFeatureApproval(entry, edited), { allow: true });
  });

  it('loads an unchanged local entry', () => {
    const manifest = makeManifest('plain-feat');
    const entry = registerWith(manifest);
    assert.deepStrictEqual(evaluateFeatureApproval(entry, manifest as unknown as TileManifest), { allow: true });
  });

  it('still skips an unapproved non-builtin entry', () => {
    const entry = registerWith(makeManifest('pending-feat'));
    const decision = evaluateFeatureApproval(
      { ...entry, userApproved: false },
      makeManifest('pending-feat') as unknown as TileManifest,
    );
    assert.strictEqual(decision.allow, false);
    assert.ok(!decision.allow && decision.error.includes('not yet approved'));
  });

  it('always allows a builtin entry', () => {
    const entry = registerWith(makeManifest('builtin-feat'));
    const decision = evaluateFeatureApproval(
      { ...entry, source: { type: 'builtin', version: '1.0.0' }, userApproved: false },
      makeManifest('builtin-feat', { theme: true }) as unknown as TileManifest,
    );
    assert.deepStrictEqual(decision, { allow: true });
  });
});

describe('feature-trust', () => {
  function lookupFor(registry: FeatureRegistry) {
    setFeatureEntryLookup((id) => registry.getFeature(id));
  }

  afterEach(() => {
    setFeatureEntryLookup(() => undefined);
  });

  it('a local entry whose manifest says builtin:true resolves as non-builtin', () => {
    const dir = writeFeatureDir('claims-builtin', {
      ...makeManifest('claims-builtin', { commands: true, sync: true }),
      builtin: true,
    });
    const registry = newRegistry();
    registerLocalDirectory(dir, registry, { userApproved: true });
    lookupFor(registry);

    assert.strictEqual(isBuiltinFeature('claims-builtin'), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    const grant = resolveCapabilities('claims-builtin', manifest.capabilities, isBuiltinFeature('claims-builtin'));
    assert.ok(grant.denied.includes('sync'));
  });

  it('a registry builtin resolves as builtin, and an unregistered id does not', () => {
    const registry = newRegistry();
    registry.registerFeature({
      id: 'shipped',
      name: 'Shipped',
      path: path.join(tmpDir, 'shipped'),
      source: { type: 'builtin', version: '1.0.0' },
      grantedCapabilities: {},
      userApproved: true,
      installedAt: new Date().toISOString(),
    });
    lookupFor(registry);

    assert.strictEqual(isBuiltinFeature('shipped'), true);
    assert.strictEqual(isBuiltinFeature('nobody'), false);
    const grant = resolveCapabilities('shipped', { commands: true, sync: true }, isBuiltinFeature('shipped'));
    assert.deepStrictEqual(grant.denied, []);
  });

  it('launch approval refuses a local entry that expanded its capabilities', () => {
    const dir = writeFeatureDir('grows-later', makeManifest('grows-later', { commands: true }));
    const registry = newRegistry();
    registerLocalDirectory(dir, registry, { userApproved: true });
    lookupFor(registry);

    const edited = makeManifest('grows-later', { commands: true, theme: true }) as unknown as TileManifest;
    const decision = checkLaunchApproval(edited);
    assert.strictEqual(decision.allow, false);
    assert.ok(!decision.allow && decision.error.includes('needs re-approval'));
    assert.deepStrictEqual(checkLaunchApproval(makeManifest('grows-later', { commands: true }) as unknown as TileManifest), { allow: true });
  });
});
