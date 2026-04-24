/**
 * Tile loader bridge — registers `tile:*` IPC handlers and routes a
 * parsed v2 tile manifest to either the eager `launchTile()` path or
 * the lazy registration path in `tile-lazy.ts`.
 */

import { type TileManifestV2 } from './tile-manifest.js';
import { launchTile, type TileLaunchResult } from './tile-launcher.js';
import { registerLazyTile } from './tile-lazy.js';
import { registerTileIpcHandlers } from './tile-ipc.js';
import { registerTilePath } from './protocol.js';
import { DEBUG } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * A tile annotated with its parsed v2 manifest, ready for loading.
 */
export interface AnnotatedTile {
  id: string;
  path: string;
  v2Manifest: TileManifestV2;
}

// ─── State ───────────────────────────────────────────────────────────

let ipcHandlersRegistered = false;

/**
 * Ensure the `tile:*` ipcMain handlers are registered. Idempotent.
 *
 * Historically called lazily from `loadV2Tile()`, so when trustedBuiltin
 * core renderers (cmd, hud, page) launched before any v2 feature tile,
 * the handlers weren't yet registered and every
 * `ipcRenderer.send('tile:pubsub:publish', …)` silently dropped. Core
 * renderers and any other caller that needs tile IPC up front should
 * call this helper directly — typically from `main.ts::initialize()`
 * before any BrowserWindow is created.
 */
export function ensureTileIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  registerTileIpcHandlers();
  ipcHandlersRegistered = true;
}

// ─── Loading ─────────────────────────────────────────────────────────

/**
 * Configuration for loading tiles through the compatibility layer
 */
export interface TileCompatConfig {
  /** Path to the tile preload script */
  tilePreloadPath: string;
  /** Set of tile IDs that should load eagerly (not lazy) */
  eagerIds?: Set<string>;
}

/**
 * Load a v2 tile.
 *
 * Registers the tile's path with the protocol handler (for peek://{tileId}/ URLs),
 * then either launches it eagerly or registers it for lazy loading.
 */
export function loadV2Tile(
  tile: AnnotatedTile,
  config: TileCompatConfig
): TileLaunchResult | null {
  // Ensure IPC handlers are registered (once)
  if (!ipcHandlersRegistered) {
    registerTileIpcHandlers();
    ipcHandlersRegistered = true;
  }

  // Register with protocol handler so peek://{tileId}/ URLs resolve
  registerTilePath(tile.id, tile.path);

  const manifest = tile.v2Manifest;
  const isEager = config.eagerIds?.has(tile.id) ?? false;

  // A tile is resident if any entry declares `resident: true`.
  const residentEntry = manifest.tiles.find(t => t.resident === true);
  const hasLazyEvents = manifest.tiles.some(t => Array.isArray(t.lazyEvents) && t.lazyEvents.length > 0);
  // Non-eager tiles with no resident entry are lazy-loaded on first use.
  const shouldLazyLoad = !isEager && !residentEntry;
  const hasCommands = !!(manifest.commands && manifest.commands.length > 0);

  if (shouldLazyLoad && (hasCommands || hasLazyEvents)) {
    // Lazy load: register command stubs and/or event interceptors.
    // The tile is loaded on first command invocation or first lazy event publish.
    registerLazyTile(manifest, tile.path, config.tilePreloadPath);
    DEBUG && console.log(`[tile-compat] Registered ${tile.id} for lazy loading`);
    return null;
  }

  // Eager load: launch the resident entry immediately
  if (residentEntry) {
    const result = launchTile({
      tilePath: tile.path,
      manifest,
      preloadPath: config.tilePreloadPath,
      entryId: residentEntry.id,
    });
    DEBUG && console.log(`[tile-compat] Eagerly launched ${tile.id} (resident entry: ${residentEntry.id})`);
    return result;
  }

  // No resident entry — just register the protocol path.
  // Tiles will be launched on demand via commands.
  DEBUG && console.log(`[tile-compat] Registered ${tile.id} (no resident entry, commands only)`);
  return null;
}
