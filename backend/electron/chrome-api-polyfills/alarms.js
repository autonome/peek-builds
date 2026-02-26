/**
 * chrome.alarms Polyfill for Electron
 *
 * Implements the Chrome Alarms API using Node.js timers in the main process,
 * with IPC bridge to extension contexts.
 *
 * Each alarm is scoped to its source extension (identified by the
 * chrome-extension:// origin of the sender). Alarms fire via IPC broadcast
 * to all extension webContents in the bound session.
 *
 * @module alarms
 * @see https://developer.chrome.com/docs/extensions/reference/api/alarms
 */

import { createChromeEvent } from './_event-emitter.js';
import { channel, registerHandler, removeHandler, broadcastToExtensions } from './_ipc-bridge.js';

const API = 'alarms';
const DEBUG = !!process.env.DEBUG;

/**
 * @typedef {Object} Alarm
 * @property {string} name — Name of this alarm
 * @property {number} scheduledTime — Time at which this alarm is scheduled to fire, in ms since epoch
 * @property {number} [periodInMinutes] — If set, the alarm is recurring
 */

/**
 * @typedef {Object} AlarmCreateInfo
 * @property {number} [delayInMinutes] — Minutes from now to first fire
 * @property {number} [periodInMinutes] — Minutes between recurring fires
 * @property {number} [when] — Absolute time to fire, in ms since epoch
 */

/**
 * Internal alarm state.
 * Keyed by `${extensionId}:${alarmName}`.
 * @type {Map<string, {alarm: Alarm, timeout: NodeJS.Timeout|null, interval: NodeJS.Timeout|null, extensionId: string}>}
 */
const alarmStore = new Map();

/** @type {ReturnType<typeof createChromeEvent>} */
const onAlarmEvent = createChromeEvent();

/** @type {import('electron').Session|null} */
let _session = null;

/**
 * Build a storage key for an alarm.
 * @param {string} extensionId
 * @param {string} name
 * @returns {string}
 */
function alarmKey(extensionId, name) {
  return `${extensionId}:${name}`;
}

/**
 * Get the extension ID from an IPC event.
 * Electron tags extension webContents with the extension URL origin.
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {string}
 */
function getExtensionId(event) {
  const url = event.sender.getURL();
  // chrome-extension://[extensionId]/...
  const match = url.match(/^chrome-extension:\/\/([^/]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Fire an alarm: notify listeners and broadcast to extension contexts.
 * @param {string} key — The alarm storage key
 */
function fireAlarm(key) {
  const entry = alarmStore.get(key);
  if (!entry) return;

  DEBUG && console.log(`[chrome-polyfill:alarms] Firing alarm: ${entry.alarm.name}`);

  // Fire main-process listeners
  onAlarmEvent._fire(entry.alarm);

  // Broadcast to extension contexts
  if (_session) {
    broadcastToExtensions(_session, channel(API, 'onAlarm'), entry.alarm);
  }

  // If not recurring, remove after firing
  if (!entry.alarm.periodInMinutes) {
    alarmStore.delete(key);
  } else {
    // Update scheduledTime for next fire
    entry.alarm.scheduledTime = Date.now() + entry.alarm.periodInMinutes * 60 * 1000;
  }
}

/**
 * Create an alarm.
 * @param {string} extensionId
 * @param {string} name
 * @param {AlarmCreateInfo} alarmInfo
 */
function createAlarm(extensionId, name, alarmInfo) {
  const key = alarmKey(extensionId, name);

  // Clear existing alarm with the same name
  clearAlarm(extensionId, name);

  let delayMs;
  if (alarmInfo.when) {
    delayMs = Math.max(0, alarmInfo.when - Date.now());
  } else if (alarmInfo.delayInMinutes !== undefined) {
    delayMs = Math.max(0, alarmInfo.delayInMinutes * 60 * 1000);
  } else if (alarmInfo.periodInMinutes !== undefined) {
    delayMs = alarmInfo.periodInMinutes * 60 * 1000;
  } else {
    // Chrome requires at least one timing property
    delayMs = 0;
  }

  const scheduledTime = Date.now() + delayMs;

  /** @type {Alarm} */
  const alarm = {
    name,
    scheduledTime,
  };

  if (alarmInfo.periodInMinutes !== undefined) {
    alarm.periodInMinutes = alarmInfo.periodInMinutes;
  }

  const entry = {
    alarm,
    timeout: null,
    interval: null,
    extensionId,
  };

  // Schedule first fire
  entry.timeout = setTimeout(() => {
    fireAlarm(key);

    // Set up recurring interval if needed
    if (alarmInfo.periodInMinutes) {
      entry.interval = setInterval(() => {
        fireAlarm(key);
      }, alarmInfo.periodInMinutes * 60 * 1000);
    }
  }, delayMs);

  alarmStore.set(key, entry);
  DEBUG && console.log(`[chrome-polyfill:alarms] Created alarm "${name}" for ext ${extensionId}, delay=${delayMs}ms`);
}

/**
 * Clear a specific alarm.
 * @param {string} extensionId
 * @param {string} name
 * @returns {boolean}
 */
function clearAlarm(extensionId, name) {
  const key = alarmKey(extensionId, name);
  const entry = alarmStore.get(key);
  if (!entry) return false;

  if (entry.timeout) clearTimeout(entry.timeout);
  if (entry.interval) clearInterval(entry.interval);
  alarmStore.delete(key);
  DEBUG && console.log(`[chrome-polyfill:alarms] Cleared alarm "${name}" for ext ${extensionId}`);
  return true;
}

/**
 * Get a specific alarm.
 * @param {string} extensionId
 * @param {string} name
 * @returns {Alarm|undefined}
 */
function getAlarm(extensionId, name) {
  const key = alarmKey(extensionId, name);
  const entry = alarmStore.get(key);
  return entry ? { ...entry.alarm } : undefined;
}

/**
 * Get all alarms for an extension.
 * @param {string} extensionId
 * @returns {Alarm[]}
 */
function getAllAlarms(extensionId) {
  const prefix = `${extensionId}:`;
  const result = [];
  for (const [key, entry] of alarmStore) {
    if (key.startsWith(prefix)) {
      result.push({ ...entry.alarm });
    }
  }
  return result;
}

/**
 * Clear all alarms for an extension.
 * @param {string} extensionId
 * @returns {boolean}
 */
function clearAllAlarms(extensionId) {
  const prefix = `${extensionId}:`;
  let cleared = false;
  for (const [key, entry] of alarmStore) {
    if (key.startsWith(prefix)) {
      if (entry.timeout) clearTimeout(entry.timeout);
      if (entry.interval) clearInterval(entry.interval);
      alarmStore.delete(key);
      cleared = true;
    }
  }
  DEBUG && console.log(`[chrome-polyfill:alarms] Cleared all alarms for ext ${extensionId}`);
  return cleared;
}

// --- Public API ---

/**
 * Set up main-process IPC handlers for chrome.alarms.
 *
 * @param {import('electron').Session} session — The session to bind to
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain — Electron's ipcMain module
 * @returns {{ cleanup: () => void, onAlarm: ReturnType<typeof createChromeEvent>, _store: Map }}
 */
export function setupMainProcess(session, { ipcMain }) {
  _session = session;

  registerHandler(ipcMain, API, 'create', (event, name, alarmInfo) => {
    const extId = getExtensionId(event);
    createAlarm(extId, name, alarmInfo);
  });

  registerHandler(ipcMain, API, 'get', (event, name) => {
    const extId = getExtensionId(event);
    return getAlarm(extId, name);
  });

  registerHandler(ipcMain, API, 'getAll', (event) => {
    const extId = getExtensionId(event);
    return getAllAlarms(extId);
  });

  registerHandler(ipcMain, API, 'clear', (event, name) => {
    const extId = getExtensionId(event);
    return clearAlarm(extId, name);
  });

  registerHandler(ipcMain, API, 'clearAll', (event) => {
    const extId = getExtensionId(event);
    return clearAllAlarms(extId);
  });

  return {
    cleanup() {
      removeHandler(ipcMain, API, 'create');
      removeHandler(ipcMain, API, 'get');
      removeHandler(ipcMain, API, 'getAll');
      removeHandler(ipcMain, API, 'clear');
      removeHandler(ipcMain, API, 'clearAll');
      // Clear all timers
      for (const [, entry] of alarmStore) {
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry.interval) clearInterval(entry.interval);
      }
      alarmStore.clear();
      _session = null;
    },
    onAlarm: onAlarmEvent,
    /** @internal — exposed for testing */
    _store: alarmStore,
  };
}

/**
 * Get the JavaScript source code to inject into extension contexts.
 * This creates a `chrome.alarms` API object that communicates with
 * the main process via IPC.
 *
 * @returns {string} JavaScript source to execute in the extension context
 */
export function getPreloadScript() {
  const ch = (method) => channel(API, method);

  return `
(function() {
  // Skip if chrome.alarms already exists natively
  if (typeof chrome !== 'undefined' && chrome.alarms) return;

  const _ipc = (typeof electron !== 'undefined' && electron.ipcRenderer) ? electron.ipcRenderer : null;
  const _onAlarmListeners = new Set();

  const onAlarm = {
    addListener(cb) {
      if (typeof cb !== 'function') throw new TypeError('Listener must be a function');
      _onAlarmListeners.add(cb);
    },
    removeListener(cb) { _onAlarmListeners.delete(cb); },
    hasListener(cb) { return _onAlarmListeners.has(cb); },
    hasListeners() { return _onAlarmListeners.size > 0; },
  };

  // Listen for alarm events from main process
  if (_ipc) {
    _ipc.on('${ch('onAlarm')}', (_event, alarm) => {
      for (const l of _onAlarmListeners) {
        try { l(alarm); } catch(e) { console.error('[chrome.alarms] Listener error:', e); }
      }
    });
  }

  const alarms = {
    async create(nameOrInfo, alarmInfoOrUndef) {
      if (!_ipc) return;
      let name, alarmInfo;
      if (typeof nameOrInfo === 'string') {
        name = nameOrInfo;
        alarmInfo = alarmInfoOrUndef || {};
      } else {
        name = '';
        alarmInfo = nameOrInfo || {};
      }
      return _ipc.invoke('${ch('create')}', name, alarmInfo);
    },

    async get(name) {
      if (!_ipc) return undefined;
      if (name === undefined) name = '';
      return _ipc.invoke('${ch('get')}', name);
    },

    async getAll() {
      if (!_ipc) return [];
      return _ipc.invoke('${ch('getAll')}');
    },

    async clear(name) {
      if (!_ipc) return false;
      if (name === undefined) name = '';
      return _ipc.invoke('${ch('clear')}', name);
    },

    async clearAll() {
      if (!_ipc) return false;
      return _ipc.invoke('${ch('clearAll')}');
    },

    onAlarm,
  };

  // Inject into chrome namespace
  if (typeof chrome !== 'undefined') {
    chrome.alarms = alarms;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.alarms = alarms;
  }
})();
`;
}
