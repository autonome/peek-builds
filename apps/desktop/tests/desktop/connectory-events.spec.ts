/**
 * Connectory follows an organizer's feeds and saves each event it has not seen
 * before as an item tagged `event:new`.
 *
 * Four steps, in order, against one profile: a check over two sources — an
 * `.ics` calendar and an Atom feed served by this spec's own HTTP server —
 * saves one item per event still to come, with `metadata.event` filled; a
 * second check adds nothing; removing `event:new` from one event dismisses it
 * for good, so a third check neither brings it back nor duplicates anything;
 * and the `events` command opens the search window on `#event:new` with the
 * events that are left.
 *
 * `connectory:check` is published on the System address through
 * `__peek_test.publishSystemTopic`, the same path the manifest schedule's own
 * fire takes (`main/tile-schedule.ts fire()`), so the lazy background tile is
 * woken by the load-on-dispatch hook rather than by a renderer the test holds.
 *
 * The calendar's dates are written relative to the moment the spec runs, so the
 * past event stays past and the events still to come stay ahead of the check
 * however long this spec lives. The server answers with
 * `Access-Control-Allow-Origin: *`, since the fetch is made from the tile's
 * `peek://` origin.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

const DAY_MS = 24 * 60 * 60 * 1000;

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

/** `20261023T190000Z` — an iCal UTC date-time. */
const icalStamp = (at: number): string =>
  new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** `20261023` — an iCal all-day date. */
const icalDate = (at: number): string => new Date(at).toISOString().slice(0, 10).replace(/-/g, '');

const CALENDAR_PATH = '/organizer.ics';
const FEED_PATH = '/organizer.atom';

/** The two events still to come, and one already over that must not be saved. */
const calendar = (now: number): string => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Connectory Spec//EN',
  'BEGIN:VEVENT',
  'UID:spec-doors@example.org',
  'SUMMARY:Doors open\\, finally',
  `DTSTART:${icalStamp(now + 2 * DAY_MS)}`,
  `DTEND:${icalStamp(now + 2 * DAY_MS + 3 * 60 * 60 * 1000)}`,
  'LOCATION:The Back Room\\, Lisbon',
  'URL:https://example.org/events/spec-doors',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:spec-festival@example.org',
  'SUMMARY:Festival day',
  `DTSTART;VALUE=DATE:${icalDate(now + 5 * DAY_MS)}`,
  `DTEND;VALUE=DATE:${icalDate(now + 6 * DAY_MS)}`,
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:spec-over@example.org',
  'SUMMARY:Last week\'s party',
  `DTSTART:${icalStamp(now - 8 * DAY_MS)}`,
  `DTEND:${icalStamp(now - 8 * DAY_MS + 60 * 60 * 1000)}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const feed = (now: number): string => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Organizer announcements</title>
  <entry>
    <id>tag:example.org,2026:spec-announce-1</id>
    <title>Saturday all-nighter</title>
    <link rel="alternate" href="https://example.org/announce/spec-1"/>
    <published>${new Date(now - 2 * DAY_MS).toISOString()}</published>
  </entry>
  <entry>
    <id>tag:example.org,2026:spec-announce-2</id>
    <title>Sunday matinee</title>
    <link rel="alternate" href="https://example.org/announce/spec-2"/>
    <published>${new Date(now - DAY_MS).toISOString()}</published>
  </entry>
</feed>
`;

/** Every event the calendar and the feed between them should produce. */
const EXPECTED_UIDS = [
  'spec-doors@example.org',
  'spec-festival@example.org',
  'tag:example.org,2026:spec-announce-1',
  'tag:example.org,2026:spec-announce-2',
];

type EventItem = {
  id: string;
  type: string;
  content: string;
  event: {
    uid?: string;
    sourceItemId?: string;
    title?: string;
    startDate?: string;
    endDate?: string;
    location?: string;
    publishedAt?: string;
  };
};

/** Fire a connectory check the way the manifest schedule does. */
const publishCheck = (): Promise<void> =>
  app.evaluateMain!(((_e: unknown) => {
    (globalThis as any).__peek_test.publishSystemTopic('connectory:check', {
      scheduledAt: Date.now(),
      lastRunAt: null,
    });
  }) as any);

/** The items tagged `event:new`, with their `metadata.event` parsed. */
const eventItems = (): Promise<EventItem[]> =>
  bgWindow.evaluate(async () => {
    const api = (window as any).app;
    const tag = await api.datastore.getOrCreateTag('event:new');
    const res = await api.datastore.getItemsByTag(tag.data.tag.id);
    const out: any[] = [];
    for (const item of res.data || []) {
      let metadata: any = {};
      try {
        metadata = typeof item.metadata === 'string'
          ? JSON.parse(item.metadata || '{}')
          : (item.metadata || {});
      } catch {
        metadata = {};
      }
      out.push({
        id: item.id,
        type: item.type,
        content: item.content,
        event: metadata.event || {},
      });
    }
    return out;
  });

const uidsOf = async (): Promise<string[]> =>
  (await eventItems()).map(item => item.event.uid || '').sort();

/** When a check last looked at a source, as the source's own metadata records it. */
const checkedAt = (sourceItemId: string): Promise<string> =>
  bgWindow.evaluate(async (id: string) => {
    const res = await (window as any).app.datastore.getItem(id);
    let metadata: any = {};
    try {
      metadata = JSON.parse(res?.data?.metadata || '{}');
    } catch {
      metadata = {};
    }
    return metadata.connectory?.checkedAt || '';
  }, sourceItemId);

test.describe('Connectory saves new events @desktop', () => {
  let sourceIds: { calendar: string; feed: string };

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('connectory-events'));
    await waitForExtensionsReady(bgWindow, 15000);

    const now = Date.now();
    await new Promise<void>(resolve => {
      server = http.createServer((req, res) => {
        if (req.url === CALENDAR_PATH) {
          res.writeHead(200, {
            'Content-Type': 'text/calendar',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(calendar(now));
          return;
        }
        if (req.url === FEED_PATH) {
          res.writeHead(200, {
            'Content-Type': 'application/atom+xml',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(feed(now));
          return;
        }
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    sourceIds = await bgWindow.evaluate(async (urls: { calendar: string; feed: string }) => {
      const api = (window as any).app;
      const tag = await api.datastore.getOrCreateTag('event:source');
      const saved: Record<string, string> = {};
      for (const [kind, url] of Object.entries(urls)) {
        const item = await api.datastore.addItem('url', {
          content: url,
          metadata: JSON.stringify({ title: `connectory spec ${kind}` }),
        });
        await api.datastore.tagItem(item.data.id, tag.data.tag.id);
        saved[kind] = item.data.id;
      }
      return saved as { calendar: string; feed: string };
    }, {
      calendar: `http://127.0.0.1:${serverPort}${CALENDAR_PATH}`,
      feed: `http://127.0.0.1:${serverPort}${FEED_PATH}`,
    });

    expect(sourceIds.calendar).toBeTruthy();
    expect(sourceIds.feed).toBeTruthy();
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('a check saves one event:new item per event still to come', async () => {
    await publishCheck();

    await expect.poll(uidsOf, { timeout: 30000 }).toEqual([...EXPECTED_UIDS].sort());

    const items = await eventItems();
    const byUid = new Map(items.map(item => [item.event.uid, item]));

    // An event with a link is a URL item; one without is a text item titled
    // with its summary.
    const doors = byUid.get('spec-doors@example.org')!;
    expect(doors.type).toBe('url');
    expect(doors.content).toBe('https://example.org/events/spec-doors');
    expect(doors.event.sourceItemId).toBe(sourceIds.calendar);
    expect(doors.event.title).toBe('Doors open, finally');
    expect(doors.event.location).toBe('The Back Room, Lisbon');
    expect(doors.event.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(doors.event.endDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const festival = byUid.get('spec-festival@example.org')!;
    expect(festival.type).toBe('text');
    expect(festival.content).toBe('Festival day');
    // An all-day event stays a date with no time.
    expect(festival.event.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A feed entry carries no event date, so only publishedAt is kept.
    const announce = byUid.get('tag:example.org,2026:spec-announce-1')!;
    expect(announce.type).toBe('url');
    expect(announce.event.sourceItemId).toBe(sourceIds.feed);
    expect(announce.event.title).toBe('Saturday all-nighter');
    expect(announce.event.startDate).toBeUndefined();
    expect(announce.event.publishedAt).toBeTruthy();

    // The event already over was not saved.
    expect(items.some(item => item.event.uid === 'spec-over@example.org')).toBe(false);
  });

  test('a second check adds nothing', async () => {
    const before = await eventItems();
    const checkedBefore = await checkedAt(sourceIds.feed);
    expect(checkedBefore).toBeTruthy();

    await publishCheck();

    // Wait for the source's own record of this check to move on, so the
    // assertion below is made after the second check ran rather than before it
    // started — an absence proved too early proves nothing.
    await expect.poll(() => checkedAt(sourceIds.feed), { timeout: 30000 })
      .not.toBe(checkedBefore);

    const after = await eventItems();
    expect(after.map(i => i.event.uid).sort()).toEqual(before.map(i => i.event.uid).sort());
    expect(after.length).toBe(before.length);
  });

  test('removing event:new dismisses an event, and a later check does not bring it back', async () => {
    const dismissed = (await eventItems()).find(i => i.event.uid === 'spec-doors@example.org')!;
    expect(dismissed).toBeTruthy();

    const removed = await bgWindow.evaluate(async (itemId: string) => {
      const api = (window as any).app;
      const tag = await api.datastore.getOrCreateTag('event:new');
      return await api.datastore.untagItem(itemId, tag.data.tag.id);
    }, dismissed.id);
    expect(removed?.success).toBe(true);

    const remaining = EXPECTED_UIDS.filter(uid => uid !== 'spec-doors@example.org').sort();
    expect(await uidsOf()).toEqual(remaining);

    await publishCheck();

    // Poll a while so a re-add would have time to show, then confirm the set
    // is still the one without the dismissed event and holds no duplicates.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      expect(await uidsOf()).toEqual(remaining);
      await new Promise(r => setTimeout(r, 500));
    }

    const items = await eventItems();
    expect(items.length).toBe(remaining.length);
    expect(new Set(items.map(i => i.id)).size).toBe(items.length);
  });

  test('the events command opens the search window on #event:new', async () => {
    const listed = (await eventItems()).find(i => i.event.uid === 'spec-festival@example.org')!;
    expect(listed).toBeTruthy();

    await app.evaluateMain!(((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('events');
    }) as any);

    const query = '#event:new';
    await expect.poll(async () => {
      const urls: string[] = await bgWindow.evaluate(async () => {
        const res = await (window as any).app.window.list();
        if (!res || !res.windows) return [];
        return res.windows
          .filter((w: { url?: string }) =>
            typeof w.url === 'string' && w.url.includes('peek://search/home.html'))
          .map((w: { url: string }) => w.url);
      });
      return urls.map(u => new URL(u).searchParams.get('q'));
    }, { timeout: 20000 }).toContain(query);

    const deadline = Date.now() + 10000;
    let searchPage: Page | undefined;
    while (Date.now() < deadline) {
      searchPage = app.windows().find(p =>
        p.url().includes('search/home.html')
        && decodeURIComponent(p.url()).includes(`q=${query}`));
      if (searchPage) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(searchPage, 'search window for #event:new not found').toBeTruthy();
    await searchPage!.waitForLoadState('domcontentloaded');

    await searchPage!.waitForSelector(`peek-card[data-item-id="${listed.id}"]`, { timeout: 15000 });
  });
});
