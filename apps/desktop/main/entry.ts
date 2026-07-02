/**
 * Electron Backend Entry Point
 *
 * This is the main entry point for the Electron application.
 * All Electron-specific code lives here.
 */

// MUST be first: sets the macOS headless activation policy before any other
// (side-effectful) import runs, minimizing the launch-time focus flash.
import './headless-policy.js';
import { headlessActivationPolicy } from './headless-policy.js';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, webContents } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
import { initHybridOverlay } from './hybrid-overlay.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import unhandled from 'electron-unhandled';

// Import from local backend modules
import {
  // Main process orchestration
  configure,
  initialize,
  discoverBuiltinFeatures,
  discoverBuiltinThemes,
  loadFeatures,
  // Dev tile support (CLI --load-extension)
  registerDevTile,
  loadDevTiles,
  cleanupDevTiles,
  // External URL handling
  setAppReady,
  notifyFrontendReady,
  notifySessionRestoreDone,
  registerExternalUrlHandlers,
  registerSecondInstanceHandler,
  handleCliUrl,
  handleExternalUrl,
  // Background window
  createBackgroundWindow,
  // App lifecycle
  registerWindowAllClosedHandler,
  registerActivateHandler,
  requestSingleInstance,
  quitApp,
  shutdown,
  // Tray
  initTray,
  // Shortcuts
  registerLocalShortcut,
  unregisterLocalShortcut,
  handleLocalShortcut,
  getGlobalShortcutSource,
  // PubSub
  publish,
  subscribe,
  unsubscribe,
  getSystemAddress,
  // IPC
  registerAllHandlers,
  installHybridNavbarActionRouting,
  restoreSavedTheme,
  reopenLastClosedWindow,
  openNewPageWindow,
  // Database
  getDb,
  // Config
  WEB_CORE_ADDRESS,
  SETTINGS_ADDRESS,
  setProfile,
  isTestProfile,
  isHeadless,
  // Window helpers
  closeFocusedWindow,
  showWindowHeadlessSafe,
  setPrefsGetter,
  applyDockPreference,
  // Tile manifest loading
  loadFeatureManifest,
  // Closed window stack persistence
  loadClosedWindowStack,
  getClosedWindowStack,
  getClosedWindowCount,
  // Test-only
  flushPendingCloseSave,
} from './index.js';

import { startHotReload, stopHotReload } from './hotreload.js';
import { checkAndRunDailyBackup } from './backup.js';
import { initThumbnailDir, cleanupThumbnails } from './thumbnails.js';
import { getActiveThumbnailHashes } from './datastore.js';
import {
  applyAdblockerConfig,
  cleanupAdblocker,
} from './adblocker.js';
import {
  initChromeExtensionManager,
  loadEnabledChromeExtensions,
  openChromeExtensionPage,
  cleanupChromeExtensions,
  destroyChromeExtensionWindowsForShutdown,
  getChromeExtensionOptionsCommands,
  markRuntimeExternalQuitting,
} from './chrome-extensions.js';
import {
  initProfilesDb,
  migrateExistingProfiles,
  ensureDefaultProfile,
  getActiveProfile,
} from './profiles.js';
import {
  initSessionPartition,
  registerDownloadHandler,
} from './session-partition.js';
import { saveSessionSnapshot, restoreSessionSnapshot, readSessionCrashState, markSessionDirty, startAutosaveTimer, stopAutosaveTimer, updateAutosaveInterval, getRestoreFocusCounters, setRestoreCompleteForTest, reassertColdStartFocusOnce } from './session.js';
import { getIzuiCoordinator } from './izui-state.js';
import { getHybridWindow, getHybridContentWC } from './hybrid-page-host-registry.js';
import { initDisplayWatcher, cleanupDisplayWatcher } from './display-watcher.js';
import { getTileWebPreferencesForWebviewUrl } from './tile-launcher.js';
import { getLazyTileManifest } from './tile-lazy.js';
import { getTilePreloadPath } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { startCliSocketServer, stopCliSocketServer, isCliSocketRunning } from './cli-socket.js';
import { ensureCliHelperShadow } from './cli-helper.js';
import { ensureLinuxDesktopInstall, ensureLinuxCliAlias } from './desktop-installer.js';
import { initRendererLog } from './renderer-log.js';
import { initMainLog } from './main-log.js';
import { startCpuWatch } from './cpu-watch.js';
import { DEBUG } from './config.js';
import { isDevToolsEnabled } from './debug-flag.js';
import { isPageHostContent, destroyAllPageHostGuests } from './webview-guest-registry.js';
import {
  getRuntimeExternalWebPrefsForUrl,
  installMainWorldContentScriptInjection,
  installRuntimeExternalCdpPolyfill,
} from './page-host-compat.js';

// Early diagnostic logging for URL handling (writes to /tmp/ to avoid userData path issues)
try {
  const ts = new Date().toISOString();
  fs.appendFileSync('/tmp/peek-url-debug.log',
    `[${ts}] entry.ts loaded: pid=${process.pid} argv=${JSON.stringify(process.argv)} packaged=${app.isPackaged}\n`
  );
} catch { /* ignore */ }

// Catch unhandled errors and promise rejections without showing alert dialogs
unhandled({
  showDialog: false,
  logger: (error) => {
    console.error('Unhandled error:', error);
  }
});

// Get the root directory - app.getAppPath() works in both dev and packaged modes
const ROOT_DIR = app.getAppPath();
// Desktop app lives under apps/desktop/ within the monorepo root.
// All renderer, features, assets, and chrome-extensions paths are relative to
// DESKTOP_DIR rather than ROOT_DIR (which is the repo root).
const DESKTOP_DIR = path.join(ROOT_DIR, 'apps', 'desktop');

// Expose test utilities on global for Playwright evaluateMain access
(globalThis as any).__peek_test = {
  handleLocalShortcut,
  handleExternalUrl,
  reopenLastClosedWindow,
  getClosedWindowStack,
  getClosedWindowCount,
  /** Force-save current session snapshot (bypasses test-profile + isVisible guards). */
  forceSaveSession: () => saveSessionSnapshot('manual', { _forceForTest: true }),
  /** Force-restore session snapshot (bypasses test-profile guard). */
  forceRestoreSession: () => restoreSessionSnapshot({ restoreSession: true }, undefined, true),
  /**
   * Force-restore as a COLD START (4th positional isColdStart=true). Lets the
   * session-restore-focus specs drive the boot path: with the app-focus override
   * set FALSE (simulating the startup did-resign-active dance), a cold-start
   * restore must STILL activate the focused descriptor — the bug fix. The
   * in-session forceRestoreSession above keeps isColdStart false. See
   * shouldActivateFocusedOnRestore() in izui-roles.ts and
   * tests/desktop/session-restore-focus.spec.ts.
   */
  forceColdStartRestoreSession: () => restoreSessionSnapshot({ restoreSession: true }, undefined, true, true),
  /**
   * Re-run the cold-start trailing-dance re-assert latch ONCE, the same call
   * main.ts's did-become-active handler makes. Lets a spec drive the safety net
   * deterministically. Returns true iff it re-raised a window.
   */
  reassertColdStartFocusOnce: () => reassertColdStartFocusOnce(),
  /**
   * Override the IZUI coordinator's OS-focus state for drift-detection
   * tests. The restore loop's .show()/.focus() gate reads
   * `isAppFocused()` live; flipping it via this hook lets a test simulate
   * "user switched away mid-restore" deterministically.
   *
   * Sets a forced override (not just the OS-event-driven value) because
   * opening a new BrowserWindow during restore can fire did-become-active
   * on macOS, which would otherwise overwrite the test's intent. The
   * override sticks until `clearAppFocusedForTest()` is called. See
   * tests/desktop/session-restore-focus.spec.ts.
   */
  setAppFocusedForTest: (focused: boolean) => {
    (getIzuiCoordinator() as unknown as { _setAppFocusOverride(v: boolean | null): void })
      ._setAppFocusOverride(focused);
  },
  /** Release the test override and restore OS-driven app-focus tracking. */
  clearAppFocusedForTest: () => {
    (getIzuiCoordinator() as unknown as { _setAppFocusOverride(v: boolean | null): void })
      ._setAppFocusOverride(null);
  },
  /**
   * Read the restoreSessionSnapshot drift-detection counters. Reset at
   * the top of every restoreSessionSnapshot call, incremented at each
   * gated .show()/.showInactive()/.focus() call site. Tests assert
   * shows=0 + focuses=0 when appFocused was false at restore time.
   */
  getRestoreFocusCounters: () => getRestoreFocusCounters(),
  /**
   * Synchronously flush a pending debounced session-save (the one that
   * normally runs ~500ms after a window close). Lets the close-survives-
   * kill regression test in
   * tests/desktop/session-restore-close-survives-kill.spec.ts observe
   * the post-close snapshot without sleeping (per
   * feedback_no_sleep_in_tests_or_code).
   */
  flushPendingCloseSave: () => flushPendingCloseSave(),
  /**
   * Override the restore-complete flag for tests that simulate mid-restore
   * save behavior. Set to false to simulate "restore in flight"; set to true
   * (or call forceRestoreSession) to re-enable saves.
   *
   * See tests/desktop/session-restore-save-during-restore.spec.ts.
   */
  setRestoreCompleteForTest: (value: boolean) => setRestoreCompleteForTest(value),
  /**
   * Test-only: simulate a hybrid page-host window gaining OS focus by emitting
   * the REAL `'focus'` event on its host BaseWindow — the exact event Electron
   * fires when the user clicks into the page. On macOS-headless `baseWin.focus()`
   * does NOT grant real OS focus (no virtual display), so a test must drive the
   * event the way the OS would. This exercises the genuine focus-tracker wiring
   * (hybrid registry active id + ipc.ts lastFocusedVisibleWindowId), NOT an
   * internal setter. Returns false if the id is not a live hybrid window.
   * See tests/desktop/session-restore-page-host.spec.ts.
   */
  focusHybridWindowForTest: (windowId: number): boolean => {
    const entry = getHybridWindow(windowId);
    if (!entry || entry.baseWin.isDestroyed()) return false;
    (entry.baseWin as unknown as { emit(name: string): boolean }).emit('focus');
    return true;
  },
  /**
   * Test-only: is `windowId` a live hybrid page-host (BaseWindow) window?
   * Lets the session-restore-page-host spec skip its canvas-only chrome-param
   * assertions now that hybrid is the only page-host, the same way the
   * hybrid-overlay suite skips on a missing bridge.
   */
  isHybridWindowForTest: (windowId: number): boolean => {
    const entry = getHybridWindow(windowId);
    return !!(entry && !entry.baseWin.isDestroyed());
  },
  /**
   * Test-only: the content `WebContents` id for a live hybrid page-host
   * window, or null if it's not a registered hybrid. Captured BEFORE close so
   * the A1d leak-fix spec can later look the wc up by id (via
   * `isWebContentsAliveForTest`) and assert it was actually destroyed on close
   * — the registry no longer holds it post-close. See
   * tests/desktop/hybrid-close-leak.spec.ts.
   */
  getHybridContentWcIdForTest: (windowId: number): number | null => {
    const wc = getHybridContentWC(windowId);
    return wc ? wc.id : null;
  },
  /**
   * Test-only: is a `WebContents` with this id still alive (exists and not
   * destroyed)? Used by the A1d leak-fix spec to prove the orphaned content
   * renderer is freed on hybrid close — `webContents.fromId(id)` returns
   * undefined once the renderer is gone. Returns false for an unknown id.
   */
  isWebContentsAliveForTest: (wcId: number): boolean => {
    const wc = webContents.fromId(wcId);
    return !!(wc && !wc.isDestroyed());
  },
  /** Test-only: the IZUI coordinator's current focused-window id (or null). */
  getIzuiFocusedWindowId: (): number | null =>
    getIzuiCoordinator().getFocusedWindowId(),
  /**
   * Read the current on-disk session snapshot directly. Returns the parsed
   * SessionSnapshot object or null if no snapshot exists. Used by tests to
   * assert snapshot integrity after a save attempt.
   */
  getLastSnapshot: () => {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
      ).get() as { value: string } | undefined;
      if (!row?.value) return null;
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  },
  /**
   * Force a BrowserWindow to be visible *without focusing it*. Tests that
   * drive focus synthetically through `fireWindowFocus` need the window
   * `isVisible()` (so the focus-driven transient autoclose has something to
   * iterate) but must NOT fire a native focus event during the show — under
   * Linux/Xvfb a real `win.show()` activates the window, the natural focus
   * handler runs immediately, and any in-flight transient gets auto-closed
   * before the test can run its assertions. Use `showInactive()` so the
   * window becomes visible but the test remains the sole focus driver. (In
   * the original macOS HEADLESS path show()/showInactive() both no-op'd at
   * the WM level, so neither variant fired focus there — this distinction
   * only matters under a real display.)
   */
  showWindow: (id: number): boolean => {
    const win = getLiveWindow(id);
    if (!win) return false;
    showWindowHeadlessSafe(win);
    return true;
  },
  /**
   * Synchronously dispatch the BrowserWindow 'focus' event listener chain
   * for the given window id. Use to drive focus-handler logic deterministically
   * in tests where headless Electron and Playwright's focus model don't
   * produce reliable native focus events (notably for type:'panel' NSPanels
   * on macOS — same root cause that the in-process autoclose path was
   * written to work around).
   */
  fireWindowFocus: (id: number): boolean => {
    const win = getLiveWindow(id);
    if (win) {
      win.emit('focus');
      return true;
    }
    // Hybrid page-host (BaseWindow) — invisible to getLiveWindow. Emit 'focus'
    // on its host BaseWindow so the production `onHybridHostFocus` listener
    // (active-id tracking + transient-sibling autoclose) runs, exactly as a real
    // OS focus would. Lets a focus-free test drive the hybrid focus path.
    const hybrid = getHybridWindow(id);
    if (hybrid && !hybrid.baseWin.isDestroyed()) {
      hybrid.baseWin.emit('focus');
      return true;
    }
    return false;
  },
  /**
   * Synchronously dispatch the BrowserWindow 'blur' event listener chain for the
   * given window id — the mirror of `fireWindowFocus`. Drives the modal
   * self-close-on-blur handler (ipc.ts, gated on `windowSelfClosesOnBlur`)
   * deterministically: headless Electron / macOS NSPanels don't emit reliable
   * native blur on an app- or window-switch, so a test that needs to prove a
   * window does (or does NOT) close on blur fires it synthetically here.
   */
  fireWindowBlur: (id: number): boolean => {
    const win = getLiveWindow(id);
    if (win) {
      win.emit('blur');
      return true;
    }
    const hybrid = getHybridWindow(id);
    if (hybrid && !hybrid.baseWin.isDestroyed()) {
      hybrid.baseWin.emit('blur');
      return true;
    }
    return false;
  },
  /**
   * Emit the app-level `did-resign-active` event — the deterministic signal
   * macOS fires when Peek stops being the frontmost app (Cmd+Tab away). Drives
   * the production app-blur handlers (overlay close, HUD hide, and the hybrid
   * transient peek/slide dismissal) without needing real OS app-switching, which
   * is unobservable under headless. Faithful: it runs the SAME listeners the OS
   * event would.
   */
  fireAppResignActive: (): boolean => {
    app.emit('did-resign-active');
    return true;
  },
  /**
   * Emit the app-level `did-become-active` event — Peek returning to the
   * foreground. Paired with {@link fireAppResignActive} to simulate the macOS
   * resign→become activation dance that window restoration fires at startup, so
   * a test can assert the dance does NOT dismiss a freshly opened slide/peek.
   */
  fireAppBecomeActive: (): boolean => {
    app.emit('did-become-active');
    return true;
  },
  /** Returns the page-host URL-param bounds (the canonical webview screenBounds). */
  getHostUrlParamsByUrl: (urlSubstr: string) => {
    let last: { x: number; y: number; width: number; height: number } | null = null;
    for (const w of getAllLiveWindows()) {
      try {
        const u = w.webContents.getURL();
        if (!u.includes(urlSubstr)) continue;
        if (!u.startsWith('peek://app/page/')) continue;
        const parsed = new URL(u);
        const x = parseInt(parsed.searchParams.get('x') || '');
        const y = parseInt(parsed.searchParams.get('y') || '');
        const width = parseInt(parsed.searchParams.get('width') || '');
        const height = parseInt(parsed.searchParams.get('height') || '');
        if ([x, y, width, height].every(Number.isFinite)) {
          last = { x, y, width, height };
        }
      } catch { /* ignore */ }
    }
    return last;
  },
  /**
   * Publish `cmd:execute:<command>` on the System address — the exact
   * output of the feature-shortcut-registrar's global-hotkey callback
   * (apps/desktop/main/feature-shortcut-registrar.ts). Used by the lazy
   * windows-wake spec to drive the load-on-dispatch hook WITHOUT
   * injecting OS keys (no virtual display on macOS-headless). Mirrors
   * `deps.publish(deps.getSystemAddress(), 'cmd:execute:' + command, {})`.
   */
  publishCmdExecute: (command: string): void => {
    publish(getSystemAddress(), `cmd:execute:${command}`, {});
  },
  /**
   * Publish an arbitrary `topic` with `msg` on the System address — the
   * exact output of a feature-shortcut-registrar wakeTopic-style global
   * hotkey callback (`publish(systemAddress, wakeTopic, { args })`). Used
   * by the lazy peeks-wake spec to drive `cli:peek-open` with
   * `{ args: ['0'] }` WITHOUT injecting OS keys (no virtual display on
   * macOS-headless). Generic counterpart to `publishCmdExecute`.
   */
  publishSystemTopic: (topic: string, msg: unknown): void => {
    publish(getSystemAddress(), topic, msg);
  },
  /**
   * Return the source-address that owns a registered GLOBAL accelerator, or
   * undefined if none. Reads the internal `globalShortcuts` map in
   * shortcuts.ts, which is populated even under headless (where Electron's
   * `globalShortcut.register` is neutralized). Lets the lazy peeks-wake spec
   * assert that the manifest's static-default hotkey (`Option+0`) was
   * registered at boot by the feature-shortcut-registrar WITHOUT the renderer.
   */
  getGlobalShortcutSource: (accelerator: string): string | undefined =>
    getGlobalShortcutSource(accelerator),
  /**
   * Resolve when the given tile reaches `state` (an FSM state name such
   * as 'ready' / 'visible'). Subscribes to the System-owned, read-only
   * `tile:state-changed` observer topic — the same in-process pubsub the
   * tile-lifecycle engine publishes on every transition — so the wait is
   * synchronized on a REAL FSM transition, never a timer.
   *
   * If the tile is already AT (or past) the target when called, the
   * caller should instead synchronize on a committed signal (e.g. the
   * window's presence): this only fires on a fresh transition INTO
   * `state`. Resolves with the transition payload; rejects on timeout so
   * a regression surfaces as a failure rather than a hang.
   */
  waitForTileState: (tileId: string, state: string, timeoutMs = 15000): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const observerSource = `peek://test/tile-state-observer/${tileId}/${state}/${Date.now()}`;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe(observerSource, 'tile:state-changed');
        reject(new Error(`waitForTileState timed out: ${tileId} never reached ${state}`));
      }, timeoutMs);
      subscribe(observerSource, 'tile:state-changed', (msg: unknown) => {
        const m = msg as { tileId?: string; to?: string };
        if (m?.tileId !== tileId || m?.to !== state) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe(observerSource, 'tile:state-changed');
        resolve(msg);
      });
    });
  },
};
(globalThis as any).__peek_electron = { globalShortcut };

// Parse --load-extension CLI arguments for dev workflow.
// (Flag name retained for backward compatibility; the loaded thing is a tile.)
// Usage: yarn start -- --load-extension=/path/to/tile
// Multiple tiles: yarn start -- --load-extension=/path1 --load-extension=/path2
const devTilePaths: string[] = [];
for (const arg of process.argv) {
  if (arg.startsWith('--load-extension=')) {
    const tilePath = arg.slice('--load-extension='.length);
    // Expand ~ to home directory
    const expandedPath = tilePath.startsWith('~')
      ? path.join(app.getPath('home'), tilePath.slice(1))
      : tilePath;
    // Resolve to absolute path
    const absolutePath = path.resolve(expandedPath);
    devTilePaths.push(absolutePath);
    DEBUG && console.log(`[cli] Dev tile path: ${absolutePath}`);
  }
}

const systemAddress = getSystemAddress();

// Inject tile-preload into <webview> elements that load peek:// URLs.
// This gives internal widget pages (e.g., HUD widgets, widget-demo cards)
// access to window.app API while leaving external web content webviews untouched.
//
// Resolution order:
//   1. HUD widget webviews: peek://hud/widgets/*.html get a dedicated
//      trustedBuiltin token (hud-widget). HUD has no tile manifest but
//      widgets use api.window/context/izui/pubsub — all covered by
//      trustedBuiltin grant.
//   2. Tile-backed URLs: URL resolves to a registered tile manifest — use
//      tile-preload.cjs with manifest-derived capability token.
//   3. Unrecognised peek:// URL: log a warning and skip preload injection.
//
// Also auto-inject MAIN-world content_scripts (e.g. webauthn.js) from loaded
// chrome extensions whose manifest match-patterns accept the webview URL.
app.on('web-contents-created', (_event, contents) => {
  // ── SECURITY chokepoint ────────────────────────────────────────────
  // Validate every new webContents matches Peek's isolation policy.
  // nodeIntegration MUST be false; contextIsolation MUST be true. A raw
  // BrowserWindow constructed with permissive prefs would otherwise sit
  // outside the tile / preload / capability system entirely and expose
  // full Electron privileges to whatever URL it loads.
  //
  // Skips: extension background pages (Electron's built-in extension
  // support owns these), offscreen pages (chrome.offscreen polyfill,
  // sandbox: false by design and not reachable from the renderer).
  //
  // Behavior: log loudly always; throw in dev/test so violations cannot
  // be missed. Production stays up — crashing real users is worse than
  // a logged warning — but the assert path makes regressions impossible
  // to land via PR.
  {
    const type = contents.getType();
    if (type !== 'backgroundPage' && type !== 'offscreen') {
      try {
        // `getLastWebPreferences` exists at runtime on Electron 40
        // (returns null for some surfaces) but is not in the public
        // typings; cast through unknown so the type check stays clean.
        const getter = (contents as unknown as {
          getLastWebPreferences?: () => Electron.WebPreferences | null;
        }).getLastWebPreferences;
        const prefs = typeof getter === 'function' ? getter.call(contents) : null;
        if (prefs) {
          const violations: string[] = [];
          if (prefs.nodeIntegration === true) violations.push('nodeIntegration=true');
          if (prefs.contextIsolation === false) violations.push('contextIsolation=false');
          if (prefs.webSecurity === false) violations.push('webSecurity=false');
          if (violations.length > 0) {
            const url = contents.getURL() || '<no url yet>';
            const msg = `[SECURITY] webContents ${contents.id} (type=${type}, url=${url}) violates isolation policy: ${violations.join(', ')}`;
            console.error(msg);
            if (process.env.NODE_ENV !== 'production') {
              throw new Error(msg);
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('[SECURITY]')) throw err;
        // Inspecting prefs may fail on some surface types; swallow
        // non-security errors so we don't break legitimate flows.
      }
    }
  }

  // Forward console errors/warnings from EVERY chrome-extension:// webContents
  // to main stderr. Extension popups, options pages, BG SW, etc. have no
  // user-visible diagnostic path when they fail to render (a black screen
  // tells you nothing). Centralised here at the web-contents-created chokepoint
  // so it covers all callsites: chrome-extensions.ts openChromeExtensionPage,
  // api.window.open path, harness-driven opens, etc.
  contents.on('console-message', (event) => {
    try {
      const url = contents.getURL();
      if (!url.startsWith('chrome-extension://')) return;
      const e = event as unknown as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
      const level = String(e.level);
      const isErrorish = level === 'error' || level === 'warning' || level === 'warn';
      if (isErrorish) {
        const extId = url.slice('chrome-extension://'.length).split('/')[0].slice(0, 8);
        console.log(`[ext:${extId}:${level}] ${String(e.message)} (${String(e.sourceId)}:${String(e.lineNumber)})`);
      }
    } catch { /* logging must never throw */ }
  });

  // DevTools shortcut: Cmd+Alt+I (mac) / Ctrl+Shift+I (linux/win). Gated by
  // the runtime debug toggle (Settings → Diagnostics). Every window is
  // created with `webPreferences.devTools: true`, so this handler can open
  // devtools on any focused window — including ones that existed before the
  // user flipped the toggle, which the previous boot-time gate could not.
  //
  // Match on `input.code` (physical key) not `input.key` — on macOS,
  // holding Option transforms `key` (Option+I → 'ˆ'), so matching on `key`
  // would never fire for the mac chord.
  contents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || input.code !== 'KeyI') return;
    // Never open devtools under headless test runs (the central web-contents
    // neutralization also no-ops openDevTools; this keeps the known chord path
    // from tripping that drift signal).
    if (isHeadless()) return;
    const isMacShortcut = process.platform === 'darwin' && input.meta && input.alt && !input.control && !input.shift;
    const isPcShortcut = process.platform !== 'darwin' && input.control && input.shift && !input.meta && !input.alt;
    if (!isMacShortcut && !isPcShortcut) return;
    if (!isDevToolsEnabled()) {
      console.log(`[devtools-shortcut] ignored — toggle is off (webContents ${contents.id})`);
      return;
    }
    console.log(`[devtools-shortcut] toggling devtools on webContents ${contents.id} (was open: ${contents.isDevToolsOpened()})`);
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
    } else {
      contents.openDevTools({ mode: 'detach' });
    }
  });

  // Default-deny window-open chokepoint. Every top-level webContents and
  // every webview guest gets this fallback handler installed at creation
  // time. Per-window code (ipc.ts:wireHybridContentEvents wiring, chrome-
  // extensions popup handler) calls setWindowOpenHandler AFTER this
  // listener runs and REPLACES the default — that's the intended
  // precedence. Anything that doesn't install its own handler fails
  // closed: window.open() from an unhandled context is denied instead
  // of silently spawning a raw BrowserWindow.
  if (contents.getType() === 'window' || contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      console.warn(`[SECURITY] Default-deny chokepoint: window.open('${url}') from webContents ${contents.id} (type=${contents.getType()}) — install an explicit setWindowOpenHandler if this should be allowed`);
      return { action: 'deny' };
    });
  }

  // Blanket-register the will-download handler on this webContents' session.
  // `will-download` fires on the session that owns the downloading contents,
  // which may be a webview-partition session (persist:<profileId>) distinct
  // from the profileSession object — or another on-the-fly session we didn't
  // anticipate. Attaching here catches every webContents (top-level window,
  // webview guest, popup, extension background page). registerDownloadHandler
  // is idempotent via WeakSet so the multiple explicit registration sites in
  // ipc.ts and session-partition.ts remain harmless belt-and-suspenders.
  try {
    registerDownloadHandler(contents.session);
  } catch (err) {
    console.error('[download] Failed to register handler on new webContents session:', err);
  }

  contents.on('will-attach-webview', (_wvEvent, webPreferences, params) => {
    // For http(s) URLs that match a loaded extension's
    // externally_connectable.matches, install the runtime-external preload
    // which polyfills chrome.runtime.sendMessage(extId, msg) →
    // chrome.runtime.onMessageExternal in the BG SW. Only one preload per
    // webview is supported by Electron, and peek:// URLs already have their
    // own (tile-preload). The runtime-external bridge is irrelevant for
    // peek:// URLs anyway, so this check keeps both paths exclusive.
    if (params.src && (params.src.startsWith('http://') || params.src.startsWith('https://'))) {
      // Shared selection: matches a loaded extension's externally_connectable
      // OR its ISOLATED-world content scripts → runtime-external compat preload
      // (+ flags). Identical logic now drives the hybrid WebContentsView path
      // in ipc.ts. sandbox is disabled for these origins because Electron 40's
      // sandbox-bundle init crashes on subsequent navigations within Proton's
      // auth flow (/authorize → /reauth → /auth-ext), leaving the renderer in
      // a broken state where our preload's dom-ready listener never fires.
      const rtPrefs = getRuntimeExternalWebPrefsForUrl(params.src, 'webview');
      if (rtPrefs) {
        webPreferences.preload = rtPrefs.preload;
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          ...rtPrefs.additionalArguments,
        ];
        webPreferences.sandbox = rtPrefs.sandbox;
        webPreferences.contextIsolation = rtPrefs.contextIsolation;
        return;
      }
    }

    if (params.src && params.src.startsWith('peek://')) {
      const tilePreloadPath = getTilePreloadPath();
      if (!tilePreloadPath) return;

      // Special-case: HUD widget webviews (peek://hud/widgets/*.html).
      // HUD has no tile manifest; mint a trustedBuiltin token for all widgets
      // under a unified hud-widget tile id so they can use api.window.*,
      // api.context.*, api.izui.*, api.pubsub.*, etc.
      if (params.src.startsWith('peek://hud/widgets/')) {
        const HUD_WIDGET_ID = 'hud-widget';
        const HUD_WIDGET_ENTRY = 'main';
        const hudWidgetGrant = createTrustedBuiltinGrant(HUD_WIDGET_ID);
        const hudWidgetToken = generateToken(HUD_WIDGET_ID, HUD_WIDGET_ENTRY, hudWidgetGrant);
        webPreferences.preload = tilePreloadPath;
        (webPreferences as { additionalArguments?: string[] }).additionalArguments = [
          `--tile-id=${HUD_WIDGET_ID}`,
          `--tile-entry=${HUD_WIDGET_ENTRY}`,
          `--tile-token=${hudWidgetToken}`,
        ];
        DEBUG && console.log(`[webview] Injecting trustedBuiltin tile-preload for HUD widget: ${params.src}`);
        return;
      }

      const tileWebPrefs = getTileWebPreferencesForWebviewUrl(params.src, tilePreloadPath, getLazyTileManifest);
      if (tileWebPrefs) {
        webPreferences.preload = tileWebPrefs.preload;
        // Cast: Electron's WebPreferences type for webviews omits
        // additionalArguments in some versions, but the runtime accepts
        // it (set in BrowserWindow webPrefs the same way).
        (webPreferences as { additionalArguments?: string[] }).additionalArguments =
          tileWebPrefs.additionalArguments;
        DEBUG && console.log(
          `[webview] Injecting tile-preload for ${params.src} (tile=${tileWebPrefs.tileId}, entry=${tileWebPrefs.entryId})`
        );
      } else {
        // Any peek:// URL that reaches here is either a developer-extension
        // webview that needs a tile manifest, or a bug. Log a warning so it
        // surfaces.
        console.warn(`[webview] No tile-preload found for peek:// webview ${params.src} — no preload injected`);
      }
    }
  });

  // Auto-inject MAIN-world content_scripts from loaded chrome extensions whose
  // manifest `matches` patterns accept the webview's URL. Electron's
  // session.loadExtension does NOT auto-inject content_scripts (gap in its
  // Chrome API surface), so we drive injection ourselves via executeJavaScript,
  // which runs in main world. ISOLATED-world scripts (the default) need a real
  // isolated context with the extension's own chrome.runtime — handled
  // separately via the bridge-window relay in runtime-external.js. This loop
  // only handles `world: "MAIN"` entries (e.g. Proton Pass's webauthn.js).
  if (isPageHostContent(contents)) {
    // MAIN-world content-script injection (dom-ready) + runtime-external CDP
    // page polyfill (did-navigate). Both are now extracted into shared
    // installers in page-host-compat.ts so the IDENTICAL code runs for the
    // hybrid WebContentsView content path (called explicitly from ipc.ts after
    // markPageHostContent, sidestepping the web-contents-created timing trap).
    //
    // For a `<webview>` guest, `isPageHostContent` is already true at
    // web-contents-created time (getType() === 'webview'), so installing here
    // is correct and unchanged. See page-host-compat.ts for the full rationale
    // (CDP-vs-IPC race on Proton's SPA auth route, etc.).
    installMainWorldContentScriptInjection(contents);
    installRuntimeExternalCdpPolyfill(contents);

    // Diagnostic: forward webview-guest console + open DevTools when in DEBUG
    // mode and the URL is a Proton property. Lets us see whether our
    // chrome.runtime polyfill is reaching the page and what the auth-ext page
    // is actually doing when it shows the "communication error" message.
    if (DEBUG) {
      contents.on('console-message', (event) => {
        try {
          const e = event as unknown as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
          const msg = String(e.message ?? '');
          const level = String(e.level ?? '');
          const url = contents.getURL();
          // Forward only when there's actual signal:
          //   - any error/warning from a Proton page (extension diagnostics)
          //   - any message tagged with our 'peek:' / 'peek-rt' marker (intentional)
          // Plain info/log spam from Proton's content scripts (mouse tracking,
          // hydrate logs, etc.) is filtered out.
          const isPeekTagged = msg.includes('peek:') || msg.includes('peek-rt');
          const isProtonPage = url.includes('proton.me') || url.includes('proton.dev');
          const isErrorish = level === 'error' || level === 'warning' || level === 'warn';
          if (isPeekTagged || (isProtonPage && isErrorish)) {
            console.log(`[webview:${url.slice(0, 80)}:${level}] ${msg} (${String(e.sourceId)}:${String(e.lineNumber)})`);
          }
        } catch { /* logging must never throw */ }
      });
    }
  }
});

const strings = {
  defaults: {
    quitShortcut: 'CommandOrControl+Q'
  },
  topics: {
    prefs: 'topic:core:prefs'
  }
};

const profileIsLegit = (p: unknown): p is string =>
  p !== undefined && typeof p === 'string' && p.length > 0;

// Check if running from dev output directory (packaged but not installed)
// This catches: out/mac-arm64/Peek.app running from project directory
const isDevPackagedBuild = (): boolean => {
  if (!app.isPackaged) return false;
  const execPath = app.getPath('exe');
  // Running from out/ directory means it's a dev packaged build
  return execPath.includes('/out/') || execPath.includes('\\out\\');
};

// Determine environment context FIRST to scope profiles.db correctly
const defaultUserDataPath = app.getPath('userData');
const isDev = !app.isPackaged || isDevPackagedBuild();

// Use separate profiles.db for dev vs production to prevent interference
// Dev: ~/.config/Peek/.dev-profiles.db (hidden, prefixed)
// Production: ~/.config/Peek/profiles.db (default)
const profilesDbFile = isDev ? '.dev-profiles.db' : 'profiles.db';

// Initialize profiles database with scoped filename
try {
  initProfilesDb(defaultUserDataPath, profilesDbFile);
  migrateExistingProfiles();
  ensureDefaultProfile();
  DEBUG && console.log(`[profiles] Profiles database initialized: ${profilesDbFile}`);
} catch (error) {
  console.error('[profiles] Failed to initialize profiles:', error);
  // Continue with fallback behavior
}

// Profile selection:
// 1. Explicit PROFILE env var takes precedence (for dev/testing)
// 2. Development builds (source/dev-packaged) ALWAYS use 'dev' (isolation from production)
// 3. Production packaged builds use active profile from profiles.db
// 4. Fallback to 'default' if profiles.db fails
let PROFILE: string;

if (profileIsLegit(process.env.PROFILE)) {
  // Explicit env var takes precedence
  PROFILE = process.env.PROFILE;
  DEBUG && console.log('[profiles] Using PROFILE env var:', PROFILE);
} else if (isDev) {
  // Development builds ALWAYS use 'dev' profile (never touch production profiles)
  PROFILE = 'dev';
  DEBUG && console.log('[profiles] Development build, forcing dev profile');
} else {
  // Production packaged build - use active profile from profiles.db
  try {
    const activeProfile = getActiveProfile();
    PROFILE = activeProfile.folder;
    DEBUG && console.log('[profiles] Using active profile from profiles.db:', PROFILE);
  } catch (error) {
    // Fallback to default if profiles.db fails
    PROFILE = 'default';
    DEBUG && console.log('[profiles] Fallback to default PROFILE:', PROFILE);
  }
}

DEBUG && console.log('PROFILE', PROFILE, app.isPackaged ? (isDevPackagedBuild() ? '(dev-packaged)' : '(packaged)') : '(source)');

// Set profile in backend config
setProfile(PROFILE);

// Profile dirs are subdir of userData dir
// {home} / {appData} / {userData} / {profileDir}
// Chromium's data in a subfolder of profile folder
// {home} / {appData} / {userData} / {profileDir} / {sessionData}

// specify various app data paths and make if not exist
const profileDataPath = path.join(defaultUserDataPath, PROFILE);
const sessionDataPath = path.join(profileDataPath, 'chromium');

// create filesystem
if (!fs.existsSync(sessionDataPath)) {
  fs.mkdirSync(sessionDataPath, { recursive: true });
}

// Configure userData per-profile BEFORE requesting the single-instance
// lock. Electron stores its SingletonLock inside userData, so a
// per-profile userData yields a per-profile lock: two packaged Peeks
// running under different PROFILE= values can coexist, while two under
// the same PROFILE= still block. If setPath ran after the lock check,
// the lock would resolve against the default userData dir and become
// app-global, blocking all parallel-profile workflows.
app.setPath('userData', profileDataPath);
app.setPath('sessionData', sessionDataPath);

// Always-on main-process log: mirrors every console.{log,info,warn,error,debug}
// from this process to <userData>/logs/main.log. Initialised here, immediately
// after app.setPath('userData', ...) resolves the per-profile dir, so as many
// startup log lines as possible land in the file (including a lock-failure
// bailout below). Failures are swallowed.
initMainLog();

// Acquire single instance lock EARLY (before app.whenReady).
// This is critical on macOS: when a second instance is launched via
// `open -a Peek URL`, Electron needs the lock to be held BEFORE the
// second instance reaches app.whenReady. Otherwise, the second instance
// processes the Apple Event (open-url) locally and then quits, losing
// the URL. With early lock acquisition, Electron forwards the open-url
// event to the first (primary) instance.
if (!requestSingleInstance()) {
  // Another instance is already running for this profile. On macOS,
  // Electron forwards the Apple Event to the primary instance. On
  // Windows/Linux, the second-instance event fires with argv. Either
  // way, quit this instance.
  // Note: app.quit() was already called inside requestSingleInstance().
  // app.exit() terminates immediately (sync), preventing further init.
  app.exit(0);
  // TypeScript doesn't know app.exit() is noreturn, but it is.
}

// Windows/Linux: handle URLs when another instance tries to open.
// Must be registered early (before app.whenReady) so the handler is
// ready when the second-instance event fires.
registerSecondInstanceHandler();

// ***** Features / Strings *****

const labels = {
  app: {
    key: 'peek',
    title: 'Peek'
  },
  tray: {
    tooltip: 'Click to open'
  }
};

// ***** System / OS / Theme *****

// Register activate handler (macOS dock click)
registerActivateHandler();

// ***** Caches *****

// app global prefs configurable by user
// populated during app init
let _prefs: Record<string, unknown> = {};
let _quitShortcut: string | null = null;

// Set up prefs getter for backend window helpers
setPrefsGetter(() => _prefs);

// Define onQuit for use in IPC handlers and shortcuts
const onQuit = async () => {
  // Clean up dev tiles before quitting
  cleanupDevTiles();
  // Clean up web extensions
  cleanupAdblocker();
  await cleanupChromeExtensions();
  stopHotReload();
  quitApp();
};

// Ensure cleanup happens regardless of HOW quit is triggered.
// When tests call app.quit() directly (via electronApp.evaluate), the onQuit
// function above is bypassed. This before-quit handler ensures hot reload watchers,
// database connections, and other resources are cleaned up so the process can exit.
let _beforeQuitCleanupDone = false;
app.on('before-quit', () => {
  if (_beforeQuitCleanupDone) return;
  _beforeQuitCleanupDone = true;
  DEBUG && console.log('[lifecycle] before-quit: running cleanup');
  // FIRST: silence the runtime-external relay before any teardown below. The
  // handler stays registered through quit, so a late content-script LOG_EVENT
  // must not dispatch into the session / service workers / bridge windows that
  // destroyChromeExtensionWindowsForShutdown() (and Electron's own quit) are
  // about to free — that deref faults the main process (peek 048997b2).
  try { markRuntimeExternalQuitting(); } catch (e) { DEBUG && console.error('[lifecycle] markRuntimeExternalQuitting error:', e); }
  try { stopAutosaveTimer(); } catch (e) { DEBUG && console.error('[lifecycle] stopAutosaveTimer error:', e); }
  try { cleanupDisplayWatcher(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupDisplayWatcher error:', e); }
  try { saveSessionSnapshot('before-quit'); } catch (e) { DEBUG && console.error('[lifecycle] saveSessionSnapshot error:', e); }
  try { cleanupDevTiles(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupDevTiles error:', e); }
  try { cleanupAdblocker(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupAdblocker error:', e); }
  try { stopHotReload(); } catch (e) { DEBUG && console.error('[lifecycle] stopHotReload error:', e); }
  try { cleanupThumbnails(getActiveThumbnailHashes); } catch (e) { DEBUG && console.error('[lifecycle] cleanupThumbnails error:', e); }
  try { shutdown(); } catch (e) { DEBUG && console.error('[lifecycle] shutdown error:', e); }
  // Tear down page-host guests BEFORE Electron closes their host windows during
  // quit. App-quit (incl. tests' app.close() → app.quit()) closes leftover
  // page-host windows via the native quit path, bypassing closeHostWindow — a
  // guest with an in-flight chrome-ext relay invoke would otherwise be derefed
  // inside -[NSWindow __close] → EXC_BAD_ACCESS (peek d1cf0b9a). Runs AFTER
  // saveSessionSnapshot above so session restore still sees live guests.
  try { destroyAllPageHostGuests(); } catch (e) { DEBUG && console.error('[lifecycle] destroyAllPageHostGuests error:', e); }
  // Same rationale for the chrome-extension bridge windows: they relay
  // structured-clone messages over a live BG-SW Port and must be destroy()'d
  // (not left to the native quit __close) or they fault the same way. The async
  // cleanupChromeExtensions() that normally does this only runs via onQuit,
  // which a direct app.quit() bypasses — so do the window teardown here too.
  try { destroyChromeExtensionWindowsForShutdown(); } catch (e) { DEBUG && console.error('[lifecycle] destroyChromeExtensionWindowsForShutdown error:', e); }
  DEBUG && console.log('[lifecycle] before-quit: cleanup complete');
});

// Handle SIGINT/SIGTERM (e.g. Ctrl+C in terminal).
// app.quit() is async and won't complete before yarn kills the process,
// so we save synchronously (better-sqlite3) then exit immediately.
// Both signals are treated as clean shutdowns because they are intentional:
// - SIGINT = user pressed Ctrl+C (deliberate quit)
// - SIGTERM = system shutdown or process manager stop (graceful termination)
// Crash recovery should only trigger when the process dies WITHOUT a signal
// handler running (kill -9, segfault, OOM), in which case markSessionDirty's
// cleanShutdown=false persists because no save ever overwrites it.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[lifecycle] ${signal} received, clean exit`);
    try { stopAutosaveTimer(); } catch { /* ignore */ }
    // Save session with clean shutdown flag so next startup doesn't show crash dialog.
    // The snapshot is saved so autosave data isn't lost, but cleanShutdown=true means
    // the restore will be silent (no crash dialog).
    try { saveSessionSnapshot('before-quit'); console.log('[lifecycle] Session saved with cleanShutdown=true'); } catch (e) { console.error('[lifecycle] signal save error:', e); }
    try { shutdown(); } catch { /* ignore */ }
    process.exit(0);
  });
}

/**
 * Register command-palette entries for loaded chrome extensions that
 * expose an options page (manifest.options_page or manifest.options_ui.page).
 *
 * For each such extension we register a "<name> options" command and
 * subscribe to its execution topic so the main process can open the
 * options page in a new BrowserWindow via openChromeExtensionPage().
 *
 * Only options pages are registered here — other manifest UI entry
 * points (popup, newtab, devtools, etc.) are intentionally out of
 * scope; those have their own surfaces.
 */
function registerChromeExtensionCommands(): void {
  const commands = getChromeExtensionOptionsCommands();
  if (commands.length === 0) return;

  const systemAddress = getSystemAddress();

  for (const cmd of commands) {
    const execTopic = `cmd:execute:${cmd.commandName}`;

    // Subscribe to execution topic so we handle invocation in the main process.
    // Publish :result back immediately so the cmd panel proxy resolves instead
    // of waiting for its 30s timeout (openChromeExtensionPage is fire-and-forget
    // from the cmd panel's perspective).
    subscribe(systemAddress, execTopic, () => {
      DEBUG && console.log(`[chrome-ext] Executing command: ${cmd.commandName}`);
      openChromeExtensionPage(cmd.extensionId, 'options');
      publish(systemAddress, `${execTopic}:result`, { success: true });
    });

    // Register the command with the cmd registry.
    publish(systemAddress, 'cmd:register', {
      name: cmd.commandName,
      description: `Open ${cmd.extensionName} options page`,
      source: systemAddress,
      scope: 'global',
    });
  }

  DEBUG && console.log(`[chrome-ext] Registered ${commands.length} options command(s) for chrome extensions`);
}

// ***** init *****

// Electron app load
const onReady = async () => {
  const startupStart = Date.now();
  DEBUG && console.log('onReady');

  // Hide dock early to prevent flash in app switcher
  // Will be shown/hidden properly once prefs are loaded
  if (app.dock) {
    app.dock.hide();
  }

  // Initialize backend (database, protocol handler, pubsub broadcaster)
  await initialize();

  // Set a custom application menu so Electron's default macOS menu doesn't
  // intercept Cmd+, (Preferences accelerator). The default Electron menu on
  // macOS includes a Preferences item with Cmd+, which consumes the keystroke
  // before before-input-event fires, preventing our local shortcut handler
  // from seeing it. We keep standard Edit accelerators (copy/paste/etc.) and
  // the app submenu (hide/quit), but omit the Preferences accelerator.
  if (process.platform === 'darwin' && !isHeadless()) {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { label: 'Close Window', accelerator: 'CommandOrControl+W', click: () => {
              const win = BrowserWindow.getFocusedWindow();
              if (win) {
                // Devtools (detached) isn't a BrowserWindow — it's a child of
                // the parent's webContents. When the user focuses devtools and
                // hits Cmd+W, getFocusedWindow() still returns the parent.
                // Detect via "devtools open AND parent webContents not
                // focused" — `isDevToolsFocused()` alone has been observed to
                // return false in Electron 40 when devtools is the OS-focused
                // window. Route to closeDevTools so the parent survives.
                const wc = win.webContents;
                if (wc.isDevToolsOpened() && (wc.isDevToolsFocused() || !wc.isFocused())) {
                  wc.closeDevTools();
                  return;
                }
              }
              // Close the window the user means to close, via the overlay-aware
              // resolver (resolveFocusedWindowIdForClose):
              //   - focused BrowserWindow that isn't the overlay → close it
              //     (settings, modals, canvas page-hosts);
              //   - no focused BrowserWindow → the frontmost window may be a
              //     hybrid page-host (a BaseWindow getFocusedWindow() never
              //     returns) → close the active hybrid host (peek ca4ee5e6);
              //   - focused window IS the shared chrome overlay (address
              //     bar/widgets open via Cmd+L) → close the active hybrid host,
              //     not just the chrome, so the whole page-host goes away.
              // No-op when nothing resolves (cmd+W harmless with no window).
              closeFocusedWindow();
          }},
          { role: 'minimize' },
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    // Non-macOS platforms, or headless test runs: remove the menu entirely so
    // it doesn't consume shortcut accelerators or build an unused app menu.
    // (Headless also runs as an 'accessory' app via setActivationPolicy below,
    // so it can never own the system menubar regardless — this just avoids
    // building the template needlessly.)
    Menu.setApplicationMenu(null);
  }

  // Initialize display change watcher (repositions windows when monitors change)
  initDisplayWatcher();

  // Initialize thumbnail directory for page screenshot thumbnails
  initThumbnailDir();

  // IMPORTANT: Read crash state BEFORE markSessionDirty() overwrites it.
  // markSessionDirty sets cleanShutdown=false, so we must capture the true
  // previous shutdown state first for the crash recovery dialog.
  const _crashState = readSessionCrashState();
  DEBUG && console.log('[session] Previous shutdown state:', _crashState);

  // Now mark session as dirty for crash detection going forward
  markSessionDirty();

  // Load persisted closed window stack so undo-close-window works across restarts.
  // This includes windows from the previous session (pushed during before-quit save).
  loadClosedWindowStack();

  // Check if session restore has a valid snapshot waiting.
  // This flag tells the core app to skip the startup feature (settings window)
  // when there are windows to restore.
  let _sessionRestorePending = false;
  try {
    const db = getDb();
    const snapshotRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
    ).get() as { value: string } | undefined;
    if (snapshotRow?.value) {
      const snapshot = JSON.parse(snapshotRow.value);
      if (snapshot.version === 1 && snapshot.windows && snapshot.windows.length > 0) {
        // Check if too many consecutive crashes — skip restore to break crash loop
        const skipDueToCrash = !_crashState.cleanShutdown && _crashState.crashCount > 3;
        if (!skipDueToCrash) {
          _sessionRestorePending = true;
          DEBUG && console.log(`[session] Valid snapshot found with ${snapshot.windows.length} window(s), restore pending`);
        }
      }
    }
  } catch (err) {
    DEBUG && console.log('[session] Failed to pre-check snapshot:', err);
  }

  // IPC handler for core app to check if session restore will happen
  // (used to skip the startup feature when restore is pending)
  ipcMain.handle('session-restore-pending', () => {
    return _sessionRestorePending;
  });

  // IPC handler for background window's app/index.js to signal readiness.
  // Pending external URLs won't be processed until this fires.
  ipcMain.handle('frontend-ready', () => {
    notifyFrontendReady();
    return true;
  });

  // Initialize session partitioning for profile isolation
  // This must happen early, before any sessions are used
  initSessionPartition(PROFILE, defaultUserDataPath);

  // Register all IPC handlers from backend
  registerAllHandlers(onQuit);

  // P1.4b-1 — start the hybrid shared chrome overlay manager. Subscribes to
  // the hybrid registry's active-window push signal and lazily creates the ONE
  // shared overlay window that retargets over the frontmost hybrid content
  // window.
  initHybridOverlay();

  // P1.4b-2 — install the chrome→content navbar action routing for hybrid
  // windows (navigate/back/forward/reload published by the overlay renderer are
  // resolved to the active hybrid window's content webContents here).
  // Idempotent.
  installHybridNavbarActionRouting();

  // Always-on renderer log: writes every console.{log,info,warn,error,debug}
  // from any preload-managed renderer to <userData>/logs/renderer.log.
  // Must be called after app is ready (app.getPath('userData') requires it).
  initRendererLog();

  // Run daily backup check (non-blocking)
  checkAndRunDailyBackup().catch(err => {
    console.error('[startup] Backup check failed:', err);
  });

  // Store startup time for reporting
  (global as Record<string, unknown>).__startupStart = startupStart;

  // Note: requestSingleInstance() and registerSecondInstanceHandler()
  // are called early (before app.whenReady) for proper URL forwarding.
  // See the block after setProfile(PROFILE) above.

  // Discover and register built-in features (tiles) from features/ folder
  discoverBuiltinFeatures(path.join(DESKTOP_DIR, 'features'));

  // Register dev tiles from CLI arguments (--load-extension flag)
  // These are transient (not persisted) and load with devtools open
  for (const tilePath of devTilePaths) {
    try {
      const manifest = loadFeatureManifest(tilePath);
      if (manifest && manifest.id) {
        registerDevTile(manifest.id as string, tilePath);
      } else {
        console.error(`[cli] Invalid tile at ${tilePath}: missing id in manifest`);
      }
    } catch (err) {
      console.error(`[cli] Failed to load tile manifest at ${tilePath}:`, err);
    }
  }

  // Discover and register built-in themes from features/ (type: "theme") with legacy themes/ fallback
  discoverBuiltinThemes(path.join(DESKTOP_DIR, 'features'), path.join(DESKTOP_DIR, 'themes'));

  // Initialize bundled web extensions infrastructure.
  // electron-builder.yml lists chrome-extensions/** in asarUnpack so the
  // files land on a real filesystem (Chromium's session.loadExtension
  // doesn't go through Electron's transparent asar fs patching — it
  // needs a literal disk path). In packaged builds the unpacked tree
  // lives at ${resourcesPath}/app.asar.unpacked/. DESKTOP_DIR
  // (= app.getAppPath()) points inside app.asar itself, so we'd need
  // to swap it out otherwise.
  const chromeExtensionsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'apps', 'desktop', 'chrome-extensions')
    : path.join(DESKTOP_DIR, 'chrome-extensions');
  initChromeExtensionManager(chromeExtensionsDir);

  // Restore saved theme preference (must be after themes are discovered)
  restoreSavedTheme();

  // Peek does NOT auto-register as the default http/https handler on launch.
  // That only happens via the Settings button (the tile:app:set-default-browser
  // IPC handler in tile-ipc.ts). Auto-registering on startup popped a macOS
  // "make Electron your default browser?" prompt on every background launch.
  // Guarded by tests/unit/no-auto-default-browser.test.js.

  // Handle CLI arguments (e.g., yarn start -- "https://example.com")
  handleCliUrl();

  // Track if features have been loaded (only load once)
  let featuresLoaded = false;

  // listen for app prefs to configure ourself
  // TODO: kinda janky, needs rethink
  subscribe(systemAddress, strings.topics.prefs, async (msg: unknown) => {
    const prefsMsg = msg as { prefs: Record<string, unknown> };
    DEBUG && console.log('PREFS', prefsMsg);

    // cache all prefs
    _prefs = prefsMsg.prefs;

    // Apply dock preference
    applyDockPreference();

    // initialize system tray (never under headless test runs — a Tray is a
    // visible menubar status item that setActivationPolicy/accessory mode does
    // NOT suppress, so each headless instance would otherwise leak its own icon
    // into the user's menubar; multi-worker runs stack several).
    if (prefsMsg.prefs.showTrayIcon === true && !isHeadless()) {
      DEBUG && console.log('showing tray');
      initTray(DESKTOP_DIR, {
        tooltip: labels.tray.tooltip,
        onClick: () => {
          publish(WEB_CORE_ADDRESS, 'open', {
            address: SETTINGS_ADDRESS
          });
        }
      });
    }

    // update quit shortcut if changed (local shortcut - only works when app has focus)
    const newQuitShortcut = (prefsMsg.prefs.quitShortcut as string) || strings.defaults.quitShortcut;
    if (newQuitShortcut !== _quitShortcut) {
      if (_quitShortcut) {
        DEBUG && console.log('unregistering old quit shortcut:', _quitShortcut);
        unregisterLocalShortcut(_quitShortcut);
      }
      DEBUG && console.log('registering new quit shortcut:', newQuitShortcut);
      registerLocalShortcut(newQuitShortcut, 'system', onQuit);
      _quitShortcut = newQuitShortcut;
    }

    // Reconcile CLI dispatch socket against the user pref. Default true
    // (only an explicit `false` disables it). Single source of truth for
    // both first-launch start and live toggle from Settings UI.
    const cliSocketEnabled = prefsMsg.prefs.cliSocketEnabled !== false;
    const socketRunning = isCliSocketRunning();
    if (cliSocketEnabled && !socketRunning) {
      try {
        await startCliSocketServer(PROFILE);
      } catch (err) {
        console.error('[entry] cli-socket startup failed:', err);
      }
    } else if (!cliSocketEnabled && socketRunning) {
      await stopCliSocketServer();
    }

    // Load features after core app is ready (only once)
    if (!featuresLoaded) {
      featuresLoaded = true;

      // Background CPU watchdog: auto-attributes hot OS processes to their
      // tile/window in main.log so a hot prod Peek is self-diagnosing. Skip
      // headless/test runs (no real windows to attribute, and noise in CI).
      if (!isHeadless()) startCpuWatch();

      const featStart = Date.now();
      await loadFeatures();

      // Load dev tiles after normal features (always with devtools)
      if (devTilePaths.length > 0) {
        const devCount = await loadDevTiles();
        DEBUG && console.log(`[tile:dev] Loaded ${devCount} dev tile(s)`);
      }

      // Load bundled web extensions (chrome extensions + adblocker)
      // Adblocker: enabled by default, check prefs for override
      const adBlockerEnabled = prefsMsg.prefs.adBlockerEnabled !== false;
      if (adBlockerEnabled) {
        applyAdblockerConfig({ enabled: true }).catch(err => {
          console.error('[startup] Adblocker init failed:', err);
        });
      }

      // Load chrome extensions BEFORE session restore. Electron's native
      // content_scripts injection fires when a webContents on the extension's
      // session navigates to a matching URL — but only if the extension is
      // already loaded on the session. Awaiting here ensures extensions are
      // registered before session restore creates and navigates webviews,
      // eliminating the race that caused inconsistent ISOLATED-world content
      // script injection (e.g. orchestrator.js) into webview guests.
      try {
        await loadEnabledChromeExtensions();
        registerChromeExtensionCommands();
        publish(systemAddress, 'chrome-extensions:loaded', {});

        // PEEK_AUTOOPEN_EXT=<extId>:<pageType> auto-opens a chrome extension UI
        // page after extensions load. Used by scripts/dev-popup.sh for fast
        // iteration on the chrome-extension compat layer (skip the manual
        // toolbar-click to get to the popup). Format: "proton-pass:popup".
        const _autoOpen = process.env.PEEK_AUTOOPEN_EXT;
        if (_autoOpen) {
          const [extId, pageType] = _autoOpen.split(':');
          if (extId && pageType) {
            const win = openChromeExtensionPage(extId, pageType as 'popup' | 'options' | 'background' | 'newtab' | 'history' | 'bookmarks' | 'devtools' | 'sidepanel');
            if (win) {
              console.log(`[startup] PEEK_AUTOOPEN_EXT opened ${extId}:${pageType}`);
            } else {
              console.error(`[startup] PEEK_AUTOOPEN_EXT failed to open ${extId}:${pageType}`);
            }
          } else {
            console.error(`[startup] PEEK_AUTOOPEN_EXT malformed (expected "<extId>:<pageType>"): ${_autoOpen}`);
          }
        }
      } catch (err) {
        console.error('[startup] Chrome extensions init failed:', err);
      }

      const featTime = Date.now() - featStart;
      const totalTime = Date.now() - ((global as Record<string, unknown>).__startupStart as number);
      DEBUG && console.log(`[startup] main: ${featStart - ((global as Record<string, unknown>).__startupStart as number)}ms, features: ${featTime}ms, total: ${totalTime}ms`);

      // PEEK_AUTOOPEN_EXT mode: skip session restore + startup feature so the
      // dev iteration loop opens cleanly with only the auto-opened extension
      // page. See `scripts/dev-popup.sh`.
      if (process.env.PEEK_AUTOOPEN_EXT) {
        _sessionRestorePending = false;
        notifySessionRestoreDone();
        DEBUG && console.log('[session] PEEK_AUTOOPEN_EXT set — skipping session restore + startup feature');
      }

      // Restore session after features are loaded
      if (_sessionRestorePending) {
        try {
          // Boot restore — pass isColdStart=true so the focused descriptor is
          // raised+activated even if the macOS startup activation dance
          // transiently flips appFocused false mid-restore. (_forceForTest=false
          // here; the cold-start signal is the 4th positional arg.) See
          // shouldActivateFocusedOnRestore() in izui-roles.ts.
          const restoreResult = await restoreSessionSnapshot(prefsMsg.prefs, _crashState, false, true);
          DEBUG && console.log(`[session] Restore result:`, restoreResult);
          if (restoreResult.restored === 0) {
            _sessionRestorePending = false;
            // Nothing restored (user declined, or snapshot was empty).
            // The startup feature was suppressed, so open it now.
            DEBUG && console.log('[session] No windows restored, opening startup feature');
            publish(systemAddress, 'session:open-startup', {});
          }
        } catch (err) {
          console.error('[session] Session restore failed:', err);
          _sessionRestorePending = false;
          publish(systemAddress, 'session:open-startup', {});
        }
        // Signal that session restore is done (success or failure)
        // so pending external URLs can now be processed.
        notifySessionRestoreDone();
      } else {
        // No session restore pending — signal immediately
        notifySessionRestoreDone();
      }

      // Start periodic autosave timer (Phase 3)
      const autosaveInterval = (typeof prefsMsg.prefs.sessionAutosaveInterval === 'number')
        ? prefsMsg.prefs.sessionAutosaveInterval
        : 5;
      startAutosaveTimer(autosaveInterval);
    } else {
      // Extensions already loaded — this is a pref change, update autosave interval if changed
      const autosaveInterval = (typeof prefsMsg.prefs.sessionAutosaveInterval === 'number')
        ? prefsMsg.prefs.sessionAutosaveInterval
        : 5;
      updateAutosaveInterval(autosaveInterval);
    }
  });

  // Create the core background window (tile mechanics — see
  // apps/desktop/main/core-glue.ts::initCore). Awaited so startup code
  // downstream sees a fully-initialised renderer with all subscribers
  // registered before e.g. CLI URLs get replayed.
  await createBackgroundWindow();

  // On AppImage, refresh the peek-cli shadow at ~/.local/share/peek/
  // so binding to that absolute path keeps working across launches
  // (the AppImage mount path is ephemeral). No-op everywhere else.
  await ensureCliHelperShadow();

  // Linux/AppImage desktop integration: install peek.desktop +
  // hicolor icons under ~/.local/share/ so xdg-mime, the system
  // "Default Applications" UI, and our own settings "Set as default
  // HTTP handler" button can find the application. Required because
  // AppImage's mount is ephemeral and never auto-installs into the
  // user's XDG dirs. See apps/desktop/main/desktop-installer.ts.
  await ensureLinuxDesktopInstall();

  // Same gate: install a `peek` symlink in ~/.local/bin so users can
  // run `peek https://example.com` from a shell. argv-URL handling is
  // already wired in main.ts (handleCliUrl + second-instance handler).
  await ensureLinuxCliAlias();

  // Note: cli-socket startup happens in the prefs subscriber (below)
  // so the cliSocketEnabled toggle is honoured from the first publish.
  // See docs/global-hotkeys-on-wayland.md for the dispatch architecture.

  // Start hot reload in dev mode
  if (DEBUG) {
    startHotReload(DESKTOP_DIR);
  }

  // Register default quit shortcut (local - only works when app has focus)
  // Will be updated when prefs arrive
  _quitShortcut = strings.defaults.quitShortcut;
  registerLocalShortcut(_quitShortcut, 'system', onQuit);

  // Register reopen-last-closed-window shortcut (Cmd+Shift+T / Ctrl+Shift+T)
  registerLocalShortcut('CommandOrControl+Shift+T', 'system', () => {
    reopenLastClosedWindow();
  });

  // Register new-window shortcut (Cmd+N / Ctrl+N)
  // Opens a new page host window with navbar focused for immediate URL entry
  registerLocalShortcut('CommandOrControl+N', 'system', () => {
    openNewPageWindow();
  });

  // Close-window shortcut. The macOS application menu (set above) already
  // wires Cmd+W via an `accelerator` entry; on non-darwin we set the menu
  // to null to avoid stealing accelerators, which leaves Cmd+W unbound.
  // Register it as a system local shortcut so Linux/Windows users get
  // OS-standard "close current window" behaviour.
  if (process.platform !== 'darwin') {
    registerLocalShortcut('CommandOrControl+W', 'system', () => {
      // R1: resolve a focused hybrid page-host (BaseWindow) too, not just a
      // focused BrowserWindow (which getFocusedWindow() can't see).
      closeFocusedWindow();
    });
  }

  // Mark app as ready and process any URLs that arrived during startup
  setAppReady();
};

// macOS: handle open-url event (must be registered before app.whenReady)
registerExternalUrlHandlers();

// ***** Dark Mode (early read before app.ready) *****
// Read dark mode setting from database before app.ready so we can:
// 1. Set nativeTheme.themeSource (Tier 1)
// 2. Apply WebContentsForceDark command-line switch (Tier 2, must be before app.ready)
let _darkModeSetting = 'system'; // default
const dbPath = path.join(profileDataPath, 'datastore.sqlite');
if (fs.existsSync(dbPath)) {
  try {
    const earlyDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = earlyDb.prepare(
      "SELECT value FROM feature_settings WHERE featureId = 'core' AND key = 'darkMode'"
    ).get() as { value: string } | undefined;
    if (row?.value) {
      // Value is JSON-encoded (stored via setThemeSetting which JSON.stringify's)
      try {
        _darkModeSetting = JSON.parse(row.value);
      } catch {
        _darkModeSetting = row.value;
      }
    }
    earlyDb.close();
    DEBUG && console.log('[darkMode] Early read from db:', _darkModeSetting);
  } catch (err) {
    DEBUG && console.log('[darkMode] Early db read failed (using default):', err);
  }
}

// Tier 2: Apply WebContentsForceDark command-line switch for 'force' mode
// This must be set before app.ready. Uses CIELAB-based inversion and skips images.
if (_darkModeSetting === 'force') {
  app.commandLine.appendSwitch(
    'enable-features',
    'WebContentsForceDark:inversion_method/cielab_based/image_behavior/none'
  );
  DEBUG && console.log('[darkMode] Tier 2: WebContentsForceDark enabled via command-line switch');
}

// Disable Chromium Site Isolation so cross-origin iframes share the parent
// frame's renderer process. Required for `webPreferences.sandbox = false` set
// on a webview to actually take effect for child iframes — otherwise each
// cross-origin iframe spins up its own out-of-process renderer that ignores
// the parent's sandbox preference and re-enters Electron 40's broken
// sandbox_bundle init ("TypeError: object null is not iterable" inside
// ___electron_webpack_init__). Concretely this manifests on Proton's reauth
// page: the embedded account-api.proton.me captcha iframe crashes during
// init, the captcha never produces a token, the server rejects the unlock
// request with HTTP 422, and the page renders "Oops, something went wrong".
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');

// Configure app before ready (registers protocol scheme, sets theme)
configure({
  rootDir: DESKTOP_DIR,
  userDataPath: defaultUserDataPath,
  profile: PROFILE,
  isDev: DEBUG,
  isTest: PROFILE.startsWith('test'),
  darkMode: _darkModeSetting,
});

// Register window-all-closed handler
registerWindowAllClosedHandler(quitApp);

// Hide dock icon in headless mode to prevent focus stealing (macOS)
if (isHeadless() && process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

// Headless: make the app an "accessory" so it can never become the frontmost
// application. dock.hide() alone removes the Dock tile but leaves the app a
// REGULAR (activatable) app — so any win.show()/win.focus() (even on an
// opacity-0 window, since opacity hides pixels but not activation) still
// foregrounds Peek and steals OS focus + churns the system menubar. Accessory
// policy closes that activation gap at the OS level: window-level focus/blur
// events still fire (cmd / transient-on-blur / izui detection keep working),
// but the app cannot yank focus from the user's foreground app or own the
// menubar during headless test runs. See tasks d9bb2924 (focus steal) and
// cdf2e5f8 (menubar churn).
if (process.platform === 'darwin' && app.setActivationPolicy) {
  // Centralized invariant (see headlessActivationPolicy): non-headless → null
  // (leave the app 'regular'/activatable so it owns the menubar + key window —
  // peek 8f7010a8); headless → 'accessory' (dock-less + no menubar churn, but
  // still activatable for key-window handoff), NEVER 'prohibited' (commit
  // c9e892fa stuck-focus regression, reverted by 94121bc1). Applying it
  // unconditionally (with null = no-op for the real app) keeps the real app from
  // ever being silently left on a stale accessory policy.
  const policy = headlessActivationPolicy(isHeadless());
  if (policy) app.setActivationPolicy(policy);
}

// Headless strict guard: no BrowserWindow must appear visible immediately
// after construction during headless test runs. Windows created with show:true
// flash on the user's physical macOS desktop. Any drift from the isHeadless()
// gate in BrowserWindow constructors is caught here and fails the process.
//
// Note: BrowserWindow.prototype.show() calls are NOT blocked — session restore,
// test helpers (showWindow/fireWindowFocus), and page-host flows all legitimately
// call .show() on already-hidden windows. Only the constructor show:true path
// is the physical flash vector; it fires the OS compositor before JS can hide
// the window again.
//
// Guard scope: PEEK_HEADLESS=1 AND test profile only.
if (isHeadless() && isTestProfile()) {
  app.on('browser-window-created', (_event, win) => {
    // Check visibility in the next tick. If the window is already visible at
    // creation time it was constructed with show:true. setImmediate defers past
    // the internal Electron constructor synchronous show path while still
    // running before any app JS touches the window.
    setImmediate(() => {
      if (win.isDestroyed()) return;
      if (win.isVisible()) {
        let url = '(no-url)';
        try { url = win.webContents.getURL() || '(no-url)'; } catch { /* destroyed */ }
        const msg = `[headless-violation] BrowserWindow id=${win.id} visible at construction time (show:true?) url=${url} — fix: gate show: on !isHeadless()`;
        console.error(msg);
        console.error(new Error(msg).stack);
        // Fail hard so CI catches the regression.
        process.exitCode = 1;
        throw new Error(msg);
      }
    });
  });
  console.log('[headless-guard] BrowserWindow creation guard active (visible-at-ctor throws)');

  // ── show / showInactive prototype guard ────────────────────────────────
  // Any call to win.show() or win.showInactive() that bypasses
  // showWindowHeadlessSafe() will reach here with opacity != 0 and will
  // therefore be visible on the real display. Intercept both methods and
  // throw if the window's opacity wasn't zeroed first, so future
  // accidental call sites are caught immediately rather than silently
  // flashing windows onto the user's screen.
  //
  // Exempt: the opacity is checked BEFORE the original method runs.
  // showWindowHeadlessSafe() already calls setOpacity(0) first, so
  // compliant callers always pass the check.
  const _origShow = BrowserWindow.prototype.show;
  const _origShowInactive = BrowserWindow.prototype.showInactive;

  function headlessShowGuard(this: BrowserWindow, methodName: 'show' | 'showInactive', origFn: () => void): void {
    if (!this.isDestroyed() && this.getOpacity() !== 0) {
      let url = '(no-url)';
      try { url = this.webContents.getURL() || '(no-url)'; } catch { /* destroyed */ }
      const msg = `[headless-violation] ${methodName}() called on id=${this.id} with opacity=${this.getOpacity()} (not 0) url=${url} — use showWindowHeadlessSafe()`;
      console.error(msg);
      console.error(new Error(msg).stack);
      process.exitCode = 1;
      throw new Error(msg);
    }
    origFn.call(this);
  }

  BrowserWindow.prototype.show = function(this: BrowserWindow) {
    headlessShowGuard.call(this, 'show', _origShow);
  };
  BrowserWindow.prototype.showInactive = function(this: BrowserWindow) {
    headlessShowGuard.call(this, 'showInactive', _origShowInactive);
  };

  console.log('[headless-guard] BrowserWindow show/showInactive prototype guard active (opacity must be 0)');

  // ── focus / moveTop / restore / center / setVisibleOnAllWorkspaces no-op guard ──
  // These methods can steal OS-level focus from the user's foreground app or
  // trigger a visible flash on macOS, but ONLY when called on a hidden window.
  // Visible windows (cmd panel, modals being interacted with by Playwright)
  // legitimately need real focus behavior — cmd-hashtag-search, cmdl-on-error-page,
  // and transient-on-blur tests all depend on this.
  //
  // Gate: identical to the show/showInactive guard above — use opacity===0 as
  // the "hidden" signal. showWindowHeadlessSafe sets opacity=0 first, so a
  // window in mid-show transition is correctly considered hidden until opacity
  // is restored to 1. Visible windows pass through to the original method.
  //
  // Strategy: count + warn (first 3 per method) when no-op fires, with stack,
  // so the worst call sites can be hardened individually later.
  const _headlessNoOpCounts = {
    focus: 0,
    moveTop: 0,
    restore: 0,
    center: 0,
    setVisibleOnAllWorkspaces: 0,
  };

  type NoOpMethodName = keyof typeof _headlessNoOpCounts;

  function makeHeadlessNoOp<K extends NoOpMethodName>(
    name: K,
    orig: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => unknown {
    return function(this: BrowserWindow, ...args: unknown[]) {
      // Gate on opacity (same signal as the show/showInactive guard).
      // Hidden window → no-op + warn; visible window → real behavior.
      if (!this.isDestroyed() && this.getOpacity() === 0) {
        _headlessNoOpCounts[name]++;
        if (_headlessNoOpCounts[name] <= 3) {
          let url = '(no-url)';
          try { url = this.webContents?.getURL?.() ?? '(no-url)'; } catch { /* destroyed */ }
          console.warn(`[headless-noop] ${name}() called on id=${this.id} url=${url} opacity=0 — no-op in headless`);
          console.warn(new Error('[headless-noop] stack').stack);
        }
        return;
      }
      return orig.apply(this, args);
    };
  }

  const _origFocus = BrowserWindow.prototype.focus;
  const _origMoveTop = BrowserWindow.prototype.moveTop;
  const _origRestore = BrowserWindow.prototype.restore;
  const _origCenter = BrowserWindow.prototype.center;
  const _origSetVisibleOnAllWorkspaces = BrowserWindow.prototype.setVisibleOnAllWorkspaces;
  BrowserWindow.prototype.focus = makeHeadlessNoOp('focus', _origFocus as never) as typeof BrowserWindow.prototype.focus;
  BrowserWindow.prototype.moveTop = makeHeadlessNoOp('moveTop', _origMoveTop as never) as typeof BrowserWindow.prototype.moveTop;
  BrowserWindow.prototype.restore = makeHeadlessNoOp('restore', _origRestore as never) as typeof BrowserWindow.prototype.restore;
  BrowserWindow.prototype.center = makeHeadlessNoOp('center', _origCenter as never) as typeof BrowserWindow.prototype.center;
  BrowserWindow.prototype.setVisibleOnAllWorkspaces = makeHeadlessNoOp('setVisibleOnAllWorkspaces', _origSetVisibleOnAllWorkspaces as never) as typeof BrowserWindow.prototype.setVisibleOnAllWorkspaces;

  app.on('before-quit', () => {
    console.log('[headless-noop] final counts:', JSON.stringify(_headlessNoOpCounts));
  });

  console.log('[headless-guard] BrowserWindow focus/moveTop/restore/center/setVisibleOnAllWorkspaces no-op guard active');

  // ── headless opacity-restore guard ──────────────────────────────────────
  // Catches any code path that restores opacity from 0 to a nonzero value
  // on a hidden window during headless test runs, which would cause a visible
  // flash. The show/showInactive guard above already blocks shows on opacity!=0
  // windows; this guard is the complementary protection for the restore path.
  const _origSetOpacity = BrowserWindow.prototype.setOpacity;
  BrowserWindow.prototype.setOpacity = function(this: BrowserWindow, opacity: number) {
    if (!this.isDestroyed()) {
      const prev = this.getOpacity();
      if (prev === 0 && opacity !== 0) {
        let url = '(no-url)';
        try { url = this.webContents?.getURL?.() ?? '(no-url)'; } catch { /* */ }
        const msg = `[headless-violation] setOpacity id=${this.id} from=0 to=${opacity} url=${url} — restoring opacity on hidden window causes flash`;
        console.error(msg);
        console.error(new Error(msg).stack);
        process.exitCode = 1;
        throw new Error(msg);
      }
    }
    return _origSetOpacity.call(this, opacity);
  };

  console.log('[headless-guard] setOpacity 0→nonzero guard active');

  // ── globalShortcut neutralization (single chokepoint) ───────────────────
  // globalShortcut.register grabs a SYSTEM-WIDE hotkey on the user's real
  // machine — the packaged build has a live globalShortcut. Both the ESC
  // fallback (main.ts updateEscGlobalRegistration) and feature hotkeys
  // (shortcuts.ts, e.g. Option+Space) call it. No-op every registration here so
  // NO call site can grab the user's keys during a headless run. This is the
  // one place that needs to know about headless — call sites don't each carry
  // an isHeadless() guard.
  globalShortcut.register = (() => true) as typeof globalShortcut.register;
  globalShortcut.registerAll = (() => {}) as typeof globalShortcut.registerAll;
  console.log('[headless-guard] globalShortcut.register/registerAll neutralized');

  // ── per-webContents UI-surface neutralization ───────────────────────────
  // openDevTools and the native beforeunload "Leave site?" modal both surface
  // OS-level UI that steals focus, and neither is a BrowserWindow method, so the
  // prototype guards above can't see them. Neutralize them once at the
  // web-contents-created chokepoint, which fires for EVERY webContents (windows
  // + webview guests) regardless of which code path created it.
  app.on('web-contents-created', (_e, contents) => {
    // DevTools: nothing should pop a detached inspector onto the user's real
    // desktop during a headless run. No-op + flag drift (exitCode) so a future
    // unguarded openDevTools call site fails CI, without throwing (a throw from
    // a patched method would break the caller).
    contents.openDevTools = (() => {
      console.error('[headless-violation] openDevTools() suppressed in headless', new Error().stack);
      process.exitCode = 1;
    }) as typeof contents.openDevTools;

    // beforeunload: real external pages loaded by some specs register a
    // beforeunload handler; when the fixture's app.quit() closes the window
    // Electron would surface a native "Leave site?" modal — a focus-stealing
    // blocking dialog (this is the "window.confirm"-like prompt). preventDefault
    // auto-accepts the unload with no prompt.
    contents.on('will-prevent-unload', (event) => {
      event.preventDefault();
    });

    // window.confirm/alert/prompt: Peek's OWN renderers (settings, lists,
    // groups, tags, scripts, entities, …) call native confirm()/alert() on
    // delete/remove/clear actions. Each one flashes a focus-stealing native
    // modal on the user's real macOS desktop (and several blocking modals across
    // parallel workers read as a freeze). Override them in the page's MAIN world
    // (executeJavaScript runs there) to resolve without any native UI —
    // confirm()→true so flows that gate on it (e.g. settings "Clear all") still
    // proceed. Re-inject on every dom-ready so it survives navigations. This is
    // the single chokepoint; the ~30 call sites don't each need a guard.
    contents.on('dom-ready', () => {
      contents.executeJavaScript(
        'window.confirm=function(){return true};window.alert=function(){};window.prompt=function(){return null};',
      ).catch(() => { /* devtools / restricted webContents reject eval — ignore */ });
    });
  });
  console.log('[headless-guard] per-webContents openDevTools + beforeunload + JS-dialog neutralization active');
}

// Start the app
app.whenReady().then(onReady);
