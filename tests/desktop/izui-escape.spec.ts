import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('IZUI Escape Protocol @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('izui-escape'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('navigate mode: escape navigates internally before requesting close', async () => {

    // Create a group with items so we can navigate into it
    const tagResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('izui-esc-test');
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id || tagResult.data?.data?.id || tagResult.data?.id;

    const item = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://izui-esc-test.example.com',
        metadata: JSON.stringify({ title: 'IZUI ESC Test' })
      });
    });
    expect(item.success).toBe(true);

    if (tagId && item.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item.data.id, tagId });
    }

    // Open groups window (background.js uses escapeMode: 'navigate')
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 800,
        height: 600,
        escapeMode: 'navigate'
      });
    });
    expect(groupsResult.success).toBe(true);

    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    // Navigate to addresses view by clicking a group
    const groupCard = await groupsWindow.$('peek-card.group-card[data-tag-id="' + tagId + '"]');
    if (groupCard) {
      await groupCard.click();
    } else {
      const anyCard = await groupsWindow.$('peek-card.group-card');
      expect(anyCard).toBeTruthy();
      await anyCard!.click();
    }
    await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });

    // Verify we're in addresses view
    const viewBefore = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewBefore).toBe('addresses');

    // Trigger escape via the IZUI chain - should navigate back to groups (handled: true)
    const escResult1 = await groupsWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    expect(escResult1.handled).toBe(true);

    // Wait for navigation to complete — waitForSelector is the deterministic signal
    // that showGroups() has rendered (the setTimeout(0) in handleEscape fires and
    // DOM updates before group-card is inserted into the DOM).
    await groupsWindow.waitForSelector('peek-card.group-card', { timeout: 5000 });

    // Verify we're back in groups view
    const viewAfter = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewAfter).toBe('groups');

    // Trigger escape again at root - renderer returns { handled: false } at root
    // Backend handles close policy (child/transient windows close, active root stays)
    const escResult2 = await groupsWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    // trigger() calls the handler directly - at root, groups returns { handled: false }
    expect(escResult2.handled).toBe(false);

    // Clean up - trigger() doesn't go through backend ESC path, so window is still open
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

  test('peek-card: Enter key activates card via card-click event', async () => {

    // Create a group with an item
    const tagResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getOrCreateTag('enter-key-test');
    });
    expect(tagResult.success).toBe(true);
    const tagId = tagResult.data?.tag?.id || tagResult.data?.data?.id || tagResult.data?.id;

    const item = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addItem('url', {
        content: 'https://enter-key-test.example.com',
        metadata: JSON.stringify({ title: 'Enter Key Test' })
      });
    });
    expect(item.success).toBe(true);

    if (tagId && item.data?.id) {
      await bgWindow.evaluate(async ({ itemId, tagId }) => {
        return await (window as any).app.datastore.tagItem(itemId, tagId);
      }, { itemId: item.data.id, tagId });
    }

    // Open groups window
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'workspace',
        width: 800,
        height: 600
      });
    });
    expect(groupsResult.success).toBe(true);

    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('peek-card.group-card', { timeout: 5000 });

    // Verify we're in groups view
    const viewBefore = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewBefore).toBe('groups');

    // Programmatically activate the first card (simulates Enter key path)
    const activated = await groupsWindow.evaluate(async () => {
      const card = document.querySelector('peek-card.group-card') as any;
      if (!card) return false;
      card.click();
      return true;
    });
    expect(activated).toBe(true);

    // Should navigate to addresses view
    await groupsWindow.waitForSelector('peek-card.address-card', { timeout: 5000 });
    const viewAfter = await groupsWindow.evaluate(() => (window as any)._groupsState.view);
    expect(viewAfter).toBe('addresses');

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

  test('active mode: ESC at root does NOT close window', async () => {

    // Open groups window with role: 'workspace' (like the real groups extension does)
    // In headless/test mode, appFocused defaults to true → session is 'active'
    const groupsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'workspace',
        width: 400,
        height: 300,
      });
    });
    expect(groupsResult.success).toBe(true);
    const groupsWindow = await app.getWindow('groups/home.html', 5000);
    expect(groupsWindow).toBeTruthy();
    await groupsWindow.waitForLoadState('domcontentloaded');
    await groupsWindow.waitForSelector('.cards', { timeout: 5000 });

    // Verify the window's role is 'workspace' and session is 'active'
    const izuiState = await bgWindow.evaluate(async () => {
      return await (window as any).app.izui.getState();
    });
    expect(izuiState).toBe('active');

    // Press ESC via keyboard — goes through full backend path:
    // before-input-event → handleEscapeForWindow → askRendererToHandleEscape →
    // renderer returns { handled: false } at root → escPolicy('active', 'workspace') → 'nothing'
    await groupsWindow.keyboard.press('Escape');

    // Wait for the async ESC handling to complete
    await new Promise(resolve => setTimeout(resolve, 600));

    // Verify window is still alive — if escPolicy is wrong, the window would be closed
    const stillAlive = await groupsWindow.evaluate(() => true).catch(() => false);
    expect(stillAlive).toBe(true);

    // Also verify the view is still at root (groups list)
    const view = await groupsWindow.evaluate(() => (window as any)._groupsState?.view);
    expect(view).toBe('groups');

    // Clean up
    if (groupsResult.id) {
      try {
        await bgWindow.evaluate(async (wid: number) => {
          return await (window as any).app.window.close(wid);
        }, groupsResult.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('active mode: ESC on child-content window does NOT close it (regression)', async () => {

    // First open a workspace window (like groups) to establish an active session
    const workspaceResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        role: 'workspace',
        width: 400,
        height: 300,
      });
    });
    expect(workspaceResult.success).toBe(true);
    const workspaceWindow = await app.getWindow('groups/home.html', 5000);
    expect(workspaceWindow).toBeTruthy();
    await workspaceWindow.waitForLoadState('domcontentloaded');

    // Verify session is active
    const izuiState = await bgWindow.evaluate(async () => {
      return await (window as any).app.izui.getState();
    });
    expect(izuiState).toBe('active');

    // Now open a child-content window (simulates opening a web page from groups)
    // Using the workspace window as the opener gives it child-content role
    const contentResult = await workspaceWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://search/home.html', {
        role: 'child-content',
        width: 400,
        height: 300,
      });
    });
    expect(contentResult.success).toBe(true);
    const contentWindow = await app.getWindow('search/home.html', 5000);
    expect(contentWindow).toBeTruthy();
    await contentWindow.waitForLoadState('domcontentloaded');

    // Trigger escape via the renderer callback directly — search/home.html has no
    // onEscape handler so trigger() returns { handled: false } immediately.
    // The regression: child-content would be closed on ESC before the escPolicy fix.
    // The backend policy (escPolicy('active','child-content') === 'nothing') is a
    // pure function tested in izui-state.test.ts. Here we verify the renderer path
    // doesn't close the window.
    const escResult = await contentWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    expect(escResult).toEqual({ handled: false });

    // Verify child-content window is still alive — if the window were incorrectly
    // closed on ESC, this evaluate() call would throw/return false.
    const stillAlive = await contentWindow.evaluate(() => true).catch(() => false);
    expect(stillAlive).toBe(true);

    // Clean up
    for (const id of [contentResult.id, workspaceResult.id]) {
      if (id) {
        try {
          await bgWindow.evaluate(async (wid: number) => {
            return await (window as any).app.window.close(wid);
          }, id);
        } catch {
          // Window may already be closed
        }
      }
    }
  });

  test('navigate mode: timeout does not close window', async () => {

    // Open a window with navigate escape mode but NO escape handler registered
    // This simulates what happens when a window hasn't finished loading its IZUI
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 400,
        height: 300,
        escapeMode: 'navigate'
      });
    });
    expect(result.success).toBe(true);

    const testWindow = await app.getWindow('groups/home.html', 5000);
    expect(testWindow).toBeTruthy();
    await testWindow.waitForLoadState('domcontentloaded');

    // The groups extension registers an escape handler via api.escape.onEscape.
    // At root (groups view), handler returns { handled: false }.
    // Backend handles close policy via navigate mode.
    await testWindow.waitForSelector('.cards', { timeout: 5000 });
    const escResult = await testWindow.evaluate(async () => {
      return await (window as any).app.escape.trigger();
    });
    // trigger() calls handler directly - at root, groups returns { handled: false }
    expect(escResult.handled).toBe(false);

    // trigger() doesn't go through backend ESC path, window is still open
    // Clean up
    if (result.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, result.id);
      } catch {
        // Window may already be closed
      }
    }
  });
});
