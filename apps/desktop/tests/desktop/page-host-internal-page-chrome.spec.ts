/**
 * An internal peek:// page opened as a page host (New Tab, the way cmd+N opens
 * it) gets the chrome overlay like any other page host: the overlay attaches
 * and Cmd+L reaches the address bar's focus path.
 *
 * Run with:
 *   yarn test:grep "Page host internal page chrome"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady } from '../helpers/hybrid-page';

let app: DesktopApp;
let bgWindow: Page;

test.describe('Page host internal page chrome @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-internal-chrome'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridge = async () => app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('New Tab opened as a page host gets the chrome overlay and Cmd+L reaches the address bar', async () => {
    test.skip(!(await bridge()), 'no overlay bridge in this configuration');
    const url = 'peek://app/new-tab/index.html';
    // A real window can be occluded or inactive, so its page never composites a
    // frame to report. Drop the first-frame listener to model a host that never
    // reports one: only the main-process load outcome can make it orderable.
    await app.evaluateMain!((({ ipcMain }: any) => {
      ipcMain.removeAllListeners('hybrid:first-frame');
    }) as any);
    const before = (await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds() as number[])) as number[];
    // The same call the new-window command makes.
    await bgWindow.evaluate((u: string) => {
      (window as any).app.window.open(u, { trackingSource: 'new-window', trackingSourceId: 'shortcut' });
    }, url);
    const id = (await app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) =>
      (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(arg.url, arg.before, 8000)) as any, {
      url,
      before,
    })) as number | null;
    expect(id, 'a page host should be registered for New Tab').not.toBeNull();

    await app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.setActive(i)) as any, id);
    await expect
      .poll(
        async () =>
          app.evaluateMain!(() => (globalThis as any).__peekHybridOverlayTest.activeId() as number | null),
        { timeout: 6000, message: 'the chrome overlay should attach to the New Tab host' },
      )
      .toBe(id);
    await waitOverlayReady(app);

    // Cmd+L for this host passes the navbar focus gates (no `not-host` refusal).
    const start = (await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.showNavbarFocusCount())) as number;
    await app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.publishTopic('page:show-navbar', { windowId: i })) as any, id);
    await expect
      .poll(async () =>
        app.evaluateMain!(() => (globalThis as any).__peekHybridOverlayTest.showNavbarFocusCount()),
      )
      .toBe(start + 1);

    await bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id as number);
  });
});
