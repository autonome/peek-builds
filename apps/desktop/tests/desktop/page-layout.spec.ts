/**
 * Page Host Layout Tests
 *
 * Canvas-DOM pixel-math regression tests (1-5) were deleted at Stage B
 * (canvas page-host removal) — the measured DOM elements (page.js's navbar/
 * webview/panels/resize-handles) no longer exist. What remains is the
 * maximize behavior suite (6-14), still skipped pending the Stage-B hybrid
 * maximize FSM re-home.
 *
 * Run with:
 *   BACKEND=electron yarn test:electron
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { hybridFlagOn } from '../helpers/hybrid-page';

// Layout constants used by the remaining Maximize tests below.
const MARGIN = 8;
const PANEL_WIDTH = 280;

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
  url: string,
  options: { width?: number; height?: number } = {}
): Promise<{ pageWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(
    async ({ targetUrl, opts }: { targetUrl: string; opts: { width?: number; height?: number } }) => {
      return await (window as any).app.window.open(targetUrl, {
        width: opts.width || 800,
        height: opts.height || 600,
        ...opts,
      });
    },
    { targetUrl: url, opts: options }
  );
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

async function waitForPageReady(pageWindow: Page): Promise<void> {
  // Wait for DOM elements to exist
  await pageWindow.waitForFunction(
    () => document.getElementById('navbar') !== null && document.getElementById('content') !== null,
    undefined,
    { timeout: 10000 }
  );
  // Wait for page to finish loading
  await waitForPageLoaded(pageWindow);
}

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  await bgWindow.evaluate(async (id: number) => {
    return await (window as any).app.window.close(id);
  }, windowId);
}

/**
 * Get the computed style properties of an element by ID
 */
async function getElementPosition(pageWindow: Page, elementId: string): Promise<{
  left: number;
  top: number;
  width: number;
  height: number;
}> {
  return pageWindow.evaluate((id: string) => {
    const el = document.getElementById(id) as HTMLElement;
    if (!el) throw new Error(`Element #${id} not found`);
    return {
      left: parseFloat(el.style.left) || 0,
      top: parseFloat(el.style.top) || 0,
      width: parseFloat(el.style.width) || 0,
      height: parseFloat(el.style.height) || 0,
    };
  }, elementId);
}

/**
 * Get the window bounds via the Electron API
 */
async function getWindowBounds(pageWindow: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return pageWindow.evaluate(async () => {
    return await (window as any).app.window.getBounds();
  });
}

// ============================================================================
// Maximize Tests (6-14): Verify maximize/restore functionality
// ============================================================================

test.describe('Page Layout Maximize @desktop', () => {

  // Test 6: Maximize command fills work area
  test('maximize command fills work area', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Publish maximize command
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    // Window bounds should match the display work area
    const result = await pageWindow.evaluate(async () => {
      const bounds = await (window as any).app.window.getBounds();
      const displayInfo = await (window as any).app.window.getDisplayInfo();
      return { bounds, workArea: displayInfo.workArea };
    });

    expect(result.bounds.x).toBe(result.workArea.x);
    expect(result.bounds.y).toBe(result.workArea.y);
    expect(result.bounds.width).toBe(result.workArea.width);
    expect(result.bounds.height).toBe(result.workArea.height);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 7: Maximize toggle restores original size
  test('maximize toggle restores original size', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Record original bounds
    const originalBounds = await getWindowBounds(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    // Wait for maximize state
    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Restore from maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.unmaximize(wid);
    }, windowId);

    // Wait for maximized class to be removed
    await pageWindow.waitForFunction(
      () => !document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Bounds should match original
    const restoredBounds = await getWindowBounds(pageWindow);
    expect(restoredBounds.width).toBe(originalBounds.width);
    expect(restoredBounds.height).toBe(originalBounds.height);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 8: Webview edge-to-edge when maximized (left=0, top=0)
  test('webview fills window when maximized', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Webview should be at (0, 0) filling the window
    const webviewPos = await getElementPosition(pageWindow, 'content');
    expect(webviewPos.left).toBe(0);
    expect(webviewPos.top).toBe(0);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 9: Navbar floats over webview when maximized
  test('navbar floats over webview when maximized', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Show navbar
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid }
      );
    }, windowId);

    await pageWindow.waitForFunction(
      () => {
        const navbar = document.getElementById('navbar');
        return navbar && navbar.classList.contains('visible');
      },
      undefined,
      { timeout: 5000 }
    );

    // Navbar should be floating above the webview (z-index check)
    // and webview should still be at top=0 (not pushed down)
    const webviewPos = await getElementPosition(pageWindow, 'content');
    expect(webviewPos.top).toBe(0);

    // Navbar should have z-index >= 100 (already does from CSS)
    const navbarZIndex = await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar') as HTMLElement;
      return parseInt(window.getComputedStyle(navbar).zIndex) || 0;
    });
    expect(navbarZIndex).toBeGreaterThanOrEqual(100);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 10: Panels clamped to screen edge when maximized
  test('panels clamped to screen edges when maximized', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // The body.maximized class flips via the FSM as soon as the IPC
    // returns, but setBounds(workArea) is an async X11 configure-request
    // — actual window.innerWidth doesn't reflect the new size until the
    // server processes it. Without this wait, panel positions get laid
    // out against the now-wide window while we then sample
    // window.innerWidth against the not-yet-wide window, and the
    // clamp assertion sees a 1632px panel.left against an 816px window.
    await pageWindow.waitForFunction(
      () => window.innerWidth > 1000,
      undefined,
      { timeout: 5000 }
    );

    // Show navbar to reveal panels
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid }
      );
    }, windowId);

    await pageWindow.waitForFunction(
      () => {
        const navbar = document.getElementById('navbar');
        return navbar && navbar.classList.contains('visible');
      },
      undefined,
      { timeout: 5000 }
    );

    // Left panels should be clamped: left >= MARGIN
    const pageInfoPos = await getElementPosition(pageWindow, 'page-info-panel');
    expect(pageInfoPos.left).toBeGreaterThanOrEqual(MARGIN);

    // Right panels should be clamped: left + width <= window width - MARGIN
    const windowWidth = await pageWindow.evaluate(() => window.innerWidth);
    const tagsPanelPos = await getElementPosition(pageWindow, 'tags-panel');
    expect(tagsPanelPos.left + PANEL_WIDTH).toBeLessThanOrEqual(windowWidth - MARGIN);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 11: Resize handles stay reachable when maximized
  test('resize handles stay reachable when maximized so a corner-grab can exit-and-resize', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // After the page-host edge-resize work, corner handles must remain
    // visible and pointer-event-receptive in maximized so the user can
    // drag a corner inward to exit-and-resize in a single gesture
    // (page-fsm RESIZE_START transition from MAXIMIZED).
    const seReachable = await pageWindow.evaluate(() => {
      const el = document.getElementById('resize-se');
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (style.pointerEvents === 'none') return false;
      return true;
    });
    expect(seReachable, 'SE corner handle must stay reachable in maximized').toBe(true);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 12: Drag out of maximized state restores
  test('drag out of maximized state restores original size', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Record original bounds
    const originalBounds = await getWindowBounds(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Show navbar, then drag it to exit maximized state
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid }
      );
    }, windowId);

    await pageWindow.waitForFunction(
      () => {
        const navbar = document.getElementById('navbar');
        return navbar && navbar.classList.contains('visible');
      },
      undefined,
      { timeout: 5000 }
    );

    // Simulate drag on navbar
    await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar') as HTMLElement;
      navbar.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        screenX: 400,
        screenY: 20,
        button: 0,
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        screenX: 450,
        screenY: 50,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // Should exit maximized state
    await pageWindow.waitForFunction(
      () => !document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Restored window should have the original dimensions (not work area dimensions)
    const restoredBounds = await getWindowBounds(pageWindow);
    expect(restoredBounds.width).toBe(originalBounds.width);
    expect(restoredBounds.height).toBe(originalBounds.height);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 13: Webview border-radius removed when maximized
  test('webview border-radius removed when maximized', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Verify non-maximized has border-radius
    const normalRadius = await pageWindow.evaluate(() => {
      const webview = document.getElementById('content') as HTMLElement;
      return window.getComputedStyle(webview).borderRadius;
    });
    expect(normalRadius).not.toBe('0px');

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.maximize(wid);
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Border-radius should be removed
    const maximizedRadius = await pageWindow.evaluate(() => {
      const webview = document.getElementById('content') as HTMLElement;
      return window.getComputedStyle(webview).borderRadius;
    });
    expect(maximizedRadius).toBe('0px');

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 14: Double-click navbar maximizes
  test('double-click navbar triggers maximize', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: maximize/geometry is the Stage-B FSM re-home');
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Show navbar
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid }
      );
    }, windowId);

    await pageWindow.waitForFunction(
      () => {
        const navbar = document.getElementById('navbar');
        return navbar && navbar.classList.contains('visible');
      },
      undefined,
      { timeout: 5000 }
    );

    // Double-click on navbar
    await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar') as HTMLElement;
      navbar.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        screenX: 400,
        screenY: 20,
      }));
    });

    // Should enter maximized state
    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    await closeWindow(sharedBgWindow, windowId);
  });
});
