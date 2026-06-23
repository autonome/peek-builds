/**
 * Shared TEST fixture helper for atproto feature-release installs.
 *
 * NOT product code — imported only by `*.test.ts` files. Lives in `main/`
 * (alongside `atproto-verify-fixtures.ts`) so it compiles to `dist/main/`
 * and electron-as-node tests can import it as a sibling.
 *
 * The install path cryptographically verifies the record: it resolves the
 * publisher's #atproto signing key, fetches a CAR proof
 * (com.atproto.sync.getRecord) holding the signed commit + MST path + record
 * block, verifies the commit signature, and confirms MST inclusion. To keep
 * install-behavior tests realistic (and passing), this helper generates a
 * REAL signed proof per fixture: a fresh secp256k1 keypair, a one-leaf MST
 * holding the record, and a properly signed commit. The DID doc then
 * advertises that keypair's public key as #atproto.
 *
 * Extracted verbatim from atproto-install-hardening.test.ts so the
 * install-handler test can reuse the exact same real-proof machinery.
 */

import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';
import { Secp256k1Keypair } from '@atproto/crypto';

import { computeCidV1Sha256Raw } from './atproto-source.js';
import type { TileManifest } from './tile-manifest.js';

export const COLLECTION = 'space.peek.feature.release';

// ─── Signed-proof builder ───────────────────────────────────────────

export interface SignedProof {
  /** publicKeyMultibase for the DID doc #atproto verificationMethod. */
  publicKeyMultibase: string;
  /** the record CID (dag-cbor) the proof commits to. */
  recordCid: string;
  /** serialized CARv1 proof bytes. */
  car: Uint8Array;
}

async function dagCid(bytes: Uint8Array): Promise<CID> {
  return CID.create(1, dagCbor.code, await sha256.digest(bytes));
}

function varintEnc(n: number): Uint8Array {
  const buf: number[] = [];
  let v = n;
  while (v >= 0x80) {
    buf.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  buf.push(v);
  return new Uint8Array(buf);
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Build a real signed CAR proof for a single record under
 * `space.peek.feature.release/<rkey>` in `did`'s repo.
 */
export async function buildSignedProof(
  did: string,
  rkey: string,
  recordValue: Record<string, unknown>
): Promise<SignedProof> {
  const keypair = await Secp256k1Keypair.create();
  const publicKeyMultibase = keypair.did().slice('did:key:'.length);

  // record block
  const recordBytes = dagCbor.encode(recordValue);
  const recordCid = await dagCid(recordBytes);

  // one-leaf MST node: key = "space.peek.feature.release/<rkey>"
  const key = new TextEncoder().encode(`${COLLECTION}/${rkey}`);
  const mstNode = { l: null, e: [{ p: 0, k: key, v: recordCid, t: null }] };
  const mstBytes = dagCbor.encode(mstNode);
  const mstCid = await dagCid(mstBytes);

  // commit
  const unsigned = { did, version: 3, data: mstCid, rev: '3kaaaaaaaaaa2', prev: null };
  const sig = await keypair.sign(dagCbor.encode(unsigned));
  const commit = { ...unsigned, sig };
  const commitBytes = dagCbor.encode(commit);
  const commitCid = await dagCid(commitBytes);

  // CAR: header (roots = [commitCid]) + 3 blocks
  const header = dagCbor.encode({ version: 1, roots: [commitCid] });
  const chunks: Uint8Array[] = [varintEnc(header.length), header];
  for (const [cid, bytes] of [
    [commitCid, commitBytes],
    [mstCid, mstBytes],
    [recordCid, recordBytes],
  ] as Array<[CID, Uint8Array]>) {
    const cidBytes = cid.bytes;
    const sec = concatAll([cidBytes, bytes]);
    chunks.push(varintEnc(sec.length), sec);
  }

  return { publicKeyMultibase, recordCid: recordCid.toString(), car: concatAll(chunks) };
}

// ─── Global fetch stub ──────────────────────────────────────────────
//
// AtprotoSource calls `fetch` directly on the global. The stub captures
// routes and restores the original on teardown.

export interface StubRoute {
  match: (url: string) => boolean;
  respond: () => { ok: boolean; status?: number; statusText?: string; body: Buffer | string | object };
}

export class FetchStub {
  private originalFetch: typeof globalThis.fetch | undefined;
  routes: StubRoute[] = [];

  install(): void {
    this.originalFetch = globalThis.fetch;
    this.routes = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      for (const route of this.routes) {
        if (route.match(url)) {
          const r = route.respond();
          const status = r.status ?? (r.ok ? 200 : 500);
          const statusText = r.statusText ?? (r.ok ? 'OK' : 'Error');
          let body: BodyInit;
          if (Buffer.isBuffer(r.body)) {
            body = new Uint8Array(r.body);
          } else if (typeof r.body === 'string') {
            body = r.body;
          } else {
            body = JSON.stringify(r.body);
          }
          return new Response(body, { status, statusText });
        }
      }
      throw new Error(`No fetch stub matched: ${url}`);
    }) as typeof globalThis.fetch;
  }

  restore(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
    this.routes = [];
  }
}

// ─── Bundle fixture registration ─────────────────────────────────────

export interface BundleFixtureFile {
  path: string;
  bytes: Buffer;
  /** If set, overrides the real CID in the record (for CID-mismatch tests). */
  spoofCid?: string;
  /** If set, throws a network error when this blob is fetched. */
  throwOn?: 'fetch';
}

export interface BundleFixture {
  did: string;
  handle: string;
  pdsUrl: string;
  rkey: string;
  manifest: TileManifest;
  files: BundleFixtureFile[];
  minPeekVersion?: string;
}

/**
 * Register a complete DID-doc + signed CAR proof + getBlob chain for a
 * feature-release fixture on the given fetch stub. After this, a real
 * `AtprotoSource.resolve(atUri)` / `.fetch(atUri)` against
 * `atUriFor(fx)` resolves, verifies, and downloads the bundle.
 */
export async function registerBundleFixture(stub: FetchStub, fx: BundleFixture): Promise<void> {
  const didHost = fx.did.replace(/^did:web:/, '');

  // Manifest blob (JSON)
  const manifestBytes = Buffer.from(JSON.stringify(fx.manifest), 'utf-8');
  const manifestCid = computeCidV1Sha256Raw(manifestBytes);

  // File blobs
  const fileEntries = fx.files.map((f) => {
    const realCid = computeCidV1Sha256Raw(f.bytes);
    return {
      file: f,
      realCid,
      declaredCid: f.spoofCid ?? realCid,
    };
  });

  // The space.peek.feature.release record. This is what the signed CAR proof
  // commits to — the verified install path decodes it straight from the proof.
  const record: Record<string, unknown> = {
    $type: COLLECTION,
    featureId: fx.manifest.id,
    name: fx.manifest.name,
    version: fx.manifest.version,
    manifest: {
      $type: 'blob',
      ref: { $link: manifestCid },
      mimeType: 'application/json',
      size: manifestBytes.length,
    },
    bundle: {
      files: fileEntries.map(({ file, declaredCid }) => ({
        path: file.path,
        blob: {
          $type: 'blob',
          ref: { $link: declaredCid },
          mimeType: 'application/octet-stream',
          size: file.bytes.length,
        },
      })),
      totalSize: fx.files.reduce((n, f) => n + f.bytes.length, 0),
    },
    createdAt: '2026-04-15T00:00:00.000Z',
    ...(fx.minPeekVersion ? { minPeekVersion: fx.minPeekVersion } : {}),
  };

  // Generate a real signed proof committing to `record`.
  const proof = await buildSignedProof(fx.did, fx.rkey, record);

  // DID document: PDS service + the #atproto signing key from the proof.
  const didDoc = {
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: fx.pdsUrl,
      },
    ],
    verificationMethod: [
      {
        id: `${fx.did}#atproto`,
        type: 'Multikey',
        controller: fx.did,
        publicKeyMultibase: proof.publicKeyMultibase,
      },
    ],
    alsoKnownAs: [`at://${fx.handle}`],
  };

  // DID document resolution — serves both did:web discovery (PDS) and the
  // plc.directory/did:web signing-key lookup (same host for did:web).
  stub.routes.push({
    match: (u) =>
      u === `https://${didHost}/.well-known/did.json` ||
      u === `https://plc.directory/${fx.did}`,
    respond: () => ({ ok: true, body: didDoc }),
  });

  // com.atproto.sync.getRecord — the signed CAR proof.
  stub.routes.push({
    match: (u) => u.startsWith(`${fx.pdsUrl}/xrpc/com.atproto.sync.getRecord`),
    respond: () => ({ ok: true, body: Buffer.from(proof.car) }),
  });

  // getBlob for manifest
  stub.routes.push({
    match: (u) =>
      u.startsWith(`${fx.pdsUrl}/xrpc/com.atproto.sync.getBlob`) &&
      u.includes(`cid=${encodeURIComponent(manifestCid)}`),
    respond: () => ({ ok: true, body: manifestBytes }),
  });

  // getBlob for each file
  for (const { file, realCid, declaredCid } of fileEntries) {
    stub.routes.push({
      match: (u) =>
        u.startsWith(`${fx.pdsUrl}/xrpc/com.atproto.sync.getBlob`) &&
        u.includes(`cid=${encodeURIComponent(declaredCid)}`),
      respond: () => {
        if (file.throwOn === 'fetch') {
          return { ok: false, status: 500, statusText: 'Server error', body: 'simulated failure' };
        }
        void realCid;
        return { ok: true, body: file.bytes };
      },
    });
  }
}

export function atUriFor(fx: { did: string; rkey: string }): string {
  return `at://${fx.did}/space.peek.feature.release/${fx.rkey}`;
}

export function makeManifest(id: string, overrides: Record<string, unknown> = {}): TileManifest {
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
      { name: `${id} cmd`, action: { type: 'execute' } },
    ],
    ...overrides,
  } as unknown as TileManifest;
}
