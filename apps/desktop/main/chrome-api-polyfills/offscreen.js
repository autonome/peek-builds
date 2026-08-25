/**
 * chrome.offscreen Polyfill for Electron
 *
 * Implements the Chrome Offscreen Documents API using hidden BrowserWindows.
 * Offscreen documents are used by extensions for tasks that need DOM access
 * without showing UI (clipboard operations, audio playback, DOM parsing, etc).
 *
 * Each extension can have at most one offscreen document at a time (matching
 * Chrome's behavior).
 *
 * @module offscreen
 * @see https://developer.chrome.com/docs/extensions/reference/api/offscreen
 */

import { channel, registerHandler, removeHandler } from './_ipc-bridge.js';
// Window-state machine (design §7): every window this module creates registers
// at construction and tears down via WINDOW_DESTROY_REQUESTED, mirroring
// chrome-extensions.ts `_spawnBridgeWindow` / `destroyWindowViaMachine`. These
// relative paths resolve in dist/ (the polyfills are copied next to the
// compiled main modules by the build's `cp -r` step).
import { registerWindowWithMachine, getWindowIdFor } from '../window-machine.js';
import { deriveWindowSurface, isSatelliteRegistration } from '../izui-roles.js';
import { kernelDestroyWindow } from '../window-kernel-dispatch.js';

const API = 'offscreen';
const DEBUG = !!process.env.DEBUG;

/**
 * Valid reasons for creating offscreen documents (Chrome spec).
 * @type {Object<string, string>}
 */
const Reason = {
  TESTING: 'TESTING',
  AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
  BLOBS: 'BLOBS',
  CLIPBOARD: 'CLIPBOARD',
  DOM_PARSER: 'DOM_PARSER',
  DOM_SCRAPING: 'DOM_SCRAPING',
  GEOLOCATION: 'GEOLOCATION',
  LOCAL_STORAGE: 'LOCAL_STORAGE',
  MATCH_MEDIA: 'MATCH_MEDIA',
  WORKERS: 'WORKERS',
  USER_MEDIA: 'USER_MEDIA',
  DISPLAY_MEDIA: 'DISPLAY_MEDIA',
  WEB_RTC: 'WEB_RTC',
  IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
};

/**
 * Active offscreen documents per extension.
 * Key: extensionId, Value: { window: BrowserWindow, url: string }
 * @type {Map<string, { window: import('electron').BrowserWindow, url: string }>}
 */
const offscreenDocs = new Map();

/** @type {import('electron').Session|null} */
let _session = null;

/**
 * Get the extension ID from an IPC event.
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {string}
 */
function getExtensionId(event) {
  const url = event.sender.getURL();
  const match = url.match(/^chrome-extension:\/\/([^/]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Route an offscreen-document window teardown through the window-state machine
 * (WINDOW_DESTROY_REQUESTED → DESTROY_WINDOW → backend.destroyWindow,
 * synchronous). Mirrors `destroyWindowViaMachine` in chrome-extensions.ts:
 * every window this module creates registers at construction, so the id always
 * resolves; a window the machine no longer knows is already gone.
 * @param {import('electron').BrowserWindow} win
 */
function destroyWindowViaMachine(win) {
  const id = getWindowIdFor(win);
  if (id == null) return; // never registered / already retired — nothing to destroy
  kernelDestroyWindow(id);
}

/**
 * Create an offscreen document for an extension.
 * @param {string} extensionId
 * @param {Object} params
 * @param {string} params.url — URL relative to extension root
 * @param {string[]} params.reasons — Reasons for the document
 * @param {string} params.justification — Developer justification
 * @returns {Promise<void>}
 */
async function createDocument(extensionId, params) {
  if (offscreenDocs.has(extensionId)) {
    throw new Error(`Only a single offscreen document may be created for extension "${extensionId}".`);
  }

  let BrowserWindow;
  try {
    const electron = globalThis.require ? globalThis.require('electron') : null;
    BrowserWindow = electron ? electron.BrowserWindow : null;
  } catch {
    BrowserWindow = null;
  }

  if (!BrowserWindow) {
    throw new Error('BrowserWindow not available — chrome.offscreen requires Electron main process');
  }

  // Build the full extension URL
  // Extension URLs follow the pattern: chrome-extension://[id]/[path]
  const extensionUrl = `chrome-extension://${extensionId}/${params.url.replace(/^\//, '')}`;

  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      session: _session,
      nodeIntegration: false,
      contextIsolation: true,
      // sandbox:true — an offscreen document is a chrome-extension page; its
      // extension APIs (chrome.*) are provided by Electron's extension system,
      // not by the sandbox setting, and it has no custom preload needing Node.
      // sandbox:false here would also hit the Electron 43 `sandbox_bundle` init
      // crash (see chrome-extensions.ts bridge window) and is now forbidden by
      // main/sandbox-enforcement.ts.
      sandbox: true,
    },
  });

  // Every window registers with the window-state machine (design §7) — class
  // 'offscreen' (a hidden infrastructure satellite exactly like 'bridge':
  // never front, no Esc interceptor, no registry payload so it stays invisible
  // to the session-save/window-manager accessors).
  registerWindowWithMachine({
    kind: 'browser',
    role: 'utility',
    class: 'offscreen',
    satellite: isSatelliteRegistration('utility', { windowClass: 'offscreen' }),
    ...deriveWindowSurface({}),
    win,
    contentWC: win.webContents,
    attachEscHandler: false,
  });

  offscreenDocs.set(extensionId, { window: win, url: params.url });

  win.on('closed', () => {
    offscreenDocs.delete(extensionId);
  });

  try {
    await win.loadURL(extensionUrl);
    DEBUG && console.log(`[chrome-polyfill:offscreen] Created document for ext ${extensionId}: ${params.url}`);
  } catch (err) {
    // Clean up on load failure
    offscreenDocs.delete(extensionId);
    if (!win.isDestroyed()) destroyWindowViaMachine(win);
    throw err;
  }
}

/**
 * Close an extension's offscreen document.
 * @param {string} extensionId
 */
function closeDocument(extensionId) {
  const doc = offscreenDocs.get(extensionId);
  if (!doc) return;

  if (!doc.window.isDestroyed()) {
    destroyWindowViaMachine(doc.window);
  }
  offscreenDocs.delete(extensionId);
  DEBUG && console.log(`[chrome-polyfill:offscreen] Closed document for ext ${extensionId}`);
}

/**
 * Check if an extension has an active offscreen document.
 * @param {string} extensionId
 * @returns {boolean}
 */
function hasDocument(extensionId) {
  const doc = offscreenDocs.get(extensionId);
  if (!doc) return false;
  // Clean up stale entries
  if (doc.window.isDestroyed()) {
    offscreenDocs.delete(extensionId);
    return false;
  }
  return true;
}

// --- Public API ---

/**
 * Set up main-process IPC handlers for chrome.offscreen.
 *
 * @param {import('electron').Session} session — The session to bind to
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain — Electron's ipcMain module
 * @returns {{ cleanup: () => void, _docs: Map }}
 */
export function setupMainProcess(session, { ipcMain }) {
  _session = session;

  registerHandler(ipcMain, API, 'createDocument', async (event, params) => {
    const extId = getExtensionId(event);
    await createDocument(extId, params);
  });

  registerHandler(ipcMain, API, 'closeDocument', (event) => {
    const extId = getExtensionId(event);
    closeDocument(extId);
  });

  registerHandler(ipcMain, API, 'hasDocument', (event) => {
    const extId = getExtensionId(event);
    return hasDocument(extId);
  });

  return {
    cleanup() {
      removeHandler(ipcMain, API, 'createDocument');
      removeHandler(ipcMain, API, 'closeDocument');
      removeHandler(ipcMain, API, 'hasDocument');
      // Close all offscreen documents
      for (const [, doc] of offscreenDocs) {
        if (!doc.window.isDestroyed()) {
          destroyWindowViaMachine(doc.window);
        }
      }
      offscreenDocs.clear();
      _session = null;
    },
    /** @internal — exposed for testing */
    _docs: offscreenDocs,
  };
}

/**
 * Get the JavaScript source code to inject into extension contexts.
 * Creates a `chrome.offscreen` API object.
 *
 * @returns {string} JavaScript source to execute in the extension context
 */
export function getPreloadScript() {
  const ch = (method) => channel(API, method);

  // Build Reason enum as JS
  const reasonEntries = Object.entries(Reason)
    .map(([k, v]) => `    ${k}: '${v}'`)
    .join(',\n');

  return `
(function() {
  // Skip if chrome.offscreen already exists natively
  if (typeof chrome !== 'undefined' && chrome.offscreen) return;

  const _ipc = (typeof electron !== 'undefined' && electron.ipcRenderer) ? electron.ipcRenderer : null;

  const offscreen = {
    Reason: {
${reasonEntries}
    },

    async createDocument(parameters) {
      if (!_ipc) return;
      return _ipc.invoke('${ch('createDocument')}', parameters);
    },

    async closeDocument() {
      if (!_ipc) return;
      return _ipc.invoke('${ch('closeDocument')}');
    },

    async hasDocument() {
      if (!_ipc) return false;
      return _ipc.invoke('${ch('hasDocument')}');
    },
  };

  // Inject into chrome namespace
  if (typeof chrome !== 'undefined') {
    chrome.offscreen = offscreen;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.offscreen = offscreen;
  }
})();
`;
}
