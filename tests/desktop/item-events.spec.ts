import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Item Events @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('item-events'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('item:created is emitted when item is added', async () => {
    const timestamp = Date.now();
    const testUrl = `https://item-created-event-${timestamp}.example.com`;

    const result = await bgWindow.evaluate(async (url: string) => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, error: 'timeout' });
        }, 5000);

        api.subscribe('item:created', (msg: any) => {
          if (msg.content === url) {
            clearTimeout(timeout);
            resolve({
              received: true,
              itemId: msg.itemId,
              itemType: msg.itemType,
              content: msg.content
            });
          }
        }, api.scopes.GLOBAL);

        // Create item to trigger the event
        api.datastore.addItem('url', {
          content: url,
          metadata: JSON.stringify({ title: 'Item Created Event Test' })
        });
      });
    }, testUrl);

    expect((result as any).received).toBe(true);
    expect((result as any).itemId).toBeTruthy();
    expect((result as any).itemType).toBe('url');
    expect((result as any).content).toBe(testUrl);
  });

  test('item:updated is emitted when item is updated', async () => {
    const timestamp = Date.now();

    const result = await bgWindow.evaluate(async (ts: number) => {
      const api = (window as any).app;

      // First create an item
      const itemResult = await api.datastore.addItem('url', {
        content: `https://item-updated-event-${ts}.example.com`,
        metadata: JSON.stringify({ title: 'Item Updated Event Test' })
      });
      if (!itemResult.success) {
        return { received: false, error: 'failed to create item' };
      }
      const itemId = itemResult.data.id;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, error: 'timeout' });
        }, 5000);

        api.subscribe('item:updated', (msg: any) => {
          if (msg.itemId === itemId) {
            clearTimeout(timeout);
            resolve({
              received: true,
              itemId: msg.itemId,
              itemType: msg.itemType
            });
          }
        }, api.scopes.GLOBAL);

        // Update item to trigger the event
        api.datastore.updateItem(itemId, {
          content: `https://item-updated-event-${ts}-modified.example.com`
        });
      });
    }, timestamp);

    expect((result as any).received).toBe(true);
    expect((result as any).itemId).toBeTruthy();
    expect((result as any).itemType).toBe('url');
  });

  test('item:deleted is emitted when item is deleted', async () => {
    const timestamp = Date.now();

    const result = await bgWindow.evaluate(async (ts: number) => {
      const api = (window as any).app;

      // First create an item
      const itemResult = await api.datastore.addItem('url', {
        content: `https://item-deleted-event-${ts}.example.com`,
        metadata: JSON.stringify({ title: 'Item Deleted Event Test' })
      });
      if (!itemResult.success) {
        return { received: false, error: 'failed to create item' };
      }
      const itemId = itemResult.data.id;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, error: 'timeout' });
        }, 5000);

        api.subscribe('item:deleted', (msg: any) => {
          if (msg.itemId === itemId) {
            clearTimeout(timeout);
            resolve({
              received: true,
              itemId: msg.itemId,
              itemType: msg.itemType
            });
          }
        }, api.scopes.GLOBAL);

        // Delete item to trigger the event
        api.datastore.deleteItem(itemId);
      });
    }, timestamp);

    expect((result as any).received).toBe(true);
    expect((result as any).itemId).toBeTruthy();
    expect((result as any).itemType).toBe('url');
  });
});
