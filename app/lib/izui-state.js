/**
 * IZUI State Coordinator (shared)
 *
 * Centralized state machine for managing IZUI (Invocable Zoom User Interface) states.
 * Platform-agnostic — works with any backend (Electron, Tauri) via WindowProvider injection.
 *
 * See docs/izui.md for comprehensive documentation.
 *
 * States:
 * - idle:      No visible windows, app in background
 * - transient: Invoked via global hotkey while unfocused
 * - active:    User working within focused Peek windows
 * - overlay:   Full-screen overlay (windows picker)
 *
 * Key Rules:
 * | State     | Mode Display          | ESC Behavior                    |
 * |-----------|----------------------|--------------------------------|
 * | TRANSIENT | Always "default"     | Close immediately              |
 * | ACTIVE    | Target window's mode | Internal nav only, never close |
 * | OVERLAY   | Inherit from previous| Always close, restore hidden   |
 */

const DEBUG = typeof process !== 'undefined' && process.env.DEBUG;

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  return `izui-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * No-op window provider (safe default when no backend is connected)
 * @type {WindowProvider}
 *
 * @typedef {Object} WindowProvider
 * @property {function(): Array<{id: number, isDestroyed(): boolean, isFocused(): boolean, isVisible(): boolean}>} getAllWindows
 * @property {function(number): {show(): void, isDestroyed(): boolean}|null} fromId
 */
const nullWindowProvider = {
  getAllWindows: () => [],
  fromId: () => null,
};

/**
 * IZUI State Coordinator
 *
 * Manages the session lifecycle for IZUI state transitions.
 * Inject a WindowProvider for backend-specific window operations.
 */
class IzuiStateCoordinator {
  constructor() {
    /** @type {'idle'|'transient'|'active'|'overlay'} */
    this._state = 'idle';

    /** @type {IzuiSession|null} */
    this._session = null;

    /** @type {WindowProvider} */
    this._windowProvider = nullWindowProvider;

    // OS-level app focus state. True when Peek is the active app.
    // Updated by backend via setAppFocused().
    // Initial value is true: at app launch, Peek IS the active app.
    /** @type {boolean} */
    this._appFocused = true;
  }

  /**
   * @typedef {Object} IzuiSession
   * @property {string} id
   * @property {'active'|'transient'} entryMode
   * @property {number[]} windowStack
   * @property {number|null} overlayWindowId
   * @property {number[]} hiddenWindowIds
   * @property {number|null} focusedWindowId
   */

  /**
   * Set custom window provider (for backend integration or testing)
   * @param {WindowProvider} provider
   */
  setWindowProvider(provider) {
    this._windowProvider = provider;
  }

  /** @deprecated Use setWindowProvider() — kept for backward compatibility with tests */
  _setWindowProvider(provider) {
    this._windowProvider = provider;
  }

  /**
   * Reset to null window provider
   */
  resetWindowProvider() {
    this._windowProvider = nullWindowProvider;
  }

  /** @deprecated Use resetWindowProvider() — kept for backward compatibility with tests */
  _resetWindowProvider() {
    this._windowProvider = nullWindowProvider;
  }

  /**
   * Update OS-level app focus state.
   * Called from backend focus event handlers.
   * @param {boolean} focused
   */
  setAppFocused(focused) {
    this._appFocused = focused;
    DEBUG && console.log('[izui] App focus changed:', focused);

    // One-way ratchet: when app gains focus during a transient session,
    // promote to active. The user is now working in Peek.
    if (focused && this._session && this._session.entryMode === 'transient') {
      this._session.entryMode = 'active';
      this._state = 'active';
      DEBUG && console.log('[izui] Promoted session from transient to active (app gained focus)');
    }
  }

  /**
   * Check if app currently has OS-level focus.
   * @returns {boolean}
   */
  isAppFocused() {
    return this._appFocused;
  }

  /**
   * Reset all state (for testing only)
   */
  _resetAll() {
    this._state = 'idle';
    this._session = null;
    this._appFocused = true;
  }

  /**
   * Start a new IZUI session when the first window opens
   * @param {'active'|'transient'} entryMode How the session was started
   */
  startSession(entryMode) {
    if (this._session) {
      DEBUG && console.log('[izui] Session already active, not starting new one');
      return;
    }

    this._session = {
      id: generateSessionId(),
      entryMode,
      windowStack: [],
      overlayWindowId: null,
      hiddenWindowIds: [],
      focusedWindowId: null,
      preOverlayFocusTarget: null,
    };

    this._state = entryMode;
    DEBUG && console.log('[izui] Started session:', this._session.id, 'entryMode:', entryMode);
  }

  /**
   * End the current IZUI session when the last window closes
   */
  endSession() {
    if (!this._session) {
      DEBUG && console.log('[izui] No session to end');
      return;
    }

    DEBUG && console.log('[izui] Ending session:', this._session.id);
    this._session = null;
    this._state = 'idle';
  }

  /**
   * Evaluate transient state based on OS-level app focus.
   *
   * IZUI policy: transient = Peek was NOT the active/focused app at the OS
   * window manager level when the window was opened.
   *
   * @param {number} [_excludeWindowId] Unused (kept for API compat)
   * @returns {'active'|'transient'}
   */
  evaluateOnShow(_excludeWindowId) {
    const result = this._appFocused ? 'active' : 'transient';

    DEBUG && console.log('[izui] evaluateOnShow:', result, 'appFocused:', this._appFocused);

    if (!this._session) {
      this.startSession(result);
    } else {
      // One-way ratchet: transient -> active is allowed, active -> transient is not.
      if (this._session.entryMode === 'transient' && result === 'active') {
        this._session.entryMode = 'active';
        this._state = 'active';
        DEBUG && console.log('[izui] Promoted session from transient to active');
      } else {
        DEBUG && console.log('[izui] Session entryMode unchanged:', this._session.entryMode, '(evaluated:', result, ')');
      }
    }

    return result;
  }

  /**
   * Enter overlay mode (e.g., windows picker)
   * @param {number} windowId The overlay window's ID
   * @param {number[]} hiddenIds IDs of windows that were hidden for the overlay
   */
  enterOverlay(windowId, hiddenIds) {
    if (!this._session) {
      DEBUG && console.log('[izui] Cannot enter overlay without active session');
      return;
    }

    this._state = 'overlay';
    this._session.overlayWindowId = windowId;
    this._session.hiddenWindowIds = hiddenIds;
    this._session.preOverlayFocusTarget = this._session.focusedWindowId;
    DEBUG && console.log('[izui] Entered overlay mode, windowId:', windowId, 'hidden:', hiddenIds.length, 'preOverlayFocus:', this._session.preOverlayFocusTarget);
  }

  /**
   * Exit overlay mode and restore hidden windows
   */
  exitOverlay() {
    if (!this._session || this._state !== 'overlay') {
      DEBUG && console.log('[izui] Not in overlay mode');
      return;
    }

    const hiddenIds = this._session.hiddenWindowIds;
    DEBUG && console.log('[izui] Exiting overlay, restoring', hiddenIds.length, 'windows');

    // Restore hidden windows via provider
    for (const id of hiddenIds) {
      const win = this._windowProvider.fromId(id);
      if (win && !win.isDestroyed()) {
        win.show();
      }
    }

    // Return to previous state based on entry mode
    this._state = this._session.entryMode;
    this._session.overlayWindowId = null;
    this._session.hiddenWindowIds = [];
    this._session.preOverlayFocusTarget = null;
  }

  /**
   * Track when a window gains focus
   * @param {number} windowId
   */
  setFocusedWindow(windowId) {
    if (this._session) {
      this._session.focusedWindowId = windowId;
    }
    DEBUG && console.log('[izui] Focused window set:', windowId);
  }

  /**
   * Clear focus tracking when a window closes or loses focus
   * @param {number} windowId
   */
  clearFocusedWindow(windowId) {
    if (this._session && this._session.focusedWindowId === windowId) {
      this._session.focusedWindowId = null;
      DEBUG && console.log('[izui] Cleared focused window:', windowId);
    }
  }

  /**
   * Add a window to the session's window stack
   * @param {number} windowId
   */
  pushWindow(windowId) {
    if (!this._session) {
      DEBUG && console.log('[izui] Cannot push window without active session');
      return;
    }

    if (!this._session.windowStack.includes(windowId)) {
      this._session.windowStack.push(windowId);
      DEBUG && console.log('[izui] Pushed window:', windowId, 'stack size:', this._session.windowStack.length);
    }
  }

  /**
   * Remove a window from the session's window stack
   * If this was the last window, end the session
   * @param {number} windowId
   */
  popWindow(windowId) {
    if (!this._session) {
      return;
    }

    const index = this._session.windowStack.indexOf(windowId);
    if (index !== -1) {
      this._session.windowStack.splice(index, 1);
      DEBUG && console.log('[izui] Popped window:', windowId, 'remaining:', this._session.windowStack.length);
    }

    // End session if no more windows
    if (this._session.windowStack.length === 0) {
      this.endSession();
    }
  }

  /**
   * Check if currently in transient mode
   * @returns {boolean}
   */
  isTransient() {
    if (!this._session) {
      return false;
    }
    return this._session.entryMode === 'transient';
  }

  /**
   * Get the current IZUI state
   * @returns {'idle'|'transient'|'active'|'overlay'}
   */
  getState() {
    return this._state;
  }

  /**
   * Get the current session info
   * @returns {IzuiSession|null}
   */
  getSession() {
    return this._session;
  }

  /**
   * Get the effective mode for display
   * @param {number} [targetWindowId] Optional window to get mode for
   * @returns {'default'|'active'}
   */
  getEffectiveMode(targetWindowId) {
    if (this.isTransient()) {
      return 'default';
    }
    return 'active';
  }

  /**
   * Check if currently in overlay mode
   * @returns {boolean}
   */
  isOverlay() {
    return this._state === 'overlay';
  }

  /**
   * Get the focused window ID from the session
   * @returns {number|null}
   */
  getFocusedWindowId() {
    return this._session?.focusedWindowId ?? null;
  }

  /**
   * Get the pre-overlay focus target (the window that was focused before overlay opened).
   * Used by the overlay close handler to restore focus when no explicit selection was made.
   * @returns {number|null}
   */
  getPreOverlayFocusTarget() {
    return this._session?.preOverlayFocusTarget ?? null;
  }
}

// ============================================================================
// ESC Policy
// ============================================================================

/**
 * ESC policy: given session state and window role, determine what to do.
 * Pure function — no side effects.
 *
 * @param {string} sessionState - Current IZUI state ('idle'|'transient'|'active'|'overlay')
 * @param {string} role - Window role ('quick-view'|'palette'|'utility'|'overlay'|'child-content'|'workspace'|'content')
 * @returns {'close'|'close-and-restore'|'nothing'}
 */
function escPolicy(sessionState, role) {
  // These roles always close regardless of session state
  if (['quick-view', 'palette', 'utility'].includes(role)) return 'close';
  if (role === 'overlay') return 'close-and-restore';
  // Workspace windows are root/persistent extension windows (groups, search, etc.).
  // They must NEVER close on ESC regardless of session state — the renderer handles
  // internal navigation and the window persists.
  if (role === 'workspace') return 'nothing';
  // child-content and content: only close in transient sessions.
  // In active sessions, ESC navigates internally (renderer handles it) but
  // never closes the window — even child-content windows are user-opened
  // content that should persist.
  if (sessionState === 'transient') return 'close';
  return 'nothing';
}

/**
 * ESC unhandled policy: second-phase policy consulted ONLY after the renderer
 * returns { handled: false } AND escPolicy() returns 'nothing'.
 *
 * Determines what to do when ESC has nowhere left to navigate.
 * Pure function — no side effects.
 *
 * @param {string} sessionState - Current IZUI state ('idle'|'transient'|'active'|'overlay')
 * @param {string} role - Window role ('quick-view'|'palette'|'utility'|'overlay'|'child-content'|'workspace'|'content')
 * @returns {'open-switcher'|'nothing'}
 */
function escUnhandledPolicy(sessionState, role) {
  // Transient sessions should NOT trigger switcher — user expects ESC to
  // return to previous app, not open more UI.
  // Overlay sessions handle their own ESC (close-and-restore).
  if (sessionState === 'transient' || sessionState === 'overlay') return 'nothing';
  // In active or idle sessions, workspace, content, and child-content windows
  // open the switcher when ESC has nowhere left to navigate.
  // Note: content/child-content only reach here when the renderer's onEscape
  // returned { handled: false } AND escPolicy returned 'nothing', so page-level
  // ESC handling (spaces navigation, panel closing, etc.) takes priority.
  if (['workspace', 'content', 'child-content'].includes(role)) return 'open-switcher';
  return 'nothing';
}

// ============================================================================
// Singleton & Exports
// ============================================================================

const coordinator = new IzuiStateCoordinator();

/**
 * Get the IZUI State Coordinator singleton
 * @returns {IzuiStateCoordinator}
 */
function getIzuiCoordinator() {
  return coordinator;
}

export {
  IzuiStateCoordinator,
  getIzuiCoordinator,
  escPolicy,
  escUnhandledPolicy,
};
