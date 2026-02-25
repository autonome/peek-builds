/**
 * IPC Bridge Utilities for Chrome API Polyfills
 *
 * Shared utilities for bridging Chrome extension APIs between Electron's
 * main process and extension renderer/service-worker contexts.
 *
 * Pattern:
 * 1. Main process registers IPC handlers via `ipcMain.handle(channel, handler)`
 * 2. Preload script exposes `chrome.*` APIs that call `ipcRenderer.invoke(channel, ...args)`
 * 3. Events flow from main → renderer via `webContents.send(channel, data)`
 *
 * @module _ipc-bridge
 */

/**
 * IPC channel prefix for all Chrome API polyfills.
 * All channels are namespaced under this prefix to avoid collisions.
 * @type {string}
 */
export const IPC_PREFIX = 'chrome-polyfill';

/**
 * Build a namespaced IPC channel name.
 * @param {string} api — The API name (e.g., 'alarms', 'storage.session')
 * @param {string} method — The method name (e.g., 'create', 'get')
 * @returns {string} Fully qualified channel name
 */
export function channel(api, method) {
  return `${IPC_PREFIX}:${api}:${method}`;
}

/**
 * Register an IPC handler on the main process.
 * Wraps `ipcMain.handle()` with the polyfill channel prefix.
 *
 * @param {import('electron').IpcMain} ipcMain
 * @param {string} api — API name
 * @param {string} method — Method name
 * @param {Function} handler — `(event, ...args) => result`
 */
export function registerHandler(ipcMain, api, method, handler) {
  const ch = channel(api, method);
  ipcMain.handle(ch, handler);
}

/**
 * Remove an IPC handler.
 *
 * @param {import('electron').IpcMain} ipcMain
 * @param {string} api
 * @param {string} method
 */
export function removeHandler(ipcMain, api, method) {
  const ch = channel(api, method);
  ipcMain.removeHandler(ch);
}

/**
 * Cached reference to Electron's webContents module.
 * Lazily populated on first broadcast call.
 * @type {{ getAllWebContents: () => import('electron').WebContents[] } | null}
 */
let _webContentsModule = null;

/**
 * Send an event to all extension webContents in a session.
 *
 * @param {import('electron').Session} session
 * @param {string} channelName — Full channel name
 * @param {*} data — Data to send
 */
export function broadcastToExtensions(session, channelName, data) {
  // Lazily acquire webContents module (only available in Electron)
  if (!_webContentsModule) {
    try {
      // Dynamic import is not available synchronously, use the process-level
      // electron module if available (Electron main process always has it)
      const electron = globalThis.require ? globalThis.require('electron') : null;
      if (electron && electron.webContents) {
        _webContentsModule = electron.webContents;
      }
    } catch {
      // Not running in Electron — no-op
    }
  }

  if (!_webContentsModule) return;

  for (const contents of _webContentsModule.getAllWebContents()) {
    if (contents.session === session && !contents.isDestroyed()) {
      try {
        contents.send(channelName, data);
      } catch {
        // webContents may have been destroyed between check and send
      }
    }
  }
}

/**
 * Generate a preload script snippet that creates an `ipcRenderer.invoke`
 * wrapper for a given API method.
 *
 * @param {string} api — API name
 * @param {string} method — Method name
 * @returns {string} JavaScript source for the preload context
 */
export function invokeSnippet(api, method) {
  const ch = channel(api, method);
  return `(...args) => electron.ipcRenderer.invoke('${ch}', ...args)`;
}
