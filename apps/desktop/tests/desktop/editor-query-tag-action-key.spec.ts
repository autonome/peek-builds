/**
 * Tag-query view: pressing `x` on the selected #todo block runs the todo tag
 * action, the same as clicking the checkbox in the block's left column. The tag
 * swap happens through the normal cycle (affordance:click -> tag-swap script ->
 * datastore), and the block leaves the #todo list through the live update.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Editor query view tag action key @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('editor-query-tag-key'));
    await bgWindow.evaluate(async () => {
      await (window as any).app.rules.register({
        id: 'todo-done-key-test',
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
          key: 'x',
        },
        enabled: true,
      });
    });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('x on a selected todo block swaps todo for done and the block leaves', async () => {
    const stamp = Date.now();
    const itemId: string = await bgWindow.evaluate(async (text: string) => {
      const api = (window as any).app;
      const todo = await api.datastore.getOrCreateTag('todo');
      const item = await api.datastore.addItem('text', { content: text });
      await api.datastore.tagItem(item.data.id, todo.data.tag.id);
      return item.data.id;
    }, `key test ${stamp}`);
    expect(itemId).toBeTruthy();

    const open = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://editor/home.html?tags=todo', {
        width: 900, height: 700, key: 'editor-query-tag-key',
      });
    });
    expect(open.success).toBe(true);

    const win = await app.getWindow('editor/home.html', 10000);
    await win.waitForLoadState('domcontentloaded');

    // The block renders with its checkbox, unchecked; the first block is selected.
    const toggle = '.qs-block-left .tag-action-toggle';
    await win.waitForSelector(toggle, { timeout: 10000 });
    expect(await win.$eval(toggle, el => el.classList.contains('checked'))).toBe(false);
    const blocks = win.locator('.qs-block');
    await expect(blocks).toHaveCount(1);

    await win.keyboard.press('x');

    // The datastore sees the swap...
    await expect.poll(async () => {
      return await bgWindow.evaluate(async (id: string) => {
        const res = await (window as any).app.datastore.getItemTags(id);
        return res.success ? res.data.map((t: any) => t.name).sort() : null;
      }, itemId);
    }, { timeout: 10000 }).toEqual(['done']);

    // ...and the block is gone from the #todo list through the live update.
    await expect(blocks).toHaveCount(0, { timeout: 10000 });

    try {
      await bgWindow.evaluate(async (id: number) => (window as any).app.window.close(id), open.id);
    } catch { /* may already be closed */ }
  });
});
