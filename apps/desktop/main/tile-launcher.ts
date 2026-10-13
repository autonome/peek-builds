/**
 * Tile Launcher — Creates and manages tile contexts
 *
 * Handles:
 * - Loading and validating tile manifests
 * - Creating BrowserWindows for window tiles (with manifest window hints)
 * - Creating hidden windows for background tiles
 * - Generating capability tokens (opaque string encoding tile ID + granted capabilities)
 * - Passing tokens to tiles via additionalArguments in WebPreferences
 * - Lifecycle: load manifest -> grant capabilities -> create context -> tile calls initialize() -> tile:lifecycle:ready
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
  type TileManifest,
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
  setTokenOwner,
} from './tile-tokens.js';
import { publish, getSystemAddress, unsubscribeAll } from './pubsub.js';
import { DEBUG, getTilePreloadPath, isHeadless } from './config.js';
import { loadSchemaDefaults } from './tile-settings-defaults.js';
import { getTilePath } from './protocol.js';
import * as tileLifecycle from './tile-lifecycle.js';

// Config hooks for values sourced from electron-heavy modules
// (session-partition, windows) that we can't safely import at top
// level in this file: both transitively `import { BrowserWindow }`
// from 'electron' as ESM, which breaks under ELECTRON_RUN_AS_NODE=1
// where electron's named ESM exports are empty. Unit tests load
// tile-launcher.js under that mode and would crash at module parse
// time. We inject the getters at app startup instead — same pattern
// as `setPubsubBroadcaster` in pubsub.ts. Tests that stub the
// launcher never call createTileBrowserWindow, so the hooks stay
// null and the baseline helpers fall back cleanly.
let _getProfileSession: (() => Electron.Session) | null = null;
let _getSystemThemeBackgroundColor: (() => string) | null = null;
// Injected from main.ts: registers a tile window with the window-state machine
// (the OS adapter then attaches its focus/blur/show/hide/closed listeners and
// tracks it as a possible `front`). Replaces the old `_onWindowFocus` feed into
// ipc.ts's deleted `trackVisibleWindowFocus`.
// The `before-input-event` ESC interceptor rides along with this hook: the
// window-state machine's registration is the single owner of the attach, so
// there is no separate `addEscHandler` hook here anymore (two hooks meant two
// interceptors on any window that registered twice).
let _registerWindow: ((spec: TileWindowRegistration) => void) | null = null;

/**
 * Everything the window-state machine needs to register a tile window, taken
 * from the REQUEST that created it rather than sniffed back off the live
 * handle. `alwaysOnTop` / `focusable` are the RESOLVED creation intent (the
 * merged `windowOptions` in `createTileBrowserWindow`, i.e. after the headless
 * gate and after `browserWindowOverrides`) — not the raw manifest hints, which
 * would misclassify a headless run.
 */
export interface TileWindowRegistration {
  win: BrowserWindow;
  /** Manifest entry role; undefined means the caller declared none (defaults to 'workspace'). */
  role: string | undefined;
  /** Entry's keepLive flag — the reducer record carries it (hide-vs-close). */
  keepLive: boolean;
  /** Resolved `windowOptions.alwaysOnTop` (headless-gated). */
  alwaysOnTop: boolean;
  /** Resolved `windowOptions.focusable` (Electron's default is true). */
  focusable: boolean;
}

// Injected from main.ts: closes a tile window through the window-state machine
// (WINDOW_CLOSE_REQUESTED → the backend's guest-safe close). Injected rather
// than imported for the same ELECTRON_RUN_AS_NODE reason as the other hooks:
// the machine singleton transitively value-imports electron, which this
// module's unit tests cannot load.
let _closeTileWindow: ((win: BrowserWindow) => void) | null = null;

/** Close a tile window via the injected machine hook; loud no-op when unconfigured (production always configures it in main.ts initialize()). */
function closeTileWindowViaHook(win: BrowserWindow): void {
  if (_closeTileWindow) {
    _closeTileWindow(win);
    return;
  }
  console.error('[tile-launcher] closeTileWindow hook not configured — window', win.id, 'not closed');
}

/**
 * Lightweight role/address info for every live tile window, keyed by
 * `BrowserWindow.id`. The IZUI ESC handler (`handleEscapeForWindow` in
 * windows.ts) resolves a tile window's escape role from here via the
 * exported `getTileWindowInfo`, so tile windows run the escape protocol
 * WITHOUT being entered into the shared window-registry (which feeds the
 * "reopen last closed window" stack — and would wrongly remember closed
 * feature-tile windows if they were registered there).
 */
const tileWindowInfo = new Map<number, { role: string; address: string; escapeMode?: string }>();

/** Role/address info for a live tile window, or undefined if unknown.
 *  Reads only this module's own map — no Electron required. */
export function getTileWindowInfo(windowId: number): { role: string; address: string; escapeMode?: string } | undefined {
  return tileWindowInfo.get(windowId);
}

/**
 * Wire tile-launcher up to its electron-side dependencies. Called once
 * at app startup, before any `launchTile` / `createTileBrowserWindow`
 * call. Passing either as undefined keeps that dependency unused (unit
 * tests do this implicitly by never calling this function).
 */
export function configureTileLauncher(hooks: {
  getProfileSession?: () => Electron.Session;
  getSystemThemeBackgroundColor?: () => string;
  /**
   * Called once per tile window at launch to register it with the window-state
   * machine (every window-creation site registers — judgment call 2). The OS
   * adapter then attaches the native focus/blur/show/hide/closed listeners that
   * drive `front`, so focusing a tile (tags, search, …) makes it the command
   * target. Replaces the old `onWindowFocus` → `trackVisibleWindowFocus` feed.
   * Registering also attaches the window's before-input-event ESC interceptor
   * (and its webview guests') — one owner for both.
   * The spec carries the creation INTENT (role, keepLive, alwaysOnTop,
   * focusable) so the machine never has to ask the OS what the window is.
   */
  registerWindow?: (spec: TileWindowRegistration) => void;
  /**
   * Closes a tile window through the window-state machine. Tile teardown
   * (shutdownTile / unloadAllTiles) routes every close through this hook —
   * rule R2: nothing here calls a window API directly.
   */
  closeTileWindow?: (win: BrowserWindow) => void;
}): void {
  if (hooks.getProfileSession) _getProfileSession = hooks.getProfileSession;
  if (hooks.getSystemThemeBackgroundColor) _getSystemThemeBackgroundColor = hooks.getSystemThemeBackgroundColor;
  if (hooks.registerWindow) _registerWindow = hooks.registerWindow;
  if (hooks.closeTileWindow) _closeTileWindow = hooks.closeTileWindow;
}

// Short grace period given to tiles to run their `api.onShutdown()` callbacks
// before the BrowserWindow is forcibly closed. Kept small so app-quit and
// feature disable/uninstall don't visibly stall. Exported for tests to tune.
export const TILE_SHUTDOWN_GRACE_MS = 500;

// Re-export token functions for consumers
export { generateToken, validateToken, revokeToken, getGrantForToken } from './tile-tokens.js';

/** Tile window registry: tileId:entryId -> every live window for that
 *  key, in open order (most recently opened last).
 *
 *  More than one live window can share a key: each
 *  `api.window.open('peek://search/home.html?q=…')` builds another
 *  window for the same (tile, entry). This used to be a singleton
 *  `Map<string, BrowserWindow>` where the second open overwrote the
 *  first, so the FIRST close tore the whole entry down — `getTileWindow`
 *  went null and the entry's pubsub subscriptions were dropped while a
 *  sibling was still running.
 *
 *  Keyed lookups keep their old answer: `getTileWindow` returns the
 *  last element (the most recently opened window), `isTileLoaded` is
 *  true while any window remains. Per-entry teardown now waits for the
 *  key's last live window — see `releaseTileWindow`.
 *
 *  A key is present only while it has at least one window; an empty
 *  list is deleted rather than kept.
 */
const tileWindows = new Map<string, BrowserWindow[]>();

/** Live windows for a key, in open order. The returned array is the
 *  registry's own — callers that close windows while iterating must
 *  copy it first. */
function tileWindowsFor(key: string): BrowserWindow[] {
  return tileWindows.get(key) ?? [];
}

/** Append `win` to the key's list, ignoring a window already there. */
function addTileWindow(key: string, win: BrowserWindow): void {
  const list = tileWindows.get(key);
  if (!list) {
    tileWindows.set(key, [win]);
    return;
  }
  if (!list.includes(win)) list.push(win);
}

/** Every live tile BrowserWindow, regardless of (tileId, entryId)
 *  duplicates. Exists so the pubsub broadcaster can fan out to all
 *  open instances of a tile entry — e.g. two `peek://search/home.html`
 *  windows opened with different `?q=...` queries. */
const tileWindowsAll = new Set<BrowserWindow>();

/** Loaded manifests: tileId -> manifest */
const loadedManifests = new Map<string, TileManifest>();

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
  /** The parsed manifest */
  manifest: TileManifest;
  /** Path to the tile preload script */
  preloadPath: string;
  /** Which tile entry to launch (defaults to first) */
  entryId?: string;
  /** Override window hints (subset of TileEntry's flat window fields) */
  windowOverrides?: TileWindowOverrides;
}

/**
 * Subset of `TileEntry`'s flat window fields that can be overridden at
 * launch time. Mirrors the fields the launcher actually feeds to
 * `BrowserWindowConstructorOptions`.
 */
export type TileWindowOverrides = Partial<Pick<TileEntry,
  | 'width' | 'height' | 'minWidth' | 'minHeight'
  | 'alwaysOnTop' | 'transparent' | 'focusable' | 'frame' | 'resizable'
  | 'role' | 'key' | 'title'
>>;

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
  manifest?: TileManifest;
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
 * Why one window of a tile entry went away.
 *
 *  - `closed` — a launcher-created window closed normally; the entry's
 *    last window drives SHUTDOWN → CLEANUP_KEEP.
 *  - `crashed` — the window's render process is gone; the entry's last
 *    window drives RENDER_GONE.
 *  - `builtin-closed` — a trusted-builtin window closed; no lifecycle
 *    transitions, because those entries never ran through the feature
 *    registry.
 */
export type TileWindowReleaseReason = 'closed' | 'crashed' | 'builtin-closed';

/**
 * Drop one live tile window from the registry, and tear the ENTRY down
 * only when that window was the last one for its key.
 *
 * Several live windows can share a `tileId:entryId` key, so the work
 * splits in two:
 *
 *  - Per-window, always: forget the window in `tileWindowsAll`, remove it
 *    from the key's list, forget its role/address info. The capability
 *    token is per-window too, but stays with the caller — only the
 *    handler that minted it knows which token the window carries.
 *  - Per-entry, only for the key's last live window: the ready flag, the
 *    entry's pubsub subscriptions (pubsub keys them by source address,
 *    which both siblings share), and the lifecycle transitions for the
 *    reason given.
 *
 * Returns true when the per-entry teardown ran.
 *
 * `crashDetails` carries the `render-process-gone` reason/exit code into
 * the RENDER_GONE transition's context; it is ignored for other reasons.
 */
export function releaseTileWindow(
  tileId: string,
  entryId: string,
  win: BrowserWindow,
  reason: TileWindowReleaseReason,
  crashDetails?: { reason?: string; exitCode?: number },
): boolean {
  const key = `${tileId}:${entryId}`;
  const list = tileWindows.get(key);
  // Per-entry teardown is gated on "no OTHER window is registered for this
  // key", not on `win` still being registered itself. A live sibling blocks
  // it; an already-de-registered window does not. `unloadTile` and
  // `unloadAllTiles` drop their windows from the registry eagerly, so by the
  // time the real `closed` event arrives `win` is gone from the list — and
  // that close still has to drive the entry's lifecycle back to `registered`,
  // or a disabled feature can never be re-enabled (the FSM has no edge out of
  // `ready` for a fresh LOAD).
  const isLast = (list ?? []).some(other => other !== win) === false;

  // Lifecycle first, keeping the pre-split order (transition, then the
  // registry deletes) for the single-window case that every existing
  // caller exercises.
  if (isLast) {
    if (reason === 'closed') {
      // Drive the entry back toward `registered`: SHUTDOWN → UNLOADING →
      // CLEANUP_KEEP → REGISTERED. Each step is best-effort; from
      // UNREGISTERED (trustedBuiltin callers, uninstall races) or CRASHED
      // the FSM rejects and the resource cleanup below still runs.
      const curState = tileLifecycle.getState(tileId, entryId);
      if (curState !== tileLifecycle.STATES.UNREGISTERED && curState !== tileLifecycle.STATES.CRASHED) {
        tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.SHUTDOWN, { source: 'window-closed' });
        tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.CLEANUP_KEEP, { source: 'window-closed' });
      }
    } else if (reason === 'crashed') {
      tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.RENDER_GONE, {
        reason: crashDetails?.reason,
        exitCode: crashDetails?.exitCode,
      });
    }
    // 'builtin-closed' never transitions — those entries have no FSM record.
  }

  // Per-window, unconditionally. The index is re-read rather than reused from
  // above: the transitions publish `tile:state-changed` synchronously, so a
  // subscriber could in principle have reordered the key's list in between.
  tileWindowsAll.delete(win);
  const removeAt = list ? list.indexOf(win) : -1;
  if (removeAt >= 0) {
    list!.splice(removeAt, 1);
    if (list!.length === 0) tileWindows.delete(key);
  }
  // Drop the tile-window info entry added on launch, so stale entries don't
  // accumulate and getTileWindowInfo can't resolve a dead id.
  tileWindowInfo.delete(win.id);

  if (!isLast) return false;

  readyTiles.delete(key);
  try {
    // Scope the unsubscribe to THIS entry's source address only — otherwise a
    // window-entry closing would wipe out a sibling background-entry's pubsub
    // subscriptions, since the tile registry keys subscriptions by full source
    // address `peek://{tileId}/{entryId}`.
    unsubscribeAll(`peek://${tileId}/${entryId}`);
  } catch (err) {
    console.error(`[tile-launcher:${tileId}:${entryId}] Failed to unsubscribe on ${reason}:`, err);
  }
  return true;
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
 *   baseline defaults ◁ manifest-entry flat fields ◁ caller overrides
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
  // only authoritative for feature tiles today, and a silent
  // rejection on trustedBuiltin entries doesn't harm drift detection.
  tileLifecycle.transition(tileId, entryId, tileLifecycle.TRIGGERS.LOAD,
    { source: 'createTileBrowserWindow' });

  // Hints from the manifest entry (flat window fields on the entry).
  let hints: TileWindowOverrides = {};
  if (entry) {
    const { width, height, minWidth, minHeight, alwaysOnTop, transparent,
            focusable, frame, resizable, role, key: entryKey, title } = entry;
    hints = { width, height, minWidth, minHeight, alwaysOnTop, transparent,
              focusable, frame, resizable, role, key: entryKey, title };
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
    // Tiles default to FRAMELESS. Mirror the legacy `api.window.open` path
    // (ipc.ts:594), which always defaulted to `frame: false`. The previous
    // launcher default of `frame: true` was a silent regression that
    // surfaced as a titlebar on resident tiles (e.g. lists, websearch).
    // Tiles that genuinely need an OS titlebar must opt in with
    // `frame: true` in the manifest.
    frame: hints?.frame === true,
    transparent: transparentResolved,
    alwaysOnTop: !isHeadless() && hints?.alwaysOnTop === true,
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
      // Always grant the devTools capability. Electron fixes
      // `webPreferences.devTools` at creation, so any window that might
      // ever need devtools — including via the runtime debug toggle on an
      // already-open window — must opt in here. The opt-in to ACTUALLY
      // open devtools is gated separately by `isDevToolsEnabled()` at the
      // keyboard-shortcut handler in entry.ts.
      devTools: true,
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

  // Phase 2 pubsub hardening: bind the capability token to its owning
  // WebContents so every `tile:*` IPC handler can cross-check
  // `event.sender.id === ownerWebContentsId`. Without this a compromised
  // tile that leaks another tile's token could forge IPC frames using
  // it. The token was minted before the window existed (it's injected
  // via additionalArguments), so binding happens here — the first
  // moment `win.webContents.id` is known.
  setTokenOwner(token, win.webContents.id);

  const key = `${tileId}:${entryId}`;
  addTileWindow(key, win);
  tileWindowsAll.add(win);
  if (manifest) loadedManifests.set(tileId, manifest);

  // Record the tile window's role/address for the IZUI ESC handler. The
  // `before-input-event` ESC interceptor is attached by `_registerWindow`
  // below (the machine's registration owns it) — exactly what the
  // `window-open` IPC path does for IPC-opened windows, minus the shared
  // window-registry entry. The ESC handler resolves this window's role
  // via `getTileWindowInfo(win.id)` (not `getWindowInfo`), so feature-tile
  // windows run the escape protocol (root ESC → escPolicy 'nothing' →
  // escUnhandledPolicy 'open-switcher' → cmd:execute:windows) without
  // polluting the "reopen last closed window" stack. Default role to
  // 'workspace' (root window) so the policy resolves correctly; overlay
  // tiles that declare role:'overlay' keep it and close-and-restore.
  tileWindowInfo.set(win.id, {
    role: entry?.role ?? 'workspace',
    address: `peek://${tileId}/${entry?.url ?? ''}`,
  });
  // Register the tile window with the window-state machine so it is a possible
  // `front` (focusing tags/search/etc. makes it the command target). The OS
  // adapter attaches the focus/blur/show/hide/closed listeners AND the ESC
  // interceptor — no per-focus feed needed here anymore.
  if (_registerWindow) {
    // Pass the entry's keepLive flag so the reducer record carries it
    // first-class — the machine's WINDOW_CLOSE_OR_HIDE_REQUESTED clause (fed
    // by the keepLive 'close' intercept below) branches hide-vs-close on it.
    // alwaysOnTop/focusable come from the MERGED windowOptions above — the
    // same values the constructor just got — so the registration classifies
    // the window from the request that made it, never from a live OS read
    // (R2: the machine owns these facts). Reading the raw manifest hints
    // instead would skip the headless gate on alwaysOnTop.
    _registerWindow({
      win,
      role: entry?.role,
      keepLive: entry?.keepLive === true,
      alwaysOnTop: windowOptions.alwaysOnTop === true,
      focusable: windowOptions.focusable !== false,
    });
  }

  // Forward console messages from the tile's webContents to main-process
  // stderr — but only when DEBUG is set. In normal runs the preload-level
  // console wrapper (tile-preload.cts) sends all output to
  // peek:renderer-log → <userData>/logs/renderer.log regardless of
  // DevTools state, so we don't need to duplicate to stderr in production.
  // console-message does NOT fire when DevTools is attached; the IPC path
  // is unaffected.
  if (DEBUG) {
    win.webContents.on('console-message', (event) => {
      try {
        // Electron 40: `level` is a string literal ('info'|'warning'|'error'|
        // 'verbose'), not an integer.
        const asAny = event as unknown as { level?: unknown; message?: unknown };
        const level = String(asAny.level ?? '');
        const message = String(asAny.message ?? '');
        console.log(`[tile:${tileId}:${entryId}] [${level}] ${message}`);
      } catch {
        // Logging must never throw.
      }
    });
  }

  // Render-process crashes: revoke token, drop tracked state, unsubscribe
  // this entry's subs only (sibling entries stay subscribed), and
  // optionally publish a `tile:crashed` event.
  //
  // With a sibling window still live on this key, `releaseTileWindow` does
  // per-window cleanup only — no RENDER_GONE, since the entry is still
  // running. The `tile:crashed` publish fires either way: it reports THIS
  // window's crash, not the entry's death.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[tile:${tileId}:${entryId}] Render process gone: ${details.reason} (exitCode=${details.exitCode})`
    );
    releaseTileWindow(tileId, entryId, win, 'crashed',
      { reason: details.reason, exitCode: details.exitCode });
    revokeToken(token);
    if (publishCrashEvent) {
      try {
        publish(getSystemAddress(), 'tile:crashed', {
          tileId, entryId,
          reason: details.reason,
          exitCode: details.exitCode,
        });
      } catch (err) {
        console.error(`[tile:${tileId}:${entryId}] Failed to publish tile:crashed event:`, err);
      }
    }
  });

  // Normal close: same cleanup as crash, minus the crash broadcast. The
  // entry's lifecycle and pubsub teardown wait for the key's last live
  // window; the token is per-window, so it is revoked here either way.
  win.on('closed', () => {
    releaseTileWindow(tileId, entryId, win, 'closed');
    revokeToken(token);
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

  // Apply per-launch windowOverrides by merging them onto the entry's
  // flat window fields before we hand it to the helper.
  const entryWithOverrides: TileEntry = windowOverrides
    ? { ...entry, ...windowOverrides }
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
 * Get the BrowserWindow for a tile entry — the most recently opened live
 * one when several share the entry (what the old singleton registry's
 * "last write wins" happened to answer, which is what callers want).
 */
export function getTileWindow(tileId: string, entryId: string): BrowserWindow | null {
  const list = tileWindowsFor(`${tileId}:${entryId}`);
  return list.length > 0 ? list[list.length - 1] : null;
}

/**
 * Check if a tile entry is loaded — true while ANY window remains for it.
 */
export function isTileLoaded(tileId: string, entryId: string): boolean {
  return tileWindowsFor(`${tileId}:${entryId}`).length > 0;
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
export function getTileManifest(tileId: string): TileManifest | null {
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
 * Used by the pubsub broadcaster to forward messages to tile windows.
 */
export function getAllTileWindows(): BrowserWindow[] {
  // Iterate `tileWindowsAll`, NOT `tileWindows` — a flat set needs no
  // per-key walk to answer "every live tile window". (Historically
  // `tileWindows` was a singleton Map that silently dropped earlier
  // instances when a second window opened for the same entry, so using
  // it here stopped pubsub events reaching the first open window the
  // moment a second matching window appeared — e.g. two
  // `peek://search/home.html?q=...` queries side by side.)
  return Array.from(tileWindowsAll).filter(win => !win.isDestroyed());
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
 *    broadcaster in main.ts forwards messages to it.
 *  - Wire the same close/revoke cleanup the regular launcher uses.
 */
export function registerTrustedBuiltinWindow(
  tileId: string,
  entryId: string,
  win: BrowserWindow,
  token: string,
): void {
  addTileWindow(`${tileId}:${entryId}`, win);
  tileWindowsAll.add(win);

  // Phase 2 pubsub hardening: bind the trustedBuiltin token to its
  // owning WebContents so the IPC gate's sender-frame cross-check
  // passes for this core renderer. See createTileBrowserWindow for
  // the full rationale.
  setTokenOwner(token, win.webContents.id);

  win.on('closed', () => {
    releaseTileWindow(tileId, entryId, win, 'builtin-closed');
    revokeToken(token);
    DEBUG && console.log(`[tile-launcher:${tileId}:${entryId}] Trusted-builtin window closed`);
  });
}

/**
 * Resolve a peek:// URL to tile web preferences (preload + token).
 *
 * Used by the window-open path so that windows opened via
 * `api.window.open('peek://<tile>/<entry.url>')` get tile-preload with
 * a capability token.
 *
 * Returns null when:
 *   - the URL isn't a `peek://` tile URL
 *   - the feature isn't a registered tile
 *   - no tile entry matches the URL's path
 * In those cases the caller should open the window with no preload.
 *
 * The returned `additionalArguments` are formatted as Electron web-pref
 * args: `--tile-id=X --tile-entry=Y --tile-token=Z`. tile-preload.ts
 * reads these in its sync bootstrap before context-bridge injection.
 */
export function getTileWebPreferencesForUrl(
  url: string,
  tilePreloadPath: string,
  lookupLazyManifest: (tileId: string) => TileManifest | null,
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
 * Resolve a peek:// URL to tile web preferences for a `<webview>` child.
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
 *    match a registered tile manifest
 *  - If a tile entry's `url` matches the path, mint a token for that
 *    specific entry (same as `getTileWebPreferencesForUrl`)
 *  - Otherwise, fall back to the manifest's first tile entry — webview
 *    children inherit the parent tile's full capability grant
 *
 * Returns null when the URL isn't peek:// or the tile-id isn't a
 * registered tile. Callers should inject no preload in that case.
 */
export function getTileWebPreferencesForWebviewUrl(
  url: string,
  tilePreloadPath: string,
  lookupLazyManifest: (tileId: string) => TileManifest | null,
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
 * Send the `tile:lifecycle:shutdown` IPC to EVERY live window of a tile
 * entry, wait a short grace period for their `api.onShutdown()` callbacks
 * to run, and then close them all.
 *
 * Tiles register shutdown callbacks via `api.onShutdown(cb)` in tile-preload.
 * Without this signal the callback never fires, so intervals / timers /
 * subscriptions inside the tile leak. Signalling only the latest window
 * would leak exactly that way in the siblings.
 *
 * The grace period is waited once for the whole set, so quit latency stays
 * bounded no matter how many windows share the entry.
 *
 * Returns a promise that resolves once the closes have been dispatched (via
 * the injected machine hook). The `closed` events (which do the real
 * tracked-state cleanup) may fire a tick or two later — callers that need to
 * wait for full teardown should listen for them separately.
 */
export async function shutdownTile(tileId: string, entryId: string): Promise<void> {
  const key = `${tileId}:${entryId}`;
  // Snapshot: closing a window mutates the key's list via releaseTileWindow.
  const wins = tileWindowsFor(key).filter(win => !win.isDestroyed());

  if (wins.length === 0) return;

  for (const win of wins) {
    try {
      // Notify the tile so `api.onShutdown()` callbacks can run.
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('tile:lifecycle:shutdown');
      }
    } catch (err) {
      console.error(`[tile-launcher:${tileId}:${entryId}] Failed to send tile:lifecycle:shutdown:`, err);
    }
  }

  // Give the tiles a short grace period to clean up. We intentionally don't
  // wait for an ack — a crashing or unresponsive tile must not block quit.
  await new Promise<void>((resolve) => setTimeout(resolve, TILE_SHUTDOWN_GRACE_MS));

  for (const win of wins) {
    if (!win.isDestroyed()) {
      closeTileWindowViaHook(win);
    }
  }
}

/**
 * Unload a tile — send shutdown signal, close its window, revoke tokens.
 *
 * The `closed` event handler on each window performs the real tracked-state
 * cleanup (tileWindows / readyTiles / token revocation / unsubscribeAll).
 * Keep the eager cleanup here too so callers that check isTileLoaded() right
 * after unloadTile() see the tile as unloaded without waiting for the close
 * events to fire — which means dropping EVERY window of the entry, not just
 * the latest, or isTileLoaded() would stay true.
 */
export async function unloadTile(tileId: string, entryId: string): Promise<void> {
  const key = `${tileId}:${entryId}`;

  await shutdownTile(tileId, entryId);

  const wins = tileWindowsFor(key).slice();
  tileWindows.delete(key);
  for (const win of wins) tileWindowsAll.delete(win);
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
 * Used by `reloadTile()` and `loadDevTile()` in main.ts.
 *
 * Edge cases:
 *  - Tile not currently running (no window): just launches fresh.
 *  - Window already destroyed: skips close, still revokes tokens and relaunches.
 *  - Manifest no longer parseable: returns null (logs error).
 *  - `getTilePreloadPath()` not configured: returns null (logs error).
 */
export async function relaunchTile(tileId: string): Promise<TileLaunchResult | null> {
  const tilePath = getTilePath(tileId);
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
  if (!parsed || parsed.version !== 'tile' || !parsed.manifest) {
    console.error(`[tile-launcher] relaunchTile: cannot re-read tile manifest for ${tileId} at ${manifestPath}`);
    return null;
  }
  const manifest = parsed.manifest;

  // Determine which entry to (re)launch — use the first entry, matching the
  // pattern used in loadTile / tile-compat.
  const entry = manifest.tiles[0];
  if (!entry) {
    console.error(`[tile-launcher] relaunchTile: manifest for ${tileId} has no tile entries`);
    return null;
  }

  // Close the existing window if one is running. getTileWindow answers
  // whether ANYTHING is live for the entry, which is all the dedupe needs —
  // unloadTile below drops every window for the key.
  const existingWin = getTileWindow(tileId, entry.id);
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

/** @internal Appends to the entry's window list, so calling it twice for one
 *  key installs two siblings in open order. */
export function __setTileWindowForTest(
  tileId: string,
  entryId: string,
  win: unknown,
): void {
  addTileWindow(`${tileId}:${entryId}`, win as BrowserWindow);
  tileWindowsAll.add(win as BrowserWindow);
}

/** @internal */
export function __clearTileStateForTest(): void {
  tileWindows.clear();
  tileWindowsAll.clear();
  readyTiles.clear();
  readyCallbacks.clear();
  loadedManifests.clear();
}

/**
 * Unload all tiles — called during app shutdown.
 *
 * Broadcasts `tile:lifecycle:shutdown` to every tile in parallel, waits the
 * shared grace period once, then closes all windows. This keeps quit latency
 * bounded to TILE_SHUTDOWN_GRACE_MS regardless of how many tiles are active.
 */
export async function unloadAllTiles(): Promise<void> {
  // Phase 1: fan out shutdown signal to every tile.
  // Iterate `tileWindowsAll` so duplicate-keyed windows (e.g. two
  // open `peek://search/home.html?q=...` queries) all receive the
  // shutdown signal, not just the most-recently-registered one.
  for (const win of tileWindowsAll) {
    if (win.isDestroyed()) continue;
    try {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('tile:lifecycle:shutdown');
      }
    } catch (err) {
      console.error('[tile-launcher] Failed to send tile:lifecycle:shutdown during unloadAllTiles:', err);
    }
  }

  // Phase 2: single grace-period wait for all tiles to run their onShutdown.
  await new Promise<void>((resolve) => setTimeout(resolve, TILE_SHUTDOWN_GRACE_MS));

  // Phase 3: close every window.
  for (const win of tileWindowsAll) {
    if (!win.isDestroyed()) {
      closeTileWindowViaHook(win);
    }
  }
  tileWindows.clear();
  tileWindowsAll.clear();
  readyTiles.clear();
  readyCallbacks.clear();
  loadedManifests.clear();
  clearAllTokens();

  DEBUG && console.log('[tile-launcher] All tiles unloaded');
}
