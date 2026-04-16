/**
 * Tile Launcher — Creates and manages tile contexts
 *
 * Handles:
 * - Loading and validating tile manifests
 * - Creating BrowserWindows for window tiles (with manifest window hints)
 * - Creating hidden windows for background tiles
 * - Generating capability tokens (opaque string encoding tile ID + granted capabilities)
 * - Passing tokens to tiles via additionalArguments in WebPreferences
 * - Lifecycle: load manifest -> grant capabilities -> create context -> tile calls initialize() -> tile:ready
 */

import type { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';

// Lazy-load BrowserWindow via CommonJS require so this module can be imported
// under ELECTRON_RUN_AS_NODE=1 (where electron's named ESM exports are empty).
// Consumers that never actually launch a window (e.g. unit tests that stub
// the launcher) won't trigger the require.
const requireElectron = createRequire(import.meta.url);
let _BrowserWindow: typeof import('electron').BrowserWindow | null = null;
function getBrowserWindowCtor(): typeof import('electron').BrowserWindow {
  if (_BrowserWindow) return _BrowserWindow;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = requireElectron('electron') as typeof import('electron');
  _BrowserWindow = electron.BrowserWindow;
  return _BrowserWindow;
}

import {
  type TileManifestV2,
  type TileEntry,
  type TileCapabilities,
  type CapabilityGrant,
  resolveCapabilities,
  parseManifestFile,
} from './tile-manifest.js';
import {
  generateToken,
  validateToken,
  revokeToken,
  getGrantForToken,
  revokeTokensForTile,
  clearAllTokens,
} from './tile-tokens.js';
import { scopes, publish, getSystemAddress, unsubscribeAllByPrefix } from './pubsub.js';
import { DEBUG } from './config.js';

// Short grace period given to tiles to run their `api.onShutdown()` callbacks
// before the BrowserWindow is forcibly closed. Kept small so app-quit and
// feature disable/uninstall don't visibly stall. Exported for tests to tune.
export const TILE_SHUTDOWN_GRACE_MS = 500;

// Re-export token functions for consumers
export { generateToken, validateToken, revokeToken, getGrantForToken } from './tile-tokens.js';

/** Tile window registry: tileId:entryId -> BrowserWindow */
const tileWindows = new Map<string, BrowserWindow>();

/** Loaded manifests: tileId -> manifest */
const loadedManifests = new Map<string, TileManifestV2>();

/** Tiles that have signaled ready */
const readyTiles = new Set<string>();

/** Pending ready callbacks: tileId:entryId -> resolve[] */
const readyCallbacks = new Map<string, Array<() => void>>();

// Timeout for tile ready signal (ms)
const TILE_READY_TIMEOUT_MS = 10000;

// ─── Tile Launch ─────────────────────────────────────────────────────

/**
 * Options for launching a tile
 */
export interface TileLaunchOptions {
  /** Path to the tile's directory on disk */
  tilePath: string;
  /** The parsed v2 manifest */
  manifest: TileManifestV2;
  /** Path to the tile preload script */
  preloadPath: string;
  /** Which tile entry to launch (defaults to first) */
  entryId?: string;
  /** Override window hints */
  windowOverrides?: Partial<TileEntry['windowHints']>;
}

/**
 * Result of launching a tile
 */
export interface TileLaunchResult {
  tileId: string;
  entryId: string;
  token: string;
  window: BrowserWindow;
  grant: CapabilityGrant;
}

/**
 * Launch a tile entry
 *
 * Creates the appropriate context (BrowserWindow) with:
 * - sandbox: true
 * - contextIsolation: true
 * - nodeIntegration: false
 * - Capability token passed via additionalArguments
 */
export function launchTile(options: TileLaunchOptions): TileLaunchResult {
  const { tilePath, manifest, preloadPath, entryId, windowOverrides } = options;

  // Find the tile entry
  const entry = entryId
    ? manifest.tiles.find(t => t.id === entryId)
    : manifest.tiles[0];

  if (!entry) {
    throw new Error(`[tile-launcher] Tile entry not found: ${entryId || '(first)'} in ${manifest.id}`);
  }

  // Resolve capabilities
  const grant = resolveCapabilities(
    manifest.id,
    manifest.capabilities,
    manifest.builtin === true
  );

  if (grant.denied.length > 0) {
    DEBUG && console.log(`[tile-launcher] Denied capabilities for ${manifest.id}:`, grant.denied);
  }

  // Generate token
  const token = generateToken(manifest.id, entry.id, grant);

  // Build window options based on tile type and hints
  const hints = { ...entry.windowHints, ...windowOverrides };
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: hints?.width || 800,
    height: hints?.height || 600,
    minWidth: hints?.minWidth,
    minHeight: hints?.minHeight,
    show: entry.type !== 'background',
    frame: hints?.frame !== false,
    transparent: hints?.transparent === true,
    alwaysOnTop: hints?.alwaysOnTop === true,
    focusable: hints?.focusable !== false,
    resizable: hints?.resizable !== false,
    title: hints?.title || manifest.name,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      additionalArguments: [
        `--tile-id=${manifest.id}`,
        `--tile-entry=${entry.id}`,
        `--tile-token=${token}`,
      ],
    },
  };

  // Background tiles are hidden and minimal
  if (entry.type === 'background') {
    windowOptions.width = 0;
    windowOptions.height = 0;
    windowOptions.show = false;
    windowOptions.skipTaskbar = true;
  }

  const BrowserWindow = getBrowserWindowCtor();
  const win = new BrowserWindow(windowOptions);

  // Build the URL for this tile: peek://{tileId}/{url}
  const tileUrl = `peek://${manifest.id}/${entry.url}`;
  win.loadURL(tileUrl);

  // Track the window
  const key = `${manifest.id}:${entry.id}`;
  tileWindows.set(key, win);
  loadedManifests.set(manifest.id, manifest);

  // Forward console messages from the tile's webContents to the main process
  // stdout. Without this, console.log/error/warn inside tile code vanishes
  // silently and there is no way to correlate a log line to a specific tile.
  // Electron 40's console-message event surfaces `event.level` (0..3) and
  // `event.message` (see backend/electron/ipc.ts:2486 for the same pattern).
  win.webContents.on('console-message', (event) => {
    try {
      const level = parseInt(String((event as { level?: unknown }).level), 10);
      const message = String((event as { message?: unknown }).message ?? '');
      const levelLabels = ['verbose', 'info', 'warning', 'error'];
      const levelLabel = levelLabels[level] || 'info';
      // Errors/warnings always forwarded; info/debug only when DEBUG is on.
      if (level >= 2) {
        console.error(`[tile:${manifest.id}:${entry.id}] [${levelLabel}] ${message}`);
      } else if (DEBUG) {
        console.log(`[tile:${manifest.id}:${entry.id}] [${levelLabel}] ${message}`);
      }
    } catch {
      // Logging must never throw.
    }
  });

  // Track render-process crashes — without this, tiles crash silently.
  // On crash: revoke the capability token, drop tracked state, unsubscribe
  // any leftover pubsub registrations, and publish a GLOBAL-scope
  // `tile:crashed` event so UI (e.g. manage/features-manager) can react.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[tile:${manifest.id}:${entry.id}] Render process gone: ${details.reason} (exitCode=${details.exitCode})`
    );
    tileWindows.delete(key);
    readyTiles.delete(key);
    revokeToken(token);
    try {
      // Crashed renderer can't unsubscribe itself — clear every subscription
      // sourced from this tile so the main-process registry doesn't leak.
      unsubscribeAllByPrefix(`peek://${manifest.id}/`);
    } catch (err) {
      console.error(`[tile:${manifest.id}:${entry.id}] Failed to unsubscribe after crash:`, err);
    }
    try {
      // GLOBAL (not SYSTEM) so non-privileged UIs like the manage panel can
      // subscribe to tile:crashed and surface a crashed badge.
      publish(getSystemAddress(), scopes.GLOBAL, 'tile:crashed', {
        tileId: manifest.id,
        entryId: entry.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
    } catch (err) {
      console.error(`[tile:${manifest.id}:${entry.id}] Failed to publish tile:crashed event:`, err);
    }
  });

  // Clean up on close — drop tracked state, revoke token, and unsubscribe
  // any pubsub subscriptions the tile registered (these live in the
  // main-process registry keyed by `peek://{tileId}/{entry}` and won't
  // clean themselves up when the renderer goes away).
  win.on('closed', () => {
    tileWindows.delete(key);
    readyTiles.delete(key);
    revokeToken(token);
    try {
      unsubscribeAllByPrefix(`peek://${manifest.id}/`);
    } catch (err) {
      console.error(`[tile-launcher:${manifest.id}:${entry.id}] Failed to unsubscribe on close:`, err);
    }
    DEBUG && console.log(`[tile-launcher:${manifest.id}:${entry.id}] Tile closed`);
  });

  DEBUG && console.log(`[tile-launcher:${manifest.id}:${entry.id}] Launched -> ${tileUrl}`);

  return { tileId: manifest.id, entryId: entry.id, token, window: win, grant };
}

// ─── Tile Ready Signal ───────────────────────────────────────────────

/**
 * Signal that a tile has finished initialization
 * Called from IPC when tile calls initialize() and completes
 */
export function signalTileReady(tileId: string, entryId: string): void {
  const key = `${tileId}:${entryId}`;
  readyTiles.add(key);

  // Resolve any pending callbacks
  const callbacks = readyCallbacks.get(key);
  if (callbacks) {
    for (const cb of callbacks) {
      cb();
    }
    readyCallbacks.delete(key);
  }

  DEBUG && console.log(`[tile-launcher] Tile ready: ${key}`);
}

/**
 * Wait for a tile to signal ready
 * Returns immediately if already ready
 */
export function waitForTileReady(tileId: string, entryId: string): Promise<void> {
  const key = `${tileId}:${entryId}`;

  if (readyTiles.has(key)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (!readyCallbacks.has(key)) {
      readyCallbacks.set(key, []);
    }
    readyCallbacks.get(key)!.push(resolve);

    // Timeout
    setTimeout(() => {
      const callbacks = readyCallbacks.get(key);
      if (callbacks) {
        const idx = callbacks.indexOf(resolve);
        if (idx >= 0) {
          callbacks.splice(idx, 1);
          reject(new Error(`[tile-launcher] Tile ready timeout: ${key}`));
        }
      }
    }, TILE_READY_TIMEOUT_MS);
  });
}

// ─── Tile Queries ────────────────────────────────────────────────────

/**
 * Get the BrowserWindow for a tile entry
 */
export function getTileWindow(tileId: string, entryId: string): BrowserWindow | null {
  return tileWindows.get(`${tileId}:${entryId}`) || null;
}

/**
 * Check if a tile entry is loaded
 */
export function isTileLoaded(tileId: string, entryId: string): boolean {
  return tileWindows.has(`${tileId}:${entryId}`);
}

/**
 * Check if a tile entry is ready
 */
export function isTileReady(tileId: string, entryId: string): boolean {
  return readyTiles.has(`${tileId}:${entryId}`);
}

/**
 * Get the manifest for a loaded tile
 */
export function getTileManifest(tileId: string): TileManifestV2 | null {
  return loadedManifests.get(tileId) || null;
}

/**
 * Get all loaded tile IDs
 */
export function getLoadedTileIds(): string[] {
  return Array.from(loadedManifests.keys());
}

/**
 * Get all BrowserWindow instances for loaded tiles.
 * Used by the pubsub broadcaster to forward messages to v2 tile windows.
 */
export function getAllTileWindows(): BrowserWindow[] {
  return Array.from(tileWindows.values()).filter(win => !win.isDestroyed());
}

/**
 * Send the `tile:shutdown` IPC to a single tile window, wait a short grace
 * period for its `api.onShutdown()` callbacks to run, and then close the
 * BrowserWindow.
 *
 * Tiles register shutdown callbacks via `api.onShutdown(cb)` in tile-preload.
 * Without this signal the callback never fires, so intervals / timers /
 * subscriptions inside the tile leak.
 *
 * Returns a promise that resolves once `win.close()` has been called. The
 * `closed` event (which does the real tracked-state cleanup) may fire a tick
 * or two later — callers that need to wait for full teardown should listen
 * for it separately.
 */
export async function shutdownTile(tileId: string, entryId: string): Promise<void> {
  const key = `${tileId}:${entryId}`;
  const win = tileWindows.get(key);

  if (!win || win.isDestroyed()) return;

  try {
    // Notify the tile so `api.onShutdown()` callbacks can run.
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('tile:shutdown');
    }
  } catch (err) {
    console.error(`[tile-launcher:${tileId}:${entryId}] Failed to send tile:shutdown:`, err);
  }

  // Give the tile a short grace period to clean up. We intentionally don't
  // wait for an ack — a crashing or unresponsive tile must not block quit.
  await new Promise<void>((resolve) => setTimeout(resolve, TILE_SHUTDOWN_GRACE_MS));

  if (!win.isDestroyed()) {
    win.close();
  }
}

/**
 * Unload a tile — send shutdown signal, close its window, revoke tokens.
 *
 * The `closed` event handler on the window performs the real tracked-state
 * cleanup (tileWindows / readyTiles / token revocation / unsubscribeAllByPrefix).
 * Keep the eager cleanup here too so callers that check isTileLoaded() right
 * after unloadTile() see the tile as unloaded without waiting for the close
 * event to fire.
 */
export async function unloadTile(tileId: string, entryId: string): Promise<void> {
  const key = `${tileId}:${entryId}`;

  await shutdownTile(tileId, entryId);

  tileWindows.delete(key);
  readyTiles.delete(key);
  loadedManifests.delete(tileId);

  // Revoke all tokens for this tile
  revokeTokensForTile(tileId, entryId);

  DEBUG && console.log(`[tile-launcher] Unloaded tile: ${key}`);
}

// ─── Test Hooks ──────────────────────────────────────────────────────
//
// The tile-launcher internal state (tileWindows, readyTiles, loadedManifests)
// is private. Tests can install a fake BrowserWindow for a tile so the
// shutdown / unload path can be exercised without spinning up a real Electron
// window. Not part of the public API — exported with an underscore prefix.

/** @internal */
export function __setTileWindowForTest(
  tileId: string,
  entryId: string,
  win: unknown,
): void {
  const key = `${tileId}:${entryId}`;
  tileWindows.set(key, win as BrowserWindow);
}

/** @internal */
export function __clearTileStateForTest(): void {
  tileWindows.clear();
  readyTiles.clear();
  readyCallbacks.clear();
  loadedManifests.clear();
}

/**
 * Unload all tiles — called during app shutdown.
 *
 * Broadcasts `tile:shutdown` to every tile in parallel, waits the shared grace
 * period once, then closes all windows. This keeps quit latency bounded to
 * TILE_SHUTDOWN_GRACE_MS regardless of how many tiles are active.
 */
export async function unloadAllTiles(): Promise<void> {
  // Phase 1: fan out shutdown signal to every tile.
  for (const [, win] of tileWindows) {
    if (win.isDestroyed()) continue;
    try {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('tile:shutdown');
      }
    } catch (err) {
      console.error('[tile-launcher] Failed to send tile:shutdown during unloadAllTiles:', err);
    }
  }

  // Phase 2: single grace-period wait for all tiles to run their onShutdown.
  await new Promise<void>((resolve) => setTimeout(resolve, TILE_SHUTDOWN_GRACE_MS));

  // Phase 3: close every window.
  for (const [, win] of tileWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  tileWindows.clear();
  readyTiles.clear();
  readyCallbacks.clear();
  loadedManifests.clear();
  clearAllTokens();

  DEBUG && console.log('[tile-launcher] All tiles unloaded');
}
