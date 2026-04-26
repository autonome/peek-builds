/**
 * Regression coverage: typing `#tagA #tagB` in the cmd panel and pressing
 * Enter routes to the search view filtered by those tags. This was a daily
 * shortcut that broke during the cmd-panel rework when the all-hashtags
 * fallback was removed alongside the (intentional) web-search fallback.
 *
 * The fix wires TYPING + ENTER + isAllHashtags → openSearch.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('cmd hashtag → search @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-hashtag-search'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('typing #todo #today + Enter opens search/home with q param', async () => {
    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true, width: 600, height: 400, frame: false,
        transparent: true, alwaysOnTop: true, center: true,
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    await cmdWindow.fill('input', '#todo #today');
    await cmdWindow.keyboard.press('Enter');

    // Search/home should open with q=#todo #today.
    // Use regex to avoid substring match against `peek://websearch/home.html`.
    const searchWindow = await app.getWindow(/peek:\/\/search\/home\.html/, 10000);
    expect(searchWindow).toBeTruthy();
    await searchWindow.waitForLoadState('domcontentloaded');

    const url = searchWindow.url();
    const params = new URLSearchParams(new URL(url).search);
    expect(params.get('q')).toBe('#todo #today');

    // Cleanup any windows
    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }
  });
});
