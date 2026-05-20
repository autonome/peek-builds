/**
 * Regression: opening a peek-style web-page window and closing it within
 * 1.5s of did-stop-loading used to crash the main process with
 * `TypeError: Object has been destroyed at Timeout._onTimeout` because
 * the deferred `captureThumbnail` body dereferenced `win.webContents` on
 * an already-destroyed BrowserWindow.
 *
 * Fix: `setTimeout` body now bails out via `isDestroyed()` first.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('window thumbnail close race @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('thumb-close-race'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('closing a non-canvas web window before 1.5s thumbnail timer does not crash main', async () => {
    // Open as a modal/quick-view (peek-style) so isModalOrQuickView is true
    // — this is the non-canvas path that hit the 1797 setTimeout.
    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com/', {
        modal: true,
        width: 600,
        height: 400,
        role: 'quick-view',
        key: 'thumb-race-test',
      });
    });
    expect(open.success).toBe(true);
    const winId = open.id;

    // Close immediately, well under the 1.5s thumbnail debounce.
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, winId);

    // Wait past the 1.5s setTimeout window. If the bug were present, the main
    // process would throw an unhandled exception during this period.
    await new Promise((r) => setTimeout(r, 2500));

    // Sanity: the IPC bridge is still functional (main didn't crash).
    const stillAlive = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list?.() ?? true;
    });
    expect(stillAlive).toBeTruthy();
  });
});
