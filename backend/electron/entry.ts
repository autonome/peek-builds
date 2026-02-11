/**
 * Electron Backend Entry Point
 *
 * This is the main entry point for the Electron application.
 * All Electron-specific code lives here.
 */

import { app, globalShortcut, ipcMain } from 'electron';
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
  registerExternalUrlHandlers,
  registerSecondInstanceHandler,
  handleCliUrl,
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
  // Database
  getDb,
  // Config
  WEB_CORE_ADDRESS,
  SETTINGS_ADDRESS,
  setPreloadPath,
  setProfile,
  isTestProfile,
  isHeadless,
  // Window helpers
  setPrefsGetter,
  updateDockVisibility,
  // Extension loading
  loadExtensionManifest,
} from './index.js';

import { startHotReload, stopHotReload } from './hotreload.js';
import { checkAndRunDailyBackup } from './backup.js';
import {
  applyAdblockerConfig,
  cleanupAdblocker,
} from './adblocker.js';
import {
  initChromeExtensionManager,
  loadEnabledChromeExtensions,
  getChromeExtensionUiEntries,
  openChromeExtensionPage,
  cleanupChromeExtensions,
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
import { saveSessionSnapshot, restoreSessionSnapshot, markSessionDirty } from './session.js';

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
(globalThis as any).__peek_test = { handleLocalShortcut };
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

// script loaded into every app window
const preloadPath = path.join(ROOT_DIR, 'preload.js');

const systemAddress = getSystemAddress();

// Initialize backend config with runtime values
setPreloadPath(preloadPath);

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
  try { saveSessionSnapshot('before-quit'); } catch (e) { DEBUG && console.error('[lifecycle] saveSessionSnapshot error:', e); }
  try { cleanupDevExtensions(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupDevExtensions error:', e); }
  try { cleanupAdblocker(); } catch (e) { DEBUG && console.error('[lifecycle] cleanupAdblocker error:', e); }
  try { stopHotReload(); } catch (e) { DEBUG && console.error('[lifecycle] stopHotReload error:', e); }
  try { shutdown(); } catch (e) { DEBUG && console.error('[lifecycle] shutdown error:', e); }
  DEBUG && console.log('[lifecycle] before-quit: cleanup complete');
});

/**
 * Register command palette entries for chrome extension UI pages.
 * Called after chrome extensions are loaded so we know which ones
 * have options pages or popups.
 *
 * For each UI entry point, registers a command and subscribes to
 * its execution topic so the main process can open the window.
 */
function registerChromeExtensionCommands(): void {
  const entries = getChromeExtensionUiEntries();
  if (entries.length === 0) return;

  const systemAddress = getSystemAddress();

  for (const entry of entries) {
    const commandName = entry.type === 'options'
      ? `${entry.extensionName} Settings`
      : entry.extensionName;

    // Subscribe to execution topic so we can handle it from the main process
    const execTopic = `cmd:execute:${commandName}`;
    subscribe(systemAddress, scopes.GLOBAL, execTopic, () => {
      DEBUG && console.log(`[chrome-ext] Executing command: ${commandName}`);
      openChromeExtensionPage(entry.extensionId, entry.type);
    });

    // Register the command with the cmd extension
    publish(systemAddress, scopes.GLOBAL, 'cmd:register', {
      name: commandName,
      description: entry.type === 'options'
        ? `Open ${entry.extensionName} settings`
        : `Open ${entry.extensionName} popup`,
      source: systemAddress,
      scope: 'global',
    });
  }

  DEBUG && console.log(`[chrome-ext] Registered ${entries.length} command(s) for chrome extension UI pages`);
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

  // Mark session as dirty for crash detection (before restore)
  markSessionDirty();

  // Check if session restore has a valid snapshot waiting.
  // This flag tells the core app to skip the startup feature (settings window)
  // when there are windows to restore.
  let _sessionRestorePending = false;
  try {
    const db = getDb();
    const snapshotRow = db.prepare(
      `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'snapshot'`
    ).get() as { value: string } | undefined;
    if (snapshotRow?.value) {
      const snapshot = JSON.parse(snapshotRow.value);
      if (snapshot.version === 1 && snapshot.windows && snapshot.windows.length > 0) {
        // Also check metadata for crash detection
        let skipDueToCrash = false;
        const metaRow = db.prepare(
          `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'metadata'`
        ).get() as { value: string } | undefined;
        if (metaRow?.value) {
          const meta = JSON.parse(metaRow.value);
          if (meta.cleanShutdown === false && (meta.crashCount ?? 0) > 3) {
            skipDueToCrash = true;
          }
        }
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

  // Ensure single instance
  if (!requestSingleInstance()) {
    return;
  }

  // Windows/Linux: handle URLs when another instance tries to open
  registerSecondInstanceHandler();

  // Discover and register built-in extensions from extensions/ folder
  discoverBuiltinExtensions(path.join(ROOT_DIR, 'extensions'));

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

  // Discover and register built-in themes from themes/ folder
  discoverBuiltinThemes(path.join(ROOT_DIR, 'themes'));

  // Initialize bundled web extensions infrastructure
  const chromeExtensionsDir = path.join(ROOT_DIR, 'resources', 'chrome-extensions');
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

    // Update dock visibility based on pref and visible windows
    updateDockVisibility();

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
          const restoreResult = await restoreSessionSnapshot(prefsMsg.prefs);
          DEBUG && console.log(`[session] Restore result:`, restoreResult);
          if (restoreResult.restored === 0) {
            // If nothing was actually restored, clear the pending flag
            // so future startup feature checks don't think restore happened
            _sessionRestorePending = false;
          }
        } catch (err) {
          console.error('[session] Session restore failed:', err);
          _sessionRestorePending = false;
        }
      }
    }
  });

  // Create the core background window
  createBackgroundWindow();

  // Start hot reload in dev mode
  if (DEBUG) {
    startHotReload(ROOT_DIR);
  }

  // Register default quit shortcut (local - only works when app has focus)
  // Will be updated when prefs arrive
  _quitShortcut = strings.defaults.quitShortcut;
  registerLocalShortcut(_quitShortcut, 'system', onQuit);

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
      "SELECT value FROM extension_settings WHERE extensionId = 'core' AND key = 'darkMode'"
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
  preloadPath: preloadPath,
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
