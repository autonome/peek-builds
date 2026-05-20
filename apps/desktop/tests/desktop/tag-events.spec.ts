import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Tag Events @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tag-events'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('tag:created is emitted when new tag is created', async () => {
    const timestamp = Date.now();
    const tagName = `event-test-tag-${timestamp}`;

    const result = await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false });
        }, 5000);

        api.subscribe('tag:created', (msg: any) => {
          if (msg.tagName === name) {
            clearTimeout(timeout);
            resolve({
              received: true,
              tagId: msg.tagId,
              tagName: msg.tagName
            });
          }
        });

        // Create new tag to trigger the event
        api.datastore.getOrCreateTag(name);
      });
    }, tagName);

    expect((result as any).received).toBe(true);
    expect((result as any).tagName).toBe(tagName);
    expect((result as any).tagId).toBeTruthy();
  });

  test('tag:item-added is emitted when item is tagged', async () => {
    const timestamp = Date.now();
    const tagName = `item-added-event-tag-${timestamp}`;

    const result = await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;

      // First create an item and a tag
      const itemResult = await api.datastore.addItem('url', {
        content: `https://tag-event-test-${Date.now()}.example.com`,
        metadata: JSON.stringify({ title: 'Tag Event Test Item' })
      });
      if (!itemResult.success) {
        return { received: false, error: 'failed to create item' };
      }
      const itemId = itemResult.data.id;

      const tagResult = await api.datastore.getOrCreateTag(name);
      if (!tagResult.success) {
        return { received: false, error: 'failed to create tag' };
      }
      const tagId = tagResult.data.tag.id;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, error: 'timeout' });
        }, 5000);

        api.subscribe('tag:item-added', (msg: any) => {
          if (msg.itemId === itemId && msg.tagId === tagId) {
            clearTimeout(timeout);
            resolve({
              received: true,
              tagId: msg.tagId,
              tagName: msg.tagName,
              itemId: msg.itemId,
              itemType: msg.itemType
            });
          }
        });

        // Tag the item to trigger the event
        api.datastore.tagItem(itemId, tagId);
      });
    }, tagName);

    expect((result as any).received).toBe(true);
    expect((result as any).tagName).toBe(tagName);
    expect((result as any).tagId).toBeTruthy();
    expect((result as any).itemId).toBeTruthy();
    expect((result as any).itemType).toBe('url');
  });

  test('tag:item-removed is emitted when item is untagged', async () => {
    const timestamp = Date.now();
    const tagName = `item-removed-event-tag-${timestamp}`;

    const result = await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;

      // Create an item
      const itemResult = await api.datastore.addItem('url', {
        content: `https://untag-event-test-${Date.now()}.example.com`,
        metadata: JSON.stringify({ title: 'Untag Event Test Item' })
      });
      if (!itemResult.success) {
        return { received: false, error: 'failed to create item' };
      }
      const itemId = itemResult.data.id;

      // Create a tag
      const tagResult = await api.datastore.getOrCreateTag(name);
      if (!tagResult.success) {
        return { received: false, error: 'failed to create tag' };
      }
      const tagId = tagResult.data.tag.id;

      // Tag the item first
      await api.datastore.tagItem(itemId, tagId);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, error: 'timeout' });
        }, 5000);

        api.subscribe('tag:item-removed', (msg: any) => {
          if (msg.itemId === itemId && msg.tagId === tagId) {
            clearTimeout(timeout);
            resolve({
              received: true,
              tagId: msg.tagId,
              tagName: msg.tagName,
              itemId: msg.itemId
            });
          }
        });

        // Untag the item to trigger the event
        api.datastore.untagItem(itemId, tagId);
      });
    }, tagName);

    expect((result as any).received).toBe(true);
    expect((result as any).tagName).toBe(tagName);
    expect((result as any).tagId).toBeTruthy();
    expect((result as any).itemId).toBeTruthy();
  });

  test('tag:item-added is NOT emitted for duplicate tag', async () => {
    const timestamp = Date.now();
    const tagName = `duplicate-tag-event-${timestamp}`;

    const result = await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;

      // Create an item
      const itemResult = await api.datastore.addItem('url', {
        content: `https://duplicate-tag-test-${Date.now()}.example.com`,
        metadata: JSON.stringify({ title: 'Duplicate Tag Test Item' })
      });
      if (!itemResult.success) {
        return { received: false, error: 'failed to create item' };
      }
      const itemId = itemResult.data.id;

      // Create a tag
      const tagResult = await api.datastore.getOrCreateTag(name);
      if (!tagResult.success) {
        return { received: false, error: 'failed to create tag' };
      }
      const tagId = tagResult.data.tag.id;

      // Tag the item for the first time (this should emit an event but we don't care)
      await api.datastore.tagItem(itemId, tagId);

      // Wait a bit to ensure the first event has been processed
      await new Promise(r => setTimeout(r, 100));

      return new Promise((resolve) => {
        // Use a short timeout since we expect NO event
        const timeout = setTimeout(() => {
          resolve({ received: false }); // This is the expected outcome
        }, 1000);

        api.subscribe('tag:item-added', (msg: any) => {
          if (msg.itemId === itemId && msg.tagId === tagId) {
            clearTimeout(timeout);
            resolve({ received: true }); // This would be unexpected
          }
        });

        // Try to tag the same item with the same tag again
        api.datastore.tagItem(itemId, tagId);
      });
    }, tagName);

    // We expect NO event to be received for duplicate tagging
    expect((result as any).received).toBe(false);
  });
});
