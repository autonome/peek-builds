import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForWindowCount } from '../helpers/window-utils';

test.describe('Groups Navigation @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('groups-nav'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('groups to group to url and back navigation', async () => {
    // Create a tag/group with some items and promote it to a group
    const tagResult = await bgWindow.evaluate(async () => {
      const result = await (window as any).app.datastore.getOrCreateTag('test-group');
      if (result.success) {
        const tag = result.data.tag;
        let meta = {};
        try { meta = tag.metadata ? JSON.parse(tag.metadata) : {}; } catch {}
        meta.isGroup = true;
        await (window as any).app.datastore.setRow('tags', tag.id, { ...tag, metadata: JSON.stringify(meta) });
      }
      return result;
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id || tagResult.data?.data?.id || tagResult.data?.id;

    // Add URL items and tag them
    const item1 = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://group-test-1.example.com',
        metadata: JSON.stringify({ title: 'Group Test 1' })
      });
    });
    expect(item1.success).toBe(true);

    const item2 = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://group-test-2.example.com',
        metadata: JSON.stringify({ title: 'Group Test 2' })
      });
    });
    expect(item2.success).toBe(true);

    // Tag the items
    if (tagId && item1.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item1.data.id, tagId });
    }

    if (tagId && item2.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item2.data.id, tagId });
    }

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

    // Wait for cards to render
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    // Click on the test-group card
    const groupCard = await groupsWindow.$('peek-card.group-card[data-tag-id="' + tagId + '"]');
    if (!groupCard) {
      const anyGroupCard = await groupsWindow.$('peek-card.group-card');
      expect(anyGroupCard).toBeTruthy();
      await anyGroupCard!.click();
    } else {
      await groupCard.click();
    }

    // Wait for navigation to addresses view (address cards appear)
    await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });

    // Verify we're in addresses view by checking search placeholder
    const placeholderInGroup = await groupsWindow.evaluate(() => {
      const searchInput = document.querySelector('peek-input.search-input') as any;
      return searchInput ? searchInput.placeholder : null;
    });
    expect(placeholderInGroup).toContain('Search in');

    // Click on an address card
    const addressCard = await groupsWindow.$('peek-card.address-card');
    expect(addressCard).toBeTruthy();

    const windowCountBefore = app.windows().length;
    await addressCard!.click();

    // Wait for new window to open
    await waitForWindowCount(() => app.windows(), windowCountBefore + 1, 5000);

    // Verify a new window was opened
    const windowCountAfter = app.windows().length;
    expect(windowCountAfter).toBeGreaterThan(windowCountBefore);

    // Navigate back to groups view
    // Note: Playwright's keyboard.press('Escape') doesn't reliably trigger
    // Electron's before-input-event handler, so we call the navigation function directly
    await groupsWindow.evaluate(async () => {
      const showGroups = (window as any).showGroups;
      if (showGroups) {
        await showGroups();
      }
    });

    // Small delay for async operations
    await new Promise(resolve => setTimeout(resolve, 100));

    // Wait for groups view (group cards appear, address cards disappear)
    await groupsWindow.waitForSelector('peek-card.group-card', { timeout: 5000 });

    // Verify we're back in groups view by checking search placeholder
    const placeholderInGroups = await groupsWindow.evaluate(() => {
      const searchInput = document.querySelector('peek-input.search-input') as any;
      return searchInput ? searchInput.placeholder : null;
    });
    expect(placeholderInGroups).toBe('Search groups...');

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

    // Verify items can be retrieved by tag
    if (tagId) {
      const taggedItems = await bgWindow.evaluate(async (tId: string) => {
        return await (window as any).app.datastore.getItemsByTag(tId);
      }, tagId);
      expect(taggedItems.success).toBe(true);
      expect(taggedItems.data.length).toBeGreaterThanOrEqual(2);
    }
  });
});
