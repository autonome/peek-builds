/**
 * A `remind:<duration>` tag brings an item back when it comes due.
 *
 * Three steps, in order, against one profile: tagging an item `remind:1m`
 * starts a reminder due about a minute out; a reminder whose `dueAt` has passed
 * loses the duration tag and gains `remind:due`; and the `reminders` command
 * opens the search window on `#remind:due` with that item listed.
 *
 * `reminders:check` is published on the System address through
 * `__peek_test.publishSystemTopic`, the same path the manifest schedule's own
 * fire takes (`main/tile-schedule.ts fire()`), so the lazy background tile is
 * woken by the load-on-dispatch hook rather than by a renderer the test holds.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

const MINUTE = 60 * 1000;

let app: DesktopApp;
let bgWindow: Page;
let itemId: string;

/** Fire a reminders check the way the manifest schedule does. */
const publishCheck = (): Promise<void> =>
  app.evaluateMain!(((_e: unknown) => {
    (globalThis as any).__peek_test.publishSystemTopic('reminders:check', {
      scheduledAt: Date.now(),
      lastRunAt: null,
    });
  }) as any);

/** The item's `metadata.reminder`, parsed — the datastore stores metadata as JSON text. */
const readReminder = (): Promise<{ tag: string; dueAt: number } | null> =>
  bgWindow.evaluate(async (id: string) => {
    const res = await (window as any).app.datastore.getItem(id);
    if (!res?.success || !res.data) return null;
    const raw = res.data.metadata;
    let metadata: any = {};
    try {
      metadata = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    } catch {
      metadata = {};
    }
    return metadata.reminder ?? null;
  }, itemId);

const readTags = (): Promise<string[]> =>
  bgWindow.evaluate(async (id: string) => {
    const res = await (window as any).app.datastore.getItemTags(id);
    return res?.success ? res.data.map((t: any) => t.name).sort() : [];
  }, itemId);

test.describe('Reminders come due @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('reminders-due'));
    await waitForExtensionsReady(bgWindow, 15000);

    const created = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'reminders due test' }),
      });
      const tag = await api.datastore.getOrCreateTag('remind:1m');
      await api.datastore.tagItem(item.data.id, tag.data.tag.id);
      return { itemId: item.data.id };
    }, `https://reminders-due-${Date.now()}.example.com/`);

    expect(created.itemId).toBeTruthy();
    itemId = created.itemId;
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a remind:1m tag starts a reminder due about a minute out', async () => {
    const before = Date.now();
    await publishCheck();

    await expect.poll(async () => (await readReminder())?.tag, { timeout: 15000 })
      .toBe('remind:1m');

    const reminder = (await readReminder())!;
    // The clock starts when the check first sees the tag, so dueAt sits a
    // minute from the publish, not from when the tag was added.
    expect(reminder.dueAt).toBeGreaterThanOrEqual(before + MINUTE);
    expect(reminder.dueAt).toBeLessThan(Date.now() + MINUTE + 5000);

    // Not due yet: the duration tag is still the only remind: tag.
    expect(await readTags()).toEqual(['remind:1m']);
  });

  test('a reminder whose dueAt has passed swaps its tag for remind:due', async () => {
    // Backdate through the datastore rather than waiting a real minute.
    const written = await bgWindow.evaluate(async (arg: { id: string; dueAt: number }) => {
      return await (window as any).app.datastore.updateItem(arg.id, {
        metadata: JSON.stringify({ reminder: { tag: 'remind:1m', dueAt: arg.dueAt } }),
      });
    }, { id: itemId, dueAt: Date.now() - MINUTE });
    expect(written.success).toBe(true);

    await publishCheck();

    await expect.poll(readTags, { timeout: 15000 }).toEqual(['remind:due']);

    // metadata.reminder is kept, so dueAt stays visible on the due item.
    const reminder = await readReminder();
    expect(reminder).toBeTruthy();
    expect(reminder!.tag).toBe('remind:1m');
  });

  test('the reminders command opens the search window on #remind:due', async () => {
    await app.evaluateMain!(((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('reminders');
    }) as any);

    const query = '#remind:due';
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
    expect(searchPage, 'search window for #remind:due not found').toBeTruthy();
    await searchPage!.waitForLoadState('domcontentloaded');

    await searchPage!.waitForSelector(`peek-card[data-item-id="${itemId}"]`, { timeout: 15000 });
  });
});
