/**
 * Maximize-all mode, end to end (specs/maximize-all.md, Peek 35c2d773).
 *
 * `maximize all windows` maximizes every eligible window where the user is;
 * running it again puts back exactly the ones it maximized — and nothing else.
 * The three windows here cover the three outcomes leaving the mode can have:
 *
 *   - untouched: the mode maximized it, so it returns to its exact bounds.
 *   - taken back by the user: unmaximized by hand while the mode is on, then
 *     maximized again by hand. The mode no longer owns it, so leaving leaves it
 *     maximized. (The user's other route out of maximize is a resize gesture,
 *     which needs a real pointer drag on a hybrid host; the `unmaximize window`
 *     command is the same transition through public API.)
 *   - already maximized before the mode: never the mode's, so it stays
 *     maximized.
 *
 * The command is driven the way the palette drives it — a `cmd:execute:` publish
 * that wakes the lazy windows tile — so the manifest entry is exercised too.
 *
 *   yarn test:grep "Maximize-all mode"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { sleep } from '../helpers/window-utils';

type Rect = { x: number; y: number; width: number; height: number };

test.describe('Maximize-all mode @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('maximize-all'));
    await sleep(500);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // Bounds of any window, BrowserWindow or hybrid BaseWindow.
  const boundsOf = (id: number) =>
    app.evaluateMain!<Rect | null, number>(({ BrowserWindow, BaseWindow }, wid) => {
      const win = BrowserWindow.fromId(wid)
        ?? BaseWindow.getAllWindows().find((w) => w.id === wid)
        ?? null;
      return win && !win.isDestroyed() ? win.getBounds() : null;
    }, id);

  // "Maximized" means filling the display's work area: maximize is driven as a
  // bounds write, so a window manager is never told the window is in its own
  // maximized state, and X11 window managers shave a pixel or two for borders.
  const fillsWorkArea = (id: number) =>
    app.evaluateMain!<boolean, number>(({ BrowserWindow, BaseWindow, screen }, wid) => {
      const win = BrowserWindow.fromId(wid)
        ?? BaseWindow.getAllWindows().find((w) => w.id === wid)
        ?? null;
      if (!win || win.isDestroyed()) return false;
      const b = win.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      const slack = 4;
      return Math.abs(b.x - wa.x) <= slack
        && Math.abs(b.y - wa.y) <= slack
        && Math.abs(b.width - wa.width) <= slack
        && Math.abs(b.height - wa.height) <= slack;
    }, id);

  const runCommand = (name: string) =>
    bgWindow.evaluate(async (commandName: string) => {
      const api = (window as any).app;
      return new Promise((resolve) => {
        const resultTopic = `cmd:execute:${commandName}:result:${Date.now()}:${Math.random()}`;
        api.subscribe(resultTopic, (result: any) => resolve(result));
        api.publish(`cmd:execute:${commandName}`, { search: '', params: [], expectResult: true, resultTopic });
        setTimeout(() => resolve({ error: 'timeout' }), 10000);
      });
    }, name);

  test('entering maximizes every window here, and leaving puts back only the ones it maximized', async () => {
    const ids = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const open = async (key: string, bounds: { width: number; height: number; x: number; y: number }) => {
        const r = await api.window.open('about:blank', { role: 'workspace', key, ...bounds });
        if (!r.success) throw new Error(`open ${key} failed: ${r.error}`);
        return r.id as number;
      };
      const untouched = await open('max-all-untouched', { x: 80, y: 90, width: 640, height: 460 });
      const takenBack = await open('max-all-taken-back', { x: 200, y: 140, width: 580, height: 420 });
      const alreadyMax = await open('max-all-already', { x: 320, y: 180, width: 520, height: 380 });
      await new Promise((res) => setTimeout(res, 300));
      // The third window is maximized before the mode is ever entered.
      await api.window.maximize(alreadyMax);
      await new Promise((res) => setTimeout(res, 200));
      return { untouched, takenBack, alreadyMax };
    });

    const beforeUntouched = await boundsOf(ids.untouched);
    const beforeTakenBack = await boundsOf(ids.takenBack);
    expect(beforeUntouched).not.toBeNull();
    expect(beforeTakenBack).not.toBeNull();
    // Meaningful signal: neither is already at the work area.
    expect(await fillsWorkArea(ids.untouched)).toBe(false);
    expect(await fillsWorkArea(ids.takenBack)).toBe(false);
    expect(await fillsWorkArea(ids.alreadyMax)).toBe(true);

    const entered = await runCommand('maximize all windows') as { success?: boolean; entered?: boolean; error?: string };
    expect(entered.error).toBeUndefined();
    expect(entered.success).toBe(true);
    expect(entered.entered).toBe(true);

    await expect.poll(() => fillsWorkArea(ids.untouched)).toBe(true);
    await expect.poll(() => fillsWorkArea(ids.takenBack)).toBe(true);
    expect(await fillsWorkArea(ids.alreadyMax)).toBe(true);

    // The user takes one window back: out of maximize by hand, then maximized
    // again by hand. Re-maximizing does not hand it back to the mode.
    await bgWindow.evaluate(async (id: number) => {
      const api = (window as any).app;
      await api.window.unmaximize(id);
      await new Promise((res) => setTimeout(res, 200));
      await api.window.maximize(id);
      await new Promise((res) => setTimeout(res, 200));
    }, ids.takenBack);
    await expect.poll(() => fillsWorkArea(ids.takenBack)).toBe(true);

    const left = await runCommand('maximize all windows') as { success?: boolean; entered?: boolean; error?: string };
    expect(left.error).toBeUndefined();
    expect(left.success).toBe(true);
    expect(left.entered).toBe(false);

    await expect.poll(() => boundsOf(ids.untouched)).toEqual(beforeUntouched);
    expect(await fillsWorkArea(ids.takenBack)).toBe(true);
    expect(await fillsWorkArea(ids.alreadyMax)).toBe(true);

    await bgWindow.evaluate(async (list: number[]) => {
      const api = (window as any).app;
      for (const id of list) await api.window.close(id);
    }, [ids.untouched, ids.takenBack, ids.alreadyMax]);
  });
});
