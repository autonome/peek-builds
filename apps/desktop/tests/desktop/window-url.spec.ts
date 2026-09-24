/**
 * Window URL Loading and Reuse Tests
 *
 * Tests that:
 * - Opening an http/https URL creates a window and returns success
 * - Opening the same URL twice reuses the existing window (findHybridWindowsByUrl)
 * - Opening two different URLs creates two separate windows
 * - Key-based window reuse still works alongside URL-based reuse
 *
 * Run with:
 *   yarn test:electron -- --grep "Window URL"
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
// Helper: Open a web URL via the window API and return the result
// ============================================================================

async function openUrl(
  bgWindow: Page,
  url: string,
  options: Record<string, unknown> = {}
): Promise<{ success: boolean; id: number; reused?: boolean }> {
  const result = await bgWindow.evaluate(
    async ({ url, options }: { url: string; options: Record<string, unknown> }) => {
      return await (window as any).app.window.open(url, {
        width: 800,
        height: 600,
        ...options,
      });
    },
    { url, options }
  );
  return result;
}

// ============================================================================
// Helper: Close a window by ID
// ============================================================================

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  await bgWindow.evaluate(async (id: number) => {
    return await (window as any).app.window.close(id);
  }, windowId);
}

// ============================================================================
// Window URL Tests
// ============================================================================

test.describe('Window URL Loading @desktop', () => {
  test('opening an https URL creates a window', async () => {
    const url = 'https://example.com/url-create-test';
    const result = await openUrl(sharedBgWindow, url);

    expect(result.success).toBe(true);
    expect(result.id).toBeTruthy();
    expect(result.reused).toBeFalsy();

    // Clean up
    await closeWindow(sharedBgWindow, result.id);
  });

  test('opening the same URL twice reuses the existing window', async () => {
    const url = 'https://example.com/reuse-test';

    // Open the first window
    const result1 = await openUrl(sharedBgWindow, url);
    expect(result1.success).toBe(true);
    expect(result1.id).toBeTruthy();
    expect(result1.reused).toBeFalsy();

    // Open the same URL again -- should reuse
    const result2 = await openUrl(sharedBgWindow, url);
    expect(result2.success).toBe(true);
    expect(result2.reused).toBe(true);
    expect(result2.id).toBe(result1.id);

    // Clean up
    await closeWindow(sharedBgWindow, result1.id);
  });

  test('opening two different URLs creates two separate windows', async () => {
    const url1 = 'https://example.com/page-one';
    const url2 = 'https://example.org/page-two';

    // Open first URL
    const result1 = await openUrl(sharedBgWindow, url1);
    expect(result1.success).toBe(true);
    expect(result1.reused).toBeFalsy();

    // Open second URL -- should create a new window, not reuse
    const result2 = await openUrl(sharedBgWindow, url2);
    expect(result2.success).toBe(true);
    expect(result2.reused).toBeFalsy();
    expect(result2.id).not.toBe(result1.id);

    // Clean up both windows
    await closeWindow(sharedBgWindow, result1.id);
    await closeWindow(sharedBgWindow, result2.id);
  });

  test('opening a URL with a key does NOT reuse a keyless window with the same URL', async () => {
    // Regression: slides set address=http://localhost/ and key=address:edge.
    // When a page-host already has http://localhost/ open (no key), pressing
    // Option+Up used to fall through key-reuse → URL-reuse → got attached to
    // the page-host's window instead of opening a fresh edge-anchored slide.
    // An explicit key signals "I manage identity by key" — URL-reuse must skip.
    const url = 'https://example.com/keyless-vs-keyed';

    // Open WITHOUT a key (the "existing page-host" stand-in)
    const keylessResult = await openUrl(sharedBgWindow, url);
    expect(keylessResult.success).toBe(true);
    expect(keylessResult.reused).toBeFalsy();

    // Open SAME URL but WITH a key — must NOT reuse the keyless window
    const keyedResult = await openUrl(sharedBgWindow, url, { key: 'keyed-slot-A' });
    expect(keyedResult.success).toBe(true);
    expect(keyedResult.reused).toBeFalsy();
    expect(keyedResult.id).not.toBe(keylessResult.id);

    // Opening with the same key again reuses the keyed window (key-reuse)
    const keyedAgain = await openUrl(sharedBgWindow, url, { key: 'keyed-slot-A' });
    expect(keyedAgain.success).toBe(true);
    expect(keyedAgain.reused).toBe(true);
    expect(keyedAgain.id).toBe(keyedResult.id);

    // Clean up
    await closeWindow(sharedBgWindow, keylessResult.id);
    await closeWindow(sharedBgWindow, keyedResult.id);
  });

  test('key-based window reuse still works', async () => {
    const url = 'https://example.com/key-test';
    const key = 'test-key-reuse';

    // Open a window with a key
    const result1 = await openUrl(sharedBgWindow, url, { key });
    expect(result1.success).toBe(true);
    expect(result1.id).toBeTruthy();
    expect(result1.reused).toBeFalsy();

    // Open a different URL with the same key -- key-based reuse should take priority
    const url2 = 'https://example.com/key-test-different';
    const result2 = await openUrl(sharedBgWindow, url2, { key });
    expect(result2.success).toBe(true);
    expect(result2.reused).toBe(true);
    expect(result2.id).toBe(result1.id);

    // Clean up
    await closeWindow(sharedBgWindow, result1.id);
  });
});
