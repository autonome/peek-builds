/**
 * Session restore — focus IDENTITY under the hybrid page-host default
 *
 * User-reported regression (2026-06-09, hybrid default prod build): leave a
 * SPECIFIC web page focused, quit (Cmd+Q), relaunch → a DIFFERENT page comes up
 * focused, not the one focused at quit. The right windows restore, but the
 * focus / z-order target is wrong.
 *
 * Root cause (RESTORE side): a web page under the hybrid default is a
 * `BaseWindow` page-host shown via `showHybridHost`. The session-restore open
 * passes `show:false` (the canvas path honors it — `ipc.ts` BrowserWindow ctor
 * `show: options.show !== false` — so restored canvas windows show inactive and
 * the restore loop's focus block raises exactly the focused one). But the hybrid
 * show seam IGNORED `show:false` and called the ACTIVATING branch
 * (`baseWin.show()` + `contentWC.focus()`) for EVERY restored hybrid window. So
 * each restored page activated itself; the last one to show (or the macOS
 * show-storm race winner) ended up frontmost — not the page the user left
 * focused. The fix threads `inactive: options.show === false` into the hybrid
 * show seam so restore opens are non-activating, and makes the restore loop's
 * focus block the SINGLE authority that activates exactly the focused descriptor
 * (an activating `showHybridHost` on it — host raised + content first responder).
 *
 * Real OS focus / first-responder is UNOBSERVABLE in macOS-headless, so we
 * assert the DECISION + restore STATE via the test bridge, focus-free (the
 * pattern hybrid-show-activate.spec.ts uses), NOT real OS focus:
 *
 *   1. DECISION (failing-first core): the hybrid show seam for a `show:false`
 *      (restore) open must be NON-activating even in a NON-headless run. Pre-fix
 *      `hybridShowIntent(headless=false)` is unconditionally activating, so a
 *      restored hybrid window would activate and steal focus.
 *   2. IDENTITY: after a real save→restore with TWO hybrid pages where the FIRST
 *      one was focused at save, the restore activates EXACTLY ONE hybrid window
 *      (hybridActivations === 1, never both) and the window it raised + the IZUI
 *      coordinator's focused window are the RESTORED FIRST page — not the second.
 *
 * Run with:
 *   yarn test:grep "Session Restore Hybrid Focus"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Session Restore Hybrid Focus @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-hybrid-focus'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
            `<body><h1>${req.url}</h1></body></html>`,
        );
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

  // Helpers --------------------------------------------------------------

  const hybridBridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  async function openPageHost(url: string): Promise<{ pageWindow: Page; windowId: number }> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const slug = new URL(url).pathname.slice(1);
    const pageWindow = await app.getWindow(slug, 15000);
    return { pageWindow, windowId: result.id };
  }

  async function closeWindows(ids: number[]) {
    await bgWindow.evaluate(async (toClose: number[]) => {
      for (const id of toClose) {
        await (window as any).app.window.close(id);
      }
    }, ids);
    await bgWindow.waitForFunction(async (toClose: number[]) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      const live = new Set((list.windows || []).map((w: any) => w.id));
      return toClose.every((id) => !live.has(id));
    }, ids);
  }

  async function restoredIdForSlug(slug: string): Promise<number | null> {
    return (await bgWindow.evaluate(async (s: string) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return null;
      const match = (list.windows || []).find(
        (w: any) => typeof w.url === 'string' && w.url.includes(s),
      );
      return match ? match.id : null;
    }, slug)) as number | null;
  }

  // Tests ----------------------------------------------------------------

  // CORE failing-first DECISION test. Real OS focus is unobservable headless, so
  // we assert the pure show decision the restore open makes. A session-restore
  // (`show:false`) hybrid open must be NON-activating EVEN IN A NON-HEADLESS run
  // — otherwise each restored page activates itself and the page the user left
  // focused is not the one raised. Pre-fix `hybridShowIntent(false)` is
  // unconditionally activating (no inactive concept), so this assertion fails.
  test('restore (show:false) hybrid show DECISION is non-activating in non-headless', async () => {
    test.skip(!(await hybridBridgePresent()), 'hybrid flag off — no overlay bridge');

    const { freshNonHeadless, restoreNonHeadless, restoreHeadless } =
      await app.evaluateMain!(() => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return {
          // A FRESH (non-restore) open in the real app still activates (R4/R7).
          freshNonHeadless: b.hybridShowIntent(false, false),
          // A RESTORE open (show:false) must NOT activate, even non-headless.
          restoreNonHeadless: b.hybridShowIntent(false, true),
          // Headless restore stays focus-free too (unchanged).
          restoreHeadless: b.hybridShowIntent(true, true),
        };
      });

    // Regression guard: a fresh open is still the activating path.
    expect(freshNonHeadless.activated, 'fresh non-headless open still activates').toBe(true);
    expect(freshNonHeadless.contentFocused).toBe(true);

    // THE FIX: a restore open is inactive + focus-free in a NON-headless run.
    expect(
      restoreNonHeadless.activated,
      'a restored hybrid window must NOT activate itself — only the focused descriptor is re-activated by the restore loop',
    ).toBe(false);
    expect(restoreNonHeadless.contentFocused).toBe(false);
    expect(restoreNonHeadless.showInactive).toBe(true);

    // Headless restore is focus-free as before.
    expect(restoreHeadless.activated).toBe(false);
  });

  // IDENTITY: a real save→restore with two hybrid pages where the FIRST was
  // focused at save must restore that SAME page focused — and must activate
  // EXACTLY ONE hybrid window (not both). The drift counters expose the
  // restore loop's decision focus-free.
  test('two hybrid pages: the page focused at save is the one restore raises (not the other)', async () => {
    test.skip(!(await hybridBridgePresent()), 'hybrid flag off — no overlay bridge');

    const slugA = 'hybrid-focus-A';
    const slugB = 'hybrid-focus-B';
    const urlA = `http://127.0.0.1:${serverPort}/${slugA}`;
    const urlB = `http://127.0.0.1:${serverPort}/${slugB}`;

    // Open page A, then page B. Both are hybrid BaseWindow page-hosts.
    const a = await openPageHost(urlA);
    await a.pageWindow.waitForLoadState('domcontentloaded');
    const b = await openPageHost(urlB);
    await b.pageWindow.waitForLoadState('domcontentloaded');

    const aIsHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, a.windowId) as boolean;
    test.skip(!aIsHybrid, 'hybrid flag off — identity bug is hybrid-only');

    // The user clicks BACK into page A → A is the page focused at quit. Drive
    // the REAL host BaseWindow 'focus' event (the exact event Electron fires).
    const focusedA = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as any, a.windowId) as boolean;
    expect(focusedA, 'focusHybridWindowForTest should find page A').toBe(true);

    // Save. The snapshot must mark page A (not B) focused.
    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as any);
    const snapshot = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as any) as
      { windows: Array<{ url: string; focused: boolean }> } | null;
    expect(snapshot, 'snapshot exists after save').not.toBeNull();
    const focusedDescriptors = (snapshot!.windows || []).filter((w) => w.focused);
    expect(focusedDescriptors.length, 'exactly one focused descriptor').toBe(1);
    expect(
      focusedDescriptors[0].url,
      'the focused descriptor must be page A (the one focused at quit), not page B',
    ).toContain(slugA);

    // Close both so restore has work to do.
    await closeWindows([a.windowId, b.windowId]);

    // Restore with the app focused so the restore focus block actually runs.
    await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.setAppFocusedForTest(true)) as any);
    const restoreResult = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as any) as
      { restored: number; failed: number; total: number };
    expect(restoreResult.restored, 'both pages restore').toBeGreaterThanOrEqual(2);

    // Resolve the restored windows' fresh ids by content-URL slug. Wait for
    // BOTH restored page-host windows to exist (both restore eagerly — only 2
    // windows, eager cap is 5) so the id lookups are deterministic, not racy.
    const restoredA = await app.getWindow(slugA, 15000);
    await restoredA.waitForLoadState('domcontentloaded');
    const restoredB = await app.getWindow(slugB, 15000);
    await restoredB.waitForLoadState('domcontentloaded');
    const restoredAId = await restoredIdForSlug(slugA);
    const restoredBId = await restoredIdForSlug(slugB);
    expect(restoredAId, 'restored page A enumerable').not.toBeNull();
    expect(restoredBId, 'restored page B enumerable').not.toBeNull();
    expect(restoredAId).not.toBe(restoredBId);

    const counters = await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.getRestoreFocusCounters()) as any) as
      { focuses: number; hybridActivations: number; focusedId: number | null };

    // EXACTLY ONE hybrid window is activated — never both. Pre-fix every restored
    // hybrid activated at open time; the fix shows them inactive and activates
    // only the focused descriptor here.
    expect(
      counters.hybridActivations,
      'restore must activate exactly ONE hybrid window (the focused descriptor), never every restored page',
    ).toBe(1);

    // IDENTITY: the window restore raised is the RESTORED page A, not page B.
    expect(
      counters.focusedId,
      'restore must raise+activate the restored page A (focused at quit), not page B',
    ).toBe(restoredAId);

    // The app's notion of the frontmost window (IZUI focused id) is page A.
    const izuiFocusedId = await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.getIzuiFocusedWindowId()) as any) as number | null;
    expect(
      izuiFocusedId,
      'after restore, the focused window must be the restored page A, not page B',
    ).toBe(restoredAId);

    // Cleanup.
    await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.clearAppFocusedForTest()) as any);
    await bgWindow.evaluate(async (slugs: string[]) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return;
      for (const w of list.windows || []) {
        if (typeof w.url === 'string' && slugs.some((s) => w.url.includes(s))) {
          await (window as any).app.window.close(w.id);
        }
      }
    }, [slugA, slugB]);
  });
});
