/**
 * Context History - Persistence helpers for context changes
 *
 * Handles storing and querying context history from the backend datastore.
 * Used for time-series visualization and correlation with visits.
 */

/**
 * @typedef {Object} ContextHistoryEntry
 * @property {string} id - Unique entry ID
 * @property {string} key - Context key
 * @property {*} value - The context value
 * @property {Object} metadata - Additional context-specific data
 * @property {number|null} windowId - Window ID
 * @property {string} source - Source that set this context
 * @property {number} timestamp - Unix timestamp ms
 * @property {string|null} prevEntryId - Previous entry ID for chaining
 */

/**
 * @typedef {Object} HistoryQueryOptions
 * @property {number} [since] - Start timestamp (inclusive)
 * @property {number} [until] - End timestamp (inclusive)
 * @property {number|null} [windowId] - Filter by window ID
 * @property {number} [limit] - Max entries to return
 * @property {string} [order='desc'] - Sort order ('asc' or 'desc')
 */

// Reference to the IPC renderer (set during initialization)
let ipcRenderer = null;

/**
 * Initialize the history module with IPC renderer
 * @param {object} renderer - Electron IPC renderer
 */
export function init(renderer) {
  ipcRenderer = renderer;
}

/**
 * Save a context entry to history
 * @param {string} key - Context key
 * @param {*} value - Context value
 * @param {Object} options - Options
 * @param {Object} [options.metadata={}] - Additional metadata
 * @param {number|null} [options.windowId=null] - Window ID
 * @param {string} [options.source=''] - Source identifier
 * @returns {Promise<{success: boolean, id?: string, error?: string}>}
 */
export async function save(key, value, options = {}) {
  if (!ipcRenderer) {
    console.warn('[context:history] IPC not initialized');
    return { success: false, error: 'IPC not initialized' };
  }

  return ipcRenderer.invoke('context-set', {
    key,
    value,
    metadata: options.metadata || {},
    windowId: options.windowId ?? null,
    source: options.source || ''
  });
}

/**
 * Query context history
 * @param {string} key - Context key
 * @param {HistoryQueryOptions} options - Query options
 * @returns {Promise<{success: boolean, data?: ContextHistoryEntry[], error?: string}>}
 */
export async function query(key, options = {}) {
  if (!ipcRenderer) {
    console.warn('[context:history] IPC not initialized');
    return { success: false, error: 'IPC not initialized' };
  }

  return ipcRenderer.invoke('context-history', {
    key,
    ...options
  });
}

/**
 * Get the latest entry for a key from history
 * @param {string} key - Context key
 * @param {number|null} windowId - Optional window ID filter
 * @returns {Promise<{success: boolean, data?: ContextHistoryEntry, error?: string}>}
 */
export async function getLatest(key, windowId = null) {
  const result = await query(key, { windowId, limit: 1, order: 'desc' });
  if (result.success && result.data && result.data.length > 0) {
    return { success: true, data: result.data[0] };
  }
  return { success: true, data: null };
}

/**
 * Get context snapshot at a specific time
 * Returns the most recent entry for each key before the given timestamp
 * @param {number} timestamp - Point in time
 * @param {string[]} keys - Keys to include (empty = all keys)
 * @returns {Promise<{success: boolean, data?: Object.<string, ContextHistoryEntry>, error?: string}>}
 */
export async function getSnapshot(timestamp, keys = []) {
  if (!ipcRenderer) {
    console.warn('[context:history] IPC not initialized');
    return { success: false, error: 'IPC not initialized' };
  }

  return ipcRenderer.invoke('context-snapshot', {
    timestamp,
    keys
  });
}

export default {
  init,
  save,
  query,
  getLatest,
  getSnapshot
};
