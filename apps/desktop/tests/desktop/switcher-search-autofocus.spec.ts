import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

/**
 * The window switcher opens with the caret already in its search box.
 *
 * `features/windows/background.js openWindowsView()` opens
 * `peek://windows/windows.html` keyed on its own address, so `windows.js
 * init()` runs once per opened view and focusing there covers every entry
 * point (the `windows` command, the global shortcut, and Escape's switcher
 * fallback alike).
 *
 * Real OS focus is unobservable headless (see `apps/desktop/CLAUDE.md`, the
 * first-responder LESSON), so these assert the page's own focused element and
 * the keystrokes that element receives — never where the window manager thinks
 * focus is.
 *
 * The switcher itself is an ordinary tile `BrowserWindow`, so Playwright sees
 * it as a `Page` and can type into it for real. The two listed targets are
 * `http://` content windows, which are hybrid `BaseWindow`s and therefore not
 * `Page`s — they exist here only to give the list something to filter.
 *
 * The three tests share ONE switcher view, opened once in `beforeAll`. The
 * open is keyed on the view's own address, so a second `cmd:execute:windows`
 * while the view is up reuses the live window instead of re-running `init()`
 * — re-opening per test would prove nothing new. The caret that the single
 * open placed is what all three act on, which is the point being proven:
 * nothing has to put it back.
 *
 *   yarn test:grep "switcher"
 */
test.describe('Windows switcher search autofocus @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;
  let zebraId: number;
  let mangoId: number;
  let switcher: Page;

  /** Title each served page after its path, so titles and URLs both differ. */
  const titleForPath = (path: string) =>
    path.includes('zebra') ? 'Zebra Switcher Target' : 'Mango Switcher Target';

  const openContentWindow = async (path: string): Promise<number> => {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 400, height: 300 });
    }, `http://127.0.0.1:${serverPort}${path}`);
    expect(result.success).toBe(true);
    return result.id as number;
  };

  /**
   * Open the switcher the way the global hotkey does and return it once its
   * cards are rendered. Waiting on a card is the synchronization point:
   * `init()` focuses the search input in the same synchronous run as the
   * `renderWindows()` call that appends them, so a rendered card means the
   * focus call has already happened.
   */
  const openSwitcher = async (): Promise<Page> => {
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('windows');
    });
    const view = await app.getWindow('windows/windows.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector(`peek-card[data-window-id="${zebraId}"]`, { timeout: 10000 });
    await view.waitForSelector(`peek-card[data-window-id="${mangoId}"]`, { timeout: 10000 });
    return view;
  };

  const cardCount = (): Promise<number> =>
    switcher.evaluate(() => document.querySelectorAll('.cards peek-card').length);

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('switcher-search-autofocus'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const title = titleForPath(req.url || '');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${title}</body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // The switcher dismisses itself on `window:opened`, and a hybrid content
    // window announces itself on that topic some time after `window.open`
    // resolves. Record the announcements so the switcher is not opened until
    // both targets' are in the past.
    await bgWindow.evaluate(() => {
      (window as any).__openedWindowIds = [];
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg && typeof msg.id === 'number') (window as any).__openedWindowIds.push(msg.id);
      });
    });

    zebraId = await openContentWindow('/zebra');
    mangoId = await openContentWindow('/mango');

    await expect
      .poll(() => bgWindow.evaluate(() => (window as any).__openedWindowIds as number[]), {
        timeout: 15000,
      })
      .toEqual(expect.arrayContaining([zebraId, mangoId]));

    switcher = await openSwitcher();
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('the search input holds focus as soon as the switcher opens', async () => {
    const focused = await switcher.evaluate(() => {
      const active = document.activeElement as (HTMLElement & { shadowRoot?: ShadowRoot }) | null;
      return {
        tag: active ? active.tagName.toLowerCase() : null,
        className: active ? active.className : null,
        // Shadow DOM retargets `document.activeElement` to the host, so the
        // inner native input is where the caret actually sits.
        innerTag: active?.shadowRoot?.activeElement?.tagName.toLowerCase() ?? null,
      };
    });

    expect(focused.tag).toBe('peek-input');
    expect(focused.className).toContain('search-input');
    expect(focused.innerTag).toBe('input');
  });

  test('typing filters the switcher list with no click first', async () => {
    expect(await cardCount()).toBeGreaterThanOrEqual(2);

    // No click, no focus call — straight to the keyboard, which is the whole
    // point of the change.
    await switcher.keyboard.type('zebra');

    await expect
      .poll(
        () =>
          switcher.evaluate(
            () => (document.querySelector('peek-input.search-input') as any)?.value ?? '',
          ),
        { timeout: 5000 },
      )
      .toBe('zebra');

    await expect.poll(() => cardCount(), { timeout: 5000 }).toBe(1);
    await expect(switcher.locator(`peek-card[data-window-id="${zebraId}"]`)).toHaveCount(1);
    await expect(switcher.locator(`peek-card[data-window-id="${mangoId}"]`)).toHaveCount(0);
  });

  test('ArrowDown then Enter still activates a card', async () => {
    expect(await cardCount()).toBeGreaterThanOrEqual(1);

    await switcher.keyboard.press('ArrowDown');

    // The arrow reached the list rather than being swallowed by the focused
    // input: a card is still selected, and the caret has not left the search.
    const afterArrow = await switcher.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.cards peek-card')) as any[];
      const active = document.activeElement as HTMLElement | null;
      return {
        selectedCards: cards.filter((c) => c.selected).length,
        activeTag: active ? active.tagName.toLowerCase() : null,
      };
    });
    expect(afterArrow.selectedCards).toBe(1);
    expect(afterArrow.activeTag).toBe('peek-input');

    // Activation tears this page down from under the keypress, so the press
    // itself can come back as "target closed" — which is the outcome under
    // test, not a failure. The poll below is what judges it.
    await switcher.keyboard.press('Enter').catch(() => {});

    // `activateSelected()` closes the switcher only after resolving a window
    // from the selection, so the close IS the activation.
    await expect.poll(() => switcher.isClosed(), { timeout: 10000 }).toBe(true);
  });
});
