/**
 * Unit tests for IZUI State Coordinator
 * Tests the state machine managing transient vs active state for windows
 *
 * Key behaviors tested:
 * - Transient detection based on window focus
 * - Session lifecycle management
 * - Window stack management
 * - Overlay mode
 * - Focus tracking
 */

import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import type { WindowProvider } from './izui-state.js';

// Mock window interface
interface MockWindow {
  id: number;
  _destroyed: boolean;
  _focused: boolean;
  _visible: boolean;
  _url: string;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isVisible: () => boolean;
  show: () => void;
  showInactive: () => void;
  /** Records whether the window was last surfaced via show() (activates) or
   *  showInactive() (doesn't pull user across Spaces). Tests for the
   *  active-Space-preservation path assert this. */
  _lastShowMode: 'show' | 'showInactive' | null;
  webContents: { getURL: () => string };
}

function createMockWindow(id: number, options: { focused?: boolean; destroyed?: boolean; url?: string; visible?: boolean } = {}): MockWindow {
  const win: MockWindow = {
    id,
    _destroyed: options.destroyed ?? false,
    _focused: options.focused ?? false,
    _visible: options.visible ?? true,
    _url: options.url ?? `peek://test/window-${id}.html`,
    _lastShowMode: null,
    isDestroyed: function() { return this._destroyed; },
    isFocused: function() { return this._focused; },
    isVisible: function() { return this._visible; },
    show: function() { this._visible = true; this._lastShowMode = 'show'; },
    showInactive: function() { this._visible = true; this._lastShowMode = 'showInactive'; },
    webContents: { getURL: function() { return win._url; } },
  };
  return win;
}

// Create a mock window provider for testing
function createMockWindowProvider(windows: MockWindow[]): WindowProvider {
  return {
    getAllWindows: () => windows,
    fromId: (id: number) => windows.find(w => w.id === id) || null,
  };
}

// Import will be done after build
let izuiState: typeof import('./izui-state.js');

describe('IZUI State Coordinator Tests', () => {
  let mockWindows: MockWindow[];

  before(async () => {
    // Dynamic import of the compiled module
    izuiState = await import('./izui-state.js');
  });

  beforeEach(() => {
    // Clear mock windows before each test
    mockWindows = [];
    // Reset all state (session, appFocused, etc.)
    const coordinator = izuiState.getIzuiCoordinator();
    coordinator._resetAll();
    coordinator._setWindowProvider(createMockWindowProvider(mockWindows));
  });

  describe('evaluateOnShow', () => {
    it('should return active when app has OS-level focus', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // appFocused defaults to true (app startup)
      const result = coordinator.evaluateOnShow();
      assert.strictEqual(result, 'active');
    });

    it('should return transient when app does NOT have OS-level focus', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.setAppFocused(false); // User is in another app
      const result = coordinator.evaluateOnShow();
      assert.strictEqual(result, 'transient');
    });

    it('should return active at app startup (appFocused defaults to true)', () => {
      // At startup, app is focused even though no content windows exist yet
      const coordinator = izuiState.getIzuiCoordinator();
      // Don't call setAppFocused - verify default is active
      const result = coordinator.evaluateOnShow();
      assert.strictEqual(result, 'active');
    });

    it('should implement one-way ratchet: transient -> active, never active -> transient', () => {
      const coordinator = izuiState.getIzuiCoordinator();

      // Start transient (app not focused)
      coordinator.setAppFocused(false);
      coordinator.evaluateOnShow();
      assert.strictEqual(coordinator.getSession()!.entryMode, 'transient');

      // User focuses Peek (app gains focus)
      coordinator.setAppFocused(true);
      coordinator.evaluateOnShow();
      // Should promote from transient to active
      assert.strictEqual(coordinator.getSession()!.entryMode, 'active');

      // User switches to another app
      coordinator.setAppFocused(false);
      coordinator.evaluateOnShow();
      // Should NOT downgrade from active to transient (one-way ratchet)
      assert.strictEqual(coordinator.getSession()!.entryMode, 'active');
    });

    it('should start a session if none exists', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator.getSession(), null, 'No session should exist initially');

      coordinator.evaluateOnShow();

      assert.ok(coordinator.getSession(), 'Session should be created');
    });

    it('should not downgrade active session to transient (one-way ratchet)', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      const originalSessionId = coordinator.getSession()!.id;

      // User switches to another app
      coordinator.setAppFocused(false);
      coordinator.evaluateOnShow();

      const session = coordinator.getSession();
      assert.strictEqual(session!.id, originalSessionId, 'Should be same session');
      assert.strictEqual(session!.entryMode, 'active', 'Entry mode should NOT be downgraded');
    });
  });

  describe('isTransient', () => {
    it('should return false when no session exists', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator.isTransient(), false);
    });

    it('should return true when session.entryMode is transient', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('transient');
      assert.strictEqual(coordinator.isTransient(), true);
    });

    it('should return false when session.entryMode is active', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      assert.strictEqual(coordinator.isTransient(), false);
    });

    it('should persist transient state even after windows are pushed', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.setAppFocused(false); // App not focused
      coordinator.evaluateOnShow(); // Starts as transient
      coordinator.pushWindow(1);

      coordinator.pushWindow(2);

      // Session should still be transient (pushWindow doesn't re-evaluate)
      assert.strictEqual(coordinator.isTransient(), true);
    });
  });

  describe('startSession and endSession', () => {
    it('should create a new session with startSession', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      const session = coordinator.getSession();
      assert.ok(session, 'Session should exist');
      assert.ok(session!.id.startsWith('izui-'), 'Session ID should have correct prefix');
      assert.strictEqual(session!.entryMode, 'active');
      assert.deepStrictEqual(session!.windowStack, []);
      assert.strictEqual(session!.overlayWindowId, null);
      assert.deepStrictEqual(session!.hiddenWindowIds, []);
      assert.strictEqual(session!.focusedWindowId, null);
    });

    it('should not create a new session if one already exists', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      const firstSessionId = coordinator.getSession()!.id;

      coordinator.startSession('transient'); // Should be ignored

      assert.strictEqual(coordinator.getSession()!.id, firstSessionId);
      assert.strictEqual(coordinator.getSession()!.entryMode, 'active'); // Not changed to transient
    });

    it('should clear session with endSession', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      assert.ok(coordinator.getSession());

      coordinator.endSession();

      assert.strictEqual(coordinator.getSession(), null);
      assert.strictEqual(coordinator.getState(), 'idle');
    });

    it('should handle endSession when no session exists', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // Should not throw
      coordinator.endSession();
      assert.strictEqual(coordinator.getSession(), null);
    });

    it('should set state to entryMode when starting session', () => {
      const coordinator = izuiState.getIzuiCoordinator();

      coordinator.startSession('transient');
      assert.strictEqual(coordinator.getState(), 'transient');

      coordinator.endSession();

      coordinator.startSession('active');
      assert.strictEqual(coordinator.getState(), 'active');
    });
  });

  describe('pushWindow and popWindow', () => {
    it('should add window to stack with pushWindow', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      coordinator.pushWindow(1);
      coordinator.pushWindow(2);

      const session = coordinator.getSession()!;
      assert.deepStrictEqual(session.windowStack, [1, 2]);
    });

    it('should not add duplicate windows to stack', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      coordinator.pushWindow(1);
      coordinator.pushWindow(1); // Duplicate

      const session = coordinator.getSession()!;
      assert.deepStrictEqual(session.windowStack, [1]);
    });

    it('should not add window without active session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session started
      coordinator.pushWindow(1);

      // Should not throw, but also no session to verify
      assert.strictEqual(coordinator.getSession(), null);
    });

    it('should remove window from stack with popWindow', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);
      coordinator.pushWindow(3);

      coordinator.popWindow(2);

      const session = coordinator.getSession()!;
      assert.deepStrictEqual(session.windowStack, [1, 3]);
    });

    it('should auto-end session when stack becomes empty', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);

      coordinator.popWindow(1);
      assert.ok(coordinator.getSession(), 'Session should still exist');

      coordinator.popWindow(2);
      assert.strictEqual(coordinator.getSession(), null, 'Session should end when stack is empty');
      assert.strictEqual(coordinator.getState(), 'idle');
    });

    it('should handle popping non-existent window', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);

      // Pop window that's not in stack - should not throw
      coordinator.popWindow(99);

      const session = coordinator.getSession()!;
      assert.deepStrictEqual(session.windowStack, [1]);
    });

    it('should handle popWindow without session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session - should not throw
      coordinator.popWindow(1);
      assert.strictEqual(coordinator.getSession(), null);
    });
  });

  describe('enterOverlay and exitOverlay', () => {
    it('should enter overlay mode', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      coordinator.enterOverlay(100, [1, 2, 3]);

      assert.strictEqual(coordinator.getState(), 'overlay');
      assert.strictEqual(coordinator.isOverlay(), true);

      const session = coordinator.getSession()!;
      assert.strictEqual(session.overlayWindowId, 100);
      assert.deepStrictEqual(session.hiddenWindowIds, [1, 2, 3]);
    });

    it('should not enter overlay without active session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session

      coordinator.enterOverlay(100, [1, 2, 3]);

      assert.strictEqual(coordinator.isOverlay(), false);
      assert.strictEqual(coordinator.getState(), 'idle');
    });

    it('should exit overlay mode and restore hidden windows', () => {
      // Set up mock windows that will be "hidden"
      const hiddenWindow1 = createMockWindow(1);
      const hiddenWindow2 = createMockWindow(2);
      hiddenWindow1._visible = false;
      hiddenWindow2._visible = false;
      mockWindows.push(hiddenWindow1, hiddenWindow2);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.enterOverlay(100, [1, 2]);

      coordinator.exitOverlay();

      assert.strictEqual(coordinator.isOverlay(), false);
      assert.strictEqual(coordinator.getState(), 'active');
      assert.ok(hiddenWindow1._visible, 'Window 1 should be shown');
      assert.ok(hiddenWindow2._visible, 'Window 2 should be shown');

      const session = coordinator.getSession()!;
      assert.strictEqual(session.overlayWindowId, null);
      assert.deepStrictEqual(session.hiddenWindowIds, []);
    });

    it('restores hidden windows via showInactive() to preserve the user\'s active macOS Space', () => {
      // Regression: previously this used .show(), which activates the
      // window and pulls macOS to its Space. With hidden windows living
      // across multiple Spaces, restoration was yanking the user to
      // whichever Space the last-iterated window happens to belong to.
      // The caller (main.ts overlay-closed handler) issues an explicit
      // .focus() on the chosen target afterward — that's the right
      // place to deterministically pick the Space to land on.
      const hiddenWindow1 = createMockWindow(1);
      const hiddenWindow2 = createMockWindow(2);
      hiddenWindow1._visible = false;
      hiddenWindow2._visible = false;
      mockWindows.push(hiddenWindow1, hiddenWindow2);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.enterOverlay(100, [1, 2]);

      coordinator.exitOverlay();

      assert.strictEqual(hiddenWindow1._lastShowMode, 'showInactive',
        'Window 1 must be restored via showInactive(), not show()');
      assert.strictEqual(hiddenWindow2._lastShowMode, 'showInactive',
        'Window 2 must be restored via showInactive(), not show()');
    });

    it('exitOverlayForAppBlur also restores via showInactive()', () => {
      // Same reasoning as the regular exit path — when the user has
      // Cmd+Tab'd to another app, we must not yank focus back via .show().
      const hiddenWindow = createMockWindow(1);
      hiddenWindow._visible = false;
      mockWindows.push(hiddenWindow);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.enterOverlay(100, [1]);

      coordinator.exitOverlayForAppBlur();

      assert.strictEqual(hiddenWindow._lastShowMode, 'showInactive',
        'app-blur path must use showInactive() (matches docstring)');
    });

    it('should return to transient state after overlay if session was transient', () => {
      mockWindows.push(createMockWindow(1));

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('transient');
      coordinator.enterOverlay(100, [1]);

      assert.strictEqual(coordinator.getState(), 'overlay');

      coordinator.exitOverlay();

      assert.strictEqual(coordinator.getState(), 'transient');
    });

    it('should not exit overlay when not in overlay mode', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      // Not in overlay mode

      coordinator.exitOverlay(); // Should not throw

      assert.strictEqual(coordinator.getState(), 'active');
    });

    it('should handle exitOverlay with no session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session

      coordinator.exitOverlay(); // Should not throw

      assert.strictEqual(coordinator.getSession(), null);
    });

    it('should not restore destroyed windows on exitOverlay', () => {
      const destroyedWindow = createMockWindow(1, { destroyed: true });
      destroyedWindow._visible = false;
      mockWindows.push(destroyedWindow);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.enterOverlay(100, [1]);

      coordinator.exitOverlay();

      // Destroyed window should not have show() called (and therefore still not visible)
      assert.strictEqual(destroyedWindow._visible, false);
    });
  });

  describe('isOverlay', () => {
    it('should return false when not in overlay mode', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator.isOverlay(), false);

      coordinator.startSession('active');
      assert.strictEqual(coordinator.isOverlay(), false);
    });

    it('should return true when in overlay mode', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.enterOverlay(100, []);

      assert.strictEqual(coordinator.isOverlay(), true);
    });
  });

  describe('setFocusedWindow and clearFocusedWindow', () => {
    it('should track focused window in session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      coordinator.setFocusedWindow(42);

      const session = coordinator.getSession()!;
      assert.strictEqual(session.focusedWindowId, 42);
    });

    it('should update focused window', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      coordinator.setFocusedWindow(1);
      coordinator.setFocusedWindow(2);

      const session = coordinator.getSession()!;
      assert.strictEqual(session.focusedWindowId, 2);
    });

    it('should not crash when setting focused window without session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session
      coordinator.setFocusedWindow(1); // Should not throw
    });

    it('should clear focused window if it matches', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.setFocusedWindow(42);

      coordinator.clearFocusedWindow(42);

      const session = coordinator.getSession()!;
      assert.strictEqual(session.focusedWindowId, null);
    });

    it('should not clear focused window if it does not match', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.setFocusedWindow(42);

      coordinator.clearFocusedWindow(99); // Different ID

      const session = coordinator.getSession()!;
      assert.strictEqual(session.focusedWindowId, 42); // Unchanged
    });

    it('should not crash when clearing focused window without session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session
      coordinator.clearFocusedWindow(1); // Should not throw
    });

    it('should return focused window ID via getFocusedWindowId', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.setFocusedWindow(123);

      assert.strictEqual(coordinator.getFocusedWindowId(), 123);
    });

    it('should return null from getFocusedWindowId when no session', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator.getFocusedWindowId(), null);
    });
  });

  describe('getState', () => {
    it('should return idle initially', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.endSession(); // Ensure clean state
      assert.strictEqual(coordinator.getState(), 'idle');
    });

    it('should return active when session started as active', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      assert.strictEqual(coordinator.getState(), 'active');
    });

    it('should return transient when session started as transient', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('transient');
      assert.strictEqual(coordinator.getState(), 'transient');
    });

    it('should return overlay when in overlay mode', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.enterOverlay(1, []);
      assert.strictEqual(coordinator.getState(), 'overlay');
    });

    it('should return idle after session ends', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.endSession();
      assert.strictEqual(coordinator.getState(), 'idle');
    });
  });

  describe('getEffectiveMode', () => {
    it('should return default for transient sessions', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('transient');

      assert.strictEqual(coordinator.getEffectiveMode(), 'default');
    });

    it('should return active for active sessions', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      assert.strictEqual(coordinator.getEffectiveMode(), 'active');
    });

    it('should return active when no session (isTransient returns false)', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      // No session - isTransient() returns false, so this returns 'active'
      assert.strictEqual(coordinator.getEffectiveMode(), 'active');
    });
  });

  describe('Session persistence across windows', () => {
    it('should maintain transient mode when opening windows from transient session', () => {
      // Simulate: user invokes cmd bar via global hotkey (app not focused)
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.setAppFocused(false);

      // Cmd bar evaluates on show - detects transient (app not focused)
      const entryMode = coordinator.evaluateOnShow();
      assert.strictEqual(entryMode, 'transient');

      // User opens a window from cmd bar
      coordinator.pushWindow(100);

      // Session is still transient (pushWindow doesn't re-evaluate)
      assert.strictEqual(coordinator.isTransient(), true);

      // User opens another window from that window
      coordinator.pushWindow(101);

      // Session is still transient
      assert.strictEqual(coordinator.isTransient(), true);

      // ESC should close everything in transient mode
      assert.strictEqual(coordinator.getSession()!.entryMode, 'transient');
    });

    it('should maintain active mode when user is working within app', () => {
      // Simulate: user is working in Peek (app focused), opens cmd bar
      const coordinator = izuiState.getIzuiCoordinator();
      // appFocused defaults to true

      // Cmd bar evaluates on show - detects active (app focused)
      const entryMode = coordinator.evaluateOnShow();
      assert.strictEqual(entryMode, 'active');

      coordinator.pushWindow(100); // cmd bar

      // Session is active
      assert.strictEqual(coordinator.isTransient(), false);

      // User opens a window from cmd bar
      coordinator.pushWindow(200);

      // Session is still active
      assert.strictEqual(coordinator.isTransient(), false);
    });
  });

  describe('Complex workflow scenarios', () => {
    it('should handle full transient workflow: invoke, pick, close', () => {
      const coordinator = izuiState.getIzuiCoordinator();

      // 1. App not focused - user invokes via global hotkey
      coordinator.setAppFocused(false);

      // 2. Cmd bar opens and evaluates state
      const entryMode = coordinator.evaluateOnShow();
      assert.strictEqual(entryMode, 'transient');
      coordinator.pushWindow(10); // cmd bar window

      // 3. User triggers windows picker (overlay)
      const hiddenWindow = createMockWindow(10);
      hiddenWindow._visible = false;
      mockWindows.length = 0;
      mockWindows.push(hiddenWindow);

      coordinator.enterOverlay(20, [10]);
      assert.strictEqual(coordinator.isOverlay(), true);
      assert.strictEqual(coordinator.isTransient(), true); // Still transient at entry

      // 4. User presses ESC - exit overlay
      coordinator.exitOverlay();
      assert.strictEqual(coordinator.isOverlay(), false);
      assert.ok(hiddenWindow._visible, 'Cmd bar should be shown again');

      // 5. User presses ESC again - close everything (in transient mode)
      coordinator.popWindow(10);
      assert.strictEqual(coordinator.getSession(), null);
      assert.strictEqual(coordinator.getState(), 'idle');
    });

    it('should handle full active workflow: work, invoke, navigate back', () => {
      const coordinator = izuiState.getIzuiCoordinator();

      // 1. User is working in Peek (app focused)
      // appFocused defaults to true
      coordinator.startSession('active');
      coordinator.pushWindow(50);

      // 2. User invokes cmd bar (app still focused)
      const entryMode = coordinator.evaluateOnShow();
      assert.strictEqual(entryMode, 'active');
      coordinator.pushWindow(100);

      // 3. User types and selects something, opening new window
      coordinator.pushWindow(200);

      // 4. ESC in active mode just navigates, doesn't close
      // (state remains active)
      assert.strictEqual(coordinator.isTransient(), false);
      assert.strictEqual(coordinator.getState(), 'active');

      // 5. User manually closes windows one by one
      coordinator.popWindow(200);
      assert.ok(coordinator.getSession());

      coordinator.popWindow(100);
      assert.ok(coordinator.getSession());

      coordinator.popWindow(50);
      // Session ends when last window closes
      assert.strictEqual(coordinator.getSession(), null);
    });
  });

  describe('getIzuiCoordinator singleton', () => {
    it('should return the same instance', () => {
      const coordinator1 = izuiState.getIzuiCoordinator();
      const coordinator2 = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator1, coordinator2);
    });
  });

  // The `escPolicy` / `escUnhandledPolicy` decision-table tests moved to
  // `window-state.test.ts` with the functions themselves (now `decideEscape`
  // step 6 in the reducer). The coordinator keeps only session idle/transient/
  // active + the switcher-overlay executor, tested below.

  describe('Pre-overlay focus tracking', () => {
    it('should preserve pre-overlay focus and restore on ESC (no explicit selection)', () => {
      // Open windows A (id=1) and B (id=2), focus B
      const winA = createMockWindow(1);
      const winB = createMockWindow(2);
      mockWindows.push(winA, winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);
      coordinator.setFocusedWindow(2); // B is focused

      // Enter overlay — should save pre-overlay focus
      coordinator.enterOverlay(100, [1, 2]);
      const session = coordinator.getSession()!;
      assert.strictEqual(session.preOverlayFocusTarget, 2,
        'preOverlayFocusTarget should be saved when entering overlay');
    });

    it('should clear preOverlayFocusTarget after exitOverlay', () => {
      const winA = createMockWindow(1);
      const winB = createMockWindow(2);
      mockWindows.push(winA, winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);
      coordinator.setFocusedWindow(2);

      coordinator.enterOverlay(100, [1, 2]);
      coordinator.exitOverlay();

      const session = coordinator.getSession()!;
      assert.strictEqual(session.preOverlayFocusTarget, null,
        'preOverlayFocusTarget should be cleared after exiting overlay');
    });

    it('should save null preOverlayFocusTarget when no window is focused', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      // No setFocusedWindow call

      coordinator.enterOverlay(100, [1]);
      const session = coordinator.getSession()!;
      assert.strictEqual(session.preOverlayFocusTarget, null,
        'preOverlayFocusTarget should be null when no window was focused');
    });

    it('should expose preOverlayFocusTarget via getPreOverlayFocusTarget()', () => {
      const winB = createMockWindow(2);
      mockWindows.push(winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(2);
      coordinator.setFocusedWindow(2);

      // Before overlay: should be null
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), null);

      coordinator.enterOverlay(100, [2]);

      // During overlay: should be 2
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 2);

      coordinator.exitOverlay();

      // After overlay exit: should be null
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), null);
    });
  });

  describe('Full ESC flow integration', () => {
    // The escPolicy/escUnhandledPolicy step tests moved to window-state.test.ts
    // (the reducer's `decideEscape` step 6). The overlay-restore flow below stays.

    it('overlay ESC without selection uses preOverlayFocusTarget', () => {
      const winA = createMockWindow(1);
      const winB = createMockWindow(2);
      winA._visible = false;
      winB._visible = false;
      mockWindows.push(winA, winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);
      coordinator.setFocusedWindow(2); // B was focused

      // Enter overlay, windows hidden
      coordinator.enterOverlay(100, [1, 2]);

      // Verify preOverlayFocusTarget is set
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 2);

      // Exit overlay (ESC without selection)
      coordinator.exitOverlay();

      // Windows restored
      assert.ok(winA._visible, 'Window A should be restored');
      assert.ok(winB._visible, 'Window B should be restored');

      // preOverlayFocusTarget was 2 (B) — caller (main.ts) uses this to focus B
      // After exitOverlay, preOverlayFocusTarget is cleared
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), null);
    });
  });

  describe('IZUI Coordinator as single source of truth for focus/overlay', () => {
    it('1. Focus tracking updates coordinator: setFocusedWindow(5) → getFocusedWindowId() returns 5', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);

      coordinator.setFocusedWindow(5);

      assert.strictEqual(coordinator.getFocusedWindowId(), 5);
    });

    it('2. Overlay tracks pre-overlay focus: setFocusedWindow(5) → enterOverlay → getPreOverlayFocusTarget() returns 5', () => {
      const winA = createMockWindow(5);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.setFocusedWindow(5);

      coordinator.enterOverlay(100, [5]);

      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 5);
    });

    it('3. ESC on switcher restores correct window: after overlay with preOverlayFocusTarget=5, exitOverlay → focus should go to 5', () => {
      const winA = createMockWindow(5);
      winA._visible = false;
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.setFocusedWindow(5);

      coordinator.enterOverlay(100, [5]);
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 5);

      // Read the target BEFORE exitOverlay (the caller in main.ts does this)
      const restoreTarget = coordinator.getSession()!.overlayFocusTarget || coordinator.getPreOverlayFocusTarget();

      coordinator.exitOverlay();

      // The target was 5, and exitOverlay restored the hidden window
      assert.strictEqual(restoreTarget, 5);
      assert.ok(winA._visible, 'Window 5 should be restored/shown');
      // State returns to active
      assert.strictEqual(coordinator.getState(), 'active');
    });

    it('4. User selection overrides pre-overlay: setOverlayFocusTarget(3) → restoration uses 3 not preOverlayFocusTarget', () => {
      const winA = createMockWindow(5);
      const winB = createMockWindow(3);
      winA._visible = false;
      winB._visible = false;
      mockWindows.push(winA, winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.pushWindow(3);
      coordinator.setFocusedWindow(5);

      coordinator.enterOverlay(100, [5, 3]);
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 5);

      // User explicitly selects window 3 in the switcher
      coordinator.setOverlayFocusTarget(3);
      assert.strictEqual(coordinator.getSession()!.overlayFocusTarget, 3);

      // Caller reads overlayFocusTarget first, falls back to preOverlayFocusTarget
      const restoreTarget = coordinator.getSession()!.overlayFocusTarget || coordinator.getPreOverlayFocusTarget();
      assert.strictEqual(restoreTarget, 3, 'Should use explicit selection (3), not pre-overlay (5)');
    });

    it('5. ESC works after switcher closes: after exitOverlay, state is active, focusedWindowId updated', () => {
      const winA = createMockWindow(5);
      winA._visible = false;
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.pushWindow(100);
      coordinator.setFocusedWindow(5);

      coordinator.enterOverlay(100, [5]);
      coordinator.exitOverlay();

      assert.strictEqual(coordinator.getState(), 'active');
      assert.strictEqual(coordinator.isOverlay(), false);
      // Caller can then set focus to restored window
      coordinator.setFocusedWindow(5);
      assert.strictEqual(coordinator.getFocusedWindowId(), 5);
    });

    it('6. Overlay does not corrupt focus tracking: overlay window ID never set as focusedWindowId', () => {
      const winA = createMockWindow(5);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.setFocusedWindow(5);

      // Enter overlay with window 100
      coordinator.enterOverlay(100, [5]);

      // The overlay window should NOT be set as the focused window
      // (In runtime, the focus handler checks role !== 'overlay' before calling setFocusedWindow)
      // Verify that focusedWindowId is still 5, not 100
      assert.strictEqual(coordinator.getFocusedWindowId(), 5);
      // And preOverlayFocusTarget captured correctly
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 5);
    });

    it('7. Session not prematurely ended: popWindow for overlay does not end session when content windows exist', () => {
      const winA = createMockWindow(5);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);   // content window
      coordinator.pushWindow(100); // overlay window

      // Overlay closes — popWindow should not end session since window 5 still exists
      coordinator.popWindow(100);

      assert.ok(coordinator.getSession(), 'Session should still exist');
      assert.deepStrictEqual(coordinator.getSession()!.windowStack, [5]);
    });

    it('8. Transient overlay does not restore: transient + overlay close = no window restore', () => {
      const winA = createMockWindow(5);
      winA._visible = false;
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('transient');
      coordinator.pushWindow(5);
      coordinator.setFocusedWindow(5);
      coordinator.enterOverlay(100, [5]);

      // In transient mode, the caller (main.ts) checks isTransient and does NOT call exitOverlay
      // to restore windows. Verify that session is still transient at entry.
      assert.strictEqual(coordinator.isTransient(), true);
      assert.strictEqual(coordinator.getState(), 'overlay');

      // The transient check means: DO NOT restore hidden windows.
      // The caller skips exitOverlay and instead just pops the overlay window.
      // Simulate that: don't call exitOverlay, just pop
      coordinator.popWindow(100);

      // Window 5 should NOT have been shown (no exitOverlay called)
      assert.strictEqual(winA._visible, false, 'Transient overlay should not restore hidden windows');
    });

    it('9. overlayFocusTarget cleared on exit: after exitOverlay, overlayFocusTarget is null', () => {
      const winA = createMockWindow(5);
      winA._visible = false;
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.pushWindow(100);
      coordinator.setFocusedWindow(5);

      coordinator.enterOverlay(100, [5]);
      coordinator.setOverlayFocusTarget(3);
      assert.strictEqual(coordinator.getSession()!.overlayFocusTarget, 3);

      coordinator.exitOverlay();

      assert.strictEqual(coordinator.getSession()!.overlayFocusTarget, null,
        'overlayFocusTarget should be cleared after exitOverlay');
    });

    it('10. Multiple ESC cycles work: enter overlay → exit → enter overlay → exit → state consistent', () => {
      const winA = createMockWindow(5);
      const winB = createMockWindow(6);
      mockWindows.push(winA, winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.pushWindow(6);
      coordinator.pushWindow(100); // overlay window stays in stack across cycles
      coordinator.setFocusedWindow(5);

      // Cycle 1: enter overlay → exit
      coordinator.enterOverlay(100, [5, 6]);
      assert.strictEqual(coordinator.getState(), 'overlay');
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 5);

      winA._visible = false;
      winB._visible = false;
      coordinator.exitOverlay();
      assert.strictEqual(coordinator.getState(), 'active');
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), null);
      assert.ok(winA._visible);
      assert.ok(winB._visible);

      // Cycle 2: enter overlay again → exit
      coordinator.setFocusedWindow(6); // Now 6 is focused
      coordinator.enterOverlay(100, [5, 6]);
      assert.strictEqual(coordinator.getState(), 'overlay');
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 6);

      winA._visible = false;
      winB._visible = false;
      coordinator.exitOverlay();
      assert.strictEqual(coordinator.getState(), 'active');
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), null);
      assert.ok(winA._visible);
      assert.ok(winB._visible);

      // Session still intact
      assert.ok(coordinator.getSession());
      assert.deepStrictEqual(coordinator.getSession()!.windowStack, [5, 6, 100]);
    });

    it('11. Overlay exit cooldown blocks immediate re-open: isWithinOverlayExitCooldown is true right after exitOverlay', () => {
      // Regression: after dismissing the windows-switcher overlay with ESC,
      // the ESC key lands on the workspace window. escUnhandledPolicy returns
      // open-switcher for workspace in an active session. Without the cooldown
      // check in handleEscapeForWindow the switcher re-opens immediately.
      // This test verifies the coordinator signals the cooldown correctly so
      // the caller can gate the switcher open.
      const winA = createMockWindow(5);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(5);
      coordinator.pushWindow(100);
      coordinator.setFocusedWindow(5);

      // Before overlay: no cooldown
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), false,
        'No cooldown before overlay opens');

      coordinator.enterOverlay(100, [5]);

      // Overlay open: still no exit cooldown (entry cooldown, not exit)
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), false,
        'No exit cooldown while overlay is open');

      // Overlay closes via ESC (exitOverlay called by closed-event handler)
      coordinator.exitOverlay();

      // Immediately after: exit cooldown active — workspace ESC must NOT open switcher
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), true,
        'Exit cooldown must be active right after exitOverlay to block re-open');

      // With a 0ms custom cooldown the check confirms we are past a zero-width window
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(0), false,
        'isWithinOverlayExitCooldown(0) false — confirms cooldown is time-based');

      // State is back to active (the switcher should stay closed, not reopen)
      assert.strictEqual(coordinator.getState(), 'active');
    });
  });

  describe('exitOverlayForAppBlur', () => {
    it('should restore hidden windows without setting focus target', () => {
      const winA = createMockWindow(1);
      const winB = createMockWindow(2);
      winA._visible = false;
      winB._visible = false;
      mockWindows.push(winA, winB);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);
      coordinator.setFocusedWindow(2);

      coordinator.enterOverlay(100, [1, 2]);
      assert.strictEqual(coordinator.getPreOverlayFocusTarget(), 2);

      // App blur exit — restores windows but clears focus targets
      coordinator.exitOverlayForAppBlur();

      // Windows should be restored (shown)
      assert.ok(winA._visible, 'Window A should be restored after app blur');
      assert.ok(winB._visible, 'Window B should be restored after app blur');

      // State should return to previous (active)
      assert.strictEqual(coordinator.getState(), 'active');
      assert.strictEqual(coordinator.isOverlay(), false);

      // Focus targets should be cleared — no window should be focused
      const session = coordinator.getSession()!;
      assert.strictEqual(session.preOverlayFocusTarget, null,
        'preOverlayFocusTarget should be cleared (no focus on app blur)');
      assert.strictEqual(session.overlayFocusTarget, null,
        'overlayFocusTarget should be cleared (no focus on app blur)');
    });

    it('should not restore windows when not in overlay mode', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');

      // Not in overlay mode — should be a no-op
      coordinator.exitOverlayForAppBlur();

      assert.strictEqual(coordinator.getState(), 'active');
    });

    it('should set lastOverlayExitTime for cooldown', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      const beforeTime = Date.now();
      coordinator.exitOverlayForAppBlur();
      const afterTime = Date.now();

      const exitTime = coordinator.getLastOverlayExitTime();
      assert.ok(exitTime >= beforeTime && exitTime <= afterTime,
        'lastOverlayExitTime should be set to current time');
    });
  });

  describe('Overlay exit cooldown', () => {
    it('should not be in cooldown initially', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), false);
    });

    it('should be in cooldown immediately after exitOverlay', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      coordinator.exitOverlay();

      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), true,
        'Should be in cooldown right after overlay exit');
    });

    it('should be in cooldown immediately after exitOverlayForAppBlur', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      coordinator.exitOverlayForAppBlur();

      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), true,
        'Should be in cooldown right after app blur overlay exit');
    });

    it('should accept custom cooldown duration', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      coordinator.exitOverlay();

      // With a very short cooldown, should still be in cooldown (just exited)
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(1000), true);
      // With a 0ms cooldown, should NOT be in cooldown
      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(0), false);
    });

    it('should be cleared after _resetAll', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);
      coordinator.exitOverlay();

      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), true);

      coordinator._resetAll();
      coordinator._setWindowProvider(createMockWindowProvider(mockWindows));

      assert.strictEqual(coordinator.isWithinOverlayExitCooldown(), false,
        'Cooldown should be cleared after _resetAll');
    });
  });

  describe('Overlay entry cooldown', () => {
    it('should not be in cooldown initially', () => {
      const coordinator = izuiState.getIzuiCoordinator();
      assert.strictEqual(coordinator.isWithinOverlayEntryCooldown(), false);
    });

    it('should be in cooldown immediately after enterOverlay', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      assert.strictEqual(coordinator.isWithinOverlayEntryCooldown(), true,
        'Should be in cooldown right after overlay entry');
    });

    it('should accept custom cooldown duration', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      // With a very long cooldown, should be in cooldown (just entered)
      assert.strictEqual(coordinator.isWithinOverlayEntryCooldown(1000), true);
      // With a 0ms cooldown, should NOT be in cooldown
      assert.strictEqual(coordinator.isWithinOverlayEntryCooldown(0), false);
    });

    it('should be cleared after _resetAll', () => {
      const winA = createMockWindow(1);
      mockWindows.push(winA);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.enterOverlay(100, [1]);

      assert.strictEqual(coordinator.isWithinOverlayEntryCooldown(), true);

      coordinator._resetAll();
      coordinator._setWindowProvider(createMockWindowProvider(mockWindows));

      assert.strictEqual(coordinator.isWithinOverlayEntryCooldown(), false,
        'Entry cooldown should be cleared after _resetAll');
    });
  });

  describe('State is clean after both overlay close paths', () => {
    it('should have identical state after exitOverlay vs exitOverlayForAppBlur', () => {
      // Path 1: normal exitOverlay
      const win1 = createMockWindow(1);
      mockWindows.length = 0;
      mockWindows.push(win1);

      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(100);
      coordinator.setFocusedWindow(1);
      coordinator.enterOverlay(100, [1]);
      coordinator.exitOverlay();

      const stateAfterNormal = coordinator.getState();
      const sessionAfterNormal = coordinator.getSession();
      const overlayAfterNormal = coordinator.isOverlay();

      // Reset for path 2
      coordinator._resetAll();
      coordinator._setWindowProvider(createMockWindowProvider(mockWindows));
      win1._visible = false;

      // Path 2: app blur exitOverlay
      coordinator.startSession('active');
      coordinator.pushWindow(1);
      coordinator.pushWindow(100);
      coordinator.setFocusedWindow(1);
      coordinator.enterOverlay(100, [1]);
      coordinator.exitOverlayForAppBlur();

      const stateAfterBlur = coordinator.getState();
      const sessionAfterBlur = coordinator.getSession();
      const overlayAfterBlur = coordinator.isOverlay();

      // Both paths should leave identical coordinator state
      assert.strictEqual(stateAfterNormal, stateAfterBlur,
        'State should be the same after both exit paths');
      assert.strictEqual(overlayAfterNormal, overlayAfterBlur,
        'isOverlay should be the same after both exit paths');
      assert.ok(sessionAfterNormal, 'Session should exist after normal exit');
      assert.ok(sessionAfterBlur, 'Session should exist after app blur exit');
      assert.strictEqual(sessionAfterNormal!.overlayWindowId, sessionAfterBlur!.overlayWindowId,
        'overlayWindowId should be null in both');
      assert.deepStrictEqual(sessionAfterNormal!.hiddenWindowIds, sessionAfterBlur!.hiddenWindowIds,
        'hiddenWindowIds should be empty in both');
    });
  });
});
