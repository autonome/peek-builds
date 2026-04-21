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
