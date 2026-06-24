/**
 * Tile loader bridge — registers `tile:*` IPC handlers and routes a
 * parsed tile manifest to either the eager `launchTile()` path or
 * the lazy registration path in `tile-lazy.ts`.
 */

import { type TileLaunchResult } from './tile-launcher.js';
import { loadOrArmFeatureTile, type AnnotatedTile, type TileCompatConfig } from './tile-arm.js';
import { registerTileIpcHandlers } from './tile-ipc.js';

// Re-export the shared arm/disarm surface + types so existing importers
// (tile-loader, tests) keep their `./tile-compat.js` entry point while the
// implementation lives in the electron-safe `tile-arm` module.
export { armLazyTile, disarmLazyTile, isLazyTileManifest, loadOrArmFeatureTile } from './tile-arm.js';
export type { AnnotatedTile, TileCompatConfig } from './tile-arm.js';

// ─── State ───────────────────────────────────────────────────────────

let ipcHandlersRegistered = false;

/**
 * Ensure the `tile:*` ipcMain handlers are registered. Idempotent.
 *
 * Historically called lazily from `loadTile()`, so when trustedBuiltin
 * core renderers (cmd, hud, page) launched before any feature tile,
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
 * Load a tile: ensure the `tile:*` IPC handlers are up, then hand off to the
 * shared `loadOrArmFeatureTile` (register protocol path + arm-lazy-or-launch-
 * resident) — the same path the live `tile:features:enable` handler uses.
 */
export function loadTile(
  tile: AnnotatedTile,
  config: TileCompatConfig
): TileLaunchResult | null {
  // Ensure IPC handlers are registered (once). This is the boot-init concern
  // that stays here; everything else is the shared load/arm decision.
  if (!ipcHandlersRegistered) {
    registerTileIpcHandlers();
    ipcHandlersRegistered = true;
  }

  return loadOrArmFeatureTile(tile, config);
}
