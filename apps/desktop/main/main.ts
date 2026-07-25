/**
 * Electron Main Process Entry Point
 *
 * This module orchestrates the main process startup and provides
 * a unified API for managing the Electron application.
 */

import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, webContents } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
import { getHybridWindow } from './hybrid-page-host-registry.js';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { initDatabase, closeDatabase, getDb, getContextEntry, normalizeUrl } from './datastore.js';
import { seedOnboardingIfNeeded } from './onboarding-seed.js';
import { installDebugFlagsPersistence } from './debug-flag-store.js';
import { migrateMcpConfigLocation } from './mcp-config.js';
import { registerScheme, initProtocol, registerTilePath, getTilePath, getRegisteredTileIds, registerThemePath, getRegisteredThemeIds } from './protocol.js';
import { initCore, getCoreBackgroundWindow } from './core-glue.js';
import { initTestFixture } from './test-fixture-glue.js';
import { discoverFeatures, loadFeatureManifest, isBuiltinFeatureEnabled } from './tile-feature-state.js';
import { initializeFeatures, type FeatureStartupResult } from './feature-startup.js';
import { ensureTileIpcHandlers } from './tile-compat.js';
import {
  registerTileLifecycleIpc,
  setReadyCallback as setLifecycleReadyCallback,
} from './tile-lifecycle.js';
import { signalTileReady, getLoadedTileIds, getTileManifest, getAllTileWindows, unloadAllTiles, relaunchTile, configureTileLauncher } from './tile-launcher.js';
import { installLoadOnDispatchHook } from './tile-lazy.js';
import { initTray } from './tray.js';
import { registerLocalShortcut, unregisterLocalShortcut, handleLocalShortcut, registerGlobalShortcut, unregisterGlobalShortcut, unregisterShortcutsForAddress } from './shortcuts.js';
import { publish, subscribe, unsubscribe, setPubsubBroadcaster, getSystemAddress } from './pubsub.js';
import { createRuleEngine, type RuleEngine } from './rule-engine.js';
import { listRules as rulesList, type RulesDb } from './rules.js';
import { installDirectSendGuard, installOffPathWindowGuard, unguardedWebContentsSend } from './tile-ipc-gate.js';
import { WEB_CORE_ADDRESS, isTestProfile, isDevProfile, isEphemeralProfile, isHeadless, getProfile, setTilePreloadPath, getTilePreloadPath, DEBUG } from './config.js';
import { getSystemThemeBackgroundColor } from './windows.js';
import { getProfileSession, getPartitionString, getCurrentProfileId } from './session-partition.js';
import { getIzuiCoordinator } from './izui-state.js';
import {
  initWindowStateMachine,
  registerWindowWithMachine,
  dispatchWindowEvent,
  getWindowIdFor,
  getNativeWindowFor,
  getMachineWindowRecord,
  listMachineWindowRecords,
} from './window-state-singleton.js';
import { isSatelliteRegistration, classifyWindowRegistration } from './window-state.js';
import type { Placement } from './window-placement.js';
import { getWindowPresentation, getRestorableBounds } from './window-presenter.js';
import { saveSessionSnapshot, reassertColdStartFocusOnce } from './session.js';

// Track app-quit state so the close-debounced save doesn't double-fire
// alongside the before-quit save. before-quit handler in entry.ts sets
// _appIsQuitting=true via the listener below; the debounced timer body
// checks it and bails so we don't write a half-quit snapshot.
let _appIsQuitting = false;
try {
  app.on('before-quit', () => { _appIsQuitting = true; });
} catch {
  // Running under ELECTRON_RUN_AS_NODE=1 — `app.on` may be unavailable.
}

// Debounced session-save on window close or open. Force-kill / crash /
// power loss between an explicit window close/open and the next autosave
// tick (or quit) would otherwise leave the snapshot stale. With this
// trailing-edge debounce, the on-disk snapshot is at most ~500ms stale
// from the user's last lifecycle-intent. A single shared timer coalesces
// mixed open+close bursts into one write 500ms after the last event.
// The open path is gated on !skipTracking so bulk session-restore does
// NOT trigger N extra saves (the periodic autosave covers that).
let _closeSaveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const CLOSE_SAVE_DEBOUNCE_MS = 500;
function scheduleSnapshotOnClose(): void {
  if (_appIsQuitting) return;
  if (_closeSaveDebounceTimer) clearTimeout(_closeSaveDebounceTimer);
  _closeSaveDebounceTimer = setTimeout(() => {
    _closeSaveDebounceTimer = null;
    if (_appIsQuitting) return;
    try {
      saveSessionSnapshot('window-lifecycle');
    } catch (err) {
      DEBUG && console.error('[session] Debounced lifecycle-save failed:', err);
    }
  }, CLOSE_SAVE_DEBOUNCE_MS);
}

// Shared debounce trigger for both close and open events — same timer,
// same 500ms trailing edge. Export so ipc.ts can call it from the
// window-open success path without duplicating the logic.
export { scheduleSnapshotOnClose as scheduleSnapshotOnLifecycleChange };

// Test-only: synchronously flush a pending debounced lifecycle-save. Drift-
// detection test for the close-survives-kill regression (see
// tests/desktop/session-restore-close-survives-kill.spec.ts) needs to
// observe the post-close snapshot deterministically without sleeping for
// 500ms. Cancels the in-flight timer and runs the save body directly.
// No-op if no timer is pending. The _appIsQuitting guard is intentionally
// dropped here — tests force a save regardless of quit state, and the
// test profile isn't a real quit anyway.
export function flushPendingCloseSave(): void {
  if (_closeSaveDebounceTimer) {
    clearTimeout(_closeSaveDebounceTimer);
    _closeSaveDebounceTimer = null;
  }
  try {
    saveSessionSnapshot('window-lifecycle');
  } catch (err) {
    DEBUG && console.error('[session] Manual lifecycle-save flush failed:', err);
  }
}

/**
 * Bounds/presentation captured for a window BEFORE its native handle is
 * destroyed, so the close-finalize tail can persist the correct content rect
 * for reopen-last-closed. Both window kinds capture this in their own `'close'`
 * (pre-destroy) listener and hand it to `finalizeWindowClose`.
 */
export interface CapturedClosePresentation {
  bounds: { x: number; y: number; width: number; height: number } | null;
  presentation: import('./window-presenter.js').WindowPresentation | null;
}

/**
 * The shared "close finalize tail" run for EVERY window when it is destroyed,
 * regardless of whether it is a `BrowserWindow` (canvas / generic) or a
 * `BaseWindow` (hybrid page-host). It does the three lifecycle side-effects a
 * close must produce once the window is gone:
 *
 *   (a) push the closed window onto the reopen stack (Cmd+Shift+T), gated by
 *       the same reopen-able / content-role / not-keepLive / not-modal /
 *       not-suppressed-during-quit policy the canvas path has always used;
 *   (b) retire the window's machine record (WINDOW_CLOSED — idempotent with
 *       the native 'closed' emission, and the ONLY reliable retire for a
 *       hybrid BaseWindow, which never emits 'closed' on the normal close
 *       path) and publish the post-retire `window:removed` signal (the
 *       deterministic "fully gone" gate that close-awaits and
 *       dedup-on-reopen wait on);
 *   (c) `scheduleSnapshotOnClose()` so a force-kill before the next autosave
 *       can't resurrect the just-closed window from a stale on-disk snapshot.
 *
 * This was extracted verbatim from the `browser-window-created → 'closed'`
 * handler below so the canvas behavior stays byte-identical, and is the SAME
 * routine the hybrid page-host's `baseWin 'closed'` handler invokes (ipc.ts
 * hybrid branch) — a `BaseWindow` never flows through `browser-window-created`,
 * so without this its reopen-stack push, `window:removed`, and close-snapshot
 * never ran. Each window finalizes EXACTLY ONCE: the two call sites are gated
 * to disjoint window kinds (BrowserWindow vs hybrid BaseWindow).
 *
 * `captured` carries the pre-destroy bounds/presentation; pass it from the
 * matching `'close'` listener (the window must still be alive when captured).
 */
export function finalizeWindowClose(windowId: number, captured: CapturedClosePresentation): void {
  const windowData = getWindowInfo(windowId);

  // (a) Save to closed window stack for reopen-last-closed.
  // Only save user-facing content windows with web URLs (not background, modals, palettes, etc.)
  // Skip during quit — session.ts already pushes all open windows during before-quit,
  // so pushing here too would create duplicates that shadow session-restored windows.
  if (windowData && !_suppressClosedWindowPush) {
    const address = windowData.params.address as string | undefined;
    const role = windowData.params.role as string | undefined;
    const isKeepLive = windowData.params.keepLive === true;
    const isModal = windowData.params.modal === true;
    const isWebUrl = address && (address.startsWith('http://') || address.startsWith('https://'));
    const isPeekUrl = address && address.startsWith('peek://');
    const isBackgroundPage = address && address.includes('background.html');
    const isReopenable = (isWebUrl || (isPeekUrl && !isBackgroundPage)) && !!address;
    const isContentRole = !role || role === 'content' || role === 'child-content' || role === 'workspace';

    if (isReopenable && isContentRole && !isKeepLive && !isModal) {
      // Check for space mode context
      let spaceMode: ClosedWindowEntry['spaceMode'] = null;
      try {
        const modeEntry = getContextEntry('mode', windowId);
        if (modeEntry && modeEntry.value === 'space' && modeEntry.metadata) {
          spaceMode = {
            spaceId: modeEntry.metadata.spaceId as string,
            spaceName: modeEntry.metadata.spaceName as string,
            color: modeEntry.metadata.color as string | undefined,
          };
        }
      } catch {
        // Context may be cleaned up already during shutdown
      }

      // Pull bounds + maximize state from the presentation captured
      // pre-destruction. The presenter reads the window-state machine via
      // the ONE restorable-geometry rule (window-presenter.ts
      // getRestorableBounds, §5 step 7D) for every window kind, so a
      // fullscreen/maximized window reopens at a sane rect.
      const saveBounds = captured.presentation?.bounds ?? captured.bounds;
      const saveMaximized = captured.presentation?.maximized ?? false;
      const savePreMaxBounds: ClosedWindowEntry['preMaximizeBounds'] =
        captured.presentation?.preMaxBounds ?? undefined;

      // Use the current navigated URL if available (tracks where user actually was)
      const currentUrl = windowData.params.currentUrl as string | undefined;
      const scrollX = windowData.params.scrollX as number | undefined;
      const scrollY = windowData.params.scrollY as number | undefined;

      pushClosedWindow({
        url: currentUrl || address,
        originalUrl: currentUrl ? address : undefined,
        source: windowData.source,
        bounds: saveBounds,
        spaceMode,
        role: role || undefined,
        scrollX: scrollX || undefined,
        scrollY: scrollY || undefined,
        maximized: saveMaximized || undefined,
        preMaximizeBounds: savePreMaxBounds,
        timestamp: Date.now(),
      });
    }
  }

  // (b) Retire the machine record, then publish the post-retire event — the
  // deterministic "the window is fully gone from the registry" signal.
  // Distinct from `window:closed`, which fires earlier (before pushClosedWindow
  // + retire) and so isn't a safe gate for "you can now re-open the same URL
  // without dedup matching the previous instance". Idempotent with the
  // backend's own native-'closed' WINDOW_CLOSED emission — and for a hybrid
  // BaseWindow (which never emits 'closed' on the normal close path) this
  // dispatch is the one that retires the record.
  {
    const wmId = getWindowIdFor(windowId);
    if (wmId != null) dispatchWindowEvent({ type: 'WINDOW_CLOSED', id: wmId });
  }
  try {
    publish('system', 'window:removed', { id: windowId });
  } catch (publishErr) {
    DEBUG && console.error('[lifecycle] window:removed publish failed:', publishErr);
  }
  // (c) Persist the now-shorter window list so a force-kill before the
  // next autosave tick doesn't bring the closed window back.
  scheduleSnapshotOnClose();
}

// Configuration
export interface AppConfig {
  rootDir: string;
  userDataPath: string;
  profile: string;
  isDev: boolean;
  isTest: boolean;
  darkMode?: string; // 'off' | 'system' | 'force'
}

// App state
let config: AppConfig;
// (The old `mainWindow` singleton is gone — window identity lives on the
// window-state machine's class-tagged records now; §4.3 dim 8b.)

// Diagnostic logger for external URL handling.
// Writes to /tmp/ so it's always accessible regardless of userData path.
// This can be removed once external URL handling is confirmed working.
function urlLog(msg: string): void {
  try {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync('/tmp/peek-url-debug.log', line);
  } catch {
    // Ignore write errors
  }
}

// External URL handling state
let _appReady = false;
let _pendingUrls: Array<{ url: string; sourceId: string }> = [];
// Frontend readiness: resolved when background window's app/index.js signals ready
let _frontendReadyResolve: (() => void) | null = null;
const _frontendReadyPromise = new Promise<void>(resolve => { _frontendReadyResolve = resolve; });
let _frontendReady = false;
// Session restore completion: resolved after session restore finishes (or is skipped)
let _sessionRestoreDoneResolve: (() => void) | null = null;
const _sessionRestoreDonePromise = new Promise<void>(resolve => { _sessionRestoreDoneResolve = resolve; });
let _sessionRestoreDone = false;

// Dev tiles loaded via --load-extension CLI flag
// These are transient (not persisted) and always have devtools open
const devTiles = new Map<string, { path: string }>();

// The window-manager registry (windowId -> { source, params }) lives on the
// window-state machine's window records now (window-manager.md §4.1 dim 1a,
// §5 step 4) — the module-level Map this file used to hold is DELETED. The
// exported accessors below (`registerWindow` / `getWindowInfo` /
// `findWindowByKey` / …) survive as the numeric-Electron-id seam over the
// machine state: records that carry a `source`+`params` payload are exactly
// the windows the old Map contained (ipc.ts open sites + the core background
// window); machine-registered infrastructure windows (tiles, bridge,
// extension-ui, test-fixture, devtools) carry none and stay invisible to
// these accessors, preserving the old registry's membership.

// Recently closed windows stack (in-memory, most recent last)
const MAX_CLOSED_WINDOWS = 50;

export interface ClosedWindowEntry {
  url: string;           // Current URL at time of close (where user actually was)
  originalUrl?: string;  // Original URL the window was opened with
  source: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  spaceMode: { spaceId: string; spaceName: string; color?: string } | null;
  role?: string;         // Window role (workspace, content, etc.) — needed to restore peek:// windows correctly
  scrollX?: number;      // Scroll position at time of close
  scrollY?: number;
  maximized?: boolean;   // Page-host was maximized at close — restore directly into MAXIMIZED on reopen
  // Pre-maximize bounds: stored alongside `maximized` so reopen-after-close
  // can hand them to the page-host, letting unmaximize after reopen restore
  // to the size before the original maximize. Read from the page-host URL
  // params (preX/preY/preWidth/preHeight) at close time.
  preMaximizeBounds?: { x: number; y: number; width: number; height: number };
  timestamp: number;
}

const closedWindowStack: ClosedWindowEntry[] = [];

// Flag to suppress closed-window-stack pushes during quit.
// session.ts already pushes all open windows during before-quit,
// so the per-window 'closed' event handler must skip its push to avoid duplicates.
let _suppressClosedWindowPush = false;

export function suppressClosedWindowPush(): void {
  _suppressClosedWindowPush = true;
}

/**
 * Initialize the application configuration
 * Must be called before app.ready
 */
/**
 * Global error handlers — installed once, idempotent.
 *
 * Without these, rejected promises and thrown exceptions that escape
 * the feature/tile loading paths crash the process with no breadcrumb.
 * We install early in configure() so startup-time errors surface.
 */
let _globalErrorHandlersInstalled = false;
function installGlobalErrorHandlers(): void {
  if (_globalErrorHandlersInstalled) return;
  _globalErrorHandlersInstalled = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[main] Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('[main] Uncaught exception:', error);
  });
}

export function configure(cfg: AppConfig): void {
  // Install global error handlers FIRST, before anything else can throw,
  // so startup errors (protocol registration, config parsing, etc.) surface.
  installGlobalErrorHandlers();

  config = cfg;

  // Tier 1 dark mode: 'force' = always dark, 'off'/'system' = respect OS preference
  const darkMode = cfg.darkMode || 'system';
  nativeTheme.themeSource = (darkMode === 'force') ? 'dark' : 'system';

  // Register custom protocol scheme (must be before app.ready)
  registerScheme();
}

// Rule engine singleton — created during initialize() after the
// datastore + features are up. Held at module scope so it stays alive
// for the process lifetime.
let ruleEngine: RuleEngine | null = null;

/**
 * Initialize the application
 * Called after app.ready
 */
export async function initialize(): Promise<void> {
  if (!config) {
    throw new Error('App not configured. Call configure() first.');
  }

  // Initialize protocol handler
  initProtocol(config.rootDir);

  // Register tile:* IPC handlers BEFORE any BrowserWindow is created.
  // Without this, core renderers (cmd, hud, page) launching with
  // tile-preload would silently drop their `tile:validate-token` and
  // `tile:pubsub:*` IPC sends — handlers were historically registered
  // lazily from `loadTile()` which runs after core glue.
  ensureTileIpcHandlers();

  // Phase 8 — install dev-mode bypass detectors. These monkey-patch
  // WebContents.prototype.send and BrowserWindow.prototype.loadURL to
  // catch code paths that bypass the gate. Idempotent + safe to ship
  // in release; intended primarily for test / dev feedback.
  installDirectSendGuard();
  installOffPathWindowGuard();

  // Register the private `tile:lifecycle:ready` IPC handler. Must also
  // run before any BrowserWindow is created; the core background
  // renderer launched by `initCore()` sends `tile:lifecycle:ready` from
  // its preload `api.initialize()` resolution tick. `setReadyCallback`
  // injects the tile-launcher's `signalTileReady` so the lifecycle
  // module can drive LOADING→READY without importing tile-launcher
  // (one-way dependency: tile-launcher → tile-lifecycle).
  setLifecycleReadyCallback(signalTileReady);
  registerTileLifecycleIpc();

  // Resolve & cache the tile-preload path early (also used by `initCore`
  // from entry.ts before `loadFeatures` runs). Preload source is
  // `tile-preload.cts` (CommonJS) so tsc emits `tile-preload.cjs` —
  // Electron preload scripts must be CommonJS under `sandbox: true`.
  const tilePreloadPath = path.join(config.rootDir, 'dist', 'main', 'tile-preload.cjs');
  setTilePreloadPath(tilePreloadPath);

  // Inject tile-launcher's electron-side dependencies. These live on
  // modules that tile-launcher can't import at its top level (they
  // transitively ESM-import BrowserWindow, which blows up under
  // ELECTRON_RUN_AS_NODE=1 during unit tests). See `configureTileLauncher`
  // for the why.
  configureTileLauncher({
    getProfileSession,
    getSystemThemeBackgroundColor,
    // Register each tile window with the window-state machine so a focused tile
    // becomes the command target (the OS adapter attaches its focus listeners).
    // Front-ineligibility (satellite) uses the shared `isSatelliteRegistration`
    // predicate — same rule as the ipc.ts window-open site. A tile defaults to
    // the front-eligible 'workspace' role.
    registerWindow: (win, role, keepLive) => registerWindowWithMachine({
      kind: 'browser',
      role: role ?? 'workspace',
      class: classifyWindowRegistration(role ?? 'workspace', {
        alwaysOnTop: win.isAlwaysOnTop(),
        focusable: win.isFocusable(),
      }),
      satellite: isSatelliteRegistration(role ?? 'workspace', { focusable: win.isFocusable() }),
      win,
      contentWC: win.webContents,
      // A keepLive tile entry's flag lands on the reducer record so the
      // machine's WINDOW_CLOSE_OR_HIDE_REQUESTED clause hides instead of
      // closing (the tile-launcher 'close' intercept dispatches that intent).
      keepLive: keepLive === true,
    }),
    // Tile close routes through the machine (WINDOW_CLOSE_REQUESTED →
    // CLOSE_WINDOW_DIRECT → backend). Injected — tile-launcher cannot import
    // the singleton (its unit tests run under ELECTRON_RUN_AS_NODE=1, where
    // the backend's value-side electron import dies at parse).
    closeTileWindow: (win) => {
      const id = getWindowIdFor(win);
      if (id == null) {
        console.error('[tile-launcher] closeTileWindow: window', win.id, 'is not machine-registered — cannot close (leak risk)');
        return;
      }
      dispatchWindowEvent({ type: 'WINDOW_CLOSE_REQUESTED', id });
    },
    // keepLive close intercept (tile-launcher's 'close' handler): dispatch the
    // INTENT — the reducer branches on the record's keepLive (hide vs the
    // resolved close). Injected for the same ELECTRON_RUN_AS_NODE reason as
    // closeTileWindow above.
    closeOrHideTileWindow: (win) => {
      const id = getWindowIdFor(win);
      if (id == null) {
        console.error('[tile-launcher] closeOrHideTileWindow: window', win.id, 'is not machine-registered — cannot hide');
        return;
      }
      dispatchWindowEvent({ type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED', id });
    },
    // NOTE: no `addEscHandler` hook — the ESC before-input interceptor is
    // attached by `registerWindowWithMachine` itself now, so registration is the
    // single owner and a window registered twice can't get two interceptors.
  });

  // Install the load-on-dispatch pre-publish hook. Every subsequent
  // `cmd:execute:{name}` or declared-lazyEvent publish passes through
  // this hook, which awaits the owning tile's boot before letting the
  // publish reach subscribers. Must run before any command can fire
  // (i.e. before loadFeatures / initializeFeatures).
  installLoadOnDispatchHook();

  // Initialize database
  const dbPath = path.join(config.userDataPath, config.profile, 'datastore.sqlite');
  initDatabase(dbPath);

  // First-launch onboarding: seed demo content into a brand-new profile so the
  // empty-state teaches the surface. No-op after the first run and for existing
  // profiles. Runs before any window/pubsub — the fresh UI reads the seeded DB
  // when it first renders, so nothing needs to be broadcast.
  seedOnboardingIfNeeded();

  // Hydrate runtime debug flags from persisted state. Must run after
  // initDatabase so feature_settings is readable; before any feature loads
  // so the flags are correct from the first DEBUG && console.log call.
  installDebugFlagsPersistence();

  // One-time migration: move any stale user-scope MCP registration from the
  // dead ~/.claude/settings.json (Claude Code never read `mcpServers` there)
  // to ~/.claude.json where it's actually honored. Self-guards on
  // packaged+default profile; no DB dependency; idempotent after first run.
  migrateMcpConfigLocation();

  // Set up pubsub broadcaster.
  // Forwards GLOBAL publishes to every renderer that needs to see them:
  // bgWindow (core), tile BrowserWindows, and peek:// webview guests.
  // All send() calls are wrapped in try-catch to prevent errors during shutdown
  // when windows are being destroyed concurrently (race between isDestroyed check and send).
  setPubsubBroadcaster((topic, msg, source) => {
    // Broadcast to bgWindow (core orchestrator).
    // bgWindow hosts app/index.js which runs cmd/page/hud registries and is a
    // first-class pubsub subscriber. Every publish must reach it — historical
    // omissions from this loop were directly responsible for "hello-world-only
    // commands visible in cmd panel" and "tile cmd:execute:*:result never
    // reaches core subscribers" bug classes. bgWindow is NOT a tile; it is
    // broadcast to explicitly rather than via getAllTileWindows().
    const bgWindow = getCoreBackgroundWindow();
    if (bgWindow && !bgWindow.isDestroyed()) {
      try {
        const winUrl = bgWindow.webContents.getURL();
        if (winUrl !== source) {
          unguardedWebContentsSend(bgWindow.webContents, `pubsub:${topic}`, { ...(msg as object), source });
        }
      } catch {
        // Window may have been destroyed between check and send
      }
    }

    // Broadcast to tile BrowserWindows (launched by tile-launcher).
    // Without this, tiles that subscribe to global pubsub events (editor:open,
    // item:created, etc.) never receive them.
    //
    // Skip bgWindow if it appears in the tile registry — it is registered there
    // via `registerTrustedBuiltinWindow` for lifecycle/cleanup bookkeeping, but
    // we already sent to it above. Without this guard, bgWindow would receive
    // each frame twice.
    //
    // Echo-prevention compares FULL source URL against FULL window URL rather
    // than just the peek host. One feature tile can have multiple
    // BrowserWindows sharing the same host (e.g. websearch has peek://websearch/
    // background.html AND peek://websearch/home.html). A host-level compare
    // treats those siblings as the same sender and silently drops their
    // intra-feature pubsub round-trips. Full-URL compare only excludes the
    // exact originating window, allowing sibling entries to receive.
    for (const tileWin of getAllTileWindows()) {
      if (tileWin === bgWindow) continue;
      try {
        const winUrl = tileWin.webContents.getURL();
        if (winUrl !== source) {
          unguardedWebContentsSend(tileWin.webContents, `pubsub:${topic}`, { ...(msg as object), source });
        }
      } catch {
        // Window may have been destroyed between check and send
      }
    }

    // Broadcast to webview guests that are themselves peek:// tiles (HUD
    // widgets, page-canvas webviews, etc.). These guest webContents each
    // run a tile-preload with a capability token and subscribe to pubsub,
    // but they are NOT returned by `getAllTileWindows()` (that registry
    // only tracks top-level BrowserWindows), so without this second pass
    // their subscribers never fire. Filter by `getType() === 'webview'`
    // and peek:// URLs to avoid broadcasting into arbitrary http(s)
    // content webviews. Same full-URL echo-prevention as above.
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (wc.isDestroyed()) continue;
        if (wc.getType() !== 'webview') continue;
        const url = wc.getURL();
        if (!url.startsWith('peek://')) continue;
        if (url !== source) {
          unguardedWebContentsSend(wc, `pubsub:${topic}`, { ...(msg as object), source });
        }
      } catch {
        // WebContents may have been destroyed mid-iteration
      }
    }
  });

  // ESC grab + focused-window/fullscreen state are owned by the window-state
  // machine now. The OS-level `globalShortcut('Escape')` grab is DERIVED (§2.4):
  // registered ⇔ `appActive && front === null && !switcher.open`, reconciled by
  // the OS adapter's subscriber on EVERY transition — replacing the old
  // `updateEscGlobalRegistration` + its 5 re-evaluation call sites
  // (browser-window-focus/blur, did-become/resign-active, onActiveHybridWindowChange).
  // Its handler dispatches `ESC_PRESSED('global')` into the SAME `decideEscape`
  // the before-input path uses, so a stale grab is harmless.
  //
  // Stand the machine up: construct the single adapter, attach its app-level
  // `did-become/resign-active` listeners (→ APP_ACTIVATED/RESIGNED), and seed
  // the izui→machine session mirror.
  initWindowStateMachine();

  // Track OS-level app focus for IZUI transient detection.
  // When Peek is the active app, windows opened are "active."
  // When Peek is in the background, windows opened are "transient."
  if (process.platform === 'darwin') {
    // macOS: use did-become-active / did-resign-active for reliable OS-level focus.
    // browser-window-blur/focus are per-window and unreliable with utility windows
    // (e.g. HUD with alwaysOnTop+focusable:false confuses getFocusedWindow()).
    (app as any).on('did-become-active', () => {
      getIzuiCoordinator().setAppFocused(true);
      publish(getSystemAddress(), 'app:focus-changed', { focused: true });
      // Cold-start trailing-dance safety net: if a boot restore activated the
      // saved-focused window and the macOS startup dance then fired a trailing
      // did-resign-active (re-stranding Peek), re-raise that window ONCE on the
      // first activation after restore. Self-gating one-shot — no-op unless the
      // latch was armed (cold start + non-headless). See session.ts.
      reassertColdStartFocusOnce();
      // (HUD re-show removed — the reducer's APP_ACTIVATED clause re-shows
      // the class-'hud' windows its APP_RESIGNED sweep hid, via SHOW_WINDOW
      // effects; the executor skips them under headless. The `__hudHidden`
      // expando is gone — the record's `hiddenByAppBlur` flag replaced it.)
      //
      // (Esc-grab re-evaluation removed — the machine's adapter reconciles the
      // derived grab on APP_ACTIVATED, which its own did-become-active listener
      // dispatches.)
    });
    (app as any).on('did-resign-active', () => {
      const coordBefore = getIzuiCoordinator();
      DEBUG && console.log('[izui] did-resign-active fired. state:', coordBefore.getState(), 'isOverlay:', coordBefore.isOverlay(), 'exitCooldown:', coordBefore.isWithinOverlayExitCooldown(), 'entryCooldown:', coordBefore.isWithinOverlayEntryCooldown());
      coordBefore.setAppFocused(false);
      publish(getSystemAddress(), 'app:focus-changed', { focused: false });

      // Close overlay window (e.g. windows switcher) when app loses OS focus.
      // The overlay is a transient full-screen picker that should dismiss when the user
      // Cmd+Tabs away.
      //
      // COOLDOWN GUARDS:
      // 1. EXIT cooldown: After an overlay closes, window restoration can trigger a brief
      //    did-resign-active → did-become-active cycle (macOS focus dance). Skip overlay
      //    close if we just exited an overlay — prevents closing a newly opened overlay.
      // 2. ENTRY cooldown: When an overlay opens, hiding all regular windows can trigger
      //    did-resign-active because only a panel-type window remains (macOS panels don't
      //    count as main windows for app activation). Skip overlay close if one just opened.
      const coordinator = getIzuiCoordinator();
      if (!coordinator.isWithinOverlayExitCooldown() && !coordinator.isWithinOverlayEntryCooldown()) {
        for (const [id, data] of getAllWindows()) {
          if (data.params.role === 'overlay') {
            const overlayWin = getLiveWindow(id);
            if (overlayWin) {
              DEBUG && console.log('[izui] App lost focus while overlay open, closing overlay window:', id);
              // Use app-blur exit path: restores hidden windows but does NOT focus any,
              // so we don't steal focus from the app the user is switching to.
              coordinator.exitOverlayForAppBlur();
              // Mark this window so the 'closed' handler knows not to do overlay restoration
              (overlayWin as any).__closedDueToAppBlur = true;
              overlayWin.close();
            }
            break;
          }
        }
      } else {
        DEBUG && console.log('[izui] Skipping overlay close in did-resign-active (within cooldown: exit=', coordinator.isWithinOverlayExitCooldown(), 'entry=', coordinator.isWithinOverlayEntryCooldown(), ')');
      }

      // (HUD hide removed — the reducer's APP_RESIGNED clause hides the
      // visible class-'hud' windows via HIDE_WINDOW effects. The class field
      // replaced the `isAlwaysOnTop() && !isFocusable()` sniffing predicate;
      // focusable alwaysOnTop windows classify 'palette'/'primary' and are
      // untouched, same as the old sweep's isFocusable() skip.)
      //
      // (Esc-grab drop removed — the machine's adapter reconciles the derived
      // grab on APP_RESIGNED, which its own did-resign-active listener
      // dispatches; `appActive:false` makes the grab predicate false.)
    });
  } else {
    // Non-macOS fallback: use browser-window-focus/blur with focused-window check
    app.on('browser-window-focus', () => {
      getIzuiCoordinator().setAppFocused(true);
      publish(getSystemAddress(), 'app:focus-changed', { focused: true });
    });
    app.on('browser-window-blur', () => {
      // Only mark unfocused if NO window has focus (user switched to another app).
      // During window switches within Peek, one window blurs before another focuses.
      if (!BrowserWindow.getFocusedWindow()) {
        getIzuiCoordinator().setAppFocused(false);
        publish(getSystemAddress(), 'app:focus-changed', { focused: false });
      }
    });
  }

  // ── Registration tripwire (observe-only) ──────────────────────────────
  // Assert that every newly created native window promptly registers with
  // the window-state machine (getWindowIdFor(win) != null). An unregistered
  // live window is invisible to the machine: focus/front/escape decisions
  // route around it. Mirrors the headless visible-at-construction guard in
  // entry.ts. Loud (exitCode + throw) in test/dev profiles; console.error
  // only in production. The tripwire ONLY observes — it never registers,
  // shows, or otherwise mutates a window.
  //
  // Why a 5000ms setTimeout and not setImmediate: this is a sanctioned
  // OS/Chromium-boundary workaround at the lowest layer — Electron emits no
  // 'base-window-created' or registration-complete signal to hook, and
  // registration is legitimately deferred after construction:
  // assembleHybridPageHost (ipc.ts) constructs the BaseWindow first and
  // calls registerWindowWithMachine later in async assembly (the documented
  // construct→register gap that destroyUnassembledHybridHost exists for),
  // and detached-devtools BrowserWindows register lazily on
  // 'devtools-opened'. A timed deferred observation is the only available
  // hook. Do not stack another timer/poll on top of this one.
  const REGISTRATION_TRIPWIRE_DELAY_MS = 5000;
  // Dedup: a window can reach the tripwire via both hooks below
  // (browser-window-created for BrowserWindows, web-contents-created owner
  // resolution for BaseWindows); first check claims the window.
  const registrationTripwireChecked = new WeakSet<Electron.BaseWindow>();
  const fireRegistrationTripwire = (win: Electron.BaseWindow, origin: string): void => {
    // A destroyed window went through teardown; the tripwire hunts live
    // unregistered leaks.
    if (win.isDestroyed()) return;
    if (registrationTripwireChecked.has(win)) return;
    registrationTripwireChecked.add(win);
    if (getWindowIdFor(win) != null) return;
    let url = '(no-url)';
    try {
      const wc = (win as BrowserWindow).webContents;
      url = wc ? (wc.getURL() || '(no-url)') : '(no-webcontents)';
    } catch {
      /* webContents gone mid-teardown */
    }
    const msg = `[registration-tripwire] window id=${win.id} (via ${origin}) still unregistered with the window-state machine ${REGISTRATION_TRIPWIRE_DELAY_MS}ms after creation url=${url} — every live native window must go through registerWindowWithMachine`;
    console.error(msg);
    console.error(new Error(msg).stack);
    if (isTestProfile() || isDevProfile()) {
      process.exitCode = 1;
      throw new Error(msg);
    }
  };

  // Track window events globally
  app.on('browser-window-created', (_, window) => {
    // Registration tripwire, hook 1: every BrowserWindow. (See the boundary
    // comment above for why this is a timer.)
    setTimeout(() => fireRegistrationTripwire(window, 'browser-window-created'), REGISTRATION_TRIPWIRE_DELAY_MS);
    const windowId = window.id;

    // Capture the window's canonical presentation before destruction so the
    // 'closed' handler can persist correct bounds, address, and maximize
    // state for reopen-last-closed. The presenter encapsulates the canvas /
    // generic split — main.ts no longer parses the page-host shell URL.
    let lastBounds: { x: number; y: number; width: number; height: number } | null = null;
    let lastPresentation: import('./window-presenter.js').WindowPresentation | null = null;
    window.on('close', () => {
      try {
        if (!window.isDestroyed()) {
          // Machine-owned geometry (§5 step 7D): the raw-bounds fallback
          // (used when the presentation below is null) reads the machine via
          // the ONE restorable-geometry rule (window-presenter.ts
          // getRestorableBounds — fullscreen → preBounds, else the bounds
          // mirror) so undo-close of a fullscreen/maximized window restores
          // sanely. The live getBounds() survives only for a window the
          // machine never saw (unregistered — the tripwire hunts those).
          lastBounds = getRestorableBounds(getWindowIdFor(window)) ?? window.getBounds();
          lastPresentation = getWindowPresentation(windowId);
        }
      } catch {
        // Ignore errors during shutdown
      }

      // (Pre-close overlay restoration removed — the overlay no longer
      // hides other windows, so there's nothing to restore. See
      // apps/desktop/main/ipc.ts windowOpenHandler for the rationale.)
    });

    // Handle window close
    // Wrapped in try-catch to prevent errors during shutdown from stalling the quit sequence.
    // During app.quit(), windows close concurrently and some may already be destroyed.
    window.on('closed', () => {
      try {
        const windowData = getWindowInfo(windowId);

        const coordinator = getIzuiCoordinator();

        // (Stale-front cleanup removed — the window-state machine clears `front`
        // on WINDOW_CLOSED, dispatched by the OS adapter's own 'closed' listener
        // for every registered window; the overlay-window close likewise clears
        // the mirrored switcher state via that same WINDOW_CLOSED.)

        // (Parent refocus removed — a window registered with `parentWindowId`
        // carries `parentId` on its machine record, and the reducer's
        // WINDOW_CLOSED transition hands `front` back to the parent + emits
        // the raise. See window-state.ts.)

        if (windowData) {
          // Check if this overlay was already handled by the app-blur path.
          // When the user Cmd+Tabs away, did-resign-active calls exitOverlayForAppBlur()
          // (which restores windows without focusing) before closing the overlay window.
          // In that case, skip all overlay restoration logic here.
          const closedDueToAppBlur = (window as any).__closedDueToAppBlur === true;

          // Overlay restoration: use coordinator as single source of truth
          const isOverlayWindow = coordinator.isOverlay() && coordinator.getSession()?.overlayWindowId === windowId;
          if (isOverlayWindow) {
            const session = coordinator.getSession()!;
            const isTransient = coordinator.isTransient();

            if (!isTransient) {
              // Capture the explicit selection BEFORE exitOverlay clears it.
              // Important: ONLY focus when the user explicitly chose a target
              // via the switcher (overlayFocusTarget). On a plain ESC dismiss
              // overlayFocusTarget is null and we fall through with no
              // focus call — that preserves the user's current Space, which
              // .focus() on the preOverlayFocusTarget would silently break
              // if that window happened to be anchored to a different Space.
              const selectedTargetId = session.overlayFocusTarget;

              // exitOverlay resets overlay state (the hiddenWindowIds list
              // is empty in the no-hide overlay model, so the showInactive
              // loop inside is a no-op).
              coordinator.exitOverlay();

              if (selectedTargetId != null) {
                const targetWin = getLiveWindow(selectedTargetId);
                if (targetWin) {
                  DEBUG && console.log('[izui] Overlay explicit selection focus:', selectedTargetId);
                  targetWin.focus();
                } else {
                  // Hybrid page-hosts are BaseWindows, invisible to
                  // getLiveWindow. Route focus to the host BaseWindow so
                  // selecting a hybrid window in the switcher focuses it just
                  // like a canvas page. No-op (null) when the flag is off.
                  const hybrid = getHybridWindow(selectedTargetId);
                  if (hybrid && !hybrid.baseWin.isDestroyed()) {
                    DEBUG && console.log('[izui] Overlay explicit selection focus (hybrid):', selectedTargetId);
                    hybrid.baseWin.focus();
                  }
                }
              }
            } else {
              DEBUG && console.log('[izui] Overlay closed in transient mode - not restoring windows');
            }

            // Pop AFTER exitOverlay — order matters to avoid premature session end
            coordinator.popWindow(windowId);
          } else if (closedDueToAppBlur) {
            // App-blur path already handled restoration via exitOverlayForAppBlur().
            // Just pop the window from the stack — no focus, no restoration needed.
            DEBUG && console.log('[izui] Overlay closed due to app blur — skipping restoration (already handled)');
            coordinator.popWindow(windowId);
          } else {
            // Non-overlay close. There used to be a fallback here that
            // re-showed `params.overlayHiddenWindows` for a "non-coordinator"
            // overlay, left behind when 9904f113 stopped the switcher hiding
            // windows. Nothing has written that key since, so the branch could
            // only ever be entered with an empty list — it is gone along with
            // the rest of the side channel (§5 step 11 task 6).
            coordinator.popWindow(windowId);
          }

          publish(windowData.source, 'window:closed', {
            id: windowId,
            source: windowData.source
          });
        }

        // Close-finalize tail — push to the reopen stack, drop from the
        // registry + publish `window:removed`, and schedule the close-snapshot.
        // Extracted into a shared routine so a hybrid page-host BaseWindow
        // (which never flows through `browser-window-created`) runs the
        // identical tail from its own `baseWin 'closed'` handler. Bounds come
        // from the presentation captured in this window's pre-destroy 'close'
        // listener above.
        finalizeWindowClose(windowId, {
          bounds: lastBounds,
          presentation: lastPresentation,
        });
      } catch (err) {
        // During shutdown, errors here must not prevent the quit sequence
        DEBUG && console.error('[lifecycle] Error in window closed handler:', err);
        try {
          const wmId = getWindowIdFor(windowId);
          if (wmId != null) dispatchWindowEvent({ type: 'WINDOW_CLOSED', id: wmId });
        } catch {
          // already in error path; suppress
        }
        try {
          publish('system', 'window:removed', { id: windowId });
        } catch {
          // already in error path; suppress
        }
        scheduleSnapshotOnClose();
      }
    });

    // Handle local shortcuts (with window ID for mode-conditional shortcuts)
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'l') {
        const mod = process.platform === 'darwin' ? input.meta : input.control;
        if (mod && !input.alt && !input.shift) {
          // Hybrid page-host shared-chrome overlay: a real BrowserWindow
          // loading peek://app/page/overlay.html. When R1/R2/R3 focuses it
          // (overlayWin.focus on page:show-navbar), Cmd+L lands here. Skip
          // the local-shortcut dispatch so the overlay's <peek-navbar>
          // (shortcuts=true) handles Cmd+L → focusUrl instead of opening the
          // cmd panel. Detected via the focused window's own webContents URL
          // to avoid importing hybrid-overlay.ts (which imports from
          // main.js → cycle).
          let focusedUrl = '';
          try {
            focusedUrl = window.webContents.getURL();
          } catch {
            // webContents may be gone mid-teardown; treat as non-overlay.
          }
          if (focusedUrl.includes('page/overlay.html')) {
            return; // Let the overlay's <peek-navbar> handle Cmd+L
          }
        }
      }

      if (handleLocalShortcut(input, windowId)) {
        event.preventDefault();
      }
    });
  });

  // Devtools windows register like everything else (window-manager.md §4.6
  // dim 8a): on 'devtools-opened' the detached devtools window (when one
  // exists — attached mode has none) registers with class 'devtools', parented
  // to its host so closing it hands `front` back; and both open/close edges
  // dispatch into the machine, whose transitions invalidate + re-drive the
  // front assertion (the machine form of the old scattered "re-focus the
  // content window around devtools" handlers).
  app.on('web-contents-created', (_e, wc) => {
    const hostMachineId = (): import('./window-state.js').WindowId | null => {
      try {
        // For hybrid page-host content this resolves the owning BaseWindow
        // (the documented windowFromWebContents TRAP — desired here); both
        // kinds are machine-registered.
        const owner = BrowserWindow.fromWebContents(wc);
        return owner ? getWindowIdFor(owner) : null;
      } catch {
        return null;
      }
    };
    wc.on('devtools-opened', () => {
      const hostId = hostMachineId();
      try {
        const devWC = wc.devToolsWebContents;
        const devWin = devWC ? BrowserWindow.fromWebContents(devWC) : null;
        const hostWin = BrowserWindow.fromWebContents(wc);
        if (devWC && devWin && (!hostWin || devWin.id !== hostWin.id)) {
          registerWindowWithMachine({
            kind: 'browser',
            role: 'utility',
            class: 'devtools',
            satellite: isSatelliteRegistration('utility', { windowClass: 'devtools' }),
            win: devWin,
            contentWC: devWC,
            // Devtools owns its own Escape; a main-side interceptor would
            // swallow it before the devtools UI ever saw the keystroke.
            attachEscHandler: false,
            parentId: hostId,
          });
        }
      } catch {
        /* detached devtools window not resolvable — attached mode, or races teardown */
      }
      if (hostId != null) dispatchWindowEvent({ type: 'DEVTOOLS_OPENED', id: hostId });
    });
    wc.on('devtools-closed', () => {
      const hostId = hostMachineId();
      if (hostId != null) dispatchWindowEvent({ type: 'DEVTOOLS_CLOSED', id: hostId });
    });

    // Registration tripwire, hook 2: BaseWindow coverage. Electron has no
    // 'base-window-created' event, so hybrid page-host BaseWindows are
    // reached through their content WC: BrowserWindow.fromWebContents here
    // intentionally also resolves owning hybrid BaseWindows (the documented
    // windowFromWebContents TRAP — desired, same as hostMachineId above).
    // Owner is resolved at fire time, after the delay, because at
    // web-contents-created time the WC may not be attached to its window
    // yet. A null owner means the WC has no window — not a violation.
    // (See the boundary comment above browser-window-created for why this
    // is a timer.)
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      let owner: Electron.BaseWindow | null = null;
      try {
        owner = BrowserWindow.fromWebContents(wc);
      } catch {
        /* races teardown */
      }
      if (owner) fireRegistrationTripwire(owner, 'web-contents-created');
    }, REGISTRATION_TRIPWIRE_DELAY_MS);
  });
}

/**
 * Discover and register built-in features (each feature is a tile).
 */
export function discoverBuiltinFeatures(featuresDir: string): void {
  const discovered = discoverFeatures(featuresDir);
  for (const feat of discovered) {
    registerTilePath(feat.id, feat.path);
  }
}

/**
 * Required CSS variables that every theme must define.
 * Used by validateThemeCSS() to verify theme completeness.
 */
const REQUIRED_THEME_VARIABLES = [
  // Base16 colors
  '--base00', '--base01', '--base02', '--base03',
  '--base04', '--base05', '--base06', '--base07',
  '--base08', '--base09', '--base0A', '--base0B',
  '--base0C', '--base0D', '--base0E', '--base0F',
  // Semantic aliases
  '--theme-bg', '--theme-bg-secondary', '--theme-bg-tertiary',
  '--theme-text', '--theme-text-secondary', '--theme-text-muted',
  '--theme-border', '--theme-accent',
  '--theme-success', '--theme-warning', '--theme-danger',
  // Surface tokens
  '--theme-surface-border', '--theme-surface-ring',
  // Typography
  '--theme-font-sans', '--theme-font-mono',
];

/**
 * Validate that a theme CSS file defines all required variables.
 * Returns { valid: true } or { valid: false, missing: string[] }
 */
export function validateThemeCSS(cssPath: string): { valid: boolean; missing?: string[] } {
  if (!fs.existsSync(cssPath)) {
    return { valid: false, missing: REQUIRED_THEME_VARIABLES };
  }

  const css = fs.readFileSync(cssPath, 'utf-8');
  const missing = REQUIRED_THEME_VARIABLES.filter(v => !css.includes(v));

  if (missing.length > 0) {
    return { valid: false, missing };
  }
  return { valid: true };
}

/**
 * Discover and register built-in themes.
 * Scans the extensions directory for manifests with "type": "theme".
 * Also scans a legacy themes directory for backward compatibility.
 */
export function discoverBuiltinThemes(extensionsDir: string, legacyThemesDir?: string): void {
  // Scan extensions directory for theme-type extensions
  if (fs.existsSync(extensionsDir)) {
    const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const themePath = path.join(extensionsDir, entry.name);
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

        // Only register extensions with type: "theme"
        if (manifest.type !== 'theme') continue;

        const themeId = manifest.id || entry.name;

        // Validate theme CSS on discovery
        const variablesFile = manifest.variables || './variables.css';
        const cssPath = path.join(themePath, variablesFile.replace(/^\.\//, ''));
        const validation = validateThemeCSS(cssPath);
        if (!validation.valid) {
          console.warn(`[theme] Theme ${themeId} missing required variables:`, validation.missing);
          // Still register it — warn but don't block built-in themes
        }

        registerThemePath(themeId, themePath);
        DEBUG && console.log('Discovered theme extension:', themeId);
      } catch (err) {
        console.error('Failed to load theme manifest:', entry.name, err);
      }
    }
  }

  // Legacy fallback: scan old themes/ directory for themes not yet migrated
  if (legacyThemesDir && fs.existsSync(legacyThemesDir)) {
    const entries = fs.readdirSync(legacyThemesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const themePath = path.join(legacyThemesDir, entry.name);
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const themeId = manifest.id || entry.name;

        // Skip if already registered from extensions directory
        if (getRegisteredThemeIds().includes(themeId)) {
          DEBUG && console.log('Theme already registered from extensions, skipping legacy:', themeId);
          continue;
        }

        registerThemePath(themeId, themePath);
        DEBUG && console.log('Discovered legacy theme:', themeId);
      } catch (err) {
        console.error('Failed to load legacy theme manifest:', entry.name, err);
      }
    }
  }
}


/**
 * Load all enabled features. Each feature is a tile.
 * - Builtin features (cmd/hud/page core renderers) launch via core-glue.
 * - Feature tiles in `features/` launch via the tile launcher (eager
 *   if any tile entry has `resident: true`, otherwise lazy stubs).
 */
export async function loadFeatures(): Promise<number> {
  const featStart = Date.now();

  const featuresDir = path.join(config.rootDir, 'features');
  // `tilePreloadPath` is now resolved + cached in `initialize()`. Read
  // it via the config getter so the value stays consistent whether we
  // were reached from `initialize()` or directly from a test harness.
  const tilePreloadPath = getTilePreloadPath();
  const loadedTileIds = new Set<string>();

  // cmd, hud, and page's command/shortcut wiring all run inside the
  // core background renderer (app/index.js awaits initCmd(), initHud(),
  // and initPage() at the top of its init). initCore — called earlier
  // in entry.ts — already blocked on `window.__coreReady`, set AFTER
  // core's init (including those subscribers) completes. So by the time
  // we reach feature loading below, cmd:register publishers always find
  // a live registry.

  // Launch the privileged test-fixture renderer when running under
  // Playwright (E2E_TEST=true). Tests access it via `getBackgroundWindow()`
  // in `tests/fixtures/desktop-app.ts`. A no-op in production.
  if (process.env.E2E_TEST === 'true') {
    try {
      await initTestFixture({ tilePreloadPath });
    } catch (err) {
      console.error('[main] initTestFixture failed (continuing anyway):', err);
    }
  }

  // ── Feature Startup ──
  // Run the feature-startup pipeline: discover, sync registry, and load tile manifests.
  // This runs AFTER initCmd so tile-lazy's cmd:register-batch publishes reach cmd.
  try {
    const featureResult: FeatureStartupResult = initializeFeatures({
      appDataDir: config.userDataPath,
      builtinFeaturesDir: featuresDir,
      tilePreloadPath,
    });
    for (const r of featureResult.loadResults) {
      if (r.loaded) loadedTileIds.add(r.id);
    }
    DEBUG && console.log(`[feature] Feature startup: ${loadedTileIds.size} tiles loaded`);
  } catch (err) {
    console.error('[feature] Feature startup failed:', err);
  }

  // ── Rule Engine ──
  // Stage 2 of peek MCP plan 3d7d9239. The engine subscribes to every
  // concrete topic referenced by an enabled rule and dispatches
  // matching events to scripts:execute. Created after feature-startup
  // so manifest-declared rules are already reconciled into the table.
  try {
    ruleEngine = createRuleEngine({
      pubsub: {
        publish: (source, topic, msg) => publish(source, topic, msg),
        subscribe: (source, topic, cb) => subscribe(source, topic, cb),
        unsubscribe: (source, topic) => unsubscribe(source, topic),
      },
      listEnabledRules: () => rulesList(getDb() as unknown as RulesDb, { enabled: true }),
    });
  } catch (err) {
    console.error('[rule-engine] init failed:', err);
  }

  // Phase 1: Early
  publish('system', 'feature:startup:phase', { phase: 'early' });

  // Phase 2: Commands
  publish('system', 'feature:startup:phase', { phase: 'commands' });

  // Lazy command stubs and lazy event interceptors live in `tile-lazy.ts` —
  // `registerLazyTile()` (called from tile-compat) publishes
  // `cmd:register-batch` and the pre-publish dispatch hook handles
  // load-on-dispatch for `cmd:execute:*` and declared `lazyEvents`.
  // Declarative `type: 'window'` and `type: 'publish'` commands are
  // short-circuited inside the hook without loading the tile.

  DEBUG && console.log(`[feature:timing] startup total: ${Date.now() - featStart}ms`);

  // Phase 3: UI
  publish('system', 'feature:startup:phase', { phase: 'ui' });

  // Phase 4: Complete
  publish('system', 'feature:startup:phase', { phase: 'complete' });
  publish('system', 'feature:all-loaded', { count: 0 });

  return 0;
}

// Core renderers that are always considered "running" once the app has started.
// These are not feature tiles (no tile manifest in features/) but the
// Features pane should always show them as running.
const CORE_RENDERER_IDS = ['cmd', 'hud', 'page'];

/**
 * Get running tiles info.
 * Includes core renderers and feature tiles launched by the tile-launcher.
 */
export function getRunningTiles(): Array<{ id: string; manifest: unknown; status: string }> {
  const running: Array<{ id: string; manifest: unknown; status: string }> = [];

  // Add core renderers (cmd, hud, page) — always running once app is up
  for (const tileId of CORE_RENDERER_IDS) {
    if (!isBuiltinFeatureEnabled(tileId)) continue;
    const tilePath = getTilePath(tileId);
    const manifest = tilePath ? loadFeatureManifest(tilePath) : null;
    running.push({
      id: tileId,
      manifest: manifest || { id: tileId },
      status: 'running'
    });
  }

  // Add tiles launched by the tile-launcher as separate BrowserWindows.
  for (const tileId of getLoadedTileIds()) {
    if (running.some(r => r.id === tileId)) continue;
    if (!isBuiltinFeatureEnabled(tileId)) continue;
    const tileManifest = getTileManifest(tileId);
    running.push({
      id: tileId,
      manifest: tileManifest || { id: tileId },
      status: 'running'
    });
  }

  return running;
}

/**
 * Get all registered (discovered) builtin tiles, whether running or not.
 * Used by the Settings Features pane to show ALL tiles from the features/ directory.
 */
export function getAllRegisteredTiles(): Array<{ id: string; manifest: unknown; status: string }> {
  const registeredIds = getRegisteredTileIds();
  const result: Array<{ id: string; manifest: unknown; status: string }> = [];

  // Build a set of running tile IDs for status info.
  // Sources: core renderers (always up) and loaded tiles.
  const runningSet = new Set<string>(CORE_RENDERER_IDS);
  for (const tileId of getLoadedTileIds()) {
    runningSet.add(tileId);
  }

  for (const tileId of registeredIds) {
    const tilePath = getTilePath(tileId);
    const manifest = tilePath ? loadFeatureManifest(tilePath) : null;
    result.push({
      id: tileId,
      manifest: manifest || { id: tileId },
      status: runningSet.has(tileId) ? 'running' : 'registered'
    });
  }

  return result;
}


/**
 * Check if a tile was loaded as a dev tile via the CLI --load-extension flag.
 */
export function isDevTile(tileId: string): boolean {
  return devTiles.has(tileId);
}

/**
 * Register a dev tile path for the CLI --load-extension flag.
 * These are transient and not persisted to datastore.
 */
export function registerDevTile(tileId: string, tilePath: string): void {
  devTiles.set(tileId, { path: tilePath });
  // Also register the path so the protocol handler can resolve peek://{tileId}/...
  registerTilePath(tileId, tilePath);
  DEBUG && console.log(`[tile:dev] Registered dev tile: ${tileId} from ${tilePath}`);
}

/**
 * Load a dev tile with devtools always open.
 */
export async function loadDevTile(tileId: string): Promise<object | null> {
  const devTile = devTiles.get(tileId);
  if (!devTile) {
    console.error(`[tile:dev] Dev tile not registered: ${tileId}`);
    return null;
  }

  // Relaunch tile: re-read manifest, revoke old token, close old window, launch fresh.
  const result = await relaunchTile(tileId);
  if (!result) {
    return null;
  }

  // Always open devtools for dev tiles (regardless of debug mode)
  if (!isHeadless()) {
    result.window.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  DEBUG && console.log(`[tile:dev] Loaded dev tile: ${tileId}`);
  return result;
}

/**
 * Load all registered dev tiles.
 */
export async function loadDevTiles(): Promise<number> {
  let count = 0;
  for (const [tileId] of devTiles) {
    const win = await loadDevTile(tileId);
    if (win) count++;
  }
  return count;
}

/**
 * Unload and clean up all dev tiles.
 */
export function cleanupDevTiles(): void {
  for (const [tileId] of devTiles) {
    DEBUG && console.log(`[tile:dev] Cleaned up dev tile: ${tileId}`);
  }
  devTiles.clear();
}

/**
 * Get list of dev tile IDs.
 */
export function getDevTileIds(): string[] {
  return Array.from(devTiles.keys());
}

/**
 * Reload a tile by closing and relaunching its window.
 * Returns a truthy result on success, null on failure.
 */
export async function reloadTile(tileId: string): Promise<object | null> {
  DEBUG && console.log(`[tile:reload] Reloading tile: ${tileId}`);

  // Check if it's a core renderer (cmd/hud/page) — not reloadable without a full app restart
  if (CORE_RENDERER_IDS.includes(tileId)) {
    console.error(`[tile:reload] Cannot reload core renderer: ${tileId} (reload the app instead)`);
    return null;
  }

  // For dev tiles, open devtools after relaunch
  if (isDevTile(tileId)) {
    return loadDevTile(tileId);
  }

  // Relaunch tile: re-read manifest, revoke old token, close old window, launch fresh.
  return relaunchTile(tileId);
}

/**
 * The numeric-id view over the machine's registry payload (see the note where
 * the old Map used to live). Enumerates only LIVE windows whose record
 * carries `source`+`params` — the exact membership the old Map had.
 */
function machineRegistryEntries(): Array<[number, { source: string; params: Record<string, unknown> }]> {
  const out: Array<[number, { source: string; params: Record<string, unknown> }]> = [];
  for (const rec of listMachineWindowRecords()) {
    if (rec.source === undefined || rec.params === undefined) continue;
    const native = getNativeWindowFor(rec.id);
    if (!native) continue; // destroyed mid-teardown — the old Map's entry was unreadable-by-liveness too
    out.push([native.id, { source: rec.source, params: rec.params }]);
  }
  return out;
}

/**
 * Attach the window-manager registry payload ({ source, params }) to an
 * already-machine-registered window. The ipc.ts open sites now pass the
 * payload directly on the registration spec; this export remains for the
 * merge callers that run AFTER `registerWindowWithMachine` (hybrid-overlay
 * test bridges, `createBackgroundWindow`).
 */
export function registerWindow(windowId: number, source: string, params: Record<string, unknown>): void {
  const id = getWindowIdFor(windowId);
  if (id == null) {
    DEBUG && console.log('[window-registry] registerWindow: window', windowId, 'is not machine-registered — payload dropped');
    return;
  }
  // Lift keepLive out of the opaque params bag onto the record FIRST-CLASS
  // (the payload-after-registration path, e.g. the hybrid test bridge) — the
  // reducer's WINDOW_CLOSE_OR_HIDE_REQUESTED clause branches on
  // `WindowRecord.keepLive`, never on params. Absent stays undefined so the
  // merge keeps any registration-time value.
  const keepLive = typeof params.keepLive === 'boolean' ? params.keepLive : undefined;
  dispatchWindowEvent({ type: 'WINDOW_PARAMS_SET', id, source, params, keepLive });
}

/**
 * Get window info from the machine's registry payload. Undefined for windows
 * that never carried one (tile windows, bridge/background infra) — same
 * contract as the deleted Map. The returned `params` is the SAME object
 * across calls (callers mutate it in place, e.g. `params.currentUrl`).
 */
export function getWindowInfo(windowId: number): { source: string; params: Record<string, unknown> } | undefined {
  const id = getWindowIdFor(windowId);
  if (id == null) return undefined;
  const rec = getMachineWindowRecord(id);
  if (!rec || rec.source === undefined || rec.params === undefined) return undefined;
  return { source: rec.source, params: rec.params };
}

/**
 * Find a window by source and key
 */
export function findWindowByKey(source: string, key: string): { id: number; window: BrowserWindow; data: unknown } | null {
  if (!key) return null;

  for (const [id, win] of machineRegistryEntries()) {
    if (win.source === source && win.params && win.params.key === key) {
      const browserWindow = getLiveWindow(id);
      if (browserWindow) {
        return { id, window: browserWindow, data: win };
      }
      // A live machine record whose id doesn't resolve to a BrowserWindow is
      // a hybrid BaseWindow (getLiveWindow is BrowserWindow.fromId-backed) —
      // skip it; hybrid dedup runs on the hybrid registry before this lookup.
      // (The old Map deleted "stale" entries here, which for a hybrid was a
      // live-entry deletion bug; the machine record retires on WINDOW_CLOSED.)
      DEBUG && console.log('findWindowByKey: id', id, 'has no live BrowserWindow — skipping');
    }
  }
  return null;
}

/**
 * Find an existing page-host window that has the given URL loaded (by address param).
 * Only searches for http/https URLs. Only matches page-host windows (canvas pages
 * with role 'content' or 'child-content'), NOT peeks, slides, modals, or other
 * non-page-host window types.
 */
export function findWindowByUrl(url: string): { id: number; window: BrowserWindow; data: unknown } | null {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;

  // Normalize the target once. Match registry addresses on their normalized
  // form too, so a re-open of the SAME page that differs only in trailing
  // slash, default port, or query-param order (e.g. `http://x/` vs `http://x`)
  // is recognized as already-open instead of spawning a duplicate window.
  // Reuses datastore's canonical `normalizeUrl` — the same helper `findUrlItem`
  // uses — so window dedupe and item lookup agree on URL identity.
  const normalizedTarget = normalizeUrl(url);

  for (const [id, win] of machineRegistryEntries()) {
    const address = win.params && typeof win.params.address === 'string'
      ? (win.params.address as string)
      : null;
    if (address && normalizeUrl(address) === normalizedTarget) {
      // Only match page-host windows (canvas pages), not peeks, slides, modals, etc.
      const role = win.params.role;
      if (role !== 'content' && role !== 'child-content') continue;

      const browserWindow = getLiveWindow(id);
      if (browserWindow) {
        return { id, window: browserWindow, data: win };
      }
    }
  }
  return null;
}

/**
 * Remove a window from the registry — machine form: retire its record
 * (idempotent with the WINDOW_CLOSED the native teardown emits).
 */
export function removeWindow(windowId: number): boolean {
  const id = getWindowIdFor(windowId);
  if (id == null || getMachineWindowRecord(id) === undefined) return false;
  dispatchWindowEvent({ type: 'WINDOW_CLOSED', id });
  return true;
}

/**
 * Get all child windows for a source
 */
export function getChildWindows(source: string): Array<{ id: number; data: { source: string; params: Record<string, unknown> } }> {
  const children = [];
  for (const [id, win] of machineRegistryEntries()) {
    if (win.source === source) {
      children.push({ id, data: win });
    }
  }
  return children;
}

/**
 * Get all registered windows
 */
export function getAllWindows(): Array<[number, { source: string; params: Record<string, unknown> }]> {
  return machineRegistryEntries();
}

/**
 * Push a closed window entry onto the stack.
 * Persists to DB so the stack survives restarts.
 */
export function pushClosedWindow(entry: ClosedWindowEntry): void {
  closedWindowStack.push(entry);
  if (closedWindowStack.length > MAX_CLOSED_WINDOWS) {
    closedWindowStack.shift();
  }
  DEBUG && console.log('[reopen] Pushed closed window:', entry.url, 'stack size:', closedWindowStack.length);
  saveClosedWindowStack();
}

/**
 * Pop the most recently closed window from the stack.
 * Persists to DB so the stack survives restarts.
 */
export function popClosedWindow(): ClosedWindowEntry | undefined {
  const entry = closedWindowStack.pop();
  DEBUG && console.log('[reopen] Popped closed window:', entry?.url, 'stack size:', closedWindowStack.length);
  saveClosedWindowStack();
  return entry;
}

/**
 * Get the number of closed windows in the stack
 */
export function getClosedWindowCount(): number {
  return closedWindowStack.length;
}

/**
 * Get a copy of the current closed window stack.
 * Used by session save to persist the stack.
 */
export function getClosedWindowStack(): ClosedWindowEntry[] {
  return [...closedWindowStack];
}

/**
 * Save the closed window stack to the datastore (feature_settings table).
 * Synchronous — safe for before-quit handler.
 */
export function saveClosedWindowStack(): void {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const data = JSON.stringify(closedWindowStack);
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'closed-window-stack', ?, ?)
    `).run('session-closed-window-stack', data, Date.now());
    DEBUG && console.log(`[reopen] Saved closed window stack (${closedWindowStack.length} entries)`);
  } catch (error) {
    console.error('[reopen] Failed to save closed window stack:', error);
  }
}

/**
 * Load the closed window stack from the datastore on startup.
 * Replaces the in-memory stack with persisted entries.
 */
export function loadClosedWindowStack(): void {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'closed-window-stack'`
    ).get() as { value: string } | undefined;

    if (row?.value) {
      const entries: ClosedWindowEntry[] = JSON.parse(row.value);
      if (Array.isArray(entries)) {
        closedWindowStack.length = 0;
        for (const entry of entries) {
          closedWindowStack.push(entry);
        }
        DEBUG && console.log(`[reopen] Loaded closed window stack (${closedWindowStack.length} entries)`);
      }
    }
  } catch (error) {
    console.error('[reopen] Failed to load closed window stack:', error);
  }
}

/**
 * Shutdown the application
 *
 * Fires the `app:shutdown` pubsub event, then broadcasts `tile:lifecycle:shutdown`
 * to every live tile and waits one grace period so tile `api.onShutdown()`
 * callbacks can run before the BrowserWindows are closed. Finally closes the
 * database.
 *
 * NOTE: entry.ts's `before-quit` handler invokes this without awaiting (that
 * handler is synchronous). We still perform the broadcast+wait synchronously
 * from JS's perspective — the whole sequence is short (TILE_SHUTDOWN_GRACE_MS)
 * and runs on the event loop. Signal paths (SIGINT/SIGTERM) also don't await
 * but call process.exit() immediately after, so tiles may not finish cleanup
 * on abrupt termination — that's expected (grace-period cleanup is
 * best-effort, never guaranteed).
 */
export async function shutdown(): Promise<void> {
  // Publish shutdown event
  publish(getSystemAddress(), 'app:shutdown', {
    timestamp: Date.now()
  });

  // Signal every tile and wait for the shared grace period before closing.
  try {
    await unloadAllTiles();
  } catch (err) {
    console.error('[main] unloadAllTiles during shutdown failed:', err);
  }

  // Close database
  closeDatabase();
}

// ***** Background Window *****
// (No module-level handle — the core background window is a class-'background'
// machine record; `getBackgroundWindow()` below is a lookup by class.)

/**
 * Launch the core background renderer via tile mechanics.
 *
 * Post-Phase-2.5-#1, the core background window uses `tile-preload.cjs`
 * with a `createTrustedBuiltinGrant('core')` token — same shape as cmd,
 * hud, page, and the privileged test fixture. The heavy lifting lives
 * in `core-glue.ts::initCore()`; this wrapper keeps the existing
 * `createBackgroundWindow()` call site in `entry.ts` working and
 * registers the window in the session registry with `WEB_CORE_ADDRESS`
 * (other code paths identify the core window by address match, e.g.
 * `closeOrHideWindow` refuses to close it, `countVisibleWindows`
 * excludes it).
 *
 * Returns the BrowserWindow so callers that used to do
 * `const bg = createBackgroundWindow()` still get a reference — though
 * nothing in the current tree reads the return value.
 */
export async function createBackgroundWindow(): Promise<BrowserWindow> {
  const tilePreloadPath = getTilePreloadPath();
  if (!tilePreloadPath) {
    throw new Error('[main] tile preload path not configured — call initialize() first');
  }

  const win = await initCore({ tilePreloadPath });

  // Register in the session registry with the legacy address — other
  // code paths use `WEB_CORE_ADDRESS` to identify the core window
  // (e.g. `closeOrHideWindow` refuses to close it, `countVisibleWindows`
  // excludes it). `key: 'background-core'` preserves the v1 winPrefs.key
  // so any `findWindowByKey(WEB_CORE_ADDRESS, 'background-core')`
  // lookups continue to work.
  const systemAddress = getSystemAddress();
  // Record `placement` intent on the registry. The core background window
  // is hidden infrastructure (never positioned by the user, never visible),
  // but we still tag it so consumers reading `params.placement` never see
  // undefined. `centered` is a harmless tag — display-watcher already
  // filters bgWindow out by address, so the projection never runs.
  // See docs/window-placement.md.
  const corePlacement: Placement = { mode: 'centered' };
  registerWindow(win.id, systemAddress, {
    key: 'background-core',
    address: WEB_CORE_ADDRESS,
    placement: corePlacement,
  });

  // Devtools for the background window (dev-profile only, not tests /
  // headless). The core renderer was traditionally helpful to inspect
  // for command registration + pubsub traffic while debugging; keeping
  // the same affordance.
  if (config.isDev && !isTestProfile() && !isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  return win;
}

// Legacy `setWindowOpenHandler` child-window path removed in Phase 2.5
// #1. `api.window.open(...)` routes through `tile:window:open`
// (handled in tile-ipc.ts) and delegates to the centralised window-open
// IPC handler. Native `window.open()` calls from the core background
// HTML never happen — the renderer has no `<a target="_blank">` or
// equivalent. The ~150 lines of `setWindowOpenHandler` logic were dead
// in practice and are deleted.

/**
 * Get the background window
 */
export function getBackgroundWindow(): BrowserWindow | null {
  // The core-glue accessor is itself a class-'background' machine lookup now.
  return getCoreBackgroundWindow();
}

// ***** External URL Handling *****

/**
 * Handle URLs opened from external apps (e.g., when Peek is default browser)
 *
 * URLs are queued until both:
 * 1. The frontend subscriber in app/index.js is ready (frontend-ready IPC)
 * 2. Session restore has completed (so we don't race window creation)
 */
export function handleExternalUrl(url: string, sourceId = 'os'): void {
  urlLog(`handleExternalUrl: url=${url} sourceId=${sourceId} appReady=${_appReady} frontendReady=${_frontendReady} sessionRestoreDone=${_sessionRestoreDone}`);
  DEBUG && console.log('External URL received:', url, 'from:', sourceId);

  if (!_appReady) {
    _pendingUrls.push({ url, sourceId });
    urlLog(`handleExternalUrl: queued (app not ready), pendingUrls=${_pendingUrls.length}`);
    return;
  }

  // If frontend isn't ready yet, queue and wait
  if (!_frontendReady || !_sessionRestoreDone) {
    _pendingUrls.push({ url, sourceId });
    urlLog(`handleExternalUrl: queued (waiting for frontend/session), pendingUrls=${_pendingUrls.length}`);
    DEBUG && console.log('External URL queued (waiting for frontend/session):', url);
    return;
  }

  urlLog(`handleExternalUrl: publishing immediately`);
  publishExternalUrl(url, sourceId);
}

/**
 * Publish a single external URL to the frontend via pubsub
 */
function publishExternalUrl(url: string, sourceId: string): void {
  const processUrl = () => {
    // Note: Using trackingSource/trackingSourceId because tile-preload overwrites msg.source
    publish(getSystemAddress(), 'external:open-url', {
      url,
      trackingSource: 'external',
      trackingSourceId: sourceId,
      timestamp: Date.now()
    });
  };

  // On macOS, open-url fires during app activation, which can happen before
  // the app is fully focused. Wait a tick to ensure activation completes.
  if (process.platform === 'darwin' && sourceId === 'os') {
    setTimeout(processUrl, 100);
  } else {
    processUrl();
  }
}

/**
 * Process any URLs that arrived before app was fully ready.
 * Waits for both frontend readiness and session restore completion,
 * then processes URLs sequentially (one at a time) with a small
 * delay between each to avoid racing concurrent window creation.
 */
async function processPendingUrls(): Promise<void> {
  // Wait for frontend subscriber and session restore before processing
  await Promise.all([_frontendReadyPromise, _sessionRestoreDonePromise]);

  const urls = _pendingUrls.slice();
  _pendingUrls = [];

  if (urls.length === 0) {
    urlLog('processPendingUrls: no pending URLs');
    return;
  }

  urlLog(`processPendingUrls: processing ${urls.length} pending URL(s)`);
  DEBUG && console.log(`[url] Processing ${urls.length} pending URL(s)`);

  // Process sequentially with a small delay between each
  for (const { url, sourceId } of urls) {
    publishExternalUrl(url, sourceId);
    // Small delay between URLs to avoid concurrent window creation races
    if (urls.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/**
 * Mark app as ready to handle external URLs.
 * Pending URLs are NOT processed immediately — they wait for
 * frontendReady and sessionRestoreDone signals.
 */
export function setAppReady(): void {
  _appReady = true;
  urlLog(`setAppReady: pendingUrls=${_pendingUrls.length}`);
  // Kick off pending URL processing (will wait for frontend + session restore)
  processPendingUrls();
}

/**
 * Signal that the frontend (background window's app/index.js) has finished
 * initializing and has registered its pubsub subscribers.
 * Called via IPC 'frontend-ready' from the background window.
 */
export function notifyFrontendReady(): void {
  if (_frontendReady) return;
  _frontendReady = true;
  urlLog(`notifyFrontendReady: pendingUrls=${_pendingUrls.length}`);
  DEBUG && console.log('[url] Frontend ready — pubsub subscribers registered');
  if (_frontendReadyResolve) {
    _frontendReadyResolve();
    _frontendReadyResolve = null;
  }
}

/**
 * Signal that session restore has completed (or was skipped).
 * Called from entry.ts after restoreSessionSnapshot finishes.
 */
export function notifySessionRestoreDone(): void {
  if (_sessionRestoreDone) return;
  _sessionRestoreDone = true;
  urlLog(`notifySessionRestoreDone: pendingUrls=${_pendingUrls.length}`);
  DEBUG && console.log('[url] Session restore done');
  if (_sessionRestoreDoneResolve) {
    _sessionRestoreDoneResolve();
    _sessionRestoreDoneResolve = null;
  }
}

/**
 * Convert a local file path to a file:// URL.
 * Returns null if the path doesn't exist on disk.
 */
function filePathToUrl(filePath: string): string | null {
  try {
    // Resolve to absolute path (handles relative paths)
    const resolved = path.resolve(filePath);
    // Only accept files, not directories
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return pathToFileURL(resolved).href;
    }
  } catch {
    // Not a valid path
  }
  return null;
}

/**
 * Register external URL event handlers
 * Must be called before app.ready for open-url, and in onReady for second-instance
 */
export function registerExternalUrlHandlers(): void {
  urlLog('registerExternalUrlHandlers: registering open-url and open-file handlers');

  // macOS: handle open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
    urlLog(`open-url event fired: url=${url}`);
    handleExternalUrl(url, 'os');
  });

  // macOS: handle open-file event (e.g., `open -a Peek /path/to/file`)
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    DEBUG && console.log('open-file event:', filePath);
    const fileUrl = filePathToUrl(filePath);
    if (fileUrl) {
      handleExternalUrl(fileUrl, 'os');
    } else {
      console.error('open-file: path does not exist:', filePath);
    }
  });
}

/**
 * Register second-instance handler (for Windows/Linux URL handling)
 * Call this inside onReady after acquiring single instance lock
 */
export function registerSecondInstanceHandler(): void {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    urlLog(`second-instance event: argv=${JSON.stringify(argv)} additionalData=${JSON.stringify(additionalData)}`);

    // Check additionalData first (set by the second instance via requestSingleInstanceLock)
    if (additionalData && typeof additionalData === 'object' && (additionalData as any).url) {
      const url = (additionalData as any).url as string;
      urlLog(`second-instance: found URL in additionalData: ${url}`);
      DEBUG && console.log('second-instance additionalData URL:', url);
      handleExternalUrl(url, 'os');
      return;
    }

    // Look for URLs in argv
    const url = argv.find(arg =>
      arg.startsWith('http://') || arg.startsWith('https://')
    );
    if (url) {
      urlLog(`second-instance: found URL in argv: ${url}`);
      DEBUG && console.log('second-instance URL:', url);
      handleExternalUrl(url, 'os');
      return;
    }

    // Look for file paths (skip flags and the executable path)
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-')) continue;
      const fileUrl = filePathToUrl(arg);
      if (fileUrl) {
        urlLog(`second-instance: found file URL in argv: ${arg} -> ${fileUrl}`);
        DEBUG && console.log('second-instance file path:', arg, '->', fileUrl);
        handleExternalUrl(fileUrl, 'os');
        return;
      }
    }

    urlLog('second-instance: no URL found in argv or additionalData');
  });
}

/**
 * Check for URL or file path in CLI arguments and handle it.
 * Uses handleExternalUrl which queues until frontend + session restore are ready.
 */
export function handleCliUrl(): void {
  urlLog(`handleCliUrl: argv=${JSON.stringify(process.argv)}`);

  // Look for URLs first
  const urlArg = process.argv.find(arg =>
    arg.startsWith('http://') || arg.startsWith('https://')
  );
  if (urlArg) {
    urlLog(`handleCliUrl: found URL in argv: ${urlArg}`);
    DEBUG && console.log('CLI URL argument:', urlArg);
    handleExternalUrl(urlArg, 'cli');
    return;
  }

  // Look for file paths (skip flags, electron path, and the app path)
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    // Skip the app directory/entry point itself
    if (arg === app.getAppPath() || arg === '.' || arg.endsWith('.js')) continue;
    // Skip if arg resolves to the app path (handles relative paths, trailing slashes)
    try { if (path.resolve(arg) === path.resolve(app.getAppPath())) continue; } catch {}
    const fileUrl = filePathToUrl(arg);
    if (fileUrl) {
      DEBUG && console.log('CLI file path:', arg, '->', fileUrl);
      handleExternalUrl(fileUrl, 'cli');
      return;
    }
  }
}

// ***** App Lifecycle *****

/**
 * Register the window-all-closed handler
 */
export function registerWindowAllClosedHandler(onQuit: () => void): void {
  app.on('window-all-closed', () => {
    DEBUG && console.log('window-all-closed', process.platform);
    if (process.platform !== 'darwin') {
      onQuit();
    }
  });
}

/**
 * Register the activate handler (macOS dock click)
 */
export function registerActivateHandler(): void {
  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (getAllLiveWindows().length === 0) {
      // Could recreate window here if needed
    }
  });
}

/**
 * Request single instance lock
 * Returns true if lock acquired, false if another instance is running.
 *
 * The lock is per-profile: Electron's SingletonLock lives inside
 * userData, and entry.ts calls `app.setPath('userData', <profileDir>)`
 * before this function runs. Two packaged Peeks under different
 * PROFILE= values therefore coexist; two under the same PROFILE=
 * still block.
 *
 * Skipped entirely when:
 * - Source build (!app.isPackaged): every `yarn start` invocation can
 *   coexist with a packaged Peek and with other source instances. The
 *   packaged build is the only "owner" of the lock — that's what
 *   handles `open -a Peek URL` Apple Events. Source builds are dev
 *   tooling and shouldn't block on the prod lock or each other.
 * - Ephemeral profile (dev / test-* / tmp-*): packaged builds running
 *   under one of these profile prefixes are explicitly secondary
 *   (used by `run:packaged` and parallel Playwright workers that share
 *   the same profile name across workers).
 *
 * The `agent-*` family used by `scripts/spawn-isolated-clone.sh`
 * always runs from source, so it's covered by the !app.isPackaged
 * branch — no special-case needed.
 */
export function requestSingleInstance(): boolean {
  if (!app.isPackaged || isEphemeralProfile()) {
    DEBUG && console.log('Skipping single-instance lock for profile:', getProfile(), 'isPackaged:', app.isPackaged);
    return true;
  }

  // Pass any URL from argv as additionalData so the primary instance receives it
  // via the second-instance event. On macOS, `open -a Peek URL` may pass the URL
  // as an Apple Event (handled via open-url) OR in argv, depending on the scenario.
  const urlArg = process.argv.find(arg =>
    arg.startsWith('http://') || arg.startsWith('https://')
  );
  const additionalData = urlArg ? { url: urlArg } : undefined;

  urlLog(`requestSingleInstance: attempting lock, additionalData=${JSON.stringify(additionalData)}`);

  const gotTheLock = app.requestSingleInstanceLock(additionalData);
  if (!gotTheLock) {
    urlLog('requestSingleInstance: lock NOT acquired, another instance running');
    console.error('APP INSTANCE ALREADY RUNNING, QUITTING');
    app.quit();
    return false;
  }

  urlLog('requestSingleInstance: lock acquired (primary instance)');
  return true;
}

/**
 * Quit the application gracefully
 */
export function quitApp(): void {
  DEBUG && console.log('quitApp');

  // Don't call shutdown() here — let the before-quit handler in entry.ts
  // handle the full cleanup sequence: saveSessionSnapshot() then shutdown().
  // Calling shutdown() here closes the database BEFORE before-quit fires,
  // which prevents the session snapshot from being saved with cleanShutdown=true,
  // causing a false crash recovery prompt on next startup.
  app.quit();
}

// Re-export commonly used functions
export {
  publish,
  subscribe,
  getSystemAddress,
  registerLocalShortcut,
  unregisterLocalShortcut,
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  unregisterShortcutsForAddress,
  handleLocalShortcut,
  initTray,
  getDb,
  getTilePath,
  getRegisteredTileIds,
  loadFeatureManifest,
};

