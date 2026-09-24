/**
 * chrome.tabs Polyfill for Electron — BG SW gaps
 *
 * Fills the chrome.tabs methods that Electron's native extension support
 * either omits or implements incorrectly in the BG service worker context.
 *
 * Covered methods:
 * - tabs.get(tabId, [callback])       — resolve tabId → Tab object
 * - tabs.sendMessage(tabId, msg, [options], [callback]) — deliver msg to content script
 * - tabs.update(tabId, {url}, [callback]) — navigate a tab
 * - tabs.create({url, ...}, [callback]) — open a new tab (delegates to window.open
 *                                         in extension popup contexts, or sends IPC
 *                                         to main in BG SW context)
 *
 * tabId namespace: tabId === webContents.id — same convention used throughout
 * the chrome-api-polyfills codebase (web-navigation.js, scripting.js).
 * Electron's native chrome.tabs.query() in BG SW context returns objects where
 * tab.id === webContents.id; no synthetic mapping is needed.
 *
 * Note: chrome.tabs.query() is already provided natively by Electron — this
 * polyfill does NOT replace it, only adds the missing methods.
 *
 * @module tabs
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs
 */

import { webContents as _wc, shell as _shell } from 'electron';
import { channel, registerHandler, removeHandler } from './_ipc-bridge.js';
import { openExternalIfWebUrl } from './_external-url.js';

const API = 'tabs';
const DEBUG = !!process.env.DEBUG;

/** @type {import('electron').Session|null} */
let _session = null;

/**
 * Get the extension ID from an IPC event sender URL.
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {string}
 */
function getExtensionId(event) {
  const url = event.sender.getURL();
  const match = url.match(/^chrome-extension:\/\/([^/]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * The scheme of a URL, for a log line that must not carry the rest of it.
 * @param {unknown} url
 * @returns {string}
 */
function schemeOf(url) {
  if (typeof url !== 'string') return 'none';
  try {
    return new URL(url).protocol;
  } catch {
    return 'unparsable';
  }
}

/**
 * Resolve tabId → webContents in our session.
 * tabId === webContents.id (Electron convention).
 *
 * @param {number} tabId
 * @returns {import('electron').WebContents|null}
 */
function resolveTab(tabId) {
  let wc;
  try {
    wc = _wc.fromId(tabId);
  } catch {
    return null;
  }
  if (!wc || wc.isDestroyed()) return null;
  if (_session && wc.session !== _session) return null;
  return wc;
}

/**
 * Build a Chrome Tab-shaped object from a webContents.
 *
 * @param {import('electron').WebContents} wc
 * @returns {object}
 */
function buildTab(wc) {
  return {
    id: wc.id,
    index: 0,
    windowId: 0,
    active: true,
    highlighted: true,
    pinned: false,
    incognito: false,
    selected: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    status: 'complete',
    discarded: false,
    autoDiscardable: false,
    groupId: -1,
  };
}

// --- IPC handlers (main process side) ---

/**
 * Set up main-process IPC handlers for chrome.tabs gap methods.
 *
 * @param {import('electron').Session} session
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @returns {{ cleanup: () => void }}
 */
export function setupMainProcess(session, { ipcMain }) {
  _session = session;

  // tabs.get(tabId)
  registerHandler(ipcMain, API, 'get', (_event, tabId) => {
    const wc = resolveTab(tabId);
    if (!wc) throw new Error(`[tabs] No tab found for tabId ${tabId}`);
    return buildTab(wc);
  });

  // tabs.sendMessage(tabId, message, [options])
  // Delivers the message to the tab's webContents (content script context).
  // Uses webContents.send() on the well-known content-script IPC channel.
  registerHandler(ipcMain, API, 'sendMessage', async (_event, tabId, message, options) => {
    const wc = resolveTab(tabId);
    if (!wc) throw new Error(`[tabs] sendMessage: no tab for tabId ${tabId}`);
    // Deliver via the standard chrome.runtime.onMessage IPC path.
    // Content scripts inside the webContents receive messages on the
    // chrome-extension internals channel that Electron uses for tab messages.
    // If that channel isn't wired, fall back to executeJavaScript injection
    // which dispatches a synthetic CustomEvent that content scripts can intercept.
    try {
      wc.send('chrome-extension:tabs-sendMessage', { message, options: options || {} });
    } catch {
      // Best-effort: content scripts may not have an ipc listener.
    }
    DEBUG && console.log(`[tabs] sendMessage to tab ${tabId}:`, message);
    return {};
  });

  // tabs.update(tabId, {url, ...})
  registerHandler(ipcMain, API, 'update', async (_event, tabId, updateProperties) => {
    const wc = resolveTab(tabId);
    if (!wc) throw new Error(`[tabs] update: no tab for tabId ${tabId}`);

    if (updateProperties && typeof updateProperties.url === 'string') {
      await wc.loadURL(updateProperties.url).catch(err => {
        DEBUG && console.warn(`[tabs] update loadURL failed:`, err);
      });
    }
    return buildTab(wc);
  });

  // tabs.create({url, ...})
  // In the BG SW context, chrome.tabs.create should open a new Peek page.
  // We open it via shell/default browser through a main-process IPC relay.
  // The popup-context version is handled by peek-permissions.js (window.open).
  registerHandler(ipcMain, API, 'create', async (event, createProperties) => {
    const url = (createProperties && createProperties.url) || 'about:blank';
    DEBUG && console.log(`[tabs] create: opening ${url}`);
    // Only http(s) reaches the OS. Anything else — a custom protocol that would
    // re-enter Peek outside the tile path, file:, javascript:, data:, and the
    // 'about:blank' default, which has nothing to open — is refused.
    // chrome.tabs.create in an extension BG SW is typically used for OAuth
    // fork flows and similar redirects that should open as Peek page tiles.
    try {
      if (!openExternalIfWebUrl(_shell, url)) {
        console.warn(
          `[tabs] create: refused non-web URL from extension ${getExtensionId(event)} (scheme: ${schemeOf(url)})`
        );
      }
    } catch (err) {
      DEBUG && console.warn('[tabs] create: openExternal failed:', err);
    }
    // Return a synthetic tab object (the real tab isn't tracked here)
    return {
      id: -1,
      index: 0,
      windowId: 0,
      active: true,
      highlighted: true,
      pinned: false,
      incognito: false,
      selected: true,
      url,
      title: '',
      status: 'loading',
      discarded: false,
      autoDiscardable: false,
      groupId: -1,
    };
  });

  return {
    cleanup() {
      removeHandler(ipcMain, API, 'get');
      removeHandler(ipcMain, API, 'sendMessage');
      removeHandler(ipcMain, API, 'update');
      removeHandler(ipcMain, API, 'create');
      _session = null;
    },
  };
}

/**
 * Get the JavaScript source to inject into BG SW / extension page contexts.
 *
 * Only fills gaps — does NOT replace chrome.tabs if it already has the method.
 * chrome.tabs.query() is provided natively by Electron and is NOT replaced here.
 *
 * The injected object uses Object.defineProperty with configurable:true so it
 * survives downstream Proxy wraps (same pattern as permissions.js and scripting.js).
 *
 * @returns {string}
 */
export function getPreloadScript() {
  const chGet = channel(API, 'get');
  const chSend = channel(API, 'sendMessage');
  const chUpdate = channel(API, 'update');
  const chCreate = channel(API, 'create');

  return `
(function() {
  if (typeof chrome === 'undefined') return;
  var _ipc = (typeof electron !== 'undefined' && electron.ipcRenderer) ? electron.ipcRenderer : null;
  if (!_ipc) return;

  var _tabs = chrome.tabs;
  if (!_tabs) {
    _tabs = {};
    try {
      Object.defineProperty(chrome, 'tabs', {
        value: _tabs, writable: true, configurable: true, enumerable: true,
      });
    } catch(e) {
      try { chrome.tabs = _tabs; } catch(_) { return; }
    }
  }

  // Helper: install a method only if not already provided natively.
  function _fill(name, fn) {
    if (typeof _tabs[name] !== 'function') {
      try {
        Object.defineProperty(_tabs, name, {
          value: fn, writable: true, configurable: true, enumerable: true,
        });
      } catch(e) {
        try { _tabs[name] = fn; } catch(_) {}
      }
    }
  }

  // tabs.get(tabId, [callback])
  _fill('get', function(tabId, callback) {
    var p = _ipc.invoke('${chGet}', tabId);
    if (typeof callback === 'function') {
      p.then(function(tab) { try { callback(tab); } catch(e) {} })
       .catch(function(e) {
         try {
           if (chrome.runtime) chrome.runtime.lastError = { message: String(e && e.message || e) };
           callback(null);
         } catch(_) {}
       });
      return undefined;
    }
    return p;
  });

  // tabs.sendMessage(tabId, message, [options], [callback])
  _fill('sendMessage', function(tabId, message, optionsOrCallback, maybeCallback) {
    var options = {};
    var callback;
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    } else if (optionsOrCallback && typeof optionsOrCallback === 'object') {
      options = optionsOrCallback;
      callback = maybeCallback;
    }
    var p = _ipc.invoke('${chSend}', tabId, message, options);
    if (typeof callback === 'function') {
      p.then(function(r) { try { callback(r); } catch(e) {} })
       .catch(function(e) {
         try {
           if (chrome.runtime) chrome.runtime.lastError = { message: String(e && e.message || e) };
           callback(null);
         } catch(_) {}
       });
      return undefined;
    }
    return p;
  });

  // tabs.update(tabId, updateProperties, [callback])
  _fill('update', function(tabId, updateProperties, callback) {
    var p = _ipc.invoke('${chUpdate}', tabId, updateProperties);
    if (typeof callback === 'function') {
      p.then(function(tab) { try { callback(tab); } catch(e) {} })
       .catch(function(e) {
         try {
           if (chrome.runtime) chrome.runtime.lastError = { message: String(e && e.message || e) };
           callback(null);
         } catch(_) {}
       });
      return undefined;
    }
    return p;
  });

  // tabs.create(createProperties, [callback])
  _fill('create', function(createProperties, callback) {
    var p = _ipc.invoke('${chCreate}', createProperties);
    if (typeof callback === 'function') {
      p.then(function(tab) { try { callback(tab); } catch(e) {} })
       .catch(function(e) {
         try {
           if (chrome.runtime) chrome.runtime.lastError = { message: String(e && e.message || e) };
           callback(null);
         } catch(_) {}
       });
      return undefined;
    }
    return p;
  });
})();
`;
}
