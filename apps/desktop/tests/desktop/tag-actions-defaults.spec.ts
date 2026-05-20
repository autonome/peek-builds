/**
 * Tag Action Defaults — out-of-the-box affordance rendering.
 *
 * Regression for: in a fresh profile, `cmd: #todo` opens
 * search/home but no card shows a toggle affordance because no
 * tag-swap rule has been registered yet (the lazy tag-actions home
 * tile never opened to seed defaults).
 *
 * This spec deliberately does NOT pre-seed a rule. It relies on the
 * tag-actions feature shipping default tag-swap rules (todo/done,
 * readme/read) via its manifest's `rules` block — so they reconcile
 * into the rules table at boot and are visible to the affordance lib
 * without any UI ever loading.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Tag Action Defaults @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-actions-defaults'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('default tag-swap rule for todo/done is registered at boot (no UI seed needed)', async () => {
    const affordances = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const res = await api.rules.listAffordances();
      return res?.rules ?? [];
    });

    const todoSwap = affordances.find(
      (r: any) => r.scriptId === 'tag-swap'
        && r.config?.activeTag === 'todo'
        && r.config?.completedTag === 'done',
    );
    expect(
      todoSwap,
      'a default tag-swap rule for todo/done must be registered at boot — '
      + 'otherwise the affordance never renders on cards (`cmd #todo` shows no checkbox).',
    ).toBeTruthy();

    // Display block must be populated — listAffordances filters out empty
    // displays and the card UI uses these fields directly.
    expect(todoSwap.display).toBeTruthy();
    expect(todoSwap.display.icon).toBe('unchecked');
    expect(todoSwap.display.checkedIcon).toBe('checked');
  });

  test('toggle renders on tags/home for todo-tagged item (no pre-seed)', async () => {
    const ts = Date.now();
    const testUri = `https://tag-actions-default-render-${ts}.example.com/`;

    const setup = await bgWindow.evaluate(async (uri: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      const item = await api.datastore.addItem('url', {
        content: uri,
        metadata: JSON.stringify({ title: 'tag-actions defaults render test' })
      });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);
      return { itemId: item.data.id };
    }, testUri);
    expect(setup.itemId).toBeTruthy();

    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://tags/home.html', {
        width: 900, height: 700, key: 'tags-defaults-test'
      });
    });
    expect(open.success).toBe(true);

    const tagsWindow = await app.getWindow('tags/home.html', 10000);
    expect(tagsWindow).toBeTruthy();
    await tagsWindow.waitForLoadState('domcontentloaded');

    const cardSelector = `peek-card[data-item-id="${setup.itemId}"]`;
    await tagsWindow.waitForSelector(cardSelector, { timeout: 10000 });
    const toggleSelector = `${cardSelector} .tag-action-affordances .tag-action-toggle`;
    await tagsWindow.waitForSelector(toggleSelector, { timeout: 10000 });

    const exists = await tagsWindow.$$eval(toggleSelector, (els) => els.length);
    expect(exists).toBeGreaterThanOrEqual(1);

    if (open.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, open.id);
      } catch { /* may already be closed */ }
    }
  });
});
