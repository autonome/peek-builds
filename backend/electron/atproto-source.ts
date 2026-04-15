/**
 * AtprotoSource — Fetches and installs features from AT Protocol repositories
 *
 * Implements the TileSource interface for AT Protocol. Runs in main process (Node.js).
 * All API calls are unauthenticated — reads public records and blobs from PDS.
 *
 * AT URI format: at://{did-or-handle}/{collection}/{rkey}
 * Expected collection: space.peek.feature.release
 */

import type {
  TileManifestV2,
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
  createdAt: string;
}

/** Internal resolved data from resolve() */
interface ResolvedFeature {
  did: string;
  handle: string;
  pdsUrl: string;
  record: FeatureReleaseRecord;
  manifest: TileManifestV2;
  atUri: string;
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
    let didDoc: {
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
      alsoKnownAs?: string[];
    } | null = null;

    if (did.startsWith('did:plc:')) {
      const res = await fetch(`https://plc.directory/${did}`);
      if (res.ok) didDoc = await res.json() as typeof didDoc;
    } else if (did.startsWith('did:web:')) {
      const host = did.replace('did:web:', '');
      const res = await fetch(`https://${host}/.well-known/did.json`);
      if (res.ok) didDoc = await res.json() as typeof didDoc;
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
 * Download a blob from a PDS (unauthenticated).
 * Uses com.atproto.sync.getBlob XRPC endpoint.
 */
export async function getBlob(
  pdsUrl: string,
  did: string,
  cid: string
): Promise<Buffer> {
  const params = new URLSearchParams({ did, cid });
  const url = `${pdsUrl}/xrpc/com.atproto.sync.getBlob?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch blob ${cid}: ${res.status} ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── AtprotoSource Class ────────────────────────────────────────────

/**
 * AtprotoSource implements TileSource for AT Protocol feature records.
 *
 * Usage:
 *   const source = new AtprotoSource();
 *   const metadata = await source.resolve('at://did:plc:.../space.peek.feature.release/...');
 *   const bundle = await source.fetch('at://did:plc:.../space.peek.feature.release/...');
 */
export class AtprotoSource implements TileSource {
  type = 'atproto';

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

    // 4. Fetch the record from PDS (unauthenticated)
    const recordResult = await getRecord(pdsUrl, did, collection, rkey);
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

    // 6. Download manifest blob and parse as TileManifestV2
    const manifestBuffer = await getBlob(pdsUrl, did, record.manifest.ref.$link);
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

    const manifest = manifestRaw as unknown as TileManifestV2;

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

    return {
      source,
      manifest: resolved.manifest,
    };
  }

  /**
   * Fetch an AT URI — downloads all bundle files and returns a TileBundle.
   * This is the full install payload.
   */
  async fetch(atUri: string): Promise<TileBundle> {
    const resolved = await this.resolveInternal(atUri);

    // Download each file blob from PDS
    const files = new Map<string, Buffer>();

    for (const fileEntry of resolved.record.bundle.files) {
      if (!fileEntry.path || !fileEntry.blob?.ref?.$link) {
        throw new Error(`Invalid file entry in bundle: missing path or blob ref`);
      }

      const fileBuffer = await getBlob(
        resolved.pdsUrl,
        resolved.did,
        fileEntry.blob.ref.$link
      );

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
