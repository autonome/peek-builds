/**
 * Electron Main Process Entry Point
 *
 * This module orchestrates the main process startup and provides
 * a unified API for managing the Electron application.
 */

import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { initDatabase, closeDatabase, getDb, trackWindowLoad, updateItemTitle, updateModeForNavigation } from './datastore.js';
import { registerScheme, initProtocol, registerExtensionPath, getExtensionPath, getRegisteredExtensionIds, registerThemePath, getRegisteredThemeIds } from './protocol.js';
import { discoverExtensions, loadExtensionManifest, isBuiltinExtensionEnabled, getExternalExtensions } from './extensions.js';
import { initTray } from './tray.js';
import { registerLocalShortcut, unregisterLocalShortcut, handleLocalShortcut, registerGlobalShortcut, unregisterGlobalShortcut, unregisterShortcutsForAddress } from './shortcuts.js';
import { scopes, publish, subscribe, setExtensionBroadcaster, getSystemAddress } from './pubsub.js';
import { APP_DEF_WIDTH, APP_DEF_HEIGHT, WEB_CORE_ADDRESS, getPreloadPath, isTestProfile, isDevProfile, isHeadless, getProfile, DEBUG } from './config.js';
import { trackWindow } from './display-watcher.js';
import { addEscHandler, winDevtoolsConfig, closeOrHideWindow, getSystemThemeBackgroundColor, getPrefs } from './windows.js';
import { getProfileSession, getPartitionString, getCurrentProfileId } from './session-partition.js';
import { getIzuiCoordinator } from './izui-state.js';

// Configuration
export interface AppConfig {
  rootDir: string;
  preloadPath: string;
  userDataPath: string;
  profile: string;
  isDev: boolean;
  isTest: boolean;
  darkMode?: string; // 'off' | 'system' | 'force'
}

// App state
let config: AppConfig;
let mainWindow: BrowserWindow | null = null;

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

// Extension windows: extId -> { win, manifest, status }
const extensionWindows = new Map<string, {
  win: BrowserWindow;
  manifest: unknown;
  status: 'loading' | 'running' | 'crashed';
}>();

// Extension host window for built-in extensions (consolidated mode)
let extensionHostWindow: BrowserWindow | null = null;

// Built-in extensions that load in consolidated mode (iframes)
// External extensions (including 'example') load in separate windows
const CONSOLIDATED_EXTENSION_IDS = ['cmd', 'editor', 'groups', 'hud', 'localsearch', 'peeks', 'slides', 'websearch', 'windows'];

// Dev extensions loaded via --load-extension CLI flag
// These are transient (not persisted) and always have devtools open
const devExtensions = new Map<string, { path: string }>();

// Window manager: windowId -> { source, params }
const windowRegistry = new Map<number, {
  source: string;
  params: Record<string, unknown>;
}>();

/**
 * Initialize the application configuration
 * Must be called before app.ready
 */
export function configure(cfg: AppConfig): void {
  config = cfg;

  // Tier 1 dark mode: 'force' = always dark, 'off'/'system' = respect OS preference
  const darkMode = cfg.darkMode || 'system';
  nativeTheme.themeSource = (darkMode === 'force') ? 'dark' : 'system';

  // Register custom protocol scheme (must be before app.ready)
  registerScheme();
}

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

  // Initialize database
  const dbPath = path.join(config.userDataPath, config.profile, 'datastore.sqlite');
  initDatabase(dbPath);

  // Set up extension broadcaster for pubsub
  // Hybrid mode: broadcast to BOTH consolidated (iframes) AND separate windows
  // All send() calls are wrapped in try-catch to prevent errors during shutdown
  // when windows are being destroyed concurrently (race between isDestroyed check and send).
  setExtensionBroadcaster((topic, msg, source) => {
    const sourceOrigin = source.startsWith('peek://') ? new URL(source).origin : source;

    // Broadcast to consolidated extension iframes (built-in extensions)
    if (extensionHostWindow && !extensionHostWindow.isDestroyed()) {
      try {
        const mainFrame = extensionHostWindow.webContents.mainFrame;
        for (const frame of mainFrame.framesInSubtree) {
          if (frame !== mainFrame && frame.url) {
            const frameOrigin = new URL(frame.url).origin;
            // Don't echo back to sender
            if (frameOrigin !== sourceOrigin) {
              frame.send(`pubsub:${topic}`, {
                ...(msg as object),
                source
              });
            }
          }
        }
      } catch {
        // Window may have been destroyed between check and send (during shutdown)
      }
    }

    // Broadcast to separate extension windows (external extensions)
    for (const [extId, entry] of extensionWindows) {
      if (entry.win && !entry.win.isDestroyed() && entry.status === 'running') {
        try {
          entry.win.webContents.send(`pubsub:${topic}`, {
            ...(msg as object),
            source
          });
        } catch {
          // Window may have been destroyed between check and send (during shutdown)
        }
      }
    }
  });

  // Track OS-level app focus for IZUI transient detection.
  // When Peek is the active app, windows opened are "active."
  // When Peek is in the background, windows opened are "transient."
  if (process.platform === 'darwin') {
    // macOS: use did-become-active / did-resign-active for reliable OS-level focus.
    // browser-window-blur/focus are per-window and unreliable with utility windows
    // (e.g. HUD with alwaysOnTop+focusable:false confuses getFocusedWindow()).
    (app as any).on('did-become-active', () => {
      getIzuiCoordinator().setAppFocused(true);
      publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: true });
    });
    (app as any).on('did-resign-active', () => {
      getIzuiCoordinator().setAppFocused(false);
      publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: false });
    });
  } else {
    // Non-macOS fallback: use browser-window-focus/blur with focused-window check
    app.on('browser-window-focus', () => {
      getIzuiCoordinator().setAppFocused(true);
      publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: true });
    });
    app.on('browser-window-blur', () => {
      // Only mark unfocused if NO window has focus (user switched to another app).
      // During window switches within Peek, one window blurs before another focuses.
      if (!BrowserWindow.getFocusedWindow()) {
        getIzuiCoordinator().setAppFocused(false);
        publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: false });
      }
    });
  }

  // Track window events globally
  app.on('browser-window-created', (_, window) => {
    const windowId = window.id;

    // Handle window close
    // Wrapped in try-catch to prevent errors during shutdown from stalling the quit sequence.
    // During app.quit(), windows close concurrently and some may already be destroyed.
    window.on('closed', () => {
      try {
        const windowData = windowRegistry.get(windowId);

        // Clean up IZUI coordinator state
        const coordinator = getIzuiCoordinator();
        coordinator.clearFocusedWindow(windowId);
        coordinator.popWindow(windowId);

        // Focus parent window if this was a child
        if (windowData && windowData.params.parentWindowId) {
          const parentId = windowData.params.parentWindowId as number;
          const parentWin = BrowserWindow.fromId(parentId);
          if (parentWin && !parentWin.isDestroyed()) {
            DEBUG && console.log('[izui] Child window closed, focusing parent:', parentId);
            parentWin.focus();
          }
        }

        if (windowData) {
          // If this was an overlay window, restore the windows that were hidden
          // BUT: In transient mode, don't restore - just close and return to previous app
          // Use the window's own transient param (not coordinator - session may be ended by popWindow)
          const hiddenWindowIds = windowData.params.overlayHiddenWindows as number[] | undefined;
          const isTransient = windowData.params.transient === true;
          if (hiddenWindowIds && hiddenWindowIds.length > 0 && !isTransient) {
            DEBUG && console.log('[izui] Overlay closed (active mode), restoring', hiddenWindowIds.length, 'windows');
            for (const hiddenId of hiddenWindowIds) {
              const hiddenWin = BrowserWindow.fromId(hiddenId);
              if (hiddenWin && !hiddenWin.isDestroyed()) {
                hiddenWin.show();
              }
            }
          } else if (isTransient && hiddenWindowIds && hiddenWindowIds.length > 0) {
            DEBUG && console.log('[izui] Overlay closed in transient mode - not restoring', hiddenWindowIds.length, 'windows');
          }

          publish(windowData.source, scopes.GLOBAL, 'window:closed', {
            id: windowId,
            source: windowData.source
          });
        }

        windowRegistry.delete(windowId);
      } catch (err) {
        // During shutdown, errors here must not prevent the quit sequence
        DEBUG && console.error('[lifecycle] Error in window closed handler:', err);
        windowRegistry.delete(windowId);
      }
    });

    // Handle local shortcuts (with window ID for mode-conditional shortcuts)
    window.webContents.on('before-input-event', (event, input) => {
      if (handleLocalShortcut(input, windowId)) {
        event.preventDefault();
      }
    });
  });
}

/**
 * Discover and register built-in extensions
 */
export function discoverBuiltinExtensions(extensionsDir: string): void {
  const discovered = discoverExtensions(extensionsDir);
  for (const ext of discovered) {
    registerExtensionPath(ext.id, ext.path);
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
 * Create an extension window
 */
export async function createExtensionWindow(extId: string): Promise<BrowserWindow | null> {
  if (extensionWindows.has(extId)) {
    DEBUG && console.log(`[ext:win] Extension ${extId} already has a window`);
    return extensionWindows.get(extId)!.win;
  }

  const extPath = getExtensionPath(extId);
  if (!extPath) {
    console.error(`[ext:win] Extension path not found: ${extId}`);
    return null;
  }

  const manifest = loadExtensionManifest(extPath);

  DEBUG && console.log(`[ext:win] Creating window for extension: ${extId}`);

  // Use profile-specific session for isolation
  const profileSession = getProfileSession();

  const win = new BrowserWindow({
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    webPreferences: {
      preload: config.preloadPath,
      session: profileSession,
    }
  });

  // Forward console logs
  win.webContents.on('console-message', (event) => {
    DEBUG && console.log(`[ext:${extId}] ${event.message}`);
  });

  // Track crashes
  win.webContents.on('render-process-gone', (event, details) => {
    console.error(`[ext:win] Extension ${extId} crashed (reason: ${details.reason})`);
    const entry = extensionWindows.get(extId);
    if (entry) {
      entry.status = 'crashed';
    }
  });

  // Track close
  win.on('closed', () => {
    DEBUG && console.log(`[ext:win] Extension ${extId} window closed`);
    extensionWindows.delete(extId);
  });

  extensionWindows.set(extId, { win, manifest, status: 'loading' });

  try {
    await win.loadURL(`peek://ext/${extId}/background.html`);
    DEBUG && console.log(`[ext:win] Extension ${extId} loaded successfully`);
    const entry = extensionWindows.get(extId);
    if (entry) {
      entry.status = 'running';
    }

    // Open devtools for extension in debug mode (not in tests or headless)
    if (config.isDev && !isTestProfile() && !isHeadless()) {
      win.webContents.openDevTools({ mode: 'detach', activate: false });
    }

    return win;
  } catch (error) {
    console.error(`[ext:win] Failed to load extension ${extId}:`, error);
    extensionWindows.delete(extId);
    win.destroy();
    return null;
  }
}

/**
 * Load all enabled extensions with startup phases for optimization
 *
 * Startup phases allow extensions to defer work:
 * - 'early': cmd loads first (it's the command registry)
 * - 'commands': other extensions load, should register commands
 * - 'ui': extensions can initialize UI elements
 * - 'complete': all extensions loaded
 */
export async function loadEnabledExtensions(): Promise<number> {
  const extStart = Date.now();
  const builtinExtIds = getRegisteredExtensionIds();

  // Phase 1: Early - load cmd first (it's the command registry)
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'early' });

  if (builtinExtIds.includes('cmd') && isBuiltinExtensionEnabled('cmd')) {
    const cmdStart = Date.now();
    await createExtensionWindow('cmd');
    DEBUG && console.log(`[ext:timing] cmd: ${Date.now() - cmdStart}ms`);
  }

  // Phase 2: Commands - other extensions should register commands
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });

  // Load remaining built-in extensions in parallel
  const otherBuiltinIds = builtinExtIds.filter(id => id !== 'cmd');
  const enabledBuiltinIds = otherBuiltinIds.filter(id => isBuiltinExtensionEnabled(id));

  const parallelStart = Date.now();
  await Promise.all(enabledBuiltinIds.map(id => createExtensionWindow(id)));
  DEBUG && console.log(`[ext:timing] parallel (${enabledBuiltinIds.join(',')}): ${Date.now() - parallelStart}ms`);

  // Load external extensions in parallel
  const externalExts = getExternalExtensions();
  const enabledExternalExts = externalExts.filter(ext => {
    if (extensionWindows.has(ext.id)) return false;
    if (!ext.enabled || !ext.path) return false;
    return true;
  });

  if (enabledExternalExts.length > 0) {
    const extExtStart = Date.now();
    await Promise.all(enabledExternalExts.map(ext => createExtensionWindow(ext.id)));
    DEBUG && console.log(`[ext:timing] external: ${Date.now() - extExtStart}ms`);
  }

  DEBUG && console.log(`[ext:timing] total: ${Date.now() - extStart}ms`);

  // Phase 3: UI - extensions can now initialize UI elements
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'ui' });

  // Phase 4: Complete - all extensions loaded
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'complete' });
  publish('system', scopes.GLOBAL, 'ext:all-loaded', {
    count: extensionWindows.size
  });

  return extensionWindows.size;
}

/**
 * Create the consolidated extension host window
 * All extensions load as iframes within this single window
 */
async function createExtensionHostWindow(): Promise<BrowserWindow> {
  DEBUG && console.log('[ext:host] Creating consolidated extension host window');

  // Use profile-specific session for isolation
  const profileSession = getProfileSession();

  const win = new BrowserWindow({
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    webPreferences: {
      preload: config.preloadPath,
      session: profileSession,
      nodeIntegrationInSubFrames: true,  // Preload runs in iframes too
    }
  });

  // Forward console logs from extension host
  win.webContents.on('console-message', (event) => {
    DEBUG && console.log(`[ext:host] ${event.message}`);
  });

  // Log load errors
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[ext:host] Failed to load: ${errorCode} ${errorDescription}`);
  });

  await win.loadURL('peek://app/extension-host.html');

  extensionHostWindow = win;

  // Open devtools for extension host in debug mode (not in tests or headless)
  if (config.isDev && !isTestProfile() && !isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  return win;
}

/**
 * Load extensions in consolidated mode (single window with iframes)
 */
async function loadExtensionsConsolidated(): Promise<number> {
  const extStart = Date.now();

  // Create the extension host window
  const host = await createExtensionHostWindow();

  // Get all extension IDs to load
  const builtinExtIds = getRegisteredExtensionIds();
  const enabledBuiltinIds = builtinExtIds.filter(id => isBuiltinExtensionEnabled(id));

  // Get external extensions
  const externalExts = getExternalExtensions();
  const enabledExternalIds = externalExts
    .filter(ext => ext.enabled && ext.path)
    .map(ext => ext.id);

  const allExtIds = [...enabledBuiltinIds, ...enabledExternalIds];

  DEBUG && console.log(`[ext:host] Loading ${allExtIds.length} extensions as iframes`);

  // Phase 1: Early
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'early' });

  // Send load commands to extension host
  // Load cmd first (it's the command registry)
  if (allExtIds.includes('cmd')) {
    host.webContents.send('ext:load', { id: 'cmd', url: `peek://cmd/background.html` });
    // Wait for cmd iframe to load
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Phase 2: Commands
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });

  // Load remaining extensions
  const otherIds = allExtIds.filter(id => id !== 'cmd');
  for (const extId of otherIds) {
    host.webContents.send('ext:load', { id: extId, url: `peek://${extId}/background.html` });
  }

  // Wait for iframes to load
  await new Promise(resolve => setTimeout(resolve, 200));

  DEBUG && console.log(`[ext:timing] consolidated total: ${Date.now() - extStart}ms`);

  // Phase 3: UI
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'ui' });

  // Phase 4: Complete
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'complete' });
  publish('system', scopes.GLOBAL, 'ext:all-loaded', { count: allExtIds.length });

  return allExtIds.length;
}

/**
 * Load all enabled extensions (hybrid mode)
 * - Built-in extensions (cmd, groups, peeks, slides) → consolidated (iframes)
 * - External extensions (including example) → separate windows
 */
export async function loadExtensions(): Promise<number> {
  const extStart = Date.now();

  // Get all registered extension IDs
  const registeredExtIds = getRegisteredExtensionIds();

  // Split into consolidated (built-in) and external
  const consolidatedIds = registeredExtIds.filter(id =>
    CONSOLIDATED_EXTENSION_IDS.includes(id) && isBuiltinExtensionEnabled(id)
  );
  const externalBuiltinIds = registeredExtIds.filter(id =>
    !CONSOLIDATED_EXTENSION_IDS.includes(id) && isBuiltinExtensionEnabled(id)
  );

  // Get external extensions from datastore
  const externalExts = getExternalExtensions();
  const enabledExternalExts = externalExts.filter(ext => ext.enabled && ext.path);

  DEBUG && console.log(`[ext] Hybrid mode: ${consolidatedIds.length} consolidated, ${externalBuiltinIds.length + enabledExternalExts.length} external`);

  // Phase 1: Early
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'early' });

  // Create extension host window for consolidated extensions
  if (consolidatedIds.length > 0) {
    const host = await createExtensionHostWindow();

    // Load cmd first (command registry)
    if (consolidatedIds.includes('cmd')) {
      host.webContents.send('ext:load', { id: 'cmd', url: 'peek://cmd/background.html' });
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Phase 2: Commands
    publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });

    // Load remaining consolidated extensions
    const otherConsolidatedIds = consolidatedIds.filter(id => id !== 'cmd');
    for (const extId of otherConsolidatedIds) {
      host.webContents.send('ext:load', { id: extId, url: `peek://${extId}/background.html` });
    }

    // Wait for consolidated extensions to load
    await new Promise(resolve => setTimeout(resolve, 200));
  } else {
    // Phase 2: Commands (even if no consolidated)
    publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });
  }

  // Load external built-in extensions (like 'example') as separate windows
  for (const extId of externalBuiltinIds) {
    await createExtensionWindow(extId);
  }

  // Load external extensions from datastore as separate windows
  for (const ext of enabledExternalExts) {
    if (!extensionWindows.has(ext.id)) {
      registerExtensionPath(ext.id, ext.path!);
      await createExtensionWindow(ext.id);
    }
  }

  const totalCount = consolidatedIds.length + externalBuiltinIds.length + enabledExternalExts.length;
  DEBUG && console.log(`[ext:timing] hybrid total: ${Date.now() - extStart}ms`);

  // Phase 3: UI
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'ui' });

  // Phase 4: Complete
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'complete' });
  publish('system', scopes.GLOBAL, 'ext:all-loaded', { count: totalCount });

  return totalCount;
}

/**
 * Get running extensions info
 * Includes both consolidated (iframe) and separate window extensions
 */
export function getRunningExtensions(): Array<{ id: string; manifest: unknown; status: string }> {
  const running: Array<{ id: string; manifest: unknown; status: string }> = [];

  // Add consolidated extensions (in extension host iframes)
  if (extensionHostWindow && !extensionHostWindow.isDestroyed()) {
    for (const extId of CONSOLIDATED_EXTENSION_IDS) {
      if (isBuiltinExtensionEnabled(extId)) {
        // loadExtensionManifest expects a path, not an ID
        const extPath = getExtensionPath(extId);
        const manifest = extPath ? loadExtensionManifest(extPath) : null;
        running.push({
          id: extId,
          manifest: manifest || { id: extId },
          status: 'running'
        });
      }
    }
  }

  // Add separate window extensions
  for (const [extId, entry] of extensionWindows) {
    if (entry.status === 'running') {
      running.push({
        id: extId,
        manifest: entry.manifest,
        status: entry.status
      });
    }
  }

  return running;
}

/**
 * Destroy an extension window
 */
export function destroyExtensionWindow(extId: string): boolean {
  const entry = extensionWindows.get(extId);
  if (!entry) {
    DEBUG && console.log(`[ext:win] No window to destroy for: ${extId}`);
    return false;
  }

  DEBUG && console.log(`[ext:win] Destroying window for: ${extId}`);

  if (entry.win && !entry.win.isDestroyed()) {
    try {
      entry.win.webContents.send('pubsub:app:shutdown', {});
    } catch {
      // Window may have been destroyed between check and send
    }
    setTimeout(() => {
      if (!entry.win.isDestroyed()) {
        entry.win.destroy();
      }
    }, 100);
  }

  extensionWindows.delete(extId);
  return true;
}

/**
 * Get an extension window
 */
export function getExtensionWindow(extId: string): BrowserWindow | null {
  const entry = extensionWindows.get(extId);
  return entry ? entry.win : null;
}

/**
 * Get the extension host window (for consolidated/builtin extensions)
 */
export function getExtensionHostWindow(): BrowserWindow | null {
  return extensionHostWindow;
}

/**
 * Check if an extension runs in consolidated mode (iframe in host)
 */
export function isConsolidatedExtension(extId: string): boolean {
  return CONSOLIDATED_EXTENSION_IDS.includes(extId);
}

/**
 * Check if an extension is a dev extension (loaded via CLI)
 */
export function isDevExtension(extId: string): boolean {
  return devExtensions.has(extId);
}

/**
 * Register a dev extension path for CLI --load-extension
 * These are transient and not persisted to datastore
 */
export function registerDevExtension(extId: string, extPath: string): void {
  devExtensions.set(extId, { path: extPath });
  // Also register the path so protocol handler can find it
  registerExtensionPath(extId, extPath);
  DEBUG && console.log(`[ext:dev] Registered dev extension: ${extId} from ${extPath}`);
}

/**
 * Load a dev extension with devtools always open
 */
export async function loadDevExtension(extId: string): Promise<BrowserWindow | null> {
  const devExt = devExtensions.get(extId);
  if (!devExt) {
    console.error(`[ext:dev] Dev extension not registered: ${extId}`);
    return null;
  }

  // Create the extension window
  const win = await createExtensionWindow(extId);
  if (!win) {
    return null;
  }

  // Always open devtools for dev extensions (regardless of debug mode)
  if (!isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  DEBUG && console.log(`[ext:dev] Loaded dev extension: ${extId}`);
  return win;
}

/**
 * Load all registered dev extensions
 */
export async function loadDevExtensions(): Promise<number> {
  let count = 0;
  for (const [extId] of devExtensions) {
    const win = await loadDevExtension(extId);
    if (win) count++;
  }
  return count;
}

/**
 * Unload and clean up all dev extensions
 */
export function cleanupDevExtensions(): void {
  for (const [extId] of devExtensions) {
    destroyExtensionWindow(extId);
    DEBUG && console.log(`[ext:dev] Cleaned up dev extension: ${extId}`);
  }
  devExtensions.clear();
}

/**
 * Get list of dev extension IDs
 */
export function getDevExtensionIds(): string[] {
  return Array.from(devExtensions.keys());
}

/**
 * Reload an extension by destroying and recreating its window
 * Returns the new window on success, null on failure
 */
export async function reloadExtension(extId: string): Promise<BrowserWindow | null> {
  DEBUG && console.log(`[ext:reload] Reloading extension: ${extId}`);

  // Check if it's a consolidated extension (not supported for reload)
  if (isConsolidatedExtension(extId)) {
    console.error(`[ext:reload] Cannot reload consolidated extension: ${extId} (reload the app instead)`);
    return null;
  }

  // Destroy existing window if any
  const existingEntry = extensionWindows.get(extId);
  if (existingEntry) {
    if (existingEntry.win && !existingEntry.win.isDestroyed()) {
      existingEntry.win.destroy();
    }
    extensionWindows.delete(extId);
  }

  // Small delay to ensure cleanup
  await new Promise(resolve => setTimeout(resolve, 100));

  // For dev extensions, use loadDevExtension to ensure devtools opens
  if (isDevExtension(extId)) {
    return loadDevExtension(extId);
  }

  // For normal extensions, use createExtensionWindow
  return createExtensionWindow(extId);
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
      const browserWindow = BrowserWindow.fromId(id);
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
 * Shutdown the application
 */
export async function shutdown(): Promise<void> {
  // Publish shutdown event
  publish(getSystemAddress(), scopes.GLOBAL, 'app:shutdown', {
    timestamp: Date.now()
  });

  // Close database
  closeDatabase();
}

// ***** Background Window *****

let backgroundWindow: BrowserWindow | null = null;

/**
 * Create the core background window
 */
export function createBackgroundWindow(): BrowserWindow {
  const preloadPath = getPreloadPath();
  const systemAddress = getSystemAddress();

  // Use profile-specific session for isolation
  const profileSession = getProfileSession();

  const winPrefs = {
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    key: 'background-core',
    webPreferences: {
      preload: preloadPath,
      session: profileSession,
    }
  };

  // Create the background window
  const win = new BrowserWindow(winPrefs);
  win.loadURL(WEB_CORE_ADDRESS);

  // Forward console logs from background window
  win.webContents.on('console-message', (event) => {
    DEBUG && console.log(`[core] ${event.message}`);
  });

  // Setup devtools for the background window (debug mode, but not in tests or headless)
  if (config.isDev && !isTestProfile() && !isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  // Add to window manager
  registerWindow(win.id, systemAddress, { ...winPrefs, address: WEB_CORE_ADDRESS });

  // NOTE: No ESC handler for background window - it should never be closed

  // Set up handlers for windows opened from the background window
  win.webContents.setWindowOpenHandler((details) => {
    DEBUG && console.log('Background window opening child window:', details.url);

    // Parse window features into options
    const featuresMap: Record<string, unknown> = {};
    if (details.features) {
      details.features.split(',')
        .map(entry => entry.split('='))
        .forEach(([key, value]) => {
          let parsedValue: unknown = value;
          // Convert string booleans to actual booleans
          if (value === 'true') parsedValue = true;
          else if (value === 'false') parsedValue = false;
          // Convert numeric values to numbers
          else if (!isNaN(Number(value)) && value.trim() !== '') {
            parsedValue = parseInt(value, 10);
          }
          featuresMap[key] = parsedValue;
        });
    }

    DEBUG && console.log('Parsed features map:', featuresMap);

    // Check if window with this key already exists
    if (featuresMap.key) {
      const existingWindow = findWindowByKey(WEB_CORE_ADDRESS, featuresMap.key as string);
      if (existingWindow) {
        DEBUG && console.log('Reusing existing window with key:', featuresMap.key);
        if (!isHeadless()) {
          existingWindow.window.show();
        }
        return { action: 'deny' as const };
      }
    }

    // Determine frame setting based on explicit option or preference
    let frameDefault = false; // Default to frameless if pref not available
    if (featuresMap.frame === undefined) {
      const prefs = getPrefs();
      // hideTitleBar: true means frame: false (no titlebar)
      // hideTitleBar: false means frame: true (show titlebar)
      frameDefault = prefs.hideTitleBar === false;
    }

    // Prepare browser window options
    // Use profile-specific session for isolation
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      frame: frameDefault, // Default based on hideTitleBar pref
      ...(featuresMap as Electron.BrowserWindowConstructorOptions),
      width: parseInt(String(featuresMap.width)) || APP_DEF_WIDTH,
      height: parseInt(String(featuresMap.height)) || APP_DEF_HEIGHT,
      show: isHeadless() ? false : featuresMap.show !== false,
      // Don't set backgroundColor for transparent windows - it would show through
      backgroundColor: featuresMap.transparent ? undefined : getSystemThemeBackgroundColor(),
      webPreferences: {
        preload: preloadPath,
        session: getProfileSession(),
      }
    };

    // Make sure position parameters are correctly handled
    if (featuresMap.x !== undefined) {
      winOptions.x = parseInt(String(featuresMap.x));
    }
    if (featuresMap.y !== undefined) {
      winOptions.y = parseInt(String(featuresMap.y));
    }

    DEBUG && console.log('Background window creating child with options:', winOptions);

    // Make sure we register browser window created handler to track the new window
    const onCreated = (_e: Electron.Event, newWin: BrowserWindow) => {
      // Check if this is the window we just created
      newWin.webContents.once('did-finish-load', () => {
        const loadedUrl = newWin.webContents.getURL();
        if (loadedUrl === details.url) {
          // Remove the listener
          app.removeListener('browser-window-created', onCreated);

          // Add the window to our manager with necessary parameters
          registerWindow(newWin.id, WEB_CORE_ADDRESS, {
            ...featuresMap,
            address: details.url,
            modal: featuresMap.modal
          });

          // Track this load in history
          try {
            trackWindowLoad(details.url, {
              source: (featuresMap.trackingSource as string) || 'background',
              sourceId: (featuresMap.trackingSourceId as string) || '',
              windowType: featuresMap.modal ? 'modal' : 'main',
              title: (newWin.getTitle() !== 'Loading...' ? newWin.getTitle() : '') || '',
            });
          } catch (e) {
            DEBUG && console.log('Failed to track background child window load:', e);
          }

          // Set initial mode based on URL
          updateModeForNavigation(newWin.id, details.url);

          // Update item title when page finishes loading (background child windows).
          // Without this, titles stay empty or "Loading..." in history.
          if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
            newWin.webContents.on('page-title-updated', (_event: Electron.Event, title: string) => {
              if (title && title !== 'Loading...') {
                try {
                  updateItemTitle(newWin.webContents.getURL() || details.url, title);
                } catch (e) {
                  DEBUG && console.log('Failed to update title from page-title-updated:', e);
                }
              }
            });
          }

          // Track in-page navigation within this window
          newWin.webContents.on('did-navigate', (_event: Electron.Event, navUrl: string) => {
            if (navUrl === details.url) return;
            // Update mode for the new URL
            updateModeForNavigation(newWin.id, navUrl);
            try {
              trackWindowLoad(navUrl, {
                source: 'navigation',
                sourceId: '',
                windowType: featuresMap.modal ? 'modal' : 'main',
                title: (newWin.getTitle() !== 'Loading...' ? newWin.getTitle() : '') || '',
              });
            } catch (e) {
              DEBUG && console.log('Failed to track did-navigate:', e);
            }
          });

          // Add escape key handler
          addEscHandler(newWin);

          // Track window for display change handling
          trackWindow(newWin);

          // Set up DevTools if requested
          winDevtoolsConfig(newWin);

          // Set up modal behavior with delay to avoid focus race condition
          if (featuresMap.modal === true) {
            setTimeout(() => {
              if (!newWin.isDestroyed()) {
                newWin.on('blur', () => {
                  DEBUG && console.log('Modal window lost focus:', details.url);
                  closeOrHideWindow(newWin.id);
                });
              }
            }, 100);
          }
        }
      });
    };

    // Start listening for the window creation
    app.on('browser-window-created', onCreated);

    // Return allow with overridden options
    return {
      action: 'allow' as const,
      overrideBrowserWindowOptions: winOptions
    };
  });

  backgroundWindow = win;
  return win;
}

/**
 * Get the background window
 */
export function getBackgroundWindow(): BrowserWindow | null {
  return backgroundWindow;
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
  DEBUG && console.log('External URL received:', url, 'from:', sourceId);

  if (!_appReady) {
    _pendingUrls.push({ url, sourceId });
    return;
  }

  // If frontend isn't ready yet, queue and wait
  if (!_frontendReady || !_sessionRestoreDone) {
    _pendingUrls.push({ url, sourceId });
    DEBUG && console.log('External URL queued (waiting for frontend/session):', url);
    return;
  }

  publishExternalUrl(url, sourceId);
}

/**
 * Publish a single external URL to the frontend via pubsub
 */
function publishExternalUrl(url: string, sourceId: string): void {
  const processUrl = () => {
    // Note: Using trackingSource/trackingSourceId because preload.js overwrites msg.source
    publish(getSystemAddress(), scopes.GLOBAL, 'external:open-url', {
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

  if (urls.length === 0) return;

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
    if (fs.existsSync(resolved)) {
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
  // macOS: handle open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
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
  app.on('second-instance', (_event, argv) => {
    // Look for URLs first
    const url = argv.find(arg =>
      arg.startsWith('http://') || arg.startsWith('https://')
    );
    if (url) {
      DEBUG && console.log('second-instance URL:', url);
      handleExternalUrl(url, 'os');
      return;
    }

    // Look for file paths (skip flags and the executable path)
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-')) continue;
      const fileUrl = filePathToUrl(arg);
      if (fileUrl) {
        DEBUG && console.log('second-instance file path:', arg, '->', fileUrl);
        handleExternalUrl(fileUrl, 'os');
        return;
      }
    }
  });
}

/**
 * Check for URL or file path in CLI arguments and handle it.
 * Uses handleExternalUrl which queues until frontend + session restore are ready.
 */
export function handleCliUrl(): void {
  // Look for URLs first
  const urlArg = process.argv.find(arg =>
    arg.startsWith('http://') || arg.startsWith('https://')
  );
  if (urlArg) {
    DEBUG && console.log('CLI URL argument:', urlArg);
    handleExternalUrl(urlArg, 'cli');
    return;
  }

  // Look for file paths (skip flags, electron path, and the app path)
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    // Skip the app directory/entry point itself
    if (arg === app.getAppPath() || arg.endsWith('.js')) continue;
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
    if (BrowserWindow.getAllWindows().length === 0) {
      // Could recreate window here if needed
    }
  });
}

/**
 * Request single instance lock
 * Returns true if lock acquired, false if another instance is running
 * Skips lock in dev/test profiles to allow running alongside production
 */
export function requestSingleInstance(): boolean {
  // Skip single-instance lock in dev/test profiles to allow running alongside production
  if (isDevProfile() || isTestProfile()) {
    DEBUG && console.log('Skipping single-instance lock for profile:', getProfile());
    return true;
  }

  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.error('APP INSTANCE ALREADY RUNNING, QUITTING');
    app.quit();
    return false;
  }
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
  scopes,
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
  getExtensionPath,
  getRegisteredExtensionIds,
  loadExtensionManifest,
};
