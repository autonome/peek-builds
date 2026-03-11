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
  webContents: { getURL: () => string };
}

function createMockWindow(id: number, options: { focused?: boolean; destroyed?: boolean; url?: string; visible?: boolean } = {}): MockWindow {
  const win: MockWindow = {
    id,
    _destroyed: options.destroyed ?? false,
    _focused: options.focused ?? false,
    _visible: options.visible ?? true,
    _url: options.url ?? `peek://ext/test/window-${id}.html`,
    isDestroyed: function() { return this._destroyed; },
    isFocused: function() { return this._focused; },
    isVisible: function() { return this._visible; },
    show: function() { this._visible = true; },
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

// Import escPolicy and escUnhandledPolicy from the shared module (pure functions, no Electron deps)
// At runtime (from dist/backend/electron/) the path is ../../../app/lib/izui-state.js
let escPolicy: (sessionState: string, role: string) => 'close' | 'close-and-restore' | 'nothing';
let escUnhandledPolicy: (sessionState: string, role: string) => 'open-switcher' | 'nothing';

describe('IZUI State Coordinator Tests', () => {
  let mockWindows: MockWindow[];

  before(async () => {
    // Dynamic import of the compiled module
    izuiState = await import('./izui-state.js');
    // Import escPolicy from shared module (pure function, no Electron deps)
    // @ts-expect-error — shared JS module in app/lib, no .d.ts in tsconfig rootDir
    const shared = await import('../../../app/lib/izui-state.js');
    escPolicy = shared.escPolicy;
    escUnhandledPolicy = shared.escUnhandledPolicy;
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

  describe('escPolicy', () => {
    // Transient UI roles always close regardless of session state
    it('should close quick-view in any session state', () => {
      assert.strictEqual(escPolicy('active', 'quick-view'), 'close');
      assert.strictEqual(escPolicy('transient', 'quick-view'), 'close');
      assert.strictEqual(escPolicy('idle', 'quick-view'), 'close');
    });

    it('should close palette in any session state', () => {
      assert.strictEqual(escPolicy('active', 'palette'), 'close');
      assert.strictEqual(escPolicy('transient', 'palette'), 'close');
      assert.strictEqual(escPolicy('idle', 'palette'), 'close');
    });

    it('should close utility in any session state', () => {
      assert.strictEqual(escPolicy('active', 'utility'), 'close');
      assert.strictEqual(escPolicy('transient', 'utility'), 'close');
      assert.strictEqual(escPolicy('idle', 'utility'), 'close');
    });

    it('should close-and-restore overlay in any session state', () => {
      assert.strictEqual(escPolicy('active', 'overlay'), 'close-and-restore');
      assert.strictEqual(escPolicy('transient', 'overlay'), 'close-and-restore');
      assert.strictEqual(escPolicy('idle', 'overlay'), 'close-and-restore');
    });

    // Content roles: close in transient, nothing in active
    it('should close content in transient session', () => {
      assert.strictEqual(escPolicy('transient', 'content'), 'close');
    });

    it('should NOT close content in active session', () => {
      assert.strictEqual(escPolicy('active', 'content'), 'nothing');
    });

    // REGRESSION TEST: workspace must NEVER close on ESC regardless of session state.
    // Workspace windows are root/persistent extension windows (groups, search, etc.)
    // that should never be dismissed by the backend ESC policy.
    it('should NOT close workspace in transient session (regression test)', () => {
      assert.strictEqual(escPolicy('transient', 'workspace'), 'nothing',
        'workspace windows must never close on ESC — they are root/persistent extension windows');
    });

    it('should NOT close workspace in active session', () => {
      assert.strictEqual(escPolicy('active', 'workspace'), 'nothing');
    });

    // REGRESSION TEST: child-content must NOT close in active sessions
    // This was a bug where child-content always returned 'close' regardless
    // of session state, causing root-level content windows to close on ESC
    // when the user was actively working in the app.
    it('should close child-content in transient session', () => {
      assert.strictEqual(escPolicy('transient', 'child-content'), 'close');
    });

    it('should NOT close child-content in active session (regression test)', () => {
      assert.strictEqual(escPolicy('active', 'child-content'), 'nothing',
        'child-content windows must not close on ESC in active sessions — ' +
        'they are user-opened content, not transient UI');
    });

    it('should NOT close child-content in idle session', () => {
      assert.strictEqual(escPolicy('idle', 'child-content'), 'nothing');
    });

    // Idle state: content roles should not close
    it('should NOT close content in idle state', () => {
      assert.strictEqual(escPolicy('idle', 'content'), 'nothing');
    });

    it('should NOT close workspace in idle state', () => {
      assert.strictEqual(escPolicy('idle', 'workspace'), 'nothing');
    });
  });

  describe('ESC on root content window in active session (regression)', () => {
    it('should not close a content window when session is active', () => {
      // Simulate: user is working in Peek (active session), has a content window open
      const coordinator = izuiState.getIzuiCoordinator();
      // appFocused defaults to true → active session
      coordinator.evaluateOnShow();
      coordinator.pushWindow(1); // workspace window
      coordinator.pushWindow(2); // content window opened from workspace

      // Verify session is active
      assert.strictEqual(coordinator.getState(), 'active');
      assert.strictEqual(coordinator.isTransient(), false);

      // escPolicy for child-content in active session should be 'nothing'
      const action = escPolicy(coordinator.getState(), 'child-content');
      assert.strictEqual(action, 'nothing',
        'ESC on child-content in active session must return nothing (not close)');

      // Same for plain content role
      const contentAction = escPolicy(coordinator.getState(), 'content');
      assert.strictEqual(contentAction, 'nothing');
    });

    it('should close a content window when session is transient', () => {
      // Simulate: user invoked from background (transient session)
      const coordinator = izuiState.getIzuiCoordinator();
      coordinator.setAppFocused(false);
      coordinator.evaluateOnShow();
      coordinator.pushWindow(1);
      coordinator.pushWindow(2);

      // Verify session is transient
      assert.strictEqual(coordinator.getState(), 'transient');
      assert.strictEqual(coordinator.isTransient(), true);

      // In transient mode, ESC should close content roles but NOT workspace
      assert.strictEqual(escPolicy(coordinator.getState(), 'child-content'), 'close');
      assert.strictEqual(escPolicy(coordinator.getState(), 'content'), 'close');
      assert.strictEqual(escPolicy(coordinator.getState(), 'workspace'), 'nothing',
        'workspace windows must never close on ESC, even in transient sessions');
    });
  });

  describe('escUnhandledPolicy', () => {
    it('should open switcher for workspace in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'workspace'), 'open-switcher');
    });

    it('should open switcher for workspace in idle session', () => {
      assert.strictEqual(escUnhandledPolicy('idle', 'workspace'), 'open-switcher');
    });

    it('should NOT open switcher for workspace in transient session', () => {
      assert.strictEqual(escUnhandledPolicy('transient', 'workspace'), 'nothing',
        'transient sessions should not trigger switcher — user expects ESC to return to previous app');
    });

    it('should NOT open switcher for workspace in overlay session', () => {
      assert.strictEqual(escUnhandledPolicy('overlay', 'workspace'), 'nothing');
    });

    it('should NOT open switcher for content in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'content'), 'nothing');
    });

    it('should NOT open switcher for child-content in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'child-content'), 'nothing');
    });

    it('should NOT open switcher for overlay role in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'overlay'), 'nothing');
    });

    it('should NOT open switcher for palette in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'palette'), 'nothing');
    });

    it('should NOT open switcher for utility in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'utility'), 'nothing');
    });

    it('should NOT open switcher for quick-view in active session', () => {
      assert.strictEqual(escUnhandledPolicy('active', 'quick-view'), 'nothing');
    });
  });
});
