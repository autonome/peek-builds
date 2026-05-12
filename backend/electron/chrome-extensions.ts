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
import { buildOptionsCommandName, computeUiEntries } from './chrome-extensions-helpers.js';
import { invokeWindowOpen } from './ipc.js';
import { DEBUG } from './config.js';

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
  externally_connectable?: {
    matches?: string[];
    ids?: string[];
    accepts_tls_channel_id?: boolean;
  };
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
const DISABLED_BY_DEFAULT = new Set<string>();

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
    polyfillHandle = registerAll(profileSession, {
      ipcMain,
      app,
      // For sendMessage(extId, msg) calls from cross-origin pages where the
      // requested extId is a hardcoded Web Store ID (Proton's account bundle
      // fans out to 4 platform IDs that never match our Electron-assigned
      // runtime hash), fall back to resolving by origin.
      findExtensionByOrigin: (origin: string) => findExtensionByExternallyConnectableUrl(origin),
    });

    // Web permission handling now lives in permission-handler.ts (installed
    // by session-partition.ts when the profile session is created). The
    // canonical handler grants all permissions to chrome-extension:// origins
    // — same effect as the blanket-allow that used to live here, but without
    // also auto-allowing every webview guest's permission requests.

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

    // Forward extension service-worker console output to main stderr.
    // Without this, BG SW console.log/error are invisible — they live in
    // the SW's own console which isn't surfaced anywhere.
    if (DEBUG && typeof profileSession.serviceWorkers?.on === 'function') {
      profileSession.serviceWorkers.on('console-message', (msgDetails) => {
        try {
          const d = msgDetails as unknown as { message?: unknown; level?: unknown; sourceUrl?: unknown; versionId?: unknown };
          const msg = String(d.message ?? '');
          // Only forward our peek-tagged BG output to keep stderr readable;
          // Proton's BG is chatty.
          if (msg.includes('peek:') || msg.includes('peek-rt')) {
            console.log(`[sw:vid=${String(d.versionId)}:${String(d.level)}] ${msg}`);
          }
        } catch { /* logging must never throw */ }
      });
    }
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
 * Convert a manifest match-pattern (https://*.proton.me/*) into a host-checker
 * function. Used to test whether a webview URL falls under any loaded
 * extension's externally_connectable.matches.
 *
 * Subset of the chrome match-pattern grammar — sufficient for what extensions
 * we ship (Proton Pass etc.). Patterns: scheme://host/path. Wildcards:
 *   - scheme: "*" matches http or https
 *   - host: "*" matches any host; "*.example.com" matches example.com or
 *     any subdomain
 *   - path: literal prefix; "*" allowed only as the last segment
 */
function matchPatternToTester(pattern: string): ((url: URL) => boolean) | null {
  if (pattern === '<all_urls>') return () => true;
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/);
  if (!m) return null;
  const [, scheme, host, pathGlob] = m;
  const schemeMatcher = (s: string) => scheme === '*' ? (s === 'http:' || s === 'https:') : s === `${scheme}:`;
  let hostMatcher: (h: string) => boolean;
  if (host === '*') hostMatcher = () => true;
  else if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    hostMatcher = (h) => h === suffix || h.endsWith('.' + suffix);
  } else {
    hostMatcher = (h) => h === host;
  }
  // Path glob: convert to regex with * → .*
  const pathRe = new RegExp('^' + pathGlob.split('*').map(escapeRe).join('.*') + '$');
  return (url) => schemeMatcher(url.protocol) && hostMatcher(url.hostname) && pathRe.test(url.pathname + url.search);
}
function escapeRe(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Returns the extension ID whose externally_connectable.matches matches `url`,
 * or null if none. Used by entry.ts will-attach-webview to decide whether to
 * inject the runtime-external preload into a webview navigating to that URL.
 */
export function findExtensionByExternallyConnectableUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  for (const [extId, info] of discoveredExtensions) {
    const loaded = loadedExtensions.get(extId);
    if (!loaded) continue;
    const matches = info.manifest?.externally_connectable?.matches;
    if (!Array.isArray(matches)) continue;
    for (const pattern of matches) {
      const tester = matchPatternToTester(pattern);
      // Return the runtime Chrome extension ID hash (what `chrome.runtime.id`
      // resolves to for callers), not the unpacked-extension directory name.
      // Proton's bundle calls `sendMessage(chrome.runtime.id, msg)`, so the
      // page-side polyfill must expose the same hash here.
      if (tester && tester(parsed)) return loaded.electronExtension.id;
    }
  }
  return null;
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
  // Adapt module-level Maps to the shape expected by the pure helper so the
  // computation can be tested without an Electron session. The pure helper
  // (computeUiEntries in chrome-extensions-helpers.ts) is the standing
  // regression test surface for this logic.
  const loadedAdapted = new Map<string, { extensionUrl: string }>();
  for (const [id, loaded] of loadedExtensions) {
    loadedAdapted.set(id, { extensionUrl: loaded.electronExtension.url });
  }
  return computeUiEntries(loadedAdapted, discoveredExtensions) as ChromeExtensionUiEntry[];
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
      // injected by Electron's built-in extension support. sandbox is
      // explicit-true so the entry.ts SECURITY chokepoint sees a policy-
      // compliant window (extension pages have their own integrity model
      // via the extension manifest + the profile-session permissions).
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Track the window
  extensionUiWindows.set(windowKey, win);

  win.on('closed', () => {
    extensionUiWindows.delete(windowKey);
    DEBUG && console.log(`[chrome-ext] UI window closed: ${windowKey}`);
  });

  if (DEBUG) {
    // Forward renderer console + JS errors to main stderr so popup-side
    // failures (which would otherwise live only in the popup's DevTools)
    // surface in the same log stream as the rest of the extension wiring.
    // NOTE: console-message does NOT fire when DevTools is attached, so we
    // do not auto-open DevTools here. If you need to inspect manually,
    // right-click → Inspect inside the popup.
    win.webContents.on('console-message', (event) => {
      try {
        const e = event as unknown as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
        console.log(`[ext-popup:${windowKey}:${String(e.level)}] ${String(e.message)} (${String(e.sourceId)}:${String(e.lineNumber)})`);
      } catch {
        /* logging must never throw */
      }
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[ext-popup:${windowKey}] render-process-gone:`, details);
    });
  }

  // Route window.open(url) from the popup (and from our chrome.tabs.create
  // shim, which delegates to window.open) through Peek's normal window
  // pipeline. Without this, Electron's default handler creates a bare
  // BrowserWindow that bypasses Peek's tile/page system; for chrome
  // extensions specifically, the call also returns null, breaking
  // Proton's auth-fork chain.
  win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
    if (childUrl.startsWith('http://') || childUrl.startsWith('https://')) {
      DEBUG && console.log(`[chrome-ext] popup ${windowKey} → opening ${childUrl} in Peek`);
      if (invokeWindowOpen) {
        // ipc.ts derives the opener window via BrowserWindow.fromWebContents(ev.sender);
        // pass our popup's webContents so placement / parent-tracking works.
        invokeWindowOpen({ sender: win.webContents }, {
          source: `chrome-extension:${extensionId}`,
          url: childUrl,
          options: {},
        }).catch(err => {
          console.error(`[chrome-ext] invokeWindowOpen failed for ${childUrl}:`, err);
        });
      }
      return { action: 'deny' };
    }
    // Anything that isn't http(s) — chrome-extension://, data:, blob:,
    // javascript:, etc. — is denied. Previously this fell through to
    // `{ action: 'allow' }`, which let extension popups spawn raw
    // unregistered BrowserWindows that sit outside Peek's tile + preload
    // system entirely. If a legitimate use case for non-http schemes from
    // extension popups emerges, route it through invokeWindowOpen above
    // with explicit scheme handling rather than re-opening this hole.
    console.warn(`[chrome-ext] popup ${windowKey} attempted window.open('${childUrl}') with non-http scheme — denied`);
    return { action: 'deny' };
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


/**
 * Info needed to register a single "options" command for a loaded chrome extension.
 */
export interface ChromeExtensionOptionsCommand {
  extensionId: string;
  extensionName: string;
  commandName: string;
  url: string;
}

// Re-export the pure helpers from the split module so callers only need
// one import path.
export { sanitizeExtensionName, buildOptionsCommandName } from './chrome-extensions-helpers.js';

/**
 * Enumerate the options-page commands that should be registered for all
 * currently-loaded chrome extensions that expose an options UI. Pure —
 * derives everything from the already-populated discovery + loaded maps.
 */
export function getChromeExtensionOptionsCommands(): ChromeExtensionOptionsCommand[] {
  const commands: ChromeExtensionOptionsCommand[] = [];
  const entries = getChromeExtensionUiEntries();
  for (const entry of entries) {
    if (entry.type !== 'options') continue;
    if (!entry.openable) continue;
    const discovered = discoveredExtensions.get(entry.extensionId);
    const rawName = discovered?.name || entry.extensionName;
    commands.push({
      extensionId: entry.extensionId,
      extensionName: rawName,
      commandName: buildOptionsCommandName(rawName, entry.extensionId),
      url: entry.url,
    });
  }
  return commands;
}
