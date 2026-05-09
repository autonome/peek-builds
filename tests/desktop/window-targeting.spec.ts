import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { sleep } from '../helpers/window-utils';

// ============================================================================
// Window Targeting Tests
// ============================================================================
// Tests for the window focus tracking system that enables per-window commands
// like "theme dark here" to target the correct window.
//
// Key behavior: Modal windows (like cmd palette) should NOT update the
// "last focused visible window" tracker, so commands target the window
// the user was looking at before opening the palette.

test.describe('Window Targeting @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('window-targeting'));
    await sleep(500); // Wait for app to stabilize
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('getFocusedVisibleWindowId tracks the most recently focused non-modal window', async () => {
    // Regression for: when a search window is open in front of a page-host
    // (e.g. example.com), the maximize command was hitting the page-host
    // *behind* the search window. The bug surfaces if either
    // getFocusedVisibleWindowId returns a stale id or the maximize IPC
    // silently falls back to event.sender on a bad arg. This test pins
    // the expected behavior at the tracker layer.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // 1. Open an http content window. This becomes the "page-host
      //    behind" the search window in the user's repro.
      const back = await api.window.open('about:blank', {
        role: 'workspace',
        width: 600,
        height: 400,
        key: 'targeting-back',
      });
      if (!back.success) return { stage: 'open back', error: back.error };

      // Drive focus explicitly — opening a new window doesn't always
      // settle focus before we read the tracker in headless tests.
      await api.window.focus(back.id);
      await new Promise(r => setTimeout(r, 200));

      // 2. Open a "search-like" workspace window on top.
      const front = await api.window.open('about:blank', {
        role: 'workspace',
        width: 700,
        height: 500,
        key: 'targeting-front',
      });
      if (!front.success) return { stage: 'open front', error: front.error };
      await api.window.focus(front.id);
      await new Promise(r => setTimeout(r, 200));

      // 3. The tracker should now point at the front window.
      const tracked = await api.window.getFocusedVisibleWindowId();

      // Cleanup
      await api.window.close(back.id);
      await api.window.close(front.id);

      return { backId: back.id, frontId: front.id, tracked };
    });

    expect(result.error).toBeUndefined();
    expect(result.tracked).toBe(result.frontId);
    // And critically, NOT the back window:
    expect(result.tracked).not.toBe(result.backId);
  });

  test('maximize cmd targets the most recently opened workspace, not the one behind it', async () => {
    // Tighter reproduction of the user's bug report: opening a "back"
    // window and then a "front" workspace window without explicitly
    // calling api.window.focus on either, then running maximize, must
    // grow the front window (not the back one). If the natural focus
    // flow on window.open doesn't update the tracker, this fails — and
    // any "maximize" command that uses getFocusedVisibleWindowId hits
    // the wrong window.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      const back = await api.window.open('about:blank', {
        role: 'workspace',
        width: 600,
        height: 400,
        key: 'targeting-back-natural',
      });
      if (!back.success) return { stage: 'open back', error: back.error };
      await new Promise(r => setTimeout(r, 250));

      const front = await api.window.open('about:blank', {
        role: 'workspace',
        width: 700,
        height: 500,
        key: 'targeting-front-natural',
      });
      if (!front.success) return { stage: 'open front', error: front.error };
      await new Promise(r => setTimeout(r, 250));

      const tracked = await api.window.getFocusedVisibleWindowId();
      return { backId: back.id, frontId: front.id, tracked };
    });

    expect(result.error).toBeUndefined();
    // The freshly-opened front window should be tracked. If this fails,
    // the bug is at the focus-event-on-open layer — opening a window
    // doesn't reliably update lastFocusedVisibleWindowId, leaving stale
    // state from whatever was focused previously.
    expect(result.tracked).toBe(result.frontId);

    // Cleanup
    await bgWindow.evaluate(async (ids: { backId: number; frontId: number }) => {
      const api = (window as any).app;
      await api.window.close(ids.backId);
      await api.window.close(ids.frontId);
    }, { backId: result.backId as number, frontId: result.frontId as number });
  });

  test('opening the actual search tile after a content window updates the focus tracker', async () => {
    // Closer to the user repro: open a content window, then open the
    // search tile (peek://search/home.html with the manifest key
    // 'search-home'), and assert the tracker now points at search.
    // If the search tile's reuse flow or lazy-stub bootstrap doesn't
    // propagate focus correctly, this fails — explaining why the
    // 'maximize' command lands on the back content window.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      const back = await api.window.open('about:blank', {
        role: 'workspace',
        width: 600,
        height: 400,
        key: 'targeting-search-back',
      });
      if (!back.success) return { stage: 'open back', error: back.error };
      await new Promise(r => setTimeout(r, 250));

      const search = await api.window.open('peek://search/home.html', {
        role: 'workspace',
        width: 700,
        height: 500,
        key: 'search-home',
      });
      if (!search.success) return { stage: 'open search', error: search.error };
      await new Promise(r => setTimeout(r, 400));

      const tracked = await api.window.getFocusedVisibleWindowId();
      return { backId: back.id, searchId: search.id, tracked };
    });

    expect(result.error).toBeUndefined();
    expect(result.tracked).toBe(result.searchId);

    await bgWindow.evaluate(async (ids: { backId: number; searchId: number }) => {
      const api = (window as any).app;
      await api.window.close(ids.backId);
      await api.window.close(ids.searchId);
    }, { backId: result.backId as number, searchId: result.searchId as number });
  });

  test('focusing a tile window updates the tracker (regression: maximize-on-wrong-window)', async () => {
    // Bug: with a tile (e.g. tags, search) focused in front of a content
    // window, the maximize cmd hit the content window behind. Root cause:
    // tile-launcher.createTileBrowserWindow created BrowserWindows
    // without attaching the focus listener that updates
    // lastFocusedVisibleWindowId — so focusing a tile-launched window
    // never updated the tracker, leaving stale state from whatever
    // window-open path window was focused last.
    //
    // Production wires the listener via configureTileLauncher's
    // onWindowFocus hook. This test focuses a real tile window and
    // asserts the tracker reflects it.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // Open a content window first, focus it, so the tracker has a
      // non-tile baseline.
      const back = await api.window.open('about:blank', {
        role: 'workspace',
        width: 600,
        height: 400,
        key: 'targeting-tile-back',
      });
      if (!back.success) return { stage: 'open back', error: back.error };
      await api.window.focus(back.id);
      await new Promise(r => setTimeout(r, 200));

      // Open a tile (tags-home is a workspace tile that goes through
      // the tile-launcher createTileBrowserWindow path).
      const tile = await api.window.open('peek://tags/home.html', {
        role: 'workspace',
        width: 800,
        height: 600,
        key: 'tags-home',
      });
      if (!tile.success) return { stage: 'open tile', error: tile.error };
      await api.window.focus(tile.id);
      await new Promise(r => setTimeout(r, 250));

      const tracked = await api.window.getFocusedVisibleWindowId();
      return { backId: back.id, tileId: tile.id, tracked };
    });

    expect(result.error).toBeUndefined();
    expect(result.tracked).toBe(result.tileId);
    expect(result.tracked).not.toBe(result.backId);

    await bgWindow.evaluate(async (ids: { backId: number; tileId: number }) => {
      const api = (window as any).app;
      await api.window.close(ids.backId);
      await api.window.close(ids.tileId);
    }, { backId: result.backId as number, tileId: result.tileId as number });
  });

  test('maximize is non-toggling — calling twice keeps window maximized', async () => {
    // Regression: maximize used to toggle (maximize ↔ unmaximize), so a
    // double-fire (or running the cmd twice with no intervening user
    // action) would surprise the user. The contract is now: maximize
    // always maximizes; unmaximize always restores.
    const winId = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const r = await api.window.open('about:blank', {
        role: 'workspace',
        width: 600,
        height: 400,
        key: 'maximize-non-toggle',
      });
      if (!r.success) throw new Error('open failed: ' + r.error);
      await new Promise(res => setTimeout(res, 200));
      await api.window.maximize(r.id);
      await new Promise(res => setTimeout(res, 150));
      await api.window.maximize(r.id);
      await new Promise(res => setTimeout(res, 150));
      return r.id as number;
    });

    // "Maximized" here means the window fills the display work area —
    // production maximize uses `win.setBounds(workArea)` rather than
    // `win.maximize()`, so the WM never gets told the window is in its
    // maximized state. On macOS BrowserWindow.isMaximized() happens to
    // return true after setBounds-fills-workArea anyway, but on Linux
    // (X11/Wayland) isMaximized() reflects the real WM state and stays
    // false. Compare bounds against the work area directly so the
    // assertion has the same meaning across platforms.
    const isFillingWorkArea = (id: number) => app.evaluateMain!<boolean, number>(
      ({ BrowserWindow, screen }, wid) => {
        const w = BrowserWindow.fromId(wid);
        if (!w) return false;
        const b = w.getBounds();
        const wa = screen.getDisplayMatching(b).workArea;
        return b.x === wa.x && b.y === wa.y && b.width === wa.width && b.height === wa.height;
      },
      id,
    );

    const isMaxedAfterTwice = await isFillingWorkArea(winId);
    expect(isMaxedAfterTwice).toBe(true);

    // unmaximize → restored
    await bgWindow.evaluate(async (id) => {
      const api = (window as any).app;
      await api.window.unmaximize(id);
      await new Promise(res => setTimeout(res, 150));
    }, winId);

    const isMaxedAfterUnmax = await isFillingWorkArea(winId);
    expect(isMaxedAfterUnmax).toBe(false);

    // unmaximize again → still not maximized (no-op)
    await bgWindow.evaluate(async (id) => {
      const api = (window as any).app;
      await api.window.unmaximize(id);
      await new Promise(res => setTimeout(res, 150));
    }, winId);

    const isMaxedAfterUnmaxTwice = await isFillingWorkArea(winId);
    expect(isMaxedAfterUnmaxTwice).toBe(false);

    await bgWindow.evaluate(async (id) => {
      const api = (window as any).app;
      await api.window.close(id);
    }, winId);
  });

  test('unmaximize restores pre-maximize bounds', async () => {
    // Frameless / panel-style windows don't always flip Electron's
    // BrowserWindow.isMaximized() flag, so unmaximize() alone is a no-op
    // on them. The IPC stashes pre-maximize bounds in the window's
    // registry entry and restores via setBounds. This test pins that
    // behavior — open a window at a known size, maximize, unmaximize,
    // assert size matches the original.
    const winId = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const r = await api.window.open('about:blank', {
        role: 'workspace',
        width: 642,
        height: 437,
        key: 'unmaximize-restores-bounds',
      });
      if (!r.success) throw new Error('open failed: ' + r.error);
      await new Promise(res => setTimeout(res, 250));
      return r.id as number;
    });

    const readBounds = async (id: number) =>
      app.evaluateMain!<{ x: number; y: number; width: number; height: number } | null, number>(
        ({ BrowserWindow }, wid) => {
          const w = BrowserWindow.fromId(wid);
          return w ? w.getBounds() : null;
        },
        id,
      );

    const before = await readBounds(winId);
    await bgWindow.evaluate(async (id) => {
      await (window as any).app.window.maximize(id);
      await new Promise(res => setTimeout(res, 200));
    }, winId);
    const maxed = await readBounds(winId);
    await bgWindow.evaluate(async (id) => {
      await (window as any).app.window.unmaximize(id);
      await new Promise(res => setTimeout(res, 200));
    }, winId);
    const after = await readBounds(winId);

    await bgWindow.evaluate(async (id) => {
      await (window as any).app.window.close(id);
    }, winId);

    expect(before).not.toBeNull();
    expect(maxed).not.toBeNull();
    expect(after).not.toBeNull();
    // Maximized bounds should be larger than the original.
    expect(maxed!.width).toBeGreaterThan(before!.width);
    expect(maxed!.height).toBeGreaterThan(before!.height);
    // Post-unmaximize, bounds should match the pre-maximize snapshot.
    expect(after!.width).toBe(before!.width);
    expect(after!.height).toBe(before!.height);
    expect(after!.x).toBe(before!.x);
    expect(after!.y).toBe(before!.y);
  });

  test('setWindowColorScheme returns success with windowId', async () => {
    // Test that setWindowColorScheme works and returns expected data
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // Open a test window (non-modal) to have a valid target
      const winResult = await api.window.open('peek://app/settings/settings.html', {
        width: 400,
        height: 300,
        modal: false,
        key: 'test-theme-window-1'
      });

      if (!winResult.success) {
        return { success: false, error: 'Failed to open window' };
      }

      // Wait for window to be ready and focused
      await new Promise(r => setTimeout(r, 300));

      // Call setWindowColorScheme
      const themeResult = await api.theme.setWindowColorScheme('dark');

      // Clean up
      try {
        await api.window.close(winResult.id);
      } catch (e) {
        // Ignore close errors
      }

      return {
        success: themeResult.success,
        windowId: themeResult.windowId,
        colorScheme: themeResult.colorScheme,
        error: themeResult.error
      };
    });

    expect(result.success).toBe(true);
    expect(result.colorScheme).toBe('dark');
    expect(typeof result.windowId).toBe('number');
  });

  test('modal window does not become theme target', async () => {
    // This test verifies that opening a modal window after a non-modal window
    // still allows setWindowColorScheme to target the non-modal window
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // Open a non-modal window first
      const nonModalResult = await api.window.open('peek://app/settings/settings.html', {
        width: 400,
        height: 300,
        modal: false,
        key: 'test-nonmodal-target'
      });

      if (!nonModalResult.success) {
        return { success: false, error: 'Failed to open non-modal window' };
      }

      // Wait for it to focus
      await new Promise(r => setTimeout(r, 300));

      // Now open a modal window (simulating cmd palette behavior)
      const modalResult = await api.window.open('peek://app/settings/settings.html', {
        width: 300,
        height: 200,
        modal: true,
        key: 'test-modal-overlay'
      });

      if (!modalResult.success) {
        // Clean up non-modal
        try { await api.window.close(nonModalResult.id); } catch (e) {}
        return { success: false, error: 'Failed to open modal window' };
      }

      // Wait a bit for modal to be ready
      await new Promise(r => setTimeout(r, 200));

      // Now call setWindowColorScheme - should still target the NON-MODAL window
      const themeResult = await api.theme.setWindowColorScheme('light');

      // Clean up both windows
      try { await api.window.close(modalResult.id); } catch (e) {}
      try { await api.window.close(nonModalResult.id); } catch (e) {}

      return {
        success: themeResult.success,
        targetedWindowId: themeResult.windowId,
        nonModalWindowId: nonModalResult.id,
        modalWindowId: modalResult.id,
        // Key assertion: the targeted window should be the non-modal one
        targetedNonModal: themeResult.windowId === nonModalResult.id
      };
    });

    expect(result.success).toBe(true);
    // The theme command should have targeted the non-modal window, not the modal
    expect(result.targetedNonModal).toBe(true);
  });

  test('setWindowColorScheme with global resets override', async () => {
    // Test the 'global' value which should reset window-specific override
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // Open a test window
      const winResult = await api.window.open('peek://app/settings/settings.html', {
        width: 400,
        height: 300,
        modal: false,
        key: 'test-theme-reset-window'
      });

      if (!winResult.success) {
        return { success: false, error: 'Failed to open window' };
      }

      await new Promise(r => setTimeout(r, 300));

      // Set to dark first
      const darkResult = await api.theme.setWindowColorScheme('dark');

      // Then reset to global
      const globalResult = await api.theme.setWindowColorScheme('global');

      // Clean up
      try { await api.window.close(winResult.id); } catch (e) {}

      return {
        darkSuccess: darkResult.success,
        globalSuccess: globalResult.success,
        globalColorScheme: globalResult.colorScheme
      };
    });

    expect(result.darkSuccess).toBe(true);
    expect(result.globalSuccess).toBe(true);
    expect(result.globalColorScheme).toBe('global');
  });
});
