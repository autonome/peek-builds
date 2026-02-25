/**
 * chrome.storage.session Polyfill for Electron
 *
 * Implements the chrome.storage.session API using an in-memory Map in the
 * main process. Data is scoped per extension and cleared when the app quits
 * (matching Chrome's behavior where session storage is cleared on browser exit).
 *
 * This complements Electron's built-in chrome.storage.local support.
 *
 * @module storage-session
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage#property-session
 */

import { createChromeEvent } from './_event-emitter.js';
import { channel, registerHandler, removeHandler, broadcastToExtensions } from './_ipc-bridge.js';

const API = 'storage.session';
const DEBUG = !!process.env.DEBUG;

/**
 * In-memory storage per extension.
 * Outer key: extensionId, inner key: storage key.
 * @type {Map<string, Map<string, *>>}
 */
const stores = new Map();

/** @type {ReturnType<typeof createChromeEvent>} */
const onChangedEvent = createChromeEvent();

/** @type {import('electron').Session|null} */
let _session = null;

/**
 * Chrome storage quota for session storage (10 MB).
 * @type {number}
 */
const QUOTA_BYTES = 10 * 1024 * 1024;

/**
 * Get or create the store for an extension.
 * @param {string} extensionId
 * @returns {Map<string, *>}
 */
function getStore(extensionId) {
  let store = stores.get(extensionId);
  if (!store) {
    store = new Map();
    stores.set(extensionId, store);
  }
  return store;
}

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
 * Compute approximate byte size of a value (for quota tracking).
 * @param {*} value
 * @returns {number}
 */
function approximateSize(value) {
  return JSON.stringify(value).length * 2; // rough UTF-16 estimate
}

/**
 * Broadcast storage change to extension contexts.
 * @param {string} extensionId
 * @param {Object<string, {oldValue?: *, newValue?: *}>} changes
 */
function notifyChanges(extensionId, changes) {
  onChangedEvent._fire(changes, 'session');

  if (_session) {
    broadcastToExtensions(
      _session,
      channel(API, 'onChanged'),
      { changes, areaName: 'session' }
    );
  }
}

/**
 * Implementation of chrome.storage.session.get().
 * @param {string} extensionId
 * @param {string|string[]|Object|null} keys
 * @returns {Object}
 */
function storageGet(extensionId, keys) {
  const store = getStore(extensionId);
  const result = {};

  if (keys === null || keys === undefined) {
    // Return all items
    for (const [k, v] of store) {
      result[k] = structuredClone(v);
    }
    return result;
  }

  if (typeof keys === 'string') {
    if (store.has(keys)) {
      result[keys] = structuredClone(store.get(keys));
    }
    return result;
  }

  if (Array.isArray(keys)) {
    for (const k of keys) {
      if (store.has(k)) {
        result[k] = structuredClone(store.get(k));
      }
    }
    return result;
  }

  // Object with default values
  if (typeof keys === 'object') {
    for (const [k, defaultValue] of Object.entries(keys)) {
      result[k] = store.has(k) ? structuredClone(store.get(k)) : defaultValue;
    }
    return result;
  }

  return result;
}

/**
 * Implementation of chrome.storage.session.set().
 * @param {string} extensionId
 * @param {Object} items
 */
function storageSet(extensionId, items) {
  const store = getStore(extensionId);
  const changes = {};

  for (const [key, value] of Object.entries(items)) {
    const oldValue = store.has(key) ? structuredClone(store.get(key)) : undefined;
    store.set(key, structuredClone(value));

    changes[key] = {};
    if (oldValue !== undefined) changes[key].oldValue = oldValue;
    changes[key].newValue = structuredClone(value);
  }

  if (Object.keys(changes).length > 0) {
    notifyChanges(extensionId, changes);
  }

  DEBUG && console.log(`[chrome-polyfill:storage.session] Set ${Object.keys(items).length} key(s) for ext ${extensionId}`);
}

/**
 * Implementation of chrome.storage.session.remove().
 * @param {string} extensionId
 * @param {string|string[]} keys
 */
function storageRemove(extensionId, keys) {
  const store = getStore(extensionId);
  const keyList = typeof keys === 'string' ? [keys] : keys;
  const changes = {};

  for (const key of keyList) {
    if (store.has(key)) {
      changes[key] = { oldValue: structuredClone(store.get(key)) };
      store.delete(key);
    }
  }

  if (Object.keys(changes).length > 0) {
    notifyChanges(extensionId, changes);
  }
}

/**
 * Implementation of chrome.storage.session.clear().
 * @param {string} extensionId
 */
function storageClear(extensionId) {
  const store = getStore(extensionId);
  const changes = {};

  for (const [key, value] of store) {
    changes[key] = { oldValue: structuredClone(value) };
  }

  store.clear();

  if (Object.keys(changes).length > 0) {
    notifyChanges(extensionId, changes);
  }

  DEBUG && console.log(`[chrome-polyfill:storage.session] Cleared storage for ext ${extensionId}`);
}

/**
 * Implementation of chrome.storage.session.getBytesInUse().
 * @param {string} extensionId
 * @param {string|string[]|null} keys
 * @returns {number}
 */
function storageGetBytesInUse(extensionId, keys) {
  const store = getStore(extensionId);

  if (keys === null || keys === undefined) {
    let total = 0;
    for (const [k, v] of store) {
      total += approximateSize(k) + approximateSize(v);
    }
    return total;
  }

  const keyList = typeof keys === 'string' ? [keys] : keys;
  let total = 0;
  for (const k of keyList) {
    if (store.has(k)) {
      total += approximateSize(k) + approximateSize(store.get(k));
    }
  }
  return total;
}

// --- Public API ---

/**
 * Set up main-process IPC handlers for chrome.storage.session.
 *
 * @param {import('electron').Session} session — The session to bind to
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain — Electron's ipcMain module
 * @returns {{ cleanup: () => void, onChanged: ReturnType<typeof createChromeEvent>, _stores: Map }}
 */
export function setupMainProcess(session, { ipcMain }) {
  _session = session;

  registerHandler(ipcMain, API, 'get', (event, keys) => {
    const extId = getExtensionId(event);
    return storageGet(extId, keys);
  });

  registerHandler(ipcMain, API, 'set', (event, items) => {
    const extId = getExtensionId(event);
    storageSet(extId, items);
  });

  registerHandler(ipcMain, API, 'remove', (event, keys) => {
    const extId = getExtensionId(event);
    storageRemove(extId, keys);
  });

  registerHandler(ipcMain, API, 'clear', (event) => {
    const extId = getExtensionId(event);
    storageClear(extId);
  });

  registerHandler(ipcMain, API, 'getBytesInUse', (event, keys) => {
    const extId = getExtensionId(event);
    return storageGetBytesInUse(extId, keys);
  });

  registerHandler(ipcMain, API, 'setAccessLevel', () => {
    // No-op in Electron — access level is always TRUSTED_CONTEXTS
    // (there is no concept of content script access restriction for session storage)
  });

  return {
    cleanup() {
      removeHandler(ipcMain, API, 'get');
      removeHandler(ipcMain, API, 'set');
      removeHandler(ipcMain, API, 'remove');
      removeHandler(ipcMain, API, 'clear');
      removeHandler(ipcMain, API, 'getBytesInUse');
      removeHandler(ipcMain, API, 'setAccessLevel');
      stores.clear();
      _session = null;
    },
    onChanged: onChangedEvent,
    /** @internal — exposed for testing */
    _stores: stores,
    /** @internal — exposed for testing */
    QUOTA_BYTES,
  };
}

/**
 * Get the JavaScript source code to inject into extension contexts.
 * Adds `chrome.storage.session` alongside Electron's built-in
 * `chrome.storage.local` and `chrome.storage.sync`.
 *
 * @returns {string} JavaScript source to execute in the extension context
 */
export function getPreloadScript() {
  const ch = (method) => channel(API, method);

  return `
(function() {
  const _onChangedListeners = new Set();

  // Listen for change events from main process
  if (typeof electron !== 'undefined' && electron.ipcRenderer) {
    electron.ipcRenderer.on('${ch('onChanged')}', (_event, data) => {
      for (const l of _onChangedListeners) {
        try { l(data.changes, data.areaName); } catch(e) { console.error('[chrome.storage.session] Listener error:', e); }
      }
    });
  }

  const sessionStorage = {
    async get(keys) {
      if (keys === undefined) keys = null;
      return electron.ipcRenderer.invoke('${ch('get')}', keys);
    },

    async set(items) {
      return electron.ipcRenderer.invoke('${ch('set')}', items);
    },

    async remove(keys) {
      return electron.ipcRenderer.invoke('${ch('remove')}', keys);
    },

    async clear() {
      return electron.ipcRenderer.invoke('${ch('clear')}');
    },

    async getBytesInUse(keys) {
      if (keys === undefined) keys = null;
      return electron.ipcRenderer.invoke('${ch('getBytesInUse')}', keys);
    },

    async setAccessLevel(accessOptions) {
      return electron.ipcRenderer.invoke('${ch('setAccessLevel')}', accessOptions);
    },

    onChanged: {
      addListener(cb) {
        if (typeof cb !== 'function') throw new TypeError('Listener must be a function');
        _onChangedListeners.add(cb);
      },
      removeListener(cb) { _onChangedListeners.delete(cb); },
      hasListener(cb) { return _onChangedListeners.has(cb); },
      hasListeners() { return _onChangedListeners.size > 0; },
    },

    QUOTA_BYTES: ${QUOTA_BYTES},
  };

  // Inject into chrome.storage namespace
  if (typeof chrome !== 'undefined') {
    chrome.storage = chrome.storage || {};
    chrome.storage.session = sessionStorage;

    // Also add session change events to main onChanged if it exists
    if (chrome.storage.onChanged) {
      const _origAddListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
      const _sessionListeners = new WeakSet();
      const origOnChanged = chrome.storage.onChanged;

      // Wrap addListener to also catch session changes
      chrome.storage.onChanged.addListener = function(cb) {
        _origAddListener(cb);
        // Also register for session changes
        _onChangedListeners.add(cb);
      };
    } else {
      chrome.storage.onChanged = sessionStorage.onChanged;
    }
  } else if (typeof globalThis !== 'undefined') {
    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.storage = globalThis.chrome.storage || {};
    globalThis.chrome.storage.session = sessionStorage;
  }
})();
`;
}
