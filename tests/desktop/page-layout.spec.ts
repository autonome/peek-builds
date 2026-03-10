/**
 * Page Host Layout Tests
 *
 * Tests the page host layout invariants and future maximize behavior:
 * - Regression tests (1-5): Verify current layout math is correct
 * - New behavior tests (6-14): Verify maximize functionality (skipped until implemented)
 *
 * Constants from page.js:
 *   NAVBAR_HEIGHT = 36, NAVBAR_GAP = 0, TRIGGER_ZONE_HEIGHT = 8, MARGIN = 8
 *   PANEL_WIDTH = 280, PANEL_OVERLAP = 70, PANEL_OVERHANG = 210
 *
 * Run with:
 *   BACKEND=electron yarn test:electron
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

// Layout constants (must match page.js)
const NAVBAR_HEIGHT = 36;
const NAVBAR_GAP = 0;
const TRIGGER_ZONE_HEIGHT = 8;
const MARGIN = 8;
const PANEL_WIDTH = 280;
const PANEL_OVERLAP = 70; // PANEL_WIDTH * 0.25
const PANEL_OVERHANG = 210; // PANEL_WIDTH - PANEL_OVERLAP

// Derived constants
const NAV_OFFSET = NAVBAR_HEIGHT + NAVBAR_GAP; // 36
const WEBVIEW_TOP = NAV_OFFSET + TRIGGER_ZONE_HEIGHT; // 44

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
// Regression Tests (1-5): Must pass with current code
// ============================================================================

test.describe('Page Layout Regression @desktop', () => {

  // Test 1: Webview positioned below navbar space (44px from window top)
  test('webview is positioned 44px from window top', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    const webviewPos = await getElementPosition(pageWindow, 'content');
    // Webview top = NAVBAR_HEIGHT(36) + NAVBAR_GAP(0) + TRIGGER_ZONE_HEIGHT(8) = 44
    expect(webviewPos.top).toBe(WEBVIEW_TOP);
    // Webview left = MARGIN(8)
    expect(webviewPos.left).toBe(MARGIN);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 2: Navbar show/hide does not change window height
  // The window always reserves 44px for navbar space. Show/hide toggles
  // CSS-only (opacity + pointer-events). The only setBounds calls during
  // show/hide are for width changes (panel overhang). Height stays the same.
  test('navbar show/hide does not change window height', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Show navbar via pubsub — this triggers setWindowPadding which calls
    // setBounds with computeWindowBounds. This establishes the proper window
    // height (screenBounds.height + 44 + 8).
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
    }, windowId);

    // Wait for navbar to become visible
    await pageWindow.waitForFunction(
      () => {
        const navbar = document.getElementById('navbar');
        return navbar && navbar.classList.contains('visible');
      },
      undefined,
      { timeout: 5000 }
    );

    // Record the window height when navbar is shown
    const shownBounds = await getWindowBounds(pageWindow);

    // Simulate mouseleave to hide navbar
    await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar');
      if (navbar) {
        navbar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientY: 200 }));
      }
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 200 }));
    });

    // Wait for navbar to hide
    await pageWindow.waitForFunction(
      () => {
        const navbar = document.getElementById('navbar');
        return navbar && !navbar.classList.contains('visible');
      },
      undefined,
      { timeout: 5000 }
    );

    // Window height must be the same after hide — only width changes (panel padding)
    const hiddenBounds = await getWindowBounds(pageWindow);
    expect(hiddenBounds.height).toBe(shownBounds.height);

    // Show again and verify height still matches
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
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

    const shownAgainBounds = await getWindowBounds(pageWindow);
    expect(shownAgainBounds.height).toBe(shownBounds.height);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 3: Panel positions — left panels partially off-left, right panels partially off-right
  test('panel positions: left panels offset left, right panels offset right', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Show navbar to make panels visible (panels share navbar lifecycle)
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
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

    // Check left panel (page-info-panel) position
    // Expected left = webviewLeft(8) - PANEL_WIDTH(280) + PANEL_OVERLAP(70) = -202
    const pageInfoPos = await getElementPosition(pageWindow, 'page-info-panel');
    const expectedLeftPanelLeft = MARGIN - PANEL_WIDTH + PANEL_OVERLAP; // 8 - 280 + 70 = -202
    expect(pageInfoPos.left).toBe(expectedLeftPanelLeft);

    // Check right panel position (e.g. tags-panel, entities-panel)
    // Expected left = webviewLeft(8) + webviewWidth - PANEL_OVERLAP(70)
    const webviewPos = await getElementPosition(pageWindow, 'content');
    const expectedRightPanelLeft = MARGIN + webviewPos.width - PANEL_OVERLAP;

    const tagsPanelPos = await getElementPosition(pageWindow, 'tags-panel');
    expect(tagsPanelPos.left).toBe(expectedRightPanelLeft);

    const entitiesPanelPos = await getElementPosition(pageWindow, 'entities-panel');
    expect(entitiesPanelPos.left).toBe(expectedRightPanelLeft);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 4: Resize handles at webview corners
  test('resize handles positioned at webview corners', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    const webviewPos = await getElementPosition(pageWindow, 'content');
    const handleSize = 24;

    // SE handle: bottom-right corner of webview
    const sePos = await getElementPosition(pageWindow, 'resize-se');
    expect(sePos.left).toBe(webviewPos.left + webviewPos.width - handleSize);
    expect(sePos.top).toBe(webviewPos.top + webviewPos.height - handleSize);

    // SW handle: bottom-left corner of webview
    const swPos = await getElementPosition(pageWindow, 'resize-sw');
    expect(swPos.left).toBe(webviewPos.left);
    expect(swPos.top).toBe(webviewPos.top + webviewPos.height - handleSize);

    // NE handle: top-right corner of webview
    const nePos = await getElementPosition(pageWindow, 'resize-ne');
    expect(nePos.left).toBe(webviewPos.left + webviewPos.width - handleSize);
    expect(nePos.top).toBe(webviewPos.top);

    // NW handle: top-left corner of webview
    const nwPos = await getElementPosition(pageWindow, 'resize-nw');
    expect(nwPos.left).toBe(webviewPos.left);
    expect(nwPos.top).toBe(webviewPos.top);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 5: URL params update on drag
  test('URL params update after drag completes', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Read initial URL params
    const initialParams = await pageWindow.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        x: parseInt(url.searchParams.get('x') || '0'),
        y: parseInt(url.searchParams.get('y') || '0'),
        width: parseInt(url.searchParams.get('width') || '0'),
        height: parseInt(url.searchParams.get('height') || '0'),
      };
    });

    // Simulate a drag by calling startDrag + mousemove + mouseup on the navbar
    // The navbar mousedown starts an instant drag
    await pageWindow.evaluate(() => {
      const navbar = document.getElementById('navbar') as HTMLElement;
      // Dispatch mousedown on navbar to start drag
      navbar.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        screenX: 400,
        screenY: 300,
        button: 0,
      }));

      // Dispatch mousemove to simulate dragging 50px right and 30px down
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        screenX: 450,
        screenY: 330,
      }));

      // Dispatch mouseup to end drag
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
      }));
    });

    // Wait for URL params to reflect the new position
    await pageWindow.waitForFunction(
      (origX: number) => {
        const url = new URL(window.location.href);
        const newX = parseInt(url.searchParams.get('x') || '0');
        return newX !== origX;
      },
      initialParams.x,
      { timeout: 5000 }
    );

    // Verify the URL params changed
    const updatedParams = await pageWindow.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        x: parseInt(url.searchParams.get('x') || '0'),
        y: parseInt(url.searchParams.get('y') || '0'),
      };
    });

    // The x should have increased by ~50 and y by ~30
    expect(updatedParams.x).not.toBe(initialParams.x);
    expect(updatedParams.y).not.toBe(initialParams.y);

    await closeWindow(sharedBgWindow, windowId);
  });
});

// ============================================================================
// New Behavior Tests (6-14): Will pass after maximize implementation
// These test maximize functionality that doesn't exist yet.
// ============================================================================

test.describe('Page Layout Maximize @desktop', () => {

  // Test 6: Maximize command fills work area
  // Will pass after maximize implementation
  test.skip('maximize command fills work area', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Publish maximize command
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
    }, windowId);

    // Window bounds should match the display work area
    const result = await pageWindow.evaluate(async () => {
      const bounds = await (window as any).app.window.getBounds();
      const displayInfo = await (window as any).app.invoke('get-display-info');
      return { bounds, workArea: displayInfo.workArea };
    });

    expect(result.bounds.x).toBe(result.workArea.x);
    expect(result.bounds.y).toBe(result.workArea.y);
    expect(result.bounds.width).toBe(result.workArea.width);
    expect(result.bounds.height).toBe(result.workArea.height);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 7: Maximize toggle restores original size
  // Will pass after maximize implementation
  test.skip('maximize toggle restores original size', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Record original bounds
    const originalBounds = await getWindowBounds(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
    }, windowId);

    // Wait for maximize state
    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Toggle back (restore)
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
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
  // Will pass after maximize implementation
  test.skip('webview fills window when maximized', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
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
  // Will pass after maximize implementation
  test.skip('navbar floats over webview when maximized', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
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
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
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
  // Will pass after maximize implementation
  test.skip('panels clamped to screen edges when maximized', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // Show navbar to reveal panels
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
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

  // Test 11: Resize handles hidden when maximized
  // Will pass after maximize implementation
  test.skip('resize handles hidden when maximized', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
    }, windowId);

    await pageWindow.waitForFunction(
      () => document.body.classList.contains('maximized'),
      undefined,
      { timeout: 5000 }
    );

    // All resize handles should be hidden
    const handlesHidden = await pageWindow.evaluate(() => {
      const handles = document.querySelectorAll('.resize-handle');
      return Array.from(handles).every((h) => {
        const style = window.getComputedStyle(h);
        return style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none';
      });
    });
    expect(handlesHidden).toBe(true);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Test 12: Drag out of maximized state restores
  // Will pass after maximize implementation
  test.skip('drag out of maximized state restores original size', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Record original bounds
    const originalBounds = await getWindowBounds(pageWindow);

    // Maximize
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
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
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
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
  // Will pass after maximize implementation
  test.skip('webview border-radius removed when maximized', async () => {
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
      (window as any).app.publish(
        'page:maximize',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
      );
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
  // Will pass after maximize implementation
  test.skip('double-click navbar triggers maximize', async () => {
    const { pageWindow, windowId } = await openCanvasPage(
      sharedBgWindow,
      'https://example.com'
    );

    await waitForPageReady(pageWindow);

    // Show navbar
    await sharedBgWindow.evaluate(async (wid: number) => {
      (window as any).app.publish(
        'page:show-navbar',
        { windowId: wid },
        (window as any).app.scopes.GLOBAL
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
