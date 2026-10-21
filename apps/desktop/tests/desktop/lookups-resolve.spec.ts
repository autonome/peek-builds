/**
 * Lookups end to end — a text item tagged `to-watch`, `to-read` or `to-listen`
 * is resolved to the work its title names.
 *
 * Nothing here reaches Wikidata. A local HTTP server answers
 * `wbsearchentities` and `wbgetentities` out of `tests/unit/fixtures/lookups/`,
 * recorded once by hand, and the feature's `apiBase` setting is seeded with its
 * address while the lazy tile is still cold.
 *
 * What this covers that the unit tests cannot: the whole-text retry (the
 * `to-watch` title's ` by ` is part of the title, so it resolves only on the
 * second search), the three fetches in sequence, the metadata and tag writes,
 * and the single `lookups:resolved` publish for the item that has a TMDB id.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let apiBase: string;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../unit/fixtures/lookups');

/** Item ids, filled in by the setup below. */
const items: Record<string, string> = {};

const readFixture = (...parts: string[]): unknown | null => {
  const path = join(FIXTURES, ...parts);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

/** The file a recorded search lives in, named after the term it was recorded for. */
const searchSlug = (term: string): string =>
  term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Answer one Wikidata API request from the fixtures. A term with no recording
 * answers no hits, which is what an unresolvable title looks like.
 */
function answer(query: URLSearchParams): unknown {
  const action = query.get('action');

  if (action === 'wbsearchentities') {
    const term = query.get('search') || '';
    const recorded = readFixture('search', `${searchSlug(term)}.json`);
    return recorded || { searchinfo: { search: term }, search: [], success: 1 };
  }

  if (action === 'wbgetentities') {
    // The creator-label call asks for labels alone; the candidate call asks for
    // claims too, and only the recorded entities carry those.
    const dir = (query.get('props') || '').includes('claims') ? 'entities' : 'labels';
    const entities: Record<string, unknown> = {};
    for (const id of (query.get('ids') || '').split('|').filter(Boolean)) {
      const recorded = readFixture(dir, `${id}.json`) ?? readFixture('entities', `${id}.json`);
      if (recorded) entities[id] = recorded;
    }
    return { entities, success: 1 };
  }

  return { error: { code: 'unknown-action', info: `no fixture server route for ${action}` } };
}

/** Create a text item with one tag, and hand back its id. */
const addTagged = (content: string, tagName: string, type = 'text'): Promise<string> =>
  bgWindow.evaluate(
    async ({ content: text, tagName: name, type: itemType }) => {
      const api = (window as any).app;
      const item = await api.datastore.addItem(itemType, { content: text });
      if (!item?.success) throw new Error(`addItem failed: ${item?.error}`);
      const tag = await api.datastore.getOrCreateTag(name);
      if (!tag?.success) throw new Error(`getOrCreateTag failed: ${tag?.error}`);
      await api.datastore.tagItem(item.data.id, tag.data.tag.id);
      return item.data.id as string;
    },
    { content, tagName, type },
  );

/** The item's `metadata.lookup`, or null while it has none yet. */
const readLookup = (itemId: string): Promise<any> =>
  bgWindow.evaluate(async (id: string) => {
    const res = await (window as any).app.datastore.getItem(id);
    if (!res?.success || !res.data) return null;
    try {
      return (JSON.parse(res.data.metadata || '{}') || {}).lookup ?? null;
    } catch {
      return null;
    }
  }, itemId);

const readTags = (itemId: string): Promise<string[]> =>
  bgWindow.evaluate(async (id: string) => {
    const res = await (window as any).app.datastore.getItemTags(id);
    return res?.success ? (res.data || []).map((tag: any) => tag.name) : [];
  }, itemId);

/** What the feature put on `lookups:resolved`; the broker adds its own `source`. */
const readResolvedPublishes = (): Promise<any[]> =>
  bgWindow.evaluate(() =>
    ((window as any).__lookupsResolved || []).map((msg: any) => ({
      itemId: msg.itemId,
      tmdb: msg.tmdb,
    })),
  );

const publishCheck = (): Promise<void> =>
  app.evaluateMain!(((_e: unknown) => {
    (globalThis as any).__peek_test.publishSystemTopic('lookups:check', {
      scheduledAt: Date.now(),
      lastRunAt: null,
    });
  }) as any);

test.describe('Lookups resolve tagged titles @desktop', () => {
  // The second check reads what the first one wrote, so both tests must run in
  // order against the one app; split across workers each would get its own
  // profile and the second would find nothing already looked up.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('lookups-resolve'));

    await new Promise<void>(resolve => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer(url.searchParams)));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        apiBase = `http://127.0.0.1:${port}/w/api.php`;
        resolve();
      });
    });

    await waitForExtensionsReady(bgWindow, 15000);

    // Point the feature at the fixture server while its tile is still cold, so
    // the address is in place before the wake publish lands.
    const seed = await bgWindow.evaluate(async (base: string) => {
      return await (window as any).app.datastore.setRow('feature_settings', 'lookups:apiBase', {
        featureId: 'lookups',
        key: 'apiBase',
        value: JSON.stringify(base),
        updatedAt: Date.now(),
      });
    }, apiBase);
    expect(seed.success).toBe(true);

    // Collect `lookups:resolved` from before the check runs.
    await bgWindow.evaluate(() => {
      (window as any).__lookupsResolved = [];
      (window as any).app.pubsub.subscribe('lookups:resolved', (msg: unknown) => {
        (window as any).__lookupsResolved.push(msg);
      });
    });

    // The ` by ` in this title is part of the title, so the split search
    // ("Stand") finds no film and only the whole-text retry resolves it.
    items.watch = await addTagged('Stand by Me', 'to-watch');
    items.read = await addTagged('The Piano Tuner (about Thai Myanmar border)', 'to-read');
    items.listen = await addTagged('Arrival, ABBA', 'to-listen');
    items.unresolved = await addTagged('Clara and the Sun', 'to-read');
    items.page = await addTagged('https://example.com/a-review', 'to-watch', 'url');
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('a check resolves each tagged text item and leaves the URL item alone', async () => {
    await publishCheck();

    await expect
      .poll(() => readLookup(items.unresolved), { timeout: 20000 })
      .not.toBeNull();

    const watch = await readLookup(items.watch);
    expect(watch).toMatchObject({
      wikidataId: 'Q494722',
      label: 'Stand by Me',
      kind: 'film',
      creator: 'Rob Reiner',
      links: {
        wikipedia: 'https://en.wikipedia.org/wiki/Stand_by_Me_(film)',
        tmdb: { type: 'movie', id: '235' },
      },
    });
    expect(typeof watch.resolvedAt).toBe('number');
    expect(await readTags(items.watch)).toEqual(
      expect.arrayContaining(['to-watch', 'lookup:found']),
    );

    const read = await readLookup(items.read);
    expect(read).toMatchObject({
      wikidataId: 'Q2882166',
      kind: 'written work',
      creator: 'Daniel Mason',
      links: {
        wikipedia: 'https://en.wikipedia.org/wiki/The_Piano_Tuner_(2002_novel)',
        openLibrary: 'https://openlibrary.org/works/OL5956196W',
      },
    });
    expect(await readTags(items.read)).toEqual(
      expect.arrayContaining(['to-read', 'lookup:found']),
    );

    // "Arrival" ranks the Journey album above the ABBA one; the creator hint
    // after the comma is what makes ABBA's win.
    const listen = await readLookup(items.listen);
    expect(listen).toMatchObject({
      wikidataId: 'Q162392',
      kind: 'album',
      creator: 'ABBA',
      links: {
        wikipedia: 'https://en.wikipedia.org/wiki/Arrival_(ABBA_album)',
        spotify: 'https://open.spotify.com/album/79ZX48114T8NH36MnOTtl7',
        musicbrainz: 'https://musicbrainz.org/release-group/e464e167-83ab-3b59-88bd-262cf552056e',
      },
    });
    expect(await readTags(items.listen)).toEqual(
      expect.arrayContaining(['to-listen', 'lookup:found']),
    );

    const unresolved = await readLookup(items.unresolved);
    expect(unresolved.unresolved).toBe(true);
    expect(typeof unresolved.checkedAt).toBe('number');
    expect(unresolved.wikidataId).toBeUndefined();
    expect(await readTags(items.unresolved)).toEqual(
      expect.arrayContaining(['to-read', 'lookup:unresolved']),
    );

    // The URL item carries the tag but is not a typed title.
    expect(await readLookup(items.page)).toBeNull();
    expect(await readTags(items.page)).toEqual(['to-watch']);

    // Only the film has a TMDB id, so only it is announced.
    expect(await readResolvedPublishes()).toEqual([
      { itemId: items.watch, tmdb: { type: 'movie', id: '235' } },
    ]);
  });

  test('a second check takes the new item and leaves the resolved ones alone', async () => {
    const before = await readLookup(items.watch);
    const beforeUnresolved = await readLookup(items.unresolved);
    items.series = await addTagged('The Expanse', 'to-watch');

    await publishCheck();

    // The new item resolving is what proves this check ran to the end.
    await expect.poll(() => readLookup(items.series), { timeout: 20000 }).not.toBeNull();
    const series = await readLookup(items.series);
    expect(series).toMatchObject({
      wikidataId: 'Q18389644',
      kind: 'television series',
      links: { tmdb: { type: 'tv', id: '63639' } },
    });

    // The items already carrying a lookup were skipped, found and unresolved
    // alike, so neither was written again or announced again.
    expect(await readLookup(items.watch)).toEqual(before);
    expect(await readLookup(items.unresolved)).toEqual(beforeUnresolved);
    expect(await readResolvedPublishes()).toEqual([
      { itemId: items.watch, tmdb: { type: 'movie', id: '235' } },
      { itemId: items.series, tmdb: { type: 'tv', id: '63639' } },
    ]);
  });
});
