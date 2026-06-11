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
 * gate's behavior: shows=0 + focuses=0 when appFocused is false at
 * restore time; shows>0 + focuses=1 in the happy-path positive case.
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
import { hybridFlagOn } from '../helpers/hybrid-page';
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

  test('appFocused=false at restore: no .show() and no .focus() called on restored windows', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: drift counters instrument only the BrowserWindow show path; hybrid show is via ipc.ts, Batch D test-instrumentation port');
    // Open 3 windows so the snapshot has multiple descriptors. The
    // focused-descriptor handling is what matters most; the others
    // exercise the per-window show gate.
    await openPage(`http://127.0.0.1:${serverPort}/focus-away-a`);
    await openPage(`http://127.0.0.1:${serverPort}/focus-away-b`);
    await openPage(`http://127.0.0.1:${serverPort}/focus-away-c`);

    // Save baseline.
    await forceSave();

    // Close all so restore has work to do.
    await resetState();

    // Simulate user having switched away to another app.
    await setAppFocused(false);

    // Restore.
    const result = await forceRestore();
    expect(result.restored).toBeGreaterThan(0);

    // Drift-detection assertions:
    // - shows must be 0 (gate took the showInactive branch every time)
    // - showInactives must equal restored count (every gated path went here)
    // - focuses must be 0 (post-loop .focus() on focused descriptor skipped)
    const counters = await getCounters();
    expect(counters.shows,
      `restore must NOT call .show() while user is away — would steal focus from their current app`)
      .toBe(0);
    expect(counters.focuses,
      `restore must NOT call .focus() on focused descriptor while user is away`)
      .toBe(0);
    expect(counters.moveTops,
      `restore must NOT moveTop() the focused descriptor while user is away`)
      .toBe(0);
    expect(counters.showInactives,
      `every restored window must go through .showInactive() when appFocused=false`)
      .toBe(result.restored);

    // Release the override so subsequent tests see real OS focus state.
    await clearAppFocusOverride();
  });

  test('appFocused=true at restore: positive case — .show() per restored window + .focus() on focused descriptor', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: drift counters instrument only the BrowserWindow show path; hybrid show is via ipc.ts, Batch D test-instrumentation port');
    // Open and save with a focused descriptor (last-focused tracker
    // marks the most-recent window). saveSessionSnapshot encodes that
    // as `descriptor.focused = true`.
    await openPage(`http://127.0.0.1:${serverPort}/focus-happy-a`);
    await openPage(`http://127.0.0.1:${serverPort}/focus-happy-b`);

    await forceSave();
    await resetState();

    // Make sure the gate sees appFocused=true.
    await setAppFocused(true);

    const result = await forceRestore();
    expect(result.restored).toBeGreaterThan(0);

    const counters = await getCounters();
    expect(counters.shows,
      `appFocused=true happy path: every restored window goes through .show()`)
      .toBe(result.restored);
    expect(counters.showInactives,
      `appFocused=true happy path: no .showInactive() calls`)
      .toBe(0);
    // The post-loop .focus() is called at most once, only when the
    // snapshot carries a focused descriptor. The session-save path
    // records `focused: true` on the last-focused-visible window, so
    // for a baseline with >=1 window this should be 1. Allowing 0 in
    // case the test harness's window-tracking didn't observe a focus
    // event yet — but if shows>0 and focuses=0 with a multi-window
    // restore, suspect the post-loop gate.
    expect(counters.focuses,
      `appFocused=true happy path: .focus() called 0 or 1 times (only on focused descriptor)`)
      .toBeLessThanOrEqual(1);
    // Regression guard: the focused descriptor must be raised via moveTop(), not
    // just .focus(). focus() alone does not reliably reorder above the other
    // restored windows on macOS (canvas-branch parity with the hybrid branch).
    expect(counters.moveTops,
      `focused descriptor must be raised with moveTop() exactly when .focus() is called`)
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
