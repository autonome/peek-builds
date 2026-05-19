/**
 * IZUI State Coordinator
 *
 * Centralized state machine for managing IZUI (Invocable Zoom User Interface) states.
 * See docs/izui.md for comprehensive documentation.
 *
 * Problems solved:
 * - Transient state frozen at creation for keepLive windows
 * - No session concept for unified state
 * - Stale focus trackers never cleaned up
 *
 * States:
 * - IDLE: No visible windows, app in background
 * - TRANSIENT: Invoked via global hotkey while unfocused
 * - ACTIVE: User working within focused Peek windows
 * - OVERLAY: Full-screen overlay (windows picker)
 *
 * Key Rules:
 * | State     | Mode Display          | ESC Behavior                    |
 * |-----------|----------------------|--------------------------------|
 * | TRANSIENT | Always "default"     | Close immediately              |
 * | ACTIVE    | Target window's mode | Internal nav only, never close |
 * | OVERLAY   | Inherit from previous| Always close, restore hidden   |
 */

import { DEBUG, isHeadless } from './config.js';

// Lazy-load Electron modules to allow testing without Electron
let BrowserWindow: typeof import('electron').BrowserWindow | null = null;

try {
  const electron = await import('electron');
  BrowserWindow = electron.BrowserWindow;
} catch {
  // Electron not available (e.g., in unit tests)
  DEBUG && console.log('[izui-state] Running without Electron (test mode)');
}

export type IzuiState = 'idle' | 'transient' | 'active' | 'overlay';

/**
 * Window provider interface for dependency injection (enables testing)
 */
export interface WindowProvider {
  getAllWindows(): Array<{ id: number; isDestroyed(): boolean; isFocused(): boolean; isVisible(): boolean; webContents?: { getURL(): string } }>;
  fromId(id: number): { show(): void; showInactive(): void; isDestroyed(): boolean } | null;
}

/**
 * Default window provider using Electron's BrowserWindow (or stub for testing)
 */
const defaultWindowProvider: WindowProvider = {
  getAllWindows: () => BrowserWindow?.getAllWindows() ?? [],
  fromId: (id: number) => BrowserWindow?.fromId(id) ?? null,
};

export interface IzuiSession {
  id: string;
  entryMode: 'active' | 'transient';
  windowStack: number[];
  overlayWindowId: number | null;
  hiddenWindowIds: number[];
  focusedWindowId: number | null;
  preOverlayFocusTarget: number | null;
  overlayFocusTarget: number | null;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `izui-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * IZUI State Coordinator singleton
 */
class IzuiStateCoordinator {
  private state: IzuiState = 'idle';
  private session: IzuiSession | null = null;
  private windowProvider: WindowProvider = defaultWindowProvider;

  // OS-level app focus state. True when Peek is the active app.
  // Updated by browser-window-focus/blur events in main.ts.
  // Initial value is true: at app launch, Peek IS the active app.
  // In headless mode, stays true (no real focus events fire).
  private appFocused: boolean = true;

  // Cooldown: timestamp of last overlay exit. Used to prevent the macOS focus dance
  // (did-resign-active → did-become-active cycle during window restoration) from
  // immediately closing a newly opened overlay.
  private lastOverlayExitTime: number = 0;

  // Cooldown: timestamp of last overlay entry. Used to prevent did-resign-active
  // from immediately closing an overlay that was just opened. On macOS, hiding all
  // regular windows during overlay creation can trigger did-resign-active because
  // only a panel-type window remains (panels don't count as main windows for app
  // activation). This cooldown lets the overlay survive that initial focus dance.
  private lastOverlayEntryTime: number = 0;

  /**
   * Set custom window provider (for testing)
   */
  _setWindowProvider(provider: WindowProvider): void {
    this.windowProvider = provider;
  }

  /**
   * Reset to default window provider
   */
  _resetWindowProvider(): void {
    this.windowProvider = defaultWindowProvider;
  }

  /**
   * Update OS-level app focus state.
   * Called from main.ts browser-window-focus/blur event handlers.
   */
  setAppFocused(focused: boolean): void {
    this.appFocused = focused;
    DEBUG && console.log('[izui] App focus changed:', focused);

    // One-way ratchet: when app gains focus during a transient session,
    // promote to active. The user is now working in Peek.
    if (focused && this.session && this.session.entryMode === 'transient') {
      this.session.entryMode = 'active';
      this.state = 'active';
      DEBUG && console.log('[izui] Promoted session from transient to active (app gained focus)');
    }
  }

  /**
   * Check if app currently has OS-level focus.
   */
  isAppFocused(): boolean {
    return this.appFocused;
  }

  /**
   * Reset all state (for testing only)
   */
  _resetAll(): void {
    this.state = 'idle';
    this.session = null;
    this.appFocused = true;
    this.lastOverlayExitTime = 0;
    this.lastOverlayEntryTime = 0;
  }

  /**
   * Start a new IZUI session when the first window opens
   * @param entryMode How the session was started (active if app was focused, transient if not)
   */
  startSession(entryMode: 'active' | 'transient'): void {
    if (this.session) {
      DEBUG && console.log('[izui] Session already active, not starting new one');
      return;
    }

    this.session = {
      id: generateSessionId(),
      entryMode,
      windowStack: [],
      overlayWindowId: null,
      hiddenWindowIds: [],
      focusedWindowId: null,
      preOverlayFocusTarget: null,
      overlayFocusTarget: null,
    };

    this.state = entryMode;
    DEBUG && console.log('[izui] Started session:', this.session.id, 'entryMode:', entryMode);
  }

  /**
   * End the current IZUI session when the last window closes
   */
  endSession(): void {
    if (!this.session) {
      DEBUG && console.log('[izui] No session to end');
      return;
    }

    DEBUG && console.log('[izui] Ending session:', this.session.id);
    this.session = null;
    this.state = 'idle';
  }

  /**
   * Evaluate transient state based on OS-level app focus.
   *
   * IZUI policy: transient = Peek was NOT the active/focused app at the OS
   * window manager level when the window was opened. This is the single source
   * of truth for transient detection.
   *
   * Called from:
   *   - window-open handler (before window is shown, so focus state is still accurate)
   *   - keepLive reuse path (re-evaluates on each show)
   *   - izui-is-transient IPC handler (when no session exists)
   *
   * @param _excludeWindowId Unused (kept for API compat), focus is now app-level
   * @returns 'active' if Peek has OS focus, 'transient' if not
   */
  evaluateOnShow(_excludeWindowId?: number): 'active' | 'transient' {
    // IZUI policy: app focused → active, app not focused → transient.
    // appFocused is tracked via browser-window-focus/blur events in main.ts.
    // At startup, appFocused defaults to true (app is active when launched).
    // In headless mode, appFocused stays true (no real focus events fire).
    const result = this.appFocused ? 'active' : 'transient';

    DEBUG && console.log('[izui] evaluateOnShow:', result, 'appFocused:', this.appFocused);

    if (!this.session) {
      this.startSession(result);
    } else {
      // One-way ratchet: transient -> active is allowed, active -> transient is not.
      // Once a session becomes active (user is working in Peek), it stays active.
      if (this.session.entryMode === 'transient' && result === 'active') {
        this.session.entryMode = 'active';
        this.state = 'active';
        DEBUG && console.log('[izui] Promoted session from transient to active');
      } else {
        DEBUG && console.log('[izui] Session entryMode unchanged:', this.session.entryMode, '(evaluated:', result, ')');
      }
    }

    return result;
  }

  /**
   * Enter overlay mode (e.g., windows picker)
   * @param windowId The overlay window's ID
   * @param hiddenIds IDs of windows that were hidden for the overlay
   */
  enterOverlay(windowId: number, hiddenIds: number[]): void {
    if (!this.session) {
      DEBUG && console.log('[izui] Cannot enter overlay without active session');
      return;
    }

    this.state = 'overlay';
    this.session.overlayWindowId = windowId;
    this.session.hiddenWindowIds = hiddenIds;
    this.session.preOverlayFocusTarget = this.session.focusedWindowId;
    this.lastOverlayEntryTime = Date.now();
    console.log('[overlay:enter] overlayId=' + windowId
      + ' preOverlayFocusTarget=' + (this.session.preOverlayFocusTarget ?? 'null')
      + ' hidden=[' + hiddenIds.join(',') + ']');
  }

  /**
   * Exit overlay mode and restore hidden windows.
   * Used for user-initiated close (ESC or selection).
   */
  exitOverlay(): void {
    if (!this.session || this.state !== 'overlay') {
      DEBUG && console.log('[izui] Not in overlay mode');
      return;
    }

    const hiddenIds = this.session.hiddenWindowIds;
    DEBUG && console.log('[izui] Exiting overlay, restoring', hiddenIds.length, 'windows');

    // Restore hidden windows with showInactive(). Plain show() activates
    // the window, and on macOS each activation pulls the user to the
    // window's Space — restoring a batch of windows that live on
    // different Spaces would yank the user to whichever one happens to
    // come last in iteration order. The caller (main.ts overlay close
    // handler) issues an explicit `.focus()` on the chosen target
    // afterward, which is the correct path to activate one window's
    // Space deterministically.
    for (const id of hiddenIds) {
      const win = this.windowProvider.fromId(id);
      if (win && !win.isDestroyed()) {
        win.showInactive();
      }
    }

    // Return to previous state based on entry mode
    this.state = this.session.entryMode;
    this.session.overlayWindowId = null;
    this.session.hiddenWindowIds = [];
    this.session.preOverlayFocusTarget = null;
    this.session.overlayFocusTarget = null;
    this.lastOverlayExitTime = Date.now();
  }

  /**
   * Exit overlay mode due to app losing OS focus (Cmd+Tab away).
   * Restores hidden windows with showInactive() so they don't steal focus,
   * and does NOT focus any window — the user is switching to another app.
   */
  exitOverlayForAppBlur(): void {
    if (!this.session || this.state !== 'overlay') {
      DEBUG && console.log('[izui] Not in overlay mode (app blur path)');
      return;
    }

    const hiddenIds = this.session.hiddenWindowIds;
    DEBUG && console.log('[izui] Exiting overlay (app blur), restoring', hiddenIds.length, 'windows without focus');

    // Restore hidden windows WITHOUT focusing — use showInactive() to avoid stealing focus.
    // (Previously called show() despite the docstring saying showInactive — fixed.)
    for (const id of hiddenIds) {
      const win = this.windowProvider.fromId(id);
      if (win && !win.isDestroyed()) {
        win.showInactive();
      }
    }

    // Return to previous state based on entry mode
    this.state = this.session.entryMode;
    this.session.overlayWindowId = null;
    this.session.hiddenWindowIds = [];
    this.session.preOverlayFocusTarget = null;
    this.session.overlayFocusTarget = null;
    this.lastOverlayExitTime = Date.now();
  }

  /**
   * Check if we're within the overlay exit cooldown period.
   * After an overlay closes, window restoration can trigger a brief
   * did-resign-active → did-become-active cycle (macOS focus dance).
   * This cooldown prevents that stale did-resign-active from closing
   * a newly opened overlay.
   * @param cooldownMs Cooldown duration in milliseconds (default 300)
   */
  isWithinOverlayExitCooldown(cooldownMs: number = 300): boolean {
    if (this.lastOverlayExitTime === 0) return false;
    return (Date.now() - this.lastOverlayExitTime) < cooldownMs;
  }

  /**
   * Check if we're within the overlay entry cooldown period.
   * After an overlay opens, hiding regular windows can trigger did-resign-active
   * on macOS because only a panel-type window remains (panels don't count as
   * main windows for app activation). This cooldown prevents that stale
   * did-resign-active from immediately closing the just-opened overlay.
   * @param cooldownMs Cooldown duration in milliseconds (default 500)
   */
  isWithinOverlayEntryCooldown(cooldownMs: number = 500): boolean {
    if (this.lastOverlayEntryTime === 0) return false;
    return (Date.now() - this.lastOverlayEntryTime) < cooldownMs;
  }

  /**
   * Get the last overlay exit timestamp (for testing)
   */
  getLastOverlayExitTime(): number {
    return this.lastOverlayExitTime;
  }

  /**
   * Track when a window gains focus
   * @param windowId The window that gained focus
   */
  setFocusedWindow(windowId: number): void {
    if (this.session) {
      this.session.focusedWindowId = windowId;
    }
    DEBUG && console.log('[izui] Focused window set:', windowId);
  }

  /**
   * Clear focus tracking when a window closes or loses focus
   * This prevents stale window IDs from being tracked
   * @param windowId The window to clear
   */
  clearFocusedWindow(windowId: number): void {
    if (this.session && this.session.focusedWindowId === windowId) {
      this.session.focusedWindowId = null;
      DEBUG && console.log('[izui] Cleared focused window:', windowId);
    }
  }

  /**
   * Add a window to the session's window stack
   * @param windowId The window to add
   */
  pushWindow(windowId: number): void {
    if (!this.session) {
      DEBUG && console.log('[izui] Cannot push window without active session');
      return;
    }

    if (!this.session.windowStack.includes(windowId)) {
      this.session.windowStack.push(windowId);
      DEBUG && console.log('[izui] Pushed window:', windowId, 'stack size:', this.session.windowStack.length);
    }
  }

  /**
   * Remove a window from the session's window stack
   * If this was the last window, end the session
   * @param windowId The window to remove
   */
  popWindow(windowId: number): void {
    if (!this.session) {
      return;
    }

    const index = this.session.windowStack.indexOf(windowId);
    if (index !== -1) {
      this.session.windowStack.splice(index, 1);
      DEBUG && console.log('[izui] Popped window:', windowId, 'remaining:', this.session.windowStack.length);
    }

    // End session if no more windows
    if (this.session.windowStack.length === 0) {
      this.endSession();
    }
  }

  /**
   * Check if currently in transient mode
   * This is the primary query for determining mode display and ESC behavior
   */
  isTransient(): boolean {
    if (!this.session) {
      return false;
    }
    // Transient means opened without app focus
    return this.session.entryMode === 'transient';
  }

  /**
   * Get the current IZUI state
   */
  getState(): IzuiState {
    return this.state;
  }

  /**
   * Get the current session info (for debugging)
   */
  getSession(): IzuiSession | null {
    return this.session;
  }

  /**
   * Get the effective mode for display
   * @param targetWindowId Optional window to get mode for
   * @returns 'default' for transient sessions, actual mode otherwise
   */
  getEffectiveMode(targetWindowId?: number): string {
    // In transient mode, always show "default"
    if (this.isTransient()) {
      return 'default';
    }

    // For active sessions, return the window's actual mode
    // This will be resolved by the caller using the context API
    return 'active';
  }

  /**
   * Check if currently in overlay mode
   */
  isOverlay(): boolean {
    return this.state === 'overlay';
  }

  /**
   * Get the focused window ID from the session
   */
  getFocusedWindowId(): number | null {
    return this.session?.focusedWindowId ?? null;
  }

  /**
   * Get the pre-overlay focus target (the window that was focused before overlay opened).
   * Used by the overlay close handler to restore focus when no explicit selection was made.
   */
  getPreOverlayFocusTarget(): number | null {
    return this.session?.preOverlayFocusTarget ?? null;
  }

  /**
   * Set the overlay focus target (explicit user selection in the switcher).
   * Takes priority over preOverlayFocusTarget when restoring focus after overlay close.
   */
  setOverlayFocusTarget(windowId: number): void {
    if (this.session) {
      this.session.overlayFocusTarget = windowId;
      DEBUG && console.log('[izui] Set overlay focus target:', windowId);
    }
  }
}

// Singleton instance
const coordinator = new IzuiStateCoordinator();

/**
 * Get the IZUI State Coordinator singleton
 */
export function getIzuiCoordinator(): IzuiStateCoordinator {
  return coordinator;
}

export { IzuiStateCoordinator };
