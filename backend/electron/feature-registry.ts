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
  type: 'builtin' | 'local' | 'atproto' | 'url';
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

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.data = { version: 1, features: {} };
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
  }

  /**
   * Remove a feature from the registry.
   * Returns true if the feature was found and removed.
   */
  unregisterFeature(id: string): boolean {
    if (this.data.features[id]) {
      delete this.data.features[id];
      this.dirty = true;
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
