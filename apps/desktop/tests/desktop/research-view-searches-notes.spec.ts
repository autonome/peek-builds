/**
 * The research view's other two groups: the searches the research ran, and the
 * notes written into it.
 *
 * The research is staged as data rather than driven through the UI: one page,
 * two `search-round` items with their run events written directly, and one
 * note. The run events are what the search order is read from, so the search
 * created second is given the earlier first run — an order that matches
 * creation order would prove nothing.
 *
 * What this spec proves is the view's side of the contract: the three groups in
 * order, searches in run order with their run counts, one selection crossing
 * all three, and the add-a-note row writing a `text` item into the research
 * that the live query brings into the Notes group without reopening the view.
 *
 * The orders themselves are decided in `tests/unit/research-view-groups.test.js`.
 *
 *   yarn test:grep "research-view-searches-notes"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

test.describe('research-view-searches-notes @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  const SPACE_NAME = 'badgers';
  const SPACE_TAG = `space:${SPACE_NAME}`;
  const SEARCH_ROUND_TAG = 'search-round';
  const VIEW_URL_FRAGMENT = 'research/home.html';

  const pageUrl = (path: string) => `http://127.0.0.1:${serverPort}${path}`;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('research-view-searches-notes'));
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

  /**
   * One run of a search, written the way `features/websearch/search-rounds.js
   * recordSearchRound()` writes it: an item event whose metadata `kind` is
   * `search-run`. Written directly so the run order under test is a fact about
   * the data rather than about which search the harness happened to run first.
   */
  const recordSearchRun = async (itemId: string, occurredAt: number): Promise<void> => {
    const ok = await bgWindow.evaluate(
      async (arg: { itemId: string; occurredAt: number }) => {
        const r = await (window as any).app.datastore.addItemEvent(arg.itemId, {
          content: 'https://example.test/?q=badgers',
          occurredAt: arg.occurredAt,
          metadata: JSON.stringify({ kind: 'search-run', engineId: 'test', url: null }),
        });
        return r?.success === true;
      },
      { itemId, occurredAt },
    );
    expect(ok, `could not record a search run on ${itemId}`).toBe(true);
  };

  /** A search in the research: a text item carrying the query, with its runs. */
  const createSearchRound = async (query: string, runsAt: number[]): Promise<string> => {
    const id = await createTextItem(query);
    await tagItem(id, SEARCH_ROUND_TAG);
    await tagItem(id, SPACE_TAG);
    for (const at of runsAt) await recordSearchRun(id, at);
    return id;
  };

  // ===== Reading the view =====

  const groupRowIds = (view: Page, groupId: string): Promise<string[]> =>
    view.evaluate(
      (id: string) =>
        Array.from(document.querySelectorAll(`#${id} .cards peek-card`)).map(
          (card) => (card as HTMLElement).dataset.itemId || '',
        ),
      groupId,
    );

  /** Every row the one selection moves through, in the order it moves. */
  const allRowIds = (view: Page): Promise<string[]> =>
    view.evaluate(() =>
      Array.from(document.querySelectorAll('.cards peek-card')).map(
        (card) => (card as HTMLElement).dataset.itemId || '',
      ),
    );

  const rowText = (view: Page, itemId: string, selector: string): Promise<string | null> =>
    view.evaluate(
      (arg: { id: string; selector: string }) => {
        const card = document.querySelector(`.cards peek-card[data-item-id="${arg.id}"]`);
        const found = card?.querySelector(arg.selector);
        return found ? (found.textContent || '').trim() : null;
      },
      { id: itemId, selector },
    );

  const selectedItemId = (view: Page): Promise<string | null> =>
    view.evaluate(() => {
      const found = Array.from(document.querySelectorAll('.cards peek-card')).find(
        (card) => (card as any).selected === true,
      );
      return found ? (found as HTMLElement).dataset.itemId || null : null;
    });

  const tagNamesOf = (itemId: string): Promise<string[]> =>
    bgWindow.evaluate(async (id: string) => {
      const r = await (window as any).app.datastore.getItemTags(id);
      return r?.success ? ((r.data || []) as any[]).map((t) => String(t.name)) : [];
    }, itemId);

  /** Open the view on the staged research and return its window. */
  const openResearchView = async (spaceTagId: string): Promise<Page> => {
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

    const view = await app.getWindow(VIEW_URL_FRAGMENT, 15000);
    await view.waitForLoadState('domcontentloaded');
    return view;
  };

  test('the groups are pages, then searches in run order, then notes', async () => {
    const spaceTagId = await tagId(SPACE_TAG);

    const page = await createPageItem('/sett', 'Setts');
    await tagItem(page, SPACE_TAG);

    // Created second, first run earlier: the order can only come from the runs.
    const laterSearch = await createSearchRound('badger sett depth', [5000, 6000, 7000]);
    const earlierSearch = await createSearchRound('badger diet', [2000]);

    const note = await createTextItem('setts are reused for generations');
    await tagItem(note, SPACE_TAG);

    const view = await openResearchView(spaceTagId);
    await view.waitForSelector('#group-notes .cards peek-card', { timeout: 15000 });

    await expect.poll(() => groupRowIds(view, 'group-pages'), { timeout: 15000 }).toEqual([page]);
    await expect
      .poll(() => groupRowIds(view, 'group-searches'), { timeout: 15000 })
      .toEqual([earlierSearch, laterSearch]);
    await expect.poll(() => groupRowIds(view, 'group-notes'), { timeout: 15000 }).toEqual([note]);

    // The groups are drawn in that order, which is also the order one
    // selection moves through them.
    await expect
      .poll(() => allRowIds(view), { timeout: 15000 })
      .toEqual([page, earlierSearch, laterSearch, note]);

    // A search row says its query and how many times it ran.
    expect(await rowText(view, earlierSearch, '.card-title')).toBe('badger diet');
    expect(await rowText(view, earlierSearch, '.card-run-count')).toBe('1 run');
    expect(await rowText(view, laterSearch, '.card-run-count')).toBe('3 runs');

    // One selection across all three groups: j steps off the last page onto
    // the first search and on into the notes.
    expect(await selectedItemId(view)).toBe(page);
    await view.keyboard.press('j');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(earlierSearch);
    await view.keyboard.press('j');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(laterSearch);
    await view.keyboard.press('j');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(note);
    await view.keyboard.press('k');
    await expect.poll(() => selectedItemId(view), { timeout: 5000 }).toBe(laterSearch);
  });

  test('the add-a-note row writes a note into the research, and it appears without reopening', async () => {
    const spaceTagId = await tagId(SPACE_TAG);

    const page = await createPageItem('/latrine', 'Latrines');
    await tagItem(page, SPACE_TAG);

    const view = await openResearchView(spaceTagId);
    await view.waitForSelector('#group-pages .cards peek-card', { timeout: 15000 });

    // The profile is per-describe, so the research still holds what the first
    // test put in it; what this test reads is the difference writing a note
    // makes, not the whole research.
    const before = await groupRowIds(view, 'group-notes');
    const pagesBefore = await groupRowIds(view, 'group-pages');
    expect(pagesBefore).toContain(page);

    // The row is reached the way the list offers it — `n` from the list, no
    // mouse — and it is the only editable text here.
    await view.keyboard.press('n');
    await expect
      .poll(() => view.evaluate(() => document.activeElement?.id || ''), { timeout: 5000 })
      .toBe('note-input');

    await view.keyboard.type('they are fastidious about latrines');
    await view.keyboard.press('Enter');

    // The live query is what brings it in; nothing reopened the view.
    await expect
      .poll(() => groupRowIds(view, 'group-notes'), { timeout: 15000 })
      .toHaveLength(before.length + 1);

    const noteIds = await groupRowIds(view, 'group-notes');
    const written = noteIds.find((id) => !before.includes(id)) as string;
    expect(written, 'the note row carries the item it was written as').toBeTruthy();
    expect(await rowText(view, written, '.card-title')).toBe('they are fastidious about latrines');

    // A `text` item in the research, which is what makes it a note rather than
    // a line of text in this window.
    expect(await tagNamesOf(written)).toContain(SPACE_TAG);

    // The row is left empty and ready for the next note, and the page group is
    // untouched.
    expect(await view.evaluate(() => (document.getElementById('note-input') as any)?.value)).toBe('');
    expect(await groupRowIds(view, 'group-pages')).toEqual(pagesBefore);

    // Escape leaves the row for the list rather than closing the view.
    await view.keyboard.type('half a thought');
    await view.keyboard.press('Escape');
    await expect
      .poll(() => view.evaluate(() => (document.getElementById('note-input') as any)?.value ?? null), {
        timeout: 5000,
      })
      .toBe('');
    expect(
      await view.evaluate(() => document.activeElement?.id || ''),
      'Escape moves the focus out of the add-a-note row',
    ).not.toBe('note-input');
    const stillOpen = await openWindowIds();
    expect(stillOpen.length, 'Escape in the note row must not close the view').toBeGreaterThan(1);
  });
});
