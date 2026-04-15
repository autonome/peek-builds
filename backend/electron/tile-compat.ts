/**
 * Tile Compatibility Layer
 *
 * Both v1 (legacy extension) and v2 (tile) manifests work side by side.
 * This module handles:
 * - Detecting manifest version during extension discovery
 * - Routing v1 manifests to the legacy extension loader
 * - Routing v2 manifests to the tile launcher
 * - Allowing incremental migration of extensions to tiles
 */

import path from 'node:path';

import { discoverExtensions, type DiscoveredExtension, type ExtensionManifest } from './extensions.js';
import { parseManifestFile, detectManifestVersion, type TileManifestV2, type ParsedManifest } from './tile-manifest.js';
import { launchTile, type TileLaunchResult } from './tile-launcher.js';
import { registerLazyTile } from './tile-lazy.js';
import { registerTileIpcHandlers } from './tile-ipc.js';
import { registerExtensionPath } from './protocol.js';
import { DEBUG } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Discovered extension with manifest version annotation
 */
export interface AnnotatedExtension {
  id: string;
  path: string;
  manifestVersion: 'v1' | 'v2';
  /** Original v1 manifest (always present) */
  v1Manifest: ExtensionManifest;
  /** Parsed v2 manifest (only if manifestVersion is 'v2') */
  v2Manifest?: TileManifestV2;
}

// ─── State ───────────────────────────────────────────────────────────

let ipcHandlersRegistered = false;

// ─── Discovery ───────────────────────────────────────────────────────

/**
 * Discover and annotate all extensions with their manifest version
 *
 * This is the compatibility-aware replacement for discoverExtensions().
 * Returns all extensions with their detected manifest version, allowing
 * the caller to route them to the appropriate loader.
 */
export function discoverAnnotatedExtensions(basePath: string): AnnotatedExtension[] {
  // Use existing discovery to find all extensions
  const extensions = discoverExtensions(basePath);
  const annotated: AnnotatedExtension[] = [];

  for (const ext of extensions) {
    const manifestPath = path.join(ext.path, 'manifest.json');
    const parsed = parseManifestFile(manifestPath);

    if (!parsed) {
      // Failed to parse — treat as v1 (legacy)
      annotated.push({
        id: ext.id,
        path: ext.path,
        manifestVersion: 'v1',
        v1Manifest: ext.manifest,
      });
      continue;
    }

    annotated.push({
      id: ext.id,
      path: ext.path,
      manifestVersion: parsed.version,
      v1Manifest: ext.manifest,
      v2Manifest: parsed.v2,
    });
  }

  DEBUG && console.log(`[tile-compat] Discovered ${annotated.length} extensions: ${annotated.filter(e => e.manifestVersion === 'v2').length} v2, ${annotated.filter(e => e.manifestVersion === 'v1').length} v1`);

  return annotated;
}

// ─── Loading ─────────────────────────────────────────────────────────

/**
 * Configuration for loading extensions through the compatibility layer
 */
export interface TileCompatConfig {
  /** Path to the tile preload script */
  tilePreloadPath: string;
  /** Set of extension IDs that should load eagerly (not lazy) */
  eagerIds?: Set<string>;
}

/**
 * Load a v2 tile extension
 *
 * Registers the tile's path with the protocol handler (for peek://{tileId}/ URLs),
 * then either launches it eagerly or registers it for lazy loading.
 */
export function loadV2Tile(
  ext: AnnotatedExtension,
  config: TileCompatConfig
): TileLaunchResult | null {
  if (!ext.v2Manifest) {
    console.error(`[tile-compat] Cannot load ${ext.id} as v2: no v2 manifest`);
    return null;
  }

  // Ensure IPC handlers are registered (once)
  if (!ipcHandlersRegistered) {
    registerTileIpcHandlers();
    ipcHandlersRegistered = true;
  }

  // Register with protocol handler so peek://{tileId}/ URLs resolve
  registerExtensionPath(ext.id, ext.path);

  const manifest = ext.v2Manifest;
  const isEager = config.eagerIds?.has(ext.id) ?? false;

  // Check if any tile entry is marked as lazy (or if the tile isn't eager)
  const hasLazyEntries = manifest.tiles.some(t => t.lazy === true);
  const hasLazyEvents = manifest.tiles.some(t => Array.isArray(t.lazyEvents) && t.lazyEvents.length > 0);
  const shouldLazyLoad = !isEager && (hasLazyEntries || manifest.tiles.some(t => t.type === 'background'));
  const hasCommands = !!(manifest.commands && manifest.commands.length > 0);

  if (shouldLazyLoad && (hasCommands || hasLazyEvents)) {
    // Lazy load: register command stubs and/or event interceptors.
    // The tile is loaded on first command invocation or first lazy event publish.
    registerLazyTile(manifest, ext.path, config.tilePreloadPath);
    DEBUG && console.log(`[tile-compat] Registered ${ext.id} for lazy loading`);
    return null;
  }

  // Eager load: launch background tile immediately
  const bgTile = manifest.tiles.find(t => t.type === 'background');
  if (bgTile) {
    const result = launchTile({
      tilePath: ext.path,
      manifest,
      preloadPath: config.tilePreloadPath,
      entryId: bgTile.id,
    });
    DEBUG && console.log(`[tile-compat] Eagerly launched ${ext.id}`);
    return result;
  }

  // No background tile — just register the protocol path
  // Window tiles will be launched on demand via commands
  DEBUG && console.log(`[tile-compat] Registered ${ext.id} (no background, commands only)`);
  return null;
}

/**
 * Check if an extension should be loaded via the tile runtime
 */
export function shouldUseTileRuntime(ext: AnnotatedExtension): boolean {
  return ext.manifestVersion === 'v2' && ext.v2Manifest !== undefined;
}
