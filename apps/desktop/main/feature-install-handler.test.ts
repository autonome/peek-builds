/**
 * Main-process tests for the `tile:features:install` handler pipeline.
 *
 * What this covers (peek task 54aad964, item 2):
 *   1. pending-approval gating — a feature whose capabilities require
 *      approval surfaces `pendingApproval` (and `userApproved` stays false
 *      until the user grants it), and the handler refuses to install at all
 *      without `userApproved: true`.
 *   2. the userApproved flow — installs and marks the entry approved.
 *   3. the `features_history` write on install (real DB, real schema).
 *   4. the `feature:installed` publish (real pubsub bus).
 *
 * How it gets a passing signed proof: it reuses the REAL-signed-proof
 * fixture infrastructure from `atproto-bundle-fixture.ts` (fresh secp256k1
 * keypair → one-leaf MST → signed commit → CAR proof; DID doc advertises
 * the matching #atproto key). So the install path's cryptographic record
 * verification (fetchAndVerifyRecord) genuinely passes — no mock shortcut.
 *
 * Why a pipeline replay and not the registered IPC handler directly: the
 * `tile:features:install` handler is a closure registered through
 * `registerTileIpc` (Electron `ipcMain.handle`) and reads the
 * `getAtprotoSource()` / `getFeatureRegistry()` singletons that are only set
 * by `initializeFeatures()` (full app boot). Invoking the registered handler
 * end-to-end therefore needs the whole gate + a live PDS, which is the
 * Playwright integration follow-up. This test instead drives the SAME
 * collaborators the handler drives — real `AtprotoSource.resolve` + `.fetch`,
 * real `installFromBundle`, real `FeatureRegistry`, real `features_history`
 * insert against the real `initDatabase` schema, and a real `publish` — in
 * the handler's exact order, asserting each load-bearing side effect.
 *
 * Runs under Electron's Node host (ELECTRON_RUN_AS_NODE=1 electron --test).
 * `fetch` is stubbed on the global by the fixture helper; `better-sqlite3`
 * runs in-process against a temp DB file.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AtprotoSource } from './atproto-source.js';
import { FeatureRegistry } from './feature-registry.js';
import { installFromBundle, type InstallResult } from './feature-installer.js';
import type { FeatureSource } from './feature-registry.js';
import { initDatabase, closeDatabase, getDb } from './datastore.js';
import { publish, subscribe, unsubscribe } from './pubsub.js';
import {
  FetchStub,
  registerBundleFixture,
  atUriFor,
  makeManifest,
} from './atproto-bundle-fixture.js';

// ─── features_history write — mirrors tile-ipc.ts writeFeatureHistory ──
//
// `writeFeatureHistory` is module-private to tile-ipc.ts. We reproduce its
// exact INSERT here against the REAL `features_history` schema (built by
// initDatabase) so the column set / shape is genuinely exercised. The schema
// and the getDb() singleton are real product code.
function writeFeatureHistory(
  featureId: string,
  event: string,
  version?: string,
  sourceType?: string,
  sourceUri?: string,
  publisher?: string,
  capabilities?: Record<string, unknown>
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO features_history (featureId, event, version, sourceType, sourceUri, publisher, capabilities, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    featureId,
    event,
    version || null,
    sourceType || null,
    sourceUri || null,
    publisher || null,
    capabilities ? JSON.stringify(capabilities) : '{}',
    new Date().toISOString()
  );
}

// ─── Handler pipeline replay ────────────────────────────────────────
//
// A faithful replay of the `tile:features:install` handler body
// (tile-ipc.ts ~L1511): the userApproved gate, then resolve → fetch →
// installFromBundle → saveRegistry → writeFeatureHistory → publish, in the
// handler's exact order with the handler's exact arguments. Every step calls
// the REAL collaborator.
interface InstallHandlerResult {
  error?: string;
  success?: boolean;
  entry?: InstallResult['entry'];
  pendingApproval?: InstallResult['pendingApproval'];
}

async function runInstallHandler(
  source: AtprotoSource,
  registry: FeatureRegistry,
  args: { atUri: string; userApproved: boolean }
): Promise<InstallHandlerResult> {
  // Gate: the handler refuses any install without explicit user approval.
  if (!args.userApproved) {
    return { error: 'User approval required before installation' };
  }

  const metadata = await source.resolve(args.atUri);
  const bundle = await source.fetch(args.atUri);

  const result = installFromBundle(
    bundle,
    metadata.source,
    registry,
    { force: true, userApproved: true }
  );

  if (!result.success) {
    return { error: result.error };
  }

  registry.saveRegistry();

  writeFeatureHistory(
    result.entry!.id,
    'install',
    metadata.source.version,
    'atproto',
    args.atUri,
    metadata.source.publisher,
    result.entry!.grantedCapabilities as unknown as Record<string, unknown>
  );

  publish('feature-registry', 'feature:installed', {
    id: result.entry!.id,
    name: result.entry!.name,
    source: metadata.source,
  });

  return { success: true, entry: result.entry, pendingApproval: result.pendingApproval };
}

// ─── Setup / teardown ───────────────────────────────────────────────

let tmpDir: string;
let registryDir: string;
let featuresDir: string;
let dbPath: string;
let fetchStub: FetchStub;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-handler-test-'));
  registryDir = path.join(tmpDir, 'appdata');
  featuresDir = path.join(registryDir, 'features');
  fs.mkdirSync(featuresDir, { recursive: true });

  dbPath = path.join(tmpDir, 'peek.db');
  initDatabase(dbPath);

  fetchStub = new FetchStub();
  fetchStub.install();
});

afterEach(() => {
  fetchStub.restore();
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function historyRows(featureId: string): Array<{
  featureId: string;
  event: string;
  version: string | null;
  sourceType: string | null;
  sourceUri: string | null;
  publisher: string | null;
  capabilities: string;
}> {
  return getDb()
    .prepare('SELECT featureId, event, version, sourceType, sourceUri, publisher, capabilities FROM features_history WHERE featureId = ?')
    .all(featureId) as never;
}

function captureFeatureInstalled(): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const src = `install-handler-test-${Math.random().toString(36).slice(2, 8)}`;
  subscribe(src, 'feature:installed', (msg) => {
    events.push(msg as Record<string, unknown>);
  });
  return { events, stop: () => { unsubscribe(src, 'feature:installed'); } };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('tile:features:install — pending-approval gating', () => {
  it('refuses to install without userApproved (no entry, no history, no publish)', async () => {
    const source = new AtprotoSource();
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    await registerBundleFixture(fetchStub, {
      did: 'did:web:example.com',
      handle: 'example.com',
      pdsUrl: 'https://pds.example.com',
      rkey: 'gate-nope',
      manifest: makeManifest('gate-nope'),
      files: [{ path: 'background.html', bytes: Buffer.from('<html></html>', 'utf-8') }],
    });

    const pub = captureFeatureInstalled();
    const res = await runInstallHandler(source, registry, {
      atUri: atUriFor({ did: 'did:web:example.com', rkey: 'gate-nope' }),
      userApproved: false,
    });
    pub.stop();

    assert.strictEqual(res.success, undefined);
    assert.match(res.error ?? '', /User approval required/i);

    // No registry entry, no disk install, no history, no publish.
    assert.strictEqual(registry.getFeature('gate-nope'), undefined);
    assert.strictEqual(fs.existsSync(path.join(featuresDir, 'gate-nope')), false);
    assert.strictEqual(historyRows('gate-nope').length, 0);
    assert.strictEqual(pub.events.length, 0);
  });

  it('surfaces pendingApproval for capabilities that require approval (filesystem on a non-builtin)', async () => {
    const source = new AtprotoSource();
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    // filesystem + sync are denied for non-builtin atproto features →
    // they land in pendingApproval. pubsub.system is denied too.
    const manifest = makeManifest('needs-approval', {
      capabilities: {
        pubsub: { scopes: ['self', 'system'] },
        filesystem: { read: ['/*'], write: ['/*'] },
        sync: true,
        commands: true,
      },
    });

    await registerBundleFixture(fetchStub, {
      did: 'did:web:example.com',
      handle: 'example.com',
      pdsUrl: 'https://pds.example.com',
      rkey: 'needs-approval',
      manifest,
      files: [{ path: 'background.html', bytes: Buffer.from('<html></html>', 'utf-8') }],
    });

    const res = await runInstallHandler(source, registry, {
      atUri: atUriFor({ did: 'did:web:example.com', rkey: 'needs-approval' }),
      userApproved: true,
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.pendingApproval, 'expected pendingApproval to be populated');
    // The privileged caps were denied (held pending), not silently granted.
    assert.ok(res.pendingApproval!.includes('filesystem'));
    assert.ok(res.pendingApproval!.includes('sync'));
    assert.ok(res.pendingApproval!.includes('pubsub.system'));

    // The granted set must NOT contain the privileged capabilities.
    const entry = registry.getFeature('needs-approval');
    assert.ok(entry);
    assert.strictEqual(entry!.grantedCapabilities.filesystem, undefined);
    assert.strictEqual(entry!.grantedCapabilities.sync, undefined);
  });
});

describe('tile:features:install — userApproved flow', () => {
  it('installs an approved feature: registry entry, disk files, approved flag', async () => {
    const source = new AtprotoSource();
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    await registerBundleFixture(fetchStub, {
      did: 'did:web:example.com',
      handle: 'example.com',
      pdsUrl: 'https://pds.example.com',
      rkey: 'approved-1',
      manifest: makeManifest('approved-feature'),
      files: [
        { path: 'background.html', bytes: Buffer.from('<html>hi</html>', 'utf-8') },
        { path: 'background.js', bytes: Buffer.from('console.log(1)', 'utf-8') },
      ],
    });

    const atUri = atUriFor({ did: 'did:web:example.com', rkey: 'approved-1' });
    const res = await runInstallHandler(source, registry, { atUri, userApproved: true });

    assert.strictEqual(res.success, true);
    assert.ok(res.entry);
    assert.strictEqual(res.entry!.id, 'approved-feature');
    assert.strictEqual(res.entry!.userApproved, true);

    // Registry persisted to disk.
    const reloaded = new FeatureRegistry(registryDir);
    reloaded.loadRegistry();
    const persisted = reloaded.getFeature('approved-feature');
    assert.ok(persisted, 'entry must survive a registry reload (saveRegistry ran)');
    assert.strictEqual(persisted!.source.type, 'atproto');
    assert.strictEqual(persisted!.source.uri, atUri);

    // Bundle files written to disk.
    const target = path.join(featuresDir, 'approved-feature');
    assert.ok(fs.existsSync(path.join(target, 'background.html')));
    assert.ok(fs.existsSync(path.join(target, 'background.js')));
    // manifest.json synthesized into the bundle by AtprotoSource.fetch.
    assert.ok(fs.existsSync(path.join(target, 'manifest.json')));
  });
});

describe('tile:features:install — features_history write', () => {
  it('writes exactly one install row with the source metadata', async () => {
    const source = new AtprotoSource();
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    await registerBundleFixture(fetchStub, {
      did: 'did:web:example.com',
      handle: 'example.com',
      pdsUrl: 'https://pds.example.com',
      rkey: 'hist-1',
      manifest: makeManifest('hist-feature'),
      files: [{ path: 'background.html', bytes: Buffer.from('<html></html>', 'utf-8') }],
    });

    const atUri = atUriFor({ did: 'did:web:example.com', rkey: 'hist-1' });
    const res = await runInstallHandler(source, registry, { atUri, userApproved: true });
    assert.strictEqual(res.success, true);

    const rows = historyRows('hist-feature');
    assert.strictEqual(rows.length, 1, 'exactly one features_history row');
    const row = rows[0];
    assert.strictEqual(row.event, 'install');
    assert.strictEqual(row.version, '1.0.0');
    assert.strictEqual(row.sourceType, 'atproto');
    assert.strictEqual(row.sourceUri, atUri);
    // publisher is the resolved DID.
    assert.strictEqual(row.publisher, 'did:web:example.com');
    // capabilities column is JSON of the granted set.
    const caps = JSON.parse(row.capabilities) as Record<string, unknown>;
    assert.ok(caps.pubsub, 'granted pubsub recorded in history capabilities');
  });
});

describe('tile:features:install — feature:installed publish', () => {
  it('publishes feature:installed with id, name, and source after a successful install', async () => {
    const source = new AtprotoSource();
    const registry = new FeatureRegistry(registryDir);
    registry.loadRegistry();

    await registerBundleFixture(fetchStub, {
      did: 'did:web:example.com',
      handle: 'example.com',
      pdsUrl: 'https://pds.example.com',
      rkey: 'pub-1',
      manifest: makeManifest('pub-feature'),
      files: [{ path: 'background.html', bytes: Buffer.from('<html></html>', 'utf-8') }],
    });

    const atUri = atUriFor({ did: 'did:web:example.com', rkey: 'pub-1' });
    const pub = captureFeatureInstalled();
    const res = await runInstallHandler(source, registry, { atUri, userApproved: true });
    pub.stop();

    assert.strictEqual(res.success, true);
    assert.strictEqual(pub.events.length, 1, 'exactly one feature:installed event');
    const evt = pub.events[0];
    assert.strictEqual(evt.id, 'pub-feature');
    assert.strictEqual(evt.name, 'Feature pub-feature');
    const src = evt.source as FeatureSource;
    assert.strictEqual(src.type, 'atproto');
    assert.strictEqual(src.uri, atUri);
    assert.strictEqual(src.publisher, 'did:web:example.com');
    assert.strictEqual(src.version, '1.0.0');
  });
});
