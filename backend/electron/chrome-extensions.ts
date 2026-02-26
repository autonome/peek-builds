/**
 * Chrome Extension Manager for Electron
 *
 * Provides infrastructure for loading bundled Chrome/MV3 web extensions.
 * Extensions are loaded from a bundled directory using Electron's native
 * session.loadExtension() API.
 *
 * Features:
 * - Load unpacked Chrome extensions from bundled directory
 * - Enable/disable extensions via settings (persisted in datastore)
 * - Compatible with electron-chrome-extensions for enhanced API support
 */

import { session, Extension, BrowserWindow, nativeTheme, ipcMain, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from './datastore.js';
import { getProfileSession } from './session-partition.js';
import { registerAll } from './chrome-api-polyfills/index.js';

const DEBUG = !!process.env.DEBUG;

/**
 * Chrome extension manifest.json structure (MV3)
 */
export interface ChromeManifest {
  manifest_version: number;
  name: string;
  version: string;
  description?: string;
  icons?: Record<string, string>;
  permissions?: string[];
  host_permissions?: string[];
  background?: {
    page?: string;
    service_worker?: string;
    scripts?: string[];
    type?: string;
  };
  content_scripts?: Array<{
    matches: string[];
    js?: string[];
    css?: string[];
    run_at?: string;
  }>;
  action?: {
    default_popup?: string;
    default_icon?: string | Record<string, string>;
    default_title?: string;
  };
  options_page?: string;
  options_ui?: {
    page: string;
    open_in_tab?: boolean;
  };
  browser_action?: {
    default_popup?: string;
    default_icon?: string | Record<string, string>;
    default_title?: string;
  };
  chrome_url_overrides?: {
    newtab?: string;
    history?: string;
    bookmarks?: string;
  };
  devtools_page?: string;
  side_panel?: {
    default_path?: string;
  };
  sidebar_action?: {
    default_panel?: string;
    default_title?: string;
  };
  web_accessible_resources?: Array<{
    resources: string[];
    matches: string[];
  }>;
}

/**
 * UI entry point for a chrome extension
 */
export type ChromeExtensionUiEntryType =
  | 'popup' | 'options' | 'background' | 'newtab' | 'history'
  | 'bookmarks' | 'devtools' | 'sidepanel';

export interface ChromeExtensionUiEntry {
  extensionId: string;
  extensionName: string;
  type: ChromeExtensionUiEntryType;
  title: string;
  url: string;
  /** Suggested window dimensions */
  width: number;
  height: number;
  /** Whether this entry point can be opened in a window */
  openable: boolean;
}

/**
 * Discovered extension info (before loading)
 */
export interface ChromeExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  manifest: ChromeManifest;
}

/**
 * Loaded extension state
 */
export interface LoadedChromeExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  electronExtension: Extension;
}

/**
 * Extension enable/disable setting (persisted)
 */
export interface ChromeExtensionSetting {
  extensionId: string;
  enabled: boolean;
  updatedAt: number;
}

// Extensions that are disabled by default (must be explicitly enabled by user)
const DISABLED_BY_DEFAULT = new Set(['proton-pass']);

// Module state
let polyfillHandle: { cleanup: () => void; getPreloadScript: () => string } | null = null;
let extensionsDir: string | null = null;
const discoveredExtensions: Map<string, ChromeExtensionInfo> = new Map();
const loadedExtensions: Map<string, LoadedChromeExtension> = new Map();
// Track open extension UI windows: key = `${extId}:${type}` -> BrowserWindow
const extensionUiWindows: Map<string, BrowserWindow> = new Map();

/**
 * Initialize the chrome_extensions table in the database
 */
function initChromeExtensionsTable(): void {
  const db = getDb();
  if (!db) {
    console.error('[chrome-ext] Database not initialized');
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_extensions (
      extensionId TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL
    )
  `);

  DEBUG && console.log('[chrome-ext] Database table initialized');
}

/**
 * Get extension setting from database
 */
function getExtensionSetting(extensionId: string): ChromeExtensionSetting | null {
  const db = getDb();
  if (!db) return null;

  const row = db.prepare(
    'SELECT extensionId, enabled, updatedAt FROM chrome_extensions WHERE extensionId = ?'
  ).get(extensionId) as { extensionId: string; enabled: number; updatedAt: number } | undefined;

  if (!row) return null;

  return {
    extensionId: row.extensionId,
    enabled: row.enabled === 1,
    updatedAt: row.updatedAt,
  };
}

/**
 * Save extension setting to database
 */
function saveExtensionSetting(extensionId: string, enabled: boolean): void {
  const db = getDb();
  if (!db) return;

  const now = Date.now();
  db.prepare(`
    INSERT INTO chrome_extensions (extensionId, enabled, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(extensionId) DO UPDATE SET
      enabled = excluded.enabled,
      updatedAt = excluded.updatedAt
  `).run(extensionId, enabled ? 1 : 0, now);

  DEBUG && console.log(`[chrome-ext] Saved setting: ${extensionId} = ${enabled}`);
}

/**
 * Initialize the chrome extension manager
 * @param bundledExtensionsDir Path to the bundled extensions directory
 */
export function initChromeExtensionManager(bundledExtensionsDir: string): void {
  extensionsDir = bundledExtensionsDir;

  // Initialize database table
  initChromeExtensionsTable();

  // Discover extensions in the directory
  discoverExtensions();

  DEBUG && console.log(`[chrome-ext] Manager initialized with ${discoveredExtensions.size} extensions`);
}

/**
 * Discover extensions in the bundled directory
 */
function discoverExtensions(): void {
  if (!extensionsDir) return;

  if (!fs.existsSync(extensionsDir)) {
    DEBUG && console.log(`[chrome-ext] Extensions directory does not exist: ${extensionsDir}`);
    return;
  }

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const extPath = path.join(extensionsDir, entry.name);
    const manifestPath = path.join(extPath, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      DEBUG && console.log(`[chrome-ext] Skipping ${entry.name}: no manifest.json`);
      continue;
    }

    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as ChromeManifest;

      // Use directory name as ID (standard for unpacked extensions)
      const extId = entry.name;

      const extInfo: ChromeExtensionInfo = {
        id: extId,
        name: manifest.name || extId,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        path: extPath,
        manifest,
      };

      discoveredExtensions.set(extId, extInfo);
      DEBUG && console.log(`[chrome-ext] Discovered: ${extInfo.name} v${extInfo.version}`);
    } catch (error) {
      console.error(`[chrome-ext] Failed to read manifest for ${entry.name}:`, error);
    }
  }
}

/**
 * Load a chrome extension into the session
 */
async function loadExtension(extInfo: ChromeExtensionInfo): Promise<LoadedChromeExtension | null> {
  if (loadedExtensions.has(extInfo.id)) {
    DEBUG && console.log(`[chrome-ext] Extension already loaded: ${extInfo.id}`);
    return loadedExtensions.get(extInfo.id) || null;
  }

  try {
    // Use profile-specific session for isolation
    const profileSession = getProfileSession();
    const ext = await profileSession.loadExtension(extInfo.path, {
      allowFileAccess: true,
    });

    const loaded: LoadedChromeExtension = {
      id: extInfo.id,
      name: extInfo.name,
      version: extInfo.version,
      path: extInfo.path,
      electronExtension: ext,
    };

    loadedExtensions.set(extInfo.id, loaded);
    DEBUG && console.log(`[chrome-ext] Loaded: ${extInfo.name}`);

    return loaded;
  } catch (error) {
    console.error(`[chrome-ext] Failed to load ${extInfo.id}:`, error);
    return null;
  }
}

/**
 * Unload a chrome extension from the session
 */
async function unloadExtension(extId: string): Promise<boolean> {
  const loaded = loadedExtensions.get(extId);
  if (!loaded) {
    DEBUG && console.log(`[chrome-ext] Extension not loaded: ${extId}`);
    return false;
  }

  try {
    // Use profile-specific session for isolation
    const profileSession = getProfileSession();
    await profileSession.removeExtension(loaded.electronExtension.id);
    loadedExtensions.delete(extId);
    DEBUG && console.log(`[chrome-ext] Unloaded: ${loaded.name}`);
    return true;
  } catch (error) {
    console.error(`[chrome-ext] Failed to unload ${extId}:`, error);
    return false;
  }
}

/**
 * Load all enabled chrome extensions
 */
export async function loadEnabledChromeExtensions(): Promise<void> {
  DEBUG && console.log('[chrome-ext] Loading enabled extensions...');

  // Register Chrome API polyfills before loading extensions
  const profileSession = getProfileSession();
  if (!polyfillHandle) {
    polyfillHandle = registerAll(profileSession, { ipcMain, app });

    // Inject polyfill preload scripts into extension webContents
    app.on('web-contents-created', (_event, webContents) => {
      webContents.on('dom-ready', () => {
        const url = webContents.getURL();
        if (url.startsWith('chrome-extension://') && polyfillHandle) {
          webContents.executeJavaScript(polyfillHandle.getPreloadScript()).catch(() => {
            // Ignore injection errors (webContents may be destroyed)
          });
        }
      });
    });

    DEBUG && console.log('[chrome-ext] Chrome API polyfills registered');
  }

  for (const [extId, extInfo] of discoveredExtensions) {
    const setting = getExtensionSetting(extId);

    // Default to enabled unless in the disabled-by-default list
    const enabled = setting ? setting.enabled : !DISABLED_BY_DEFAULT.has(extId);

    if (enabled) {
      await loadExtension(extInfo);
    }
  }

  DEBUG && console.log(`[chrome-ext] Loaded ${loadedExtensions.size} extensions`);
}

/**
 * Get list of all chrome extensions with their status
 */
export function getChromeExtensions(): Array<{
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  loaded: boolean;
  path: string;
  hasOptionsPage: boolean;
  attribution?: string;
}> {
  const result: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    enabled: boolean;
    loaded: boolean;
    path: string;
    hasOptionsPage: boolean;
    attribution?: string;
  }> = [];

  for (const [extId, extInfo] of discoveredExtensions) {
    const setting = getExtensionSetting(extId);
    const enabled = setting ? setting.enabled : !DISABLED_BY_DEFAULT.has(extId);
    const loaded = loadedExtensions.has(extId);
    const hasOptionsPage = !!(extInfo.manifest.options_ui?.page || extInfo.manifest.options_page);

    // Build attribution from manifest metadata
    let attribution: string | undefined;
    const manifest = extInfo.manifest as ChromeManifest & { author?: string; homepage_url?: string };
    if (manifest.author || manifest.homepage_url) {
      const parts: string[] = [];
      if (manifest.author) parts.push(manifest.author);
      if (manifest.homepage_url) parts.push(manifest.homepage_url);
      attribution = parts.join(' - ');
    }

    result.push({
      id: extId,
      name: extInfo.name,
      version: extInfo.version,
      description: extInfo.description,
      enabled,
      loaded,
      path: extInfo.path,
      hasOptionsPage,
      attribution,
    });
  }

  return result;
}

/**
 * Enable a chrome extension
 */
export async function enableChromeExtension(extId: string): Promise<boolean> {
  const extInfo = discoveredExtensions.get(extId);
  if (!extInfo) {
    console.error(`[chrome-ext] Unknown extension: ${extId}`);
    return false;
  }

  saveExtensionSetting(extId, true);

  const loaded = await loadExtension(extInfo);
  return loaded !== null;
}

/**
 * Disable a chrome extension
 */
export async function disableChromeExtension(extId: string): Promise<boolean> {
  saveExtensionSetting(extId, false);
  return await unloadExtension(extId);
}

/**
 * Check if a chrome extension is enabled
 */
export function isChromeExtensionEnabled(extId: string): boolean {
  const setting = getExtensionSetting(extId);
  return setting ? setting.enabled : !DISABLED_BY_DEFAULT.has(extId);
}

/**
 * Check if a chrome extension is loaded
 */
export function isChromeExtensionLoaded(extId: string): boolean {
  return loadedExtensions.has(extId);
}

/**
 * Get chrome extension manager status
 */
export function getChromeExtensionStatus(): {
  initialized: boolean;
  extensionsDir: string | null;
  discoveredCount: number;
  loadedCount: number;
} {
  return {
    initialized: extensionsDir !== null,
    extensionsDir,
    discoveredCount: discoveredExtensions.size,
    loadedCount: loadedExtensions.size,
  };
}

/**
 * Get UI entry points for all loaded chrome extensions.
 * Detects all possible entry points from each extension's manifest.json.
 * Returns entries only for extensions that are currently loaded.
 */
export function getChromeExtensionUiEntries(): ChromeExtensionUiEntry[] {
  const entries: ChromeExtensionUiEntry[] = [];

  for (const [extId, loaded] of loadedExtensions) {
    const discovered = discoveredExtensions.get(extId);
    if (!discovered) continue;

    const manifest = discovered.manifest;
    const baseUrl = loaded.electronExtension.url; // chrome-extension://[id]/

    // Action popup (action takes priority over browser_action for MV3)
    const popupPage = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    if (popupPage) {
      entries.push({
        extensionId: extId, extensionName: discovered.name, type: 'popup',
        title: manifest.action?.default_title || manifest.browser_action?.default_title || discovered.name,
        url: `${baseUrl}${popupPage}`, width: 400, height: 500, openable: true,
      });
    }

    // Options page (options_ui takes priority over options_page)
    const optionsPage = manifest.options_ui?.page || manifest.options_page;
    if (optionsPage) {
      entries.push({
        extensionId: extId, extensionName: discovered.name, type: 'options',
        title: `${discovered.name} Settings`,
        url: `${baseUrl}${optionsPage}`, width: 1024, height: 768, openable: true,
      });
    }

    // Background page (informational - service workers are not directly openable)
    const bgPage = manifest.background?.page;
    const bgWorker = manifest.background?.service_worker;
    const bgScripts = manifest.background?.scripts;
    if (bgPage || bgWorker || bgScripts) {
      const bgPath = bgPage || bgWorker || (bgScripts && bgScripts[0]) || '';
      entries.push({
        extensionId: extId, extensionName: discovered.name, type: 'background',
        title: `${discovered.name} Background`,
        url: bgPath ? `${baseUrl}${bgPath}` : '',
        width: 0, height: 0, openable: !!bgPage,
      });
    }

    // Chrome URL overrides
    if (manifest.chrome_url_overrides) {
      const overrides = manifest.chrome_url_overrides;
      if (overrides.newtab) {
        entries.push({
          extensionId: extId, extensionName: discovered.name, type: 'newtab',
          title: `${discovered.name} New Tab`,
          url: `${baseUrl}${overrides.newtab}`, width: 1024, height: 768, openable: true,
        });
      }
      if (overrides.history) {
        entries.push({
          extensionId: extId, extensionName: discovered.name, type: 'history',
          title: `${discovered.name} History`,
          url: `${baseUrl}${overrides.history}`, width: 1024, height: 768, openable: true,
        });
      }
      if (overrides.bookmarks) {
        entries.push({
          extensionId: extId, extensionName: discovered.name, type: 'bookmarks',
          title: `${discovered.name} Bookmarks`,
          url: `${baseUrl}${overrides.bookmarks}`, width: 1024, height: 768, openable: true,
        });
      }
    }

    // DevTools page
    if (manifest.devtools_page) {
      entries.push({
        extensionId: extId, extensionName: discovered.name, type: 'devtools',
        title: `${discovered.name} DevTools`,
        url: `${baseUrl}${manifest.devtools_page}`, width: 1024, height: 768, openable: true,
      });
    }

    // Side panel
    const sidePanelPath = manifest.side_panel?.default_path || manifest.sidebar_action?.default_panel;
    if (sidePanelPath) {
      entries.push({
        extensionId: extId, extensionName: discovered.name, type: 'sidepanel',
        title: manifest.sidebar_action?.default_title || `${discovered.name} Side Panel`,
        url: `${baseUrl}${sidePanelPath}`, width: 400, height: 768, openable: true,
      });
    }
  }

  return entries;
}
/**
 * Open a chrome extension's UI page in a BrowserWindow.
 * Supports all entry point types. Reuses existing window if already open.
 * @returns The BrowserWindow on success, null on failure
 */
export function openChromeExtensionPage(
  extensionId: string,
  pageType: ChromeExtensionUiEntryType
): BrowserWindow | null {
  const windowKey = `${extensionId}:${pageType}`;

  // Reuse existing window if it's still open
  const existing = extensionUiWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  // Find the UI entry
  const entries = getChromeExtensionUiEntries();
  const entry = entries.find(e => e.extensionId === extensionId && e.type === pageType);
  if (entry && !entry.openable) {
    console.error(`[chrome-ext] Entry point ${pageType} for ${extensionId} is not openable`);
    return null;
  }
  if (!entry) {
    console.error(`[chrome-ext] No ${pageType} page found for extension: ${extensionId}`);
    return null;
  }

  // Use profile-specific session so the extension page has access to chrome.* APIs
  const profileSession = getProfileSession();

  // Use dark background when system is in dark mode for proper Peek styling
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff';

  const win = new BrowserWindow({
    width: entry.width,
    height: entry.height,
    title: entry.title,
    show: true,
    backgroundColor,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      session: profileSession,
      // No preload — these are chrome extension pages, they use chrome.* APIs
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Track the window
  extensionUiWindows.set(windowKey, win);

  win.on('closed', () => {
    extensionUiWindows.delete(windowKey);
    DEBUG && console.log(`[chrome-ext] UI window closed: ${windowKey}`);
  });

  win.loadURL(entry.url).catch(error => {
    console.error(`[chrome-ext] Failed to load ${pageType} page for ${extensionId}:`, error);
    if (!win.isDestroyed()) {
      win.destroy();
    }
  });

  DEBUG && console.log(`[chrome-ext] Opened ${pageType} page for ${extensionId}: ${entry.url}`);

  return win;
}

/**
 * Clean up chrome extension manager
 */
export async function cleanupChromeExtensions(): Promise<void> {
  DEBUG && console.log('[chrome-ext] Cleaning up...');

  // Clean up Chrome API polyfills
  if (polyfillHandle) {
    polyfillHandle.cleanup();
    polyfillHandle = null;
  }

  // Close any open UI windows
  for (const [key, win] of extensionUiWindows) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
  extensionUiWindows.clear();

  for (const extId of loadedExtensions.keys()) {
    await unloadExtension(extId);
  }

  discoveredExtensions.clear();
  loadedExtensions.clear();
  extensionsDir = null;
}
