/**
 * Chrome API Polyfills for Electron
 *
 * Provides Chrome Extension API compatibility for Electron applications.
 * Each API is implemented as a standalone module that:
 *
 * 1. Registers IPC handlers in the main process (`setupMainProcess`)
 * 2. Provides injectable JS for extension contexts (`getPreloadScript`)
 *
 * Implemented APIs:
 * - `chrome.alarms` — Timer/scheduling API using Node.js timers
 * - `chrome.storage.session` — In-memory session storage (cleared on quit)
 * - `chrome.webNavigation` — Page navigation event forwarding
 * - `chrome.offscreen` — Offscreen document management via hidden windows
 * - `chrome.permissions` — No-op permissions (all granted in Electron)
 *
 * ## Usage
 *
 * ```js
 * import { registerAll } from './lib/chrome-api-polyfills/index.js';
 *
 * // In your main process, after app is ready:
 * const { cleanup, injectPreloads } = registerAll(session, {
 *   ipcMain: require('electron').ipcMain,
 *   app: require('electron').app,
 * });
 *
 * // Inject polyfill scripts into extension service worker sessions
 * injectPreloads(extensionSession);
 *
 * // On shutdown:
 * cleanup();
 * ```
 *
 * @module chrome-api-polyfills
 */

import * as alarms from './alarms.js';
import * as storageSession from './storage-session.js';
import * as webNavigation from './web-navigation.js';
import * as offscreen from './offscreen.js';
import * as permissions from './permissions.js';
import * as runtimeExternal from './runtime-external.js';

export { alarms, storageSession, webNavigation, offscreen, permissions, runtimeExternal };

/**
 * Register all Chrome API polyfills for a session.
 *
 * @param {import('electron').Session} session — The Electron session to bind polyfills to
 * @param {Object} options
 * @param {import('electron').IpcMain} options.ipcMain — Electron's ipcMain module
 * @param {import('electron').App} [options.app] — Electron's app module (needed for webNavigation)
 * @param {string[]} [options.apis] — Specific APIs to register (default: all)
 * @returns {{
 *   cleanup: () => void,
 *   getPreloadScript: () => string,
 *   handles: Object
 * }}
 */
export function registerAll(session, options = {}) {
  const { ipcMain, app, apis, findExtensionByOrigin } = options;

  if (!ipcMain) {
    throw new Error('chrome-api-polyfills: options.ipcMain is required');
  }

  const shouldRegister = (api) => !apis || apis.includes(api);
  const handles = {};
  const cleanups = [];

  // Register each API
  if (shouldRegister('alarms')) {
    handles.alarms = alarms.setupMainProcess(session, { ipcMain });
    cleanups.push(handles.alarms.cleanup);
  }

  if (shouldRegister('storage.session')) {
    handles.storageSession = storageSession.setupMainProcess(session, { ipcMain });
    cleanups.push(handles.storageSession.cleanup);
  }

  if (shouldRegister('webNavigation')) {
    handles.webNavigation = webNavigation.setupMainProcess(session, { ipcMain, app });
    cleanups.push(handles.webNavigation.cleanup);
  }

  if (shouldRegister('offscreen')) {
    handles.offscreen = offscreen.setupMainProcess(session, { ipcMain });
    cleanups.push(handles.offscreen.cleanup);
  }

  if (shouldRegister('permissions')) {
    handles.permissions = permissions.setupMainProcess(session, { ipcMain });
    cleanups.push(handles.permissions.cleanup);
  }

  if (shouldRegister('runtimeExternal')) {
    handles.runtimeExternal = runtimeExternal.setupMainProcess(session, { ipcMain, findExtensionByOrigin });
    cleanups.push(handles.runtimeExternal.cleanup);
  }

  return {
    /**
     * Clean up all registered handlers and free resources.
     * Call this on app shutdown.
     */
    cleanup() {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (err) {
          console.error('[chrome-api-polyfills] Cleanup error:', err);
        }
      }
    },

    /**
     * Get the combined preload script source for all registered APIs.
     * Execute this in the extension's JS context to make chrome.* APIs available.
     *
     * @returns {string} Combined JavaScript source
     */
    getPreloadScript() {
      const scripts = [];

      if (shouldRegister('alarms')) {
        scripts.push(alarms.getPreloadScript());
      }
      if (shouldRegister('storage.session')) {
        scripts.push(storageSession.getPreloadScript());
      }
      if (shouldRegister('webNavigation')) {
        scripts.push(webNavigation.getPreloadScript());
      }
      if (shouldRegister('offscreen')) {
        scripts.push(offscreen.getPreloadScript());
      }
      if (shouldRegister('permissions')) {
        scripts.push(permissions.getPreloadScript());
      }

      return scripts.join('\n');
    },

    /**
     * References to individual API handles for fine-grained control.
     */
    handles,
  };
}
