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
 * | OVERLAY   | Inherit from previous| Always close                   |
 */

import { DEBUG } from './config.js';

export type IzuiState = 'idle' | 'transient' | 'active' | 'overlay';

export interface IzuiSession {
  id: string;
  entryMode: 'active' | 'transient';
  windowStack: number[];
  overlayWindowId: number | null;
  hiddenWindowIds: number[];
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

  // App-active fact provider: real-time "is Peek the OS-focused app"
  // — INJECTED, not imported, same one-way pattern as
  // `frontWindowIdProvider` below. Wired once at boot by `window-machine.ts
  // seedSessionMirror` to `getAppActive()`, the kernel's own app-active
  // mirror (fed by `electron-window-backend.ts attachAppListeners`'
  // did-become/resign-active listeners — "THE copy; no module may keep its
  // own did-resign-active mirror," per that function's doc). This
  // coordinator used to keep such a mirror itself (`appFocused`, fed
  // straight off `app.on('did-become-active'/…)` in main.ts); that was a
  // second copy of the same OS fact and is gone. `null` before boot wiring
  // runs (or in an unseeded unit test) reads as focused, matching the old
  // mirror's construction-time default (Peek IS the active app at launch).
  private appActiveProvider: (() => boolean) | null = null;

  /** Register (or clear, with null) the app-active fact provider. */
  setAppActiveProvider(provider: (() => boolean) | null): void {
    this.appActiveProvider = provider;
  }

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

  // Session-change notifier. The window-state machine mirrors this coordinator's
  // idle/transient/active tri-state via `SESSION_CHANGED` (staged cutover: the
  // coordinator stays the single session authority; the reducer only records
  // what it is told, for `decideEscape` step 6). Seeded once at boot by
  // `window-machine.ts`. One-way — this module never imports the machine.
  private sessionChangeListener: ((state: IzuiState) => void) | null = null;

  /** Register (or clear, with null) the session-change mirror callback. */
  onSessionChange(cb: ((state: IzuiState) => void) | null): void {
    this.sessionChangeListener = cb;
  }

  // Front-window provider: returns the NUMERIC Electron id of the window-state
  // machine's `front` (or null). Injected — not imported — because value-
  // importing `window-machine.ts` from here would (a) drag electron
  // into the electron-free unit run via `electron-window-backend.ts`, and
  // (b) create an import cycle (the singleton already value-imports this
  // module for the session mirror). Wired once at boot by
  // `window-machine.ts seedSessionMirror`, same one-way pattern as
  // `onSessionChange`. Stubbed directly in unit tests.
  private frontWindowIdProvider: (() => number | null) | null = null;

  /** Register (or clear, with null) the machine-front numeric-id provider. */
  setFrontWindowIdProvider(provider: (() => number | null) | null): void {
    this.frontWindowIdProvider = provider;
  }

  private emitSessionChange(): void {
    if (!this.sessionChangeListener) return;
    try {
      this.sessionChangeListener(this.state);
    } catch {
      /* a mirror subscriber throwing must not break session bookkeeping */
    }
  }

  /**
   * Notify the coordinator that Peek just regained OS-level app focus. Runs
   * the same one-way ratchet `evaluateOnShow` runs on the next window open —
   * promotes a transient session to active immediately, instead of waiting
   * for the next window to open, so a session left transient while the user
   * was away updates the instant they click back in.
   *
   * Wired by `window-machine.ts seedSessionMirror` to the kernel's
   * `subscribeAppActive` edge (the gained-focus transition only — losing
   * focus has no session-side effect of its own; `evaluateOnShow` reads the
   * live `appActiveProvider` on the next open regardless).
   */
  notifyAppActiveGained(): void {
    if (this.session && this.session.entryMode === 'transient') {
      this.session.entryMode = 'active';
      this.state = 'active';
      this.emitSessionChange();
      DEBUG && console.log('[izui] Promoted session from transient to active (app gained focus)');
    }
  }

  /**
   * Reset all state (for testing only)
   */
  _resetAll(): void {
    this.state = 'idle';
    this.session = null;
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
      preOverlayFocusTarget: null,
      overlayFocusTarget: null,
    };

    this.state = entryMode;
    this.emitSessionChange();
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
    this.emitSessionChange();
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
    // IZUI policy: app focused → active, app not focused → transient. The
    // fact comes from the injected `appActiveProvider` (see its doc) rather
    // than an OS-event mirror this module keeps itself. Unwired reads as
    // focused (app is active when launched / in headless mode, where no
    // real focus events fire).
    const appActive = this.appActiveProvider ? this.appActiveProvider() : true;
    const result = appActive ? 'active' : 'transient';

    DEBUG && console.log('[izui] evaluateOnShow:', result, 'appActive:', appActive);

    if (!this.session) {
      this.startSession(result);
    } else {
      // One-way ratchet: transient -> active is allowed, active -> transient is not.
      // Once a session becomes active (user is working in Peek), it stays active.
      if (this.session.entryMode === 'transient' && result === 'active') {
        this.session.entryMode = 'active';
        this.state = 'active';
        this.emitSessionChange();
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
    // Seed the focus-restore target from the window-state machine's `front`
    // (via the injected provider — see setFrontWindowIdProvider). The machine
    // is the sole focus authority; the coordinator's own focus tracker was
    // removed in step 8c of the window-manager migration.
    //
    // Ordering guarantee (why the seed can't be the overlay itself): the
    // switcher window registers with role 'overlay', which
    // `isSatelliteRegistration` (izui-roles.ts) marks satellite — and the
    // reducer structurally never lets a satellite become `front`
    // (`applyFocusGained` / `isEligibleFront`), nor does losing OS focus
    // clear `front` (OS_FOCUS_SETTLED_NULL keeps it: front is the TARGET,
    // not the key window). So even though the window-open path dispatches
    // WINDOW_SHOWN{focused:true} for the switcher BEFORE calling
    // enterOverlay, `front` still names the pre-overlay window here — the
    // same value SWITCHER_OPENED snapshots as `switcher.previousFront`.
    this.session.preOverlayFocusTarget = this.frontWindowIdProvider
      ? this.frontWindowIdProvider()
      : null;
    this.lastOverlayEntryTime = Date.now();
    this.emitSessionChange();
    console.log('[izui] Entered overlay mode, windowId:', windowId, 'hidden:', hiddenIds.length, 'preOverlayFocus:', this.session.preOverlayFocusTarget);
  }

  /**
   * Exit overlay mode. Used for user-initiated close (ESC or selection).
   */
  exitOverlay(): void {
    if (!this.session || this.state !== 'overlay') {
      DEBUG && console.log('[izui] Not in overlay mode');
      return;
    }

    DEBUG && console.log('[izui] Exiting overlay');

    // Return to previous state based on entry mode
    this.state = this.session.entryMode;
    this.session.overlayWindowId = null;
    this.session.hiddenWindowIds = [];
    this.session.preOverlayFocusTarget = null;
    this.session.overlayFocusTarget = null;
    this.lastOverlayExitTime = Date.now();
    this.emitSessionChange();
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

// ESC policy (`escPolicy` / `escUnhandledPolicy`) moved into
// `window-escape.ts interpretEscape` step 6 — that module is now the
// single ESC decider. This coordinator keeps ONLY the session tri-state
// (idle/transient/active), the overlay entry/exit cooldowns (wall-clock
// windows the kernel does not model — see `electron-window-backend.ts
// attachAppListeners`), and the switcher-overlay WINDOW teardown executor
// (enterOverlay/exitOverlay/…), which the machine invokes via the
// CLOSE_SWITCHER seam.

// Singleton instance
const coordinator = new IzuiStateCoordinator();

/**
 * Get the IZUI State Coordinator singleton
 */
export function getIzuiCoordinator(): IzuiStateCoordinator {
  return coordinator;
}

export { IzuiStateCoordinator };
