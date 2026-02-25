/**
 * Chrome-style Event Emitter
 *
 * Implements the chrome.events.Event interface used throughout the Chrome
 * Extension API. Provides addListener/removeListener/hasListener/hasListeners
 * matching the Chrome spec.
 *
 * @module _event-emitter
 * @see https://developer.chrome.com/docs/extensions/reference/api/events
 */

/**
 * Create a Chrome-style event object.
 *
 * The returned object has the same shape as `chrome.*.onFoo`:
 * - `addListener(callback)` — register a listener
 * - `removeListener(callback)` — unregister a listener
 * - `hasListener(callback)` — check if a specific listener is registered
 * - `hasListeners()` — check if any listeners are registered
 *
 * Internally exposes `_fire(...args)` for the polyfill to trigger the event,
 * and `_listeners` for inspection.
 *
 * @returns {ChromeEvent}
 */
export function createChromeEvent() {
  /** @type {Set<Function>} */
  const listeners = new Set();

  const event = {
    /**
     * Register a listener for this event.
     * @param {Function} callback
     */
    addListener(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('Listener must be a function');
      }
      listeners.add(callback);
    },

    /**
     * Remove a previously registered listener.
     * @param {Function} callback
     */
    removeListener(callback) {
      listeners.delete(callback);
    },

    /**
     * Check whether a specific callback is registered.
     * @param {Function} callback
     * @returns {boolean}
     */
    hasListener(callback) {
      return listeners.has(callback);
    },

    /**
     * Check whether any listeners are registered.
     * @returns {boolean}
     */
    hasListeners() {
      return listeners.size > 0;
    },

    /**
     * Fire the event, calling all registered listeners with the given arguments.
     * Listeners are called synchronously in registration order.
     * Errors in individual listeners are caught and logged, not propagated.
     * @param {...*} args
     * @internal
     */
    _fire(...args) {
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch (err) {
          console.error('[chrome-polyfill] Event listener error:', err);
        }
      }
    },

    /**
     * Direct access to the listener set (for testing/inspection).
     * @internal
     */
    get _listeners() {
      return listeners;
    },
  };

  return event;
}

/**
 * Create a serializable representation of a ChromeEvent for injection into
 * an extension context via preload script. The returned JS code string
 * creates an event object that forwards addListener/removeListener calls
 * back to the main process via IPC.
 *
 * @param {string} ipcChannel — The IPC channel name for this event
 * @returns {string} JavaScript source code
 */
export function createEventPreloadSource(ipcChannel) {
  return `(() => {
    const _listeners = new Set();
    return {
      addListener(cb) {
        if (typeof cb !== 'function') throw new TypeError('Listener must be a function');
        _listeners.add(cb);
        if (_listeners.size === 1) {
          electron.ipcRenderer.send('${ipcChannel}:subscribe');
        }
      },
      removeListener(cb) {
        _listeners.delete(cb);
        if (_listeners.size === 0) {
          electron.ipcRenderer.send('${ipcChannel}:unsubscribe');
        }
      },
      hasListener(cb) { return _listeners.has(cb); },
      hasListeners() { return _listeners.size > 0; },
      _fire(...args) {
        for (const l of _listeners) {
          try { l(...args); } catch(e) { console.error('[chrome-polyfill]', e); }
        }
      },
      get _listeners() { return _listeners; }
    };
  })()`;
}
