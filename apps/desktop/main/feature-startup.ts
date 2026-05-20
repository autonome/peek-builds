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

import { FeatureRegistry, type FeatureRegistryEntry } from './feature-registry.js';
import { syncBuiltinFeatures } from './feature-installer.js';
import { loadFeaturesFromRegistry, type TileLoaderConfig, type FeatureLoadResult } from './tile-loader.js';
import { AtprotoSource } from './atproto-source.js';
import * as manifestCache from './manifest-cache.js';
import * as tileLifecycle from './tile-lifecycle.js';
import { isEphemeralProfile } from './config.js';
import { getDb } from './datastore.js';
import { syncManifestRules, deleteRulesByFeature, type RulesDb, type ManifestRule } from './rules.js';
import type { TileRule } from './tile-manifest.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface FeatureStartupConfig {
  /** App data directory (e.g., app.getPath('userData')) */
  appDataDir: string;
  /** Path to the repo/app features/ directory for builtins */
  builtinFeaturesDir: string;
  /** Path to the tile preload script */
  tilePreloadPath: string;
  /** Current Peek app version (for minPeekVersion checks on installs) */
  peekVersion?: string;
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

// ─── manifest-cache bridge ──────────────────────────────────────────

/**
 * Upsert a registry entry's manifest into the cache. Reads the
 * manifest from `<entry.path>/manifest.json`. Swallows parse / write
 * errors with a warning — a feature with an unreadable manifest
 * shouldn't bring down startup or every subsequent registry mutation.
 */
function upsertManifestCacheForEntry(entry: FeatureRegistryEntry): void {
  try {
    const manifestPath = path.join(entry.path, 'manifest.json');
    manifestCache.upsertFromManifest(entry.id, manifestPath);
  } catch (err) {
    console.warn(`[feature-startup] manifest-cache upsert failed for ${entry.id}:`, err);
  }
}

// ─── rules bridge ───────────────────────────────────────────────────

/**
 * Reconcile the `rules` table with the feature's manifest.rules
 * declaration. Called from the registry listener so that an install /
 * update / re-register all converge to the same desired state without
 * each caller having to know about the rules table.
 *
 * Errors are swallowed with a warning — a feature whose rules fail to
 * sync should not block its tile lifecycle, and the next reconcile
 * (next boot or next install) will heal any drift.
 */
function reconcileRulesForEntry(entry: FeatureRegistryEntry): void {
  try {
    const row = manifestCache.get(entry.id);
    const declared = (row?.manifest?.rules as TileRule[] | undefined) ?? [];
    const manifestRules: ManifestRule[] = declared.map(r => ({
      topic: r.topic,
      scriptId: r.scriptId,
      match: r.match,
      config: r.config,
      display: r.display ?? null,
      enabled: r.enabled,
      ordering: r.ordering,
    }));
    const db = getDb() as unknown as RulesDb;
    syncManifestRules(db, entry.id, manifestRules, Date.now());
  } catch (err) {
    console.warn(`[feature-startup] rules reconcile failed for ${entry.id}:`, err);
  }
}

function dropManifestRulesForFeature(id: string): void {
  try {
    const db = getDb() as unknown as RulesDb;
    deleteRulesByFeature(db, id);
  } catch (err) {
    console.warn(`[feature-startup] rules cleanup failed for ${id}:`, err);
  }
}

// ─── tile-lifecycle bridge ──────────────────────────────────────────

/**
 * Drive the tile-lifecycle FSM for every entry declared by a feature.
 * Each entry gets its own transition — the FSM is per-entry (a feature
 * with a background + a window entry has two independent lifecycles).
 * Called from the registry listener on install and from the seed pass
 * at boot so the FSM state map matches on-disk reality.
 *
 * `trigger` should be whatever the caller intends — `INSTALL` when a
 * feature arrives, a cleanup trigger on uninstall. If a transition is
 * invalid from the current state (e.g. INSTALL when the entry is
 * already REGISTERED), the call is a silent no-op; the FSM rejects it.
 */
function fireFsmTriggerForFeature(entry: FeatureRegistryEntry, trigger: string): void {
  const row = manifestCache.get(entry.id);
  if (!row || !row.manifest || !Array.isArray(row.manifest.tiles)) return;
  for (const tileEntry of row.manifest.tiles) {
    try {
      tileLifecycle.transition(entry.id, tileEntry.id, trigger, { source: 'feature-startup' });
    } catch (err) {
      console.warn(`[feature-startup] FSM ${trigger} failed for ${entry.id}:${tileEntry.id}:`, err);
    }
  }
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
  _atprotoSource = new AtprotoSource({ peekVersion: config.peekVersion });

  // Wire manifest-cache to registry mutations. Every subsequent
  // registerFeature / unregisterFeature / (dis|en)ableFeature call —
  // from syncBuiltinFeatures below, from tile-ipc install handlers,
  // from the Features pane — keeps the cache in step without each
  // caller having to know the cache exists.
  registry.addListener({
    onRegister: (entry) => {
      // Cache must land first — the FSM transition reads the cached
      // manifest to enumerate tile entries.
      upsertManifestCacheForEntry(entry);
      fireFsmTriggerForFeature(entry, tileLifecycle.TRIGGERS.INSTALL);
      reconcileRulesForEntry(entry);
    },
    onUnregister: (id) => {
      // Transition first while the cache row still exists (the FSM
      // callback enumerates tile entries from it), then remove.
      const cached = manifestCache.get(id);
      if (cached && cached.manifest && Array.isArray(cached.manifest.tiles)) {
        for (const tileEntry of cached.manifest.tiles) {
          try {
            tileLifecycle.transition(id, tileEntry.id, tileLifecycle.TRIGGERS.UNINSTALL,
              { source: 'feature-startup' });
          } catch (err) {
            console.warn(`[feature-startup] FSM UNINSTALL failed for ${id}:${tileEntry.id}:`, err);
          }
        }
      }
      try { manifestCache.remove(id); }
      catch (err) { console.warn(`[feature-startup] manifest-cache remove failed for ${id}:`, err); }
      dropManifestRulesForFeature(id);
    },
    onDisableChange: (id, disabled) => {
      try { manifestCache.setDisabled(id, disabled); }
      catch (err) { console.warn(`[feature-startup] manifest-cache setDisabled failed for ${id}:`, err); }
    },
  });

  // Ephemeral profiles (dev, test-*, tmp-*) start with an empty cache
  // each boot — the on-disk copy is throwaway and the subsequent
  // loadRegistry + sync will repopulate it from the current state of
  // the features dir. Production profiles preserve the cache across
  // boots; upserts below are idempotent so any drift heals itself.
  if (isEphemeralProfile()) {
    try {
      manifestCache.clearAll();
    } catch (err) {
      console.warn('[feature-startup] manifest-cache clearAll failed:', err);
    }
  }

  // Seed the cache from the just-loaded registry. loadRegistry() sets
  // the in-memory map directly (no registerFeature calls), so its
  // entries never fired the onRegister listener — we have to walk them
  // manually. Runs before sync so the sync's own registerFeature calls
  // (for updated paths / removed builtins) simply refresh on top.
  // Also drives the tile-lifecycle FSM to the initial REGISTERED state
  // so dispatch-drift checks see a correct baseline.
  for (const entry of registry.listFeatures()) {
    upsertManifestCacheForEntry(entry);
    if (entry.disabled) {
      try { manifestCache.setDisabled(entry.id, true); }
      catch {
        // Already warned by the upsert path if anything went wrong.
      }
    }
    fireFsmTriggerForFeature(entry, tileLifecycle.TRIGGERS.INSTALL);
    reconcileRulesForEntry(entry);
  }

  // 2. Sync builtins
  const sync = syncBuiltinFeatures(config.builtinFeaturesDir, registry);

  console.log(
    `[feature-startup] Builtin sync: ${sync.added.length} added, ` +
    `${sync.removed.length} removed, ${sync.updated.length} updated`
  );

  // 3. Load features
  const loaderConfig: TileLoaderConfig = {
    tilePreloadPath: config.tilePreloadPath,
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
