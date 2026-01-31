/**
 * IZUI: Inverted Zooming User Interface - Minimal Implementation
 *
 * Simple parent-child window tracking for focus restoration.
 * When a child window closes, focus returns to its parent.
 *
 * See notes/izui-model.md for the full design and future plans.
 */

import api from './api.js';

const DEBUG = false;

/**
 * Notify parent window to take focus.
 * Called when this window is about to close/hide.
 * Publishes globally so any listening parent will receive.
 *
 * @param {string} [parentAddress] - The parent window's address (optional, for logging)
 */
export function notifyParentFocus(parentAddress) {
  DEBUG && console.log('[IZUI] Notifying parent to focus:', parentAddress || '(global)');

  // Publish globally so listening parent windows will receive
  api.publish('izui:focus-request', {
    from: window.location.toString(),
    parentAddress: parentAddress || null
  }, api.scopes.GLOBAL);
}

/**
 * Set up focus listener for this window.
 * When a child window closes, this window will receive focus.
 *
 * Call this in windows that may have children (e.g., settings).
 */
export function setupFocusListener() {
  const myAddress = window.location.toString();

  api.subscribe('izui:focus-request', async (msg) => {
    DEBUG && console.log('[IZUI] Received focus request from:', msg?.from);

    // Focus this window
    if (api.window && api.window.focus) {
      // Get our own window ID and focus it
      const windowId = await api.window.getWindowId();
      if (windowId) {
        api.window.focus(windowId);
      }
    }
  }, api.scopes.GLOBAL);

  DEBUG && console.log('[IZUI] Focus listener set up for:', myAddress);
}

/**
 * Open a child window with IZUI tracking.
 * The child will notify this window to focus when it closes.
 *
 * @param {string} address - URL to open
 * @param {Object} params - Window parameters
 * @returns {Promise<Object>} Window controller
 */
export async function openChildWindow(address, params = {}) {
  const myAddress = window.location.toString();

  // Track this window as the parent
  // Set escapeMode: 'navigate' so backend asks renderer before closing
  const childParams = {
    ...params,
    izuiParent: myAddress,
    escapeMode: params.escapeMode || 'navigate'
  };

  DEBUG && console.log('[IZUI] Opening child window:', address, 'parent:', myAddress);

  const result = await api.window.open(address, childParams);
  return result;
}

/**
 * Handle ESC key for IZUI navigation.
 * If the window has internal navigation, handle that first.
 * Otherwise, notify parent and close this window.
 *
 * @param {Function} [internalHandler] - Optional handler for internal navigation
 *   Should return { handled: true } if it handled the ESC internally
 * @param {Object} [options] - Options
 * @param {boolean} [options.closeOnEscape=true] - Whether to close when no internal navigation
 * @returns {Function} Cleanup function
 */
export function setupEscapeHandler(internalHandler, options = {}) {
  const { closeOnEscape = true } = options;

  const handler = async () => {
    // First, try internal navigation
    if (internalHandler) {
      const result = await internalHandler();
      if (result && result.handled) {
        DEBUG && console.log('[IZUI] Internal handler handled ESC');
        return { handled: true };
      }
    }

    // No internal navigation - notify parent, then optionally close
    notifyParentFocus(null); // Global publish

    if (closeOnEscape) {
      DEBUG && console.log('[IZUI] ESC at root, closing window');
      // Close this window - parent was already notified
      window.close();
    } else {
      DEBUG && console.log('[IZUI] ESC at root, not closing (closeOnEscape=false)');
    }

    return { handled: true }; // We handled it (by closing or not)
  };

  // Register with the escape API
  if (api.escape && api.escape.onEscape) {
    api.escape.onEscape(handler);
  }

  return () => {
    // Cleanup - currently no way to unregister escape handler
  };
}

/**
 * Initialize IZUI for a window.
 * Sets up focus listening and escape handling.
 *
 * @param {Object} options
 * @param {Function} [options.onEscape] - Internal escape handler (returns { handled: true } to prevent close)
 * @param {boolean} [options.canHaveChildren=true] - Whether this window may open children
 * @param {boolean} [options.setupEscape=true] - Whether to set up escape handling (notifies parent on close)
 * @param {boolean} [options.closeOnEscape=true] - Whether ESC closes this window (when no internal nav)
 */
export function init(options = {}) {
  const { onEscape, canHaveChildren = true, setupEscape = true, closeOnEscape = true } = options;

  if (canHaveChildren) {
    setupFocusListener();
  }

  // Always set up escape handler so parent is notified before close
  // Pass onEscape if provided for internal navigation handling
  if (setupEscape) {
    setupEscapeHandler(onEscape, { closeOnEscape });
  }

  DEBUG && console.log('[IZUI] Initialized for:', window.location.toString());
}

export default {
  init,
  setupFocusListener,
  setupEscapeHandler,
  openChildWindow,
  notifyParentFocus
};
