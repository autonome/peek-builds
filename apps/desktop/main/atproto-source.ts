/**
 * AtprotoSource — Fetches and installs features from AT Protocol repositories
 *
 * Implements the TileSource interface for AT Protocol. Runs in main process (Node.js).
 * All API calls are unauthenticated — reads public records and blobs from PDS.
 *
 * AT URI format: at://{did-or-handle}/{collection}/{rkey}
 * Expected collection: space.peek.feature.release
 */

import crypto from 'node:crypto';

import type {
  TileManifest,
} from './tile-manifest.js';
import {
  validateTileManifest,
} from './tile-manifest.js';
import type {
  TileSource,
  TileBundle,
  FeatureSourceMetadata,
} from './feature-installer.js';
import type { FeatureSource } from './feature-registry.js';
import { fetchAndVerifyRecord } from './atproto-verify.js';

// ─── Injectable fetch (for tests) ───────────────────────────────────

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...args: Parameters<FetchFn>) => fetch(...args);

/** Override the fetch implementation (tests only). Pass nothing to reset. */
export function __setFetchForTest(fn?: FetchFn): void {
  fetchImpl = fn ?? ((...args: Parameters<FetchFn>) => fetch(...args));
}

// ─── Types ──────────────────────────────────────────────────────────

/** Parsed AT URI components */
export interface AtUriParts {
  repo: string;       // DID or handle
  collection: string; // NSID
  rkey: string;       // record key
}

/** A blob reference in an AT Protocol record */
interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/** A file entry in the bundle */
interface FileEntry {
  path: string;
  blob: BlobRef;
}

/** The space.peek.feature.release record structure */
interface FeatureReleaseRecord {
  featureId: string;
  name: string;
  version: string;
  manifest: BlobRef;
  bundle: {
    files: FileEntry[];
    totalSize: number;
  };
  description?: string;
  categories?: string[];
  capabilities?: string[];
  /** Optional feature icon blob (PNG or SVG) — display only, not installed. */
  icon?: BlobRef;
  /** Optional screenshot blobs (PNG or JPEG) — display only, not installed. */
  screenshots?: BlobRef[];
  minPeekVersion?: string;
  createdAt: string;
}

/** Internal resolved data from resolve() */
interface ResolvedFeature {
  did: string;
  handle: string;
  pdsUrl: string;
  record: FeatureReleaseRecord;
  manifest: TileManifest;
  atUri: string;
}

/** Options for constructing an AtprotoSource */
export interface AtprotoSourceOptions {
  /**
   * The current running Peek version (semver). Used to enforce the
   * record's optional `minPeekVersion` field at install time.
   *
   * If omitted, the `minPeekVersion` check is skipped (defensive default
   * so tests and non-Electron callers don't need to provide one).
   */
  peekVersion?: string;
}

// ─── AT URI Parsing ─────────────────────────────────────────────────

/**
 * Parse an AT URI into its components.
 * Format: at://{repo}/{collection}/{rkey}
 *
 * @throws Error if the URI is malformed
 */
export function parseAtUri(uri: string): AtUriParts {
  if (!uri.startsWith('at://')) {
    throw new Error(`Invalid AT URI: must start with "at://": ${uri}`);
  }

  const rest = uri.slice(5); // remove "at://"
  const parts = rest.split('/');

  if (parts.length < 3) {
    throw new Error(`Invalid AT URI: expected at://{repo}/{collection}/{rkey}, got: ${uri}`);
  }

  const repo = parts[0];
  // Collection can have dots (e.g., space.peek.feature.release)
  // so everything between repo and the last segment is collection
  const rkey = parts[parts.length - 1];
  const collection = parts.slice(1, parts.length - 1).join('/');

  if (!repo || !collection || !rkey) {
    throw new Error(`Invalid AT URI: empty component in: ${uri}`);
  }

  return { repo, collection, rkey };
}

// ─── CID Computation ────────────────────────────────────────────────

// RFC 4648 base32 alphabet (lowercase) — used by multibase 'b' prefix.
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Encode a byte buffer as base32-lowercase without padding (RFC 4648).
 * Matches multibase encoding with prefix 'b' used in CIDv1 string form.
 */
function encodeBase32NoPad(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Compute a CIDv1 string for a byte buffer, using:
 *   - codec: raw (0x55)
 *   - multihash: sha2-256 (0x12) with 32-byte digest (0x20)
 *   - multibase: base32-lowercase ('b' prefix)
 *
 * This matches how AT Protocol blobs are identified. The resulting
 * string starts with `bafkrei` for any 32-byte sha256 raw CID.
 */
export function computeCidV1Sha256Raw(bytes: Buffer | Uint8Array): string {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  // CIDv1 prefix bytes: version 0x01, codec 0x55 (raw), mh-code 0x12 (sha2-256), mh-length 0x20 (32)
  const cidBytes = Buffer.concat([
    Buffer.from([0x01, 0x55, 0x12, 0x20]),
    digest,
  ]);
  return 'b' + encodeBase32NoPad(cidBytes);
}

// ─── Semver Comparison ──────────────────────────────────────────────

/**
 * Parse a semver-ish string into [major, minor, patch] numbers.
 * Missing parts default to 0. Ignores anything after the first '-' or '+'
 * (so "1.2.3-rc.1" parses as 1.2.3). Non-numeric segments parse as 0.
 */
function parseSemver(v: string): [number, number, number] {
  const clean = String(v).trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = clean.split('.');
  const n = (s: string | undefined): number => {
    const x = Number.parseInt(s ?? '0', 10);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  };
  return [n(parts[0]), n(parts[1]), n(parts[2])];
}

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b,  0 if equal,  1 if a > b.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMa, aMi, aPa] = parseSemver(a);
  const [bMa, bMi, bPa] = parseSemver(b);
  if (aMa !== bMa) return aMa < bMa ? -1 : 1;
  if (aMi !== bMi) return aMi < bMi ? -1 : 1;
  if (aPa !== bPa) return aPa < bPa ? -1 : 1;
  return 0;
}

// ─── Identity Resolution ────────────────────────────────────────────

/**
 * Resolve a handle to a DID via the public API.
 * Returns null if the handle cannot be resolved.
 */
export async function resolveHandleToDid(handle: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
    );
    if (!res.ok) return null;
    const data = await res.json() as { did?: string };
    return data.did || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a DID to its DID document and extract PDS URL and handle.
 * Supports did:plc and did:web methods.
 */
export async function resolveDid(did: string): Promise<{ pdsUrl: string; handle: string } | null> {
  try {
    interface DidDocument {
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
      alsoKnownAs?: string[];
    }

    let didDoc: DidDocument | null = null;

    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (res.ok) didDoc = await res.json() as DidDocument;
    } else if (did.startsWith('did:web:')) {
      const host = did.replace('did:web:', '');
      const res = await fetch(`https://${host}/.well-known/did.json`);
      if (res.ok) didDoc = await res.json() as DidDocument;
    }

    if (!didDoc || !didDoc.service) return null;

    const pdsService = didDoc.service.find(
      (s: { id: string; type: string }) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
    );
    if (!pdsService) return null;

    // Extract handle from alsoKnownAs (at:// URI format)
    let handle = did; // fallback to DID
    if (didDoc.alsoKnownAs) {
      for (const aka of didDoc.alsoKnownAs) {
        if (aka.startsWith('at://')) {
          handle = aka.slice(5); // remove "at://"
          break;
        }
      }
    }

    return {
      pdsUrl: pdsService.serviceEndpoint,
      handle,
    };
  } catch {
    return null;
  }
}

// ─── PDS API Calls ──────────────────────────────────────────────────

/**
 * Fetch a record from a PDS (unauthenticated).
 * Uses com.atproto.repo.getRecord XRPC endpoint.
 */
export async function getRecord(
  pdsUrl: string,
  repo: string,
  collection: string,
  rkey: string
): Promise<{ uri: string; cid: string; value: Record<string, unknown> }> {
  const params = new URLSearchParams({ repo, collection, rkey });
  const url = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch record: ${res.status} ${res.statusText} — ${body}`);
  }

  return res.json() as Promise<{ uri: string; cid: string; value: Record<string, unknown> }>;
}

/**
 * Build the public (unauthenticated) PDS XRPC URL for a blob.
 * Uses com.atproto.sync.getBlob. This is the *upstream fetch* URL used by
 * getBlob() below — it is NOT handed to the renderer.
 *
 * Renderer-facing display media (icon/screenshots) instead use
 * buildFeatureBlobUrl() → a `peek://feature-blob/...` URL whose bytes are
 * CID-verified by the main process before display (see fetchVerifiedFeatureBlob).
 */
export function buildBlobUrl(pdsUrl: string, did: string, cid: string): string {
  const params = new URLSearchParams({ did, cid });
  return `${pdsUrl}/xrpc/com.atproto.sync.getBlob?${params.toString()}`;
}

/**
 * Download a blob from a PDS (unauthenticated).
 * Uses com.atproto.sync.getBlob XRPC endpoint.
 */
export async function getBlob(
  pdsUrl: string,
  did: string,
  cid: string
): Promise<Buffer> {
  const url = buildBlobUrl(pdsUrl, did, cid);

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch blob ${cid}: ${res.status} ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Verified display-media (icon/screenshot) serving ───────────────

/**
 * Known publisher PDS registry: DID → PDS URL.
 *
 * Populated only by the paths that have already discovered (and, for the
 * install path, signature-verified) a publisher's identity — resolveInternal()
 * and the browse-list IPC handler. The `peek://feature-blob` protocol handler
 * looks DIDs up here rather than resolving them itself, which (a) caches the
 * DID→PDS discovery across the many `<img>` loads of a browse list, and
 * (b) deliberately does NOT widen the did:web → arbitrary-host SSRF surface of
 * resolveDid() into a handler reachable by any peek:// renderer. A DID the user
 * hasn't browsed is simply unserveable (handler 404s → letter-avatar fallback).
 */
const knownPublisherPds = new Map<string, string>();

/** Record a DID→PDS mapping so its display blobs can be served + verified. */
export function registerPublisherPds(did: string, pdsUrl: string): void {
  if (did && pdsUrl) knownPublisherPds.set(did, pdsUrl);
}

/**
 * Build the renderer-facing URL for a verified feature display blob.
 * `<img src>` loads this; the `peek://feature-blob` protocol handler fetches the
 * bytes from the publisher's PDS and CID-verifies them before serving.
 */
export function buildFeatureBlobUrl(did: string, cid: string): string {
  return `peek://feature-blob/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
}

/**
 * Sniff an image Content-Type from magic bytes. Display media is loaded via
 * `<img src>` (Chromium sniffs regardless), but a correct type is cleaner and
 * avoids relying on the record's publisher-declared mimeType. SVG is served as
 * image/svg+xml — safe under `<img>`, where embedded scripts do not execute.
 */
function sniffImageContentType(bytes: Buffer): string {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  // SVG (or XML-wrapped SVG): a leading '<' after optional whitespace/BOM.
  const head = bytes.subarray(0, 256).toString('utf-8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

/**
 * Fetch a feature display blob (icon/screenshot) from its publisher's PDS and
 * verify the bytes hash to the requested CID before returning them.
 *
 * This closes the display-media integrity gap: the bundle/manifest blobs are
 * already CID-gated at install (verifyBlobCid), but icon/screenshot bytes used
 * to be loaded straight from a public PDS URL with no byte verification — a
 * compromised PDS could serve different image bytes under the signed CID and
 * spoof a trusted publisher's icon. Here the SAME hash gate
 * (computeCidV1Sha256Raw) is applied to display bytes.
 *
 * Unlike the install path, a bad display blob is NOT fatal: this returns null
 * (the handler 404s → the renderer falls back to the letter avatar / drops the
 * screenshot) rather than throwing. A cosmetic image must never block a feature
 * whose executable bundle verified clean.
 */
export async function fetchVerifiedFeatureBlob(
  did: string,
  cid: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const pdsUrl = knownPublisherPds.get(did);
  if (!pdsUrl) {
    console.warn(`[atproto] feature-blob: no known PDS for ${did} — refusing to resolve (not browsed)`);
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = await getBlob(pdsUrl, did, cid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[atproto] feature-blob: fetch failed for ${cid}: ${msg}`);
    return null;
  }

  const actual = computeCidV1Sha256Raw(bytes);
  if (actual !== cid) {
    console.warn(
      `[atproto] feature-blob: CID mismatch — requested ${cid} but bytes hash to ${actual}. ` +
      `Dropping (PDS may be serving substituted display media).`
    );
    return null;
  }

  return { bytes, contentType: sniffImageContentType(bytes) };
}

// ─── AtprotoSource Class ────────────────────────────────────────────

/**
 * AtprotoSource implements TileSource for AT Protocol feature records.
 *
 * Usage:
 *   const source = new AtprotoSource({ peekVersion: app.getVersion() });
 *   const metadata = await source.resolve('at://did:plc:.../space.peek.feature.release/...');
 *   const bundle = await source.fetch('at://did:plc:.../space.peek.feature.release/...');
 */
export class AtprotoSource implements TileSource {
  type = 'atproto';
  private peekVersion?: string;

  constructor(options: AtprotoSourceOptions = {}) {
    this.peekVersion = options.peekVersion;
  }

  /**
   * Internal resolve that returns full data (used by both resolve() and fetch()).
   */
  private async resolveInternal(atUri: string): Promise<ResolvedFeature> {
    // 1. Parse AT URI
    const { repo, collection, rkey } = parseAtUri(atUri);

    // 2. Resolve repo to DID if it's a handle
    let did: string;
    if (repo.startsWith('did:')) {
      did = repo;
    } else {
      const resolved = await resolveHandleToDid(repo);
      if (!resolved) {
        throw new Error(`Could not resolve handle "${repo}" to a DID`);
      }
      did = resolved;
    }

    // 3. Discover PDS URL for the DID
    const identity = await resolveDid(did);
    if (!identity) {
      throw new Error(`Could not discover PDS for DID: ${did}`);
    }

    const { pdsUrl, handle } = identity;

    // Record the DID→PDS mapping so the verified-blob protocol handler can
    // serve this publisher's display media (icon/screenshots) without
    // re-resolving the DID itself.
    registerPublisherPds(did, pdsUrl);

    // 4. Fetch the record from PDS AND cryptographically verify it.
    //    This replaces the previous unverified getRecord() call: we now
    //    resolve the publisher's #atproto signing key, fetch a CAR proof
    //    (signed commit + MST path + record block), verify the commit
    //    signature, and confirm the record's CID is included in the
    //    committed MST. Any failure throws and aborts the install — there is
    //    no unverified fallback. The existing verifyBlobCid() (below) then
    //    closes the chain from the verified record CIDs to the blob bytes.
    const recordResult = await fetchAndVerifyRecord(
      pdsUrl,
      { did, collection, rkey },
      atUri
    );
    const record = recordResult.value as unknown as FeatureReleaseRecord;

    // 5. Validate record structure
    if (!record.featureId || !record.name || !record.version) {
      throw new Error('Record missing required fields: featureId, name, version');
    }
    if (!record.manifest || !record.manifest.ref?.$link) {
      throw new Error('Record missing manifest blob reference');
    }
    if (!record.bundle || !Array.isArray(record.bundle.files)) {
      throw new Error('Record missing bundle or bundle.files array');
    }

    // 5b. Enforce minPeekVersion, if declared.
    // We check as early as possible so we don't download blobs for a release
    // that can't run on this build anyway.
    if (record.minPeekVersion && this.peekVersion) {
      if (compareSemver(this.peekVersion, record.minPeekVersion) < 0) {
        throw new Error(
          `Feature requires Peek ${record.minPeekVersion} or newer ` +
          `(current version: ${this.peekVersion}). Please update Peek to install.`
        );
      }
    }

    // 6. Download manifest blob and parse as TileManifest.
    //    Verify CID matches the record's manifest ref.
    const manifestBuffer = await getBlob(pdsUrl, did, record.manifest.ref.$link);
    verifyBlobCid('manifest.json', manifestBuffer, record.manifest.ref.$link);
    const manifestJson = manifestBuffer.toString('utf-8');

    let manifestRaw: Record<string, unknown>;
    try {
      manifestRaw = JSON.parse(manifestJson) as Record<string, unknown>;
    } catch {
      throw new Error('Manifest blob is not valid JSON');
    }

    // 7. Validate manifest
    const errors = validateTileManifest(manifestRaw);
    if (errors.length > 0) {
      const msgs = errors.map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Invalid manifest: ${msgs}`);
    }

    const manifest = manifestRaw as unknown as TileManifest;

    // 8. Cross-validate: record featureId should match manifest id
    if (manifest.id !== record.featureId) {
      throw new Error(
        `Feature ID mismatch: record says "${record.featureId}" but manifest says "${manifest.id}"`
      );
    }

    return {
      did,
      handle,
      pdsUrl,
      record,
      manifest,
      atUri,
    };
  }

  /**
   * Resolve an AT URI to feature metadata (without downloading files).
   * Used for preview/approval before install.
   */
  async resolve(atUri: string): Promise<FeatureSourceMetadata> {
    const resolved = await this.resolveInternal(atUri);

    const source: FeatureSource = {
      type: 'atproto',
      publisher: resolved.did,
      publisherName: resolved.handle,
      uri: atUri,
      version: resolved.record.version,
    };

    // Surface display media (icon + screenshots) as `peek://feature-blob/...`
    // URLs. The renderer loads them via <img src>; the protocol handler fetches
    // the bytes and CID-verifies them against the (signature-verified) record
    // CIDs before display, so a compromised PDS can't substitute the bytes. On
    // mismatch the handler 404s and the renderer falls back to the letter avatar.
    const { record, did } = resolved;
    const icon = record.icon?.ref?.$link
      ? buildFeatureBlobUrl(did, record.icon.ref.$link)
      : undefined;
    const screenshots = Array.isArray(record.screenshots)
      ? record.screenshots
          .filter((s): s is BlobRef => !!s?.ref?.$link)
          .map(s => buildFeatureBlobUrl(did, s.ref.$link))
      : undefined;

    return {
      source,
      manifest: resolved.manifest,
      iconUrl: icon,
      screenshotUrls: screenshots && screenshots.length > 0 ? screenshots : undefined,
    };
  }

  /**
   * Fetch an AT URI — downloads all bundle files and returns a TileBundle.
   * This is the full install payload.
   *
   * Each downloaded blob is CID-verified against the record's declared ref.
   * On any mismatch the whole install is rejected before returning — callers
   * should not need to re-check.
   */
  async fetch(atUri: string): Promise<TileBundle> {
    const resolved = await this.resolveInternal(atUri);

    // Download each file blob from PDS and verify CID matches the record.
    const files = new Map<string, Buffer>();

    for (const fileEntry of resolved.record.bundle.files) {
      if (!fileEntry.path || !fileEntry.blob?.ref?.$link) {
        throw new Error(`Invalid file entry in bundle: missing path or blob ref`);
      }

      const declaredCid = fileEntry.blob.ref.$link;
      const fileBuffer = await getBlob(
        resolved.pdsUrl,
        resolved.did,
        declaredCid
      );

      // Data-integrity gate: reject the whole install if any blob's bytes
      // don't hash to the CID the record promised. This protects against a
      // PDS (or MITM) swapping out bytes while keeping the record intact.
      verifyBlobCid(fileEntry.path, fileBuffer, declaredCid);

      files.set(fileEntry.path, fileBuffer);
    }

    // Validate that manifest.json is included in the bundle
    // (it might be separate from the manifest blob — the bundle has the raw files)
    // If manifest.json is not in the files, add it from the manifest blob
    if (!files.has('manifest.json')) {
      files.set('manifest.json', Buffer.from(JSON.stringify(resolved.manifest, null, 2), 'utf-8'));
    }

    return {
      manifest: resolved.manifest,
      files,
    };
  }
}

// ─── CID Verification Helper ────────────────────────────────────────

/**
 * Verify a downloaded buffer's bytes hash to the given CID.
 *
 * We only know how to compute one CID flavor (CIDv1, raw codec, sha2-256),
 * which is the shape AT Protocol uses for blobs. If the record declares
 * a CID in a different flavor we fall back to string comparison — rejecting
 * only on a clear mismatch with our computed form.
 *
 * @throws Error on mismatch, with the path of the offending file.
 */
function verifyBlobCid(label: string, bytes: Buffer, declaredCid: string): void {
  if (!declaredCid || typeof declaredCid !== 'string') {
    throw new Error(`Blob "${label}" has no declared CID to verify against`);
  }
  const actual = computeCidV1Sha256Raw(bytes);
  if (actual === declaredCid) return;

  // The AT Protocol blob CID spec is CIDv1 + raw + sha2-256, so for any
  // conformant record `actual` should match. A mismatch is a hard fail.
  throw new Error(
    `Blob CID mismatch for "${label}": declared ${declaredCid} but got ${actual}. ` +
    `Refusing to install — the file's bytes don't match the record's declared hash.`
  );
}
