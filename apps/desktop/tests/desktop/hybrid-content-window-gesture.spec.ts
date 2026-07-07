/**
 * Content-area double-click window gesture — end-to-end over a REAL hybrid
 * page-host (peek d8ce0ddf).
 *
 * A double-click over "dead" page content toggles the host window's MAXIMIZE.
 * The gesture is SUPPRESSED when the multi-click lands on an editable/interactive
 * control OR when it selects text. The detection lives CONTENT-SIDE in the
 * universal preload (runtime-external-preload.cjs), which is applied to every
 * http(s) page-host content WC (getRuntimeExternalWebPrefsForUrl). So — unlike
 * the `data:`-URL hybrid specs, which get no preload — this spec loads content
 * from a local http server so the REAL capture-phase click listener runs.
 *
 * We drive the content WC's MAIN world with a synthetic
 * `new MouseEvent('click', { detail: 2 })`. contextIsolation gives the preload a
 * separate JS realm but the SAME DOM, so the preload's document-level capture
 * listener sees the dispatched event exactly as it sees a native one.
 *
 * Observable assertion: maximize snaps the host BaseWindow to its display's work
 * area (hostBounds(id) === hostWorkArea(id)) — the SAME assertion the overlay
 * maximize test uses. Because maximize is a strict TOGGLE, the suppression cases
 * are proven sleep-free by PARITY: fire the suppressed click, then a known-good
 * empty-area click. If suppression works, exactly one effective gesture lands and
 * the window ends MAXIMIZED; if the suppressed click had leaked, two toggles fire
 * and the window ends back at its ORIGINAL bounds — so the maximize assertion
 * fails, catching the regression with no timer.
 *
 * Fullscreen (detent 3) is deliberately NOT asserted here — real fullscreen is
 * unobservable in macOS-headless; the detent→'toggle-fullscreen' mapping is
 * covered by the pure unit (main/hybrid-window-gesture.test.ts).
 *
 *   yarn test:grep "Hybrid content window gesture"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  hybridBridgePresent,
  getHybridContentWcId,
  waitOverlayReady,
  type Rect,
} from '../helpers/hybrid-page';
import http from 'http';

// A single synthetic native-style double-click (detail:2) on `sel`. `sel` null =
// document.body (the "dead space" case). Optionally clear the live text selection
// first (so a fresh empty-area click carries no lingering selection).
function dispatchDoubleClickSrc(sel: string | null, clearSelection: boolean): string {
  const target = sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document.body';
  return `(function () {
    ${clearSelection ? 'try { window.getSelection().removeAllRanges(); } catch (_) {}' : ''}
    var el = ${target};
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true, composed: true, cancelable: true }));
    return true;
  })()`;
}

test.describe('Hybrid content window gesture @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let port: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-content-window-gesture'));

    // Local http server so the content WC gets the REAL universal preload (the
    // gesture listener only loads on http(s) — data: URLs get no preload).
    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>Gesture</title></head>` +
            `<body style="margin:0;height:100vh">` +
            `<div id="dead" style="width:100%;height:240px"></div>` +
            `<p id="para">hello selectable words here</p>` +
            `<input id="inp" value="x">` +
            `<button id="btn">Press</button>` +
            `</body></html>`,
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (app) await app.close();
  });

  // Open a REAL hybrid page-host on the local server, make it the active window
  // (so the singleton chrome overlay — the single source of truth for maximize —
  // frames it), and resolve its content WC id for MAIN-world dispatch. Each call
  // uses a UNIQUE path so the hybrid find-by-url dedup never collapses a later
  // open onto an earlier (already-maximized) window.
  let seq = 0;
  async function openGestureWindow(): Promise<{ id: number; wcId: number }> {
    const token = `g-${++seq}`;
    const openResult = await bgWindow.evaluate(async (targetUrl: string) => {
      return await (window as any).app.window.open(targetUrl, { width: 720, height: 520 });
    }, `http://127.0.0.1:${port}/${token}`);
    expect(openResult.success).toBe(true);
    const id = openResult.id as number;

    const pageWindow = await app.getWindow(token, 15000);
    expect(pageWindow).toBeTruthy();
    await pageWindow.waitForLoadState('domcontentloaded');

    const wcId = await getHybridContentWcId(app, id);
    expect(wcId, 'a live hybrid must expose its content wc id').not.toBeNull();

    // Frame the overlay over this window (focus-free) and wait for its renderer,
    // which owns the maximize toggle the gesture routes through.
    await app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.setActive(wid);
    }, id);
    await waitOverlayReady(app);

    return { id, wcId: wcId as number };
  }

  const runInContent = (wcId: number, src: string) =>
    app.evaluateMain!(
      (async ({ webContents }: any, arg: { wcId: number; src: string }) => {
        const wc = webContents.fromId(arg.wcId);
        if (!wc || wc.isDestroyed()) return null;
        return wc.executeJavaScript(arg.src);
      }) as any,
      { wcId, src },
    );

  const hostBoundsOf = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBounds(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const workAreaOf = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostWorkArea(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  test('double-click on dead content maximizes the host window', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();

    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(workArea).not.toBeNull();
    expect(before).not.toBeNull();
    // Sanity: the fresh window is NOT already at the work area, so "became the
    // work area" is a meaningful signal (not vacuously true).
    expect(before).not.toEqual(workArea);

    // Dead-space double-click over the empty body → gesture fires → maximize.
    const fired = await runInContent(wcId, dispatchDoubleClickSrc(null, true));
    expect(fired).toBe(true);

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('double-click on an <input> does NOT maximize (interactive target suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    // Parity proof (sleep-free): suppressed click on the input, THEN a known-good
    // dead-space click. Maximize is a strict toggle — if the input click were
    // (wrongly) NOT suppressed, two effective gestures fire and the window ends
    // back at `before`; the poll for the work area then times out and FAILS.
    await runInContent(
      wcId,
      dispatchDoubleClickSrc('#inp', false) + ';' + dispatchDoubleClickSrc(null, true),
    );

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('double-click on a <button> does NOT maximize (interactive target suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    await runInContent(
      wcId,
      dispatchDoubleClickSrc('#btn', false) + ';' + dispatchDoubleClickSrc(null, true),
    );

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });

  test('double-click that selected text does NOT maximize (selection suppressed)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const before = await hostBoundsOf(id);
    expect(before).not.toEqual(workArea);

    // Select the paragraph's text, THEN double-click on it: a non-collapsed
    // selection means "the user is selecting, not gesturing" → suppressed. Then
    // clear the selection and fire a known-good dead-space click. Same toggle
    // parity: a leak would toggle back to `before` and fail the maximize poll.
    const selectAndClick = `(function () {
      var p = document.getElementById('para');
      var s = window.getSelection();
      s.removeAllRanges();
      s.selectAllChildren(p);
      p.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true, composed: true, cancelable: true }));
      return { selected: String(s).length > 0 };
    })()`;
    const sel = (await runInContent(wcId, selectAndClick)) as { selected: boolean } | null;
    expect(sel && sel.selected).toBe(true);

    await runInContent(wcId, dispatchDoubleClickSrc(null, true));

    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
  });
});
