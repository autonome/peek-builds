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
import { DEBUG } from './config.js';

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

  // Clean up on close
  win.on('closed', () => {
    tileWindows.delete(key);
    readyTiles.delete(key);
    revokeToken(token);
    DEBUG && console.log(`[tile-launcher] Tile closed: ${key}`);
  });

  DEBUG && console.log(`[tile-launcher] Launched tile: ${key} -> ${tileUrl}`);

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
 * Unload a tile — close its window and revoke tokens
 */
export function unloadTile(tileId: string, entryId: string): void {
  const key = `${tileId}:${entryId}`;
  const win = tileWindows.get(key);

  if (win && !win.isDestroyed()) {
    win.close();
  }

  tileWindows.delete(key);
  readyTiles.delete(key);
  loadedManifests.delete(tileId);

  // Revoke all tokens for this tile
  revokeTokensForTile(tileId, entryId);

  DEBUG && console.log(`[tile-launcher] Unloaded tile: ${key}`);
}

/**
 * Unload all tiles — called during app shutdown
 */
export function unloadAllTiles(): void {
  for (const [key, win] of tileWindows) {
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
