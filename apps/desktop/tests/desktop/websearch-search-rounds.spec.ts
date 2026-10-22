/**
 * Search rounds end to end: every web search becomes a `search-round` item
 * with one `search-run` event per run, and a search started from a window in a
 * space puts both the search and its result page in that space.
 *
 * A local `http` server stands in for the search engine, so no test touches
 * the network: the websearch tile's settings are rewritten to hold one custom
 * engine whose `searchUrl` points at that server, and that engine is made the
 * default. The settings are persisted, so the lazy tile picks them up on every
 * later wake.
 *
 * The profile is per-describe and therefore fresh, but the assertions still
 * scope themselves to the query text rather than to a total item count.
 *
 * Run with:
 *   yarn test:grep "Websearch search rounds"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

const ENGINE_ID = 'localtest';
const SPACE_NAME = 'rounds';
const SPACE_TAG = `space:${SPACE_NAME}`;

/** Ids of the windows on the local server, so a test can close what the last one left front. */
const localServerWindowIds = async (): Promise<number[]> =>
  bgWindow.evaluate(async (origin: string) => {
    const r = await (window as any).app.window.list({ includeInternal: false });
    if (!r?.success) return [];
    return (r.windows as any[]).filter((w) => w.url?.startsWith(origin)).map((w) => w.id);
  }, `http://127.0.0.1:${serverPort}`);

const searchUrlTemplate = () => `http://127.0.0.1:${serverPort}/search?q={searchTerms}`;
const resultUrlFor = (query: string) =>
  `http://127.0.0.1:${serverPort}/search?q=${encodeURIComponent(query)}`;

// ===== Driving the app through the background window =====

const openWindow = async (url: string, options: Record<string, unknown>) =>
  bgWindow.evaluate(
    async (arg: { url: string; options: Record<string, unknown> }) =>
      await (window as any).app.window.open(arg.url, arg.options),
    { url, options },
  ) as Promise<{ success: boolean; id: number }>;

const closeWindow = async (windowId: number) => {
  try {
    await bgWindow.evaluate(
      async (id: number) => await (window as any).app.window.close(id),
      windowId,
    );
  } catch {
    // Already gone.
  }
};

const frontWindowId = () =>
  bgWindow.evaluate(
    async () => await (window as any).app.window.getFocusedVisibleWindowId(),
  ) as Promise<number | null>;

const spaceTagId = async (): Promise<string> => {
  const id = await bgWindow.evaluate(async (name: string) => {
    const r = await (window as any).app.datastore.getOrCreateTag(name);
    return (r?.data?.tag?.id ?? null) as string | null;
  }, SPACE_TAG);
  expect(id, `could not resolve the tag ${SPACE_TAG}`).toBeTruthy();
  return id as string;
};

const itemsMatching = (type: string, search: string) =>
  bgWindow.evaluate(
    async (arg: { type: string; search: string }) => {
      const r = await (window as any).app.datastore.queryItems({
        type: arg.type,
        search: arg.search,
      });
      return ((r?.data ?? []) as any[]).map((item) => ({ id: item.id, content: item.content }));
    },
    { type, search },
  ) as Promise<{ id: string; content: string }[]>;

const itemTagNames = (itemId: string) =>
  bgWindow.evaluate(async (id: string) => {
    const r = await (window as any).app.datastore.getItemTags(id);
    return ((r?.data ?? []) as any[]).map((tag) => tag.name ?? tag.tag?.name);
  }, itemId) as Promise<string[]>;

const itemEvents = (itemId: string) =>
  bgWindow.evaluate(async (id: string) => {
    const r = await (window as any).app.datastore.queryItemEvents({
      itemId: id,
      limit: 50,
      order: 'asc',
    });
    return ((r?.data ?? []) as any[]).map((evt) => ({
      content: evt.content,
      metadata: evt.metadata,
    }));
  }, itemId) as Promise<{ content: string; metadata: string }[]>;

/** Run a palette command and wait for its result. */
const runCommand = (name: string, search: string) =>
  bgWindow.evaluate(
    async (arg: { name: string; search: string }) => {
      const api = (window as any).app;
      return await new Promise((resolve) => {
        const resultTopic = `cmd:execute:${arg.name}:result:${Date.now()}:${Math.random()}`;
        api.subscribe(resultTopic, (r: unknown) => resolve(r));
        api.publish(`cmd:execute:${arg.name}`, {
          name: arg.name,
          search: arg.search,
          params: [arg.search],
          expectResult: true,
          resultTopic,
        });
        setTimeout(() => resolve({ error: `timeout waiting for ${arg.name}` }), 20000);
      });
    },
    { name, search },
  );

const waitFor = async <T>(
  what: string,
  probe: () => Promise<T | null | undefined>,
  timeout = 15000,
): Promise<T> => {
  const deadline = Date.now() + timeout;
  let last: T | null | undefined = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
};

/**
 * The tracked page item for a result URL, once it exists.
 *
 * The datastore stores the normalized URL (`datastore.ts normalizeUrl` sorts
 * the query string, which re-encodes a space as `+`), so the match is on the
 * `q` parameter rather than on the URL text the engine template produced.
 */
const waitForResultPageItem = (query: string) =>
  waitFor(`the tracked result page for "${query}"`, async () => {
    const pages = await itemsMatching('url', '/search');
    return (
      pages.find((page) => {
        try {
          return new URL(page.content).searchParams.get('q') === query;
        } catch {
          return false;
        }
      }) || null
    );
  });

/** The one `search-round` item whose content is exactly this query, once it exists. */
const waitForRoundItem = (query: string) =>
  waitFor(`the search-round item for "${query}"`, async () => {
    const candidates = (await itemsMatching('text', query)).filter((i) => i.content === query);
    for (const candidate of candidates) {
      const tags = await itemTagNames(candidate.id);
      if (tags.includes('search-round')) return { ...candidate, tags };
    }
    return null;
  });

// ===== Making the local server the default engine =====

/**
 * Write the websearch tile's engine list and prefs from inside its own window,
 * then close that window. The settings are persisted, so each later lazy wake
 * of the tile boots with the local engine as its default — and the closed
 * window cannot be mistaken for the window a later search was started from.
 */
const installLocalEngine = async () => {
  const opened = await openWindow('peek://websearch/home.html', { width: 600, height: 500 });
  expect(opened.success).toBe(true);

  const searchWindow = await app.getWindow('websearch/home.html', 15000);
  expect(searchWindow).toBeTruthy();
  await searchWindow.waitForLoadState('domcontentloaded');

  const wrote = await searchWindow.evaluate(async (template: string) => {
    const api = (window as any).app;
    const engines = await api.settings.set('engines', [
      {
        id: 'localtest',
        name: 'Local Test',
        shortName: 'localtest',
        description: 'Local test engine',
        searchUrl: template,
        suggestUrl: null,
        iconUrl: null,
        isBuiltIn: false,
        enabled: true,
      },
    ]);
    const prefs = await api.settings.set('prefs', {
      defaultEngine: 'localtest',
      enableSuggestions: false,
      enableAutoDiscovery: false,
    });
    return { engines: engines?.success === true, prefs: prefs?.success === true };
  }, searchUrlTemplate());

  expect(wrote.engines, 'writing the websearch engine list').toBe(true);
  expect(wrote.prefs, 'writing the websearch prefs').toBe(true);

  await closeWindow(opened.id);
};

test.describe('Websearch search rounds @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('websearch-search-rounds'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const title = (req.url || '').startsWith('/search') ? 'Local results' : 'Local page';
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

    await installLocalEngine();
  });

  // Every window on the local server goes away between tests, so the window a
  // test finds in front is one it opened itself.
  test.afterEach(async () => {
    for (const id of await localServerWindowIds()) await closeWindow(id);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('a search is recorded as one round item carrying one run per search', async () => {
    const query = 'otter diet';

    await runCommand('web search', query);

    const item = await waitForRoundItem(query);
    expect(item.tags).toContain('search-round');

    // Nothing is asserted here about space membership: whether the window a
    // boot-time search runs from already belongs to the default space depends
    // on when the lazy spaces tile wakes and creates it. The space is the next
    // test's subject, staged explicitly.

    const events = await waitFor('the search-run event', async () => {
      const found = await itemEvents(item.id);
      return found.length > 0 ? found : null;
    });
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe(resultUrlFor(query));

    const metadata = JSON.parse(events[0].metadata);
    expect(metadata.kind).toBe('search-run');
    expect(metadata.engineId).toBe(ENGINE_ID);
    expect(metadata.url).toBe(resultUrlFor(query));

    // One item per distinct query text, however many runs.
    await runCommand('web search', query);
    const runs = await waitFor('the second search-run event', async () => {
      const found = await itemEvents(item.id);
      return found.length > 1 ? found : null;
    });
    expect(runs).toHaveLength(2);

    const sameQueryItems = (await itemsMatching('text', query)).filter((i) => i.content === query);
    expect(sameQueryItems).toHaveLength(1);
  });

  test('a search started from a window in a space puts the search and the result page in it', async () => {
    const tagId = await spaceTagId();

    const opened = await openWindow(`http://127.0.0.1:${serverPort}/home`, {
      role: 'content',
      width: 800,
      height: 600,
      spaceMode: { spaceId: tagId, spaceName: SPACE_NAME, color: '#3366ff' },
    });
    expect(opened.success).toBe(true);

    // The space has to be on the window before the search reads it, and that
    // window has to be the one the search is attributed to.
    await waitFor('the space mode on the opened window', async () => {
      const mode = await bgWindow.evaluate(
        async (id: number) => await (window as any).app.context.get('mode', id),
        opened.id,
      );
      return (mode as any)?.data?.metadata?.spaceId === tagId ? true : null;
    });
    await waitFor('the space window to become the front content window', async () =>
      (await frontWindowId()) === opened.id ? true : null,
    );

    const query = 'otter range';
    await runCommand('web search', query);

    const item = await waitForRoundItem(query);
    expect(item.tags).toContain('search-round');
    expect(item.tags).toContain(SPACE_TAG);

    const page = await waitForResultPageItem(query);
    const pageTags = await waitFor(`the space tag on ${page.content}`, async () => {
      const tags = await itemTagNames(page.id);
      return tags.includes(SPACE_TAG) ? tags : null;
    });
    expect(pageTags).toContain(SPACE_TAG);
  });
});
