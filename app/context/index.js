/**
 * Context API - App-wide context management
 *
 * Provides a simple key-value store for application context with:
 * - Per-window and global context
 * - Change notifications via watch()
 * - Time-series history for visualization
 *
 * "mode" is just one key in this general-purpose system.
 *
 * Usage:
 *   import context from 'peek://app/context/index.js';
 *
 *   // Set context
 *   context.set('mode', 'page', { metadata: { url: 'https://example.com' } });
 *
 *   // Get context
 *   const entry = context.get('mode');
 *   // { value: 'page', metadata: { url: '...' }, timestamp: ... }
 *
 *   // Watch for changes
 *   const unsub = context.watch('mode', (entry, oldEntry) => {
 *     console.log('Mode changed to:', entry?.value);
 *   });
 *   // Later: unsub();
 *
 *   // Query history
 *   const history = await context.getHistory('mode', { since: startOfDay });
 */

import * as store from './store.js';
import * as history from './history.js';

// Re-export store functions for direct use
export const get = store.get;
export const watch = store.watch;
export const remove = store.remove;
export const getAll = store.getAll;
export const clearWindow = store.clearWindow;
export const getWindowsWithContext = store.getWindowsWithContext;
export const getWindowsMatching = store.getWindowsMatching;

// IPC renderer reference (set during init)
let ipcRenderer = null;

/**
 * Initialize the context module
 * @param {object} renderer - Electron IPC renderer
 */
export function init(renderer) {
  ipcRenderer = renderer;
  history.init(renderer);
}

/**
 * Set a context value with persistence
 * @param {string} key - Context key
 * @param {*} value - Value to set
 * @param {Object} options - Options
 * @param {Object} [options.metadata={}] - Additional metadata
 * @param {string} [options.source=''] - Source identifier (defaults to window.location)
 * @param {number|null} [options.windowId=null] - Window ID
 * @param {boolean} [options.persist=true] - Whether to persist to history
 * @returns {Promise<{success: boolean, entry?: Object, error?: string}>}
 */
export async function set(key, value, options = {}) {
  const {
    metadata = {},
    source = typeof window !== 'undefined' ? window.location.toString() : '',
    windowId = null,
    persist = true
  } = options;

  // Update in-memory store
  const entry = store.set(key, value, { metadata, source, windowId });

  // Persist to backend (async, don't block)
  if (persist && ipcRenderer) {
    try {
      const result = await ipcRenderer.invoke('context-set', {
        key,
        value,
        metadata,
        windowId,
        source
      });
      if (!result.success) {
        console.warn('[context] Failed to persist:', result.error);
      }
    } catch (err) {
      console.error('[context] Persistence error:', err);
    }
  }

  return { success: true, entry };
}

/**
 * Query context history
 * @param {string} key - Context key
 * @param {Object} options - Query options
 * @param {number} [options.since] - Start timestamp
 * @param {number} [options.until] - End timestamp
 * @param {number|null} [options.windowId] - Filter by window
 * @param {number} [options.limit] - Max entries
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
export async function getHistory(key, options = {}) {
  return history.query(key, options);
}

/**
 * Get context snapshot at a point in time
 * @param {number} timestamp - Point in time
 * @param {string[]} keys - Keys to include
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
export async function getSnapshot(timestamp, keys = []) {
  return history.getSnapshot(timestamp, keys);
}

// Mode-specific helpers (convenience functions)

/**
 * Get the current mode for a window
 * @param {number|null} windowId - Window ID (null for global)
 * @returns {string|null} Mode value or null
 */
export function getMode(windowId = null) {
  const entry = store.get('mode', windowId);
  return entry?.value ?? null;
}

/**
 * Set the mode for a window
 * @param {string} mode - Mode value ('default', 'page', 'space', etc.)
 * @param {Object} options - Options
 * @param {Object} [options.metadata={}] - Mode metadata (e.g., spaceId, spaceName)
 * @param {number|null} [options.windowId=null] - Window ID
 * @returns {Promise<{success: boolean, entry?: Object, error?: string}>}
 */
export function setMode(mode, options = {}) {
  return set('mode', mode, options);
}

/**
 * Watch for mode changes
 * @param {function(string, Object): void} callback - Called with (modeValue, entry)
 * @param {number|null} windowId - Window ID to watch (null watches all)
 * @returns {function(): void} Unsubscribe function
 */
export function watchMode(callback, windowId = null) {
  return store.watch('mode', (entry, oldEntry) => {
    // Filter by windowId if specified
    if (windowId !== null && entry?.windowId !== windowId) {
      return;
    }
    callback(entry?.value ?? null, entry);
  });
}

/**
 * Get all windows in a specific mode
 * @param {string} mode - Mode value to match
 * @returns {number[]} Array of window IDs
 */
export function getWindowsInMode(mode) {
  return store.getWindowsWithContext('mode', mode);
}

/**
 * Get all windows in a specific space
 * @param {string} spaceId - Space ID to match
 * @returns {number[]} Array of window IDs
 */
export function getWindowsInSpace(spaceId) {
  return store.getWindowsMatching('mode', (entry) => {
    return entry.value === 'space' && entry.metadata?.spaceId === spaceId;
  });
}

export default {
  // Core API
  init,
  get,
  set,
  remove,
  watch,
  getAll,
  clearWindow,
  getHistory,
  getSnapshot,

  // Query helpers
  getWindowsWithContext,
  getWindowsMatching,

  // Mode-specific helpers
  getMode,
  setMode,
  watchMode,
  getWindowsInMode,
  getWindowsInSpace
};
