/**
 * affordance:click → bg-tile swap → tag:item-* events.
 *
 * The previous spec (rule-engine-wiring) proved the rule engine
 * itself is sound. This spec adds the next layer: a real
 * affordance:click publish goes through the engine, the lazy
 * tag-actions background tile loads on its lazyEvent
 * (`scripts:execute:tag-swap`), runs the swap against the datastore,
 * and the datastore IPC publishes `tag:item-added` / `tag:item-removed`.
 *
 * Assertions per toggle:
 *   - tag:item-removed fires for the outgoing tag
 *   - tag:item-added fires for the incoming tag
 *   - the DB tag set on the item matches expectation
 *
 * Repeats N times to surface any race in lazy-tile load (cold-start
 * happens on the first click; subsequent clicks should reuse the
 * loaded tile) or in the datastore-publish path.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';

const TOGGLES = 10;

test.describe('Affordance → tag-swap → tag events @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('affordance-tag-swap'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test(`${TOGGLES} affordance:click toggles flip tags + emit tag events deterministically`, async () => {
    const ts = Date.now();
    const testUri = `https://affordance-swap-${ts}.example.com/`;

    // Setup: item tagged `todo`, look up the manifest default
    // tag-swap rule for todo/done. Also start collecting tag events
    // as soon as the bg window is ready.
    const setup = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      const done = await api.datastore.getOrCreateTag('done');
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'affordance-tag-swap' }),
      });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);

      const aff = await api.rules.listAffordances();
      const rule = aff.rules.find((r: any) =>
        r.scriptId === 'tag-swap'
        && r.config?.activeTag === 'todo'
        && r.config?.completedTag === 'done',
      );

      // Buffer every relevant tag event for later inspection.
      const w: any = window;
      w.__tagEvents = { added: [] as any[], removed: [] as any[] };
      api.pubsub.subscribe('tag:item-added', (msg: any) => {
        if (msg?.itemId === item.data.id) w.__tagEvents.added.push({ ...msg, ts: Date.now() });
      });
      api.pubsub.subscribe('tag:item-removed', (msg: any) => {
        if (msg?.itemId === item.data.id) w.__tagEvents.removed.push({ ...msg, ts: Date.now() });
      });

      return {
        itemId: item.data.id,
        ruleId: rule?.id ?? null,
      };
    }, testUri);
    expect(setup.itemId).toBeTruthy();
    expect(setup.ruleId, 'manifest default tag-swap rule must be present').toBeTruthy();

    async function tagsOnItem(): Promise<string[]> {
      return await bgWindow.evaluate(async (id: string) => {
        const r = await (window as any).app.datastore.getItemTags(id);
        return r.success ? r.data.map((t: any) => t.name).sort() : [];
      }, setup.itemId);
    }

    async function publishClick(checked: boolean): Promise<void> {
      await bgWindow.evaluate(async (payload: any) => {
        (window as any).app.pubsub.publish('affordance:click', payload);
      }, {
        ruleId: setup.ruleId,
        itemId: setup.itemId,
        checked,
        activeTag: 'todo',
        completedTag: 'done',
      });
    }

    async function eventCounts(): Promise<{ added: number; removed: number }> {
      return await bgWindow.evaluate(() => ({
        added: (window as any).__tagEvents.added.length,
        removed: (window as any).__tagEvents.removed.length,
      }));
    }

    // Sanity: starting state.
    expect(await tagsOnItem()).toEqual(['todo']);
    let prev = await eventCounts();

    for (let i = 0; i < TOGGLES; i++) {
      const checking = (i % 2 === 0); // even: todo→done, odd: done→todo
      const expected = checking ? ['done'] : ['todo'];

      await publishClick(checking);

      // Wait until BOTH the DB and the event counters reflect this
      // toggle. We expect exactly one new tag:item-added and one new
      // tag:item-removed per click.
      const wantAdded = prev.added + 1;
      const wantRemoved = prev.removed + 1;

      const deadline = Date.now() + 8000;
      let lastTags: string[] = [];
      let lastCounts = prev;
      while (Date.now() < deadline) {
        lastTags = await tagsOnItem();
        lastCounts = await eventCounts();
        const tagsMatch = lastTags.length === expected.length
          && lastTags.every((t, idx) => t === expected[idx]);
        if (tagsMatch && lastCounts.added >= wantAdded && lastCounts.removed >= wantRemoved) break;
        await new Promise(r => setTimeout(r, 50));
      }

      expect(
        lastTags,
        `toggle #${i + 1} (${checking ? 'todo→done' : 'done→todo'}): DB tags wrong`,
      ).toEqual(expected);
      expect(
        lastCounts.added,
        `toggle #${i + 1}: expected ${wantAdded} tag:item-added events, got ${lastCounts.added}`,
      ).toBe(wantAdded);
      expect(
        lastCounts.removed,
        `toggle #${i + 1}: expected ${wantRemoved} tag:item-removed events, got ${lastCounts.removed}`,
      ).toBe(wantRemoved);

      prev = lastCounts;
    }

    // Final cross-check: the sequence of tag names in the events
    // matches the toggle sequence. Even iterations remove `todo` and
    // add `done`; odd iterations remove `done` and add `todo`.
    const events = await bgWindow.evaluate(() => ({
      added: (window as any).__tagEvents.added.map((e: any) => e.tagName),
      removed: (window as any).__tagEvents.removed.map((e: any) => e.tagName),
    }));
    const expectedAdded = Array.from({ length: TOGGLES }, (_, i) => i % 2 === 0 ? 'done' : 'todo');
    const expectedRemoved = Array.from({ length: TOGGLES }, (_, i) => i % 2 === 0 ? 'todo' : 'done');
    expect(events.added).toEqual(expectedAdded);
    expect(events.removed).toEqual(expectedRemoved);
  });
});
