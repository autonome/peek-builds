/**
 * Regression coverage: items with stuck title="Loading..." get rewritten
 * to the URL hostname on the fly via the entities flow (already landed)
 * AND via the one-shot migration on app boot for already-stored rows.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Loading title residual @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('loading-title-backfill'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('updateItemTitle replaces stuck Loading... with a real title', async () => {
    // Seed a URL item with the literal "Loading..." title.
    const seededUrl = `https://load-test-${Date.now()}.example.com/page`;
    const add = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.addItem('url', {
        content: url,
        title: 'Loading...',
      });
    }, seededUrl);
    expect(add.success).toBe(true);
    const itemId = add.data?.id;

    const replaced = await bgWindow.evaluate(async ({ url }: { url: string }) => {
      return await (window as any).app.datastore.updateItemTitle(url, 'Real Title');
    }, { url: seededUrl });
    expect(replaced.success).toBe(true);

    const fetched = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.getItem(id);
    }, itemId);
    expect(fetched.data?.title).toBe('Real Title');
  });
});
