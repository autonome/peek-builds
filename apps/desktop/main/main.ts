/**
 * Electron Main Process Entry Point
 *
 * This module orchestrates the main process startup and provides
 * a unified API for managing the Electron application.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, webContents } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
import { getHybridWindow } from './hybrid-page-host-registry.js';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { initDatabase, closeDatabase, getDb, getContextEntry, normalizeUrl } from './datastore.js';
import { installDebugFlagsPersistence } from './debug-flag-store.js';
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
import { getSystemThemeBackgroundColor, showWindowHeadlessSafe, addEscHandler } from './windows.js';
import { getProfileSession, getPartitionString, getCurrentProfileId } from './session-partition.js';
import { getIzuiCoordinator } from './izui-state.js';
import { shouldRegisterGlobalEscFallback } from './izui-roles.js';
import { getActiveHybridWindowId, onActiveHybridWindowChange } from './hybrid-page-host-registry.js';
import { clearLastFocusedVisibleWindowId, trackOnWindowFocus } from './ipc.js';
import type { Placement } from './window-placement.js';
import { getWindowPresentation } from './window-presenter.js';
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
  hostUrl: string | null;
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
 *   (b) delete the window from `windowRegistry` and publish the post-delete
 *       `window:removed` signal (the deterministic "fully gone" gate that
 *       close-awaits and dedup-on-reopen wait on);
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
  const windowData = windowRegistry.get(windowId);

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
      // pre-destruction. The presenter already returns canvas-aware
      // bounds for page-hosts (info.params x/y/width/height), the
      // hybrid content rect for hybrid page-hosts (baseWin.getBounds()),
      // and BrowserWindow bounds for everything else.
      let saveBounds = captured.presentation?.bounds ?? captured.bounds;
      const saveMaximized = captured.presentation?.maximized ?? false;
      const savePreMaxBounds: ClosedWindowEntry['preMaximizeBounds'] =
        captured.presentation?.preMaxBounds ?? undefined;

      // Fallback for canvas pages whose presentation didn't capture
      // (presenter returned null because the window was already
      // destroyed before our close listener fired): subtract the
      // fixed canvas chrome from window bounds. Slightly inflated
      // when panels were open in non-maximized mode, but only
      // reached on the unhappy path. (Gated on the canvas shell URL,
      // so it never fires for a hybrid page-host's content URL.)
      if (saveBounds === captured.bounds && captured.bounds && isWebUrl
        && captured.hostUrl && captured.hostUrl.startsWith('peek://app/page/')) {
        const CANVAS_MARGIN = 8;
        const CANVAS_TRIGGER_ZONE = 8;
        const CANVAS_NAVBAR_HEIGHT = 36;
        saveBounds = {
          x: captured.bounds.x + CANVAS_MARGIN,
          y: captured.bounds.y + CANVAS_TRIGGER_ZONE + CANVAS_NAVBAR_HEIGHT,
          width: captured.bounds.width - CANVAS_MARGIN * 2,
          height: captured.bounds.height - CANVAS_TRIGGER_ZONE - CANVAS_MARGIN - CANVAS_NAVBAR_HEIGHT,
        };
      }

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

  // (b) Drop from the registry, then publish the post-delete event — the
  // deterministic "the window is fully gone from the registry" signal.
  // Distinct from `window:closed`, which fires earlier (before pushClosedWindow
  // + delete) and so isn't a safe gate for "you can now re-open the same URL
  // without dedup matching the previous instance".
  windowRegistry.delete(windowId);
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
let mainWindow: BrowserWindow | null = null;

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

// Window manager: windowId -> { source, params }
const windowRegistry = new Map<number, {
  source: string;
  params: Record<string, unknown>;
}>();

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
    onWindowFocus: trackOnWindowFocus,
    // Wire the IZUI ESC handler into the tile-launch path so feature-tile
    // windows run the escape protocol, matching the `window-open` IPC path.
    // addEscHandler lives in windows.ts. The handler resolves a tile
    // window's escape role via tile-launcher's own getTileWindowInfo map,
    // so tile windows are NOT entered into the shared window-registry.
    addEscHandler,
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

  // Hydrate runtime debug flags from persisted state. Must run after
  // initDatabase so feature_settings is readable; before any feature loads
  // so the flags are correct from the first DEBUG && console.log call.
  installDebugFlagsPersistence();

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

  // ESC fallback when Peek is active but has no focused window on the
  // user's current macOS Space. Without this, pressing ESC in this case
  // does nothing because the per-window `before-input-event` handler
  // (`windows.ts:addEscHandler`) requires a focused webContents that's
  // visible on the current Space — and macOS only delivers keystrokes
  // to the key window. When the user Cmd+Tabs to Peek on a Space that
  // has none of Peek's windows, there is no reachable key window for
  // the keystroke to land on.
  //
  // Workaround: register a focus-gated `globalShortcut` for Escape that
  // publishes `cmd:execute:windows` (same fallback the per-window ESC
  // handler uses via escUnhandledPolicy → open-switcher). Registration
  // is gated to avoid swallowing ESC from other apps or stealing ESC
  // from per-window handlers when a Peek window IS focused:
  //   - Register: Peek is the active app AND no Peek window is focused.
  //   - Unregister: Peek loses focus OR a Peek window gains focus.
  // While Peek is active with a focused window, normal per-window ESC
  // routing is preserved; the global hotkey only steps in when there's
  // genuinely no per-window handler to receive the keystroke.
  //
  // Same pattern Spotlight / Alfred / Raycast use for their hotkeys.
  let _escGlobalRegistered = false;
  const escGlobalHandler = (): void => {
    if (getIzuiCoordinator().isWithinOverlayExitCooldown()) {
      DEBUG && console.log('[esc-fallback] Skipping escGlobalHandler — within overlay exit cooldown');
      return;
    }
    DEBUG && console.log('[esc-fallback] global ESC fired — publishing cmd:execute:windows');
    publish(getSystemAddress(), 'cmd:execute:windows', {});
  };
  const updateEscGlobalRegistration = (): void => {
    // Headless safety: globalShortcut.register is neutralized centrally for
    // headless test runs (entry.ts), so this hot path can run unguarded — no
    // OS-wide Escape grab happens regardless of how often focus/blur churn.
    const appActive = getIzuiCoordinator().isAppFocused();
    const focusedWin = BrowserWindow.getFocusedWindow();
    // A hybrid page-host (slide/peek/content) is a BaseWindow, so
    // getFocusedWindow() returns null for it — counting it as "no focused
    // window" wrongly grabs ESC away from its own close handler (peek ebb10894).
    // Treat an active hybrid window as a focused Peek window.
    const activeHybridId = getActiveHybridWindowId();
    const shouldRegister = shouldRegisterGlobalEscFallback(
      appActive,
      focusedWin !== null,
      activeHybridId !== null,
    );
    if (shouldRegister && !_escGlobalRegistered) {
      try {
        const ok = globalShortcut.register('Escape', escGlobalHandler);
        if (ok) {
          _escGlobalRegistered = true;
          DEBUG && console.log('[esc-fallback] global ESC registered (no focused window while Peek active)');
        } else {
          DEBUG && console.log('[esc-fallback] global ESC registration declined (already grabbed elsewhere)');
        }
      } catch (err) {
        console.error('[esc-fallback] global ESC register failed:', err);
      }
    } else if (!shouldRegister && _escGlobalRegistered) {
      try {
        globalShortcut.unregister('Escape');
      } catch (err) {
        // Ignore: unregistering a hotkey that isn't held is a no-op on some platforms.
      }
      _escGlobalRegistered = false;
      DEBUG && console.log('[esc-fallback] global ESC unregistered');
    }
  };
  app.on('browser-window-focus', () => {
    updateEscGlobalRegistration();
  });
  app.on('browser-window-blur', () => {
    // Defer one tick so the next focused window's browser-window-focus
    // (which usually fires immediately after a blur during in-app
    // window switching) can settle before we re-check getFocusedWindow.
    setImmediate(() => updateEscGlobalRegistration());
  });
  // Hybrid page-hosts (slides/peeks/content BaseWindows) do NOT fire
  // app.browser-window-focus/blur, so without this the esc-fallback predicate
  // would never re-evaluate when a slide/peek gains or loses focus — leaving a
  // stale global ESC grab that pre-empts the slide's own ESC→close
  // (peek ebb10894). Re-check on every active-hybrid-window transition.
  onActiveHybridWindowChange(() => updateEscGlobalRegistration());

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
      // Show any alwaysOnTop overlay windows (e.g. HUD) that were hidden
      // by the did-resign-active handler below. This hide/show pair
      // avoids a pubsub round-trip through a renderer.
      for (const win of getAllLiveWindows()) {
        // Never re-show overlay/HUD windows under headless — showInactive on an
        // alwaysOnTop window surfaces it on the user's real desktop.
        if (!isHeadless() && win.isAlwaysOnTop() && (win as any).__hudHidden) {
          win.showInactive();
          (win as any).__hudHidden = false;
        }
      }
      // Defer one tick so any browser-window-focus that macOS fires
      // alongside this activation has a chance to settle first; the
      // check below reads getFocusedWindow().
      setImmediate(() => updateEscGlobalRegistration());
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
        for (const [id, data] of windowRegistry) {
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

      // Hide non-focusable alwaysOnTop overlay windows (e.g. HUD) when
      // the app loses focus. Skip focusable alwaysOnTop windows (e.g.
      // the cmd panel) — they have their own blur handler and would
      // blink if hidden here.
      for (const win of getAllLiveWindows()) {
        if (win.isAlwaysOnTop() && win.isVisible() && !win.isFocusable()) {
          win.hide();
          (win as any).__hudHidden = true;
        }
      }
      // Peek is no longer the active app — drop the ESC fallback so we
      // don't swallow ESC keystrokes from whatever app the user just
      // switched to.
      updateEscGlobalRegistration();
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

  // Track window events globally
  app.on('browser-window-created', (_, window) => {
    const windowId = window.id;

    // Capture the window's canonical presentation before destruction so the
    // 'closed' handler can persist correct bounds, address, and maximize
    // state for reopen-last-closed. The presenter encapsulates the canvas /
    // generic split — main.ts no longer parses the page-host shell URL.
    let lastBounds: { x: number; y: number; width: number; height: number } | null = null;
    let lastHostUrl: string | null = null;
    let lastPresentation: import('./window-presenter.js').WindowPresentation | null = null;
    window.on('close', () => {
      try {
        if (!window.isDestroyed()) {
          lastBounds = window.getBounds();
          lastHostUrl = window.webContents.getURL();
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
        const windowData = windowRegistry.get(windowId);

        // Clean up IZUI coordinator state
        const coordinator = getIzuiCoordinator();
        coordinator.clearFocusedWindow(windowId);

        // Clear stale lastFocusedVisibleWindowId so getFocusedVisibleWindowId()
        // doesn't return a closed window's ID (causes wrong window targeting)
        clearLastFocusedVisibleWindowId(windowId);

        // Focus parent window if this was a child
        if (windowData && windowData.params.parentWindowId) {
          const parentId = windowData.params.parentWindowId as number;
          const parentWin = getLiveWindow(parentId);
          if (parentWin) {
            DEBUG && console.log('[izui] Child window closed, focusing parent:', parentId);
            parentWin.focus();
          }
        }

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
            // Fallback: ad-hoc overlay restoration for non-coordinator path (backward compat)
            const hiddenWindowIds = windowData.params.overlayHiddenWindows as number[] | undefined;
            const isTransient = windowData.params.transient === true;
            if (hiddenWindowIds && hiddenWindowIds.length > 0 && !isTransient) {
              DEBUG && console.log('[izui] Overlay closed (fallback path), restoring', hiddenWindowIds.length, 'windows');
              for (const hiddenId of hiddenWindowIds) {
                const hiddenWin = getLiveWindow(hiddenId);
                if (hiddenWin) {
                  // showInactive: activating each one would pull the user to its
                  // Space; the explicit .focus() below selects the right target.
                  showWindowHeadlessSafe(hiddenWin);
                }
              }
              const focusTargetId = windowData.params.overlayFocusTarget as number | undefined;
              const preOverlayTarget = coordinator.getPreOverlayFocusTarget();
              const restoreFocusId = focusTargetId || preOverlayTarget;
              if (restoreFocusId) {
                const targetWin = getLiveWindow(restoreFocusId);
                if (targetWin) {
                  targetWin.focus();
                } else {
                  // Hybrid page-host (BaseWindow) — focus the host directly.
                  const hybrid = getHybridWindow(restoreFocusId);
                  if (hybrid && !hybrid.baseWin.isDestroyed()) hybrid.baseWin.focus();
                }
              }
            } else if (isTransient && hiddenWindowIds && hiddenWindowIds.length > 0) {
              DEBUG && console.log('[izui] Overlay closed in transient mode (fallback) - not restoring windows');
            }

            // Pop window for non-overlay path
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
          hostUrl: lastHostUrl,
          presentation: lastPresentation,
        });
      } catch (err) {
        // During shutdown, errors here must not prevent the quit sequence
        DEBUG && console.error('[lifecycle] Error in window closed handler:', err);
        windowRegistry.delete(windowId);
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
      // Page host windows (canvas) have their own Cmd+L handler for the floating navbar
      // (registered in openWindow). Skip local shortcut handling for Cmd+L on those windows
      // so the page host's before-input-event handler can handle it instead.
      if (input.type === 'keyDown' && input.key === 'l') {
        const mod = process.platform === 'darwin' ? input.meta : input.control;
        if (mod && !input.alt && !input.shift) {
          const winInfo = getWindowInfo(windowId);
          const addr = winInfo?.params?.address as string | undefined;
          if (addr && (addr.startsWith('http://') || addr.startsWith('https://') || addr.startsWith('file:///'))) {
            return; // Let the page host's own handler deal with Cmd+L
          }
          // Hybrid page-host shared-chrome overlay: a real BrowserWindow
          // loading peek://app/page/overlay.html. When R1/R2/R3 focuses it
          // (overlayWin.focus on page:show-navbar), Cmd+L lands here. Its
          // params.address is the peek:// overlay URL (not http/https/file),
          // so the check above doesn't skip it. Skip the local-shortcut
          // dispatch so the overlay's <peek-navbar> (shortcuts=true) handles
          // Cmd+L → focusUrl instead of opening the cmd panel. Detected via
          // the focused window's own webContents URL to avoid importing
          // hybrid-overlay.ts (which imports from main.js → cycle).
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
 * Register a window in the registry
 */
export function registerWindow(windowId: number, source: string, params: Record<string, unknown>): void {
  windowRegistry.set(windowId, { source, params });
}

/**
 * Get window info from registry
 */
export function getWindowInfo(windowId: number): { source: string; params: Record<string, unknown> } | undefined {
  return windowRegistry.get(windowId);
}

/**
 * Find a window by source and key
 */
export function findWindowByKey(source: string, key: string): { id: number; window: BrowserWindow; data: unknown } | null {
  if (!key) return null;

  for (const [id, win] of windowRegistry) {
    if (win.source === source && win.params && win.params.key === key) {
      const browserWindow = getLiveWindow(id);
      if (browserWindow) {
        return { id, window: browserWindow, data: win };
      }
      // Clean up stale registry entry for destroyed/missing window.
      // This happens when Cmd+W or OS close destroys a window but the
      // registry entry wasn't removed (e.g., panel windows on macOS).
      DEBUG && console.log('findWindowByKey: cleaning up stale entry for key:', key, 'windowId:', id);
      windowRegistry.delete(id);
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

  for (const [id, win] of windowRegistry) {
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
 * Remove a window from the registry
 */
export function removeWindow(windowId: number): boolean {
  return windowRegistry.delete(windowId);
}

/**
 * Get all child windows for a source
 */
export function getChildWindows(source: string): Array<{ id: number; data: { source: string; params: Record<string, unknown> } }> {
  const children = [];
  for (const [id, win] of windowRegistry) {
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
  return Array.from(windowRegistry.entries());
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

let backgroundWindow: BrowserWindow | null = null;

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

  // Keep the local handle in sync so `getBackgroundWindow()` returns
  // the same reference even while test code that reads it early hasn't
  // yet switched to the core-glue accessor.
  backgroundWindow = win;

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
  // Prefer the core-glue accessor so callers get a live reference even
  // if `createBackgroundWindow()` hasn't been called yet in this boot
  // (e.g. during mid-startup IPC that runs before entry.ts's call).
  return getCoreBackgroundWindow() ?? backgroundWindow;
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

