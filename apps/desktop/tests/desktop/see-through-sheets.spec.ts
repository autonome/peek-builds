import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

/**
 * The per-window see-through switch on the Sheets view.
 *
 * The switch itself is covered by `card-view-see-through.spec.ts`; this spec
 * only proves the view is on it. Support is the view's own declaration —
 * `seeThrough: true` on the `sheet` tile entry in
 * `features/sheets/manifest.json`, read by `main/see-through-support.ts
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
 * The view is opened the way the feature opens it — `background.js
 * openSheet()` passes a `key` and no role, so this does too — with a
 * `sheetId` that has no stored config. A sheet whose config is missing draws
 * its own default: the header with the Edit button, and the empty state. That
 * is the whole of the view's own light DOM, which is what makes both the look
 * and the keyboard reachable without seeding settings for another feature.
 *
 *   yarn test:grep "see-through-sheets"
 */
test.describe('see-through-sheets @desktop', () => {
  const SHEET_ID = 'seethroughsheets';
  const SHEET_URL = `peek://sheets/sheet.html?sheetId=${SHEET_ID}`;

  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('see-through-sheets'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /** Open the sheet view at known bounds and return its window id. */
  const openSheet = async (bounds: { width: number; height: number }): Promise<number> => {
    const result = await bgWindow.evaluate(
      async (b: { width: number; height: number; url: string }) => {
        return await (window as any).app.window.open(b.url, {
          key: b.url,
          title: 'Sheet',
          transparent: true,
          width: b.width,
          height: b.height,
        });
      },
      { ...bounds, url: SHEET_URL },
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

  /** The Edit button's label and whether the view is in edit mode. */
  const editState = async (view: Page): Promise<string> => {
    return await view.evaluate(() => {
      const btn = document.querySelector('.btn-edit') as HTMLElement | null;
      const label = (btn?.textContent || '').trim();
      return `${label}|${document.body.classList.contains('editing')}`;
    });
  };

  /**
   * Operate the view's own control from the keyboard, driven through the page
   * rather than the OS, which is all the headless harness can observe. Asked
   * in both looks because the see-through look is the one that could hide or
   * inert a control. The Edit button is the view's only control in the page's
   * own light DOM, so the focus it takes and the state it toggles are readable
   * without reaching into a component's shadow root. Enter on it twice turns
   * edit mode on and off again, so the walk leaves the view as it found it and
   * can be repeated and compared.
   */
  const keyboardWalk = async (view: Page): Promise<{ tookFocus: boolean; on: string; off: string }> => {
    const tookFocus = await view.evaluate(() => {
      const btn = document.querySelector('.btn-edit') as HTMLElement | null;
      btn?.focus();
      return document.activeElement === btn;
    });

    await view.keyboard.press('Enter');
    await expect.poll(() => editState(view), { timeout: 5000 }).toBe('Done|true');
    const on = await editState(view);

    await view.keyboard.press('Enter');
    await expect.poll(() => editState(view), { timeout: 5000 }).toBe('Edit|false');
    const off = await editState(view);

    return { tookFocus, on, off };
  };

  test('the switch maximizes, frosts, and puts the window back exactly where it was', async () => {
    const id = await openSheet({ width: 860, height: 640 });
    const view = await app.getWindow('sheets/sheet.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('body[data-ready="true"]', { timeout: 15000 });

    // The view draws its own default for a sheet with no stored config.
    expect(await editState(view)).toBe('Edit|false');

    const before = await boundsOf(id);
    expect(await bodyIsSeeThrough(view)).toBe(false);
    const opaqueBackground = await bodyBackground(view);
    // The normal look is opaque even though the window is transparent.
    expect(opaqueBackground).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)$/);
    const normalWalk = await keyboardWalk(view);
    expect(normalWalk.tookFocus).toBe(true);

    await focusWindow(id);
    await runSeeThroughCommand();

    // On: maximized, and the body carries the class with a non-opaque
    // background.
    await expect.poll(() => isMaximized(id), { timeout: 10000 }).toBe(true);
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(true);
    const frosted = await bodyBackground(view);
    expect(frosted).toMatch(/^rgba\(/);
    const alpha = Number(frosted.replace(/^rgba\(|\)$/g, '').split(',')[3]);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);

    // The control is still reachable and still works from the keyboard in
    // this look.
    const frostedWalk = await keyboardWalk(view);
    expect(frostedWalk).toEqual(normalWalk);
    expect(frostedWalk.tookFocus).toBe(true);

    await runSeeThroughCommand();

    // Off: the class is gone and the window is back at its exact bounds.
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(false);
    await expect.poll(() => isMaximized(id), { timeout: 10000 }).toBe(false);
    await expect.poll(() => boundsOf(id), { timeout: 10000 }).toEqual(before);

    await closeWindow(id);
  });
});
