/**
 * Feature Startup — Orchestrates feature discovery, sync, and loading
 *
 * Called at app startup to:
 * 1. Load (or create) the feature registry
 * 2. Sync builtin features from the repo features/ directory
 * 3. Load all registered features via the tile loader
 *
 * This module is the single entry point for the feature system.
 * Wire it into main.ts when ready to replace direct extension scanning.
 */

import path from 'node:path';

import { FeatureRegistry } from './feature-registry.js';
import { syncBuiltinFeatures } from './feature-installer.js';
import { loadFeaturesFromRegistry, type TileLoaderConfig, type FeatureLoadResult } from './tile-loader.js';
import { AtprotoSource } from './atproto-source.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface FeatureStartupConfig {
  /** App data directory (e.g., app.getPath('userData')) */
  appDataDir: string;
  /** Path to the repo/app features/ directory for builtins */
  builtinFeaturesDir: string;
  /** Path to the tile preload script */
  tilePreloadPath: string;
  /** Feature IDs that should load eagerly */
  eagerIds?: Set<string>;
  /** Callback for v1 features needing legacy loading */
  onV1Feature?: (id: string, featurePath: string, manifest: unknown) => void;
}

export interface FeatureStartupResult {
  /** Number of builtin features added during sync */
  builtinsAdded: number;
  /** Number of builtin features removed during sync */
  builtinsRemoved: number;
  /** Number of builtin features updated during sync */
  builtinsUpdated: number;
  /** Results of loading each feature */
  loadResults: FeatureLoadResult[];
  /** The registry instance (for later use) */
  registry: FeatureRegistry;
}

// ─── Singleton Registry Access ──────────────────────────────────────

/** Module-level reference to the registry, set during initializeFeatures() */
let _registry: FeatureRegistry | null = null;

/** Module-level AtprotoSource singleton */
let _atprotoSource: AtprotoSource | null = null;

/**
 * Get the feature registry instance (available after initializeFeatures() is called).
 * Returns null if the feature system hasn't been initialized yet.
 */
export function getFeatureRegistry(): FeatureRegistry | null {
  return _registry;
}

/**
 * Get the AtprotoSource singleton (available after initializeFeatures() is called).
 * Returns null if the feature system hasn't been initialized yet.
 */
export function getAtprotoSource(): AtprotoSource | null {
  return _atprotoSource;
}

// ─── Startup ────────────────────────────────────────────────────────

/**
 * Initialize the feature system.
 *
 * 1. Load registry from disk
 * 2. Sync builtins (add new, remove missing, update paths)
 * 3. Load all features via tile loader
 */
export function initializeFeatures(config: FeatureStartupConfig): FeatureStartupResult {
  // 1. Load registry
  const registry = new FeatureRegistry(config.appDataDir);
  registry.loadRegistry();

  // Store singleton references for IPC handlers
  _registry = registry;
  _atprotoSource = new AtprotoSource();

  // 2. Sync builtins
  const sync = syncBuiltinFeatures(config.builtinFeaturesDir, registry);

  console.log(
    `[feature-startup] Builtin sync: ${sync.added.length} added, ` +
    `${sync.removed.length} removed, ${sync.updated.length} updated`
  );

  // 3. Load features
  const loaderConfig: TileLoaderConfig = {
    tilePreloadPath: config.tilePreloadPath,
    eagerIds: config.eagerIds,
    onV1Feature: config.onV1Feature as TileLoaderConfig['onV1Feature'],
  };

  const loadResults = loadFeaturesFromRegistry(registry, loaderConfig);

  const loaded = loadResults.filter(r => r.loaded).length;
  const failed = loadResults.filter(r => !r.loaded).length;
  console.log(`[feature-startup] Loaded ${loaded} features, ${failed} skipped/failed`);

  for (const r of loadResults) {
    if (!r.loaded && r.error) {
      console.warn(`[feature-startup] Failed to load ${r.id}: ${r.error}`);
    }
  }

  return {
    builtinsAdded: sync.added.length,
    builtinsRemoved: sync.removed.length,
    builtinsUpdated: sync.updated.length,
    loadResults,
    registry,
  };
}
