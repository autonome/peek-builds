import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

/**
 * The per-window see-through switch on a card-grid view (Tags).
 *
 * `see-through view` (features/windows/background.js) reads the focused
 * window's state through `api.window.getSeeThrough` and flips it with
 * `api.window.setSeeThrough`, which lands in `tile-ipc.ts
 * tile:window:set-see-through`. Main records the look in the window's
 * params without touching its bounds or maximize state, and announces the
 * change on `window:see-through`; the Tags
 * renderer answers by re-reading its own state and putting (or taking) the
 * `see-through` class on `<body>`, which is what `renderer/lib/see-through.css`
 * is gated on. Rule: docs/design/window-rules.md G15.
 *
 * Bounds are read from main rather than from the page: the X11 window
 * manager in the Linux harness constrains rects, so the assertions compare
 * the window against ITS OWN earlier bounds instead of any absolute size.
 *
 *   yarn test:grep "card-view-see-through"
 */
test.describe('card-view-see-through @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('card-view-see-through'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>page</title></head><body>page</body></html>');
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

  /** Open the Tags card view at known bounds and return its window id. */
  const openTags = async (bounds: { width: number; height: number }): Promise<number> => {
    const result = await bgWindow.evaluate(
      async (b: { width: number; height: number }) => {
        return await (window as any).app.window.open('peek://tags/home.html', {
          role: 'workspace',
          key: 'tags-home',
          title: 'Tags',
          transparent: true,
          ...b,
        });
      },
      bounds,
    );
    expect(result.success).toBe(true);
    return result.id as number;
  };

  /** Close a window for good, so the next test's `tags-home` key is free. */
  const closeWindow = async (id: number): Promise<void> => {
    await bgWindow.evaluate((wid: number) => {
      (window as any).app.window.close(wid, { force: true });
    }, id);
    await expect.poll(() => windowExists(id), { timeout: 5000 }).toBe(false);
  };

  const windowExists = async (id: number): Promise<boolean> => {
    return (await app.evaluateMain!(((electron: any, wid: number) => {
      const { BrowserWindow, BaseWindow } = electron;
      const live = (w: any) => !w.isDestroyed() && w.id === wid;
      return BrowserWindow.getAllWindows().some(live) || BaseWindow.getAllWindows().some(live);
    }) as any, id)) as boolean;
  };

  const boundsOf = async (id: number): Promise<{ x: number; y: number; width: number; height: number }> => {
    return (await app.evaluateMain!(((electron: any, wid: number) => {
      const { BrowserWindow, BaseWindow } = electron;
      const all = [...BrowserWindow.getAllWindows(), ...BaseWindow.getAllWindows()];
      const found = all.find((w: any) => !w.isDestroyed() && w.id === wid);
      return found ? found.getBounds() : null;
    }) as any, id)) as { x: number; y: number; width: number; height: number };
  };

  /**
   * The machine's own maximize flag — the fact the switch acts on. Read it
   * rather than comparing geometry: a window manager may refit a maximized
   * window, so geometry does not answer "is this maximized".
   */
  const isMaximized = async (id: number): Promise<boolean> => {
    return (await app.evaluateMain!(((_electron: unknown, wid: number) => {
      const t = (globalThis as any).__peek_test;
      const machineId = t.getMachineWindowIdFor(wid);
      if (machineId == null) return false;
      const record = t.kernelStateForTest().order.find((w: any) => w.id === machineId);
      return record?.maximized === true;
    }) as any, id)) as boolean;
  };

  /** Run `see-through view` the way the command palette does, and wait. */
  const runSeeThroughCommand = async (): Promise<void> => {
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('see-through view');
    });
  };

  /**
   * The command acts on the focused window, so make this one it — and wait
   * until the app agrees, rather than assuming the focus settled.
   */
  const focusWindow = async (id: number): Promise<void> => {
    await bgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.focus(wid);
    }, id);
    await expect.poll(async () => {
      const result = await bgWindow.evaluate(async () => {
        return await (window as any).app.window.getFocusedVisibleWindowId();
      });
      return (result && typeof result === 'object' ? (result as any).data : result) as number | null;
    }, { timeout: 5000 }).toBe(id);
  };

  const bodyIsSeeThrough = async (view: Page): Promise<boolean> => {
    return await view.evaluate(() => document.body.classList.contains('see-through'));
  };

  const bodyBackground = async (view: Page): Promise<string> => {
    return await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  };

  test('the switch frosts the view and never moves, resizes or maximizes the window', async () => {
    const id = await openTags({ width: 820, height: 620 });
    const view = await app.getWindow('tags/home.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('peek-grid.cards', { timeout: 15000 });

    const before = await boundsOf(id);
    expect(await bodyIsSeeThrough(view)).toBe(false);
    const opaqueBackground = await bodyBackground(view);
    // The normal look is opaque even though the window is transparent.
    expect(opaqueBackground).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)$/);

    await focusWindow(id);
    await runSeeThroughCommand();

    // On: the body carries the class with a non-opaque background, and
    // the window is exactly where it was, not maximized.
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(true);
    expect(await isMaximized(id)).toBe(false);
    expect(await boundsOf(id)).toEqual(before);
    const frosted = await bodyBackground(view);
    expect(frosted).toMatch(/^rgba\(/);
    const alpha = Number(frosted.replace(/^rgba\(|\)$/g, '').split(',')[3]);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);

    // hjkl still moves the card selection in the see-through look.
    await view.locator('peek-card').first().waitFor({ timeout: 10000 });
    const cardCount = await view.locator('peek-card').count();
    test.skip(cardCount < 2, 'needs at least two cards to move the selection');
    await view.click('peek-grid.cards');
    await view.keyboard.press('j');
    await expect
      .poll(() => view.locator('peek-card[selected], peek-card.selected').count(), { timeout: 5000 })
      .toBeGreaterThan(0);

    await runSeeThroughCommand();

    // Off: the class is gone and the window is still at its exact bounds.
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(false);
    expect(await isMaximized(id)).toBe(false);
    expect(await boundsOf(id)).toEqual(before);

    await closeWindow(id);
  });

  test('a window maximized by hand stays maximized, at the same rect, through the switch on and off', async () => {
    const id = await openTags({ width: 780, height: 580 });
    const view = await app.getWindow('tags/home.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('peek-grid.cards', { timeout: 15000 });

    // Maximized before the switch is ever touched — by hand, as far as the
    // switch is concerned.
    await bgWindow.evaluate((wid: number) => {
      (window as any).app.window.maximize(wid);
    }, id);
    await expect.poll(() => isMaximized(id), { timeout: 10000 }).toBe(true);
    const maximizedBounds = await boundsOf(id);

    await focusWindow(id);
    await runSeeThroughCommand();
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(true);
    expect(await isMaximized(id)).toBe(true);
    expect(await boundsOf(id)).toEqual(maximizedBounds);

    await runSeeThroughCommand();
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(false);

    // The switch never touches maximize state: still maximized, and still
    // at the rect it was maximized to.
    expect(await isMaximized(id)).toBe(true);
    expect(await boundsOf(id)).toEqual(maximizedBounds);

    await closeWindow(id);
  });

  test('the command on a page reports failure and changes nothing', async () => {
    const id = (await bgWindow.evaluate(async (port: number) => {
      return await (window as any).app.window.open(`http://127.0.0.1:${port}/`, {
        width: 460,
        height: 340,
      });
    }, serverPort)).id as number;

    const before = await boundsOf(id);
    const wasMaximized = await isMaximized(id);

    await focusWindow(id);
    const result = await bgWindow.evaluate(async (wid: number) => {
      return await (window as any).app.window.setSeeThrough(wid, true);
    }, id);

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('does not support');
    expect(await boundsOf(id)).toEqual(before);
    expect(await isMaximized(id)).toBe(wasMaximized);

    await closeWindow(id);
  });
});
