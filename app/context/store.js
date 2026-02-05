/**
 * Context Store - In-memory state management for window context
 *
 * Manages per-window context state with pub/sub for change notifications.
 * This is the frontend-side cache; backend persists to context_history table.
 */

/**
 * @typedef {Object} ContextEntry
 * @property {string} key - Context key (e.g., 'mode')
 * @property {*} value - The context value
 * @property {Object} metadata - Additional context-specific data
 * @property {number} timestamp - Unix timestamp ms when set
 * @property {string} source - Source that set this context
 * @property {number|null} windowId - Window ID (null for global)
 */

// Per-window context storage
// Map<windowId, Map<key, ContextEntry>>
const windowContexts = new Map();

// Global context (windowId = null)
const globalContext = new Map();

// Subscribers for context changes
// Map<key, Set<callback>>
const subscribers = new Map();

/**
 * Get the context map for a window
 * @param {number|null} windowId - Window ID or null for global
 * @returns {Map<string, ContextEntry>}
 */
function getContextMap(windowId) {
  if (windowId === null || windowId === undefined) {
    return globalContext;
  }
  if (!windowContexts.has(windowId)) {
    windowContexts.set(windowId, new Map());
  }
  return windowContexts.get(windowId);
}

/**
 * Get a context entry
 * @param {string} key - Context key
 * @param {number|null} windowId - Window ID (null for global)
 * @returns {ContextEntry|null}
 */
export function get(key, windowId = null) {
  const contextMap = getContextMap(windowId);
  const entry = contextMap.get(key);
  return entry ? { ...entry } : null;
}

/**
 * Set a context value
 * @param {string} key - Context key
 * @param {*} value - Value to set
 * @param {Object} options - Options
 * @param {Object} [options.metadata={}] - Additional metadata
 * @param {string} [options.source=''] - Source identifier
 * @param {number|null} [options.windowId=null] - Window ID
 * @returns {ContextEntry} The created entry
 */
export function set(key, value, options = {}) {
  const {
    metadata = {},
    source = '',
    windowId = null
  } = options;

  const contextMap = getContextMap(windowId);
  const oldEntry = contextMap.get(key);

  const entry = {
    key,
    value,
    metadata,
    timestamp: Date.now(),
    source,
    windowId
  };

  contextMap.set(key, entry);

  // Notify subscribers
  notifySubscribers(key, entry, oldEntry);

  return { ...entry };
}

/**
 * Delete a context entry
 * @param {string} key - Context key
 * @param {number|null} windowId - Window ID
 * @returns {boolean} True if entry existed and was deleted
 */
export function remove(key, windowId = null) {
  const contextMap = getContextMap(windowId);
  const oldEntry = contextMap.get(key);

  if (oldEntry) {
    contextMap.delete(key);
    notifySubscribers(key, null, oldEntry);
    return true;
  }
  return false;
}

/**
 * Watch for context changes
 * @param {string} key - Context key to watch
 * @param {function(ContextEntry|null, ContextEntry|null): void} callback - Called with (newEntry, oldEntry)
 * @returns {function(): void} Unsubscribe function
 */
export function watch(key, callback) {
  if (!subscribers.has(key)) {
    subscribers.set(key, new Set());
  }
  subscribers.get(key).add(callback);

  // Return unsubscribe function
  return () => {
    const subs = subscribers.get(key);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) {
        subscribers.delete(key);
      }
    }
  };
}

/**
 * Notify subscribers of a context change
 * @param {string} key - Context key that changed
 * @param {ContextEntry|null} newEntry - New entry (null if removed)
 * @param {ContextEntry|null} oldEntry - Previous entry (null if new)
 */
function notifySubscribers(key, newEntry, oldEntry) {
  const subs = subscribers.get(key);
  if (subs) {
    for (const callback of subs) {
      try {
        callback(newEntry, oldEntry);
      } catch (err) {
        console.error('[context:store] Subscriber error:', err);
      }
    }
  }
}

/**
 * Get all context entries for a window
 * @param {number|null} windowId - Window ID
 * @returns {ContextEntry[]}
 */
export function getAll(windowId = null) {
  const contextMap = getContextMap(windowId);
  return Array.from(contextMap.values()).map(e => ({ ...e }));
}

/**
 * Clear all context for a window
 * Called when window closes
 * @param {number} windowId - Window ID
 */
export function clearWindow(windowId) {
  const contextMap = windowContexts.get(windowId);
  if (contextMap) {
    // Notify subscribers of removal for each key
    for (const [key, entry] of contextMap) {
      notifySubscribers(key, null, entry);
    }
    windowContexts.delete(windowId);
  }
}

/**
 * Get all windows with a specific context value
 * @param {string} key - Context key
 * @param {*} value - Value to match
 * @returns {number[]} Array of window IDs
 */
export function getWindowsWithContext(key, value) {
  const windowIds = [];
  for (const [windowId, contextMap] of windowContexts) {
    const entry = contextMap.get(key);
    if (entry && entry.value === value) {
      windowIds.push(windowId);
    }
  }
  return windowIds;
}

/**
 * Get all windows with context matching a predicate
 * @param {string} key - Context key
 * @param {function(ContextEntry): boolean} predicate - Filter function
 * @returns {number[]} Array of window IDs
 */
export function getWindowsMatching(key, predicate) {
  const windowIds = [];
  for (const [windowId, contextMap] of windowContexts) {
    const entry = contextMap.get(key);
    if (entry && predicate(entry)) {
      windowIds.push(windowId);
    }
  }
  return windowIds;
}

export default {
  get,
  set,
  remove,
  watch,
  getAll,
  clearWindow,
  getWindowsWithContext,
  getWindowsMatching
};
