import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

/**
 * The per-window see-through switch on the Search view.
 *
 * The switch itself is covered by `card-view-see-through.spec.ts`; this spec
 * only proves the view is on it. Support is the view's own declaration —
 * `seeThrough: true` on the `home` tile entry in
 * `features/search/manifest.json`, read by `main/see-through-support.ts
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
 * The view draws nothing without results, and it has no control of its own
 * in the page's light DOM, so the profile is seeded with two items under one
 * tag and the view is opened on that tag. The result cards are the view's
 * keyboard surface, and they are in the page's own DOM, so the selection
 * they carry is readable without reaching into a component's shadow root.
 *
 *   yarn test:grep "see-through-search"
 */
test.describe('see-through-search @desktop', () => {
  const TAG = 'seethroughsearch';
  const ITEM_COUNT = 2;

  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('see-through-search'));
    await waitForExtensionsReady(bgWindow, 15000);

    // The view renders cards, and cards need items. Seeded through the bg
    // window, which is a core renderer, so the datastore calls need no
    // per-feature grant.
    await bgWindow.evaluate(
      async ({ tag, count }: { tag: string; count: number }) => {
        const api = (window as any).app;
        const created = await api.datastore.getOrCreateTag(tag);
        const tagId = created.data.tag.id;
        for (let i = 0; i < count; i++) {
          const item = await api.datastore.addItem('url', {
            content: `https://see-through-search-${i}.example.com/`,
            metadata: JSON.stringify({ title: `See-through item ${i}` }),
          });
          await api.datastore.tagItem(item.data.id, tagId);
        }
      },
      { tag: TAG, count: ITEM_COUNT },
    );
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /** Open the search view on the seeded tag at known bounds; return its id. */
  const openSearch = async (bounds: { width: number; height: number }): Promise<number> => {
    const result = await bgWindow.evaluate(
      async (b: { width: number; height: number; tag: string }) => {
        return await (window as any).app.window.open(
          `peek://search/home.html?q=${encodeURIComponent('#' + b.tag)}`,
          {
            role: 'workspace',
            title: 'Search',
            transparent: true,
            width: b.width,
            height: b.height,
          },
        );
      },
      { ...bounds, tag: TAG },
    );
    expect(result.success).toBe(true);
    return result.id as number;
  };

  /** Close a window for good. */
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

  /** The item ids of the result cards, in the order they are drawn. */
  const cardIds = async (view: Page): Promise<string[]> => {
    return await view.evaluate(() =>
      [...document.querySelectorAll('peek-grid.cards peek-card')]
        .map(card => (card as HTMLElement).dataset.itemId || ''),
    );
  };

  /** The item id of the one selected card, if any. */
  const selectedCardId = async (view: Page): Promise<string | null> => {
    return await view.evaluate(() => {
      const card = document.querySelector('peek-grid.cards peek-card[selected]') as HTMLElement | null;
      return card ? (card.dataset.itemId || null) : null;
    });
  };

  /**
   * Walk the selection down and back up with the view's own keys, driven
   * through the page rather than the OS, which is all the headless harness
   * can observe. Asked in both looks because the see-through look is the one
   * that could hide or inert a card. Leaves the selection where it started,
   * so the walk can be repeated and compared.
   */
  const keyboardWalk = async (view: Page, ids: string[]): Promise<{ afterDown: string | null; afterUp: string | null }> => {
    await view.keyboard.press('j');
    await expect.poll(() => selectedCardId(view), { timeout: 5000 }).toBe(ids[1]);
    const afterDown = await selectedCardId(view);

    await view.keyboard.press('k');
    await expect.poll(() => selectedCardId(view), { timeout: 5000 }).toBe(ids[0]);
    const afterUp = await selectedCardId(view);

    return { afterDown, afterUp };
  };

  test('the switch maximizes, frosts, and puts the window back exactly where it was', async () => {
    const id = await openSearch({ width: 860, height: 640 });
    const view = await app.getWindow('search/home.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('body[data-ready="true"]', { timeout: 15000 });

    const ids = await cardIds(view);
    expect(ids).toHaveLength(ITEM_COUNT);
    expect(await selectedCardId(view)).toBe(ids[0]);

    const before = await boundsOf(id);
    expect(await bodyIsSeeThrough(view)).toBe(false);
    const opaqueBackground = await bodyBackground(view);
    // The normal look is opaque even though the window is transparent.
    expect(opaqueBackground).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)$/);
    const normalWalk = await keyboardWalk(view, ids);
    expect(normalWalk.afterDown).toBe(ids[1]);
    expect(normalWalk.afterUp).toBe(ids[0]);

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

    // The cards are still reachable from the keyboard in this look.
    const frostedWalk = await keyboardWalk(view, ids);
    expect(frostedWalk).toEqual(normalWalk);

    await runSeeThroughCommand();

    // Off: the class is gone and the window is back at its exact bounds.
    await expect.poll(() => bodyIsSeeThrough(view), { timeout: 10000 }).toBe(false);
    await expect.poll(() => isMaximized(id), { timeout: 10000 }).toBe(false);
    await expect.poll(() => boundsOf(id), { timeout: 10000 }).toEqual(before);

    await closeWindow(id);
  });
});
