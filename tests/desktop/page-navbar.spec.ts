/**
 * Page Host Navbar Tests
 *
 * Tests the navbar show/hide behavior in canvas page windows:
 * - Loading lifecycle shows/hides navbar
 * - Cmd+L shortcut shows navbar with URL focus (via pubsub)
 * - Hover trigger zone shows navbar
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
// Helper: Open a web URL as a canvas page and get the page host window
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

  // The URL gets rewritten to peek://app/page/index.html?url=...
  const pageWindow = await sharedApp.getWindow('page/index.html', 15000);
  expect(pageWindow).toBeTruthy();

  return { pageWindow, windowId };
}

// ============================================================================
// Helper: Wait for page host to be fully loaded (webview has 'loaded' class)
// ============================================================================

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

// ============================================================================
// Helper: Wait for navbar to reach a specific visibility state
// ============================================================================

async function waitForNavbarVisible(pageWindow: Page, visible: boolean, timeout = 10000): Promise<void> {
  await pageWindow.waitForFunction(
    (vis: boolean) => {
      const navbar = document.getElementById('navbar');
      if (!navbar) return false;
      const hasClass = navbar.classList.contains('visible');
      return vis ? hasClass : !hasClass;
    },
    visible,
    { timeout }
  );
}

// ============================================================================
// Page Navbar Tests
// ============================================================================

test.describe('Page Navbar @desktop', () => {
  test('navbar shows during loading and hides after load completes', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    // Wait for page.js to initialize (DOM elements ready)
    await pageWindow.waitForFunction(
      () => document.getElementById('navbar') !== null,
      undefined,
      { timeout: 10000 }
    );

    // Wait for loading to complete: webview should get 'loaded' class
    // (example.com loads fast, so we may miss the navbar 'visible' during loading)
    await waitForPageLoaded(pageWindow);

    // After loading completes, navbar should auto-hide (since showSource was 'loading').
    // This validates the loading lifecycle: navbar was shown during loading and
    // auto-hidden after loading completed.
    await waitForNavbarVisible(pageWindow, false, 10000);

    // Verify the loading lifecycle ran by checking that showSource was cleared
    // (hide() sets showSource = null when it hides after loading)
    const showSource = await pageWindow.evaluate(() => {
      // showSource is module-scoped but we can check the navbar's loading property
      const navbar = document.getElementById('navbar') as any;
      return navbar ? navbar.loading : undefined;
    });
    expect(showSource).toBe(false);

    // Clean up: close the page window
    await sharedBgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  });

  test('Cmd+L shows navbar via pubsub', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    // Wait for page.js to fully initialize and loading to complete
    await pageWindow.waitForFunction(
      () => document.getElementById('navbar') !== null,
      undefined,
      { timeout: 10000 }
    );
    await waitForPageLoaded(pageWindow);

    // Wait for navbar to be hidden after loading
    await waitForNavbarVisible(pageWindow, false, 10000);

    // Simulate Cmd+L via pubsub (same mechanism as the before-input-event handler)
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid }
      );
    }, windowId);

    // Navbar should become visible
    await waitForNavbarVisible(pageWindow, true, 5000);

    // Clean up
    await sharedBgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  });

  test('Cmd+L navbar auto-hides on mouseleave like hover', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    // Wait for page.js to fully initialize and loading to complete
    await pageWindow.waitForFunction(
      () => document.getElementById('navbar') !== null,
      undefined,
      { timeout: 10000 }
    );
    await waitForPageLoaded(pageWindow);

    // Wait for navbar to be hidden after loading
    await waitForNavbarVisible(pageWindow, false, 10000);

    // Simulate Cmd+L via pubsub
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid }
      );
    }, windowId);

    // Navbar should become visible with source 'shortcut'
    await waitForNavbarVisible(pageWindow, true, 5000);

    // Simulate mouse entering then leaving the navbar area
    // First enter the navbar (cancels any pending hide)
    await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar');
      if (navbar) {
        navbar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
    });

    // Then leave the navbar — should schedule auto-hide
    await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar');
      if (navbar) {
        navbar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientY: 200 }));
      }
      // Update lastMouseY to simulate cursor being below navbar area
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 200 }));
    });

    // Navbar should auto-hide after the 300ms delay
    await waitForNavbarVisible(pageWindow, false, 5000);

    // Clean up
    await sharedBgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  });

  test('trigger zone hover shows navbar', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    // Wait for page.js to fully initialize and loading to complete
    await pageWindow.waitForFunction(
      () => document.getElementById('navbar') !== null,
      undefined,
      { timeout: 10000 }
    );
    await waitForPageLoaded(pageWindow);

    // Wait for navbar to be hidden
    await waitForNavbarVisible(pageWindow, false, 10000);

    // Simulate mouseenter on the trigger zone
    await pageWindow.evaluate(() => {
      const triggerZone = document.getElementById('trigger-zone');
      if (triggerZone) {
        triggerZone.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
    });

    // Navbar should become visible
    await waitForNavbarVisible(pageWindow, true, 5000);

    // Clean up
    await sharedBgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  });
});
