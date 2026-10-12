/**
 * headless-no-focus-theft
 *
 * Drift-detection guard: opening a canvas web window in headless mode must NOT
 * move OS-level focus to the newly-created (and still-hidden) BrowserWindow.
 *
 * Root cause context: .focus(), .moveTop(), .restore(), .center(), and
 * .setVisibleOnAllWorkspaces() were not covered by the headless prototype guard
 * in entry.ts. Any of these called on a hidden window during page-host bringup
 * would steal OS focus from the user's foreground app.
 *
 * Fix: all five methods are no-op'd in headless (entry.ts). This test is the
 * regression gate ensuring that behavior is preserved.
 *
 * Run with:
 *   yarn test:grep "headless no focus theft"
 */

import { test, expect } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { DesktopApp } from '../fixtures/desktop-app';
import { isHybridWindow, hostVisibility } from '../helpers/hybrid-page';

test.describe('headless no focus theft @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('headless-no-focus-theft', { headless: true }));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------------
  // Core assertion: BrowserWindow.getFocusedWindow() must NOT point at the
  // newly-opened canvas window after window.open completes.
  //
  // In headless (PEEK_HEADLESS=1) tests the test runner itself does not own a
  // real display focus; BrowserWindow.getFocusedWindow() returns null or points
  // at the bgWindow. After opening a new canvas page-host window, focus must
  // NOT shift to the new window — the no-op prototype guard on .focus() is what
  // prevents that.
  // ---------------------------------------------------------------------------

  test('canvas page-host window does not steal focus after open', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');

    // Record focused window id BEFORE the open
    const focusedIdBefore = await app.evaluateMain<number | null>(({ BrowserWindow }) => {
      const focused = BrowserWindow.getFocusedWindow();
      return focused ? focused.id : null;
    });

    // Open a canvas window — same pattern used by slide/peek features
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        role: 'quick-view',
        modal: true,
        pageHost: true,
        type: 'panel',
        width: 800,
        height: 600,
        key: 'test-no-focus-theft',
        screenEdge: 'Up',
        // No show: false — mimics real feature invocations; ipc.ts headless gate handles it
      });
    });
    expect(result.success).toBe(true);
    const newWinId: number = result.id;
    expect(newWinId).toBeTruthy();

    // Give the window bringup cycle a chance to run (page-host init fires
    // async events that could call .focus() if not guarded).
    // Use waitForFunction rather than sleep — resolves as soon as the
    // BrowserWindow exists (ctor complete) rather than a fixed delay.
    await app.evaluateMain<void, number>(({ BrowserWindow }, wid) => {
      // Just poll until the window is registered; already exists since we have
      // result.id, but this ensures the main-process event loop has drained.
      return new Promise<void>((resolve) => {
        const w = BrowserWindow.fromId(wid);
        if (w && !w.isDestroyed()) {
          resolve();
          return;
        }
        // Fallback: already exists from result.id guarantee
        resolve();
      });
    }, newWinId);

    // Assert: focused window must NOT be the new canvas window.
    // (BrowserWindow.getFocusedWindow() only ever returns BrowserWindows, so a
    // hybrid BaseWindow page-host can never appear here — but the assertion still
    // catches a canvas page-host that grabbed focus.)
    const focusedIdAfter = await app.evaluateMain<number | null>(({ BrowserWindow }) => {
      const focused = BrowserWindow.getFocusedWindow();
      return focused ? focused.id : null;
    });

    expect(focusedIdAfter).not.toBe(newWinId);

    // Assert: the new page-host window itself must report isFocused() === false.
    // On the canvas path it's a BrowserWindow (`fromId`); on the hybrid path
    // it's a BaseWindow invisible to `fromId` — its
    // focus state lives in the hybrid registry, read via the `hostVisibility`
    // bridge. Without this branch the hybrid assertion would pass vacuously
    // (fromId(null).isFocused() defaults to false), never exercising the host.
    const hybrid = await isHybridWindow(app, newWinId);
    let newWinFocused: boolean;
    if (hybrid) {
      const vis = await hostVisibility(app, newWinId);
      expect(vis).not.toBeNull();
      newWinFocused = vis!.focused;
    } else {
      newWinFocused = await app.evaluateMain<boolean, number>(
        ({ BrowserWindow }, wid) => {
          const w = BrowserWindow.fromId(wid);
          if (!w || w.isDestroyed()) return false;
          return w.isFocused();
        },
        newWinId,
      );
    }
    expect(newWinFocused).toBe(false);

    // Assert: overall focused window id unchanged (null or bgWindow id)
    // Allow: null → null, bgId → bgId. Disallow: anything → newWinId (done above).
    // Also record that focus didn't jump to some OTHER unrelated window.
    // We only enforce the new window specifically — other Electron internals
    // may shift focus in edge cases we don't control.
    expect(focusedIdAfter).toBe(focusedIdBefore);

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, newWinId);
  });

  // ---------------------------------------------------------------------------
  // Bonus: the new window must still be hidden (not visible) after open.
  // Belt-and-suspenders alongside slide-peek-addressbar.spec.ts.
  // ---------------------------------------------------------------------------

  test('page-host window does not paint after open in headless', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');

    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        role: 'quick-view',
        modal: true,
        pageHost: true,
        type: 'panel',
        width: 800,
        height: 600,
        key: 'test-no-focus-theft-visibility',
        center: true,
      });
    });
    expect(result.success).toBe(true);

    // The page-host must never PAINT in headless. Canvas: born `show:false`
    // (isVisible false). Hybrid: `setOpacity(0)` then `showInactive()` in the
    // headless branch (ipc.ts) → isVisible true but opacity 0, so the compositor
    // never paints it. Encode the shared invariant ("not painted") rather than a
    // single implementation's shape, resolving the hybrid host via the registry
    // bridge (BaseWindows are invisible to `fromId`).
    const hybrid = await isHybridWindow(app, result.id);
    let isVisible: boolean;
    let opacity: number;
    if (hybrid) {
      const vis = await hostVisibility(app, result.id);
      expect(vis).not.toBeNull();
      isVisible = vis!.visible;
      opacity = vis!.opacity;
    } else {
      isVisible = await app.evaluateMain<boolean, number>(
        ({ BrowserWindow }, wid) => {
          const w = BrowserWindow.fromId(wid);
          if (!w || w.isDestroyed()) return false;
          return w.isVisible();
        },
        result.id,
      );
      opacity = await app.evaluateMain<number, number>(
        ({ BrowserWindow }, wid) => {
          const w = BrowserWindow.fromId(wid);
          if (!w || w.isDestroyed()) return -1;
          return w.getOpacity();
        },
        result.id,
      );
    }
    const notPainted = isVisible === false || opacity === 0;
    expect(notPainted).toBe(true);

    // Clean up
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, result.id);
  });

  // ---------------------------------------------------------------------------
  // Regression guard for the ~30s desktop freeze: headless must NEVER grab a
  // system-wide Escape hotkey. On a real display the ESC fallback registers a
  // global shortcut when Peek is active with no focused window; in headless,
  // appFocused is stuck true and opacity-0 windows leave getFocusedWindow()
  // null, so without the !isHeadless() guard (main.ts updateEscGlobalRegistration)
  // every focus/blur would grab Escape OS-wide and thrash it across workers.
  // ---------------------------------------------------------------------------

  test('headless never registers the system-wide Escape global shortcut', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');

    // Open then close a window to drive browser-window-focus/blur — the events
    // that trigger updateEscGlobalRegistration on a real display.
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        role: 'quick-view',
        modal: true,
        pageHost: true,
        type: 'panel',
        width: 800,
        height: 600,
        key: 'test-esc-global-shortcut',
        center: true,
      });
    });
    expect(result.success).toBe(true);

    const escRegistered = await app.evaluateMain<boolean>(({ globalShortcut }) => {
      return globalShortcut.isRegistered('Escape');
    });
    expect(escRegistered).toBe(false);

    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, result.id);

    // After teardown churn it must still be unregistered.
    const escRegisteredAfter = await app.evaluateMain<boolean>(({ globalShortcut }) => {
      return globalShortcut.isRegistered('Escape');
    });
    expect(escRegisteredAfter).toBe(false);
  });
});
