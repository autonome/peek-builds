import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

/**
 * The per-window see-through switch on the Entities view.
 *
 * The switch itself is covered by `card-view-see-through.spec.ts`; this spec
 * only proves the view is on it. Support is the view's own declaration —
 * `seeThrough: true` on the `home` tile entry in
 * `features/entities/manifest.json`, read by `main/see-through-support.ts
 * urlSupportsSeeThrough`. `see-through view` flips it, main announces the
 * change on `window:see-through`, and the renderer answers by re-reading its
 * own state and putting (or taking) the `see-through` class on `<body>`,
 * which is what `renderer/lib/see-through.css` is gated on. Rule:
 * docs/design/window-rules.md G15.
 *
 * Bounds are read from main rather than from the page: the X11 window
 * manager in the Linux harness constrains rects, so the assertions compare
 * the window against ITS OWN earlier bounds instead of any absolute size.
 *
 *   yarn test:grep "see-through-entities"
 */
test.describe('see-through-entities @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('see-through-entities'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /** Open the entities view at known bounds and return its window id. */
  const openEntities = async (bounds: { width: number; height: number }): Promise<number> => {
    const result = await bgWindow.evaluate(
      async (b: { width: number; height: number }) => {
        return await (window as any).app.window.open('peek://entities/home.html', {
          role: 'workspace',
          key: 'entities-browser',
          title: 'Entities',
          transparent: true,
          ...b,
        });
      },
      bounds,
    );
    expect(result.success).toBe(true);
    return result.id as number;
  };

  /** Close a window for good, so the next test's key is free. */
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

  /** Run `see-through view` the way the command palette does. */
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

  /**
   * Tab moves the focus along the view's own controls. Driven through the
   * page rather than the OS, which is all the headless harness can observe,
   * and asked in both looks because the see-through look is the one that
   * could hide or inert a control. The type filters are the view's first
   * controls and are in the page's own DOM, so the focus they take is
   * readable without reaching into a component's shadow root.
   */
  const tabMovesFocus = async (view: Page): Promise<boolean> => {
    await view.evaluate(() => {
      (document.querySelector('.filter-btn[data-type=""]') as HTMLElement | null)?.focus();
    });
    await view.keyboard.press('Tab');
    return await view.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active != null
        && active !== document.body
        && active.dataset?.type !== '';
    });
  };

  test('the switch frosts the view and never moves, resizes or maximizes the window', async () => {
    const id = await openEntities({ width: 860, height: 640 });
    const view = await app.getWindow('entities/home.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('body[data-ready="true"]', { timeout: 15000 });

    const before = await boundsOf(id);
    expect(await bodyIsSeeThrough(view)).toBe(false);
    const opaqueBackground = await bodyBackground(view);
    // The normal look is opaque even though the window is transparent.
    expect(opaqueBackground).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)$/);
    expect(await tabMovesFocus(view)).toBe(true);

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

    // The controls are still reachable from the keyboard in this look.
    expect(await tabMovesFocus(view)).toBe(true);

    await runSeeThroughCommand();

    // Off: the class is gone and the window is still at its exact bounds.
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(false);
    await expect.poll(() => isMaximized(id), { timeout: 10000 }).toBe(false);
    await expect.poll(() => boundsOf(id), { timeout: 10000 }).toEqual(before);

    await closeWindow(id);
  });
});
