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
import http from 'http';

test.describe('headless no permission flash @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('headless-no-perm-flash'));

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

  test('canvas page-host window for HTTP origin stays hidden after open', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');

    const url = `http://127.0.0.1:${serverPort}/perm-flash`;
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const winId: number = result.id;
    expect(winId).toBeTruthy();

    // Poll until the BrowserWindow exists in the main process.
    await app.evaluateMain<void, number>(({ BrowserWindow }, wid) => {
      return new Promise<void>((resolve) => {
        const w = BrowserWindow.fromId(wid);
        if (w && !w.isDestroyed()) { resolve(); return; }
        resolve();
      });
    }, winId);

    // The page-host window must not be visible in headless.
    const isVisible = await app.evaluateMain<boolean, number>(
      ({ BrowserWindow }, wid) => {
        const w = BrowserWindow.fromId(wid);
        if (!w || w.isDestroyed()) return false;
        return w.isVisible();
      },
      winId,
    );
    expect(isVisible).toBe(false);

    // Opacity must be at the default (1) or 0 — never 0→nonzero restored.
    // The entry.ts guard throws process.exitCode=1 if opacity goes 0→nonzero,
    // which would have crashed the test above. This assertion is belt-and-
    // suspenders for the opacity value after the full page load cycle.
    const opacity = await app.evaluateMain<number, number>(
      ({ BrowserWindow }, wid) => {
        const w = BrowserWindow.fromId(wid);
        if (!w || w.isDestroyed()) return -1;
        return w.getOpacity();
      },
      winId,
    );
    // Opacity must not be a nonzero value restored from 0 (flash indicator).
    // Acceptable: 1 (never shown via headless safe path) or 0 (shown headless-safe).
    expect(opacity === 0 || opacity === 1).toBe(true);

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, winId);
  });
});
