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
  fromId(id: number): { show(): void; isDestroyed(): boolean } | null;
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
   * Re-evaluate transient state when a window is shown (for keepLive windows)
   * This is the key fix for the cmd bar stuck on "group" mode issue.
   * When a keepLive window is reused, we need to re-check if the app
   * was focused when it was invoked.
   *
   * IMPORTANT: BrowserWindow.getFocusedWindow() returns Electron's internally
   * tracked "focused window" which persists even when the app loses system focus.
   * Instead, we check if ANY window actually has system focus via isFocused().
   *
   * @param excludeWindowId Optional window ID to exclude from focus check
   *        (used when the querying window is already visible/focused)
   * @returns 'active' if a Peek window has system focus, 'transient' if not
   */
  evaluateOnShow(excludeWindowId?: number): 'active' | 'transient' {
    // Determine if user has an active Peek context by checking for visible
    // content windows. We use isVisible() instead of isFocused() because:
    // - Modal windows (cmd) steal focus from content windows on open
    // - By the time this is called, the requesting window may have already stolen focus
    // - isVisible() is stable: a content window stays visible regardless of focus changes
    //
    // Active = at least one visible, non-background, non-modal content window exists
    // Transient = no visible content windows (user invoked from background/other app)
    const allWindows = this.windowProvider.getAllWindows();

    // Background/internal URLs that don't count as user-visible content
    const INTERNAL_URLS = [
      'peek://app/background.html',
      'peek://app/extension-host.html',
    ];

    // In headless mode (tests), windows are created with show:false so isVisible()
    // always returns false. Skip the visibility check - a non-destroyed, non-background
    // window is equivalent to "visible" in headless.
    const checkVisible = !isHeadless();

    const visibleContentWindow = allWindows.find(win => {
      if (win.isDestroyed()) return false;
      if (checkVisible && !win.isVisible()) return false;
      if (win.id === excludeWindowId) return false;

      // Exclude internal/background windows
      const url = win.webContents?.getURL?.() ?? '';
      if (INTERNAL_URLS.some(internal => url === internal)) return false;

      return true;
    });

    const hasVisibleContent = !!visibleContentWindow;
    const result = hasVisibleContent ? 'active' : 'transient';
    DEBUG && console.log('[izui] evaluateOnShow:', result, 'excludeWindowId:', excludeWindowId,
      'visibleContentWindow:', visibleContentWindow?.id,
      'url:', visibleContentWindow?.webContents?.getURL?.()?.substring(0, 60));

    if (!this.session) {
      this.startSession(result);
    } else {
      // Update entry mode for this invocation (e.g., keepLive window reuse)
      this.session.entryMode = result;
      this.state = result;
      DEBUG && console.log('[izui] Updated session entryMode to:', result);
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
    DEBUG && console.log('[izui] Entered overlay mode, windowId:', windowId, 'hidden:', hiddenIds.length);
  }

  /**
   * Exit overlay mode and restore hidden windows
   */
  exitOverlay(): void {
    if (!this.session || this.state !== 'overlay') {
      DEBUG && console.log('[izui] Not in overlay mode');
      return;
    }

    const hiddenIds = this.session.hiddenWindowIds;
    DEBUG && console.log('[izui] Exiting overlay, restoring', hiddenIds.length, 'windows');

    // Restore hidden windows
    for (const id of hiddenIds) {
      const win = this.windowProvider.fromId(id);
      if (win && !win.isDestroyed()) {
        win.show();
      }
    }

    // Return to previous state based on entry mode
    this.state = this.session.entryMode;
    this.session.overlayWindowId = null;
    this.session.hiddenWindowIds = [];
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
