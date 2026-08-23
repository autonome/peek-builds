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
import { getBridgePreloadPath, setBridgeWindowsRegistry } from './chrome-api-polyfills/runtime-external.js';
// Re-exported so entry.ts can flag shutdown on the runtime-external relay from
// its before-quit handler (peek 048997b2) without reaching into the polyfill
// module directly.
export { markRuntimeExternalQuitting } from './chrome-api-polyfills/runtime-external.js';
import { buildOptionsCommandName, computeUiEntries } from './chrome-extensions-helpers.js';
import { invokeWindowOpen } from './ipc.js';
import { DEBUG, isHeadless } from './config.js';
import {
  registerWindowWithMachine,
  getWindowIdFor,
} from './window-machine.js';
import { deriveWindowSurface, isSatelliteRegistration } from './izui-roles.js';
import { shadowKernelDestroyWindow, shadowKernelShowRequested } from './window-kernel-shadow.js';

/**
 * Route a bridge/extension-UI window teardown through the window-state
 * machine (WINDOW_DESTROY_REQUESTED → DESTROY_WINDOW → backend.destroyWindow,
 * synchronous — the before-quit path depends on that). Every window this
 * module creates registers at construction, so the id always resolves; a
 * window the machine no longer knows is already gone.
 */
function destroyWindowViaMachine(win: BrowserWindow): void {
  const id = getWindowIdFor(win);
  if (id == null) return; // never registered / already retired — nothing to destroy
  shadowKernelDestroyWindow(id);
}

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
    world?: 'ISOLATED' | 'MAIN';
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
  /**
   * Canonical Chrome extension ID derived from the CRX's signed_header_data
   * (or its embedded public key). This is the ID that pages hardcode when
   * targeting this extension via `chrome.runtime.sendMessage(id, msg)` from
   * a `externally_connectable` origin. Different from Electron's
   * path-derived runtime ID. Used by the compat layer to faithfully reject
   * fan-out requests intended for OTHER platform-specific extension IDs
   * (firefox/edge/safari variants etc.) — Chrome would also reject those
   * with "no such extension." Populated by `scripts/install-chrome-extension.js`
   * into `apps/desktop/chrome-extensions/.peek-canonical-ids.json` and
   * loaded at init. May be null if the install script didn't write an entry
   * (e.g., manually-dropped extensions).
   */
  canonicalChromeId?: string | null;
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
// twp: bundled but spammy — uses chrome.tabs.detectLanguage which we don't
//      polyfill. Re-enable manually via Settings → Extensions if needed.
const DISABLED_BY_DEFAULT = new Set<string>(['twp']);

// Module state
let polyfillHandle: { cleanup: () => void; getPreloadScript: () => string } | null = null;
let extensionsDir: string | null = null;
const discoveredExtensions: Map<string, ChromeExtensionInfo> = new Map();
const loadedExtensions: Map<string, LoadedChromeExtension> = new Map();
// Track open extension UI windows: key = `${extId}:${type}` -> BrowserWindow
const extensionUiWindows: Map<string, BrowserWindow> = new Map();
// Track hidden bridge windows: key = electronExtension.id -> BrowserWindow.
// These provide the chrome-extension:// origin context needed for
// same-extension chrome.runtime.connect() to the BG SW.
const _bridgeWindows: Map<string, BrowserWindow> = new Map();

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

  // Load the canonical-IDs sidecar written by scripts/install-chrome-extension.js
  // (one JSON file at the extensions/ root, NOT inside any extension dir, so
  // we don't touch upstream source).
  let canonicalIds: Record<string, string> = {};
  const canonicalIdsPath = path.join(extensionsDir, '.peek-canonical-ids.json');
  if (fs.existsSync(canonicalIdsPath)) {
    try {
      canonicalIds = JSON.parse(fs.readFileSync(canonicalIdsPath, 'utf-8'));
      DEBUG && console.log(`[chrome-ext] loaded canonical IDs for ${Object.keys(canonicalIds).length} extension(s)`);
    } catch (err) {
      console.warn('[chrome-ext] failed to parse .peek-canonical-ids.json:', err);
    }
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
        canonicalChromeId: canonicalIds[extId] ?? null,
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
 * Wait for an extension's BG service worker to reach "running" status.
 * Electron's SW startup takes ~3s after loadExtension; the bridge window's
 * chrome.runtime.connect() fails until the SW is ready.
 */
async function _waitForServiceWorker(session: Electron.Session, runtimeId: string, extName: string): Promise<void> {
  const targetScope = `chrome-extension://${runtimeId}/`;
  const SW_TIMEOUT_MS = 10_000;
  const sw = session.serviceWorkers;
  if (!sw) {
    console.warn(`[chrome-ext] session.serviceWorkers unavailable — skipping SW wait for ${extName}`);
    return;
  }

  // Already running?
  const running = sw.getAllRunning?.() ?? {};
  for (const info of Object.values(running)) {
    if ((info as { scope?: string })?.scope?.startsWith(targetScope)) {
      console.log(`[chrome-ext] SW already running for ${extName}`);
      return;
    }
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      console.warn(`[chrome-ext] SW startup timeout (${SW_TIMEOUT_MS}ms) for ${extName} — spawning bridge anyway`);
      resolve();
    }, SW_TIMEOUT_MS);

    const handler = (...args: unknown[]) => {
      const details = args[0] as { versionId?: number; runningStatus?: string } | undefined;
      if (details?.runningStatus !== 'running') return;
      const allRunning = sw.getAllRunning?.() ?? {};
      const vid = String(details.versionId);
      const info = (allRunning as Record<string, { scope?: string }>)[vid];
      if (info?.scope?.startsWith(targetScope)) {
        cleanup();
        console.log(`[chrome-ext] SW running for ${extName} (vid=${details.versionId})`);
        resolve();
      }
    };

    function cleanup() {
      clearTimeout(timer);
      try { (sw as unknown as { removeListener: (e: string, h: (...a: unknown[]) => void) => void }).removeListener('running-status-changed', handler); } catch { /* best effort */ }
    }

    (sw as unknown as { on: (e: string, h: (...a: unknown[]) => void) => void }).on('running-status-changed', handler);
  });
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

    // Spawn the hidden bridge window for this extension if the extension has
    // externally_connectable matches (i.e. it can receive cross-origin messages).
    // The bridge window lives at chrome-extension://<runtimeId>/peek-bridge.html
    // and holds a long-lived chrome.runtime.Port to the BG SW, acting as the
    // relay for messages that cannot be delivered cross-origin from Electron 40.
    //
    // The bridge's chrome.runtime.connect() needs the BG SW to be running, so
    // we wait for running-status-changed → "running" before spawning it —
    // otherwise the connect() reconnect-loops until the SW is ready.
    if (Array.isArray(extInfo.manifest?.externally_connectable?.matches) &&
        extInfo.manifest.externally_connectable.matches.length > 0) {
      // Do NOT block extension load — and therefore app boot / session restore,
      // which awaits loadEnabledChromeExtensions() in entry.ts — on the BG
      // service worker reaching "running". If the SW is slow or fails to start,
      // awaiting here stalls the whole boot for the full SW_TIMEOUT_MS (~10s).
      // The bridge window only needs the SW for its chrome.runtime.connect(),
      // and that isn't needed until a cross-origin runtime message actually
      // flows. Spawn the bridge off the critical path once the SW is ready (or
      // the wait times out), so a stuck SW can never delay startup.
      void _waitForServiceWorker(profileSession, ext.id, extInfo.name).then(() => {
        _spawnBridgeWindow(loaded);
      });
    }

    return loaded;
  } catch (error) {
    console.error(`[chrome-ext] Failed to load ${extInfo.id}:`, error);
    return null;
  }
}

/**
 * Spawn (or reuse) the hidden bridge BrowserWindow for an extension.
 * The bridge page (peek-bridge.html) is a chrome-extension:// page that has
 * native same-extension chrome.runtime.connect() to the BG SW, which is used
 * to relay messages forwarded from the main process.
 */
function _spawnBridgeWindow(loaded: LoadedChromeExtension): void {
  const runtimeId = loaded.electronExtension.id;

  // Don't duplicate if already alive.
  const existing = _bridgeWindows.get(runtimeId);
  if (existing && !existing.isDestroyed()) {
    DEBUG && console.log(`[chrome-ext] bridge window already alive for ${runtimeId}`);
    return;
  }

  const bridgeUrl = `chrome-extension://${runtimeId}/peek-bridge.html`;
  const profileSession = getProfileSession();
  const preloadPath = getBridgePreloadPath();

  console.log(`[chrome-ext] spawning bridge window for ${loaded.name} (${runtimeId})`);

  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      session: profileSession,
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox:true — a sandboxed preload still has contextBridge + electron's
      // ipcRenderer (the only thing peek-bridge-preload.cjs requires), and it
      // avoids the Electron 43 `sandbox_bundle` init crash ("Cannot destructure
      // property 'preloadScripts' of 'binding.startupData' as it is null") that a
      // sandbox:false chrome-extension renderer hits — which silently aborts the
      // preload, leaving window.peekBridge undefined and the whole Proton relay
      // (autofill LOAD_CONTENT_SCRIPT → SW → scripting) dead. This was the last
      // remaining sandbox:false path 802aaa37 assumed was gone.
      sandbox: true,
    },
  });

  // Every window registers with the window-state machine (design §7) — class
  // 'bridge' (a hidden infrastructure satellite; never front, no Esc
  // interceptor, no registry payload so it stays invisible to the
  // session-save/window-manager accessors).
  registerWindowWithMachine({
    kind: 'browser',
    role: 'utility',
    class: 'bridge',
    satellite: isSatelliteRegistration('utility', { windowClass: 'bridge' }),
    ...deriveWindowSurface({}),
    win,
    contentWC: win.webContents,
    attachEscHandler: false,
  });

  _bridgeWindows.set(runtimeId, win);
  // Keep runtime-external.js in sync so it can route via this window.
  setBridgeWindowsRegistry(_bridgeWindows);

  win.on('closed', () => {
    _bridgeWindows.delete(runtimeId);
    setBridgeWindowsRegistry(_bridgeWindows);
    console.log(`[chrome-ext] bridge window closed for ${runtimeId}`);
  });

  // Forward bridge window console output to main stderr in all modes —
  // bridge errors are critical for diagnosing auth-ext failures.
  win.webContents.on('console-message', (event) => {
    try {
      const e = event as unknown as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
      const msg = String(e.message ?? '');
      if (msg.includes('peek:bridge') || msg.includes('peek:auth-ext')) {
        console.error(`[bridge:${runtimeId.slice(0, 8)}:${String(e.level)}] ${msg}`);
      }
    } catch { /* logging must never throw */ }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[chrome-ext] bridge window render-process-gone for ${runtimeId}:`, details);
    _bridgeWindows.delete(runtimeId);
    setBridgeWindowsRegistry(_bridgeWindows);
  });

  win.loadURL(bridgeUrl).catch(err => {
    console.error(`[chrome-ext] bridge window failed to load ${bridgeUrl}:`, err && err.message);
    if (!win.isDestroyed()) destroyWindowViaMachine(win);
  });

  // After the bridge page is ready, inject the extension's ISOLATED-world
  // content scripts so they run as singleton listeners on behalf of any page
  // whose URL matches their `matches` patterns. The bridge is a chrome-extension
  // origin window, so executeJavaScript runs in a context where chrome.runtime
  // is the extension's real runtime — same-extension messaging from these
  // scripts works natively, no shims.
  win.webContents.once('did-finish-load', () => {
    const scripts = getIsolatedContentScriptsForExtension(loaded.id);
    for (const s of scripts) {
      let src: string;
      try {
        src = fs.readFileSync(s.scriptPath, 'utf-8');
      } catch (err) {
        console.error(`[chrome-ext] failed to read ISOLATED content script ${s.scriptPath}:`, err);
        continue;
      }
      win.webContents.executeJavaScript(src).then(
        () => DEBUG && console.log(`[chrome-ext] bridge ${runtimeId}: injected ISOLATED content script ${path.basename(s.scriptPath)}`),
        (err) => console.error(`[chrome-ext] bridge ${runtimeId}: failed injecting ${path.basename(s.scriptPath)}:`, err && err.message),
      );
    }
  });

  DEBUG && console.log(`[chrome-ext] bridge window spawned for ${loaded.name} at ${bridgeUrl}`);
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
    // Close the bridge window for this extension before removing it.
    const runtimeId = loaded.electronExtension.id;
    const bridgeWin = _bridgeWindows.get(runtimeId);
    if (bridgeWin && !bridgeWin.isDestroyed()) {
      destroyWindowViaMachine(bridgeWin);
    }
    _bridgeWindows.delete(runtimeId);
    setBridgeWindowsRegistry(_bridgeWindows);

    // Use profile-specific session for isolation
    const profileSession = getProfileSession();
    await profileSession.removeExtension(runtimeId);
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
      // Lets the runtime-external IPC handler reject non-canonical platform
      // IDs from fan-out requests — Chrome's native behavior. See
      // getCanonicalChromeIdForOrigin doc for why this is necessary.
      getCanonicalChromeIdForOrigin: (origin: string) => getCanonicalChromeIdForOrigin(origin),
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
 * Match-pattern test against the manifest "matches" grammar — returns true if
 * any pattern in `patterns` accepts `url`. Convenience wrapper.
 */
function urlMatchesAny(url: URL, patterns: string[] | undefined): boolean {
  if (!Array.isArray(patterns)) return false;
  for (const p of patterns) {
    const tester = matchPatternToTester(p);
    if (tester && tester(url)) return true;
  }
  return false;
}

/**
 * Result entry for {@link getMatchingMainWorldContentScripts}.
 */
export interface MainWorldContentScriptInjection {
  extId: string;
  /** Absolute path to the .js file on disk. */
  scriptPath: string;
  /** Source of the script (read at injection time by caller to keep this sync). */
  runAt: 'document_start' | 'document_end' | 'document_idle';
}

/**
 * Returns the set of content_scripts (declared `world: "MAIN"`) whose `matches`
 * pattern accepts `url`, for all currently-loaded extensions.
 *
 * Electron's `session.loadExtension()` auto-injects ISOLATED-world
 * content_scripts (the default) but does NOT auto-inject MAIN-world scripts.
 * This function exposes the MAIN-world scripts so the lifecycle hook in
 * entry.ts can inject them via `webContents.executeJavaScript()`.
 *
 * ISOLATED-world scripts are excluded here because Electron handles them
 * natively — they get a proper isolated context with the extension's own
 * `chrome.runtime`. The critical requirement is that the extension must be
 * loaded on the session BEFORE webContents navigate to matching URLs;
 * entry.ts awaits `loadEnabledChromeExtensions()` before session restore
 * to ensure this ordering.
 */
export function getMatchingMainWorldContentScripts(url: string): MainWorldContentScriptInjection[] {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return []; }

  const out: MainWorldContentScriptInjection[] = [];
  for (const [extId, info] of discoveredExtensions) {
    const loaded = loadedExtensions.get(extId);
    if (!loaded) continue;
    const scripts = info.manifest?.content_scripts;
    if (!Array.isArray(scripts)) continue;

    for (const entry of scripts) {
      if (entry.world !== 'MAIN') continue; // ISOLATED handled elsewhere
      if (!urlMatchesAny(parsed, entry.matches)) continue;
      if (urlMatchesAny(parsed, (entry as { exclude_matches?: string[] }).exclude_matches)) continue;
      if (!Array.isArray(entry.js)) continue;

      const runAtRaw = entry.run_at ?? 'document_idle';
      const runAt: MainWorldContentScriptInjection['runAt'] =
        runAtRaw === 'document_start' || runAtRaw === 'document_end' ? runAtRaw : 'document_idle';

      for (const js of entry.js) {
        out.push({
          extId,
          scriptPath: path.join(loaded.path, js),
          runAt,
        });
      }
    }
  }
  return out;
}

/**
 * Result entry for {@link getMatchingIsolatedContentScripts}.
 */
export interface IsolatedContentScriptMatch {
  /** Internal extension ID (directory name). */
  extId: string;
  /** Runtime extension ID (Electron-assigned, e.g. chrome.runtime.id value). */
  runtimeExtId: string;
}

/**
 * Returns extensions whose ISOLATED-world content_scripts accept `url`. Used by
 * the page-side preload to decide whether window.postMessage events from this
 * origin should be relayed to the extension's bridge window (where the
 * ISOLATED scripts are hosted as singleton listeners with the extension's real
 * chrome.runtime). Only returns extensions that are loaded AND have a live
 * bridge window — caller doesn't need to recheck.
 */
export function getMatchingIsolatedContentScripts(url: string): IsolatedContentScriptMatch[] {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return []; }

  const out: IsolatedContentScriptMatch[] = [];
  for (const [extId, info] of discoveredExtensions) {
    const loaded = loadedExtensions.get(extId);
    if (!loaded) continue;
    const bridge = _bridgeWindows.get(loaded.electronExtension.id);
    if (!bridge || bridge.isDestroyed()) continue;
    const scripts = info.manifest?.content_scripts;
    if (!Array.isArray(scripts)) continue;

    for (const entry of scripts) {
      if (entry.world === 'MAIN') continue; // MAIN handled by direct page injection
      if (!urlMatchesAny(parsed, entry.matches)) continue;
      if (urlMatchesAny(parsed, (entry as { exclude_matches?: string[] }).exclude_matches)) continue;
      if (!Array.isArray(entry.js) || entry.js.length === 0) continue;
      out.push({ extId, runtimeExtId: loaded.electronExtension.id });
      break; // dedupe per extension; one match is enough to enable relay
    }
  }
  return out;
}

/**
 * Returns absolute paths of an extension's ISOLATED-world content_scripts —
 * the scripts to inject into the bridge BrowserWindow at load time so they
 * can act as singleton listeners on behalf of all pages whose URL matches
 * their `matches` patterns. The bridge is a chrome-extension:// origin window,
 * so injecting via executeJavaScript gives these scripts the extension's
 * native chrome.runtime (same-extension messaging works without shims).
 */
export function getIsolatedContentScriptsForExtension(extId: string): { scriptPath: string }[] {
  const loaded = loadedExtensions.get(extId);
  if (!loaded) return [];
  const info = discoveredExtensions.get(extId);
  if (!info) return [];
  const scripts = info.manifest?.content_scripts;
  if (!Array.isArray(scripts)) return [];

  const out: { scriptPath: string }[] = [];
  const seen = new Set<string>();
  for (const entry of scripts) {
    if (entry.world === 'MAIN') continue;
    if (!Array.isArray(entry.js)) continue;
    for (const js of entry.js) {
      const full = path.join(loaded.path, js);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ scriptPath: full });
    }
  }
  return out;
}

/**
 * Returns the CANONICAL Chrome extension ID of the extension whose
 * externally_connectable.matches accepts `origin`, or null if none.
 *
 * The canonical ID is what Chrome derives from the extension's CRX
 * signed_header_data (Web Store ID). Pages targeting an extension via
 * `chrome.runtime.sendMessage(<id>, msg)` use this hardcoded id, so the
 * compat layer uses it to filter fan-out requests: pages like
 * account.proton.me try 4 platform-specific extension IDs in parallel
 * (Chrome/Firefox/Edge/Safari) and accept the first responder. Chrome
 * itself rejects requests to non-installed IDs as "no such extension" so
 * only one wins. Our origin-fallback path needs the same filter — without
 * it, all 4 requests fan out to the same loaded extension and corrupt
 * single-use state (e.g. auth selectors).
 *
 * Returns null when the extension was loaded without a canonical id sidecar
 * entry (e.g. manually-dropped extensions); callers should fall back to
 * accepting any matching origin in that case.
 */
export function getCanonicalChromeIdForOrigin(origin: string): string | null {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return null; }
  for (const [extId, info] of discoveredExtensions) {
    if (!loadedExtensions.has(extId)) continue;
    const matches = info.manifest?.externally_connectable?.matches;
    if (!Array.isArray(matches)) continue;
    if (urlMatchesAny(parsed, matches)) {
      return info.canonicalChromeId ?? null;
    }
  }
  return null;
}

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

  // Reuse existing window if it's still open. Surface it through the machine
  // (an ACTIVATING show — reuse means "bring it to me", so activate:true,
  // same as the ipc.ts key/url-reuse shows), never a direct `.focus()` on the
  // Electron handle: a raw focus is a restack the window-state machine never
  // sees, so `front`/stacking would go stale.
  const existing = extensionUiWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    const existingId = getWindowIdFor(existing);
    if (existingId != null) {
      shadowKernelShowRequested(existingId, true);
    }
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

  // PEEK_AUTOOPEN_EXT mode: open without stealing focus so the dev iteration
  // loop can rebuild + relaunch in the background while the user keeps
  // working in their editor / terminal. Use show:false here and call
  // showInactive() after load (below).
  const inDevAutoopen = !!process.env.PEEK_AUTOOPEN_EXT;
  const win = new BrowserWindow({
    width: entry.width,
    height: entry.height,
    title: entry.title,
    show: !isHeadless() && !inDevAutoopen,
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

  // Every window registers with the window-state machine (design §7) — class
  // 'extension-ui'. Deliberately NOT a satellite: an extension popup is a
  // real user-facing window, so it stays front-eligible (a focused popup is
  // the command target). escapeMode 'ignore' + no main-side Esc interceptor:
  // Esc keeps reaching the extension page's own DOM, exactly as it did when
  // these windows were unregistered.
  registerWindowWithMachine({
    kind: 'browser',
    role: 'content',
    class: 'extension-ui',
    satellite: false,
    escapeMode: 'ignore',
    ...deriveWindowSurface({}),
    win,
    contentWC: win.webContents,
    attachEscHandler: false,
  });

  // Track the window
  extensionUiWindows.set(windowKey, win);

  win.on('closed', () => {
    extensionUiWindows.delete(windowKey);
    DEBUG && console.log(`[chrome-ext] UI window closed: ${windowKey}`);
  });

  // Always forward extension UI console errors/warnings + render-process
  // crashes to main stderr — these surfaces have no other diagnostic path
  // (Electron's native extension popup doesn't expose devtools through our
  // Cmd+Option+I bridge), so a black popup leaves no trace otherwise.
  // Info/log levels still gated on DEBUG to keep the stream usable.
  win.webContents.on('console-message', (event) => {
    try {
      const e = event as unknown as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown };
      const level = String(e.level);
      const isErrorish = level === 'error' || level === 'warning' || level === 'warn';
      if (isErrorish || DEBUG) {
        console.log(`[ext-popup:${windowKey}:${level}] ${String(e.message)} (${String(e.sourceId)}:${String(e.lineNumber)})`);
      }
    } catch {
      /* logging must never throw */
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[ext-popup:${windowKey}] render-process-gone:`, details);
  });

  // PEEK_AUTOOPEN_EXT mode: show inactive (no focus steal) and open detached
  // devtools so the dev iteration loop can inspect the extension UI without
  // pulling focus away from the terminal/editor on each nodemon restart.
  if (inDevAutoopen && !isHeadless()) {
    win.webContents.once('did-finish-load', () => {
      // Show without stealing focus, through the machine (SHOW_WINDOW with
      // activate:false; this whole block is already !isHeadless()-gated
      // above, so the dev autoopen never fires in a headless run).
      try {
        const id = getWindowIdFor(win);
        if (id != null) {
          shadowKernelShowRequested(id, false);
        }
      } catch { /* ignore */ }
      try { win.webContents.openDevTools({ mode: 'detach', activate: false }); } catch { /* ignore */ }
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
      destroyWindowViaMachine(win);
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
  for (const [, win] of extensionUiWindows) {
    if (!win.isDestroyed()) {
      destroyWindowViaMachine(win);
    }
  }
  extensionUiWindows.clear();

  // Close all bridge windows
  for (const [, win] of _bridgeWindows) {
    if (!win.isDestroyed()) {
      destroyWindowViaMachine(win);
    }
  }
  _bridgeWindows.clear();
  setBridgeWindowsRegistry(_bridgeWindows);

  for (const extId of loadedExtensions.keys()) {
    await unloadExtension(extId);
  }

  discoveredExtensions.clear();
  loadedExtensions.clear();
  extensionsDir = null;
}


/**
 * Synchronously destroy the chrome-extension infrastructure windows — the
 * hidden bridge windows (peek-bridge.html, which hold a live chrome.runtime
 * Port to the BG SW and relay structured-clone messages) and any open
 * extension UI windows.
 *
 * Why a separate sync entry point: the full async `cleanupChromeExtensions()`
 * only runs from `onQuit`, which is BYPASSED when something calls `app.quit()`
 * directly (e.g. tests' app.close(), or any quit not routed through Peek's quit
 * shortcut). In that path the bridge window is left to close via the native
 * quit teardown (`-[NSWindow __close]`) WITH an in-flight relay message →
 * EXC_BAD_ACCESS in the main process (peek d1cf0b9a). `destroy()` (used here,
 * same as cleanupChromeExtensions) is the forceful teardown that severs the
 * port/messaging immediately and skips the crashing performClose path. Call
 * from `before-quit` so these windows are gone before the native quit closes
 * the rest. Idempotent: cleanupChromeExtensions guards on isDestroyed() and the
 * maps are cleared here, so a later cleanup call is a no-op.
 */
export function destroyChromeExtensionWindowsForShutdown(): void {
  // `destroyWindowViaMachine` stays SYNCHRONOUS end-to-end (dispatch → effect
  // → backend.destroyWindow → win.destroy()), which is what this before-quit
  // path depends on.
  for (const [, win] of extensionUiWindows) {
    if (!win.isDestroyed()) destroyWindowViaMachine(win);
  }
  extensionUiWindows.clear();
  for (const [, win] of _bridgeWindows) {
    if (!win.isDestroyed()) destroyWindowViaMachine(win);
  }
  _bridgeWindows.clear();
  setBridgeWindowsRegistry(_bridgeWindows);
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
