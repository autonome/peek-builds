/**
 * Tile Loader — Bridges the feature registry to the tile launcher
 *
 * At startup:
 * 1. Load registry
 * 2. Iterate features
 * 3. Load manifests
 * 4. Route to tile launcher (v2) or legacy loader (v1)
 *
 * This module replaces the direct features/ scan pattern in main.ts.
 * It reads from the registry (populated by feature-installer) and
 * delegates to tile-compat for actual loading.
 */

import fs from 'node:fs';
import path from 'node:path';

import { FeatureRegistry, type FeatureRegistryEntry } from './feature-registry.js';
import {
  parseManifestFile,
  type TileManifestV2,
  type ParsedManifest,
} from './tile-manifest.js';
import { type AnnotatedExtension, loadV2Tile, type TileCompatConfig } from './tile-compat.js';
import { type ExtensionManifest } from './extensions.js';
import * as manifestCache from './manifest-cache.js';
import { DEBUG } from './config.js';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Result of loading a single feature
 */
export interface FeatureLoadResult {
  id: string;
  loaded: boolean;
  manifestVersion: 'v1' | 'v2';
  error?: string;
}

/**
 * Configuration for the tile loader
 */
export interface TileLoaderConfig {
  /** Path to the tile preload script */
  tilePreloadPath: string;
  /** Set of feature IDs that should load eagerly */
  eagerIds?: Set<string>;
  /** Callback for v1 features that need legacy loading */
  onV1Feature?: (id: string, featurePath: string, manifest: ExtensionManifest) => void;
}

// ─── Loader ─────────────────────────────────────────────────────────

/**
 * Load all features from the registry.
 *
 * For each registered feature:
 * - Reads manifest from entry.path/manifest.json
 * - Detects v1 vs v2
 * - V2: passes to tile launcher with granted capabilities
 * - V1: calls onV1Feature callback for legacy handling
 *
 * Returns results for each feature attempted.
 */
export function loadFeaturesFromRegistry(
  registry: FeatureRegistry,
  config: TileLoaderConfig
): FeatureLoadResult[] {
  const results: FeatureLoadResult[] = [];
  const features = registry.listFeatures();

  for (const entry of features) {
    const result = loadSingleFeature(entry, config);
    results.push(result);
  }

  return results;
}

/**
 * Resolve a feature's manifest, preferring manifest_cache over disk.
 *
 * Phase C: the cache is the authoritative source. Disk fallback covers
 * two legitimate cases — v1 manifests (which the cache deliberately
 * doesn't store) and cache drift (e.g. ephemeral profile whose cache
 * was cleared mid-session between registry seed and feature load).
 *
 * Returning `null` means both paths failed; caller surfaces an error.
 */
function loadParsedManifest(
  entry: FeatureRegistryEntry,
  manifestPath: string,
): ParsedManifest | null {
  try {
    const cached = manifestCache.get(entry.id);
    if (cached && cached.manifest) {
      // The cache stores the full parsed v2 manifest JSON; it IS both
      // the validated `v2` view and the `raw` view as far as downstream
      // consumers care (they only touch v2 fields when version is 'v2').
      return {
        version: 'v2',
        v2: cached.manifest,
        raw: cached.manifest as unknown as Record<string, unknown>,
      };
    }
  } catch (err) {
    DEBUG && console.warn(`[tile-loader] manifest-cache read failed for ${entry.id}, falling back to disk:`, err);
  }

  if (!fs.existsSync(manifestPath)) return null;
  return parseManifestFile(manifestPath);
}

/**
 * Load a single feature from a registry entry
 */
function loadSingleFeature(
  entry: FeatureRegistryEntry,
  config: TileLoaderConfig
): FeatureLoadResult {
  // Skip disabled features
  if (entry.disabled) {
    return {
      id: entry.id,
      loaded: false,
      manifestVersion: 'v2',
      error: 'Feature is disabled',
    };
  }

  const manifestPath = path.join(entry.path, 'manifest.json');

  // Cache-first read. feature-startup seeds manifest_cache from the
  // registry at boot (Phase B), so every v2 feature that went through
  // the installer is here. A miss means either a v1 feature (not
  // cached — we don't extract v1 decls) or drift (cache cleared mid-
  // session, disk-only manifest). Fall back to the disk parse so we
  // don't hard-fail in either case.
  const parsed = loadParsedManifest(entry, manifestPath);
  if (!parsed) {
    return {
      id: entry.id,
      loaded: false,
      manifestVersion: 'v2',
      error: `Manifest not available for ${entry.id} (cache miss + disk parse failed)`,
    };
  }

  if (parsed.version === 'v2' && parsed.v2) {
    return loadV2Feature(entry, parsed.v2, config);
  }

  // V1 manifest — delegate to legacy loader
  if (config.onV1Feature) {
    try {
      config.onV1Feature(entry.id, entry.path, parsed.raw as unknown as ExtensionManifest);
      return { id: entry.id, loaded: true, manifestVersion: 'v1' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: entry.id, loaded: false, manifestVersion: 'v1', error: message };
    }
  }

  return {
    id: entry.id,
    loaded: false,
    manifestVersion: 'v1',
    error: 'No v1 handler configured',
  };
}

/**
 * Load a v2 feature via the tile compat layer
 */
function loadV2Feature(
  entry: FeatureRegistryEntry,
  manifest: TileManifestV2,
  config: TileLoaderConfig
): FeatureLoadResult {
  // Skip features that haven't been user-approved (non-builtin)
  if (!entry.userApproved && entry.source.type !== 'builtin') {
    return {
      id: entry.id,
      loaded: false,
      manifestVersion: 'v2',
      error: 'Feature not yet approved by user',
    };
  }

  // Build the annotated extension object that tile-compat expects
  const annotated: AnnotatedExtension = {
    id: entry.id,
    path: entry.path,
    manifestVersion: 'v2',
    v1Manifest: manifest as unknown as ExtensionManifest,
    v2Manifest: manifest,
  };

  const compatConfig: TileCompatConfig = {
    tilePreloadPath: config.tilePreloadPath,
    eagerIds: config.eagerIds,
  };

  try {
    loadV2Tile(annotated, compatConfig);
    return { id: entry.id, loaded: true, manifestVersion: 'v2' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: entry.id, loaded: false, manifestVersion: 'v2', error: message };
  }
}
