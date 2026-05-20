/**
 * Regression coverage: typing `note buy milk #shopping #urgent` in the
 * cmd panel must extract `#shopping` and `#urgent` as tags on the new
 * text item. The user reported tags inside note bodies weren't picked
 * up; the fix lives in `syncContentHashtags` in datastore.ts (called
 * from addItem/updateItem). This guards against regressions if anyone
 * removes that call or breaks the regex.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('note flow: inline hashtag extraction @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('note-hashtag'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('addItem with hashtag content extracts tags', async () => {
    const stamp = Date.now();
    const tagA = `inline-shop-${stamp}`;
    const tagB = `inline-urge-${stamp}`;
    const content = `buy milk #${tagA} #${tagB}`;

    const addResult = await bgWindow.evaluate(async (c: string) => {
      return await (window as any).app.datastore.addItem('text', { content: c });
    }, content);
    expect(addResult.success).toBe(true);
    const itemId = addResult.data?.id;
    expect(itemId).toBeTruthy();

    // Tags should be applied synchronously by syncContentHashtags
    const tagsResult = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.getItemTags(id);
    }, itemId);
    expect(tagsResult.success).toBe(true);
    const names: string[] = (tagsResult.data || []).map((t: { name: string }) => t.name);
    expect(names).toContain(tagA);
    expect(names).toContain(tagB);
  });

  test('updateItem with new hashtag content extracts new tags', async () => {
    const stamp = Date.now();
    const tagInitial = `init-${stamp}`;
    const tagAdded = `added-${stamp}`;

    const addResult = await bgWindow.evaluate(async (c: string) => {
      return await (window as any).app.datastore.addItem('text', { content: c });
    }, `start #${tagInitial}`);
    expect(addResult.success).toBe(true);
    const itemId = addResult.data?.id;

    const updResult = await bgWindow.evaluate(async ({ id, c }: { id: string; c: string }) => {
      return await (window as any).app.datastore.updateItem(id, { content: c });
    }, { id: itemId, c: `start #${tagInitial}\nlater #${tagAdded}` });
    expect(updResult.success).toBe(true);

    const tagsResult = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.getItemTags(id);
    }, itemId);
    const names: string[] = (tagsResult.data || []).map((t: { name: string }) => t.name);
    expect(names).toContain(tagInitial);
    expect(names).toContain(tagAdded);
  });
});
