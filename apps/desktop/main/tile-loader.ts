/**
 * Tile Loader — Bridges the feature registry to the tile launcher
 *
 * At startup:
 * 1. Load registry
 * 2. Iterate features
 * 3. Load manifests
 * 4. Route to tile launcher
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
  type TileManifest,
  type ParsedManifest,
} from './tile-manifest.js';
import { type AnnotatedTile, loadTile, type TileCompatConfig } from './tile-compat.js';
import * as manifestCache from './manifest-cache.js';
import { DEBUG } from './config.js';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Result of loading a single feature
 */
export interface FeatureLoadResult {
  id: string;
  loaded: boolean;
  error?: string;
  /**
   * True when `loaded: false` means "deliberately not loaded" (disabled,
   * awaiting approval) rather than "tried and failed". Both carry an
   * `error` message for the log, but only a real fault should be shown
   * to the user as one — see collectLoadErrors in feature-list-entries.
   */
  skipped?: boolean;
}

/**
 * Configuration for the tile loader
 */
export interface TileLoaderConfig {
  /** Path to the tile preload script */
  tilePreloadPath: string;
}

// ─── Loader ─────────────────────────────────────────────────────────

/**
 * Load all features from the registry.
 *
 * For each registered feature:
 * - Reads manifest from entry.path/manifest.json
 * - Detects legacy vs current tile manifest
 * - Current: passes to tile launcher with granted capabilities
 * - Legacy: surfaces a clear error (reinstall or update manifest)
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
 * The cache is the authoritative source. Disk fallback covers cache
 * drift (e.g. ephemeral profile whose cache was cleared mid-session
 * between registry seed and feature load).
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
      // The cache stores the full parsed tile manifest JSON; it IS both
      // the validated `manifest` view and the `raw` view as far as downstream
      // consumers care (they only touch manifest fields when version is 'tile').
      return {
        version: 'tile',
        manifest: cached.manifest,
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
      skipped: true,
      error: 'Feature is disabled',
    };
  }

  const manifestPath = path.join(entry.path, 'manifest.json');

  // Cache-first read. feature-startup seeds manifest_cache from the
  // registry at boot, so every feature that went through the installer
  // is here. A miss means cache drift (cleared mid-session, disk-only
  // manifest). Fall back to the disk parse so we don't hard-fail.
  const parsed = loadParsedManifest(entry, manifestPath);
  if (!parsed) {
    return {
      id: entry.id,
      loaded: false,
      error: `Manifest not available for ${entry.id} (cache miss + disk parse failed)`,
    };
  }

  if (parsed.version === 'tile' && parsed.manifest) {
    return loadTileFromEntry(entry, parsed.manifest, config);
  }

  // Legacy (pre-v3 manifestVersion) — rejected by parseManifestFile in
  // practice, but we surface a clear error if one slips through.
  return {
    id: entry.id,
    loaded: false,
    error: `Feature ${entry.id} has a legacy manifest (manifestVersion < 3); reinstall or update the manifest.`,
  };
}

/**
 * Load a tile feature via the tile compat layer
 */
function loadTileFromEntry(
  entry: FeatureRegistryEntry,
  manifest: TileManifest,
  config: TileLoaderConfig
): FeatureLoadResult {
  // Skip features that haven't been user-approved (non-builtin)
  if (!entry.userApproved && entry.source.type !== 'builtin') {
    return {
      id: entry.id,
      loaded: false,
      skipped: true,
      error: 'Feature not yet approved by user',
    };
  }

  // Build the annotated tile object that tile-compat expects
  const annotated: AnnotatedTile = {
    id: entry.id,
    path: entry.path,
    manifest,
  };

  const compatConfig: TileCompatConfig = {
    tilePreloadPath: config.tilePreloadPath,
  };

  try {
    loadTile(annotated, compatConfig);
    return { id: entry.id, loaded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: entry.id, loaded: false, error: message };
  }
}
