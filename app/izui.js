/**
 * IZUI: Inverted Zooming User Interface - Thin Backward-Compatibility Wrapper
 *
 * The backend now handles all IZUI policy:
 * - Parent centering (centerOnParent in window-open handler)
 * - Parent tracking (parentWindowId auto-set from ev.sender)
 * - Focus restoration (parent focused on child close)
 * - ESC policy for children vs root windows
 *
 * This file exists only for backward compatibility. New code should use
 * api.window.open() and api.escape.onEscape() directly.
 *
 * See notes/izui-model.md for the full design.
 */

import api from './api.js';

const DEBUG = true;

/**
 * Open a child window.
 * Delegates to api.window.open() - the backend handles centering and parent tracking.
 *
 * @deprecated Use api.window.open() directly. Backend auto-centers on parent and tracks parentWindowId.
 * @param {string} address - URL to open
 * @param {Object} params - Window parameters
 * @returns {Promise<Object>} Window controller with { id, ... }
 */
export async function openChildWindow(address, params = {}) {
  DEBUG && console.log('[IZUI] openChildWindow (delegating to api.window.open):', address);
  return api.window.open(address, params);
}

/**
 * Notify parent window to take focus.
 * @deprecated Backend now focuses parent automatically on child close.
 */
export function notifyParentFocus() {
  DEBUG && console.log('[IZUI] notifyParentFocus (no-op, backend handles focus restoration)');
}

/**
 * Set up focus listener.
 * @deprecated Backend now focuses parent automatically on child close.
 */
export function setupFocusListener() {
  DEBUG && console.log('[IZUI] setupFocusListener (no-op, backend handles focus restoration)');
}

/**
 * Set up escape handler.
 * Delegates to api.escape.onEscape().
 *
 * @deprecated Use api.escape.onEscape() directly.
 * @param {Function} [internalHandler] - Handler for internal navigation
 * @param {Object} [options] - Options (ignored, backend handles close policy)
 * @returns {Function} Cleanup function
 */
export function setupEscapeHandler(internalHandler, options = {}) {
  DEBUG && console.log('[IZUI] setupEscapeHandler (delegating to api.escape.onEscape)');

  if (api.escape && api.escape.onEscape) {
    api.escape.onEscape(internalHandler);
  }

  return () => {
    // Cleanup - currently no way to unregister escape handler
  };
}

/**
 * Initialize IZUI for a window.
 * Thin wrapper that sets up escape handling via api.escape.onEscape().
 *
 * @deprecated Use api.escape.onEscape() directly instead of izui.init().
 * @param {Object} options
 * @param {Function} [options.onEscape] - Internal escape handler
 * @param {boolean} [options.canHaveChildren] - Ignored (backend tracks parents)
 * @param {boolean} [options.setupEscape=true] - Whether to set up escape handling
 * @param {boolean} [options.closeOnEscape] - Ignored (backend handles close policy)
 * @param {number} [options.parentWindowId] - Ignored (backend auto-tracks parent)
 */
export async function init(options = {}) {
  const { onEscape, setupEscape = true } = options;

  DEBUG && console.log('[IZUI] init (thin wrapper, backend handles policy)');

  // Only set up escape handler if requested and handler provided
  if (setupEscape && onEscape) {
    setupEscapeHandler(onEscape);
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
