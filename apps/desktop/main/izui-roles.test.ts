/**
 * Unit tests for the pure IZUI role module.
 *
 * Covers:
 *   - inferIzuiRole: how api.window.open params map to an IZUI role
 *   - FOLLOWING_ROLES: which roles follow the user across desktops
 *   - spacesPolicyForRole: how IZUI role maps to macOS Spaces policy
 *   - desktopMembershipForRole: the platform-neutral half of the same
 *     derivation, feeding the rewritten kernel
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  inferIzuiRole,
  spacesPolicyForRole,
  desktopMembershipForRole,
  shouldCloseContentWCOnFinalize,
  planBeforeQuit,
  runDeferredQuitCleanup,
  type QuitCleanupPhase,
  windowSelfClosesOnBlur,
  windowNonActivating,
  pageOpensTransient,
  reuseShowActivation,
  windowIsTransient,
  hybridResizeDirAt,
  downloadCloseTarget,
  RESIZE_EDGE_PX,
  RESIZE_CORNER_PX,
  FOLLOWING_ROLES,
  isWebPageRole,
  deriveWindowSurface,
  deriveWindowLayer,
  deriveCanBecomeKey,
  deriveAcceptsInput,
  FLOATING_LAYER,
  classifyWindowRegistration,
} from './izui-roles.js';
import { BASE_LAYER } from './window-kernel.js';

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

describe('FOLLOWING_ROLES', () => {
  it('is empty (the page chrome overlay stays on the desktop it is shown on)', () => {
    assert.deepStrictEqual([...FOLLOWING_ROLES], []);
  });

  it('holds no role a transient window opens with (a transient window never follows the user)', () => {
    for (const role of ['overlay', 'palette','quick-view', 'switcher', 'content', 'child-content', 'workspace', 'utility']) {
      assert.ok(!FOLLOWING_ROLES.has(role), role);
    }
  });
});

describe('isWebPageRole (the devtools target: role as the surviving http/https fact)', () => {
  /**
   * The whole role vocabulary, each entry paired with whether it means "a real
   * web page". A role added to `inferIzuiRole` without a decision here shows up
   * as a missing row, not as a silent default.
   */
  const vocabulary: ReadonlyArray<readonly [string, boolean]> = [
    ['content', true],
    ['child-content', true],
    ['workspace', false],
    ['quick-view', false],
    ['palette', false],
    ['overlay', false],
    ['switcher', false],
    ['utility', false],
  ];

  for (const [role, expected] of vocabulary) {
    it(`${role} -> ${expected}`, () => {
      assert.strictEqual(isWebPageRole(role), expected);
    });
  }

  it('an unknown or absent role is not a web page — an allow-list, like CONTENT_ROLES', () => {
    assert.strictEqual(isWebPageRole('something-new'), false);
    assert.strictEqual(isWebPageRole(undefined), false);
    assert.strictEqual(isWebPageRole(''), false);
  });

  it('admits exactly the roles inferIzuiRole gates on isWebPage', () => {
    // The tie that makes role a sound proxy for the deleted `lastHttpUrl`:
    // both admitted roles come out of a `ctx.isWebPage` arm, and the
    // non-web-page tail returns `workspace`, which is rejected above.
    assert.strictEqual(
      isWebPageRole(inferIzuiRole({}, { isWebPage: true, parentWindowId: null })),
      true,
    );
    assert.strictEqual(
      isWebPageRole(inferIzuiRole({}, { isWebPage: true, parentWindowId: 7 })),
      true,
    );
    assert.strictEqual(
      isWebPageRole(inferIzuiRole({}, { isWebPage: false, parentWindowId: null })),
      false,
      'a peek:// open infers `workspace` — the regression this predicate routes around',
    );
  });

  it('a peek/slide over a page is no longer auto-targetable — an accepted narrowing', () => {
    // `modal:true` infers `quick-view` even for an http URL, so a slide sitting
    // over a page stops being the automatic devtools target. The explicit
    // `args.id` path in `tile-ipc.ts` still reaches it.
    assert.strictEqual(
      isWebPageRole(inferIzuiRole({ modal: true }, { isWebPage: true, parentWindowId: null })),
      false,
    );
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

describe('windowNonActivating (the Panel open-time declaration — window-rules.md G1/F6)', () => {
  it("type:'panel' is a Panel — never activates the app", () => {
    assert.strictEqual(windowNonActivating({ type: 'panel' }), true);
  });

  it('no type, or any other type, does not declare a panel', () => {
    assert.strictEqual(windowNonActivating({}), false);
    assert.strictEqual(windowNonActivating({ type: 'normal' }), false);
  });

  it('an ordinary window the open declared non-activating never activates the app', () => {
    assert.strictEqual(windowNonActivating({ nonActivating: true }), true);
    assert.strictEqual(windowNonActivating({ nonActivating: false }), false);
  });
});

describe('pageOpensTransient (a page opened from a panel over another app — window-rules.md G1)', () => {
  it('a page opened to show while a panel holds key over another app is a transient page-host window', () => {
    assert.strictEqual(pageOpensTransient(true, {}), true);
    assert.strictEqual(pageOpensTransient(true, { show: true }), true);
  });

  it('nobody typing into the app — an active app, or a command-line open — is an ordinary open', () => {
    assert.strictEqual(pageOpensTransient(false, {}), false);
  });

  it('a window opened not to show is never a transient page-host window', () => {
    assert.strictEqual(pageOpensTransient(true, { show: false }), false);
  });

  it("a caller's own window type is left alone", () => {
    assert.strictEqual(pageOpensTransient(true, { type: 'panel' }), false);
    assert.strictEqual(pageOpensTransient(true, { type: 'normal' }), false);
  });
});

describe('windowIsTransient (specs/kernel-desktops.md "Transient window")', () => {
  it('an open that asks for it is transient whatever the focus', () => {
    for (const held of [false, true]) {
      assert.strictEqual(windowIsTransient(held, { modal: true }), true);
      assert.strictEqual(windowIsTransient(held, { overlay: true }), true);
      assert.strictEqual(windowIsTransient(held, { modal: true, show: false }), true, 'a pre-created hidden palette');
    }
  });

  it('while Peek is focused, nothing else is transient', () => {
    assert.strictEqual(windowIsTransient(false, {}), false);
  });

  it('while another app is focused, anything opened to show is transient', () => {
    assert.strictEqual(windowIsTransient(true, {}), true);
    assert.strictEqual(windowIsTransient(true, { show: false }), false);
  });

  it('an open that declares itself regular is not transient by focus, and does not open transient', () => {
    assert.strictEqual(windowIsTransient(true, { regular: true }), false);
    assert.strictEqual(pageOpensTransient(true, { regular: true }), false);
    assert.strictEqual(windowIsTransient(true, { regular: true, modal: true }), true);
  });

  it('reusing an open page carries user activation for a user gesture or a regular open only', () => {
    assert.deepStrictEqual(reuseShowActivation({ regular: true }), { activation: 'user' });
    assert.deepStrictEqual(reuseShowActivation({ activation: 'user' }), { activation: 'user' });
    assert.deepStrictEqual(reuseShowActivation({}), {});
  });

  it('a window that takes no input never is', () => {
    assert.strictEqual(windowIsTransient(true, { overlay: true, focusable: false }), false);
    assert.strictEqual(windowIsTransient(true, { modal: true, clickThrough: true }), false);
  });
});

// `selectTransientSiblingsToClose`'s 8-case table moved to
// `window-kernel.test.ts` ("window-kernel: transient autoclose") with
// the selector itself — see `window-kernel.ts selectTransientAutoclose`.

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

describe('runDeferredQuitCleanup (the re-quit waits for the async cleanup)', () => {
  // The live defect this pins: the deferred cleanup issued the page-host guest
  // `wc.destroy()` calls and returned. `destroy()` is not synchronously
  // observable — every guest was still alive ~1ms later when Electron's quit
  // closed its host window, which is the d1cf0b9a deref. So the ordering that
  // matters is "the cleanup has FINISHED before the re-quit is issued", and
  // finishing is asynchronous.

  it('issues the re-quit only after an async cleanup has settled (THE FIX)', async () => {
    const order: string[] = [];
    await runDeferredQuitCleanup(
      async () => {
        order.push('cleanup-start');
        await new Promise((r) => setTimeout(r, 5));
        order.push('cleanup-done');
      },
      () => order.push('quit'),
    );
    // Drop the await inside runDeferredQuitCleanup (the pre-fix fire-and-forget
    // shape) and this reads ['cleanup-start', 'quit', 'cleanup-done'].
    assert.deepStrictEqual(order, ['cleanup-start', 'cleanup-done', 'quit']);
  });

  it('a synchronous cleanup still quits, in order', async () => {
    const order: string[] = [];
    await runDeferredQuitCleanup(
      () => { order.push('cleanup'); },
      () => order.push('quit'),
    );
    assert.deepStrictEqual(order, ['cleanup', 'quit']);
  });

  it('still quits when the cleanup REJECTS (a hang is worse than a failed cleanup)', async () => {
    const order: string[] = [];
    const seen: unknown[] = [];
    await runDeferredQuitCleanup(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw new Error('teardown blew up');
      },
      () => order.push('quit'),
      (e) => seen.push(e),
    );
    assert.deepStrictEqual(order, ['quit'], 'the re-quit we owe the user is issued anyway');
    assert.match(String(seen[0]), /teardown blew up/, 'and the failure is reported, not swallowed silently');
  });

  it('still quits when the cleanup throws synchronously', async () => {
    let quit = 0;
    await runDeferredQuitCleanup(
      () => { throw new Error('sync boom'); },
      () => { quit++; },
    );
    assert.strictEqual(quit, 1);
  });

  it('quits exactly once', async () => {
    let quit = 0;
    await runDeferredQuitCleanup(async () => {}, () => { quit++; });
    assert.strictEqual(quit, 1);
  });
});

// (The `shouldActivateFocusedOnRestore` block moved to
// `window-kernel-executor.test.ts` with the rule itself, which is now
// `planRestoreFocus` — see the note where the function used to live in
// `izui-roles.ts`.)

describe('spacesPolicyForRole', () => {
  it("returns 'follow' for overlay on darwin", () => {
    assert.strictEqual(spacesPolicyForRole('overlay', 'darwin'), 'anchor');
  });

  it("returns 'anchor' for the transient roles on darwin: palette, quick-view, switcher", () => {
    assert.strictEqual(spacesPolicyForRole('palette', 'darwin'), 'anchor');
    assert.strictEqual(spacesPolicyForRole('quick-view', 'darwin'), 'anchor');
    assert.strictEqual(spacesPolicyForRole('switcher', 'darwin'), 'anchor');
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

describe('desktopMembershipForRole', () => {
  it("returns 'follow' for overlay chrome only, with no platform argument", () => {
    assert.strictEqual(desktopMembershipForRole('overlay'), 'anchor');
  });

  it("returns 'anchor' for every other role, transient ones included, with no platform argument", () => {
    assert.strictEqual(desktopMembershipForRole('palette'), 'anchor');
    assert.strictEqual(desktopMembershipForRole('quick-view'), 'anchor');
    assert.strictEqual(desktopMembershipForRole('switcher'), 'anchor');
    assert.strictEqual(desktopMembershipForRole('workspace'), 'anchor');
    assert.strictEqual(desktopMembershipForRole('content'), 'anchor');
    assert.strictEqual(desktopMembershipForRole('child-content'), 'anchor');
    assert.strictEqual(desktopMembershipForRole('utility'), 'anchor');
  });

  it('never answers a third value — there is no platform-derived "none"', () => {
    // TypeScript already enforces this (the return type is 'follow' | 'anchor'
    // with no platform parameter to gate on); this is the runtime witness.
    const roles = ['palette', 'quick-view', 'overlay', 'switcher', 'workspace', 'content', 'child-content', 'utility'];
    for (const role of roles) {
      assert.ok(['follow', 'anchor'].includes(desktopMembershipForRole(role)));
    }
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

/**
 * Window-surface derivation, one case per REAL construction site.
 *
 * Every `facts` object below is the registration payload that site actually
 * produces: the `focusable` / `alwaysOnTop` values its open params or
 * `BrowserWindow` options carry (normalized the way `ipc.ts` /
 * `tile-launcher.ts` / `main.ts` normalize them), and `clickThrough` only where
 * the site calls `setIgnoreMouseEvents` before registering.
 */
describe('deriveWindowSurface — real construction sites', () => {
  it('the HUD (renderer/hud/background.js openHud): focusable:false, alwaysOnTop:true', () => {
    // No `role` in its params, so `inferIzuiRole` returns 'workspace' — an
    // ordinary admitted role. Only `focusable:false` sets it apart.
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: false, alwaysOnTop: true }),
      { layer: FLOATING_LAYER, canBecomeKey: false, acceptsInput: true },
    );
  });

  it('the shared chrome overlay (hybrid-overlay.ts ensureOverlay): focusable:true, alwaysOnTop:true, click-through from birth', () => {
    // focusable:true is deliberate — Cmd+L takes key into the navbar URL input.
    // setIgnoreMouseEvents(true,{forward:true}) runs before its registration.
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: true, alwaysOnTop: true, clickThrough: true }),
      { layer: FLOATING_LAYER, canBecomeKey: true, acceptsInput: false },
    );
  });

  it('an ordinary hybrid page host (ipc.ts assembleHybridPageHost, role content): declares neither', () => {
    assert.deepStrictEqual(
      deriveWindowSurface({}),
      { layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true },
    );
  });

  it('a peek (features/peeks/background.js): role quick-view, modal, type panel — no alwaysOnTop, so BASE_LAYER', () => {
    assert.deepStrictEqual(
      deriveWindowSurface({}),
      { layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true },
    );
  });

  it('a slide (features/slides/background.js): same params plus screenEdge — also BASE_LAYER', () => {
    assert.strictEqual(deriveWindowLayer({}), BASE_LAYER);
  });

  it('the space-border indicator (features/spaces/background.js) at registration: focusable:false, alwaysOnTop:true, click-through NOT yet declared', () => {
    // Its api.window.setIgnoreMouseEvents is a separate IPC round trip issued
    // after api.window.open resolves, so the registration carries no
    // click-through fact and acceptsInput is true for that instant.
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: false, alwaysOnTop: true }),
      { layer: FLOATING_LAYER, canBecomeKey: false, acceptsInput: true },
    );
  });

  it('the space border once its click-through is known: acceptsInput false', () => {
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: false, alwaysOnTop: true, clickThrough: true }),
      { layer: FLOATING_LAYER, canBecomeKey: false, acceptsInput: false },
    );
  });

  it('the windows switcher (features/windows/background.js openWindowsView): role switcher, alwaysOnTop, and it TAKES clicks', () => {
    // Same alwaysOnTop as the space border, different role, opposite
    // acceptsInput — the user clicks windows in it. This is why acceptsInput
    // cannot key on role.
    assert.deepStrictEqual(
      deriveWindowSurface({ alwaysOnTop: true }),
      { layer: FLOATING_LAYER, canBecomeKey: true, acceptsInput: true },
    );
  });

  it('the command panel (renderer/cmd/background.js): role palette, alwaysOnTop, focusable left at Electron default', () => {
    assert.deepStrictEqual(
      deriveWindowSurface({ alwaysOnTop: true }),
      { layer: FLOATING_LAYER, canBecomeKey: true, acceptsInput: true },
    );
  });

  it('a manifest tile window — features/spaces manifest "border" entry via tile-launcher.ts: focusable:false, alwaysOnTop:true', () => {
    // tile-launcher resolves `focusable: hints.focusable !== false` and
    // `alwaysOnTop: !isHeadless() && hints.alwaysOnTop === true`, then registers
    // those merged values.
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: false, alwaysOnTop: true }),
      { layer: FLOATING_LAYER, canBecomeKey: false, acceptsInput: true },
    );
  });

  it('a manifest tile window — features/windows manifest "windows-overlay" entry: alwaysOnTop only, focusable resolves true', () => {
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: true, alwaysOnTop: true }),
      { layer: FLOATING_LAYER, canBecomeKey: true, acceptsInput: true },
    );
  });

  it('the privileged test fixture (test-fixture-glue.ts): focusable:false and NOT always-on-top', () => {
    // The pair that makes a HUD is not a single fact: this window has the
    // focusable half without the floating half.
    assert.deepStrictEqual(
      deriveWindowSurface({ focusable: false }),
      { layer: BASE_LAYER, canBecomeKey: false, acceptsInput: true },
    );
  });

  it('the hidden core background window (core-glue.ts): show:false, but focusable and input are untouched', () => {
    assert.deepStrictEqual(
      deriveWindowSurface({}),
      { layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true },
    );
  });
});

describe('deriveWindowSurface — the clause each real window forces', () => {
  it('canBecomeKey is not "everything can": the HUD is focusable:false', () => {
    // FAILING-FIRST ANCHOR. Weakening deriveCanBecomeKey to a constant `true`
    // (the naive form) fails exactly this assertion — the HUD's inferred role is
    // 'workspace', so no role or class test distinguishes it.
    assert.strictEqual(deriveCanBecomeKey({ focusable: false }), false);
  });

  it('canBecomeKey does not key on role: the chrome overlay is a focusable overlay', () => {
    assert.strictEqual(deriveCanBecomeKey({ focusable: true }), true);
  });

  it('canBecomeKey does not key on alwaysOnTop: the cmd panel floats and is typed into', () => {
    assert.strictEqual(deriveWindowSurface({ alwaysOnTop: true }).canBecomeKey, true);
  });

  it('focusable:undefined is Electron default true, not a missing value', () => {
    assert.strictEqual(deriveCanBecomeKey({}), true);
    assert.strictEqual(deriveCanBecomeKey({ focusable: undefined }), true);
  });

  it('layer keys on the declared alwaysOnTop, so a quick-view stays at BASE_LAYER', () => {
    assert.strictEqual(deriveWindowLayer({ alwaysOnTop: undefined }), BASE_LAYER);
    assert.strictEqual(deriveWindowLayer({ alwaysOnTop: false }), BASE_LAYER);
    assert.strictEqual(deriveWindowLayer({ alwaysOnTop: true }), FLOATING_LAYER);
  });

  it('there is one floating band, directly above base', () => {
    // stackingLevelForLayer has two arms, and 'floating'/'torn-off-menu' are the
    // same NSWindowLevel — a third band would realize identically.
    assert.strictEqual(FLOATING_LAYER, BASE_LAYER + 1);
    assert.ok(FLOATING_LAYER > BASE_LAYER);
  });

  it('acceptsInput is declared, never inferred: an undeclared window takes input', () => {
    assert.strictEqual(deriveAcceptsInput({}), true);
    assert.strictEqual(deriveAcceptsInput({ clickThrough: false }), true);
    assert.strictEqual(deriveAcceptsInput({ clickThrough: true }), false);
  });

  it('transparent + unfocusable does not imply click-through — the HUD takes input', () => {
    assert.strictEqual(deriveWindowSurface({ focusable: false, alwaysOnTop: true }).acceptsInput, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 step 4 — special window classes + registry unification
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyWindowRegistration — single owner of the ordinary-window class rule', () => {
  it('maps the role vocabulary onto classes', () => {
    assert.strictEqual(classifyWindowRegistration('overlay'), 'overlay');
    assert.strictEqual(classifyWindowRegistration('palette'), 'palette');
    assert.strictEqual(classifyWindowRegistration('quick-view'), 'quick-view');
    assert.strictEqual(classifyWindowRegistration('content'), 'primary');
    assert.strictEqual(classifyWindowRegistration('workspace'), 'primary');
    assert.strictEqual(classifyWindowRegistration('child-content'), 'primary');
  });

  it('alwaysOnTop + focusable:false is hud (the declared form of the deleted sniffing predicate)', () => {
    assert.strictEqual(classifyWindowRegistration('utility', { alwaysOnTop: true, focusable: false }), 'hud');
    // Either property alone is NOT a HUD — matches the old predicate's conjunction.
    assert.strictEqual(classifyWindowRegistration('utility', { alwaysOnTop: true, focusable: true }), 'primary');
    assert.strictEqual(classifyWindowRegistration('utility', { alwaysOnTop: true }), 'primary', 'focusable undefined = Electron default true');
    assert.strictEqual(classifyWindowRegistration('utility', { focusable: false }), 'primary');
  });

  it('role classes win over the hud pair (a non-focusable alwaysOnTop palette is still a palette)', () => {
    assert.strictEqual(classifyWindowRegistration('palette', { alwaysOnTop: true, focusable: false }), 'palette');
  });
});
