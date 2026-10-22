/**
 * Feature Registry — Source of truth for all installed features
 *
 * Handles:
 * - Persisting feature entries to registry.json
 * - CRUD operations on feature entries
 * - Filtering by source type
 * - Path resolution for app data directory
 *
 * Design: Electron-independent where possible. Takes paths as params
 * for testability; convenience wrappers use app.getPath() at call sites.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TileCapabilities } from './tile-manifest.js';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Where a feature came from
 */
export interface FeatureSource {
  type: 'builtin' | 'local' | 'atproto' | 'url' | 'dev';
  publisher?: string;       // for atproto: DID; for url: domain
  publisherName?: string;   // human-readable publisher name
  uri?: string;             // source-specific URI
  version?: string;         // version from manifest
}

/**
 * A single entry in the feature registry
 */
export interface FeatureRegistryEntry {
  id: string;                            // feature id (= directory name)
  name: string;                          // human-readable name from manifest
  manifestCid?: string;                  // content hash (null for builtin-dev)
  path: string;                          // absolute path to feature directory
  source: FeatureSource;                 // where it came from
  grantedCapabilities: TileCapabilities; // resolved at install time
  userApproved: boolean;                 // user explicitly approved capabilities
  installedAt: string;                   // ISO datetime
  updatedAt?: string;                    // ISO datetime
  disabled?: boolean;                    // if true, feature is not loaded
  updatePolicy?: 'auto' | 'notify' | 'pinned'; // default: 'auto'
  pinnedVersion?: string;               // only meaningful when updatePolicy is 'pinned'
  lastUpdateCheck?: string;             // ISO datetime of last check
  availableVersion?: string;            // latest version seen, if newer than installed
}

/**
 * Filter options for listing features
 */
export interface FeatureFilter {
  sourceType?: FeatureSource['type'];
}

/**
 * In-memory registry state
 */
interface RegistryData {
  version: 1;
  features: Record<string, FeatureRegistryEntry>;
}

/**
 * Listener for registry mutations. Used by side-effectful subsystems
 * (manifest-cache, drift detectors) that need to react to install /
 * uninstall / disable changes without every caller having to know
 * about them. Subscribers opt in from a single wire-up point
 * (`feature-startup.ts`) so feature-installer and tile-ipc callers
 * stay unchanged.
 */
export interface FeatureRegistryListener {
  onRegister?: (entry: FeatureRegistryEntry) => void;
  onUnregister?: (id: string) => void;
  onDisableChange?: (id: string, disabled: boolean) => void;
}

// ─── Legacy shared-registry migration ───────────────────────────────

/** The profile whose registry is seeded from the old shared file. */
export const LEGACY_REGISTRY_PROFILE = 'default';

/**
 * The registry used to live once in the top-level app data directory,
 * shared by every profile. Seed the production profile's own registry
 * from that file the first time it starts without one, so its installs
 * survive the move. Other profiles start empty.
 *
 * Only non-builtin entries are carried over (builtins are re-registered
 * by syncBuiltinFeatures). An entry installed under the legacy
 * `<legacyDir>/features/` is copied into `<profileDir>/features/` and
 * repointed. The legacy file and directory are never modified.
 *
 * Returns the number of entries seeded; 0 when nothing was migrated.
 */
export function migrateLegacyRegistry(opts: {
  profile: string;
  legacyDir: string;
  profileDir: string;
}): number {
  const { profile, legacyDir, profileDir } = opts;
  if (profile !== LEGACY_REGISTRY_PROFILE) return 0;
  if (path.resolve(legacyDir) === path.resolve(profileDir)) return 0;

  const profileRegistryPath = path.join(profileDir, 'registry.json');
  const legacyRegistryPath = path.join(legacyDir, 'registry.json');
  if (fs.existsSync(profileRegistryPath) || !fs.existsSync(legacyRegistryPath)) return 0;

  try {
    const raw = JSON.parse(fs.readFileSync(legacyRegistryPath, 'utf-8')) as RegistryData;
    if (raw.version !== 1 || typeof raw.features !== 'object' || raw.features === null) return 0;

    const legacyFeaturesDir = path.join(legacyDir, 'features');
    const profileFeaturesDir = path.join(profileDir, 'features');
    const seeded: Record<string, FeatureRegistryEntry> = {};

    for (const [id, entry] of Object.entries(raw.features)) {
      if (entry.source?.type === 'builtin') continue;
      const copy: FeatureRegistryEntry = { ...entry };
      const rel = path.relative(legacyFeaturesDir, entry.path);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        const dest = path.join(profileFeaturesDir, rel);
        if (fs.existsSync(entry.path)) {
          fs.cpSync(entry.path, dest, { recursive: true });
        }
        copy.path = dest;
      }
      seeded[id] = copy;
    }

    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      profileRegistryPath,
      JSON.stringify({ version: 1, features: seeded }, null, 2),
      'utf-8',
    );
    return Object.keys(seeded).length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[feature-registry] Legacy registry migration failed:', message);
    return 0;
  }
}

// ─── Registry Class ─────────────────────────────────────────────────

/**
 * Feature Registry
 *
 * Manages the persistent registry of installed features.
 * Takes a base data directory as constructor param (no Electron dependency).
 */
export class FeatureRegistry {
  private dataDir: string;
  private data: RegistryData;
  private dirty = false;
  private listeners: FeatureRegistryListener[] = [];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.data = { version: 1, features: {} };
  }

  /**
   * Subscribe to registry mutations. Returns an unsubscribe function.
   * Listeners are invoked synchronously after the in-memory mutation;
   * listener exceptions are caught so one broken subscriber can't
   * destabilize the registry.
   */
  addListener(listener: FeatureRegistryListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emitRegister(entry: FeatureRegistryEntry): void {
    for (const l of this.listeners) {
      if (!l.onRegister) continue;
      try { l.onRegister(entry); }
      catch (err) { console.warn('[feature-registry] onRegister listener failed:', err); }
    }
  }

  private emitUnregister(id: string): void {
    for (const l of this.listeners) {
      if (!l.onUnregister) continue;
      try { l.onUnregister(id); }
      catch (err) { console.warn('[feature-registry] onUnregister listener failed:', err); }
    }
  }

  private emitDisableChange(id: string, disabled: boolean): void {
    for (const l of this.listeners) {
      if (!l.onDisableChange) continue;
      try { l.onDisableChange(id, disabled); }
      catch (err) { console.warn('[feature-registry] onDisableChange listener failed:', err); }
    }
  }

  // ─── Path Helpers ───────────────────────────────────────────────

  /** Path to registry.json */
  getRegistryPath(): string {
    return path.join(this.dataDir, 'registry.json');
  }

  /** Path to installed features directory */
  getFeaturesDir(): string {
    return path.join(this.dataDir, 'features');
  }

  // ─── Load / Save ───────────────────────────────────────────────

  /**
   * Load registry from disk. Creates empty registry if file doesn't exist.
   */
  loadRegistry(): void {
    const registryPath = this.getRegistryPath();
    try {
      if (fs.existsSync(registryPath)) {
        const raw = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as RegistryData;
        if (raw.version === 1 && typeof raw.features === 'object') {
          this.data = raw;
        } else {
          console.warn('[feature-registry] Unknown registry format, starting fresh');
          this.data = { version: 1, features: {} };
        }
      } else {
        this.data = { version: 1, features: {} };
      }
      this.dirty = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[feature-registry] Failed to load registry:', message);
      this.data = { version: 1, features: {} };
    }
  }

  /**
   * Save registry to disk. Creates parent directory if needed.
   */
  saveRegistry(): void {
    const registryPath = this.getRegistryPath();
    try {
      const dir = path.dirname(registryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(registryPath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[feature-registry] Failed to save registry:', message);
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────

  /**
   * Get a feature by id. Returns undefined if not found.
   */
  getFeature(id: string): FeatureRegistryEntry | undefined {
    return this.data.features[id];
  }

  /**
   * List all features, optionally filtered by source type.
   */
  listFeatures(filter?: FeatureFilter): FeatureRegistryEntry[] {
    const entries = Object.values(this.data.features);
    if (filter?.sourceType) {
      return entries.filter(e => e.source.type === filter.sourceType);
    }
    return entries;
  }

  /**
   * Register (add or update) a feature entry.
   * If a feature with the same id exists, it is replaced and updatedAt is set.
   */
  registerFeature(entry: FeatureRegistryEntry): void {
    const existing = this.data.features[entry.id];
    if (existing) {
      entry.updatedAt = new Date().toISOString();
      // Preserve original installedAt
      entry.installedAt = existing.installedAt;
    }
    this.data.features[entry.id] = entry;
    this.dirty = true;
    this.emitRegister(entry);
  }

  /**
   * Remove a feature from the registry.
   * Returns true if the feature was found and removed.
   */
  unregisterFeature(id: string): boolean {
    if (this.data.features[id]) {
      delete this.data.features[id];
      this.dirty = true;
      this.emitUnregister(id);
      return true;
    }
    return false;
  }

  /**
   * Disable a feature. Returns true if the feature was found and disabled.
   */
  disableFeature(id: string): boolean {
    const entry = this.data.features[id];
    if (!entry) return false;
    entry.disabled = true;
    this.dirty = true;
    this.emitDisableChange(id, true);
    return true;
  }

  /**
   * Enable a feature. Returns true if the feature was found and enabled.
   */
  enableFeature(id: string): boolean {
    const entry = this.data.features[id];
    if (!entry) return false;
    entry.disabled = false;
    this.dirty = true;
    this.emitDisableChange(id, false);
    return true;
  }

  /**
   * Check if registry has unsaved changes
   */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Get the number of registered features
   */
  get size(): number {
    return Object.keys(this.data.features).length;
  }
}
