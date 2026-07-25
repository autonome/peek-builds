/**
 * Unit tests for the pure IZUI role module.
 *
 * Covers:
 *   - inferIzuiRole: how api.window.open params map to an IZUI role
 *   - TRANSIENT_ROLES: which roles are transient/overlay-class
 *   - spacesPolicyForRole: how IZUI role maps to macOS Spaces policy
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  inferIzuiRole,
  spacesPolicyForRole,
  shouldCloseContentWCOnFinalize,
  planBeforeQuit,
  type QuitCleanupPhase,
  shouldActivateFocusedOnRestore,
  windowSelfClosesOnBlur,
  hybridResizeDirAt,
  downloadCloseTarget,
  RESIZE_EDGE_PX,
  RESIZE_CORNER_PX,
  TRANSIENT_ROLES,
} from './izui-roles.js';

describe('inferIzuiRole', () => {
  it('returns the explicit role when caller provided one', () => {
    assert.strictEqual(
      inferIzuiRole({ role: 'utility' }, { isWebPage: false, parentWindowId: null }),
      'utility',
    );
  });

  it("returns 'overlay' when options.overlay is true", () => {
    assert.strictEqual(
      inferIzuiRole({ overlay: true }, { isWebPage: false, parentWindowId: null }),
      'overlay',
    );
  });

  it("returns 'palette' when modal + keepLive", () => {
    assert.strictEqual(
      inferIzuiRole({ modal: true, keepLive: true }, { isWebPage: false, parentWindowId: null }),
      'palette',
    );
  });

  it("returns 'quick-view' when modal alone", () => {
    assert.strictEqual(
      inferIzuiRole({ modal: true }, { isWebPage: false, parentWindowId: null }),
      'quick-view',
    );
  });

  it("returns 'workspace' when escapeMode is 'navigate'", () => {
    assert.strictEqual(
      inferIzuiRole({ escapeMode: 'navigate' }, { isWebPage: false, parentWindowId: null }),
      'workspace',
    );
  });

  it("returns 'child-content' when webpage opened from a real parent", () => {
    assert.strictEqual(
      inferIzuiRole({}, { isWebPage: true, parentWindowId: 7 }),
      'child-content',
    );
  });

  it("returns 'content' when webpage opened without parent", () => {
    assert.strictEqual(
      inferIzuiRole({}, { isWebPage: true, parentWindowId: null }),
      'content',
    );
  });

  it("defaults to 'workspace' for non-modal, non-webpage windows", () => {
    assert.strictEqual(
      inferIzuiRole({}, { isWebPage: false, parentWindowId: null }),
      'workspace',
    );
  });

  it("promotes explicit role:'content' to 'child-content' when parent present", () => {
    assert.strictEqual(
      inferIzuiRole({ role: 'content' }, { isWebPage: true, parentWindowId: 9 }),
      'child-content',
    );
  });

  it("does NOT promote 'content' when no parent", () => {
    assert.strictEqual(
      inferIzuiRole({ role: 'content' }, { isWebPage: true, parentWindowId: null }),
      'content',
    );
  });
});

describe('TRANSIENT_ROLES', () => {
  it('includes palette, quick-view, overlay', () => {
    assert.ok(TRANSIENT_ROLES.has('palette'));
    assert.ok(TRANSIENT_ROLES.has('quick-view'));
    assert.ok(TRANSIENT_ROLES.has('overlay'));
  });

  it('excludes workspace, content, child-content, utility', () => {
    assert.ok(!TRANSIENT_ROLES.has('workspace'));
    assert.ok(!TRANSIENT_ROLES.has('content'));
    assert.ok(!TRANSIENT_ROLES.has('child-content'));
    assert.ok(!TRANSIENT_ROLES.has('utility'));
  });
});

describe('windowSelfClosesOnBlur (the misnamed `modal` close-on-blur — peek 5b4fefdc)', () => {
  it('modal:true self-closes on blur', () => {
    assert.strictEqual(windowSelfClosesOnBlur({ modal: true }), true);
  });

  it('no modal flag → persistent (does NOT self-close)', () => {
    assert.strictEqual(windowSelfClosesOnBlur({}), false);
    assert.strictEqual(windowSelfClosesOnBlur({ modal: false }), false);
  });

  it("role:'utility' is persistent — the OAuth-window fix", () => {
    // The Lex auth window switched modal:true → role:'utility' so it survives
    // an app-switch (password manager / 2FA app) mid-login.
    assert.strictEqual(windowSelfClosesOnBlur({ role: 'utility' } as { modal?: boolean }), false);
  });

  it('modal wins over role — a role does NOT rescue a modal window', () => {
    // Documents the trap: the fix is to DROP modal, not to also pass a role.
    assert.strictEqual(
      windowSelfClosesOnBlur({ modal: true, role: 'utility' } as { modal?: boolean }),
      true,
    );
  });
});

// `selectTransientSiblingsToClose`'s 8-case table moved to
// `window-state.test.ts` ("transient-sibling autoclose on focus change") with
// the selector itself — see `window-state.ts selectTransientAutoclose`.

describe('shouldCloseContentWCOnFinalize (quit-teardown null-deref → SIGSEGV — peek 9a591551)', () => {
  // The live crash: on quit, runHybridFinalize read `view.webContents
  // .isDestroyed()`, but at teardown `view.webContents` can be `undefined`
  // (the content wc is gone natively). The straight deref threw a TypeError
  // the finalize catch merely logged, so the teardown tail bailed with
  // native state half-torn → SIGSEGV. THE FAILING-FIRST ASSERTION: an
  // undefined content wc must NOT throw and must decide "don't close".
  it('does NOT throw and returns false when the content wc is undefined (the quit-teardown case)', () => {
    assert.strictEqual(shouldCloseContentWCOnFinalize(undefined), false);
  });

  it('returns false when the content wc is null', () => {
    assert.strictEqual(shouldCloseContentWCOnFinalize(null), false);
  });

  it('returns false when the content wc is already destroyed (no double-close)', () => {
    assert.strictEqual(shouldCloseContentWCOnFinalize({ isDestroyed: () => true }), false);
  });

  it('returns true for a live content wc — the only case that gets close()-d', () => {
    assert.strictEqual(shouldCloseContentWCOnFinalize({ isDestroyed: () => false }), true);
  });
});

describe('planBeforeQuit (Cmd+Q SIGSEGV on a focused hybrid page-host)', () => {
  // The live crash: macOS dispatches Cmd+Q from inside AppKit's
  // `-[NSView performKeyEquivalent:]` walk, which calls app.quit() ->
  // before-quit SYNCHRONOUSLY. The cleanup body frees the focused hybrid
  // host's content WebContentsView (destroyAllPageHostGuests -> wc.destroy())
  // while AppKit still holds pointers into that view hierarchy, so AppKit
  // derefs Chromium's freed-memory poison (0xefefefefefefefef) on return.
  // The fix defers the cleanup off that native stack. These tests pin the
  // ordering/decision; real AppKit re-entrancy is NOT observable here.

  it('vetoes the first quit and schedules the cleanup off the native stack', () => {
    assert.deepStrictEqual(planBeforeQuit('idle'), {
      preventDefault: true,
      scheduleCleanup: true,
      nextPhase: 'deferred',
    });
  });

  it('keeps vetoing a re-entrant quit that lands before the cleanup ran', () => {
    // Safe: the already-queued macrotask still owns the re-quit.
    assert.deepStrictEqual(planBeforeQuit('deferred'), {
      preventDefault: true,
      scheduleCleanup: false,
      nextPhase: 'deferred',
    });
  });

  it('NEVER vetoes once cleanup is done — the re-quit must reach the real quit', () => {
    // This is the anti-hang invariant. If this ever returns preventDefault:true
    // the app can never exit, which is worse than the crash being fixed.
    assert.deepStrictEqual(planBeforeQuit('done'), {
      preventDefault: false,
      scheduleCleanup: false,
      nextPhase: 'done',
    });
  });

  it('schedules the cleanup exactly once across repeated quits', () => {
    let phase: QuitCleanupPhase = 'idle';
    let scheduled = 0;
    for (let i = 0; i < 5; i++) {
      const d = planBeforeQuit(phase);
      phase = d.nextPhase;
      if (d.scheduleCleanup) scheduled++;
    }
    assert.strictEqual(scheduled, 1);
  });

  // ---- Full-loop harness: models entry.ts's handler against a fake app. ----
  // Proves the two things that actually matter: the app ALWAYS quits, and the
  // cleanup never runs on the (simulated) native dispatch stack.
  function driveQuitLoop(opts: { cleanupThrows?: boolean } = {}) {
    let phase: QuitCleanupPhase = 'idle';
    const events: string[] = [];
    // Initializer carries the union so TS's control-flow analysis doesn't narrow
    // this to `null` (it can't see the assignment inside appQuit's closure).
    let queued = null as (() => void) | null;
    let reallyQuit = false;
    let onNativeStack = false;

    const appQuit = (): void => {
      const d = planBeforeQuit(phase);
      phase = d.nextPhase;
      const cleanup = () => {
        try {
          // `onNativeStack` is still true if this ran inside the synchronous
          // before-quit — i.e. inside AppKit's performKeyEquivalent: walk.
          events.push(onNativeStack ? 'cleanup-ON-NATIVE-STACK' : 'cleanup-off-stack');
          if (opts.cleanupThrows) throw new Error('cleanup blew up');
        } finally {
          phase = 'done';
          appQuit();
        }
      };
      if (d.scheduleCleanup) {
        // Deferred (fixed) shape: the veto buys us the macrotask hop.
        // Un-vetoed (pre-fix) shape: the cleanup runs inline, right here on
        // the native dispatch stack — which is the crash.
        if (d.preventDefault) queued = cleanup;
        else cleanup();
      }
      if (!d.preventDefault) { reallyQuit = true; events.push('quit'); }
    };

    // Simulate AppKit's performKeyEquivalent: walk calling quit synchronously.
    onNativeStack = true;
    appQuit();
    onNativeStack = false;
    // Drain the macrotask queue (the setImmediate in entry.ts). A throwing
    // cleanup escapes here exactly as it would to uncaughtException in
    // production — catch it so we can still assert the re-quit happened.
    let threw: unknown = null;
    try {
      while (queued) { const fn = queued; queued = null; fn(); }
    } catch (e) {
      threw = e;
    }
    return { events, reallyQuit, threw };
  }

  it('runs cleanup off the native key-event stack, then quits for real', () => {
    const { events, reallyQuit, threw } = driveQuitLoop();
    assert.strictEqual(threw, null);
    assert.deepStrictEqual(events, ['cleanup-off-stack', 'quit']);
    assert.strictEqual(reallyQuit, true);
  });

  it('still quits when the cleanup body throws (a hang is worse than the crash)', () => {
    const { reallyQuit, threw } = driveQuitLoop({ cleanupThrows: true });
    assert.match(String(threw), /cleanup blew up/, 'sanity: the cleanup really threw');
    // The `finally` must have re-quit BEFORE the throw propagated.
    assert.strictEqual(reallyQuit, true, 'a throwing cleanup must not strand the app unquit');
  });
});

describe('shouldActivateFocusedOnRestore (cold-start z-order + frontmost — peek 7bb74c90 / 8f7010a8)', () => {
  // THE FIX: at cold start the macOS startup activation dance fires
  // did-resign-active mid-restore, so appFocused reads false in the post-loop
  // focused-descriptor block. Pre-fix the block was gated on appFocused alone, so
  // BOTH branches were skipped — the focused window was never raised (z-order
  // bug) nor activated (not-frontmost/menubar bug). Cold start must activate
  // anyway.
  it('cold start activates even when appFocused is false (THE FIX)', () => {
    assert.strictEqual(shouldActivateFocusedOnRestore(true, false, false), true);
  });

  // In-session restore (cold=false) must NOT yank a user who switched away
  // mid-restore back to Peek — the original isAppFocused gate intent.
  it('in-session restore does NOT activate when appFocused is false (don\'t yank a switched-away user)', () => {
    assert.strictEqual(shouldActivateFocusedOnRestore(false, false, false), false);
  });

  // When the app IS focused, activate regardless of cold-start (the happy path,
  // both cold and in-session).
  it('activates when appFocused is true, regardless of cold-start', () => {
    assert.strictEqual(shouldActivateFocusedOnRestore(false, true, false), true);
    assert.strictEqual(shouldActivateFocusedOnRestore(true, true, false), true);
  });

  // Headless never steals focus, even at cold start (agent/CI runs stay
  // accessory — refs headless-no-focus-theft regressions peek 2b55f3af /
  // d9bb2924). appFocused defaults true in headless, but if a test forced it
  // false, cold start must still NOT activate under headless.
  it('headless never activates at cold start when appFocused is false', () => {
    assert.strictEqual(shouldActivateFocusedOnRestore(true, false, true), false);
  });

  // Headless with appFocused true still activates (appFocused dominates) — but
  // in headless the real OS focus calls are gated elsewhere (showHybridHost /
  // showWindowHeadlessSafe). This predicate only encodes the decision; it stays
  // true here because appFocused is the unconditional first term.
  it('headless + appFocused true returns true (appFocused dominates; OS calls gated downstream)', () => {
    assert.strictEqual(shouldActivateFocusedOnRestore(false, true, true), true);
  });
});

describe('spacesPolicyForRole', () => {
  it("returns 'follow' for palette on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'darwin'), 'follow');
  });

  it("returns 'follow' for quick-view on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('quick-view', 'darwin'), 'follow');
  });

  it("returns 'follow' for overlay on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('overlay', 'darwin'), 'follow');
  });

  it("returns 'anchor' for workspace on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('workspace', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for content on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('content', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for child-content on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('child-content', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for utility on darwin (no follow needed; ESC closes it)", () => {
    assert.strictEqual(spacesPolicyForRole('utility', 'darwin'), 'anchor');
  });

  it("returns 'none' on linux for any role", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'linux'), 'none');
    assert.strictEqual(spacesPolicyForRole('workspace', 'linux'), 'none');
  });

  it("returns 'none' on win32 for any role", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'win32'), 'none');
    assert.strictEqual(spacesPolicyForRole('workspace', 'win32'), 'none');
  });
});

describe('hybridResizeDirAt (round-2 main-driven resize band geometry)', () => {
  // 200x200 host at screen (400,300). Edges x∈{400,600}, y∈{300,500}.
  const b = { x: 400, y: 300, width: 200, height: 200 };
  const E = RESIZE_EDGE_PX;   // 8
  const C = RESIZE_CORNER_PX; // 16

  it('is null dead-center', () => {
    assert.strictEqual(hybridResizeDirAt(500, 400, b, E, C, 0), null);
  });

  it('returns the straight direction on each edge mid-span', () => {
    assert.strictEqual(hybridResizeDirAt(405, 400, b, E, C, 0), 'w'); // dl=5
    assert.strictEqual(hybridResizeDirAt(595, 400, b, E, C, 0), 'e'); // dr=5
    assert.strictEqual(hybridResizeDirAt(500, 305, b, E, C, 0), 'n'); // dt=5
    assert.strictEqual(hybridResizeDirAt(500, 495, b, E, C, 0), 's'); // db=5
  });

  it('returns the diagonal direction in each corner square', () => {
    assert.strictEqual(hybridResizeDirAt(410, 310, b, E, C, 0), 'nw'); // dl=10,dt=10
    assert.strictEqual(hybridResizeDirAt(590, 310, b, E, C, 0), 'ne');
    assert.strictEqual(hybridResizeDirAt(410, 490, b, E, C, 0), 'sw');
    assert.strictEqual(hybridResizeDirAt(590, 490, b, E, C, 0), 'se');
  });

  it('corner square (16px) wins over the edge strip near a corner', () => {
    // 6px below the top edge (within the 'n' strip) but only 10px from the left →
    // inside the nw corner square (both <= 16), so the diagonal wins over 'n'.
    assert.strictEqual(hybridResizeDirAt(410, 306, b, E, C, 0), 'nw');
  });

  it('is null just past the edge strip mid-span (15px in, no corner)', () => {
    assert.strictEqual(hybridResizeDirAt(415, 400, b, E, C, 0), null); // dl=15 > 12
  });

  it('enter vs exit slack: a 13px-in mid-left point is out at enter (0), in (w) at exit (6)', () => {
    assert.strictEqual(hybridResizeDirAt(413, 400, b, E, C, 0), null); // dl=13 > 12+0
    assert.strictEqual(hybridResizeDirAt(413, 400, b, E, C, 6), 'w');  // dl=13 <= 12+6
  });

  it('exit slack is sticky just outside the frame', () => {
    assert.strictEqual(hybridResizeDirAt(396, 400, b, E, C, 6), 'w'); // 4px left of frame
    assert.strictEqual(hybridResizeDirAt(396, 400, b, E, C, 0), null);
  });

  it('is null far outside the frame regardless of slack', () => {
    assert.strictEqual(hybridResizeDirAt(300, 400, b, E, C, 6), null);
    assert.strictEqual(hybridResizeDirAt(700, 400, b, E, C, 6), null);
  });
});

// ── Download close-target precedence (peek 02e0a4fa / a060a75f) ──────────────
describe('downloadCloseTarget', () => {
  it('THE REGRESSION CASE (peek 02e0a4fa): hybrid + painted + a BrowserWindow → none', () => {
    // Alt+click on a link in a real page. Chromium never opens a window — it
    // turns the click straight into a download in the SOURCE page's content WC.
    // hasBrowserWindow is TRUE here (that is NOT a mistake): at runtime
    // BrowserWindow.fromWebContents resolves a hybrid content WC to its owning
    // BaseWindow, so the BrowserWindow signal is truthy for every hybrid
    // download. A BrowserWindow-first cascade therefore closed the window the
    // user was reading. Hybrid must win, and painted means KEEP IT OPEN.
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: true, hybridPainted: true, hasBrowserWindow: true }),
      'none',
    );
  });

  it('hybrid + painted, no BrowserWindow → none (the Fastmail attachment case)', () => {
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: true, hybridPainted: true, hasBrowserWindow: false }),
      'none',
    );
  });

  it('hybrid + never painted → hybrid-host (a fresh popup minted just for the download)', () => {
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: true, hybridPainted: false, hasBrowserWindow: false }),
      'hybrid-host',
    );
  });

  it('hybrid + never painted still beats a truthy BrowserWindow signal', () => {
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: true, hybridPainted: false, hasBrowserWindow: true }),
      'hybrid-host',
    );
  });

  it('not hybrid + a real BrowserWindow → browser-window (top-level window opened for the download)', () => {
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: false, hybridPainted: false, hasBrowserWindow: true }),
      'browser-window',
    );
  });

  it('not hybrid, nothing owns the WC → none', () => {
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: false, hybridPainted: false, hasBrowserWindow: false }),
      'none',
    );
  });

  it('hybridPainted is ignored when the WC is not hybrid content', () => {
    assert.strictEqual(
      downloadCloseTarget({ isHybridContent: false, hybridPainted: true, hasBrowserWindow: true }),
      'browser-window',
    );
  });
});
