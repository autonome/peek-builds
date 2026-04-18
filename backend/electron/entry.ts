/**
 * Electron Backend Entry Point
 *
 * This is the main entry point for the Electron application.
 * All Electron-specific code lives here.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import unhandled from 'electron-unhandled';

// Import from local backend modules
import {
  // Main process orchestration
  configure,
  initialize,
  discoverBuiltinExtensions,
  discoverBuiltinThemes,
  loadExtensions,
  // Dev extension support
  registerDevExtension,
  loadDevExtensions,
  cleanupDevExtensions,
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
  scopes,
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
  // Extension loading
  loadExtensionManifest,
  // Closed window stack persistence
  loadClosedWindowStack,
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
} from './chrome-extensions.js';
import {
  initProfilesDb,
  migrateExistingProfiles,
  ensureDefaultProfile,
  getActiveProfile,
} from './profiles.js';
import {
  initSessionPartition,
} from './session-partition.js';
import { saveSessionSnapshot, restoreSessionSnapshot, readSessionCrashState, markSessionDirty, startAutosaveTimer, stopAutosaveTimer, updateAutosaveInterval } from './session.js';
import { initDisplayWatcher, cleanupDisplayWatcher } from './display-watcher.js';
import { getTileWebPreferencesForWebviewUrl } from './tile-launcher.js';
import { getLazyTileManifest } from './tile-lazy.js';
import { getTilePreloadPath } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';

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

const DEBUG = !!process.env.DEBUG;

// Expose test utilities on global for Playwright evaluateMain access
(globalThis as any).__peek_test = { handleLocalShortcut, handleExternalUrl };
(globalThis as any).__peek_electron = { globalShortcut };

// Parse --load-extension CLI arguments for dev workflow
// Usage: yarn start -- --load-extension=/path/to/extension
// Multiple extensions: yarn start -- --load-extension=/path1 --load-extension=/path2
const devExtensionPaths: string[] = [];
for (const arg of process.argv) {
  if (arg.startsWith('--load-extension=')) {
    const extPath = arg.slice('--load-extension='.length);
    // Expand ~ to home directory
    const expandedPath = extPath.startsWith('~')
      ? path.join(app.getPath('home'), extPath.slice(1))
      : extPath;
    // Resolve to absolute path
    const absolutePath = path.resolve(expandedPath);
    devExtensionPaths.push(absolutePath);
    DEBUG && console.log(`[cli] Dev extension path: ${absolutePath}`);
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
// Resolution order (Phase 3.11b-hud — v1 preload.js removed):
//   1. HUD widget webviews: peek://ext/hud/widgets/*.html get a dedicated
//      trustedBuiltin token (hud-widget). HUD has no v2 manifest but
//      widgets use api.window/context/izui/pubsub — all covered by
//      trustedBuiltin grant.
//   2. v2 tiles: URL resolves to a registered v2 tile manifest — use
//      tile-preload.cjs with manifest-derived capability token.
//   3. Unrecognised peek:// URL: log a warning and skip preload injection
//      (no v1 fallback — preload.js has been deleted).
//
// Also inject Proton Pass webauthn.js into http/https webviews for passkey support.
// The script overrides navigator.credentials.create/get in the main world.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (_wvEvent, webPreferences, params) => {
    if (params.src && params.src.startsWith('peek://')) {
      const tilePreloadPath = getTilePreloadPath();
      if (!tilePreloadPath) return;

      // Special-case: HUD widget webviews (peek://ext/hud/widgets/*.html).
      // HUD has no v2 manifest; mint a trustedBuiltin token for all widgets
      // under a unified hud-widget tile id so they can use api.window.*,
      // api.context.*, api.izui.*, api.pubsub.*, etc.
      if (params.src.startsWith('peek://ext/hud/widgets/')) {
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
          `[webview] Injecting v2 tile-preload for ${params.src} (tile=${tileWebPrefs.tileId}, entry=${tileWebPrefs.entryId})`
        );
      } else {
        // No v1 preload fallback — preload.js has been deleted. Any peek://
        // URL that reaches here is either a developer-extension webview that
        // needs a v2 manifest, or a bug. Log a warning so it surfaces.
        console.warn(`[webview] No tile-preload found for peek:// webview ${params.src} — no preload injected (v1 preload.js removed)`);
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

// Acquire single instance lock EARLY (before app.whenReady).
// This is critical on macOS: when a second instance is launched via
// `open -a Peek URL`, Electron needs the lock to be held BEFORE the
// second instance reaches app.whenReady. Otherwise, the second instance
// processes the Apple Event (open-url) locally and then quits, losing
// the URL. With early lock acquisition, Electron forwards the open-url
// event to the first (primary) instance.
if (!requestSingleInstance()) {
  // Another instance is already running. On macOS, Electron forwards
  // the Apple Event to the primary instance. On Windows/Linux, the
  // second-instance event fires with argv. Either way, quit this instance.
  // Note: app.quit() was already called inside requestSingleInstance().
  // app.exit() terminates immediately (sync), preventing further init.
  app.exit(0);
  // TypeScript doesn't know app.exit() is noreturn, but it is.
}

// Windows/Linux: handle URLs when another instance tries to open.
// Must be registered early (before app.whenReady) so the handler is
// ready when the second-instance event fires.
registerSecondInstanceHandler();

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

// configure Electron with these paths
app.setPath('userData', profileDataPath);
app.setPath('sessionData', sessionDataPath);

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
  // Clean up dev extensions before quitting
  cleanupDevExtensions();
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
  try { cleanupDevExtensions(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupDevExtensions error:', e); }
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
    subscribe(systemAddress, scopes.GLOBAL, execTopic, () => {
      DEBUG && console.log(`[chrome-ext] Executing command: ${cmd.commandName}`);
      openChromeExtensionPage(cmd.extensionId, 'options');
      publish(systemAddress, scopes.GLOBAL, `${execTopic}:result`, { success: true });
    });

    // Register the command with the cmd registry.
    publish(systemAddress, scopes.GLOBAL, 'cmd:register', {
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

  // Run daily backup check (non-blocking)
  checkAndRunDailyBackup().catch(err => {
    console.error('[startup] Backup check failed:', err);
  });

  // Store startup time for reporting
  (global as Record<string, unknown>).__startupStart = startupStart;

  // Note: requestSingleInstance() and registerSecondInstanceHandler()
  // are called early (before app.whenReady) for proper URL forwarding.
  // See the block after setProfile(PROFILE) above.

  // Discover and register built-in extensions from features/ folder
  discoverBuiltinExtensions(path.join(ROOT_DIR, 'features'));

  // Register dev extensions from CLI arguments
  // These are transient (not persisted) and load with devtools open
  for (const extPath of devExtensionPaths) {
    try {
      const manifest = loadExtensionManifest(extPath);
      if (manifest && manifest.id) {
        registerDevExtension(manifest.id, extPath);
      } else {
        console.error(`[cli] Invalid extension at ${extPath}: missing id in manifest`);
      }
    } catch (err) {
      console.error(`[cli] Failed to load extension manifest at ${extPath}:`, err);
    }
  }

  // Discover and register built-in themes from features/ (type: "theme") with legacy themes/ fallback
  discoverBuiltinThemes(path.join(ROOT_DIR, 'features'), path.join(ROOT_DIR, 'themes'));

  // Initialize bundled web extensions infrastructure
  const chromeExtensionsDir = path.join(ROOT_DIR, 'chrome-extensions');
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

  // Track if extensions have been loaded (only load once)
  let extensionsLoaded = false;

  // listen for app prefs to configure ourself
  // TODO: kinda janky, needs rethink
  subscribe(systemAddress, scopes.SYSTEM, strings.topics.prefs, async (msg: unknown) => {
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
          publish(WEB_CORE_ADDRESS, scopes.GLOBAL, 'open', {
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

    // Load extensions after core app is ready (only once)
    if (!extensionsLoaded) {
      extensionsLoaded = true;
      const extStart = Date.now();
      await loadExtensions();

      // Load dev extensions after normal extensions (always with devtools)
      if (devExtensionPaths.length > 0) {
        const devCount = await loadDevExtensions();
        DEBUG && console.log(`[ext:dev] Loaded ${devCount} dev extension(s)`);
      }

      // Load bundled web extensions (chrome extensions + adblocker)
      // Adblocker: enabled by default, check prefs for override
      const adBlockerEnabled = prefsMsg.prefs.adBlockerEnabled !== false;
      if (adBlockerEnabled) {
        applyAdblockerConfig({ enabled: true }).catch(err => {
          console.error('[startup] Adblocker init failed:', err);
        });
      }

      // Load enabled chrome extensions, then register their UI pages as commands
      loadEnabledChromeExtensions().then(() => {
        registerChromeExtensionCommands();
      }).catch(err => {
        console.error('[startup] Chrome extensions init failed:', err);
      });

      const extTime = Date.now() - extStart;
      const totalTime = Date.now() - ((global as Record<string, unknown>).__startupStart as number);
      DEBUG && console.log(`[startup] main: ${extStart - ((global as Record<string, unknown>).__startupStart as number)}ms, extensions: ${extTime}ms, total: ${totalTime}ms`);

      // Restore session after extensions are loaded
      if (_sessionRestorePending) {
        try {
          const restoreResult = await restoreSessionSnapshot(prefsMsg.prefs, _crashState);
          DEBUG && console.log(`[session] Restore result:`, restoreResult);
          if (restoreResult.restored === 0) {
            _sessionRestorePending = false;
            // Nothing restored (user declined, or snapshot was empty).
            // The startup feature was suppressed, so open it now.
            DEBUG && console.log('[session] No windows restored, opening startup feature');
            publish(systemAddress, scopes.GLOBAL, 'session:open-startup', {});
          }
        } catch (err) {
          console.error('[session] Session restore failed:', err);
          _sessionRestorePending = false;
          publish(systemAddress, scopes.GLOBAL, 'session:open-startup', {});
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

  // Create the core background window (v2 tile mechanics — see
  // backend/electron/core-glue.ts::initCore). Awaited so startup code
  // downstream sees a fully-initialised renderer with all subscribers
  // registered before e.g. CLI URLs get replayed.
  await createBackgroundWindow();

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
