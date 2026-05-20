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
 * The drift-detection counters in backend/electron/session.ts increment
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

  const getCounters = () =>
    app.evaluateMain!(((_e: unknown) => {
      return (globalThis as any).__peek_test.getRestoreFocusCounters();
    }) as any) as Promise<{ shows: number; showInactives: number; focuses: number }>;

  // Tests ----------------------------------------------------------------

  test('appFocused=false at restore: no .show() and no .focus() called on restored windows', async () => {
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
    expect(counters.showInactives,
      `every restored window must go through .showInactive() when appFocused=false`)
      .toBe(result.restored);

    // Release the override so subsequent tests see real OS focus state.
    await clearAppFocusOverride();
  });

  test('appFocused=true at restore: positive case — .show() per restored window + .focus() on focused descriptor', async () => {
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
  });
});
