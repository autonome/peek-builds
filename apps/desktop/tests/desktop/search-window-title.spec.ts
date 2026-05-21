/**
 * search window title reflects active query
 *
 * Regression guard: document.title on search/home.html must update to
 * "Search: <query>" when a query is supplied via ?q=, and stay "Search"
 * when no query is present. The Windows switcher reads BrowserWindow.getTitle()
 * which mirrors document.title, so distinct queries show as distinct cards.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

test.describe('search window title @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('search-window-title'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /**
   * Open a search window for the given query and return its Page.
   * Waits until the window appears in the windows list with a matching URL.
   */
  const openSearchWindow = async (q: string): Promise<Page> => {
    const { id } = await bgWindow.evaluate(async (query: string) => {
      const r = await (window as any).app.window.open(
        `peek://search/home.html?q=${encodeURIComponent(query)}`,
        { role: 'workspace', width: 700, height: 768 },
      );
      return { id: r.id };
    }, q);
    expect(id).toBeTruthy();

    const deadline = Date.now() + 10000;
    let page: Page | undefined;
    while (Date.now() < deadline) {
      page = app.windows().find(p =>
        p.url().match(/peek:\/\/search\/home\.html/) !== null &&
        decodeURIComponent(p.url()).includes(`q=${q}`),
      );
      if (page) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(page, `search window for q=${q} not found`).toBeTruthy();
    await page!.waitForLoadState('domcontentloaded');
    return page!;
  };

  test('search window with query sets title to Search: <query>', async () => {
    const page = await openSearchWindow('foo');

    // Wait for document.title to be updated by home.js init + render
    await page.waitForFunction(
      () => document.title === 'Search: foo',
      { timeout: 5000 },
    );

    const title = await page.evaluate(() => document.title);
    expect(title).toBe('Search: foo');

    await bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list();
      return r;
    });
  });

  test('two search windows with distinct queries get distinct titles', async () => {
    const pageBar = await openSearchWindow('bar');
    const pageBaz = await openSearchWindow('baz');

    await pageBar.waitForFunction(
      () => document.title === 'Search: bar',
      { timeout: 5000 },
    );
    await pageBaz.waitForFunction(
      () => document.title === 'Search: baz',
      { timeout: 5000 },
    );

    const titleBar = await pageBar.evaluate(() => document.title);
    const titleBaz = await pageBaz.evaluate(() => document.title);

    expect(titleBar).toBe('Search: bar');
    expect(titleBaz).toBe('Search: baz');
    expect(titleBar).not.toBe(titleBaz);
  });

  test('windows switcher title field matches document.title', async () => {
    const page = await openSearchWindow('switcher-check');

    await page.waitForFunction(
      () => document.title === 'Search: switcher-check',
      { timeout: 5000 },
    );

    // api.window.list() reads BrowserWindow.getTitle() which mirrors document.title
    const windowEntry = await bgWindow.waitForFunction(async () => {
      const r = await (window as any).app.window.list();
      if (!r || !r.windows) return null;
      const w = r.windows.find((w: { url?: string; title?: string }) =>
        typeof w.url === 'string' &&
        /peek:\/\/search\/home\.html/.test(w.url) &&
        typeof w.title === 'string' &&
        w.title.includes('switcher-check'),
      );
      return w || null;
    }, { timeout: 5000 });

    expect(windowEntry).not.toBeNull();
    const entry = await windowEntry.jsonValue() as { title: string };
    expect(entry.title).toBe('Search: switcher-check');
  });

  test('search window with no query keeps title as Search', async () => {
    // Open search with an empty query via direct URL (no ?q= param)
    const { id } = await bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.open(
        'peek://search/home.html',
        { role: 'workspace', width: 700, height: 768 },
      );
      return { id: r.id };
    });
    expect(id).toBeTruthy();

    const deadline = Date.now() + 10000;
    let emptyPage: Page | undefined;
    while (Date.now() < deadline) {
      // Match peek://search/home.html (not websearch/home.html) with NO q= param
      emptyPage = app.windows().find(p => {
        const url = p.url();
        if (!url.match(/peek:\/\/search\/home\.html/)) return false;
        const params = new URLSearchParams(new URL(url).search);
        return !params.get('q');
      });
      if (emptyPage) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(emptyPage, 'empty-query search window not found').toBeTruthy();
    await emptyPage!.waitForLoadState('domcontentloaded');

    // After init, document.title should remain "Search"
    await emptyPage!.waitForFunction(
      () => document.title !== '',
      { timeout: 5000 },
    );

    const title = await emptyPage!.evaluate(() => document.title);
    expect(title).toBe('Search');
  });

  test('title truncates long queries at 60 chars with ellipsis', async () => {
    const longQuery = 'a'.repeat(65);
    const page = await openSearchWindow(longQuery);

    await page.waitForFunction(
      (q: string) => document.title.startsWith('Search: ') && document.title !== `Search: ${q}`,
      longQuery,
      { timeout: 5000 },
    );

    const title = await page.evaluate(() => document.title);
    expect(title.startsWith('Search: ')).toBe(true);
    // 60-char limit: "Search: " prefix + 59 chars + "…" = 9 + 59 + 1 = 69 total,
    // but "Search: " is 8 chars, so title length = 8 + MAX chars total body length
    // The implementation: truncated = q.slice(0, 59) + "…" when q.length > 60
    expect(title.length).toBeLessThan('Search: '.length + longQuery.length);
    expect(title.endsWith('…')).toBe(true);
  });
});
