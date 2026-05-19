/**
 * Electron Backend Entry Point
 *
 * This is the main entry point for the Electron application.
 * All Electron-specific code lives here.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
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
  // PubSub
  publish,
  subscribe,
  getSystemAddress,
  // IPC
  registerAllHandlers,
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
  closeOrHideWindow,
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
  isChromeExtensionLoaded,
  getChromeExtensionOptionsCommands,
  findExtensionByExternallyConnectableUrl,
} from './chrome-extensions.js';
import {
  getPreloadPath as getRuntimeExternalPreloadPath,
  getPagePolyfillSource as getRuntimeExternalPagePolyfillSource,
} from './chrome-api-polyfills/runtime-external.js';
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
import { saveSessionSnapshot, restoreSessionSnapshot, readSessionCrashState, markSessionDirty, startAutosaveTimer, stopAutosaveTimer, updateAutosaveInterval, getRestoreFocusCounters } from './session.js';
import { getIzuiCoordinator } from './izui-state.js';
import { initDisplayWatcher, cleanupDisplayWatcher } from './display-watcher.js';
import { getTileWebPreferencesForWebviewUrl } from './tile-launcher.js';
import { getLazyTileManifest } from './tile-lazy.js';
import { getTilePreloadPath } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { startCliSocketServer, stopCliSocketServer, isCliSocketRunning } from './cli-socket.js';
import { ensureCliHelperShadow } from './cli-helper.js';
import { ensureLinuxDesktopInstall } from './desktop-installer.js';
import { initRendererLog } from './renderer-log.js';
import { initMainLog } from './main-log.js';
import { DEBUG } from './config.js';

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
    win.showInactive();
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
    if (!win) return false;
    win.emit('focus');
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

// Read Proton Pass webauthn.js for main-world injection into web content webviews.
// Electron ignores "world": "MAIN" in Chrome extension manifest content_scripts,
// so we inject the script ourselves via executeJavaScript() which runs in the main world.
let webauthnScript: string | null = null;
const webauthnScriptPath = path.join(ROOT_DIR, 'chrome-extensions', 'proton-pass', 'webauthn.js');
try {
  if (fs.existsSync(webauthnScriptPath)) {
    webauthnScript = fs.readFileSync(webauthnScriptPath, 'utf-8');
    DEBUG && console.log('[webauthn] Loaded Proton Pass webauthn.js for injection');
  }
} catch (err) {
  console.error('[webauthn] Failed to read webauthn.js:', err);
}

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
// Also inject Proton Pass webauthn.js into http/https webviews for passkey support.
// The script overrides navigator.credentials.create/get in the main world.
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

  // Default-deny window-open chokepoint. Every top-level webContents and
  // every webview guest gets this fallback handler installed at creation
  // time. Per-window code (ipc.ts:openPopupInPageHost wiring, chrome-
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
      const matchedExtId = findExtensionByExternallyConnectableUrl(params.src);
      if (matchedExtId && process.env.PEEK_DISABLE_RUNTIME_EXTERNAL_POLYFILL !== '1') {
        webPreferences.preload = getRuntimeExternalPreloadPath();
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          `--peek-runtime-external-ext-id=${matchedExtId}`,
        ];
        // Disable sandbox for these webviews. Electron 40's sandbox-bundle
        // init crashes on subsequent navigations within Proton's auth flow
        // (/authorize → /reauth → /auth-ext), with
        // "TypeError: object null is not iterable" inside
        // ___electron_webpack_init__. The renderer process gets stuck in a
        // broken state and our preload's dom-ready listener never fires, so
        // chrome.runtime.sendMessage is never polyfilled on the auth-ext
        // page that needs it. Disabling sandbox for these specific origins
        // (auth pages of a loaded extension's externally_connectable
        // matches) sidesteps the bootstrap bug.
        webPreferences.sandbox = false;
        webPreferences.contextIsolation = true;
        console.log(`[peek:runtime-external:webview] Injecting runtime-external preload for ${params.src} (ext=${matchedExtId}, sandbox=false)`);
        return;
      } else if (DEBUG && (params.src.includes('proton.me') || params.src.includes('proton.dev'))) {
        // Diagnostic: a Proton URL that DIDN'T match any loaded extension's
        // externally_connectable.matches. Most likely cause is that the
        // extension hasn't finished loading yet at attach time, or the
        // match-pattern conversion is wrong. Surface both possibilities.
        console.log(`[peek:runtime-external:webview] No extension matched ${params.src} — extension probably not loaded yet, or pattern mismatch`);
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

  // Inject webauthn.js into web content webviews for Proton Pass passkey support.
  // Uses executeJavaScript() which runs in the main world, allowing the script to
  // override navigator.credentials.create() and navigator.credentials.get().
  // Falls back to native WebAuthn if Proton Pass orchestrator isn't connected.
  if (contents.getType() === 'webview') {
    contents.on('dom-ready', () => {
      if (!webauthnScript || !isChromeExtensionLoaded('proton-pass')) return;

      const url = contents.getURL();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        contents.executeJavaScript(webauthnScript).catch(() => {
          // Ignore injection errors (webContents may be destroyed)
        });
        DEBUG && console.log(`[webauthn] Injected Proton Pass webauthn.js into: ${url}`);
      }
    });

    // Install the chrome.runtime.sendMessage page polyfill via CDP
    // `Page.addScriptToEvaluateOnNewDocument`. CDP guarantees main-world
    // execution BEFORE any page script on every navigation, with no IPC
    // round-trip.
    //
    // Why this matters: the previous path was `did-navigate` →
    // `executeJavaScript`, which is async via IPC. On Proton's /auth-ext
    // (a SPA route mount on the same React bundle as /pass), the component
    // mounts essentially synchronously after the URL changes — fast enough
    // that the IPC round-trip lost the race. The harness trace at
    // tmp/harness/proton-auth-2026-04-30T13-06-32-780Z.log shows the
    // polyfill installing 146ms post-nav, which is the same instant
    // Proton fetches its error.svg — i.e., Proton's bundle had already read
    // Electron's broken native chrome.runtime, decided extension delivery
    // failed, and rendered the error UI before the polyfill landed.
    //
    // CDP `addScriptToEvaluateOnNewDocument` registers the script once and
    // it runs on every subsequent document creation (full navs and history
    // navs that produce a new document) before any page <script>. The very
    // first document is still handled by the preload's webFrame.executeJavaScript
    // path (runtime-external-preload.cjs), since CDP can't be registered
    // before webContents creation. Together they cover both paths.
    let _polyfillScriptRegistered = false;
    const tryRegisterCDPPolyfill = async (url: string) => {
      if (_polyfillScriptRegistered) return;
      if (process.env.PEEK_DISABLE_RUNTIME_EXTERNAL_POLYFILL === '1') return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;
      const matchedExtId = findExtensionByExternallyConnectableUrl(url);
      if (!matchedExtId) return;
      try {
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach('1.3');
        }
        await contents.debugger.sendCommand('Page.enable');
        await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: getRuntimeExternalPagePolyfillSource(matchedExtId),
        });
        _polyfillScriptRegistered = true;
        DEBUG && console.log(`[peek:runtime-external] CDP addScriptToEvaluateOnNewDocument registered (ext=${matchedExtId})`);
      } catch (err) {
        console.error('[peek:runtime-external] CDP install failed:', (err as Error)?.message ?? err);
      }
    };
    contents.on('did-navigate', (_e, url) => { void tryRegisterCDPPolyfill(url); });

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
      contents.on('did-finish-load', () => {
        const url = contents.getURL();
        if (url.includes('proton.me') || url.includes('proton.dev')) {
          if (!contents.isDevToolsOpened()) {
            try { contents.openDevTools({ mode: 'detach', activate: false }); }
            catch { /* devtools open is best-effort */ }
          }
        }
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
  try { stopAutosaveTimer(); } catch (e) { DEBUG && console.error('[lifecycle] stopAutosaveTimer error:', e); }
  try { cleanupDisplayWatcher(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupDisplayWatcher error:', e); }
  try { saveSessionSnapshot('before-quit'); } catch (e) { DEBUG && console.error('[lifecycle] saveSessionSnapshot error:', e); }
  try { cleanupDevTiles(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupDevTiles error:', e); }
  try { cleanupAdblocker(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupAdblocker error:', e); }
  try { stopHotReload(); } catch (e) { DEBUG && console.error('[lifecycle] stopHotReload error:', e); }
  try { cleanupThumbnails(getActiveThumbnailHashes); } catch (e) { DEBUG && console.error('[lifecycle] cleanupThumbnails error:', e); }
  try { shutdown(); } catch (e) { DEBUG && console.error('[lifecycle] shutdown error:', e); }
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
  if (process.platform === 'darwin') {
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
              if (win) closeOrHideWindow(win.id);
          }},
          { role: 'minimize' },
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    // On non-macOS platforms, remove the menu entirely so it doesn't
    // consume any shortcut accelerators
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
  discoverBuiltinFeatures(path.join(ROOT_DIR, 'features'));

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
  discoverBuiltinThemes(path.join(ROOT_DIR, 'features'), path.join(ROOT_DIR, 'themes'));

  // Initialize bundled web extensions infrastructure.
  // electron-builder.yml lists chrome-extensions/** in asarUnpack so the
  // files land on a real filesystem (Chromium's session.loadExtension
  // doesn't go through Electron's transparent asar fs patching — it
  // needs a literal disk path). In packaged builds the unpacked tree
  // lives at ${resourcesPath}/app.asar.unpacked/. ROOT_DIR
  // (= app.getAppPath()) points inside app.asar itself, so we'd need
  // to swap it out otherwise.
  const chromeExtensionsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'chrome-extensions')
    : path.join(ROOT_DIR, 'chrome-extensions');
  initChromeExtensionManager(chromeExtensionsDir);

  // Restore saved theme preference (must be after themes are discovered)
  restoreSavedTheme();

  // Register as default handler for http/https URLs (if not already and user hasn't declined)
  // Only prompt in production packaged builds - skip for dev, test, and dev-packaged builds
  const isProductionBuild = app.isPackaged && !isDevPackagedBuild();
  if (!isProductionBuild) {
    DEBUG && console.log('Skipping default browser check for non-production build:', PROFILE);
  }

  const defaultBrowserPrefFile = path.join(profileDataPath, 'default-browser-pref.json');
  let shouldPromptForDefault = isProductionBuild && !isTestProfile();

  // Check if user has previously declined
  try {
    if (fs.existsSync(defaultBrowserPrefFile)) {
      const pref = JSON.parse(fs.readFileSync(defaultBrowserPrefFile, 'utf8'));
      if (pref.declined === true) {
        shouldPromptForDefault = false;
        DEBUG && console.log('User previously declined default browser prompt');
      }
    }
  } catch {
    // Ignore errors reading pref file
  }

  // Only try to register if user hasn't declined and we're not already default
  if (shouldPromptForDefault) {
    const isDefaultHttp = app.isDefaultProtocolClient('http');
    const isDefaultHttps = app.isDefaultProtocolClient('https');

    if (!isDefaultHttp || !isDefaultHttps) {
      DEBUG && console.log('Registering as default protocol client for http/https');
      app.setAsDefaultProtocolClient('http');
      app.setAsDefaultProtocolClient('https');

      // Check if registration succeeded - if not, user likely declined
      setTimeout(() => {
        const nowDefaultHttp = app.isDefaultProtocolClient('http');
        const nowDefaultHttps = app.isDefaultProtocolClient('https');
        if (!nowDefaultHttp && !nowDefaultHttps) {
          // User declined, save preference
          DEBUG && console.log('User declined default browser, saving preference');
          try {
            fs.writeFileSync(defaultBrowserPrefFile, JSON.stringify({ declined: true, timestamp: Date.now() }));
          } catch {
            console.error('Failed to save default browser preference');
          }
        }
      }, 2000);
    } else {
      DEBUG && console.log('Already default protocol client for http/https');
    }
  }

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

    // initialize system tray
    if (prefsMsg.prefs.showTrayIcon === true) {
      DEBUG && console.log('showing tray');
      initTray(ROOT_DIR, {
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

      // Load enabled chrome extensions, register their UI pages as commands,
      // then broadcast chrome-extensions:loaded so the Settings → Extensions
      // pane can re-render its per-extension buttons. The broadcast is needed
      // because renderPrivacySettings() runs once at page-open and
      // loadEnabledChromeExtensions() is async — without the signal, a
      // settings window opened before loading completes shows no buttons
      // (this was the root cause of the 2026-04-29 regression).
      loadEnabledChromeExtensions().then(() => {
        registerChromeExtensionCommands();
        publish(systemAddress, 'chrome-extensions:loaded', {});
      }).catch(err => {
        console.error('[startup] Chrome extensions init failed:', err);
      });

      const featTime = Date.now() - featStart;
      const totalTime = Date.now() - ((global as Record<string, unknown>).__startupStart as number);
      DEBUG && console.log(`[startup] main: ${featStart - ((global as Record<string, unknown>).__startupStart as number)}ms, features: ${featTime}ms, total: ${totalTime}ms`);

      // Restore session after features are loaded
      if (_sessionRestorePending) {
        try {
          const restoreResult = await restoreSessionSnapshot(prefsMsg.prefs, _crashState);
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
  // backend/electron/core-glue.ts::initCore). Awaited so startup code
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
  // user's XDG dirs. See backend/electron/desktop-installer.ts.
  await ensureLinuxDesktopInstall();

  // Note: cli-socket startup happens in the prefs subscriber (below)
  // so the cliSocketEnabled toggle is honoured from the first publish.
  // See docs/global-hotkeys-on-wayland.md for the dispatch architecture.

  // Start hot reload in dev mode
  if (DEBUG) {
    startHotReload(ROOT_DIR);
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
      const win = BrowserWindow.getFocusedWindow();
      if (win) closeOrHideWindow(win.id);
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
  rootDir: ROOT_DIR,
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

// Start the app
app.whenReady().then(onReady);
