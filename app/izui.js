/**
 * IZUI: Inverted Zooming User Interface - Minimal Implementation
 *
 * Simple parent-child window tracking for focus restoration.
 * When a child window closes, focus returns to its parent.
 *
 * Navigation stack: Parent windows track children they've opened.
 * When a child presses ESC, parent closes it and pops the stack.
 * This works even for web pages that don't have IZUI code.
 *
 * See notes/izui-model.md for the full design and future plans.
 */

import api from './api.js';

const DEBUG = true;

// Navigation stack - tracks child windows opened by this window
// Each entry: { windowId, url }
const navigationStack = [];

// My window ID (set during init)
let myWindowId = null;

// Parent window ID (if this window was opened as a child)
let parentWindowId = null;

/**
 * Notify parent window to take focus.
 * Called when this window is about to close/hide.
 * If we know our parent window ID, only that window should respond.
 *
 * @param {number} [targetParentId] - Specific parent window ID to notify (optional)
 */
export function notifyParentFocus(targetParentId) {
  const targetId = targetParentId || parentWindowId;
  DEBUG && console.log('[IZUI] Notifying parent to focus, target:', targetId || '(global)');

  // Publish focus request - if we have a target parent ID, include it
  api.publish('izui:focus-request', {
    from: window.location.toString(),
    fromWindowId: myWindowId,
    targetWindowId: targetId || null
  }, api.scopes.GLOBAL);
}

/**
 * Set up focus listener for this window.
 * When a child window closes and targets us, this window will receive focus.
 * Only responds if we're the target or if no specific target was given and
 * the request came from a window we have in our navigation stack.
 */
export function setupFocusListener() {
  const myAddress = window.location.toString();

  api.subscribe('izui:focus-request', async (msg) => {
    const { targetWindowId, fromWindowId, from } = msg || {};

    DEBUG && console.log('[IZUI] Received focus request from:', from, 'target:', targetWindowId, 'myId:', myWindowId);

    // If a specific target was given, only respond if we're that target
    if (targetWindowId !== null && targetWindowId !== undefined) {
      if (targetWindowId !== myWindowId) {
        DEBUG && console.log('[IZUI] Focus request not for us, ignoring');
        return;
      }
    } else {
      // No specific target - only respond if the sender is in our nav stack
      const inOurStack = navigationStack.some(entry => entry.windowId === fromWindowId);
      if (!inOurStack && fromWindowId) {
        DEBUG && console.log('[IZUI] Sender not in our stack, ignoring');
        return;
      }
    }

    // Focus this window
    if (api.window && api.window.focus && myWindowId) {
      api.window.focus(myWindowId);
      DEBUG && console.log('[IZUI] Focused self:', myWindowId);
    }
  }, api.scopes.GLOBAL);

  DEBUG && console.log('[IZUI] Focus listener set up for:', myAddress);
}


/**
 * Open a child window with IZUI tracking.
 * The child will notify this window to focus when it closes.
 * Child is added to navigation stack - ESC in child will close it and return here.
 *
 * @param {string} address - URL to open
 * @param {Object} params - Window parameters
 * @returns {Promise<Object>} Window controller with { id, ... }
 */
export async function openChildWindow(address, params = {}) {
  const myAddress = window.location.toString();

  // Ensure we have our window ID
  if (!myWindowId && api.window && api.window.getWindowId) {
    myWindowId = await api.window.getWindowId();
  }

  // Center child over parent window by default
  let centerPos = {};
  if (params.x === undefined && params.y === undefined && myWindowId && api.window.getBounds) {
    try {
      const bounds = await api.window.getBounds(myWindowId);
      if (bounds && bounds.x !== undefined) {
        const childW = params.width || 800;
        const childH = params.height || 600;
        centerPos = {
          x: Math.round(bounds.x + (bounds.width - childW) / 2),
          y: Math.round(bounds.y + (bounds.height - childH) / 2)
        };
      }
    } catch (e) {
      DEBUG && console.log('[IZUI] Could not get parent bounds for centering:', e);
    }
  }

  // Track this window as the parent - pass our window ID so child can target us
  // Set escapeMode: 'navigate' so backend asks renderer before closing
  const childParams = {
    ...centerPos,
    ...params,
    izuiParent: myAddress,
    izuiParentWindowId: myWindowId,
    escapeMode: params.escapeMode || 'navigate'
  };

  DEBUG && console.log('[IZUI] Opening child window:', address, 'parent:', myAddress, 'parentId:', myWindowId);

  const result = await api.window.open(address, childParams);

  // Track child in navigation stack
  if (result && result.id) {
    navigationStack.push({
      windowId: result.id,
      url: address
    });
    DEBUG && console.log('[IZUI] Added to nav stack:', result.id, 'stack size:', navigationStack.length);
  }

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
    DEBUG && console.log('[IZUI] Escape handler called, hasInternalHandler:', !!internalHandler, 'closeOnEscape:', closeOnEscape);

    // First, try internal navigation
    if (internalHandler) {
      const result = await internalHandler();
      DEBUG && console.log('[IZUI] Internal handler returned:', JSON.stringify(result));
      if (result && result.handled) {
        DEBUG && console.log('[IZUI] Internal handler handled ESC');
        return { handled: true };
      }
    }

    // No internal navigation - notify parent, then optionally close
    notifyParentFocus(null); // Global publish

    if (closeOnEscape) {
      DEBUG && console.log('[IZUI] ESC at root, closing via izui-close-self');
      // Renderer-driven close: call backend's closeOrHideWindow directly.
      // This avoids race conditions where backend ESC handler might close
      // the wrong window or close prematurely due to IPC timing.
      if (api.izui && api.izui.closeSelf) {
        api.izui.closeSelf();
      }
      return { handled: true }; // Tell backend we handled it (we're closing ourselves)
    } else {
      DEBUG && console.log('[IZUI] ESC at root, not closing (closeOnEscape=false)');
    }

    return { handled: true }; // We handled it (by not closing)
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
 * @param {number} [options.parentWindowId] - Parent window ID (if known, for targeted focus return)
 */
export async function init(options = {}) {
  const { onEscape, canHaveChildren = true, setupEscape = true, closeOnEscape = true, parentWindowId: providedParentId } = options;

  // Get our window ID
  if (api.window && api.window.getWindowId) {
    myWindowId = await api.window.getWindowId();
    DEBUG && console.log('[IZUI] My window ID:', myWindowId);
  }

  // Store parent window ID if provided
  if (providedParentId) {
    parentWindowId = providedParentId;
    DEBUG && console.log('[IZUI] Parent window ID:', parentWindowId);
  }

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
