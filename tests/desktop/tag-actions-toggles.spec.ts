/**
 * Tag Action Toggles — render + click coverage across consumer tiles.
 *
 * Stage 3 of peek MCP plan 3d7d9239: tag-actions migrated from a
 * resident extension serving `tag-actions:*` pubsub queries into the
 * rule engine. Pairs are now rules (`topic: 'affordance:click'`,
 * `scriptId: 'tag-swap'`); the card UI reads them via
 * `api.rules.listAffordances()` and publishes `affordance:click` on
 * user interaction; the rule engine routes that to
 * `scripts:execute:tag-swap`, which the lazy tag-actions background
 * tile handles.
 *
 * Tests:
 *   1. tags/home — full pipeline: register a tag-swap rule, render a
 *      todo-tagged item, click toggle, verify tags swapped.
 *   2-3. groups/pagestream — gate-permits round-trip: each consumer
 *      can call api.rules.listAffordances and see the registered rule.
 *   4. search — static manifest assertion (workspace-key collapse
 *      blocks a fresh runtime test there; manifest grant is what
 *      matters for the gate).
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Tag Action Toggles @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-action-toggles'));

    // Seed a tag-swap rule so the affordance renders. The bg window
    // is a core renderer (trustedBuiltin) so api.rules.* bypasses the
    // per-feature capability check.
    await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      await api.rules.register({
        id: 'todo-done-test',
        topic: 'affordance:click',
        scriptId: 'tag-swap',
        match: { activeTag: 'todo', completedTag: 'done' },
        config: { activeTag: 'todo', completedTag: 'done' },
        display: {
          icon: 'unchecked',
          checkedIcon: 'checked',
          color: '#007aff',
          checkedColor: '#34c759',
          iconPair: 'checkbox',
        },
        enabled: true,
      });
    });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /**
   * Cross-feature read: any consumer with the rules capability can
   * see every enabled rule with a non-empty display block.
   */
  async function fetchAffordanceRules(window: Page): Promise<{ success: boolean; data: any }> {
    return await window.evaluate(async () => {
      const api = (window as any).app;
      try {
        const res = await api.rules.listAffordances();
        return { success: !!(res && Array.isArray(res.rules)), data: res?.rules ?? null };
      } catch (err: any) {
        return { success: false, data: null, error: err?.message };
      }
    });
  }

  test('toggle renders on tags/home and click swaps todo → done', async () => {
    const ts = Date.now();
    const testUri = `https://tag-actions-toggle-test-${ts}.example.com/`;

    // Create the test item tagged `todo`.
    const setup = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      const done = await api.datastore.getOrCreateTag('done');
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'tag-actions toggle test' })
      });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);
      return {
        itemId: item.data.id,
        todoTagId: todo.data.tag.id,
        doneTagId: done.data.tag.id
      };
    }, testUri);
    expect(setup.itemId).toBeTruthy();

    // Open tags/home.
    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://tags/home.html', {
        width: 900, height: 700, key: 'tags-toggle-test'
      });
    });
    expect(open.success).toBe(true);

    const tagsWindow = await app.getWindow('tags/home.html', 10000);
    expect(tagsWindow).toBeTruthy();
    await tagsWindow.waitForLoadState('domcontentloaded');

    // Wait for the card and its toggle affordance to render.
    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;
    await tagsWindow.waitForSelector(cardSelector, { timeout: 10000 });
    const toggleSelector = `${cardSelector} .tag-action-affordances .tag-action-toggle`;
    await tagsWindow.waitForSelector(toggleSelector, { timeout: 10000 });

    // Initial state: not checked (item has `todo`, not `done`).
    const initialChecked = await tagsWindow.$eval(toggleSelector, (el) =>
      el.classList.contains('checked')
    );
    expect(initialChecked).toBe(false);

    // Click toggle — publishes affordance:click → rule engine routes to
    // scripts:execute:tag-swap → tag-actions background tile loads
    // (lazyEvents) → runs the swap.
    await tagsWindow.click(toggleSelector);

    // Optimistic visual flip is immediate; datastore round-trip is async.
    await tagsWindow.waitForFunction(
      (sel) => {
        const btn = document.querySelector(sel) as HTMLElement | null;
        return btn?.classList.contains('checked');
      },
      toggleSelector,
      { timeout: 5000 }
    );

    // Verify datastore: item now has `done`, not `todo`. The lazy bg
    // tile boot can take a moment on cold start.
    await expect.poll(async () => {
      return await bgWindow.evaluate(async (itemId: string) => {
        const result = await (window as any).app.datastore.getItemTags(itemId);
        return result.success ? result.data.map((t: any) => t.name) : null;
      }, setup.itemId);
    }, { timeout: 10000 }).toEqual(expect.arrayContaining(['done']));

    const tagsAfter = await bgWindow.evaluate(async (itemId: string) => {
      const result = await (window as any).app.datastore.getItemTags(itemId);
      return result.success ? result.data.map((t: any) => t.name) : null;
    }, setup.itemId);
    expect(tagsAfter).toContain('done');
    expect(tagsAfter).not.toContain('todo');

    if (open.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, open.id);
      } catch { /* may already be closed */ }
    }
  });

  test('groups/home gate permits api.rules.listAffordances round-trip', async () => {
    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 800, height: 600, key: 'groups-tag-actions-test'
      });
    });
    expect(open.success).toBe(true);

    const groupsWindow = await app.getWindow('groups/home.html', 10000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');

    const response = await fetchAffordanceRules(groupsWindow);
    expect(response.success).toBe(true);
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.length).toBeGreaterThan(0);

    if (open.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, open.id);
      } catch { /* may already be closed */ }
    }
  });

  test('search manifest declares the rules capability + affordance topics', async () => {
    // Static manifest check — search/home has a separate, pre-existing
    // workspace-key quirk (its key collapses opens) that blocks a runtime
    // round-trip from a fresh test window. The manifest-level grant is
    // what matters for the gate; the gate logic is identical to the
    // runtime-tested groups/pagestream.
    const manifest = await bgWindow.evaluate(async () => {
      const res = await fetch('peek://search/manifest.json');
      return await res.json();
    });
    const topics = manifest?.capabilities?.pubsub?.topics ?? [];
    expect(topics).toContain('affordance:click');
    expect(topics).toContain('rules:changed');
    expect(manifest?.capabilities?.rules).toBe(true);
  });

  test('pagestream/home gate permits api.rules.listAffordances round-trip', async () => {
    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://pagestream/home.html', {
        width: 600, height: 800, key: 'pagestream-tag-actions-test'
      });
    });
    expect(open.success).toBe(true);

    const psWindow = await app.getWindow('pagestream/home.html', 10000);
    expect(psWindow).toBeTruthy();
    await psWindow.waitForLoadState('domcontentloaded');

    const response = await fetchAffordanceRules(psWindow);
    expect(response.success).toBe(true);
    expect(Array.isArray(response.data)).toBe(true);
    expect(response.data.length).toBeGreaterThan(0);

    if (open.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, open.id);
      } catch { /* may already be closed */ }
    }
  });
});
