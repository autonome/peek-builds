/**
 * Session restore — focus-stealing drift detection
 *
 * Standing regression test for bug class first fixed in 853cc48f
 * (refined by 6c67ad34): when the user switches away from Peek
 * mid-restore, the per-window .show() and the post-loop .focus() on the
 * focused descriptor must both no-op. The fix gates them on
 * `getIzuiCoordinator().isAppFocused()` at restore time. The bug class
 * — unconditional .show()/.focus() in the restore loop — silently
 * regresses if someone re-introduces those calls without the guard.
 *
 * The drift-detection counters in apps/desktop/main/session.ts increment
 * at each gated call site. These tests assert the counters reflect the
 * gate's behavior.
 *
 * Note on hybrid: the legacy `shows`/`showInactives` counters only
 * instrument the per-window BrowserWindow `.show()`/`.showInactive()` call
 * site in the restore loop — dead code now that every restored page-host is
 * a hybrid BaseWindow (`getLiveWindow()` returns null for them, so that
 * branch never runs). Hybrid's restore design is intentionally different:
 * every restored window opens INACTIVE (no per-window active-show step at
 * all — see the `hybridActivations` comment in session.ts), and a single
 * post-loop authority activates ONLY the focused descriptor. That is a
 * structural difference, not an instrumentation gap, so the tests below use
 * the `hybridActivations`/`focuses`/`moveTops` counters (already
 * instrumented) instead of `shows`/`showInactives`.
 *
 * Per feedback_no_sleep_in_tests_or_code: no wall-clock waits.
 * Deterministic save→setAppFocusedForTest→forceRestoreSession→assert.
 *
 * Run with:
 *   yarn test:grep "Session Restore Focus"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Session Restore Focus @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-focus'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  /** Close every page-host window so each test starts from a clean slate. */
  async function resetState() {
    await bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return;
      for (const w of list.windows || []) {
        if (typeof w.url === 'string' && w.url.startsWith('peek://app/page/')) {
          await (window as any).app.window.close(w.id);
        }
      }
    });
    await bgWindow.waitForFunction(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      return !(list.windows || []).some((w: any) =>
        typeof w.url === 'string' && w.url.startsWith('peek://app/page/'));
    });
  }

  async function openPage(url: string): Promise<number> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    // Block on slug to ensure the page is fully open before next steps.
    const slug = new URL(url).pathname.slice(1);
    await app.getWindow(slug, 15000);
    return result.id as number;
  }

  test.beforeEach(async () => {
    await resetState();
  });

  test.afterEach(async () => {
    // Always release the test override so subsequent tests (in this
    // file or others sharing the test runner) see real OS focus state.
    await clearAppFocusOverride();
  });

  // Helpers for evaluateMain. NOTE: evaluateMain passes the electron
  // module as the first arg of the closure, the user-supplied `arg` as
  // the second. Closures here destructure only the second arg.
  const setAppFocused = (focused: boolean) =>
    app.evaluateMain!(((_e, focusedArg: boolean) => {
      return (globalThis as any).__peek_test.setAppFocusedForTest(focusedArg);
    }) as any, focused);

  const clearAppFocusOverride = () =>
    app.evaluateMain!(((_e: unknown) => {
      return (globalThis as any).__peek_test.clearAppFocusedForTest();
    }) as any);

  const forceSave = () =>
    app.evaluateMain!(((_e: unknown) => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

  const forceRestore = () =>
    app.evaluateMain!(((_e: unknown) => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as Promise<{ restored: number; failed: number; total: number }>;

  // Drive the BOOT (cold-start) restore path: isColdStart=true. Used to prove
  // the fix — at cold start the focused descriptor activates EVEN when the
  // startup did-resign-active dance left appFocused false.
  const forceColdStartRestore = () =>
    app.evaluateMain!(((_e: unknown) => {
      return (globalThis as any).__peek_test.forceColdStartRestoreSession();
    }) as any) as Promise<{ restored: number; failed: number; total: number }>;

  const getCounters = () =>
    app.evaluateMain!(((_e: unknown) => {
      return (globalThis as any).__peek_test.getRestoreFocusCounters();
    }) as any) as Promise<{ shows: number; showInactives: number; focuses: number; moveTops: number; hybridActivations: number; focusedId: number | null }>;

  // Tests ----------------------------------------------------------------

  // The former "appFocused=false: no .show()/.focus()" test is not ported —
  // it is an exact scenario duplicate of "in-session restore with
  // appFocused=false does NOT activate" below (same setup: open windows,
  // save, reset, setAppFocused(false), forceRestore, assert
  // moveTops/focuses/hybridActivations are 0). That test already covers this
  // regression class for hybrid.

  test('appFocused=true at restore (in-session, non-cold): activates the focused descriptor exactly once', async () => {
    // Hybrid restore has no per-window active-show step to instrument (every
    // restored window opens INACTIVE by design; see the file header and the
    // `hybridActivations` comment in session.ts) — only the post-loop
    // authority activates the ONE focused descriptor. This is the in-session
    // (non-cold-start) counterpart to the "COLD START boot path" test below:
    // it proves appFocused=true alone (not just the cold-start override) is
    // enough to drive activation on a regular in-session restore — a case the
    // cold-start-specific tests below don't cover.
    await openPage(`http://127.0.0.1:${serverPort}/focus-happy-a`);
    const bId = await openPage(`http://127.0.0.1:${serverPort}/focus-happy-b`);

    // Unlike the legacy BrowserWindow path, opening a hybrid window last does
    // NOT by itself mark it as the "last focused" descriptor for save
    // purposes — hybrid hosts open INACTIVE, so nothing updates
    // lastFocusedVisibleWindowId until a REAL focus event fires. Drive that
    // event explicitly (same idiom as the "focus-order" test in
    // session-restore-page-host.spec.ts) so the snapshot's focused descriptor
    // is actually one of OUR hybrid windows, not a stray BrowserWindow.
    const focused = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as any, bId) as boolean;
    expect(focused, 'focusHybridWindowForTest should find the live hybrid window').toBe(true);

    await forceSave();
    await resetState();

    // Make sure the gate sees appFocused=true.
    await setAppFocused(true);

    const result = await forceRestore();
    expect(result.restored).toBeGreaterThan(0);

    const counters = await getCounters();
    expect(counters.focuses,
      `appFocused=true happy path: the focused descriptor is activated exactly once`)
      .toBe(1);
    expect(counters.hybridActivations,
      `the activation must go through the hybrid activation path`)
      .toBe(counters.focuses);
    // Regression guard: the focused descriptor must be raised via moveTop(),
    // exactly when it is activated.
    expect(counters.moveTops,
      `focused descriptor must be raised with moveTop() exactly when it is activated`)
      .toBe(counters.focuses);
  });

  // ------------------------------------------------------------------------
  // COLD START (boot) restore — the converged-bug fix (peek 7bb74c90 z-order +
  // 8f7010a8 not-frontmost-at-startup).
  //
  // At cold start the macOS startup activation dance fires did-resign-active
  // mid-restore, so isAppFocused() reads FALSE in the post-loop focused-
  // descriptor block. Pre-fix that block was gated on isAppFocused() alone, so
  // BOTH branches were skipped — the saved-focused window was never moveTop'd
  // (z-order bug) nor activated (menubar/key-window bug). The fix gates on
  // shouldActivateFocusedOnRestore(isColdStart, appFocused, headless).
  //
  // HEADLESS CAVEAT (load-bearing, per apps/desktop/CLAUDE.md): the predicate
  // INTENTIONALLY suppresses activation under headless — `cold && !headless` —
  // so a cold restore CANNOT raise/focus while PEEK_HEADLESS=1 (these specs run
  // headless; the fixture sets PEEK_HEADLESS=1). That headless gate is itself
  // part of the contract (never steal the user's focus from a CI/agent run —
  // peek 2b55f3af / d9bb2924). So the "cold start overrides appFocused=false"
  // proof lives in the PURE unit test (izui-roles.test.ts), where headless is an
  // explicit arg. Here we assert the headless-observable invariants:
  //   (1) the in-session gate still HOLDS (appFocused=false, isColdStart=false →
  //       counters 0 — don't yank a switched-away user); the failing-first
  //       baseline.
  //   (2) the cold-start path THREADS through and ACTIVATES on the boot happy
  //       path (appFocused=true → counters 1, focusedId set) — proving the new
  //       4th param doesn't break activation and the decision log fires.
  // ------------------------------------------------------------------------

  test('in-session restore with appFocused=false does NOT activate (failing-first baseline — don\'t yank)', async () => {
    await openPage(`http://127.0.0.1:${serverPort}/insession-a`);
    await openPage(`http://127.0.0.1:${serverPort}/insession-b`);
    await forceSave();
    await resetState();

    // Simulate the user having switched away (or the startup dance) → false.
    await setAppFocused(false);

    const inSession = await forceRestore();
    expect(inSession.restored).toBeGreaterThan(0);
    const c = await getCounters();
    expect(c.moveTops,
      `in-session restore (isColdStart=false) with appFocused=false must NOT moveTop — don't yank a switched-away user`)
      .toBe(0);
    expect(c.focuses,
      `in-session restore must NOT .focus()/.activate the focused descriptor while appFocused=false`)
      .toBe(0);
    expect(c.hybridActivations,
      `in-session restore must NOT activate any hybrid host while appFocused=false`)
      .toBe(0);

    await clearAppFocusOverride();
  });

  test('COLD START boot path threads through and activates the focused descriptor (appFocused=true)', async () => {
    await openPage(`http://127.0.0.1:${serverPort}/cold-a`);
    await openPage(`http://127.0.0.1:${serverPort}/cold-b`);
    await forceSave();
    await resetState();

    // Boot happy path: Peek is the active app (the dominant term in the
    // predicate — `appFocused || ...`). Under headless the cold-start override
    // term is suppressed, so this term is what makes the boot restore activate.
    await setAppFocused(true);

    const cold = await forceColdStartRestore();
    expect(cold.restored).toBeGreaterThan(0);

    const c = await getCounters();
    // Exactly the single focused descriptor is raised + activated. moveTop ===
    // focus ties the raise to the activation (canvas + hybrid branches both do
    // moveTop()+activate on exactly the focused descriptor).
    expect(c.focuses,
      `cold-start boot restore activates the focused descriptor exactly once`)
      .toBe(1);
    expect(c.moveTops,
      `the focused descriptor is raised via moveTop() exactly when it is activated`)
      .toBe(1);
    expect(c.focusedId,
      `cold-start restore records the restored focused window id (a real window was raised)`)
      .not.toBeNull();

    await clearAppFocusOverride();
  });
});
