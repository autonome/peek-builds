/**
 * Keyboard shortcuts on search/home list view.
 *
 * From peek:daily-use task: keyboard shortcuts in local search list view.
 *   - `x` toggles todo/done on the focused result (via the tag-swap affordance)
 *   - `Delete` / `Backspace` deletes the focused result
 *
 * The wiring is already in place:
 *   - `x` → `app/lib/grid-nav.js:151` → clicks the card's `.tag-action-toggle`
 *   - `Delete`/`Backspace` → `features/search/home.js:378` → `deleteSelectedItem()`
 *
 * This spec is the regression guard: future refactors of either path
 * must keep the keyboard behavior intact.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

test.describe('Search list keyboard shortcuts @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('search-kb-shortcuts'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const openSearchWindow = async (q: string): Promise<Page> => {
    const { id } = await bgWindow.evaluate(async (query: string) => {
      const r = await (window as any).app.window.open(
        `peek://search/home.html?q=${encodeURIComponent(query)}`,
        { role: 'workspace', width: 700, height: 768 },
      );
      return { id: r.id };
    }, q);
    expect(id).toBeTruthy();

    const deadline = Date.now() + 5000;
    let page: Page | undefined;
    while (Date.now() < deadline) {
      page = app.windows().find(p =>
        p.url().includes('search/home.html')
        && decodeURIComponent(p.url()).includes(`q=${q}`),
      );
      if (page) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(page, `search window for q=${q} not found`).toBeTruthy();
    await page!.waitForLoadState('domcontentloaded');
    return page!;
  };

  test('pressing x on focused card toggles todo → done via tag-swap affordance', async () => {
    const ts = Date.now();
    const testUri = `https://search-kb-x-${ts}.example.com/`;

    const setup = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      await api.datastore.getOrCreateTag('done');
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'kb-x test' }),
      });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);
      return { itemId: item.data.id };
    }, testUri);
    expect(setup.itemId).toBeTruthy();

    const win = await openSearchWindow('#todo');
    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;
    await win.waitForSelector(cardSelector, { timeout: 10000 });

    await win.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });

    await win.keyboard.press('x');

    await expect.poll(
      async () => bgWindow.evaluate(async (id: string) => {
        const r = await (window as any).app.datastore.getItemTags(id);
        return r.success ? r.data.map((t: any) => t.name).sort() : [];
      }, setup.itemId),
      { timeout: 8000, message: 'pressing x should flip #todo to #done in DB' },
    ).toEqual(['done']);
  });

  test('pressing Delete on focused card deletes the item', async () => {
    const ts = Date.now();
    const testUri = `https://search-kb-del-${ts}.example.com/`;
    const uniqTag = `kbdel${ts}`;

    const setup = await bgWindow.evaluate(async ({ uri, tagName }) => {
      const api = (window as any).app;
      const tag = await api.datastore.getOrCreateTag(tagName);
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'kb-del test' }),
      });
      await api.datastore.tagItem(item.data.id, tag.data.tag.id);
      return { itemId: item.data.id };
    }, { uri: testUri, tagName: uniqTag });
    expect(setup.itemId).toBeTruthy();

    const win = await openSearchWindow(`#${uniqTag}`);
    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;
    await win.waitForSelector(cardSelector, { timeout: 10000 });

    await win.evaluate(() => {
      (window as any).confirm = () => true;
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });

    await win.keyboard.press('Delete');

    await expect.poll(
      async () => bgWindow.evaluate(async (id: string) => {
        const r = await (window as any).app.datastore.getItem(id);
        return !!r?.data;
      }, setup.itemId),
      { timeout: 8000, message: 'pressing Delete should remove the item from the datastore' },
    ).toBe(false);
  });
});
