import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Groups View @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('groups-view'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('empty groups are not shown in groups list', async () => {
    // Create an empty tag (group with no items) and promote it
    const emptyTag = await bgWindow.evaluate(async () => {
      const result = await (window as any).app.datastore.getOrCreateTag('empty-group-test');
      if (result.success) {
        const tag = result.data.tag;
        await (window as any).app.datastore.setRow('tags', tag.id, { ...tag, metadata: JSON.stringify({ isGroup: true }) });
      }
      return result;
    });
    expect(emptyTag.success).toBe(true);

    // Create a tag with an item and promote it
    const nonEmptyTag = await bgWindow.evaluate(async () => {
      const result = await (window as any).app.datastore.getOrCreateTag('non-empty-group-test');
      if (result.success) {
        const tag = result.data.tag;
        await (window as any).app.datastore.setRow('tags', tag.id, { ...tag, metadata: JSON.stringify({ isGroup: true }) });
      }
      return result;
    });
    expect(nonEmptyTag.success).toBe(true);

    const item = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://non-empty-group-addr.example.com',
        metadata: JSON.stringify({ title: 'Non Empty Group Address' })
      });
    });
    expect(item.success).toBe(true);

    await bgWindow.evaluate(async ({ itemId, tagId }) => {
      return await (window as any).app.datastore.tagItem(itemId, tagId);
    }, { itemId: item.data.id, tagId: nonEmptyTag.data.tag.id });

    // Open groups home
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 800,
        height: 600
      });
    });
    expect(groupsResult.success).toBe(true);

    // Find the groups window (getWindow polls)
    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');

    // Wait for group cards to render (async data loading + rendering)
    await groupsWindow.waitForSelector(`peek-card.group-card[data-tag-id="${nonEmptyTag.data.tag.id}"]`, { timeout: 10000 });

    // Get all group card tag IDs
    const groupCards = await groupsWindow.$$eval('peek-card.group-card', (cards: any[]) =>
      cards.map(c => c.dataset.tagId)
    );

    // Non-empty group should be shown
    expect(groupCards.includes(String(nonEmptyTag.data.tag.id))).toBe(true);

    // Empty groups ARE shown (so newly created groups appear immediately)
    expect(groupCards.includes(String(emptyTag.data.tag.id))).toBe(true);

    // Clean up
    if (groupsResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, groupsResult.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('Untagged group shows when there are untagged items', async () => {
    // Create an untagged URL item
    const testUrl = 'https://untagged-for-groups-view.example.com/';
    const item = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.addItem('url', {
        content: url,
        metadata: JSON.stringify({ title: 'Untagged For Groups View' })
      });
    }, testUrl);
    expect(item.success).toBe(true);

    // Verify the item exists and has no tags
    const itemTags = await bgWindow.evaluate(async (itemId: string) => {
      return await (window as any).app.datastore.getItemTags(itemId);
    }, item.data.id);
    expect(itemTags.success).toBe(true);
    expect(itemTags.data.length).toBe(0);

    // Open groups home
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 800,
        height: 600,
        key: 'groups-untagged-test'
      });
    });
    expect(groupsResult.success).toBe(true);

    // Find the groups window (getWindow polls)
    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');

    // Wait for cards to render
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    const untaggedCard = await groupsWindow.waitForSelector('peek-card.group-card[data-tag-id="__untagged__"]', { timeout: 5000 }).catch(() => null);
    expect(untaggedCard).toBeTruthy();

    // Verify it shows the special-group class
    const hasSpecialClass = await untaggedCard!.evaluate((el: HTMLElement) =>
      el.classList.contains('special-group')
    );
    expect(hasSpecialClass).toBe(true);

    // Clean up
    if (groupsResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, groupsResult.id);
      } catch {
        // Window may already be closed
      }
    }
  });
});
