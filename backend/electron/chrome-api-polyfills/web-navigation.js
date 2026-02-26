/**
 * chrome.webNavigation Polyfill for Electron
 *
 * Implements the Chrome WebNavigation API by forwarding Electron's
 * webContents navigation events to extension contexts via IPC.
 *
 * Tracks navigation events (before navigate, committed, completed,
 * DOM content loaded) for all webContents in the bound session.
 *
 * @module web-navigation
 * @see https://developer.chrome.com/docs/extensions/reference/api/webNavigation
 */

import { createChromeEvent } from './_event-emitter.js';
import { channel, registerHandler, removeHandler, broadcastToExtensions } from './_ipc-bridge.js';

const API = 'webNavigation';
const DEBUG = !!process.env.DEBUG;

/**
 * @typedef {Object} NavigationDetails
 * @property {number} tabId — The ID of the tab
 * @property {string} url — The URL being navigated to
 * @property {number} frameId — 0 for main frame, positive for subframes
 * @property {number} parentFrameId — -1 for main frame
 * @property {number} processId — The renderer process ID
 * @property {number} timeStamp — Time in ms since epoch
 * @property {string} [transitionType] — How the navigation was initiated
 * @property {string[]} [transitionQualifiers] — Additional transition info
 */

/**
 * @typedef {Object} FrameDetails
 * @property {boolean} errorOccurred — Whether an error occurred
 * @property {number} frameId — Frame ID
 * @property {number} parentFrameId — Parent frame ID
 * @property {number} processId — Renderer process ID
 * @property {string} url — Current URL of the frame
 */

// Events
const onBeforeNavigate = createChromeEvent();
const onCommitted = createChromeEvent();
const onCompleted = createChromeEvent();
const onDOMContentLoaded = createChromeEvent();
const onErrorOccurred = createChromeEvent();

/** @type {import('electron').Session|null} */
let _session = null;

/** @type {Set<import('electron').WebContents>} */
const trackedContents = new Set();

/** @type {Function|null} */
let _webContentsCreatedHandler = null;

/**
 * Get the tab ID for a webContents.
 * Uses webContents.id as a proxy for Chrome's tab ID.
 * @param {import('electron').WebContents} contents
 * @returns {number}
 */
function getTabId(contents) {
  return contents.id;
}

/**
 * Build navigation details from webContents.
 * @param {import('electron').WebContents} contents
 * @param {string} url
 * @param {Object} [extra]
 * @returns {NavigationDetails}
 */
function buildDetails(contents, url, extra = {}) {
  return {
    tabId: getTabId(contents),
    url: url || contents.getURL(),
    frameId: 0, // Main frame; Electron doesn't expose subframe IDs directly
    parentFrameId: -1,
    processId: contents.getProcessId(),
    timeStamp: Date.now(),
    ...extra,
  };
}

/**
 * Broadcast a navigation event to extension contexts and fire local listeners.
 * @param {string} eventName
 * @param {ReturnType<typeof createChromeEvent>} event
 * @param {NavigationDetails} details
 */
function emitNavigationEvent(eventName, event, details) {
  DEBUG && console.log(`[chrome-polyfill:webNavigation] ${eventName}: ${details.url} (tab ${details.tabId})`);

  // Fire main-process listeners
  event._fire(details);

  // Broadcast to extension contexts
  if (_session) {
    broadcastToExtensions(_session, channel(API, eventName), details);
  }
}

/**
 * Track navigation events on a webContents.
 * @param {import('electron').WebContents} contents
 */
function trackWebContents(contents) {
  if (trackedContents.has(contents)) return;
  if (contents.session !== _session) return;

  // Skip extension webContents (chrome-extension://)
  try {
    const url = contents.getURL();
    if (url.startsWith('chrome-extension://')) return;
  } catch {
    // getURL() can throw for destroyed contents
    return;
  }

  trackedContents.add(contents);

  contents.on('will-navigate', (_event, url) => {
    emitNavigationEvent('onBeforeNavigate', onBeforeNavigate,
      buildDetails(contents, url));
  });

  contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      emitNavigationEvent('onCommitted', onCommitted,
        buildDetails(contents, url, {
          transitionType: isInPlace ? 'auto_subframe' : 'link',
          transitionQualifiers: [],
        }));
    }
  });

  contents.on('dom-ready', () => {
    emitNavigationEvent('onDOMContentLoaded', onDOMContentLoaded,
      buildDetails(contents, contents.getURL()));
  });

  contents.on('did-finish-load', () => {
    emitNavigationEvent('onCompleted', onCompleted,
      buildDetails(contents, contents.getURL()));
  });

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    emitNavigationEvent('onErrorOccurred', onErrorOccurred,
      buildDetails(contents, validatedURL, { error: errorDescription }));
  });

  contents.on('destroyed', () => {
    trackedContents.delete(contents);
  });
}

// --- Public API ---

/**
 * Lazily resolve Electron's webContents module.
 * @returns {{ getAllWebContents: () => import('electron').WebContents[] } | null}
 */
function getWebContentsModule() {
  try {
    const electron = globalThis.require ? globalThis.require('electron') : null;
    return electron ? electron.webContents : null;
  } catch {
    return null;
  }
}

/**
 * Set up main-process IPC handlers for chrome.webNavigation.
 *
 * @param {import('electron').Session} session — The session to bind to
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain — Electron's ipcMain module
 * @param {import('electron').App} [options.app] — Electron's app module (for webContents tracking)
 * @returns {{ cleanup: () => void, events: Object }}
 */
export function setupMainProcess(session, { ipcMain, app }) {
  _session = session;

  // getFrame: return details about a specific frame
  registerHandler(ipcMain, API, 'getFrame', (event, details) => {
    const wcModule = getWebContentsModule();
    if (!wcModule) return null;
    const { tabId, frameId } = details;

    for (const contents of wcModule.getAllWebContents()) {
      if (getTabId(contents) === tabId && contents.session === session) {
        return {
          errorOccurred: false,
          frameId: frameId || 0,
          parentFrameId: -1,
          processId: contents.getProcessId(),
          url: contents.getURL(),
        };
      }
    }
    return null;
  });

  // getAllFrames: return all frames for a tab
  registerHandler(ipcMain, API, 'getAllFrames', (event, details) => {
    const wcModule = getWebContentsModule();
    if (!wcModule) return [];
    const { tabId } = details;

    for (const contents of wcModule.getAllWebContents()) {
      if (getTabId(contents) === tabId && contents.session === session) {
        // Electron doesn't easily enumerate subframes, return main frame
        return [{
          errorOccurred: false,
          frameId: 0,
          parentFrameId: -1,
          processId: contents.getProcessId(),
          url: contents.getURL(),
        }];
      }
    }
    return [];
  });

  // Track existing webContents
  const wcModule = getWebContentsModule();
  if (wcModule) {
    for (const contents of wcModule.getAllWebContents()) {
      trackWebContents(contents);
    }
  }

  // Track new webContents as they are created
  if (app) {
    _webContentsCreatedHandler = (_event, contents) => {
      // Delay slightly to let the webContents initialize
      setTimeout(() => {
        if (!contents.isDestroyed()) {
          trackWebContents(contents);
        }
      }, 0);
    };
    app.on('web-contents-created', _webContentsCreatedHandler);
  }

  return {
    cleanup() {
      removeHandler(ipcMain, API, 'getFrame');
      removeHandler(ipcMain, API, 'getAllFrames');
      trackedContents.clear();
      if (app && _webContentsCreatedHandler) {
        app.removeListener('web-contents-created', _webContentsCreatedHandler);
        _webContentsCreatedHandler = null;
      }
      _session = null;
    },
    events: {
      onBeforeNavigate,
      onCommitted,
      onCompleted,
      onDOMContentLoaded,
      onErrorOccurred,
    },
  };
}

/**
 * Get the JavaScript source code to inject into extension contexts.
 * Creates a `chrome.webNavigation` API object with event listeners
 * that receive events from the main process.
 *
 * @returns {string} JavaScript source to execute in the extension context
 */
export function getPreloadScript() {
  const ch = (method) => channel(API, method);

  const eventNames = ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onDOMContentLoaded', 'onErrorOccurred'];

  const eventDeclarations = eventNames.map(name => `
    const _${name}Listeners = new Set();
    const ${name} = {
      addListener(cb, filter) {
        if (typeof cb !== 'function') throw new TypeError('Listener must be a function');
        cb._filter = filter;
        _${name}Listeners.add(cb);
      },
      removeListener(cb) { _${name}Listeners.delete(cb); },
      hasListener(cb) { return _${name}Listeners.has(cb); },
      hasListeners() { return _${name}Listeners.size > 0; },
    };

    if (typeof electron !== 'undefined' && electron.ipcRenderer) {
      electron.ipcRenderer.on('${ch(name)}', (_event, details) => {
        for (const l of _${name}Listeners) {
          try {
            // Apply URL filters if specified
            if (l._filter && l._filter.url && l._filter.url.length > 0) {
              const matchesFilter = l._filter.url.some(f => {
                if (f.hostContains && !details.url.includes(f.hostContains)) return false;
                if (f.hostEquals) {
                  try { if (new URL(details.url).hostname !== f.hostEquals) return false; } catch { return false; }
                }
                if (f.urlMatches) {
                  try { if (!new RegExp(f.urlMatches).test(details.url)) return false; } catch { return false; }
                }
                if (f.urlContains && !details.url.includes(f.urlContains)) return false;
                return true;
              });
              if (!matchesFilter) continue;
            }
            l(details);
          } catch(e) { console.error('[chrome.webNavigation] Listener error:', e); }
        }
      });
    }
  `).join('\n');

  return `
(function() {
  ${eventDeclarations}

  const webNavigation = {
    async getFrame(details) {
      return electron.ipcRenderer.invoke('${ch('getFrame')}', details);
    },

    async getAllFrames(details) {
      return electron.ipcRenderer.invoke('${ch('getAllFrames')}', details);
    },

    onBeforeNavigate,
    onCommitted,
    onCompleted,
    onDOMContentLoaded,
    onErrorOccurred,
  };

  // Inject into chrome namespace (only if IPC is available)
  if (typeof electron !== 'undefined' && electron.ipcRenderer) {
    if (typeof chrome !== 'undefined') {
      chrome.webNavigation = webNavigation;
    } else if (typeof globalThis !== 'undefined') {
      globalThis.chrome = globalThis.chrome || {};
      globalThis.chrome.webNavigation = webNavigation;
    }
  }
})();
`;
}
