import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady, waitForAppReady, waitForPanelCommandsLoaded } from '../helpers/window-utils';

/**
 * The command panel's URL action. When the panel holds a web address (typed,
 * suggested or highlighted), a button at the right end of the input says what
 * Cmd+Enter will do:
 *   - `data-action="switch"` when a window showing that page is open;
 *   - `data-action="open"` when none is, including when the page exists only
 *     in the saved windows of a space that is not active (those windows are
 *     closed, so there is nothing to switch to).
 * Cmd+Enter on a "switch" address brings the open window forward without
 * creating another one.
 *
 * Contract this spec pins: `button#url-action` inside `cmd/panel.html`, with
 * `data-action` set to `switch` or `open` for a URL.
 *
 * Run with:
 *   echo 'apps/desktop/tests/desktop-serial/cmd-switch-to-page.spec.ts' > "$(scripts/tagged-path.sh test-spec)"
 *   yarn test:desktop:electron:spec:bg
 */
test.describe('Cmd panel switch-to-page action @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  const OPEN_URL = 'https://example.com/cmd-switch-target';
  const NOT_OPEN_URL = 'https://example.com/cmd-switch-not-open';
  const SAVED_ONLY_URL = 'https://example.com/cmd-switch-saved-only';

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-switch-to-page'));
    await waitForExtensionsReady(bgWindow, 15000);
    await waitForAppReady(bgWindow);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // A live cmd/panel.html page that is not `exclude` (a previous test's panel
  // may still be tearing down, and `app.getWindow` does not check isClosed()).
  const livePanelPage = async (exclude?: Page): Promise<Page> => {
    const pick = () =>
      app
        .windows()
        .find(p => p.url().includes('cmd/panel.html') && !p.isClosed() && p !== exclude);
    await expect
      .poll(() => pick() !== undefined, { timeout: 10000, message: 'no live cmd/panel.html page' })
      .toBe(true);
    return pick()!;
  };

  const openPanel = async (text: string, exclude?: Page): Promise<Page> => {
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
      });
    });
    expect(openResult.success).toBe(true);
    const panel = await livePanelPage(exclude);
    await panel.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(panel, 10000);
    await panel.fill('input', text);
    return panel;
  };

  const closePanel = async (panel: Page) => {
    if (panel.isClosed()) return;
    await panel.keyboard.press('Escape').catch(() => {});
    if (!panel.isClosed()) await panel.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  };

  const liveWindowsAt = async (url: string): Promise<number[]> => {
    return await bgWindow.evaluate(async (target: string) => {
      const list = await (window as any).app.window.list();
      return (list.windows || [])
        .filter((w: any) => typeof w.url === 'string' && w.url.startsWith(target))
        .map((w: any) => w.id);
    }, url);
  };

  test('a URL with no open window offers opening a new one', async () => {
    const panel = await openPanel(NOT_OPEN_URL);
    const action = panel.locator('button#url-action');
    await expect(action, 'the URL action button is missing').toBeVisible({ timeout: 5000 });
    await expect(action).toHaveAttribute('data-action', 'open', { timeout: 5000 });
    await closePanel(panel);
  });

  test('a URL open in a window offers switching, and Cmd+Enter switches without a new window', async () => {
    const opened = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.window.open(url, { width: 800, height: 600 });
    }, OPEN_URL);
    expect(opened.success).toBe(true);
    await expect
      .poll(async () => (await liveWindowsAt(OPEN_URL)).length, { timeout: 15000 })
      .toBe(1);
    const [existingId] = await liveWindowsAt(OPEN_URL);

    // Count fresh windows for the address from here on; switching publishes none.
    await bgWindow.evaluate((url: string) => {
      const api = (window as any).app;
      (window as any).__switchTargetOpened = 0;
      api.subscribe('window:opened', (msg: any) => {
        if ((msg?.url || '').startsWith(url)) (window as any).__switchTargetOpened++;
      });
    }, OPEN_URL);

    const panel = await openPanel(OPEN_URL);
    const action = panel.locator('button#url-action');
    await expect(action, 'the URL action button is missing').toBeVisible({ timeout: 5000 });
    await expect(action).toHaveAttribute('data-action', 'switch', { timeout: 5000 });

    // Cmd+Enter. Keydown only: switching moves focus away and the panel can
    // close before a keyup would be delivered.
    await panel.keyboard.down('Meta');
    await panel.keyboard.down('Enter');

    // The panel acts on it: it leaves TYPING or closes. A panel that ignores
    // Cmd+Enter stays in TYPING and this fails.
    const acted = await Promise.race([
      panel.waitForEvent('close', { timeout: 10000 }).then(() => true).catch(() => false),
      panel
        .waitForFunction(
          () => {
            const s = (window as any)._cmdState;
            return !!(s && s.currentState && s.currentState !== 'TYPING');
          },
          undefined,
          { timeout: 10000 }
        )
        .then(() => true)
        .catch(() => panel.isClosed()),
    ]);
    expect(acted, 'Cmd+Enter did nothing in the panel').toBe(true);

    const freshOpens = await bgWindow.evaluate(() => (window as any).__switchTargetOpened);
    expect(freshOpens, 'Cmd+Enter opened another window instead of switching').toBe(0);
    expect(await liveWindowsAt(OPEN_URL)).toEqual([existingId]);

    // Focus is only observable with a real display (headless skips show/focus).
    if (!process.env.HEADLESS) {
      const focused = await bgWindow.evaluate(async (id: number) => {
        const list = await (window as any).app.window.list();
        return !!(list.windows || []).find((w: any) => w.id === id && w.focused);
      }, existingId);
      expect(focused, 'the existing window was not brought forward').toBe(true);
    }

    await closePanel(panel);
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, existingId);
  });

  test('a URL saved only in an inactive space offers opening a new one', async () => {
    // Save the address into a space that is not active, by dropping it on that
    // space's card: the space's saved windows gain it, nothing opens.
    const spaceId = await bgWindow.evaluate(async (tagName: string) => {
      const r = await (window as any).app.datastore.getOrCreateTag(tagName);
      return (r?.data?.tag?.id ?? null) as string | null;
    }, 'space:cmd-switch-saved');
    expect(spaceId).toBeTruthy();

    const browseAll = () =>
      app
        .windows()
        .filter(p => !p.isClosed() && p.url().includes('spaces/home.html') && !p.url().includes('spaceId='));
    const before = new Set(browseAll());
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('open spaces');
    });
    let spacesPage: Page | undefined;
    await expect
      .poll(() => {
        spacesPage = browseAll().find(p => !before.has(p));
        return !!spacesPage;
      }, { timeout: 15000, message: 'the Spaces page never opened' })
      .toBe(true);
    await spacesPage!.waitForLoadState('domcontentloaded');
    const card = spacesPage!.locator(`peek-card.space-card[data-tag-id="${spaceId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15000 });
    await card.evaluate((el, url) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/uri-list', url);
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    }, SAVED_ONLY_URL);

    // Preconditions: saved into the space, and no window shows it.
    await expect
      .poll(async () => {
        const r = await bgWindow.evaluate(
          async (id: string) => await (window as any).app.session.getWorkspaceSnapshotWindowCount(id),
          spaceId as string,
        );
        return r?.count ?? null;
      }, { timeout: 20000, message: 'the address was not saved into the inactive space' })
      .toBe(1);
    expect(await liveWindowsAt(SAVED_ONLY_URL)).toEqual([]);

    const panel = await openPanel(SAVED_ONLY_URL);
    const action = panel.locator('button#url-action');
    await expect(action, 'the URL action button is missing').toBeVisible({ timeout: 5000 });
    await expect(action).toHaveAttribute('data-action', 'open', { timeout: 5000 });
    await closePanel(panel);
  });
});
