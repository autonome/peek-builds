import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

/**
 * Every card in the window switcher carries a close button that ends that
 * window for good.
 *
 * The button lives in the card header (`features/windows/windows.js`
 * `createCloseButton`) and calls `api.window.close(id, { force: true })` —
 * the option added here, carried through `tile-preload.cts`,
 * `tile-ipc.ts tile:window:close` and `windows.ts closeOrHideWindow()` into
 * the kernel's `CloseOrHideWindow` command, where it overrides the keepLive
 * branch for the named window. Pressing it is an explicit request to end the
 * window, so a `keepLive` window that an ordinary close would merely hide is
 * destroyed instead.
 *
 * Driven the same way `switcher-select-raises-target.spec.ts` drives the
 * switcher: the real view is opened by publishing `cmd:execute:windows`, and
 * cards are `peek-card[data-window-id="…"]`. Content windows are real
 * `http://` pages, which are hybrid page-host BaseWindows and therefore
 * invisible to Playwright as a `Page`, so whether a window survived is read
 * from main's own window registry rather than from a `Page` handle.
 *
 * Each test opens its windows BEFORE opening the switcher and closes the
 * switcher before it finishes: the view loads its list once at init and
 * dismisses itself on `window:opened`, so a view left over from an earlier
 * test would be showing a stale list.
 *
 *   yarn test:grep "windows-view card close"
 */
test.describe('windows-view card close @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('windows-view-card-close'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const name = (req.url || '/').replace(/[^a-zA-Z0-9]/g, '') || 'root';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${name}</title></head><body>${name}</body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  /** Open a content window and return its id. */
  const openContentWindow = async (path: string, options: Record<string, unknown> = {}): Promise<number> => {
    const result = await bgWindow.evaluate(
      async ({ u, o }: { u: string; o: Record<string, unknown> }) => {
        return await (window as any).app.window.open(u, { width: 420, height: 320, ...o });
      },
      { u: `http://127.0.0.1:${serverPort}/${path}`, o: options },
    );
    expect(result.success).toBe(true);
    return result.id as number;
  };

  /** Whether main still holds a switcher window, however Playwright sees it. */
  const switcherLivesInMain = async (): Promise<boolean> => {
    return (await app.evaluateMain!(((electron: any) => {
      return electron.webContents
        .getAllWebContents()
        .some((wc: any) => !wc.isDestroyed() && (wc.getURL() || '').includes('windows/windows.html'));
    }) as any)) as boolean;
  };

  /**
   * Open the switcher the way the global hotkey does. The publish is retried:
   * the switcher is a single window the command toggles, so one arriving while
   * a previous switcher is still being torn down in main is spent on that
   * teardown and never opens anything.
   */
  const openSwitcher = async (): Promise<Page> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await app.evaluateMain!((_e: unknown) => {
        (globalThis as any).__peek_test.publishCmdExecute('windows');
      });
      const view = await app.getWindow('windows/windows.html', 4000).catch(() => null);
      if (view) {
        await view.waitForLoadState('domcontentloaded');
        return view;
      }
    }
    throw new Error('the switcher never opened after five cmd:execute:windows publishes');
  };

  /**
   * Leave no switcher behind for the next test to find with a stale list —
   * and wait for main to agree it is gone, not just Playwright's handle.
   */
  const closeSwitcher = async (view: Page): Promise<void> => {
    if (!view.isClosed()) {
      await view.evaluate(() => window.close()).catch(() => {});
      await expect.poll(() => view.isClosed(), { timeout: 5000 }).toBe(true);
    }
    await expect.poll(() => switcherLivesInMain(), { timeout: 5000 }).toBe(false);
  };

  /**
   * Whether main still has a window with this id — the only honest read for a
   * hybrid page-host, which never surfaces as a Playwright `Page`. A hidden
   * window is still present, so this tells "destroyed" from "hidden".
   */
  const windowExists = async (id: number): Promise<boolean> => {
    return (await app.evaluateMain!(((electron: any, wid: number) => {
      const { BrowserWindow, BaseWindow } = electron;
      const live = (w: any) => !w.isDestroyed() && w.id === wid;
      if (BrowserWindow.getAllWindows().some(live)) return true;
      return BaseWindow.getAllWindows().some(live);
    }) as any, id)) as boolean;
  };

  /** Whether a window main still holds is on screen. `null` once it is gone. */
  const windowVisible = async (id: number): Promise<boolean | null> => {
    return (await app.evaluateMain!(((electron: any, wid: number) => {
      const { BrowserWindow, BaseWindow } = electron;
      const all = [...BrowserWindow.getAllWindows(), ...BaseWindow.getAllWindows()];
      const found = all.find((w: any) => !w.isDestroyed() && w.id === wid);
      return found ? found.isVisible() : null;
    }) as any, id)) as boolean | null;
  };

  const cardSel = (id: number) => `peek-card[data-window-id="${id}"]`;
  const closeSel = (id: number) => `${cardSel(id)} peek-button.card-close`;
  const anyCloseSel = 'peek-card peek-button.card-close';

  test('a card close button ends that window and leaves the rest of the switcher alone', async () => {
    const keepId = await openContentWindow('keeper');
    const doomedId = await openContentWindow('doomed');

    const view = await openSwitcher();
    await view.waitForSelector(cardSel(keepId), { timeout: 10000 });
    await view.waitForSelector(cardSel(doomedId), { timeout: 10000 });
    expect(await windowExists(doomedId)).toBe(true);

    await view.click(closeSel(doomedId));

    // The card goes away...
    await expect.poll(() => view.locator(cardSel(doomedId)).count(), { timeout: 5000 }).toBe(0);
    // ...the window is really gone from main...
    await expect.poll(() => windowExists(doomedId), { timeout: 5000 }).toBe(false);
    // ...and neither the other card nor the switcher itself is disturbed.
    expect(await view.locator(cardSel(keepId)).count()).toBe(1);
    expect(view.isClosed()).toBe(false);
    expect(await windowExists(keepId)).toBe(true);

    await closeSwitcher(view);
  });

  test('clicking a card body still picks that window and closes the switcher', async () => {
    const targetId = await openContentWindow('picked');

    const view = await openSwitcher();
    await view.waitForSelector(cardSel(targetId), { timeout: 10000 });

    // The card itself, not the close button — the ordinary pick gesture, and
    // the same click `switcher-select-raises-target.spec.ts` makes. It lands
    // at the card's centre, on the thumbnail, well clear of the header.
    await view.click(cardSel(targetId));

    await expect.poll(() => view.isClosed(), { timeout: 5000 }).toBe(true);
    // Picking a window must never close it.
    expect(await windowExists(targetId)).toBe(true);
  });

  test('a keepLive window is destroyed by the card close button, not hidden', async () => {
    // Two windows opened the same way, so the contrast is the close and
    // nothing else: one gets an ordinary close (which keepLive answers by
    // hiding — the window survives), the other gets the card's close button.
    const survivorId = await openContentWindow('musicone', { keepLive: true });
    const endedId = await openContentWindow('musictwo', { keepLive: true });

    // The control: an ordinary close only HIDES a keepLive window. Waiting for
    // it to go off screen is what proves the close landed at all — and that it
    // landed as a hide, since the window is still there afterwards.
    expect(await windowVisible(survivorId)).toBe(true);
    await bgWindow.evaluate((id: number) => {
      (window as any).app.window.close(id);
    }, survivorId);
    await expect.poll(() => windowVisible(survivorId), { timeout: 5000 }).toBe(false);
    expect(await windowExists(survivorId), 'an ordinary close must not destroy a keepLive window').toBe(true);

    const view = await openSwitcher();
    await view.waitForSelector(cardSel(endedId), { timeout: 10000 });

    await view.click(closeSel(endedId));

    // Destroyed, not hidden: a hide would leave the window present in main.
    await expect.poll(() => windowExists(endedId), { timeout: 5000 }).toBe(false);

    await closeSwitcher(view);
  });

  test('closing every listed card in turn leaves the empty state', async () => {
    await openContentWindow('alpha');
    await openContentWindow('beta');

    const view = await openSwitcher();
    await view.waitForSelector('peek-card', { timeout: 10000 });

    // The test app lists windows besides the two opened here, so close
    // whatever is listed rather than a known set. Each close re-renders the
    // grid, so the remaining set is re-read every time.
    for (let guard = 0; guard < 40; guard++) {
      const remaining = await view.locator(anyCloseSel).count();
      if (remaining === 0) break;
      await view.locator(anyCloseSel).first().click();
      await expect.poll(() => view.locator(anyCloseSel).count(), { timeout: 5000 }).toBe(remaining - 1);
    }

    expect(await view.locator('peek-card').count()).toBe(0);
    await expect(view.locator('.empty-state')).toHaveText('No windows open.');
    expect(view.isClosed()).toBe(false);

    await closeSwitcher(view);
  });
});
