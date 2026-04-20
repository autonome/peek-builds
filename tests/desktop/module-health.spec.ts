/**
 * Module Health Tests — detects silent module-halt regressions
 *
 * Core renderer modules like `app/page/page.js` and `app/cmd/panel.js` start
 * with `await api.initialize()` at the top level. If any later top-level
 * statement throws synchronously (e.g. an `api.*` surface was renamed or
 * removed from tile-preload), the module evaluation halts as an unhandled
 * promise rejection. DOM is usually already rendered so the window looks
 * fine, but no subscribers register and no event handlers wire up — the
 * widget quietly stops reacting.
 *
 * The modules now set a sentinel (`window.__pageModuleReady` /
 * `window.__cmdPanelModuleReady`) as their last top-level statement. If
 * the sentinel doesn't flip within a few seconds of window open, an earlier
 * top-level statement threw. These tests catch that class of drift before
 * it manifests as confusing widget-doesn't-update bugs in other tests.
 *
 * See feedback_top_level_await_silent_halt.md for the canonical incident.
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

test.describe('Module Health @desktop', () => {
  test('page.js module evaluates to completion (no silent halt from api drift)', async () => {
    const openResult = await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        width: 800,
        height: 600,
        key: 'module-health-page',
      });
    });
    expect(openResult.success).toBe(true);
    const windowId = openResult.id;

    const pageWindow = await sharedApp.getWindow('page/index.html', 15000);
    expect(pageWindow).toBeTruthy();

    // Sentinel is the last top-level statement in page.js. If any earlier
    // top-level `api.*.x` call throws (e.g. renamed method like getWindowId
    // → getId, or removed namespace like api.ipc), the module halts silently
    // and this flag never flips.
    await pageWindow.waitForFunction(
      () => (window as any).__pageModuleReady === true,
      undefined,
      { timeout: 5000 }
    );

    await sharedBgWindow.evaluate(
      async (id: number) => (window as any).app.window.close(id),
      windowId
    );
  });

  test('cmd panel.js module evaluates to completion', async () => {
    const openResult = await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
      });
    });
    expect(openResult.success).toBe(true);
    const windowId = openResult.id;

    const cmdWindow = await sharedApp.getWindow('cmd/panel.html', 5000);
    expect(cmdWindow).toBeTruthy();

    await cmdWindow.waitForFunction(
      () => (window as any).__cmdPanelModuleReady === true,
      undefined,
      { timeout: 5000 }
    );

    await sharedBgWindow.evaluate(
      async (id: number) => (window as any).app.window.close(id),
      windowId
    );
  });
});
