/**
 * Cross-window reactivity for search/home.
 *
 * The user-reported bug: cmd #todo opens search window A with one
 * result, cmd #done opens search window B with zero, clicking the
 * toggle on A correctly removes the item from A but does NOT make
 * it appear on B (the new tag matches B's query).
 *
 * The previous specs proved:
 *   - rule engine wiring is deterministic
 *   - affordance:click → bg-tile swap → tag:item-added/removed fires
 *
 * So the bug must live in the consumer-window layer — either tag
 * events don't reach a second open window, or the second window's
 * `debouncedRefresh` / `runSearch` path doesn't pick the new item up.
 *
 * This spec opens both windows directly (mimicking what
 * `panel.js:openSearch` does on cmd Enter for an all-hashtag query),
 * then drives a real affordance:click and asserts each window
 * converges to the right card set.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

test.describe('Search cross-window reactivity @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('search-cross-window'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('checking todo on window A makes item appear on the #done window B', async () => {
    const ts = Date.now();
    const testUri = `https://search-cross-window-${ts}.example.com/`;

    // Seed: item tagged `todo`, look up the manifest tag-swap rule.
    const setup = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      await api.datastore.getOrCreateTag('done');
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'cross-window test' }),
      });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);

      const aff = await api.rules.listAffordances();
      const rule = aff.rules.find((r: any) =>
        r.scriptId === 'tag-swap'
        && r.config?.activeTag === 'todo'
        && r.config?.completedTag === 'done',
      );
      return { itemId: item.data.id, ruleId: rule?.id ?? null };
    }, testUri);
    expect(setup.itemId).toBeTruthy();
    expect(setup.ruleId).toBeTruthy();

    // Mimic `panel.js:openSearch`: open search/home twice, once per
    // tag, NO `key` (so they're separate renderers and don't collapse
    // onto each other). Two distinct `q` params produce two distinct
    // result sets.
    const openA = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open(
        'peek://search/home.html?q=%23todo',
        { role: 'workspace', width: 700, height: 768 },
      );
    });
    expect(openA.success).toBe(true);

    const openB = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open(
        'peek://search/home.html?q=%23done',
        { role: 'workspace', width: 700, height: 768 },
      );
    });
    expect(openB.success).toBe(true);

    // Resolve both windows. We need to disambiguate by the `q` param
    // since both URLs share the search/home.html prefix.
    const findByQuery = (q: string): Page | undefined =>
      app.windows().find(p => p.url().includes('search/home.html')
        && decodeURIComponent(p.url()).includes(`q=${q}`));

    let windowTodo = findByQuery('#todo');
    let windowDone = findByQuery('#done');

    // Windows may not be in the initial snapshot — wait briefly.
    const pollDeadline = Date.now() + 5000;
    while ((!windowTodo || !windowDone) && Date.now() < pollDeadline) {
      await new Promise(r => setTimeout(r, 100));
      windowTodo = findByQuery('#todo');
      windowDone = findByQuery('#done');
    }

    expect(windowTodo, 'search window for #todo not found').toBeTruthy();
    expect(windowDone, 'search window for #done not found').toBeTruthy();

    await windowTodo!.waitForLoadState('domcontentloaded');
    await windowDone!.waitForLoadState('domcontentloaded');

    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;

    // Initial state: item shows on the #todo window, not on #done.
    await windowTodo!.waitForSelector(cardSelector, { timeout: 10000 });
    const initialOnTodo = await windowTodo!.$$eval(cardSelector, els => els.length);
    expect(initialOnTodo).toBe(1);

    const initialOnDone = await windowDone!.$$eval(cardSelector, els => els.length);
    expect(initialOnDone, '#done window should not show the item initially').toBe(0);

    // Instrumentation: count tag events that each search window
    // actually receives. If neither sees the events, the bug is in
    // event delivery to renderers. If both see them but the cards
    // don't update, the bug is in their re-render path.
    for (const w of [windowTodo!, windowDone!]) {
      await w.evaluate(() => {
        const wnd: any = window;
        wnd.__tagEventLog = { added: [], removed: [] };
        wnd.app.pubsub.subscribe('tag:item-added', (m: any) => wnd.__tagEventLog.added.push(m));
        wnd.app.pubsub.subscribe('tag:item-removed', (m: any) => wnd.__tagEventLog.removed.push(m));
      });
    }

    // Trigger the swap by publishing affordance:click as if the user
    // had clicked the toggle on #todo. Going from unchecked → checked
    // means: remove `todo`, add `done`.
    await bgWindow.evaluate(async (payload: any) => {
      (window as any).app.pubsub.publish('affordance:click', payload);
    }, {
      ruleId: setup.ruleId,
      itemId: setup.itemId,
      checked: true,
      activeTag: 'todo',
      completedTag: 'done',
    });

    // Step 1: confirm the DB swap actually landed. If this fails the
    // bug is in the bg-tile / datastore path (already covered by
    // affordance-tag-swap.spec.ts — would be a regression).
    await expect.poll(
      async () => bgWindow.evaluate(async (id: string) => {
        const r = await (window as any).app.datastore.getItemTags(id);
        return r.success ? r.data.map((t: any) => t.name).sort() : [];
      }, setup.itemId),
      { timeout: 8000, message: 'tag swap must land in DB before we can assert UI' },
    ).toEqual(['done']);

    // Step 2: each search window should reflect the new DB state.
    // The runSearch debounce on each window is 150ms; allow a
    // generous timeout here so any flakiness shows up as a clean
    // assertion failure rather than a 30s hang.
    // Both windows must receive the tag events. The previous bug
    // was that pubsub broadcast iterated a Map<tileId:entryId,
    // BrowserWindow> in tile-launcher, so opening a second window
    // for the same tile entry overwrote the first — only the
    // second would receive any event.
    await expect.poll(
      async () => windowTodo!.evaluate(() => ({
        added: (window as any).__tagEventLog.added.length,
        removed: (window as any).__tagEventLog.removed.length,
      })),
      { timeout: 5000, message: '#todo window must receive tag events' },
    ).toEqual({ added: 1, removed: 1 });

    await expect.poll(
      async () => windowDone!.evaluate(() => ({
        added: (window as any).__tagEventLog.added.length,
        removed: (window as any).__tagEventLog.removed.length,
      })),
      { timeout: 5000, message: '#done window must receive tag events' },
    ).toEqual({ added: 1, removed: 1 });

    await expect.poll(
      async () => windowTodo!.$$eval(cardSelector, els => els.length),
      { timeout: 8000, message: '#todo window should remove the card after the swap' },
    ).toBe(0);

    await expect.poll(
      async () => windowDone!.$$eval(cardSelector, els => els.length),
      { timeout: 8000, message: '#done window should show the card after the swap' },
    ).toBe(1);

    // Cleanup
    for (const id of [openA.id, openB.id]) {
      if (!id) continue;
      try {
        await bgWindow.evaluate(async (winId: number) => {
          return await (window as any).app.window.close(winId);
        }, id);
      } catch { /* may already be closed */ }
    }
  });
});
