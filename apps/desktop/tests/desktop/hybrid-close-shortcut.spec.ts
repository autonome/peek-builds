import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Regression R1 (Cluster B, peek item ca4ee5e6), 2026-06-08.
 *
 * When the hybrid page-host became the DEFAULT web-page renderer, cmd+W stopped
 * closing a focused page-host. The old canvas page-host was a BrowserWindow, so
 * the "Close Window" menu item's `BrowserWindow.getFocusedWindow()` resolved it.
 * A hybrid host is a `BaseWindow`, which `getFocusedWindow()` NEVER returns
 * (null), so the close handler no-op'd. Even with the right id, the close path
 * (`closeOrHideWindow` → `getLiveWindow` → `BrowserWindow.fromId`) couldn't
 * resolve a BaseWindow either — a two-layer break.
 *
 * The fix: cmd+W's handler (menu item on darwin, system local shortcut
 * elsewhere) calls `closeFocusedWindow()`, which resolves a focused
 * BrowserWindow OR — when there is none — the registry's active-hybrid window
 * (A's `getActiveHybridWindowId`), and `closeOrHideWindow` falls through to the
 * hybrid BaseWindow close path when `getLiveWindow` returns null.
 *
 * Focus-free: a macOS-headless run never grants real OS focus, so we assert the
 * RESOLUTION + close path via the test bridge. The condition we reproduce —
 * `getFocusedWindow()` is null while a hybrid window is the registry's active
 * one — is exactly the real-world "hybrid host frontmost" state.
 */
test.describe('Hybrid page-host cmd+W close (R1) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-close-shortcut'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // The prerequisite condition: a hybrid host is the active window, but
  // getFocusedWindow() reports null (it can't see BaseWindows). This is what
  // broke the old getFocusedWindow()-based close handler.
  test('getFocusedWindow() is null while a hybrid host is the active window', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const probe = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 120, y: 130, width: 640, height: 480 });
      await b.loadFakeContent(id, 'data:text/html,<title>Close Me</title>x');
      b.setActive(id);
      return {
        id,
        active: b.activeId(),
        focusedBrowserWindowId: b.focusedBrowserWindowId(),
      };
    });

    expect(probe.active).toBe(probe.id);
    // The BaseWindow is the active hybrid window, yet getFocusedWindow() is
    // null — the exact reason cmd+W's old handler had nothing to close.
    expect(probe.focusedBrowserWindowId).toBeNull();
  });

  // cmd+W's resolve-and-close path closes the focused hybrid host even though
  // getFocusedWindow() returns null for it.
  test('closeFocusedWindow() closes the active hybrid host (cmd+W path)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 200, y: 210, width: 600, height: 420 });
      await b.loadFakeContent(id, 'data:text/html,<title>Close Me</title>x');
      b.setActive(id);
      const existedBefore = b.hybridWindowExists(id);
      // Drive the exact cmd+W close path (menu item / non-darwin shortcut both
      // call closeFocusedWindow). No real BrowserWindow is focused (headless),
      // so it must resolve the active hybrid window and close it.
      const closedId = b.closeFocusedWindow();
      const existsAfter = b.hybridWindowExists(id);
      return { id, existedBefore, closedId, existsAfter };
    });

    expect(result.existedBefore).toBe(true);
    // closeFocusedWindow resolved + targeted the hybrid host (not null).
    expect(result.closedId).toBe(result.id);
    // And the hybrid BaseWindow is now gone.
    expect(result.existsAfter).toBe(false);
  });
});
