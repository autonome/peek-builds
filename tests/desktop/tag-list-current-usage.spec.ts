/**
 * Regression coverage: the Tags feature sidebar must only render tags
 * that have at least one current (non-deleted) item. Tag rows persist
 * for rename/color survival but ghost tags shouldn't clutter the UI.
 *
 * Filter lives in features/tags/home.js (loadData/loadTags), not at the
 * datastore layer — the Groups feature still needs zero-usage tags so
 * newly-promoted empty groups appear immediately.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('tag list shows current-usage only @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-current-usage'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('Tags sidebar hides tag with no items, shows tag with items', async () => {
    const stamp = Date.now();
    const ghostName = `ghost-${stamp}`;
    const liveName = `live-${stamp}`;

    // Create a ghost tag (no items)
    const ghost = await bgWindow.evaluate(async (name: string) => {
      return await (window as any).app.datastore.getOrCreateTag(name);
    }, ghostName);
    expect(ghost.success).toBe(true);

    // Create a live tag with one item via inline-hashtag extraction
    const live = await bgWindow.evaluate(async (name: string) => {
      return await (window as any).app.datastore.addItem('text', { content: `present #${name}` });
    }, liveName);
    expect(live.success).toBe(true);

    // Open Tags
    const openRes = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://tags/home.html', { width: 900, height: 700 });
    });
    expect(openRes.success).toBe(true);

    const tagsWindow = await app.getWindow('tags/home.html', 5000);
    expect(tagsWindow).toBeTruthy();
    await tagsWindow.waitForLoadState('domcontentloaded');

    // Wait for the live tag to render in the sidebar (proves load completed)
    await tagsWindow.waitForFunction(
      (name: string) => {
        const items = Array.from(document.querySelectorAll('.tag-list .tag-chip .tag-name'));
        return items.some(el => (el.textContent || '').includes(name));
      },
      liveName,
      { timeout: 10000 }
    );

    const sidebarNames = await tagsWindow.$$eval('.tag-list .tag-chip .tag-name', (els: any[]) =>
      els.map(el => (el.textContent || '').trim())
    );

    expect(sidebarNames.some(n => n.includes(liveName))).toBe(true);
    expect(sidebarNames.some(n => n.includes(ghostName))).toBe(false);

    if (openRes.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openRes.id);
      } catch { /* may already be closed */ }
    }
  });
});
