import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

/**
 * The app-wide see-through switch over the per-window one.
 *
 * `see-through views everywhere` (features/windows/background.js) reads the
 * app-wide setting through `api.window.getSeeThroughEverywhere` and flips it
 * with `api.window.setSeeThroughEverywhere`, which lands in `tile-ipc.ts
 * tile:window:set-see-through-everywhere`. That handler stores the setting
 * beside the app's other settings and then puts every open window whose
 * manifest tile entry declares `seeThrough: true` into that state, through
 * the same `applySeeThroughToWindow` the per-window switch uses — so each
 * window keeps the per-window rules. A window opened later while the switch
 * is on is decided in `ipc.ts windowOpenHandler` by
 * `see-through-support.ts seeThroughForNewWindow`. Rule:
 * docs/design/window-rules.md G15.
 *
 * Two Tags windows are told apart by a query string on the same tile URL:
 * the declaration is read from the URL's path, so `?w=a` still declares the
 * switch while giving each window a url the test can match on.
 *
 * Bounds are read from main rather than from the page, and compared against
 * a window's OWN earlier bounds: the X11 window manager in the Linux
 * harness constrains rects, so no absolute size is assertable.
 *
 *   yarn test:grep "card-view-see-through-everywhere"
 */

/** Open the Tags card view at known bounds and return its window id. */
const openTagsWindow = async (
  bgWindow: Page,
  slot: string,
  bounds: { width: number; height: number },
): Promise<number> => {
  const result = await bgWindow.evaluate(
    async (args: { slot: string; width: number; height: number }) => {
      return await (window as any).app.window.open(`peek://tags/home.html?w=${args.slot}`, {
        role: 'workspace',
        key: `tags-home-${args.slot}`,
        title: `Tags ${args.slot}`,
        transparent: true,
        width: args.width,
        height: args.height,
      });
    },
    { slot, ...bounds },
  );
  expect(result.success).toBe(true);
  return result.id as number;
};

const windowExists = async (app: DesktopApp, id: number): Promise<boolean> => {
  return (await app.evaluateMain!(((electron: any, wid: number) => {
    const { BrowserWindow, BaseWindow } = electron;
    const live = (w: any) => !w.isDestroyed() && w.id === wid;
    return BrowserWindow.getAllWindows().some(live) || BaseWindow.getAllWindows().some(live);
  }) as any, id)) as boolean;
};

/** Close a window for good, so the next test's `tags-home-*` key is free. */
const closeWindow = async (app: DesktopApp, bgWindow: Page, id: number): Promise<void> => {
  await bgWindow.evaluate((wid: number) => {
    (window as any).app.window.close(wid, { force: true });
  }, id);
  await expect.poll(() => windowExists(app, id), { timeout: 5000 }).toBe(false);
};

const boundsOf = async (
  app: DesktopApp,
  id: number,
): Promise<{ x: number; y: number; width: number; height: number }> => {
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
const isMaximized = async (app: DesktopApp, id: number): Promise<boolean> => {
  return (await app.evaluateMain!(((_electron: unknown, wid: number) => {
    const t = (globalThis as any).__peek_test;
    const machineId = t.getMachineWindowIdFor(wid);
    if (machineId == null) return false;
    const record = t.kernelStateForTest().order.find((w: any) => w.id === machineId);
    return record?.maximized === true;
  }) as any, id)) as boolean;
};

/** One window's own see-through state, as main holds it. */
const seeThroughOf = async (bgWindow: Page, id: number): Promise<boolean> => {
  const result = await bgWindow.evaluate(async (wid: number) => {
    return await (window as any).app.window.getSeeThrough(wid);
  }, id);
  return result?.data?.seeThrough === true;
};

/** The stored app-wide setting. */
const everywhereOn = async (bgWindow: Page): Promise<boolean> => {
  const result = await bgWindow.evaluate(async () => {
    return await (window as any).app.window.getSeeThroughEverywhere();
  });
  expect(result.success).toBe(true);
  return result.data?.on === true;
};

/** Run a command the way the command palette does. */
const runCommand = async (app: DesktopApp, name: string): Promise<void> => {
  await app.evaluateMain!(((_electron: unknown, command: string) => {
    (globalThis as any).__peek_test.publishCmdExecute(command);
  }) as any, name);
};

/**
 * The per-window command acts on the focused window, so make this one it —
 * and wait until the app agrees, rather than assuming the focus settled.
 */
const focusWindow = async (bgWindow: Page, id: number): Promise<void> => {
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

test.describe('card-view-see-through-everywhere @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('card-view-see-through-everywhere'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('the app-wide switch flips every declaring window, and one window can still be flipped back under it', async () => {
    const idA = await openTagsWindow(bgWindow, 'a', { width: 820, height: 620 });
    const viewA = await app.getWindow('tags/home.html?w=a', 15000);
    await viewA.waitForLoadState('domcontentloaded');
    await viewA.waitForSelector('peek-grid.cards', { timeout: 15000 });

    const idB = await openTagsWindow(bgWindow, 'b', { width: 780, height: 580 });
    const viewB = await app.getWindow('tags/home.html?w=b', 15000);
    await viewB.waitForLoadState('domcontentloaded');
    await viewB.waitForSelector('peek-grid.cards', { timeout: 15000 });

    const beforeA = await boundsOf(app, idA);
    const beforeB = await boundsOf(app, idB);
    expect(await everywhereOn(bgWindow)).toBe(false);
    expect(await bodyIsSeeThrough(viewA)).toBe(false);
    expect(await bodyIsSeeThrough(viewB)).toBe(false);

    await runCommand(app, 'see-through views everywhere');

    // Both windows are see-through and maximized, and the setting is on.
    await expect.poll(() => everywhereOn(bgWindow), { timeout: 15000 }).toBe(true);
    await expect.poll(() => seeThroughOf(bgWindow, idA), { timeout: 10000 }).toBe(true);
    await expect.poll(() => seeThroughOf(bgWindow, idB), { timeout: 10000 }).toBe(true);
    await expect.poll(() => isMaximized(app, idA), { timeout: 10000 }).toBe(true);
    await expect.poll(() => isMaximized(app, idB), { timeout: 10000 }).toBe(true);
    await expect.poll(() => bodyIsSeeThrough(viewA), { timeout: 10000 }).toBe(true);
    await expect.poll(() => bodyIsSeeThrough(viewB), { timeout: 10000 }).toBe(true);

    // The per-window switch still works under the app-wide one: A goes back
    // to its normal look and its exact earlier bounds, B is untouched.
    await focusWindow(bgWindow, idA);
    await runCommand(app, 'see-through view');

    await expect.poll(() => seeThroughOf(bgWindow, idA), { timeout: 10000 }).toBe(false);
    await expect.poll(() => bodyIsSeeThrough(viewA), { timeout: 10000 }).toBe(false);
    await expect.poll(() => isMaximized(app, idA), { timeout: 10000 }).toBe(false);
    await expect.poll(() => boundsOf(app, idA), { timeout: 10000 }).toEqual(beforeA);

    expect(await seeThroughOf(bgWindow, idB)).toBe(true);
    expect(await bodyIsSeeThrough(viewB)).toBe(true);
    expect(await isMaximized(app, idB)).toBe(true);
    // The override did not touch the app-wide setting.
    expect(await everywhereOn(bgWindow)).toBe(true);

    await runCommand(app, 'see-through views everywhere');

    // Both are back to the normal look at the bounds they started at.
    await expect.poll(() => everywhereOn(bgWindow), { timeout: 15000 }).toBe(false);
    await expect.poll(() => seeThroughOf(bgWindow, idB), { timeout: 10000 }).toBe(false);
    await expect.poll(() => bodyIsSeeThrough(viewB), { timeout: 10000 }).toBe(false);
    await expect.poll(() => isMaximized(app, idB), { timeout: 10000 }).toBe(false);
    await expect.poll(() => boundsOf(app, idB), { timeout: 10000 }).toEqual(beforeB);

    expect(await seeThroughOf(bgWindow, idA)).toBe(false);
    expect(await bodyIsSeeThrough(viewA)).toBe(false);
    expect(await isMaximized(app, idA)).toBe(false);
    expect(await boundsOf(app, idA)).toEqual(beforeA);

    await closeWindow(app, bgWindow, idA);
    await closeWindow(app, bgWindow, idB);
  });
});

test.describe('card-view-see-through-everywhere across a restart @desktop', () => {
  test('a Tags window opened after a relaunch with the switch on opens see-through', async () => {
    // One profile for both launches, fresh per run: the second launch reads
    // the first one's datastore, and no earlier run's setting leaks in.
    const PROFILE = 'test-see-through-everywhere-restart-' + Date.now();

    let app = await launchDesktopApp(PROFILE);
    let bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);

    const set = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.setSeeThroughEverywhere(true);
    });
    expect(set.success).toBe(true);
    expect(await everywhereOn(bgWindow)).toBe(true);

    await app.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    app = await launchDesktopApp(PROFILE);
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);

    // Stored with the app's other settings, so it came back.
    expect(await everywhereOn(bgWindow)).toBe(true);

    const id = await openTagsWindow(bgWindow, 'restart', { width: 760, height: 560 });
    const view = await app.getWindow('tags/home.html?w=restart', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('peek-grid.cards', { timeout: 15000 });

    // Opened see-through without anyone running a command, and maximized by
    // the same rule the per-window switch follows.
    await expect.poll(() => seeThroughOf(bgWindow, id), { timeout: 10000 }).toBe(true);
    await expect.poll(() => isMaximized(app, id), { timeout: 10000 }).toBe(true);
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(true);

    await closeWindow(app, bgWindow, id);
    await app.close();
  });
});
