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
import { scopes, publish, getSystemAddress, unsubscribeAll } from './pubsub.js';
import { DEBUG, getTilePreloadPath } from './config.js';
import { loadSchemaDefaults } from './tile-settings-defaults.js';
import { getExtensionPath } from './protocol.js';
import * as tileLifecycle from './tile-lifecycle.js';

// Config hooks for values sourced from electron-heavy modules
// (session-partition, windows) that we can't safely import at top
// level in this file: both transitively `import { BrowserWindow }`
// from 'electron' as ESM, which breaks under ELECTRON_RUN_AS_NODE=1
// where electron's named ESM exports are empty. Unit tests load
// tile-launcher.js under that mode and would crash at module parse
// time. We inject the getters at app startup instead — same pattern
// as `setExtensionBroadcaster` in pubsub.ts. Tests that stub the
// launcher never call createTileBrowserWindow, so the hooks stay
// null and the baseline helpers fall back cleanly.
let _getProfileSession: (() => Electron.Session) | null = null;
let _getSystemThemeBackgroundColor: (() => string) | null = null;

/**
 * Wire tile-launcher up to its electron-side dependencies. Called once
 * at app startup, before any `launchTile` / `createTileBrowserWindow`
 * call. Passing either as undefined keeps that dependency unused (unit
 * tests do this implicitly by never calling this function).
 */
export function configureTileLauncher(hooks: {
  getProfileSession?: () => Electron.Session;
  getSystemThemeBackgroundColor?: () => string;
}): void {
  if (hooks.getProfileSession) _getProfileSession = hooks.getProfileSession;
  if (hooks.getSystemThemeBackgroundColor) _getSystemThemeBackgroundColor = hooks.getSystemThemeBackgroundColor;
}

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
 * Spec for `createTileBrowserWindow` — the canonical BrowserWindow
 * constructor for every tile window in the app.
 */
export interface CreateTileBrowserWindowSpec {
  tileId: string;
  entryId: string;
  token: string;
  preloadPath: string;
  /**
   * Optional manifest + entry used as the source of declared window hints
   * (width/height/frame/transparent/etc). Launchers derive hints from the
   * manifest; callers that have no manifest (e.g. trustedBuiltin callers
   * doing post-hoc registration) can omit this.
   */
  manifest?: TileManifestV2;
  entry?: TileEntry;
  /**
   * Extra BrowserWindow options applied after manifest hints. Used by the
   * `window-open` IPC branch to thread through caller-provided position,
   * modal, skipTaskbar, etc. Takes precedence over manifest hints.
   */
  browserWindowOverrides?: Partial<Electron.BrowserWindowConstructorOptions>;
  /**
   * Extra webPreferences options merged into the canonical tile
   * webPreferences (preload + additionalArguments + sandbox + session).
   */
  webPreferencesOverrides?: Partial<Electron.WebPreferences>;
  /**
   * When true, the render-process-gone handler publishes a `tile:crashed`
   * event on the pubsub bus so UIs can react. Regular feature tiles want
   * this on; one-off trustedBuiltin helpers (cmd panel popup, settings
   * window) can opt out to avoid flooding the bus on dev reload crashes.
   * Default: true when `manifest` is provided, false otherwise.
   */
  publishCrashEvent?: boolean;
}

/**
 * createTileBrowserWindow — the ONE function that creates tile
 * BrowserWindows. All tile-window lifecycles go through here so:
 *
 *   - Baseline chrome defaults (autoHideMenuBar, session, backgroundColor)
 *     can't drift between callers.
 *   - The tile registry, console forwarding, crash handler, and
 *     per-entry pubsub cleanup are wired identically every time.
 *
 * Merge order (later wins):
 *   baseline defaults ◁ manifest-entry windowHints ◁ caller overrides
 *
 * Returns the BrowserWindow. Caller is responsible for `loadURL` (the
 * URL is not part of this helper so the window-open IPC branch can do
 * its own URL rewrites / redirects).
 */
export function createTileBrowserWindow(spec: CreateTileBrowserWindowSpec): BrowserWindow {
  const {
    tileId, entryId, token, preloadPath, manifest, entry,
    browserWindowOverrides, webPreferencesOverrides,
  } = spec;
  const publishCrashEvent = spec.publishCrashEvent ?? (manifest !== undefined);

  // FSM: REGISTERED → LOADING. The transition is best-effort — for
  // trustedBuiltin callers that never ran through the feature
  // registry (hud-glue, cmd-glue, etc.) the entry starts in
  // UNREGISTERED and this call is rejected. That's fine; the FSM is
  // only authoritative for v2 feature tiles today, and a silent
  // rejection on trustedBuiltin entries doesn't harm drift detection.
  tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.LOAD,
    { source: 'createTileBrowserWindow' });

  // Hints from the manifest entry (windowHints + flat fields on the
  // entry itself, which we treat as shorthand for the same thing).
  let hints: Partial<TileEntry['windowHints']> & Partial<TileEntry> = {};
  if (entry) {
    const { width, height, minWidth, minHeight, alwaysOnTop, transparent,
            focusable, frame, resizable, role, key: entryKey, title } = entry;
    const entryFlat = { width, height, minWidth, minHeight, alwaysOnTop, transparent,
                        focusable, frame, resizable, role, key: entryKey, title };
    hints = { ...entry.windowHints, ...entryFlat };
  }

  const transparentResolved = browserWindowOverrides?.transparent ?? hints?.transparent === true;

  // Canonical baseline options. Every tile window inherits these unless
  // manifest hints or caller overrides explicitly change them.
  const baseline: Electron.BrowserWindowConstructorOptions = {
    // All tiles start hidden. Visibility is a runtime choice
    // (showSelf / window-open show flag / session restore).
    show: false,
    // No OS menubar anywhere, ever. Silent divergence between launchTile
    // (which never set this) and window-open (which sometimes inherited
    // it from callers) was the Phase D trigger — nothing opts in now.
    autoHideMenuBar: true,
    // System-theme background prevents a white flash on dark mode. Skip
    // for transparent tiles — setting backgroundColor defeats transparency.
    backgroundColor: transparentResolved ? undefined : _getSystemThemeBackgroundColor?.(),
  };

  // Merge order: baseline ◁ hints ◁ overrides. The hints object is
  // spread into individual BrowserWindow fields so we can apply the
  // `hints.frame !== false` style defaults without the spread clobbering
  // them with undefined.
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    ...baseline,
    width: hints?.width || 800,
    height: hints?.height || 600,
    minWidth: hints?.minWidth,
    minHeight: hints?.minHeight,
    frame: hints?.frame !== false,
    transparent: transparentResolved,
    alwaysOnTop: hints?.alwaysOnTop === true,
    focusable: hints?.focusable !== false,
    resizable: hints?.resizable !== false,
    title: hints?.title || manifest?.name,
    ...browserWindowOverrides,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: _getProfileSession?.(),
      preload: preloadPath,
      additionalArguments: [
        `--tile-id=${tileId}`,
        `--tile-entry=${entryId}`,
        `--tile-token=${token}`,
      ],
      ...webPreferencesOverrides,
    },
  };

  const BrowserWindow = getBrowserWindowCtor();
  const win = new BrowserWindow(windowOptions);

  const key = `${tileId}:${entryId}`;
  tileWindows.set(key, win);
  if (manifest) loadedManifests.set(tileId, manifest);

  // Forward console messages from the tile's webContents to main-process
  // stdout. Errors/warnings always forwarded; info/debug only under DEBUG.
  win.webContents.on('console-message', (event) => {
    try {
      const level = parseInt(String((event as { level?: unknown }).level), 10);
      const message = String((event as { message?: unknown }).message ?? '');
      const levelLabels = ['verbose', 'info', 'warning', 'error'];
      const levelLabel = levelLabels[level] || 'info';
      if (level >= 2) {
        console.error(`[tile:${tileId}:${entryId}] [${levelLabel}] ${message}`);
      } else if (DEBUG) {
        console.log(`[tile:${tileId}:${entryId}] [${levelLabel}] ${message}`);
      }
    } catch {
      // Logging must never throw.
    }
  });

  // Render-process crashes: revoke token, drop tracked state, unsubscribe
  // this entry's subs only (sibling entries stay subscribed), and
  // optionally publish a `tile:crashed` event.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[tile:${tileId}:${entryId}] Render process gone: ${details.reason} (exitCode=${details.exitCode})`
    );
    tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.RENDER_GONE,
      { reason: details.reason, exitCode: details.exitCode });
    tileWindows.delete(key);
    readyTiles.delete(key);
    revokeToken(token);
    try {
      unsubscribeAll(`peek://${tileId}/${entryId}`);
    } catch (err) {
      console.error(`[tile:${tileId}:${entryId}] Failed to unsubscribe after crash:`, err);
    }
    if (publishCrashEvent) {
      try {
        publish(getSystemAddress(), scopes.GLOBAL, 'tile:crashed', {
          tileId, entryId,
          reason: details.reason,
          exitCode: details.exitCode,
        });
      } catch (err) {
        console.error(`[tile:${tileId}:${entryId}] Failed to publish tile:crashed event:`, err);
      }
    }
  });

  // Normal close: same cleanup as crash, minus the crash broadcast.
  //
  // FSM: drive the entry back toward `registered`. From a ready/visible/
  // loading state the correct sequence is SHUTDOWN → UNLOADING →
  // CLEANUP_KEEP → REGISTERED. Each step is best-effort; if it's already
  // UNREGISTERED (trustedBuiltin callers, uninstall races), the FSM
  // silently rejects and we continue with the resource cleanup below.
  win.on('closed', () => {
    const curState = tileLifecycle.getState(tileId, entryId);
    if (curState !== tileLifecycle.STATES.UNREGISTERED && curState !== tileLifecycle.STATES.CRASHED) {
      tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.SHUTDOWN, { source: 'window-closed' });
      tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.CLEANUP_KEEP, { source: 'window-closed' });
    }
    tileWindows.delete(key);
    readyTiles.delete(key);
    revokeToken(token);
    try {
      unsubscribeAll(`peek://${tileId}/${entryId}`);
    } catch (err) {
      console.error(`[tile-launcher:${tileId}:${entryId}] Failed to unsubscribe on close:`, err);
    }
    DEBUG && console.log(`[tile-launcher:${tileId}:${entryId}] Tile closed`);
  });

  return win;
}

/**
 * Launch a tile entry
 *
 * Thin wrapper over `createTileBrowserWindow` that:
 *  - Resolves which tile entry to launch from the manifest
 *  - Resolves and grants capabilities
 *  - Mints a capability token
 *  - Creates the window via the canonical helper
 *  - Calls `loadURL` with the tile's peek:// URL
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

  // Apply per-launch windowOverrides by merging them onto the entry
  // before we hand it to the helper. windowOverrides are defined as
  // `Partial<TileEntry['windowHints']>` so they're semantically hints.
  const entryWithOverrides: TileEntry = windowOverrides
    ? { ...entry, windowHints: { ...entry.windowHints, ...windowOverrides } }
    : entry;

  const win = createTileBrowserWindow({
    tileId: manifest.id,
    entryId: entry.id,
    token,
    preloadPath,
    manifest,
    entry: entryWithOverrides,
  });

  // Build the URL for this tile: peek://{tileId}/{url}
  const tileUrl = `peek://${manifest.id}/${entry.url}`;
  win.loadURL(tileUrl);

  // Populate manifest.defaults from the tile's settingsSchema file so
  // tile:settings:get can fall back to declared defaults on DB miss.
  if (manifest.defaults === undefined) {
    const defaults = loadSchemaDefaults(tilePath, manifest.settingsSchema);
    if (defaults) manifest.defaults = defaults;
  }

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

  // FSM: LOADING → READY. Silent no-op for entries that aren't in
  // LOADING (e.g. trustedBuiltin callers that never transitioned
  // through the feature registry).
  tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.TILE_READY,
    { source: 'signalTileReady' });

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
 * Register a BrowserWindow as a trusted-builtin core renderer.
 *
 * Core renderers (cmd, hud, page, test fixtures) run with the same tile
 * mechanics as feature tiles — `tile-preload.cjs` + a capability token —
 * but the token's grant is minted by `createTrustedBuiltinGrant(...)` so
 * capability enforcement is bypassed. They are NOT launched by
 * `launchTile()` (no manifest file on disk), so hud-glue / cmd-glue /
 * page-glue call this helper after creating their BrowserWindow to:
 *
 *  - Add the window to the `tileWindows` registry so the pubsub
 *    extensionBroadcaster in main.ts forwards messages to it.
 *  - Wire the same close/revoke cleanup the regular launcher uses.
 *
 * See docs/v1-removal-plan.md — Phase 1a/1b.
 */
export function registerTrustedBuiltinWindow(
  tileId: string,
  entryId: string,
  win: BrowserWindow,
  token: string,
): void {
  const key = `${tileId}:${entryId}`;
  tileWindows.set(key, win);

  win.on('closed', () => {
    tileWindows.delete(key);
    readyTiles.delete(key);
    revokeToken(token);
    try {
      // Scope the unsubscribe to THIS entry's source address only — otherwise a
      // window-entry closing would wipe out a sibling background-entry's pubsub
      // subscriptions, since the tile registry keys subscriptions by full source
      // address `peek://{tileId}/{entryId}`.
      unsubscribeAll(`peek://${tileId}/${entryId}`);
    } catch (err) {
      console.error(`[tile-launcher:${tileId}:${entryId}] Failed to unsubscribe on close:`, err);
    }
    DEBUG && console.log(`[tile-launcher:${tileId}:${entryId}] Trusted-builtin window closed`);
  });
}

/**
 * Resolve a peek:// URL to v2 tile web preferences (preload + token).
 *
 * Used by the `window-open` IPC handler so that windows opened via
 * `api.window.open('peek://<tile>/<entry.url>')` get the strict tile
 * preload with a capability token, instead of the legacy `preload.js`
 * (which has the old v1 API surface and no `api.initialize()`).
 *
 * Returns null when:
 *   - the URL isn't a `peek://` tile URL
 *   - the feature isn't a registered v2 tile
 *   - no tile entry matches the URL's path
 * In those cases the caller should fall back to the legacy preload.
 *
 * The returned `additionalArguments` are formatted as Electron web-pref
 * args: `--tile-id=X --tile-entry=Y --tile-token=Z`. tile-preload.ts
 * reads these in its sync bootstrap before context-bridge injection.
 */
export function getTileWebPreferencesForUrl(
  url: string,
  tilePreloadPath: string,
  lookupLazyManifest: (tileId: string) => TileManifestV2 | null,
): { preload: string; additionalArguments: string[]; tileId: string; entryId: string; token?: string } | null {
  let host: string;
  let pathPart: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'peek:') return null;
    const cleanPath = parsed.pathname.replace(/^\//, '');
    if (parsed.host === 'ext') {
      // peek://ext/<tileId>/<entry.url> (legacy compat — handled by protocol.ts shim)
      const segments = cleanPath.split('/');
      if (segments.length < 2) return null;
      host = segments[0];
      pathPart = segments.slice(1).join('/');
    } else {
      host = parsed.host;
      pathPart = cleanPath;
    }
  } catch {
    return null;
  }

  const manifest = getTileManifest(host) || lookupLazyManifest(host);
  if (!manifest) return null;

  // Find the entry whose url matches the path.
  const entry = manifest.tiles.find(t => t.url === pathPart);
  if (!entry) return null;

  const grant = resolveCapabilities(
    manifest.id,
    manifest.capabilities,
    manifest.builtin === true,
  );
  const token = generateToken(manifest.id, entry.id, grant);

  return {
    preload: tilePreloadPath,
    additionalArguments: [
      `--tile-id=${manifest.id}`,
      `--tile-entry=${entry.id}`,
      `--tile-token=${token}`,
    ],
    tileId: manifest.id,
    entryId: entry.id,
    token,
  };
}

/**
 * Resolve a peek:// URL to v2 tile web preferences for a `<webview>` child.
 *
 * Like `getTileWebPreferencesForUrl`, but treats child URLs that don't
 * correspond to a declared tile entry as belonging to the parent tile's
 * grant. This is the loader path for HTML assets a tile loads inside a
 * `<webview>` element (e.g. `widget-demo`'s widget cards loading
 * `peek://widget-demo/widgets/clock.html` — `widgets/clock.html` is
 * not declared as its own tile entry, but logically belongs to
 * `widget-demo`).
 *
 * Resolution rules:
 *  - URL must be peek://
 *  - Tile-id (URL host, or first path segment under `peek://ext/` for legacy compat) must
 *    match a registered v2 manifest
 *  - If a tile entry's `url` matches the path, mint a token for that
 *    specific entry (same as `getTileWebPreferencesForUrl`)
 *  - Otherwise, fall back to the manifest's first tile entry — webview
 *    children inherit the parent tile's full capability grant
 *
 * Returns null when the URL isn't peek:// or the tile-id isn't a v2
 * tile. Callers should fall back to the legacy preload in that case
 * (e.g. for v1 extensions like HUD).
 */
export function getTileWebPreferencesForWebviewUrl(
  url: string,
  tilePreloadPath: string,
  lookupLazyManifest: (tileId: string) => TileManifestV2 | null,
): { preload: string; additionalArguments: string[]; tileId: string; entryId: string } | null {
  let host: string;
  let pathPart: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'peek:') return null;
    const cleanPath = parsed.pathname.replace(/^\//, '');
    if (parsed.host === 'ext') {
      const segments = cleanPath.split('/');
      if (segments.length < 2) return null;
      host = segments[0];
      pathPart = segments.slice(1).join('/');
    } else {
      host = parsed.host;
      pathPart = cleanPath;
    }
  } catch {
    return null;
  }

  const manifest = getTileManifest(host) || lookupLazyManifest(host);
  if (!manifest) return null;
  if (!manifest.tiles || manifest.tiles.length === 0) return null;

  // Prefer an exact entry match, fall back to the first entry for
  // webview children that aren't declared as standalone tile entries.
  const entry = manifest.tiles.find(t => t.url === pathPart) || manifest.tiles[0];

  const grant = resolveCapabilities(
    manifest.id,
    manifest.capabilities,
    manifest.builtin === true,
  );
  const token = generateToken(manifest.id, entry.id, grant);

  return {
    preload: tilePreloadPath,
    additionalArguments: [
      `--tile-id=${manifest.id}`,
      `--tile-entry=${entry.id}`,
      `--tile-token=${token}`,
    ],
    tileId: manifest.id,
    entryId: entry.id,
  };
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

/**
 * Relaunch a tile — re-read the manifest from disk, close the old window
 * (if any), revoke its tokens, then call `launchTile()` with the fresh manifest.
 *
 * Used by `reloadExtension()` and `loadDevExtension()` in main.ts.
 *
 * Edge cases:
 *  - Tile not currently running (no window): just launches fresh.
 *  - Window already destroyed: skips close, still revokes tokens and relaunches.
 *  - Manifest no longer parseable: returns null (logs error).
 *  - `getTilePreloadPath()` not configured: returns null (logs error).
 */
export async function relaunchTile(tileId: string): Promise<TileLaunchResult | null> {
  const tilePath = getExtensionPath(tileId);
  if (!tilePath) {
    console.error(`[tile-launcher] relaunchTile: no path registered for tile ${tileId}`);
    return null;
  }

  const tilePreloadPath = getTilePreloadPath();
  if (!tilePreloadPath) {
    console.error(`[tile-launcher] relaunchTile: tile preload path not configured — call initialize() first`);
    return null;
  }

  // Re-read manifest from disk so any changes (e.g. during dev reload) are picked up.
  const manifestPath = path.join(tilePath, 'manifest.json');
  const parsed = parseManifestFile(manifestPath);
  if (!parsed || parsed.version !== 'v2' || !parsed.v2) {
    console.error(`[tile-launcher] relaunchTile: cannot re-read v2 manifest for ${tileId} at ${manifestPath}`);
    return null;
  }
  const manifest = parsed.v2;

  // Determine which entry to (re)launch — use the first entry, matching the
  // pattern used in loadV2Tile / tile-compat.
  const entry = manifest.tiles[0];
  if (!entry) {
    console.error(`[tile-launcher] relaunchTile: manifest for ${tileId} has no tile entries`);
    return null;
  }

  // Close the existing window if one is running.
  const existingWin = tileWindows.get(`${tileId}:${entry.id}`);
  if (existingWin && !existingWin.isDestroyed()) {
    // Use unloadTile for clean shutdown (shutdown signal + token revoke + unsubscribe).
    await unloadTile(tileId, entry.id);
  } else {
    // No live window — still revoke any stale tokens from a previous run.
    revokeTokensForTile(tileId, entry.id);
    loadedManifests.delete(tileId);
  }

  DEBUG && console.log(`[tile-launcher] Relaunching ${tileId}:${entry.id} from ${tilePath}`);

  return launchTile({
    tilePath,
    manifest,
    preloadPath: tilePreloadPath,
    entryId: entry.id,
  });
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
