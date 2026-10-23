/**
 * What a research view row does when it is activated.
 *
 * The research is staged as data and as windows: a page already open in a
 * window, a page in no window, a `search-round` item with its run events
 * written directly, and a note. Each test then activates one row with Enter —
 * the same gesture a click lands on, because `renderer/lib/grid-nav.js
 * activateSelected()` turns Enter into a `.click()` on the selected card — and
 * reads what the app did, not what the view drew.
 *
 * What it proves, row by row: an open page's window comes to the front; a page
 * in no window opens in the research; a search runs again in the research; a
 * note opens for editing where it is read and Enter saves it; and Escape closes
 * that editor before a second Escape closes the view.
 *
 * The decisions behind each of those are decided in
 * `tests/unit/research-view-actions.test.js`; what is here is the wiring.
 *
 *   yarn test:grep "research-view-actions"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

test.describe('research-view-actions @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  const SPACE_NAME = 'otters';
  const SPACE_TAG = `space:${SPACE_NAME}`;
  const SEARCH_ROUND_TAG = 'search-round';
  const VIEW_URL_FRAGMENT = 'research/home.html';

  const pageUrl = (path: string) => `http://127.0.0.1:${serverPort}${path}`;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('research-view-actions'));
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

  /** Make `id` the front window and wait until the app agrees. */
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

  const windowIdForUrl = (url: string) =>
    bgWindow.evaluate(async (u: string) => {
      const r = await (window as any).app.window.findByUrl(u);
      return (r?.success && typeof r.id === 'number' ? r.id : null) as number | null;
    }, url) as Promise<number | null>;

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

  const tagId = async (name: string): Promise<string> => {
    const id = await bgWindow.evaluate(async (tagName: string) => {
      const r = await (window as any).app.datastore.getOrCreateTag(tagName);
      return (r?.data?.tag?.id ?? null) as string | null;
    }, name);
    expect(id, `could not resolve the tag ${name}`).toBeTruthy();
    return id as string;
  };

  const tagItem = async (itemId: string, tag: string): Promise<void> => {
    const ok = await bgWindow.evaluate(
      async (arg: { itemId: string; tagId: string }) => {
        const r = await (window as any).app.datastore.tagItem(arg.itemId, arg.tagId);
        return r?.success === true;
      },
      { itemId, tagId: await tagId(tag) },
    );
    expect(ok, `could not tag ${itemId} with ${tag}`).toBe(true);
  };

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

  const createTextItem = async (content: string): Promise<string> => {
    const id = await bgWindow.evaluate(async (text: string) => {
      const r = await (window as any).app.datastore.addItem('text', { content: text });
      return (r?.data?.id ?? null) as string | null;
    }, content);
    expect(id, `could not create the text item "${content}"`).toBeTruthy();
    return id as string;
  };

  /** The page item for a URL, which is how a visited page is already recorded. */
  const urlItemId = (url: string) =>
    bgWindow.evaluate(async (u: string) => {
      const r = await (window as any).app.datastore.findUrlItem(u);
      return (r?.data?.id ?? null) as string | null;
    }, url) as Promise<string | null>;

  const itemContent = (itemId: string) =>
    bgWindow.evaluate(async (id: string) => {
      const r = await (window as any).app.datastore.getItem(id);
      return (r?.data?.content ?? null) as string | null;
    }, itemId) as Promise<string | null>;

  /**
   * One run of a search, written the way `features/websearch/search-rounds.js
   * recordSearchRound()` writes it: an item event whose metadata `kind` is
   * `search-run`. Counting those is how a run again is read back.
   */
  const recordSearchRun = async (itemId: string, occurredAt: number): Promise<void> => {
    const ok = await bgWindow.evaluate(
      async (arg: { itemId: string; occurredAt: number }) => {
        const r = await (window as any).app.datastore.addItemEvent(arg.itemId, {
          content: 'https://example.test/?q=otters',
          occurredAt: arg.occurredAt,
          metadata: JSON.stringify({ kind: 'search-run', engineId: 'test', url: null }),
        });
        return r?.success === true;
      },
      { itemId, occurredAt },
    );
    expect(ok, `could not record a search run on ${itemId}`).toBe(true);
  };

  const runCountOf = (itemId: string) =>
    bgWindow.evaluate(async (id: string) => {
      const r = await (window as any).app.datastore.queryItemEvents({ itemIds: [id], order: 'asc' });
      const events = r?.success && Array.isArray(r.data) ? r.data : [];
      return events.filter((e: any) => {
        try {
          const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
          return meta?.kind === 'search-run';
        } catch {
          return false;
        }
      }).length;
    }, itemId) as Promise<number>;

  /** A search in the research: a text item carrying the query, with its runs. */
  const createSearchRound = async (query: string, runsAt: number[]): Promise<string> => {
    const id = await createTextItem(query);
    await tagItem(id, SEARCH_ROUND_TAG);
    await tagItem(id, SPACE_TAG);
    for (const at of runsAt) await recordSearchRun(id, at);
    return id;
  };

  // ===== Reading and driving the view =====

  /** Every row the one selection moves through, in the order it moves. */
  const allRowIds = (view: Page): Promise<string[]> =>
    view.evaluate(() =>
      Array.from(document.querySelectorAll('.cards peek-card')).map(
        (card) => (card as HTMLElement).dataset.itemId || '',
      ),
    );

  const selectedItemId = (view: Page): Promise<string | null> =>
    view.evaluate(() => {
      const found = Array.from(document.querySelectorAll('.cards peek-card')).find(
        (card) => (card as any).selected === true,
      );
      return found ? (found as HTMLElement).dataset.itemId || null : null;
    });

  const rowText = (view: Page, itemId: string, selector: string): Promise<string | null> =>
    view.evaluate(
      (arg: { id: string; selector: string }) => {
        const card = document.querySelector(`.cards peek-card[data-item-id="${arg.id}"]`);
        const found = card?.querySelector(arg.selector);
        return found ? (found.textContent || '').trim() : null;
      },
      { id: itemId, selector },
    );

  /** Whether a page row says its page is open in a window right now. */
  const rowIsOpen = (view: Page, itemId: string): Promise<boolean | null> =>
    view.evaluate((id: string) => {
      const card = document.querySelector(`.cards peek-card[data-item-id="${id}"]`) as HTMLElement | null;
      return card ? card.dataset.open === 'true' : null;
    }, itemId);

  /** What the in-place note editor holds, or `null` when no note is being edited. */
  const editorValue = (view: Page): Promise<string | null> =>
    view.evaluate(() => {
      const found = document.querySelector('#note-rows peek-input') as any;
      return found ? String(found.value ?? '') : null;
    });

  /**
   * Press Escape on the view the way the user does — through the main process.
   *
   * `keyboard.press('Escape')` does not reliably fire Electron's
   * `before-input-event` (tests/README.md), which is the only road to the
   * Escape decision and so to the view's own handler; injecting the keystroke
   * at the webContents level is what fires it.
   *
   * A second press within 200ms of the first is dropped as one keystroke
   * (`main/windows.ts addEscHandler`), so the wait is part of pressing Escape
   * twice rather than part of this test: without it the second press never
   * reaches the window at all.
   */
  const ESC_DEBOUNCE_MS = 200;
  let lastEscapeAt = 0;
  const pressEscape = async (): Promise<void> => {
    const since = Date.now() - lastEscapeAt;
    if (since < ESC_DEBOUNCE_MS + 50) {
      await new Promise((resolve) => setTimeout(resolve, ESC_DEBOUNCE_MS + 50 - since));
    }
    const sent = await app.evaluateMain!(({ BrowserWindow }, fragment) => {
      const host = BrowserWindow.getAllWindows().find((w: Electron.BrowserWindow) =>
        w.webContents.getURL().includes(fragment),
      );
      if (!host) return { error: 'no research view window found' };
      host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as any);
      host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as any);
      return { ok: true };
    }, VIEW_URL_FRAGMENT);
    lastEscapeAt = Date.now();
    expect((sent as any).ok, `Escape was not delivered: ${JSON.stringify(sent)}`).toBe(true);
  };

  /**
   * Move the selection onto a row with j and k, the way the list offers it. The
   * index is read rather than assumed, because the research holds whatever the
   * tests before this one put in it — the profile is per-describe.
   */
  const selectRow = async (view: Page, itemId: string): Promise<void> => {
    const ids = await allRowIds(view);
    const target = ids.indexOf(itemId);
    expect(target, `no row for ${itemId} among ${JSON.stringify(ids)}`).toBeGreaterThanOrEqual(0);

    const selected = await selectedItemId(view);
    let current = selected ? ids.indexOf(selected) : 0;
    if (current < 0) current = 0;

    while (current < target) { await view.keyboard.press('j'); current += 1; }
    while (current > target) { await view.keyboard.press('k'); current -= 1; }

    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(itemId);
  };

  /** Open the view on the staged research and return its window and that window's id. */
  const openResearchView = async (spaceTagId: string): Promise<{ view: Page; viewId: number }> => {
    const opened = await openWindow(pageUrl('/reading'), {
      role: 'content',
      width: 800,
      height: 600,
      spaceMode: { spaceId: spaceTagId, spaceName: SPACE_NAME, color: '#3366ff' },
    });
    expect(opened.success).toBe(true);

    await expect
      .poll(async () => (await modeOf(opened.id))?.data?.metadata?.spaceId, { timeout: 15000 })
      .toBe(spaceTagId);
    await focusWindow(opened.id);

    const result = await runCommand('research view');
    expect(result.success, `research view failed: ${JSON.stringify(result)}`).toBe(true);
    const viewId = result.windowId as number;
    expect(typeof viewId, 'the command reports which window the view is').toBe('number');

    const view = await app.getWindow(VIEW_URL_FRAGMENT, 15000);
    await view.waitForLoadState('domcontentloaded');
    return { view, viewId };
  };

  test('Enter on a page already open brings its window forward', async () => {
    const spaceTagId = await tagId(SPACE_TAG);
    const path = '/holt';

    // The page is open in a window, and that window's own visit is what puts
    // the page item in the datastore — so the row is the page, not a copy of it.
    const win = await openWindow(pageUrl(path), {
      role: 'content', key: pageUrl(path), width: 700, height: 500,
    });
    expect(win.success).toBe(true);

    await expect.poll(() => urlItemId(pageUrl(path)), { timeout: 15000 }).not.toBeNull();
    const item = (await urlItemId(pageUrl(path))) as string;
    await tagItem(item, SPACE_TAG);

    const { view, viewId } = await openResearchView(spaceTagId);
    await view.waitForSelector(`#group-pages .cards peek-card[data-item-id="${item}"]`, { timeout: 15000 });
    await expect.poll(() => rowIsOpen(view, item), { timeout: 15000 }).toBe(true);

    // The view is in front, so the page's window coming forward is a move.
    await focusWindow(viewId);
    await selectRow(view, item);
    await view.keyboard.press('Enter');

    await expect.poll(frontWindowId, { timeout: 15000 }).toBe(win.id);
  });

  test('Enter on a page in no window opens it in the research', async () => {
    const spaceTagId = await tagId(SPACE_TAG);
    const path = '/whistle';

    const item = await createPageItem(path, 'Whistles');
    await tagItem(item, SPACE_TAG);
    expect(await windowIdForUrl(pageUrl(path)), 'the page starts in no window').toBeNull();

    const { view, viewId } = await openResearchView(spaceTagId);
    await view.waitForSelector(`#group-pages .cards peek-card[data-item-id="${item}"]`, { timeout: 15000 });
    await focusWindow(viewId);
    await selectRow(view, item);
    await view.keyboard.press('Enter');

    await expect
      .poll(async () => (await windowIdForUrl(pageUrl(path))) !== null, { timeout: 15000 })
      .toBe(true);
    const openedId = (await windowIdForUrl(pageUrl(path))) as number;

    // In the research, not beside it: the window the view opened is in the space.
    await expect
      .poll(async () => (await modeOf(openedId))?.data?.metadata?.spaceId, { timeout: 15000 })
      .toBe(spaceTagId);
  });

  test('Enter on a search runs it again in the research', async () => {
    const spaceTagId = await tagId(SPACE_TAG);
    const query = 'otter holt entrance';

    const round = await createSearchRound(query, [3000]);
    expect(await runCountOf(round)).toBe(1);

    const { view, viewId } = await openResearchView(spaceTagId);
    await view.waitForSelector(`#group-searches .cards peek-card[data-item-id="${round}"]`, { timeout: 15000 });
    expect(await rowText(view, round, '.card-title')).toBe(query);

    // The space of a search is the space of the front window
    // (`features/websearch/search-rounds.js spaceOfFrontWindow()`), so the view
    // has to be the window in front for the rerun to land in the research.
    await focusWindow(viewId);
    const before = await openWindowIds();

    await selectRow(view, round);
    await view.keyboard.press('Enter');

    // A run again is another run on the round the row already is, rather than a
    // second round carrying the same query.
    await expect.poll(() => runCountOf(round), { timeout: 20000 }).toBe(2);

    // The results opened in the research. Reading the window's mode rather than
    // the result page proves where the search ran without needing the page to
    // load, which a search engine the test cannot reach would never do.
    await expect
      .poll(async () => (await openWindowIds()).filter((id) => !before.includes(id)).length, { timeout: 20000 })
      .toBeGreaterThan(0);
    const resultWindow = (await openWindowIds()).find((id) => !before.includes(id)) as number;
    await expect
      .poll(async () => (await modeOf(resultWindow))?.data?.metadata?.spaceId, { timeout: 15000 })
      .toBe(spaceTagId);
  });

  test('Enter on a note opens it for editing in place, and Enter saves the new text', async () => {
    const spaceTagId = await tagId(SPACE_TAG);

    const note = await createTextItem('otters use several holts');
    await tagItem(note, SPACE_TAG);

    const { view } = await openResearchView(spaceTagId);
    await view.waitForSelector(`#group-notes .cards peek-card[data-item-id="${note}"]`, { timeout: 15000 });

    await selectRow(view, note);
    await view.keyboard.press('Enter');

    // The row became a field holding the note, in the list where the row was.
    await expect.poll(() => editorValue(view), { timeout: 10000 }).toBe('otters use several holts');

    // The text comes up selected, so typing replaces the note.
    await view.keyboard.type('otters use several holts along one stretch');
    await view.keyboard.press('Enter');

    await expect
      .poll(() => itemContent(note), { timeout: 15000 })
      .toBe('otters use several holts along one stretch');

    // The editor closed and the row came back saying the new text, brought in by
    // the live query rather than by reopening the view.
    await expect.poll(() => editorValue(view), { timeout: 10000 }).toBeNull();
    await expect
      .poll(() => rowText(view, note, '.card-title'), { timeout: 15000 })
      .toBe('otters use several holts along one stretch');
  });

  test('leaving the row saves the note too', async () => {
    const spaceTagId = await tagId(SPACE_TAG);

    const note = await createTextItem('they whistle to each other');
    await tagItem(note, SPACE_TAG);

    const { view } = await openResearchView(spaceTagId);
    await view.waitForSelector(`#group-notes .cards peek-card[data-item-id="${note}"]`, { timeout: 15000 });

    await selectRow(view, note);
    await view.keyboard.press('Enter');
    await expect.poll(() => editorValue(view), { timeout: 10000 }).toBe('they whistle to each other');

    await view.keyboard.type('they whistle and chirp to each other');

    // Leaving the row rather than pressing Enter: the caret goes to the
    // add-a-note row, which is the other thing in this window that takes text.
    await view.evaluate(() => (document.getElementById('note-input') as any)?.focus());

    await expect
      .poll(() => itemContent(note), { timeout: 15000 })
      .toBe('they whistle and chirp to each other');
  });

  test('Escape closes the note editor, and a second Escape closes the view', async () => {
    const spaceTagId = await tagId(SPACE_TAG);

    const note = await createTextItem('holts have underwater entrances');
    await tagItem(note, SPACE_TAG);

    const { view, viewId } = await openResearchView(spaceTagId);
    await view.waitForSelector(`#group-notes .cards peek-card[data-item-id="${note}"]`, { timeout: 15000 });

    await selectRow(view, note);
    await view.keyboard.press('Enter');
    await expect.poll(() => editorValue(view), { timeout: 10000 }).toBe('holts have underwater entrances');

    // The first Escape closes the editor and leaves the note as it was.
    await view.keyboard.type('half a thought');
    await pressEscape();
    await expect.poll(() => editorValue(view), { timeout: 10000 }).toBeNull();
    expect(await itemContent(note), 'Escape leaves the note alone').toBe('holts have underwater entrances');
    expect(await openWindowIds(), 'Escape on the editor must not close the view').toContain(viewId);

    // The second finds no editor and closes the view.
    await pressEscape();
    await expect.poll(openWindowIds, { timeout: 15000 }).not.toContain(viewId);
  });
});
