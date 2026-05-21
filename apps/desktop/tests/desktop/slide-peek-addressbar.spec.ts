/**
 * slide peek addressbar
 *
 * Verifies that slide and peek windows rendered with `canvas: true, modal: true`
 * go through the page-host shell and therefore have a navbar (#navbar) element.
 *
 * Also verifies the negative case: a plain window-open without `canvas` does NOT
 * load the page-host shell (no #navbar on that window's DOM root).
 *
 * Run with:
 *   yarn test:grep "slide peek addressbar"
 */

import { test, expect } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { DesktopApp } from '../fixtures/desktop-app';

test.describe('slide peek addressbar @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slide-peek-addressbar'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------------
  // Positive: canvas: true + modal: true → page-host shell → #navbar present
  // ---------------------------------------------------------------------------

  test('slide-style window with canvas:true has a navbar element', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        role: 'quick-view',
        modal: true,
        canvas: true,
        type: 'panel',
        width: 800,
        height: 600,
        key: 'test-slide-addressbar',
        screenEdge: 'Up',
        show: false,
      });
    });
    expect(result.success).toBe(true);

    // Canvas page-host windows load peek://app/page/index.html
    const pageWindow = await app.getWindow('page/index.html', 15000);
    expect(pageWindow).toBeTruthy();

    // Wait for #navbar to appear in the DOM
    await (pageWindow as Page).waitForFunction(
      () => document.getElementById('navbar') !== null,
      undefined,
      { timeout: 15000 }
    );

    const navbarExists = await (pageWindow as Page).evaluate(
      () => document.getElementById('navbar') !== null
    );
    expect(navbarExists).toBe(true);

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, result.id);
  });

  test('peek-style window with canvas:true has a navbar element', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        role: 'quick-view',
        modal: true,
        canvas: true,
        type: 'panel',
        width: 800,
        height: 600,
        key: 'test-peek-addressbar',
        center: true,
        show: false,
      });
    });
    expect(result.success).toBe(true);

    const pageWindow = await app.getWindow('page/index.html', 15000);
    expect(pageWindow).toBeTruthy();

    await (pageWindow as Page).waitForFunction(
      () => document.getElementById('navbar') !== null,
      undefined,
      { timeout: 15000 }
    );

    const navbarExists = await (pageWindow as Page).evaluate(
      () => document.getElementById('navbar') !== null
    );
    expect(navbarExists).toBe(true);

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, result.id);
  });

  // ---------------------------------------------------------------------------
  // Negative: plain web window (no canvas) does NOT load the page-host shell
  // ---------------------------------------------------------------------------

  test('plain modal window without canvas does not use page-host shell', async () => {
    // A modal window with no canvas: true should load the URL directly,
    // not through the page-host shell. The window's URL should not be
    // peek://app/page/index.html.
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        modal: true,
        width: 800,
        height: 600,
        key: 'test-modal-no-canvas',
        show: false,
      });
    });
    expect(result.success).toBe(true);

    // Verify via main process that the window's URL is not page/index.html
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const windowUrl = await app.evaluateMain<string | null, number>(
      ({ BrowserWindow }, wid) => {
        const w = BrowserWindow.fromId(wid);
        if (!w || w.isDestroyed()) return null;
        return w.webContents.getURL();
      },
      result.id,
    );

    expect(windowUrl).not.toContain('page/index.html');

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, result.id);
  });
});
