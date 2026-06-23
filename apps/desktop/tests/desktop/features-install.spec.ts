/**
 * Integration spec for the REGISTERED `tile:features:install` IPC handler
 * (peek task 54aad964, item 2 — the Playwright follow-up to the
 * main-process unit slice in main/feature-install-handler.test.ts).
 *
 * What this covers that the unit test could NOT:
 *   - the REAL registered handler closure in tile-ipc.ts (not a replay),
 *     reached through `window.app.features.install(atUri, userApproved)`
 *     on the trustedBuiltin test-fixture renderer;
 *   - token validation + the `features` capability gate as wired at boot
 *     (the test renderer carries a trustedBuiltin grant, so the gate is
 *     exercised on the real grant path);
 *   - the `getAtprotoSource()` / `getFeatureRegistry()` singletons that are
 *     only populated by `initializeFeatures()` during a full app boot;
 *   - real `installFromBundle` writing into the booted profile's features
 *     dir, real `saveRegistry`, real `features_history` INSERT, and the
 *     real `feature:installed` publish — all inside one running process.
 *
 * How a passing signed proof reaches the booted main process WITHOUT a
 * live PDS: the proof is built Node-side (in beforeAll) with the SAME
 * real-signed-proof machinery the unit tests use (fresh secp256k1 keypair
 * → one-leaf MST → signed commit → CARv1; DID doc advertises the matching
 * #atproto key). We then install a `globalThis.fetch` stub INSIDE the
 * Electron main process via `evaluateMain`, fed the proof + DID doc +
 * blobs as a serializable route table (CAR/blob bytes base64-encoded).
 * Overriding `globalThis.fetch` in main covers every fetch the install
 * path makes — atproto-source's bare-global DID-doc / getBlob calls AND
 * atproto-verify's default fetchImpl (which falls through to global
 * fetch) for the CAR proof. So the install path's cryptographic record
 * verification genuinely runs and passes — no mock shortcut.
 *
 * NOTE: this spec lives in the `desktop` (parallel) project; it boots its
 * own isolated profile via createPerDescribeApp, so the on-disk install +
 * DB writes are fully self-contained.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  buildSignedProof,
  COLLECTION,
} from '../../main/atproto-bundle-fixture';
import { computeCidV1Sha256Raw } from '../../main/atproto-source';
import { TextEncoder } from 'util';

// A serializable route for the main-process fetch stub. `bodyB64` is a
// base64-encoded byte body (CAR/blob); `bodyJson` is a JSON object body.
interface SerRoute {
  matchEquals?: string;
  matchPrefix?: string;
  matchContains?: string;
  ok: boolean;
  status?: number;
  bodyB64?: string;
  bodyJson?: unknown;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Build the full route table for one feature-release fixture: DID doc,
 * signed CAR proof (com.atproto.sync.getRecord), manifest blob, and each
 * file blob (com.atproto.sync.getBlob). Mirrors registerBundleFixture but
 * emits a SERIALIZABLE table for evaluateMain instead of pushing onto an
 * in-process FetchStub.
 */
async function buildRouteTable(opts: {
  did: string;
  handle: string;
  pdsUrl: string;
  rkey: string;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; bytes: Buffer }>;
}): Promise<{ routes: SerRoute[]; atUri: string }> {
  const { did, handle, pdsUrl, rkey, manifest, files } = opts;
  const didHost = did.replace(/^did:web:/, '');

  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf-8');
  const manifestCid = computeCidV1Sha256Raw(manifestBytes);

  const fileEntries = files.map((f) => ({ file: f, cid: computeCidV1Sha256Raw(f.bytes) }));

  const record: Record<string, unknown> = {
    $type: COLLECTION,
    featureId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    manifest: { $type: 'blob', ref: { $link: manifestCid }, mimeType: 'application/json', size: manifestBytes.length },
    bundle: {
      files: fileEntries.map(({ file, cid }) => ({
        path: file.path,
        blob: { $type: 'blob', ref: { $link: cid }, mimeType: 'application/octet-stream', size: file.bytes.length },
      })),
      totalSize: files.reduce((n, f) => n + f.bytes.length, 0),
    },
    createdAt: '2026-04-15T00:00:00.000Z',
  };

  const proof = await buildSignedProof(did, rkey, record);

  const didDoc = {
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pdsUrl }],
    verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: proof.publicKeyMultibase }],
    alsoKnownAs: [`at://${handle}`],
  };

  const routes: SerRoute[] = [
    { matchEquals: `https://${didHost}/.well-known/did.json`, ok: true, bodyJson: didDoc },
    { matchEquals: `https://plc.directory/${did}`, ok: true, bodyJson: didDoc },
    { matchPrefix: `${pdsUrl}/xrpc/com.atproto.sync.getRecord`, ok: true, bodyB64: b64(proof.car) },
    {
      matchPrefix: `${pdsUrl}/xrpc/com.atproto.sync.getBlob`,
      matchContains: `cid=${encodeURIComponent(manifestCid)}`,
      ok: true,
      bodyB64: b64(new Uint8Array(manifestBytes)),
    },
  ];
  for (const { file, cid } of fileEntries) {
    routes.push({
      matchPrefix: `${pdsUrl}/xrpc/com.atproto.sync.getBlob`,
      matchContains: `cid=${encodeURIComponent(cid)}`,
      ok: true,
      bodyB64: b64(new Uint8Array(file.bytes)),
    });
  }

  const atUri = `at://${did}/${COLLECTION}/${rkey}`;
  return { routes, atUri };
}

/**
 * Install a `globalThis.fetch` stub in the Electron main process from the
 * serialized route table. Returns nothing; throws (in main) on no match so
 * an unexpected outbound request fails loudly rather than hitting the net.
 */
async function installMainFetchStub(app: DesktopApp, routes: SerRoute[]): Promise<void> {
  await app.evaluateMain!(
    (_electron, payload: SerRoute[]) => {
      const g = globalThis as unknown as { __peekOrigFetch?: typeof fetch; fetch: typeof fetch };
      if (!g.__peekOrigFetch) g.__peekOrigFetch = g.fetch;
      g.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        for (const r of payload) {
          const eq = r.matchEquals ? url === r.matchEquals : true;
          const pre = r.matchPrefix ? url.startsWith(r.matchPrefix) : true;
          const con = r.matchContains ? url.includes(r.matchContains) : true;
          if (eq && pre && con) {
            const status = r.status ?? (r.ok ? 200 : 500);
            let body: BodyInit;
            if (r.bodyB64 !== undefined) {
              body = Buffer.from(r.bodyB64, 'base64');
            } else {
              body = JSON.stringify(r.bodyJson ?? {});
            }
            return new Response(body, { status });
          }
        }
        throw new Error(`[features-install.spec] unexpected fetch in main: ${url}`);
      }) as typeof fetch;
    },
    routes,
  );
}

async function restoreMainFetch(app: DesktopApp): Promise<void> {
  await app.evaluateMain!((_electron) => {
    const g = globalThis as unknown as { __peekOrigFetch?: typeof fetch; fetch: typeof fetch };
    if (g.__peekOrigFetch) {
      g.fetch = g.__peekOrigFetch;
      delete g.__peekOrigFetch;
    }
  });
}

function makeManifest(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 3,
    id,
    name: `Feature ${id}`,
    version: '1.0.0',
    tiles: [{ id: 'background', url: 'background.html', resident: true }],
    capabilities: { pubsub: { scopes: ['self', 'global'] }, commands: true },
    commands: [{ name: `${id} cmd`, action: { type: 'execute' } }],
    ...over,
  };
}

test.describe('tile:features:install — registered IPC handler @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('features-install'));
    // evaluateMain is required by this spec; createPerDescribeApp uses the
    // electron backend so it is present, but assert to fail loudly otherwise.
    expect(typeof app.evaluateMain).toBe('function');
  });

  test.afterAll(async () => {
    if (app) {
      try { await restoreMainFetch(app); } catch { /* app may already be closing */ }
      await app.close();
    }
  });

  test('refuses to install without userApproved (real handler gate)', async () => {
    const { routes, atUri } = await buildRouteTable({
      did: 'did:web:gate.example.com',
      handle: 'gate.example.com',
      pdsUrl: 'https://pds.gate.example.com',
      rkey: 'gate-1',
      manifest: makeManifest('integ-gate'),
      files: [{ path: 'background.html', bytes: Buffer.from('<html></html>', 'utf-8') }],
    });
    await installMainFetchStub(app, routes);

    const res = await bgWindow.evaluate(
      async (u: string) => await (window as any).app.features.install(u, false),
      atUri,
    );
    expect(res.error).toMatch(/User approval required/i);
    expect(res.success).toBeUndefined();

    // Not in the registry.
    const list = await bgWindow.evaluate(async () => await (window as any).app.features.list('atproto'));
    const found = (list.entries || []).some((e: any) => e.id === 'integ-gate');
    expect(found).toBe(false);
  });

  test('installs an approved feature end-to-end: registry entry + history row', async () => {
    const { routes, atUri } = await buildRouteTable({
      did: 'did:web:ok.example.com',
      handle: 'ok.example.com',
      pdsUrl: 'https://pds.ok.example.com',
      rkey: 'ok-1',
      manifest: makeManifest('integ-ok'),
      files: [
        { path: 'background.html', bytes: Buffer.from('<html>hi</html>', 'utf-8') },
        { path: 'background.js', bytes: Buffer.from('console.log(1)', 'utf-8') },
      ],
    });
    await installMainFetchStub(app, routes);

    const res = await bgWindow.evaluate(
      async (u: string) => await (window as any).app.features.install(u, true),
      atUri,
    );
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.entry?.id).toBe('integ-ok');

    // Registry: the feature is now listed under the atproto source.
    const list = await bgWindow.evaluate(async () => await (window as any).app.features.list('atproto'));
    const entry = (list.entries || []).find((e: any) => e.id === 'integ-ok');
    expect(entry).toBeTruthy();
    expect(entry.source.type).toBe('atproto');
    expect(entry.source.uri).toBe(atUri);

    // features_history: a real install row exists for this feature, queried
    // back through the registered tile:features:history handler.
    const hist = await bgWindow.evaluate(
      async (id: string) => await (window as any).app.features.history(id),
      'integ-ok',
    );
    const rows = (hist.entries || []) as Array<any>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const installRow = rows.find((r) => r.event === 'install');
    expect(installRow).toBeTruthy();
    expect(installRow.sourceType).toBe('atproto');
    expect(installRow.sourceUri).toBe(atUri);
  });

  test('a bad signature is rejected by the real verify path', async () => {
    // Build a valid proof, then corrupt the CAR bytes so commit-signature
    // verification fails inside the booted handler. The install must error
    // and write nothing to the registry.
    const { routes, atUri } = await buildRouteTable({
      did: 'did:web:bad.example.com',
      handle: 'bad.example.com',
      pdsUrl: 'https://pds.bad.example.com',
      rkey: 'bad-1',
      manifest: makeManifest('integ-bad'),
      files: [{ path: 'background.html', bytes: Buffer.from('<html></html>', 'utf-8') }],
    });
    // Corrupt the getRecord (CAR) route body.
    const carRoute = routes.find((r) => r.matchPrefix?.includes('getRecord'))!;
    const corrupted = Buffer.from(carRoute.bodyB64!, 'base64');
    corrupted[corrupted.length - 1] ^= 0xff; // flip last byte
    carRoute.bodyB64 = corrupted.toString('base64');
    await installMainFetchStub(app, routes);

    const res = await bgWindow.evaluate(
      async (u: string) => await (window as any).app.features.install(u, true),
      atUri,
    );
    expect(res.success).toBeUndefined();
    expect(res.error).toBeTruthy();

    const list = await bgWindow.evaluate(async () => await (window as any).app.features.list('atproto'));
    const found = (list.entries || []).some((e: any) => e.id === 'integ-bad');
    expect(found).toBe(false);
  });
});
