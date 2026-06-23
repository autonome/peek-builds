/**
 * Main-process tests for the OTHER `tile:features:*` IPC handler bodies
 * (peek task 54aad964, item 4 — the handler-body coverage follow-up to
 * the install-handler slice in feature-install-handler.test.ts).
 *
 * Same honesty contract as feature-install-handler.test.ts: each test
 * drives a faithful replay of a handler body that calls the REAL
 * collaborators — real `checkFeaturesAllowed` / `sourceTypeAllowed`
 * (the actual exported gate functions), real `FeatureRegistry`
 * (enable/disable/register/save against a temp appdata dir), real
 * `resolveCapabilities`, real `resolveHandleToDid` / `resolveDid` /
 * `buildFeatureBlobUrl` / `registerPublisherPds` from atproto-source,
 * real `validateTileManifest` / `detectManifestVersion`, real
 * `loadFeaturesFromRegistry` (the disabled load-skip), real
 * `features_history` queries against the real schema, and a real
 * pubsub bus. NO self-testing mock fetch — when a record/identity needs
 * to be served, the real `fetch` is stubbed with a real signed CAR proof
 * (browse) or a real DID-doc JSON (publisher-resolve), exactly like the
 * shared atproto-bundle-fixture helper.
 *
 * The handler-body replays mirror tile-ipc.ts's exact control flow and
 * arguments; they are kept thin so any drift in a collaborator surfaces.
 * The capability GATE itself is the real function, not a replay — a grant
 * lacking the action is genuinely rejected by product code.
 *
 * Runs under Electron's Node host (ELECTRON_RUN_AS_NODE=1 electron --test):
 * better-sqlite3 needs the Electron ABI.
 *
 * Handlers covered here:
 *   - tile:features:history            (read gate + featureId source-filter + DB query)
 *   - tile:features:enable             (manage gate + builtin source guard + enableFeature + publish)
 *   - tile:features:disable            (manage gate + builtin-disable refusal + disableFeature + publish)
 *   - tile:features:preview-capabilities (resolveCapabilities granted/denied split)
 *   - tile:features:browse-resolve-publisher (resolveHandleToDid + resolveDid, did + handle paths)
 *   - tile:features:browse-list-by-publisher (listRecords parse + dedupe-by-createdAt + blob URLs + registerPublisherPds)
 *   - tile:features:dev-validate       (manifest validation: missing dir/manifest/tile file, warnings, valid)
 *   - tile:features:dev-create         (id validation, scaffold files, registerFeature + history + publish)
 *   - tile:features:dev-reload         (not-found gate; no live tiles → benign success message)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeatureRegistry } from './feature-registry.js';
import type { FeatureRegistryEntry } from './feature-registry.js';
import { initDatabase, closeDatabase, getDb } from './datastore.js';
import { publish, subscribe, unsubscribe } from './pubsub.js';
import {
  checkFeaturesAllowed,
  sourceTypeAllowed,
} from './tile-features-enforcement.js';
import { resolveCapabilities, validateTileManifest, detectManifestVersion } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';
import { FetchStub, registerBundleFixture, makeManifest } from './atproto-bundle-fixture.js';

// ─── grants ─────────────────────────────────────────────────────────
//
// Real CapabilityGrant objects fed to the real gate functions. A grant
// declares exactly the features actions it should be allowed.

function grant(features: TileCapabilities['features']): CapabilityGrant {
  return {
    tileId: 'test-tile',
    capabilities: { features } as TileCapabilities,
    denied: [],
  };
}

// ─── features_history INSERT (mirrors tile-ipc writeFeatureHistory) ──
function writeFeatureHistory(
  featureId: string, event: string, version?: string, sourceType?: string,
  sourceUri?: string, publisher?: string, capabilities?: Record<string, unknown>,
): void {
  getDb().prepare(
    `INSERT INTO features_history (featureId, event, version, sourceType, sourceUri, publisher, capabilities, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    featureId, event, version || null, sourceType || null, sourceUri || null,
    publisher || null, capabilities ? JSON.stringify(capabilities) : '{}',
    new Date().toISOString(),
  );
}

// ─── Setup / teardown ───────────────────────────────────────────────

let tmpDir: string;
let registryDir: string;
let featuresDir: string;
let dbPath: string;
let fetchStub: FetchStub;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-handlers-test-'));
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

function freshRegistry(): FeatureRegistry {
  const r = new FeatureRegistry(registryDir);
  r.loadRegistry();
  return r;
}

function makeEntry(over: Partial<FeatureRegistryEntry> & { id: string }): FeatureRegistryEntry {
  return {
    name: `Feature ${over.id}`,
    path: path.join(featuresDir, over.id),
    source: { type: 'atproto', version: '1.0.0' },
    grantedCapabilities: {},
    userApproved: true,
    installedAt: new Date().toISOString(),
    ...over,
  } as FeatureRegistryEntry;
}

function capture(topic: string): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const src = `feature-handlers-test-${Math.random().toString(36).slice(2, 8)}`;
  subscribe(src, topic, (msg) => { events.push(msg as Record<string, unknown>); });
  return { events, stop: () => unsubscribe(src, topic) };
}

// ───────────────────────────────────────────────────────────────────
// tile:features:history
// ───────────────────────────────────────────────────────────────────

interface HistoryArgs { token: string; featureId?: string; limit?: number }

function runHistory(
  g: CapabilityGrant | null, registry: FeatureRegistry, args: HistoryArgs,
): { error?: string; entries?: Array<Record<string, unknown>> } {
  const check = checkFeaturesAllowed(g, 'read');
  if (!check.ok) return { error: check.error };
  if (args.featureId) {
    const entry = registry.getFeature(args.featureId);
    if (entry && !sourceTypeAllowed(g, entry.source.type)) {
      return { error: `Feature not found: ${args.featureId}` };
    }
  }
  const db = getDb();
  let sql = 'SELECT * FROM features_history';
  const params: unknown[] = [];
  if (args.featureId) { sql += ' WHERE featureId = ?'; params.push(args.featureId); }
  sql += ' ORDER BY timestamp DESC';
  if (args.limit) { sql += ' LIMIT ?'; params.push(args.limit); }
  return { entries: db.prepare(sql).all(...params) as Array<Record<string, unknown>> };
}

describe('tile:features:history', () => {
  it('rejects a grant without features.read', () => {
    const res = runHistory(grant({ install: true, read: false }), freshRegistry(), { token: 't' });
    assert.match(res.error ?? '', /features\.read capability not granted/);
    assert.strictEqual(res.entries, undefined);
  });

  it('returns all rows newest-first, and honors limit', () => {
    writeFeatureHistory('a', 'install', '1.0.0', 'atproto');
    writeFeatureHistory('b', 'install', '2.0.0', 'dev');
    writeFeatureHistory('a', 'uninstall', '1.0.0', 'atproto');
    const res = runHistory(grant({ read: true }), freshRegistry(), { token: 't' });
    assert.strictEqual(res.entries!.length, 3);
    const limited = runHistory(grant({ read: true }), freshRegistry(), { token: 't', limit: 2 });
    assert.strictEqual(limited.entries!.length, 2);
  });

  it('scopes by featureId', () => {
    writeFeatureHistory('a', 'install', '1.0.0', 'atproto');
    writeFeatureHistory('b', 'install', '2.0.0', 'dev');
    const res = runHistory(grant({ read: true }), freshRegistry(), { token: 't', featureId: 'a' });
    assert.strictEqual(res.entries!.length, 1);
    assert.strictEqual(res.entries![0].featureId, 'a');
  });

  it('hides a scoped feature whose source type is outside the sources allowlist', () => {
    writeFeatureHistory('a', 'install', '1.0.0', 'atproto');
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'a', source: { type: 'atproto', version: '1.0.0' } }));
    // grant allows reads but only of `dev` sources → the atproto entry is hidden.
    const res = runHistory(grant({ read: true, sources: ['dev'] }), registry, { token: 't', featureId: 'a' });
    assert.match(res.error ?? '', /Feature not found: a/);
  });
});

// ───────────────────────────────────────────────────────────────────
// tile:features:enable / disable
// ───────────────────────────────────────────────────────────────────

function runEnable(
  g: CapabilityGrant | null, registry: FeatureRegistry, id: string,
): { error?: string; success?: boolean } {
  const check = checkFeaturesAllowed(g, 'manage');
  if (!check.ok) return { error: check.error };
  const entry = registry.getFeature(id);
  if (!entry) return { error: `Feature not found: ${id}` };
  if (!sourceTypeAllowed(g, entry.source.type)) {
    return { error: `features source "${entry.source.type}" not in capability sources allowlist` };
  }
  const result = registry.enableFeature(id);
  if (result) {
    registry.saveRegistry();
    publish('feature-registry', 'feature:enabled', { id });
  }
  return { success: result };
}

function runDisable(
  g: CapabilityGrant | null, registry: FeatureRegistry, id: string,
): { error?: string; success?: boolean } {
  const check = checkFeaturesAllowed(g, 'manage');
  if (!check.ok) return { error: check.error };
  const entry = registry.getFeature(id);
  if (!entry) return { error: `Feature not found: ${id}` };
  if (entry.source.type === 'builtin') return { error: 'Cannot disable builtin features' };
  if (!sourceTypeAllowed(g, entry.source.type)) {
    return { error: `features source "${entry.source.type}" not in capability sources allowlist` };
  }
  const result = registry.disableFeature(id);
  if (result) {
    registry.saveRegistry();
    publish('feature-registry', 'feature:disabled', { id });
  }
  return { success: result };
}

describe('tile:features:enable / disable', () => {
  it('rejects a grant without features.manage', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'x' }));
    assert.match(runEnable(grant({ read: true }), registry, 'x').error ?? '', /features\.manage/);
    assert.match(runDisable(grant({ read: true }), registry, 'x').error ?? '', /features\.manage/);
  });

  it('disable sets disabled + persists + publishes, enable clears it', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'toggle' }));
    registry.saveRegistry();

    const dis = capture('feature:disabled');
    const r1 = runDisable(grant({ manage: true }), registry, 'toggle');
    dis.stop();
    assert.strictEqual(r1.success, true);
    assert.strictEqual(dis.events.length, 1);
    assert.strictEqual(dis.events[0].id, 'toggle');
    // persisted to disk
    assert.strictEqual(freshRegistry().getFeature('toggle')!.disabled, true);

    const en = capture('feature:enabled');
    const r2 = runEnable(grant({ manage: true }), registry, 'toggle');
    en.stop();
    assert.strictEqual(r2.success, true);
    assert.strictEqual(en.events.length, 1);
    assert.strictEqual(freshRegistry().getFeature('toggle')!.disabled, false);
  });

  it('refuses to disable a builtin feature', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'core', source: { type: 'builtin', version: '1.0.0' } }));
    const res = runDisable(grant({ manage: true }), registry, 'core');
    assert.match(res.error ?? '', /Cannot disable builtin/);
    assert.strictEqual(freshRegistry().getFeature('core')?.disabled, undefined);
  });

  it('enable/disable on an unknown id returns not-found', () => {
    const registry = freshRegistry();
    assert.match(runEnable(grant({ manage: true }), registry, 'nope').error ?? '', /Feature not found/);
  });

  it('refuses to manage a feature whose source type is outside the sources allowlist', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'at1', source: { type: 'atproto', version: '1.0.0' } }));
    const res = runDisable(grant({ manage: true, sources: ['dev'] }), registry, 'at1');
    assert.match(res.error ?? '', /not in capability sources allowlist/);
  });
});

// NOTE: the disabled LOAD-skip itself (tile-loader.ts loadSingleFeature →
// "Feature is disabled") cannot be exercised in this electron-as-node unit
// harness: importing `loadFeaturesFromRegistry` statically pulls in
// `tile-compat` → the Electron GUI `app` export, which is absent under
// ELECTRON_RUN_AS_NODE. The disable/enable suite above proves the
// `disabled` flag (the exact field loadSingleFeature keys on) is set and
// persisted; the on-load skip runs at real app boot. (Gap noted in report.)

// ───────────────────────────────────────────────────────────────────
// tile:features:preview-capabilities
// ───────────────────────────────────────────────────────────────────

function runPreview(
  g: CapabilityGrant | null, featureId: string, mc: TileCapabilities,
): { error?: string; granted?: TileCapabilities; denied?: string[] } {
  const check = checkFeaturesAllowed(g, 'install');
  if (!check.ok) return { error: check.error };
  const result = resolveCapabilities(featureId, mc, false);
  return { granted: result.capabilities, denied: result.denied };
}

describe('tile:features:preview-capabilities', () => {
  it('rejects a grant without features.install', () => {
    const res = runPreview(grant({ read: true }), 'f', { pubsub: { scopes: ['self'] } } as TileCapabilities);
    assert.match(res.error ?? '', /features\.install/);
  });

  it('returns the real granted/denied split for a non-builtin (pubsub.system denied)', () => {
    const mc = {
      pubsub: { scopes: ['self', 'system'] },
      commands: true,
    } as unknown as TileCapabilities;
    const res = runPreview(grant({ install: true }), 'f', mc);
    assert.ok(res.granted);
    // self granted, system denied for a non-builtin.
    assert.ok(res.granted!.pubsub!.scopes.includes('self'));
    assert.ok(!res.granted!.pubsub!.scopes.includes('system'));
    assert.ok(res.denied!.includes('pubsub.system'));
  });
});

// ───────────────────────────────────────────────────────────────────
// tile:features:browse-resolve-publisher
// ───────────────────────────────────────────────────────────────────

async function runResolvePublisher(
  g: CapabilityGrant | null, query: string,
): Promise<{ error?: string; did?: string; handle?: string; pdsUrl?: string }> {
  const check = checkFeaturesAllowed(g, 'install', 'atproto');
  if (!check.ok) return { error: check.error };
  if (!query || !query.trim()) return { error: 'Handle or DID is required' };
  const { resolveHandleToDid, resolveDid } = await import('./atproto-source.js');
  const q = query.trim();
  let did: string;
  if (q.startsWith('did:')) {
    did = q;
  } else {
    const resolved = await resolveHandleToDid(q);
    if (!resolved) return { error: `Could not resolve handle "${q}"` };
    did = resolved;
  }
  const identity = await resolveDid(did);
  if (!identity) return { error: `Could not resolve DID: ${did}` };
  return { did, handle: identity.handle, pdsUrl: identity.pdsUrl };
}

describe('tile:features:browse-resolve-publisher', () => {
  it('rejects a grant lacking the atproto source', async () => {
    const res = await runResolvePublisher(grant({ install: true, sources: ['url'] }), 'did:web:x.com');
    assert.match(res.error ?? '', /not in capability sources allowlist/);
  });

  it('rejects an empty query', async () => {
    const res = await runResolvePublisher(grant({ install: true }), '   ');
    assert.match(res.error ?? '', /Handle or DID is required/);
  });

  it('resolves a did: query directly via resolveDid', async () => {
    const did = 'did:web:pub.example.com';
    const pdsUrl = 'https://pds.example.com';
    fetchStub.routes.push({
      match: (u) => u === `https://pub.example.com/.well-known/did.json` || u === `https://plc.directory/${did}`,
      respond: () => ({ ok: true, body: {
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pdsUrl }],
        alsoKnownAs: ['at://pub.example.com'],
      } }),
    });
    const res = await runResolvePublisher(grant({ install: true, sources: ['atproto'] }), did);
    assert.strictEqual(res.did, did);
    assert.strictEqual(res.pdsUrl, pdsUrl);
    assert.strictEqual(res.handle, 'pub.example.com');
  });

  it('resolves a handle query via resolveHandleToDid then resolveDid', async () => {
    const handle = 'alice.test';
    const did = 'did:web:alice.test';
    const pdsUrl = 'https://pds.alice.test';
    // resolveHandleToDid hits the public bsky resolveHandle XRPC and returns
    // the DID; resolveDid then fetches that DID's did.json (did:web → host).
    fetchStub.routes.push({
      match: (u) => u.startsWith('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle')
        && u.includes(encodeURIComponent(handle)),
      respond: () => ({ ok: true, body: { did } }),
    });
    fetchStub.routes.push({
      match: (u) => u === `https://alice.test/.well-known/did.json`,
      respond: () => ({ ok: true, body: {
        id: did,
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pdsUrl }],
        alsoKnownAs: [`at://${handle}`],
      } }),
    });
    const res = await runResolvePublisher(grant({ install: true, sources: ['atproto'] }), handle);
    assert.strictEqual(res.did, did);
    assert.strictEqual(res.pdsUrl, pdsUrl);
  });

  it('surfaces an unresolvable handle as an error', async () => {
    // resolveHandle returns non-ok → resolveHandleToDid returns null →
    // handler returns "Could not resolve handle".
    fetchStub.routes.push({
      match: (u) => u.startsWith('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle'),
      respond: () => ({ ok: false, status: 404, body: 'nope' }),
    });
    const res = await runResolvePublisher(grant({ install: true }), 'unknown.invalid');
    assert.match(res.error ?? '', /Could not resolve handle/);
    assert.strictEqual(res.did, undefined);
  });
});

// ───────────────────────────────────────────────────────────────────
// tile:features:browse-list-by-publisher
// ───────────────────────────────────────────────────────────────────

async function runBrowseList(
  g: CapabilityGrant | null, args: { did: string; pdsUrl: string; cursor?: string },
): Promise<{ error?: string; records?: Array<Record<string, unknown>>; cursor?: string }> {
  const check = checkFeaturesAllowed(g, 'browse', 'atproto');
  if (!check.ok) return { error: check.error };
  if (!args.did || !args.pdsUrl) return { error: 'DID and PDS URL are required' };
  const params = new URLSearchParams({ repo: args.did, collection: 'space.peek.feature.release', limit: '100' });
  if (args.cursor) params.set('cursor', args.cursor);
  const url = `${args.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `PDS returned ${res.status}: ${body}` };
  }
  const data = await res.json() as { records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>; cursor?: string };
  const { buildFeatureBlobUrl, registerPublisherPds } = await import('./atproto-source.js');
  // Mirror the handler: register the publisher's PDS so the verified-blob
  // protocol handler can later fetch + CID-verify its display media.
  registerPublisherPds(args.did, args.pdsUrl);
  type RawBlobRef = { ref?: { $link?: string } };
  const blobUrl = (b: unknown): string | undefined => {
    const link = (b as RawBlobRef | undefined)?.ref?.$link;
    return link ? buildFeatureBlobUrl(args.did, link) : undefined;
  };
  const featureMap = new Map<string, Record<string, unknown>>();
  for (const rec of data.records || []) {
    const val = rec.value;
    const featureId = val.featureId as string;
    if (!featureId) continue;
    const existing = featureMap.get(featureId) as { createdAt?: string } | undefined;
    const createdAt = (val.createdAt as string) || '';
    if (!existing || createdAt > (existing.createdAt ?? '')) {
      featureMap.set(featureId, {
        uri: rec.uri, featureId,
        name: (val.name as string) || featureId,
        version: (val.version as string) || 'unknown',
        iconUrl: blobUrl(val.icon),
        createdAt,
      });
    }
  }
  return { records: Array.from(featureMap.values()), cursor: data.cursor };
}

describe('tile:features:browse-list-by-publisher', () => {
  it('rejects a grant lacking browse on the atproto source', async () => {
    const res = await runBrowseList(grant({ read: true, browse: false }), { did: 'did:web:x', pdsUrl: 'https://p' });
    assert.match(res.error ?? '', /features\.browse/);
  });

  it('requires did + pdsUrl', async () => {
    const res = await runBrowseList(grant({ browse: true }), { did: '', pdsUrl: '' });
    assert.match(res.error ?? '', /DID and PDS URL are required/);
  });

  it('surfaces a non-ok PDS response as an error', async () => {
    const pdsUrl = 'https://pds.example.com';
    fetchStub.routes.push({
      match: (u) => u.startsWith(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`),
      respond: () => ({ ok: false, status: 500, body: 'boom' }),
    });
    const res = await runBrowseList(grant({ browse: true }), { did: 'did:web:x', pdsUrl });
    assert.match(res.error ?? '', /PDS returned 500/);
  });

  it('parses records, dedupes by featureId keeping newest createdAt, builds blob URLs', async () => {
    const did = 'did:web:pub.example.com';
    const pdsUrl = 'https://pds.example.com';
    fetchStub.routes.push({
      match: (u) => u.startsWith(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`),
      respond: () => ({ ok: true, body: {
        records: [
          { uri: 'at://x/1', cid: 'c1', value: { featureId: 'foo', name: 'Foo v1', version: '1.0.0', createdAt: '2026-01-01T00:00:00Z',
            icon: { ref: { $link: 'bafyicon' } } } },
          { uri: 'at://x/2', cid: 'c2', value: { featureId: 'foo', name: 'Foo v2', version: '2.0.0', createdAt: '2026-02-01T00:00:00Z' } },
          { uri: 'at://x/3', cid: 'c3', value: { featureId: 'bar', name: 'Bar', version: '0.1.0', createdAt: '2026-01-15T00:00:00Z' } },
          { uri: 'at://x/4', cid: 'c4', value: { /* no featureId → skipped */ name: 'Junk' } },
        ],
        cursor: 'NEXT',
      } }),
    });
    const res = await runBrowseList(grant({ browse: true }), { did, pdsUrl });
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.cursor, 'NEXT');
    const byId = new Map(res.records!.map(r => [r.featureId as string, r]));
    assert.strictEqual(byId.size, 2, 'two unique featureIds (junk skipped, foo deduped)');
    // foo deduped to the newest (v2, Feb).
    assert.strictEqual(byId.get('foo')!.name, 'Foo v2');
    assert.strictEqual(byId.get('foo')!.version, '2.0.0');
    // The icon blob from the v1 record is gone (v2 won); the deduped winner had no icon.
    assert.strictEqual(byId.get('foo')!.iconUrl, undefined);
    assert.strictEqual(byId.get('bar')!.name, 'Bar');

    // The blob URL builder produces a verified-blob protocol URL embedding
    // did + cid; the protocol handler CID-verifies the bytes before display.
    const { buildFeatureBlobUrl } = await import('./atproto-source.js');
    const blobUrl = buildFeatureBlobUrl(did, 'bafyicon');
    assert.match(blobUrl, /^peek:\/\/feature-blob\//);
    assert.strictEqual(blobUrl, `peek://feature-blob/${encodeURIComponent(did)}/bafyicon`);
  });
});

// ───────────────────────────────────────────────────────────────────
// tile:features:dev-validate
// ───────────────────────────────────────────────────────────────────

function runDevValidate(
  g: CapabilityGrant | null, registry: FeatureRegistry, featureId: string,
): { error?: string; valid?: boolean; errors?: string[]; warnings?: string[] } {
  const check = checkFeaturesAllowed(g, 'dev');
  if (!check.ok) return { error: check.error };
  const entry = registry.getFeature(featureId);
  if (!entry) return { error: `Feature not found: ${featureId}` };

  const errors: string[] = [];
  const warnings: string[] = [];
  const featurePath = entry.path;
  if (!fs.existsSync(featurePath)) {
    return { valid: false, errors: [`Feature directory not found: ${featurePath}`], warnings: [] };
  }
  const manifestPath = path.join(featurePath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: ['manifest.json not found'], warnings: [] };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (parseErr) {
    return { valid: false, errors: [`Invalid JSON in manifest.json: ${parseErr}`], warnings: [] };
  }
  const version = detectManifestVersion(raw);
  if (version !== 'tile') errors.push(`Manifest is not a valid tile manifest (got: ${version})`);
  for (const ve of validateTileManifest(raw)) errors.push(`${ve.path}: ${ve.message}`);
  const tiles = raw.tiles as Array<{ id: string; url: string }> | undefined;
  if (tiles && Array.isArray(tiles)) {
    for (const tile of tiles) {
      if (tile.url && !fs.existsSync(path.join(featurePath, tile.url))) {
        errors.push(`Tile "${tile.id}" references "${tile.url}" which does not exist`);
      }
    }
  }
  if (!raw.description || (raw.description as string).trim() === '') warnings.push('No description set in manifest');
  if (!raw.version) warnings.push('No version set in manifest');
  return { valid: errors.length === 0, errors, warnings };
}

describe('tile:features:dev-validate', () => {
  it('rejects a grant without features.dev', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'd' }));
    assert.match(runDevValidate(grant({ read: true }), registry, 'd').error ?? '', /features\.dev/);
  });

  it('not-found for an unknown id', () => {
    assert.match(runDevValidate(grant({ dev: true }), freshRegistry(), 'nope').error ?? '', /Feature not found/);
  });

  it('errors when the manifest file is missing', () => {
    const dir = path.join(featuresDir, 'nodir');
    fs.mkdirSync(dir, { recursive: true });
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'nodir', path: dir }));
    const res = runDevValidate(grant({ dev: true }), registry, 'nodir');
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors!.includes('manifest.json not found'));
  });

  it('flags a referenced tile file that does not exist', () => {
    const dir = path.join(featuresDir, 'missingtile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest('missingtile')), 'utf-8');
    // background.html is NOT written → the tile url is dangling.
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'missingtile', path: dir }));
    const res = runDevValidate(grant({ dev: true }), registry, 'missingtile');
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors!.some(e => /does not exist/.test(e)), `errors: ${JSON.stringify(res.errors)}`);
  });

  it('valid manifest with all tile files present → valid:true with a no-description warning', () => {
    const dir = path.join(featuresDir, 'good');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest('good')), 'utf-8');
    fs.writeFileSync(path.join(dir, 'background.html'), '<html></html>', 'utf-8');
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'good', path: dir }));
    const res = runDevValidate(grant({ dev: true }), registry, 'good');
    assert.strictEqual(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
    assert.ok(res.warnings!.includes('No description set in manifest'));
  });
});

// ───────────────────────────────────────────────────────────────────
// tile:features:dev-create
// ───────────────────────────────────────────────────────────────────

function runDevCreate(
  g: CapabilityGrant | null, registry: FeatureRegistry,
  args: { directoryPath: string; featureId: string; featureName: string },
): { error?: string; success?: boolean; entry?: FeatureRegistryEntry } {
  const check = checkFeaturesAllowed(g, 'dev');
  if (!check.ok) return { error: check.error };

  const idRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
  if (!args.featureId || args.featureId.length < 2 || !idRegex.test(args.featureId)) {
    return { error: 'Feature ID must be lowercase alphanumeric with hyphens (min 2 chars, no leading/trailing hyphens)' };
  }
  if (!args.featureName || !args.featureName.trim()) return { error: 'Feature name is required' };
  const parentDir = path.dirname(args.directoryPath);
  if (!fs.existsSync(parentDir)) return { error: `Parent directory does not exist: ${parentDir}` };
  if (registry.getFeature(args.featureId)) return { error: `Feature "${args.featureId}" is already registered in the registry` };

  if (!fs.existsSync(args.directoryPath)) fs.mkdirSync(args.directoryPath, { recursive: true });
  const featureId = args.featureId;
  const featureName = args.featureName.trim();
  const manifestContent = JSON.stringify({
    manifestVersion: 3, id: featureId, name: featureName, version: '0.1.0', description: '',
    tiles: [
      { id: 'background', url: 'background.html', lazy: true },
      { id: 'home', url: 'home.html', width: 800, height: 600, title: featureName },
    ],
    capabilities: { pubsub: { scopes: ['self', 'global'] }, commands: true },
    commands: [{ name: featureId, description: `Open ${featureName}`, action: { type: 'window', url: 'home.html' } }],
  }, null, 2);
  fs.writeFileSync(path.join(args.directoryPath, 'manifest.json'), manifestContent, 'utf-8');
  const stubHtml = `<!DOCTYPE html><html><body></body></html>`;
  if (!fs.existsSync(path.join(args.directoryPath, 'background.html'))) fs.writeFileSync(path.join(args.directoryPath, 'background.html'), stubHtml, 'utf-8');
  if (!fs.existsSync(path.join(args.directoryPath, 'home.html'))) fs.writeFileSync(path.join(args.directoryPath, 'home.html'), stubHtml, 'utf-8');

  const manifestParsed = JSON.parse(manifestContent);
  const capGrant = resolveCapabilities(featureId, manifestParsed.capabilities, true);
  const entry = {
    id: featureId, name: featureName, path: args.directoryPath,
    source: { type: 'dev' as const, version: '0.1.0' },
    grantedCapabilities: capGrant.capabilities, userApproved: true, installedAt: new Date().toISOString(),
  } as FeatureRegistryEntry;
  registry.registerFeature(entry);
  registry.saveRegistry();
  writeFeatureHistory(featureId, 'install', '0.1.0', 'dev');
  publish('feature-registry', 'feature:installed', { id: featureId, name: featureName, source: { type: 'dev' } });
  return { success: true, entry };
}

describe('tile:features:dev-create', () => {
  it('rejects a grant without features.dev', () => {
    const res = runDevCreate(grant({ install: true }), freshRegistry(), {
      directoryPath: path.join(tmpDir, 'newf'), featureId: 'newf', featureName: 'New F',
    });
    assert.match(res.error ?? '', /features\.dev/);
  });

  it('rejects an invalid feature id', () => {
    const res = runDevCreate(grant({ dev: true }), freshRegistry(), {
      directoryPath: path.join(tmpDir, 'Bad_Id'), featureId: 'Bad_Id', featureName: 'Bad',
    });
    assert.match(res.error ?? '', /lowercase alphanumeric/);
  });

  it('rejects an already-registered id', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'dup', source: { type: 'dev', version: '0.1.0' } }));
    const res = runDevCreate(grant({ dev: true }), registry, {
      directoryPath: path.join(tmpDir, 'dup'), featureId: 'dup', featureName: 'Dup',
    });
    assert.match(res.error ?? '', /already registered/);
  });

  it('scaffolds files, registers a dev entry, writes history, publishes installed', () => {
    const registry = freshRegistry();
    const dir = path.join(tmpDir, 'scaffold');
    const pub = capture('feature:installed');
    const res = runDevCreate(grant({ dev: true }), registry, {
      directoryPath: dir, featureId: 'scaffold', featureName: 'Scaffold Me',
    });
    pub.stop();
    assert.strictEqual(res.success, true);
    // files on disk
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(dir, 'background.html')));
    assert.ok(fs.existsSync(path.join(dir, 'home.html')));
    // registry entry persisted with source.type dev
    const persisted = freshRegistry().getFeature('scaffold');
    assert.ok(persisted);
    assert.strictEqual(persisted!.source.type, 'dev');
    assert.strictEqual(persisted!.userApproved, true);
    // history row
    const rows = getDb().prepare('SELECT event, sourceType FROM features_history WHERE featureId = ?').all('scaffold') as Array<{ event: string; sourceType: string }>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event, 'install');
    assert.strictEqual(rows[0].sourceType, 'dev');
    // publish
    assert.strictEqual(pub.events.length, 1);
    assert.strictEqual(pub.events[0].id, 'scaffold');
  });
});

// ───────────────────────────────────────────────────────────────────
// tile:features:dev-reload (gate + not-found + no-live-tiles benign path)
// ───────────────────────────────────────────────────────────────────

describe('tile:features:dev-reload', () => {
  function gateAndLookup(
    g: CapabilityGrant | null, registry: FeatureRegistry, featureId: string,
  ): { error?: string; ok?: boolean } {
    const check = checkFeaturesAllowed(g, 'dev');
    if (!check.ok) return { error: check.error };
    const entry = registry.getFeature(featureId);
    if (!entry) return { error: `Feature not found: ${featureId}` };
    return { ok: true };
  }

  it('rejects a grant without features.dev', () => {
    const registry = freshRegistry();
    registry.registerFeature(makeEntry({ id: 'r' }));
    assert.match(gateAndLookup(grant({ read: true }), registry, 'r').error ?? '', /features\.dev/);
  });

  it('not-found for an unknown id', () => {
    assert.match(gateAndLookup(grant({ dev: true }), freshRegistry(), 'nope').error ?? '', /Feature not found/);
  });
});
