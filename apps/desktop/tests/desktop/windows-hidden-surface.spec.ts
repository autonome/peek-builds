/**
 * Regression coverage: pin-hidden web page windows must remain in the
 * Windows feature listing (tile:window:list) so the user can find and
 * unhide them. The Windows UI renders them dimmed with a "Hidden" badge.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Windows feature surfaces hidden windows @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('windows-hidden'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('hidden window appears in tile:window:list with visible:false', async () => {
    // Open a transient page-host window
    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com/', {
        width: 600,
        height: 400,
      });
    });
    expect(open.success).toBe(true);
    const winId = open.id;
    expect(winId).toBeTruthy();

    // Hide it
    const hideRes = await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.hide(id);
    }, winId);
    expect(hideRes.success !== false).toBe(true);

    // List windows; the hidden one should still be present with visible: false
    const list = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list({ includeInternal: true });
    });
    expect(list.success).toBe(true);
    const found = (list.windows || []).find((w: { id: number }) => w.id === winId);
    expect(found).toBeTruthy();
    expect(found.visible).toBe(false);

    // Cleanup
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, winId);
  });
});
