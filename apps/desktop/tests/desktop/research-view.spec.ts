/**
 * The research view end to end: `research view` opens one maximized,
 * see-through window listing the pages of the research the front window is in,
 * longest time on page first.
 *
 * A research is a space (`space:<name>`), so the subject is staged explicitly:
 * three page items tagged into the space, their visit durations written
 * directly through `recordItemVisit` so the order is known rather than timed,
 * and one of the three left open in a window — which is also the window the
 * command is run from, since that is what carries the space.
 *
 * A local `http` server stands in for every page, so no test touches the
 * network. The profile is per-describe and therefore fresh.
 *
 * The ranking itself is decided in `tests/unit/research-view-rank.test.js`;
 * what this spec proves is that the view feeds it the right research and draws
 * what it answers.
 *
 * Bounds are never compared against an absolute size: the X11 window manager
 * in the Linux harness constrains rects, so "maximized" is read from the
 * window machine's own flag.
 *
 *   yarn test:grep "research-view"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

test.describe('research-view @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  const SPACE_NAME = 'otters';
  const SPACE_TAG = `space:${SPACE_NAME}`;
  const VIEW_URL_FRAGMENT = 'research/home.html';

  const pageUrl = (path: string) => `http://127.0.0.1:${serverPort}${path}`;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('research-view'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const title = `page ${req.url}`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${title}</title></head>` +
          `<body><h1>${title}</h1></body></html>`,
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  // Every window a test opened goes away, so the next test's front window is
  // one it opened itself and the per-research view key is free again.
  test.afterEach(async () => {
    for (const id of await openWindowIds()) await closeWindow(id);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  // ===== Driving the app through the privileged test window =====

  const openWindowIds = (): Promise<number[]> =>
    bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      return r?.success ? (r.windows as any[]).map((w) => w.id) : [];
    });

  const windowUrls = (): Promise<string[]> =>
    bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      return r?.success ? (r.windows as any[]).map((w) => String(w.url || '')) : [];
    });

  const closeWindow = async (windowId: number) => {
    try {
      await bgWindow.evaluate(
        async (id: number) => await (window as any).app.window.close(id, { force: true }),
        windowId,
      );
    } catch {
      // Already gone.
    }
  };

  const openWindow = (url: string, options: Record<string, unknown>) =>
    bgWindow.evaluate(
      async (arg: { url: string; options: Record<string, unknown> }) =>
        await (window as any).app.window.open(arg.url, arg.options),
      { url, options },
    ) as Promise<{ success: boolean; id: number }>;

  const frontWindowId = () =>
    bgWindow.evaluate(
      async () => await (window as any).app.window.getFocusedVisibleWindowId(),
    ) as Promise<number | null>;

  /**
   * Make `id` the front window and wait until the app agrees — the command
   * reads the front window, so assuming the focus settled is what makes this
   * kind of test flake.
   */
  const focusWindow = async (id: number): Promise<void> => {
    await bgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.focus(wid);
    }, id);
    await expect.poll(frontWindowId, { timeout: 10000 }).toBe(id);
  };

  const modeOf = (windowId: number) =>
    bgWindow.evaluate(
      async (id: number) => await (window as any).app.context.get('mode', id),
      windowId,
    ) as Promise<{ success?: boolean; data?: { value?: string; metadata?: Record<string, unknown> } }>;

  /** Run a palette command and wait for its result, the way the palette does. */
  const runCommand = (name: string) =>
    bgWindow.evaluate(async (commandName: string) => {
      const api = (window as any).app;
      return await new Promise((resolve) => {
        const resultTopic = `cmd:execute:${commandName}:result:${Date.now()}:${Math.random()}`;
        api.subscribe(resultTopic, (r: unknown) => resolve(r));
        api.publish(`cmd:execute:${commandName}`, {
          name: commandName,
          search: '',
          params: [],
          expectResult: true,
          resultTopic,
        });
        setTimeout(() => resolve({ error: `timeout waiting for ${commandName}` }), 20000);
      });
    }, name) as Promise<Record<string, unknown>>;

  // ===== Staging the research =====

  const spaceTagId = async (): Promise<string> => {
    const id = await bgWindow.evaluate(async (name: string) => {
      const r = await (window as any).app.datastore.getOrCreateTag(name);
      return (r?.data?.tag?.id ?? null) as string | null;
    }, SPACE_TAG);
    expect(id, `could not resolve the tag ${SPACE_TAG}`).toBeTruthy();
    return id as string;
  };

  /** A page item for `path`, not yet in any research. */
  const createPageItem = async (path: string, title: string): Promise<string> => {
    const id = await bgWindow.evaluate(
      async (arg: { url: string; title: string }) => {
        const r = await (window as any).app.datastore.addItem('url', {
          content: arg.url,
          metadata: JSON.stringify({ title: arg.title }),
        });
        return (r?.data?.id ?? null) as string | null;
      },
      { url: pageUrl(path), title },
    );
    expect(id, `could not create the page item for ${path}`).toBeTruthy();
    return id as string;
  };

  /** Put a page in the research. This is what the live query answers to. */
  const addToResearch = async (itemId: string, tagId: string): Promise<void> => {
    const ok = await bgWindow.evaluate(
      async (arg: { itemId: string; tagId: string }) => {
        const r = await (window as any).app.datastore.tagItem(arg.itemId, arg.tagId);
        return r?.success === true;
      },
      { itemId, tagId },
    );
    expect(ok, `could not tag ${itemId} into ${SPACE_TAG}`).toBe(true);
  };

  /**
   * One finished visit of `ms` on a page. Written directly rather than timed:
   * the order under test is a fact about the data, and waiting on real dwell
   * would make it a fact about the machine's speed.
   */
  const recordTimeOnPage = async (itemId: string, ms: number): Promise<void> => {
    const ok = await bgWindow.evaluate(
      async (arg: { itemId: string; ms: number }) => {
        const r = await (window as any).app.datastore.recordItemVisit(arg.itemId, {
          duration: arg.ms,
          source: 'direct',
        });
        return r?.success === true;
      },
      { itemId, ms },
    );
    expect(ok, `could not record a visit on ${itemId}`).toBe(true);
  };

  // ===== Reading the window machine =====

  /**
   * The machine's own maximize flag — the fact the see-through switch acts
   * on. Read it rather than comparing geometry: a window manager may refit a
   * maximized window, so geometry does not answer "is this maximized".
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

  // ===== Reading the view =====

  const rowItemIds = (view: Page): Promise<string[]> =>
    view.evaluate(() =>
      Array.from(document.querySelectorAll('.cards peek-card')).map(
        (card) => (card as HTMLElement).dataset.itemId || '',
      ),
    );

  const rowTimeOnPage = (view: Page, itemId: string): Promise<string | null> =>
    view.evaluate((id: string) => {
      const card = document.querySelector(`.cards peek-card[data-item-id="${id}"]`);
      const time = card?.querySelector('.card-time-on-page');
      return time ? (time.textContent || '').trim() : null;
    }, itemId);

  const rowsMarkedOpen = (view: Page): Promise<string[]> =>
    view.evaluate(() =>
      Array.from(document.querySelectorAll('.cards peek-card'))
        .filter((card) => card.querySelector('.card-open-marker') !== null)
        .map((card) => (card as HTMLElement).dataset.itemId || ''),
    );

  /**
   * The selected row, read from the card's own property rather than an
   * attribute selector — `grid-nav.js updateSelection` sets the property.
   */
  const selectedItemId = (view: Page): Promise<string | null> =>
    view.evaluate(() => {
      const found = Array.from(document.querySelectorAll('.cards peek-card')).find(
        (card) => (card as any).selected === true,
      );
      return found ? (found as HTMLElement).dataset.itemId || null : null;
    });

  test('the research view lists the research in time order, live, and moves with hjkl', async () => {
    const tagId = await spaceTagId();

    // Three pages, told apart only by the time they held attention.
    const longest = await createPageItem('/longest', 'Longest');
    const middle = await createPageItem('/middle', 'Middle');
    const shortest = await createPageItem('/shortest', 'Shortest');

    for (const itemId of [longest, middle, shortest]) await addToResearch(itemId, tagId);

    // Summed over two visits for the longest page, so the ranking is reading
    // the total rather than the largest single visit.
    await recordTimeOnPage(longest, 400000);
    await recordTimeOnPage(longest, 200000);
    await recordTimeOnPage(middle, 120000);
    await recordTimeOnPage(shortest, 1000);

    // The middle page is the one left open, and its window is the one in the
    // research — the same window the command is run from.
    const opened = await openWindow(pageUrl('/middle'), {
      role: 'content',
      width: 800,
      height: 600,
      spaceMode: { spaceId: tagId, spaceName: SPACE_NAME, color: '#3366ff' },
    });
    expect(opened.success).toBe(true);

    await expect
      .poll(async () => (await modeOf(opened.id))?.data?.metadata?.spaceId, { timeout: 15000 })
      .toBe(tagId);
    await focusWindow(opened.id);

    const result = await runCommand('research view');
    expect(result.success, `research view failed: ${JSON.stringify(result)}`).toBe(true);
    expect(result.space).toBe(SPACE_NAME);
    const viewId = result.windowId as number;
    expect(typeof viewId).toBe('number');

    // Maximized and see-through, both.
    await expect.poll(() => isMaximized(viewId), { timeout: 15000 }).toBe(true);

    const view = await app.getWindow(VIEW_URL_FRAGMENT, 15000);
    await view.waitForLoadState('domcontentloaded');
    await view.waitForSelector('.cards peek-card', { timeout: 15000 });

    await expect
      .poll(() => view.evaluate(() => document.body.classList.contains('see-through')), {
        timeout: 15000,
      })
      .toBe(true);
    const frosted = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(frosted).toMatch(/^rgba\(/);
    const alpha = Number(frosted.replace(/^rgba\(|\)$/g, '').split(',')[3]);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);

    // The research, longest time on page first.
    await expect.poll(() => rowItemIds(view), { timeout: 15000 }).toEqual([longest, middle, shortest]);

    // Time on page as a row reads it, and the marker on the page that is open
    // in a window right now.
    expect(await rowTimeOnPage(view, longest)).toBe('10m');
    expect(await rowTimeOnPage(view, shortest)).toBe('1s');
    expect(await rowsMarkedOpen(view)).toEqual([middle]);

    // A fourth page tagged into the research appears without reopening the
    // view, in its place in the order rather than at the end.
    const fourth = await createPageItem('/fourth', 'Fourth');
    await recordTimeOnPage(fourth, 300000);
    await addToResearch(fourth, tagId);

    await expect
      .poll(() => rowItemIds(view), { timeout: 15000 })
      .toEqual([longest, fourth, middle, shortest]);

    // hjkl moves the selection one row at a time: the rows stack one per line,
    // so `grid-nav.js` counts one column and j/k step by one.
    expect(await selectedItemId(view)).toBe(longest);
    await view.keyboard.press('j');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(fourth);
    await view.keyboard.press('l');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(middle);
    await view.keyboard.press('k');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(fourth);
    await view.keyboard.press('h');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(longest);
  });

  test('the command from a window in no research opens nothing', async () => {
    // A workspace-role view belongs to no research — a window role that is not
    // content inherits no space (`ipc.ts inheritedModeForNewWindow`), so this
    // is the "no research" case without depending on which spaces have been
    // created.
    const opened = await openWindow('peek://tags/home.html', {
      role: 'workspace',
      key: 'tags-home',
      title: 'Tags',
      transparent: true,
      width: 700,
      height: 520,
    });
    expect(opened.success).toBe(true);
    await focusWindow(opened.id);

    const mode = await modeOf(opened.id);
    expect(mode?.data?.value, 'the staged window must be in no research').not.toBe('space');

    const result = await runCommand('research view');
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('research');

    // Nothing opened, and nothing was left half-open either.
    const urls = await windowUrls();
    expect(urls.filter((url) => url.includes(VIEW_URL_FRAGMENT))).toEqual([]);
  });
});
