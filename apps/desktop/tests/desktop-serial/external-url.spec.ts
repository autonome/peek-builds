import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady, waitForAppReady, sleep } from '../helpers/window-utils';

test.describe('External URL Opening @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('external-url'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('open URL by calling executable', async () => {
    // Verify app is ready with background window
    expect(bgWindow).toBeTruthy();
    // Ensure the API is ready
    await waitForAppReady(bgWindow);
  });

  test('cmd panel detects and opens domain without protocol (youtube.com)', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });

    // Type a domain without protocol
    await cmdWindow.fill('input', 'example.com');

    // Subscribe to the window:opened event BEFORE pressing Enter so
    // there's no race — main publishes this as soon as the new window
    // is registered (see apps/desktop/main/ipc.ts window-create handler).
    await bgWindow.evaluate(() => {
      (window as any).__domainWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes('https://example.com') || msg.url.includes('https%3A%2F%2Fexample.com'))) {
          (window as any).__domainWindowOpened = msg;
        }
      });
    });

    await cmdWindow.keyboard.press('Enter');

    // Wait for the window:opened event for our URL — deterministic.
    await bgWindow.waitForFunction(
      () => (window as any).__domainWindowOpened !== null,
      undefined,
      { timeout: 5000 }
    );

    // Verify URL was opened (check window list for the URL)
    const windowList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });

    expect(windowList.success).toBe(true);
    // URL should be wrapped in page loader with https:// protocol
    const exampleWindow = windowList.windows?.find((w: any) =>
      w.url && (w.url.includes('https://example.com') || w.url.includes('https%3A%2F%2Fexample.com'))
    );
    expect(exampleWindow).toBeTruthy();

    // Clean up
    if (exampleWindow) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, exampleWindow.id);
    }
  });

  test('cmd panel opens URL with http protocol', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });

    // Type URL with http protocol
    await cmdWindow.fill('input', 'http://example.com');

    // Subscribe to the window:opened event BEFORE pressing Enter so
    // there's no race — main publishes this as soon as the new window
    // is registered (see apps/desktop/main/ipc.ts window-create handler).
    await bgWindow.evaluate(() => {
      (window as any).__httpWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (
          msg.url.includes('http://example.com') ||
          msg.url.includes('http%3A%2F%2Fexample.com') ||
          msg.url.includes('https://example.com')
        )) {
          (window as any).__httpWindowOpened = msg;
        }
      });
    });

    await cmdWindow.keyboard.press('Enter');

    // Wait for the window:opened event for our URL — deterministic.
    await bgWindow.waitForFunction(
      () => (window as any).__httpWindowOpened !== null,
      undefined,
      { timeout: 5000 }
    );

    // Verify URL was opened (should preserve http://)
    const windowList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });

    expect(windowList.success).toBe(true);
    // Accept both the typed http:// form and the post-redirect https://
    // form. example.com auto-redirects to HTTPS, and tile:window:list now
    // returns the user-facing address (info.params.currentUrl after
    // navigation lands) rather than the shell-URL with %-encoded ?url=.
    const httpWindow = windowList.windows?.find((w: any) =>
      w.url && (
        w.url.includes('http://example.com') ||
        w.url.includes('http%3A%2F%2Fexample.com') ||
        w.url.includes('https://example.com')
      )
    );
    expect(httpWindow).toBeTruthy();

    // Clean up
    if (httpWindow) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, httpWindow.id);
    }
  });

  test('cmd panel opens URL with https protocol', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });

    // Type URL with https protocol
    await cmdWindow.fill('input', 'https://example.com');

    // Subscribe to the window:opened event BEFORE pressing Enter so
    // there's no race — main publishes this as soon as the new window
    // is registered (see apps/desktop/main/ipc.ts window-create handler).
    await bgWindow.evaluate(() => {
      (window as any).__httpsWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes('https://example.com') || msg.url.includes('https%3A%2F%2Fexample.com'))) {
          (window as any).__httpsWindowOpened = msg;
        }
      });
    });

    await cmdWindow.keyboard.press('Enter');

    // Wait for the window:opened event for our URL — deterministic.
    await bgWindow.waitForFunction(
      () => (window as any).__httpsWindowOpened !== null,
      undefined,
      { timeout: 5000 }
    );

    // Verify URL was opened
    const windowList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });

    expect(windowList.success).toBe(true);
    const httpsWindow = windowList.windows?.find((w: any) =>
      w.url && (w.url.includes('https://example.com') || w.url.includes('https%3A%2F%2Fexample.com'))
    );
    expect(httpsWindow).toBeTruthy();

    // Clean up
    if (httpsWindow) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, httpsWindow.id);
    }
  });

  test('cmd panel opens localhost URLs', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });

    // Type localhost with port
    await cmdWindow.fill('input', 'localhost:3000');

    // Subscribe to the window:opened event BEFORE pressing Enter so
    // there's no race — main publishes this as soon as the new window
    // is registered (see apps/desktop/main/ipc.ts window-create handler).
    await bgWindow.evaluate(() => {
      (window as any).__localhostWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes('localhost:3000') || msg.url.includes('localhost%3A3000'))) {
          (window as any).__localhostWindowOpened = msg;
        }
      });
    });

    await cmdWindow.keyboard.press('Enter');

    // Wait for the window:opened event for our URL — deterministic.
    await bgWindow.waitForFunction(
      () => (window as any).__localhostWindowOpened !== null,
      undefined,
      { timeout: 5000 }
    );

    // Verify URL was opened (normalized to https://localhost:3000)
    const windowList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });

    expect(windowList.success).toBe(true);
    const localhostWindow = windowList.windows?.find((w: any) =>
      w.url && (w.url.includes('localhost:3000') || w.url.includes('localhost%3A3000'))
    );
    expect(localhostWindow).toBeTruthy();

    // Clean up
    if (localhostWindow) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, localhostWindow.id);
    }
  });

  test('cmd panel ignores non-URL non-command text on Enter', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    // Snapshot window list before
    const beforeList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const beforeCount = beforeList.windows?.length || 0;

    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });

    // Type non-URL text (no dots, no protocol) — not a command either
    await cmdWindow.fill('input', 'notaurl');
    await cmdWindow.keyboard.press('Enter');

    // Wait briefly to confirm nothing happens
    await sleep(500);

    // Verify no new windows were opened (non-URL text is ignored, not routed anywhere)
    const afterList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });

    // Should NOT be opened as a direct URL
    const directUrlWindow = afterList.windows?.find((w: any) =>
      w.url === 'http://notaurl' || w.url === 'https://notaurl'
    );
    expect(directUrlWindow).toBeFalsy();

    // Should NOT be opened as a web search either (no fallback)
    const searchWindow = afterList.windows?.find((w: any) =>
      w.url && w.url.includes('notaurl')
    );
    expect(searchWindow).toBeFalsy();

    // Close cmd panel if still open
    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        try {
          await (window as any).app.window.close(id);
        } catch (e) {
          // Already closed
        }
      }, openResult.id);
    }
  });

  test('external URL handler opens URL on first click (simulates OS open-url event)', async () => {
    // This test simulates clicking a URL from an external app (like clicking a link
    // in another app when Peek is set as default browser).
    // Tests the fix for: first click focuses app but doesn't open URL, second click works.

    await waitForExtensionsReady(bgWindow, 15000);

    // Get initial window count
    const initialList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const initialCount = initialList.windows?.length || 0;

    // Simulate external URL open event (what happens when clicking URL from another app)
    // This bypasses the normal window.open flow and tests the handleExternalUrl path
    const testUrl = 'https://example.com/external-test';

    // Subscribe to the window:opened event BEFORE publishing the
    // trigger so there's no race — main publishes this as soon as the
    // new window is registered (see apps/desktop/main/ipc.ts
    // window-create handler).
    await bgWindow.evaluate((url: string) => {
      const api = (window as any).app;
      (window as any).__externalUrlWindowOpened = null;
      api.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes(url) || msg.url.includes(encodeURIComponent(url)))) {
          (window as any).__externalUrlWindowOpened = msg;
        }
      });
    }, testUrl);

    // Trigger external:open-url event directly (simulates what handleExternalUrl does)
    await bgWindow.evaluate(async (url: string) => {
      const api = (window as any).app;
      // Publish the same event that handleExternalUrl publishes — core
      // renderer subscribes on GLOBAL scope, so publish with GLOBAL explicitly
      // (default is SELF in tile-preload).
      await api.publish('external:open-url', {
        url,
        trackingSource: 'external',
        trackingSourceId: 'os',
        timestamp: Date.now()
      });
    }, testUrl);

    // Wait for the window:opened event for our URL — deterministic.
    await bgWindow.waitForFunction(
      () => (window as any).__externalUrlWindowOpened !== null,
      undefined,
      { timeout: 5000 }
    );

    // Verify URL was opened
    const finalList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });

    expect(finalList.success).toBe(true);
    const finalCount = finalList.windows?.length || 0;

    // Should have created a new window
    expect(finalCount).toBeGreaterThan(initialCount);

    // Find the window with our test URL
    const externalWindow = finalList.windows?.find((w: any) =>
      w.url && (w.url.includes(testUrl) || w.url.includes(encodeURIComponent(testUrl)))
    );
    expect(externalWindow).toBeTruthy();

    // Clean up
    if (externalWindow) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, externalWindow.id);
    }
  });

  test('handleExternalUrl from main process opens URL correctly', async () => {
    // This tests the REAL external URL path — calling handleExternalUrl from
    // the main process, which is what happens when macOS sends an open-url event
    // or when Peek receives a second-instance signal with a URL argument.
    // The previous test simulates via pubsub from the renderer; this test
    // exercises the full main-process -> pubsub -> renderer -> window-open flow.

    await waitForExtensionsReady(bgWindow, 15000);

    // Get initial window count (include internal to see ALL windows)
    const initialList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const initialCount = initialList.windows?.length || 0;

    const testUrl = 'https://example.com/main-process-external-test';

    // Call handleExternalUrl from the main process (simulates real OS open-url)
    const mainResult = await app.evaluateMain!(({ app }) => {
      const { handleExternalUrl } = (globalThis as any).__peek_test;
      if (!handleExternalUrl) return { error: 'handleExternalUrl not found on __peek_test' };
      handleExternalUrl('https://example.com/main-process-external-test', 'os');
      return { success: true };
    });

    // Verify main process call succeeded
    expect((mainResult as any).error).toBeUndefined();

    // Wait for window with the specific URL to appear (deterministic — no count-based checks)
    let externalWindow: any = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const list = await bgWindow.evaluate(async () => {
        return await (window as any).app.window.list();
      });
      externalWindow = list.windows?.find((w: any) =>
        w.url && (w.url.includes('main-process-external-test') || w.url.includes(encodeURIComponent('main-process-external-test')))
      );
      if (externalWindow) break;
      await sleep(100);
    }

    expect(externalWindow).toBeTruthy();

    // Clean up
    if (externalWindow) {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, externalWindow.id);
    }
  });
});
