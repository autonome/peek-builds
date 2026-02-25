/**
 * Page Widget Extensibility Tests
 *
 * Tests the page widget host API that lets extensions:
 * - Register widgets via pubsub
 * - Execute content scripts in the page webview
 * - Render, update, and close widgets
 * - React to page lifecycle events
 *
 * Run with:
 *   BACKEND=electron yarn test:electron
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

// Shared app instance
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

// ============================================================================
// Helpers
// ============================================================================

async function openCanvasPage(
  bgWindow: Page,
  url: string
): Promise<{ pageWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(async (targetUrl: string) => {
    return await (window as any).app.window.open(targetUrl, {
      width: 800,
      height: 600,
    });
  }, url);
  expect(result.success).toBe(true);
  const windowId = result.id;

  const pageWindow = await sharedApp.getWindow('page/index.html', 15000);
  expect(pageWindow).toBeTruthy();

  return { pageWindow, windowId };
}

async function waitForPageLoaded(pageWindow: Page, timeout = 30000): Promise<void> {
  await pageWindow.waitForFunction(
    () => {
      const webview = document.getElementById('content');
      return webview && webview.classList.contains('loaded');
    },
    undefined,
    { timeout }
  );
}

async function waitForWidgetHost(pageWindow: Page, timeout = 10000): Promise<void> {
  await pageWindow.waitForFunction(
    () => (window as any).__pageWidgetHost != null,
    undefined,
    { timeout }
  );
}

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  await bgWindow.evaluate(async (id: number) => {
    return await (window as any).app.window.close(id);
  }, windowId);
}

// ============================================================================
// Page Widget Host Tests
// ============================================================================

test.describe('Page Widgets @desktop', () => {
  test('widget host is initialized on page load', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    const hasHost = await pageWindow.evaluate(() => {
      return (window as any).__pageWidgetHost != null;
    });
    expect(hasHost).toBe(true);

    await closeWindow(sharedBgWindow, windowId);
  });

  test('widget:register creates a widget registration', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    // Register a widget via pubsub from the page window
    await pageWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('widget:register', {
        extensionId: 'test-ext',
        widgetId: 'test-widget',
        title: 'Test Widget',
        position: 'right',
      }, api.scopes.GLOBAL);
    });

    // Verify registration
    const widgetCount = await pageWindow.evaluate(() => {
      return (window as any).__pageWidgetHost.getWidgets().size;
    });
    expect(widgetCount).toBeGreaterThanOrEqual(1);

    await closeWindow(sharedBgWindow, windowId);
  });

  test('widget:render displays a widget in the page', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    // Register and render a widget
    await pageWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('widget:register', {
        extensionId: 'test-ext',
        widgetId: 'render-test',
        title: 'Render Test',
      }, api.scopes.GLOBAL);

      api.publish('widget:render', {
        extensionId: 'test-ext',
        widgetId: 'render-test',
        title: 'Rendered Widget',
        html: '<p class="test-content">Widget content here</p>',
      }, api.scopes.GLOBAL);
    });

    // Verify widget DOM was created
    const widgetExists = await pageWindow.waitForFunction(
      () => {
        const container = document.getElementById('widget-container');
        if (!container) return false;
        const widget = container.querySelector('[data-widget-id="test-ext:render-test"]');
        return widget !== null;
      },
      undefined,
      { timeout: 5000 }
    );
    expect(widgetExists).toBeTruthy();

    // Verify widget content
    const content = await pageWindow.evaluate(() => {
      const widget = document.querySelector('[data-widget-id="test-ext:render-test"]');
      const body = widget?.querySelector('.widget-body');
      return body?.innerHTML || '';
    });
    expect(content).toContain('Widget content here');

    await closeWindow(sharedBgWindow, windowId);
  });

  test('widget:update modifies existing widget content', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    // Register, render, then update
    await pageWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('widget:register', {
        extensionId: 'test-ext',
        widgetId: 'update-test',
      }, api.scopes.GLOBAL);

      api.publish('widget:render', {
        extensionId: 'test-ext',
        widgetId: 'update-test',
        html: '<p>Original</p>',
      }, api.scopes.GLOBAL);
    });

    // Wait for initial render
    await pageWindow.waitForFunction(
      () => document.querySelector('[data-widget-id="test-ext:update-test"]') !== null,
      undefined,
      { timeout: 5000 }
    );

    // Update the widget
    await pageWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('widget:update', {
        extensionId: 'test-ext',
        widgetId: 'update-test',
        html: '<p>Updated content</p>',
        title: 'New Title',
      }, api.scopes.GLOBAL);
    });

    // Verify update
    const updatedContent = await pageWindow.evaluate(() => {
      const widget = document.querySelector('[data-widget-id="test-ext:update-test"]');
      const body = widget?.querySelector('.widget-body');
      return body?.innerHTML || '';
    });
    expect(updatedContent).toContain('Updated content');

    await closeWindow(sharedBgWindow, windowId);
  });

  test('widget:close removes widget from DOM', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    // Register and render
    await pageWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('widget:register', {
        extensionId: 'test-ext',
        widgetId: 'close-test',
      }, api.scopes.GLOBAL);

      api.publish('widget:render', {
        extensionId: 'test-ext',
        widgetId: 'close-test',
        html: '<p>To be closed</p>',
      }, api.scopes.GLOBAL);
    });

    // Wait for render
    await pageWindow.waitForFunction(
      () => document.querySelector('[data-widget-id="test-ext:close-test"]') !== null,
      undefined,
      { timeout: 5000 }
    );

    // Close the widget
    await pageWindow.evaluate(() => {
      const api = (window as any).app;
      api.publish('widget:close', {
        extensionId: 'test-ext',
        widgetId: 'close-test',
      }, api.scopes.GLOBAL);
    });

    // Wait for removal (animation takes 300ms)
    await pageWindow.waitForFunction(
      () => {
        const host = (window as any).__pageWidgetHost;
        return host && host.getActiveWidgets().size === 0;
      },
      undefined,
      { timeout: 5000 }
    );

    await closeWindow(sharedBgWindow, windowId);
  });

  test('page:execute-script runs code in webview and returns result', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    // Execute a script and capture result via pubsub
    const result = await pageWindow.evaluate(() => {
      return new Promise((resolve, reject) => {
        const api = (window as any).app;
        const requestId = 'test-script-' + Date.now();
        let timer: ReturnType<typeof setTimeout>;

        const unsub = api.subscribe('page:script-result', (msg: any) => {
          if (msg.requestId !== requestId) return;
          clearTimeout(timer);
          unsub();
          resolve(msg);
        }, api.scopes.GLOBAL);

        timer = setTimeout(() => {
          unsub();
          reject(new Error('Timed out waiting for script result'));
        }, 10000);

        api.publish('page:execute-script', {
          extensionId: 'test-ext',
          requestId,
          script: 'document.title',
        }, api.scopes.GLOBAL);
      });
    });

    expect((result as any).success).toBe(true);
    expect(typeof (result as any).result).toBe('string');

    await closeWindow(sharedBgWindow, windowId);
  });

  test('page:execute-script returns error for invalid script', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageLoaded(pageWindow);
    await waitForWidgetHost(pageWindow);

    const result = await pageWindow.evaluate(() => {
      return new Promise((resolve, reject) => {
        const api = (window as any).app;
        const requestId = 'test-error-' + Date.now();
        let timer: ReturnType<typeof setTimeout>;

        const unsub = api.subscribe('page:script-result', (msg: any) => {
          if (msg.requestId !== requestId) return;
          clearTimeout(timer);
          unsub();
          resolve(msg);
        }, api.scopes.GLOBAL);

        timer = setTimeout(() => {
          unsub();
          reject(new Error('Timed out'));
        }, 10000);

        api.publish('page:execute-script', {
          extensionId: 'test-ext',
          requestId,
          script: 'throw new Error("intentional test error")',
        }, api.scopes.GLOBAL);
      });
    });

    expect((result as any).success).toBe(false);
    expect((result as any).error).toBeTruthy();

    await closeWindow(sharedBgWindow, windowId);
  });
});
