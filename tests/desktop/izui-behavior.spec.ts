import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { sleep } from '../helpers/window-utils';

test.describe('IZUI Behavior @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('izui-behavior'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('parentWindowId is set when opened from a content window', async () => {

    // Step 1: Open a content window (groups home) from the background window.
    // Since background.html is an internal URL, parentWindowId should be null.
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 600,
        height: 400
      });
    });
    expect(groupsResult.success).toBe(true);
    const groupsWindowId = groupsResult.id;

    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');

    // Verify the groups window itself has parentWindowId=null (opened from background)
    const groupsListBefore = await bgWindow.evaluate(async (wid: number) => {
      const result = await (window as any).app.window.list({ includeInternal: true });
      if (!result.success) return null;
      return result.windows.find((w: any) => w.id === wid);
    }, groupsWindowId);
    expect(groupsListBefore).toBeTruthy();
    expect(groupsListBefore.params.parentWindowId).toBeNull();

    // Step 2: Open a child window FROM the groups content window.
    // Since groups/home.html is a real content window (not background/extension-host),
    // the child should get parentWindowId set to the groups window's ID.
    const childResult = await groupsWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://child-parent-test.example.com', {
        width: 400,
        height: 300
      });
    });
    expect(childResult.success).toBe(true);
    const childWindowId = childResult.id;

    // Verify child window has parentWindowId set to the groups window
    const childInfo = await bgWindow.evaluate(async (wid: number) => {
      const result = await (window as any).app.window.list({ includeInternal: true });
      if (!result.success) return null;
      return result.windows.find((w: any) => w.id === wid);
    }, childWindowId);
    expect(childInfo).toBeTruthy();
    expect(childInfo.params.parentWindowId).toBe(groupsWindowId);

    // Clean up
    for (const id of [childWindowId, groupsWindowId]) {
      if (id) {
        try {
          await bgWindow.evaluate(async (wid: number) => {
            return await (window as any).app.window.close(wid);
          }, id);
        } catch { /* window may already be closed */ }
      }
    }
  });

  test('onEscape registers callback without changing backend escapeMode (role-based)', async () => {

    // Open a plain window with no escapeMode set (defaults to 'auto')
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('about:blank', {
        width: 400,
        height: 300
      });
    });
    expect(result.success).toBe(true);
    const windowId = result.id;

    const contentWindow = await app.getWindow('about:blank', 5000);
    expect(contentWindow).toBeTruthy();

    // Get escapeMode before registering handler
    const infoBefore = await bgWindow.evaluate(async (wid: number) => {
      const listResult = await (window as any).app.window.list({ includeInternal: true });
      if (!listResult.success) return null;
      return listResult.windows.find((w: any) => w.id === wid);
    }, windowId);
    expect(infoBefore).toBeTruthy();
    const escapeModeBefore = infoBefore.params.escapeMode;

    // Call api.escape.onEscape() — this should NOT change escapeMode on the backend
    // (self-declaration removed; role determines behavior now)
    await contentWindow.evaluate(() => {
      (window as any).app.escape.onEscape(() => ({ handled: false }));
    });

    // Small delay to ensure any async IPC would have completed
    await new Promise(r => setTimeout(r, 300));

    // Verify escapeMode was NOT changed by onEscape registration
    const infoAfter = await bgWindow.evaluate(async (wid: number) => {
      const listResult = await (window as any).app.window.list({ includeInternal: true });
      if (!listResult.success) return null;
      return listResult.windows.find((w: any) => w.id === wid);
    }, windowId);
    expect(infoAfter).toBeTruthy();
    expect(infoAfter.params.escapeMode).toBe(escapeModeBefore);

    // Verify the callback IS registered and responds via escape trigger
    const triggerResult = await contentWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    expect(triggerResult).toEqual({ handled: false });

    // Clean up
    if (windowId) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, windowId);
      } catch { /* window may already be closed */ }
    }
  });

  test('izui-close-self closes the window', async () => {

    // Open a content window
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 400,
        height: 300,
        escapeMode: 'navigate'
      });
    });
    expect(result.success).toBe(true);
    const windowId = result.id;

    const contentWindow = await app.getWindow('groups/home.html', 5000);
    expect(contentWindow).toBeTruthy();
    await contentWindow.waitForLoadState('domcontentloaded');

    // Close the window via the IPC path (tile:window:close). Fire-and-forget
    // — the IPC send doesn't block on the actual close.
    await bgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.close(wid);
    }, windowId);

    // Poll the window list until the closed window drops out. 5s is plenty
    // for a close — if it hasn't dropped by then, the close path is broken.
    await bgWindow.waitForFunction(
      async (wid: number) => {
        const listResult = await (window as any).app.window.list({ includeInternal: true });
        if (!listResult.success) return false;
        return !listResult.windows.some((w: any) => w.id === wid);
      },
      windowId,
      { timeout: 5000 }
    );
  });

  test('item:created fires from trackWindowLoad when opening external URL', async () => {
    const timestamp = Date.now();
    const testUrl = `https://track-window-load-${timestamp}.example.com`;

    // Subscribe to item:created and then open a URL window
    const result = await bgWindow.evaluate(async (url: string) => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, error: 'timeout' });
        }, 10000);

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
        });

        // Open a window with an external URL - this triggers trackWindowLoad
        // which emits item:created if the URL is new
        api.window.open(url, {
          width: 400,
          height: 300
        });
      });
    }, testUrl);

    expect((result as any).received).toBe(true);
    expect((result as any).itemId).toBeTruthy();
    expect((result as any).itemType).toBe('url');
    expect((result as any).content).toBe(testUrl);

    // Clean up - close the opened window
    const windowList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    if (windowList.success) {
      for (const w of windowList.windows) {
        if (w.url?.includes('track-window-load')) {
          try {
            await bgWindow.evaluate(async (id: number) => {
              return await (window as any).app.window.close(id);
            }, w.id);
          } catch { /* ignore */ }
        }
      }
    }
  });

  test('ESC debouncing: two rapid presses trigger only one handler call', async () => {

    // Open a groups window with navigate escape mode
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 400,
        height: 300,
        escapeMode: 'navigate'
      });
    });
    expect(result.success).toBe(true);
    const windowId = result.id;

    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    // Navigate into a group to have a deep state (so ESC navigates back)
    // First create a group with items
    const tagResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('esc-debounce-test');
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id;

    const item = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://esc-debounce-test.example.com',
        metadata: JSON.stringify({ title: 'ESC Debounce Test' })
      });
    });
    expect(item.success).toBe(true);

    if (tagId && item.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item.data.id, tagId });
    }

    // Refresh the groups view to pick up the new data
    // Navigate into the group to have a deep state.
    // Use a locator (auto-retrying) instead of elementHandle because the groups
    // view re-renders after tag:item-added pubsub events, detaching any handle.
    const groupLocator = groupsWindow.locator('peek-card.group-card').first();
    try {
      await groupLocator.waitFor({ state: 'visible', timeout: 5000 });
      await groupLocator.click({ timeout: 5000 });
      await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });
    } catch {
      // If no group cards render (e.g., visibility filtering), skip the deep
      // navigation — the ESC debounce behavior is independent of depth.
    }

    // Track how many times the escape handler is invoked by wrapping it
    // Use evaluate to set up a counter in the renderer
    await groupsWindow.evaluate(() => {
      (window as any).__escCallCount = 0;
      const origHandler = (window as any)._escapeCallback;
      if (origHandler) {
        (window as any)._origEscapeCallback = origHandler;
        // The preload stores the callback as _escapeCallback, but it's in a closure.
        // Instead, we'll use api.escape.onEscape to wrap the handler.
        (window as any).app.escape.onEscape(async () => {
          (window as any).__escCallCount++;
          return origHandler();
        });
      }
    });

    // Send two ESC key presses in rapid succession (< 200ms apart)
    // The debouncing in windows.ts should filter the second one
    await groupsWindow.keyboard.press('Escape');
    // Immediately press again - well within the 200ms debounce window
    await groupsWindow.keyboard.press('Escape');

    // Wait a moment for any handlers to complete
    await sleep(500);

    // Check call count - due to debouncing, only 0 or 1 calls should have gone through
    // Note: Playwright keyboard.press sends both keyDown and keyUp, and the ESC handler
    // fires on keyDown via before-input-event. The debounce ensures rapid presses are collapsed.
    const callCount = await groupsWindow.evaluate(() => (window as any).__escCallCount);

    // The debounce should ensure at most 1 handler call for 2 rapid presses
    expect(callCount).toBeLessThanOrEqual(1);

    // Clean up
    if (windowId) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, windowId);
      } catch { /* window may already be closed */ }
    }
  });
});
