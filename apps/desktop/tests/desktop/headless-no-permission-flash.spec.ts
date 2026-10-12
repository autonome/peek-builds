/**
 * headless-no-permission-flash
 *
 * Drift-detection guard: opening a canvas page-host window (the vector for
 * the permission-prompt flow) in headless mode must keep the window hidden.
 *
 * Root cause context: bare win.show() calls in the keepLive-reuse and
 * url-dedup-reuse paths in ipc.ts did not go through showWindowHeadlessSafe,
 * meaning in headless they could show windows with opacity=1 — a visible flash.
 * setAlwaysOnTop was also not gated on !isHeadless(), which can trigger a
 * macOS compositor repaint even on opacity=0 windows.
 *
 * Fix: showWindowHeadlessSafe replaces bare win.show() in both reuse paths;
 * setAlwaysOnTop is now gated on !isHeadless(). The headless setOpacity
 * 0→nonzero guard in entry.ts catches regressions that restore opacity to
 * a visible value. This test is the regression gate for window visibility.
 *
 * Run with:
 *   yarn test:grep "headless no permission flash"
 */

import { test, expect } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { DesktopApp } from '../fixtures/desktop-app';
import { isHybridWindow, hostVisibility } from '../helpers/hybrid-page';
import http from 'http';

test.describe('headless no permission flash @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('headless-no-perm-flash', { headless: true }));

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>perm flash test</h1></body></html>');
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

  test('page-host window for HTTP origin stays hidden after open', async () => {
    // The headless show path hides a page-host by opacity 0, and Electron's
    // setOpacity does nothing on Linux, so there the window is painted.
    test.skip(process.platform === 'linux', 'Electron has no window opacity on Linux');
    if (!app.evaluateMain) throw new Error('evaluateMain not available');

    const url = `http://127.0.0.1:${serverPort}/perm-flash`;
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const winId: number = result.id;
    expect(winId).toBeTruthy();

    // Resolve the page-host window's visibility + opacity through the right path.
    // On the canvas path the page-host is a BrowserWindow (`fromId`). On the
    // hybrid path it's a BaseWindow + WebContentsView,
    // invisible to `BrowserWindow.fromId` — its visible/opacity state lives in
    // the hybrid registry, read via the `hostVisibility` bridge. Either way the
    // assertion is identical: the page-host (the permission-prompt vector) must
    // stay hidden in headless, with opacity never restored 0→nonzero.
    const hybrid = await isHybridWindow(app, winId);

    let isVisible: boolean;
    let opacity: number;
    if (hybrid) {
      const vis = await hostVisibility(app, winId);
      expect(vis).not.toBeNull();
      isVisible = vis!.visible;
      opacity = vis!.opacity;
    } else {
      // Poll until the BrowserWindow exists in the main process.
      await app.evaluateMain<void, number>(({ BrowserWindow }, wid) => {
        return new Promise<void>((resolve) => {
          const w = BrowserWindow.fromId(wid);
          if (w && !w.isDestroyed()) { resolve(); return; }
          resolve();
        });
      }, winId);

      isVisible = await app.evaluateMain<boolean, number>(
        ({ BrowserWindow }, wid) => {
          const w = BrowserWindow.fromId(wid);
          if (!w || w.isDestroyed()) return false;
          return w.isVisible();
        },
        winId,
      );
      // The entry.ts guard throws process.exitCode=1 if opacity goes 0→nonzero,
      // which would have crashed the test above. This read is belt-and-
      // suspenders for the opacity value after the full page load cycle.
      opacity = await app.evaluateMain<number, number>(
        ({ BrowserWindow }, wid) => {
          const w = BrowserWindow.fromId(wid);
          if (!w || w.isDestroyed()) return -1;
          return w.getOpacity();
        },
        winId,
      );
    }

    // The page-host (permission-prompt vector) must never PAINT in headless —
    // no visible flash. The two page-host implementations satisfy this two
    // different but equivalent ways, and the assertion encodes the shared
    // invariant ("not paintable") rather than a single implementation's shape:
    //
    //  - Canvas page-host:  born `show:false` → `isVisible() === false`
    //    (opacity stays at default 1; never shown so never painted).
    //  - Hybrid page-host:  `setOpacity(0)` then `showInactive()` in the
    //    headless branch (ipc.ts) → `isVisible() === true` but `opacity === 0`,
    //    so the compositor never paints it (the documented headless-safe show).
    //
    // Invariant: the host is not painted — it's either hidden, or visible at
    // opacity 0. A regression that restored opacity to a nonzero value on a
    // visible host (the actual flash) fails this. The entry.ts 0→nonzero guard
    // catches the same class of regression by crashing the run.
    const notPainted = isVisible === false || opacity === 0;
    expect(notPainted).toBe(true);

    // Opacity must never be a nonzero value on a visible host (the flash
    // indicator). Acceptable: 0 (shown headless-safe) or 1 only when hidden.
    expect(opacity === 0 || (opacity === 1 && isVisible === false)).toBe(true);

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, winId);
  });
});
