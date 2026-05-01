/**
 * Feature Installer — Source-agnostic installation of features
 *
 * Handles:
 * - BuiltinSource: scans repo features/ dir, registers in registry
 * - LocalFileSource: installs from a local directory into app data
 * - Manifest validation before install
 * - Content hashing (SHA-256 of manifest as placeholder for CID)
 * - Conflict detection (duplicate feature IDs)
 *
 * Design: No Electron dependency. Takes paths as params for testability.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  type TileManifest,
  type TileCapabilities,
  validateTileManifest,
  detectManifestVersion,
  resolveCapabilities,
} from './tile-manifest.js';
import {
  FeatureRegistry,
  type FeatureRegistryEntry,
  type FeatureSource,
} from './feature-registry.js';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A bundle of files that make up a feature
 */
export interface TileBundle {
  manifest: TileManifest;
  files: Map<string, Buffer>;  // relative path -> file contents
}

/**
 * Metadata about a feature's source
 */
export interface FeatureSourceMetadata {
  source: FeatureSource;
  manifest: TileManifest;
}

/**
 * Result of an install operation
 */
export interface InstallResult {
  success: boolean;
  entry?: FeatureRegistryEntry;
  error?: string;
  /** Capabilities that need user approval (non-builtin only) */
  pendingApproval?: string[];
}

/**
 * A source that can provide features
 */
export interface TileSource {
  type: string;
  fetch(uri: string): Promise<TileBundle>;
  resolve(uri: string): Promise<FeatureSourceMetadata>;
}

// ─── Content Hashing ────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of the manifest JSON as a placeholder for CID.
 * Full DASL CID support comes later with the builder.
 */
export function computeManifestHash(manifestJson: string): string {
  return crypto.createHash('sha256').update(manifestJson, 'utf-8').digest('hex');
}

// ─── Builtin Source ─────────────────────────────────────────────────

/**
 * Scan a features directory for builtin features and register them.
 *
 * For each subdirectory with a valid tile manifest.json:
 * - Registers in the registry with source type 'builtin'
 * - Path points directly at the repo directory (no copy)
 * - manifestCid is null (dev mode)
 * - userApproved = true (builtins are pre-approved)
 *
 * Returns list of feature IDs that were registered.
 */
export function scanBuiltinFeatures(
  featuresDir: string,
  registry: FeatureRegistry
): string[] {
  const registered: string[] = [];

  if (!fs.existsSync(featuresDir)) {
    return registered;
  }

  const entries = fs.readdirSync(featuresDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const featurePath = path.join(featuresDir, entry.name);
    const manifestPath = path.join(featurePath, 'manifest.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifestJson = fs.readFileSync(manifestPath, 'utf-8');
      const raw = JSON.parse(manifestJson) as Record<string, unknown>;

      // Only process tile manifests
      const version = detectManifestVersion(raw);
      if (version !== 'tile') continue;

      // Validate
      const errors = validateTileManifest(raw);
      if (errors.length > 0) {
        console.error(`[feature-installer] Invalid manifest in ${entry.name}:`);
        for (const err of errors) {
          console.error(`  ${err.path}: ${err.message}`);
        }
        continue;
      }

      const manifest = raw as unknown as TileManifest;
      const id = manifest.id;

      // Resolve capabilities (builtin = true, all granted)
      const grant = resolveCapabilities(id, manifest.capabilities, true);

      const registryEntry: FeatureRegistryEntry = {
        id,
        name: manifest.name,
        path: featurePath,
        source: {
          type: 'builtin',
          version: manifest.version,
        },
        grantedCapabilities: grant.capabilities,
        userApproved: true,
        installedAt: new Date().toISOString(),
      };

      registry.registerFeature(registryEntry);
      registered.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[feature-installer] Failed to scan ${entry.name}:`, message);
    }
  }

  return registered;
}

// ─── Local File Source ──────────────────────────────────────────────

/**
 * Install a feature from a local directory.
 *
 * Reads the manifest, validates it, copies files to the app data features dir,
 * and registers in the registry.
 *
 * @param sourceDir - Path to the source directory containing manifest.json
 * @param registry - Feature registry instance
 * @param options - Install options
 */
export function installFromLocalDirectory(
  sourceDir: string,
  registry: FeatureRegistry,
  options?: { force?: boolean }
): InstallResult {
  // Read manifest
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { success: false, error: 'No manifest.json found in source directory' };
  }

  let manifestJson: string;
  let raw: Record<string, unknown>;
  try {
    manifestJson = fs.readFileSync(manifestPath, 'utf-8');
    raw = JSON.parse(manifestJson) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to read manifest: ${message}` };
  }

  // Must be a valid tile manifest
  const version = detectManifestVersion(raw);
  if (version !== 'tile') {
    return { success: false, error: 'Only tile manifests (manifestVersion: 3) are supported for local installation' };
  }

  // Validate
  const errors = validateTileManifest(raw);
  if (errors.length > 0) {
    const msgs = errors.map(e => `${e.path}: ${e.message}`).join('; ');
    return { success: false, error: `Invalid manifest: ${msgs}` };
  }

  const manifest = raw as unknown as TileManifest;
  const id = manifest.id;

  // Check for conflicts
  const existing = registry.getFeature(id);
  if (existing && !options?.force) {
    return {
      success: false,
      error: `Feature "${id}" is already installed (source: ${existing.source.type}). Use force to overwrite.`,
    };
  }

  // Compute content hash
  const manifestCid = computeManifestHash(manifestJson);

  // Copy files to features dir
  const targetDir = path.join(registry.getFeaturesDir(), id);
  try {
    copyDirectoryRecursive(sourceDir, targetDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to copy files: ${message}` };
  }

  // Resolve capabilities (non-builtin)
  const grant = resolveCapabilities(id, manifest.capabilities, false);
  const pendingApproval = grant.denied.length > 0 ? grant.denied : undefined;

  // Register
  const entry: FeatureRegistryEntry = {
    id,
    name: manifest.name,
    manifestCid,
    path: targetDir,
    source: {
      type: 'local',
      version: manifest.version,
    },
    grantedCapabilities: grant.capabilities,
    userApproved: false,  // local installs need user approval
    installedAt: new Date().toISOString(),
  };

  registry.registerFeature(entry);

  return { success: true, entry, pendingApproval };
}

// ─── Bundle Installation ────────────────────────────────────────────

/**
 * Install a feature from a TileBundle (source-agnostic).
 *
 * Takes a pre-fetched bundle of files + source metadata, writes them
 * to the target directory, resolves capabilities, and registers in the registry.
 *
 * Used by both installFromLocalDirectory() and the AtprotoSource install path.
 */
export function installFromBundle(
  bundle: TileBundle,
  source: FeatureSource,
  registry: FeatureRegistry,
  options?: { force?: boolean; userApproved?: boolean }
): InstallResult {
  const manifest = bundle.manifest;
  const id = manifest.id;

  // Check for conflicts
  const existing = registry.getFeature(id);
  if (existing && !options?.force) {
    return {
      success: false,
      error: `Feature "${id}" is already installed (source: ${existing.source.type}). Use force to overwrite.`,
    };
  }

  // Compute content hash from manifest
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestCid = computeManifestHash(manifestJson);

  // Atomic install:
  //   1. Write all files to a sibling temp directory (`.tmp-<id>-<random>`).
  //   2. If anything fails, blow away the temp dir — target is untouched.
  //   3. Remove any existing target (force reinstall), then rename temp -> target.
  //
  // This avoids leaving a half-written feature directory behind if a write
  // fails partway through, which is especially important for network-sourced
  // installs (atproto) where a blob download could blow up mid-way.
  const featuresDir = registry.getFeaturesDir();
  const targetDir = path.join(featuresDir, id);
  const tempSuffix = crypto.randomBytes(6).toString('hex');
  const tempDir = path.join(featuresDir, `.tmp-${id}-${tempSuffix}`);

  try {
    if (!fs.existsSync(featuresDir)) {
      fs.mkdirSync(featuresDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    for (const [filePath, content] of bundle.files) {
      const fullPath = path.join(tempDir, filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content);
    }

    // All files written successfully — swap temp into place.
    // If target already exists (force reinstall), remove it first.
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(tempDir, targetDir);
  } catch (err) {
    // Any failure: clean up the temp dir so we don't leak partial writes
    // in the features directory. Target is guaranteed untouched because
    // we haven't renamed yet (or the rename itself failed, in which case
    // targetDir may or may not exist — we leave it alone either way).
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup; don't mask the original error.
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to write files: ${message}` };
  }

  // Resolve capabilities (non-builtin)
  const isBuiltin = source.type === 'builtin';
  const grant = resolveCapabilities(id, manifest.capabilities, isBuiltin);
  const pendingApproval = grant.denied.length > 0 ? grant.denied : undefined;

  // Register
  const entry: FeatureRegistryEntry = {
    id,
    name: manifest.name,
    manifestCid,
    path: targetDir,
    source,
    grantedCapabilities: grant.capabilities,
    userApproved: options?.userApproved ?? false,
    installedAt: new Date().toISOString(),
  };

  registry.registerFeature(entry);

  return { success: true, entry, pendingApproval };
}

// ─── Builtin Sync ───────────────────────────────────────────────────

/**
 * Synchronize builtin features with the registry at app startup.
 *
 * 1. Scan features/ directory for tile manifests
 * 2. Register new builtins, update paths for existing ones
 * 3. Remove registry entries for builtins no longer on disk
 * 4. Save registry
 */
export function syncBuiltinFeatures(
  featuresDir: string,
  registry: FeatureRegistry
): { added: string[]; removed: string[]; updated: string[] } {
  const result = { added: [] as string[], removed: [] as string[], updated: [] as string[] };

  // Scan disk for current builtins
  const onDiskIds = new Set<string>();
  if (fs.existsSync(featuresDir)) {
    const entries = fs.readdirSync(featuresDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(featuresDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
        if (detectManifestVersion(raw) !== 'tile') continue;
        const errors = validateTileManifest(raw);
        if (errors.length > 0) continue;

        const manifest = raw as unknown as TileManifest;
        onDiskIds.add(manifest.id);

        const existing = registry.getFeature(manifest.id);
        if (!existing) {
          // New builtin
          const grant = resolveCapabilities(manifest.id, manifest.capabilities, true);
          registry.registerFeature({
            id: manifest.id,
            name: manifest.name,
            path: path.join(featuresDir, entry.name),
            source: { type: 'builtin', version: manifest.version },
            grantedCapabilities: grant.capabilities,
            userApproved: true,
            installedAt: new Date().toISOString(),
          });
          result.added.push(manifest.id);
        } else if (existing.source.type === 'builtin') {
          // Existing builtin — update path if changed
          const newPath = path.join(featuresDir, entry.name);
          if (existing.path !== newPath || existing.name !== manifest.name) {
            const grant = resolveCapabilities(manifest.id, manifest.capabilities, true);
            registry.registerFeature({
              ...existing,
              name: manifest.name,
              path: newPath,
              source: { ...existing.source, version: manifest.version },
              grantedCapabilities: grant.capabilities,
            });
            result.updated.push(manifest.id);
          }
        }
        // If existing but not builtin source type, don't touch it
      } catch {
        // Skip unparseable manifests
      }
    }
  }

  // Remove builtins no longer on disk
  const builtinEntries = registry.listFeatures({ sourceType: 'builtin' });
  for (const entry of builtinEntries) {
    if (!onDiskIds.has(entry.id)) {
      registry.unregisterFeature(entry.id);
      result.removed.push(entry.id);
    }
  }

  // Save if anything changed
  if (result.added.length > 0 || result.removed.length > 0 || result.updated.length > 0) {
    registry.saveRegistry();
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Recursively copy a directory
 */
function copyDirectoryRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
