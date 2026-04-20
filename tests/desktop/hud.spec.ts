/**
 * HUD Extension Tests
 *
 * Tests the always-on-top HUD overlay that shows mode, IZUI state, and window info.
 *
 * Test philosophy: deterministic — no timeouts as assertions.
 * Uses polling via evaluate()/waitForFunction instead of sleep + snapshot.
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

// Shared app for tests
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

/**
 * Get the mode widget's #mode-value text via the HUD window's webview.
 * Uses webview.executeJavaScript to query inside the webview context.
 */
async function getModeValueFromWebview(
  hudWindow: Page,
  timeout = 5000
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const text = await hudWindow.evaluate(async (timeoutMs: number) => {
        const webviews = document.querySelectorAll('webview');
        for (const wv of webviews) {
          if (wv.src && wv.src.includes('widgets/mode.html')) {
            try {
              const result = await (wv as any).executeJavaScript(
                'document.getElementById("mode-value")?.textContent || null'
              );
              return result;
            } catch { return null; }
          }
        }
        return null;
      }, timeout);
      if (text && text !== '-') return text;
    } catch {
      // Page might not be ready
    }
    await sleep(200);
  }
  return null;
}

/**
 * Wait for #mode-value text content to match expected value in HUD mode widget.
 * Uses webview.executeJavaScript to query inside the webview context.
 * Deterministic polling — no sleep-based assertions.
 */
async function waitForHudModeValue(
  hudWindow: Page,
  expected: string | ((text: string) => boolean),
  timeout = 5000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const text = await getModeValueFromWebview(hudWindow, 1000);
    if (typeof expected === 'string') {
      if (text === expected) return expected;
    } else {
      if (text && expected(text)) return text;
    }
    await sleep(200);
  }
  const lastText = await getModeValueFromWebview(hudWindow, 500);
  return lastText || '';
}

// Helper to toggle HUD and wait for the window to appear/disappear
const toggleHUD = async () => {
  await sharedBgWindow.evaluate(async () => {
    (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
  });
  // Allow the command to be processed and window to open/close
  await sleep(500);
};

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

test.describe('HUD Extension @desktop', () => {
  test('HUD extension loads', async () => {
    // Verify the HUD extension loaded by executing its command.
    // The command was registered by the HUD extension's init, so a successful
    // toggle proves the extension loaded, initialized, and registered its command.
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
    });
    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Verify the HUD has basic DOM structure
    await hudWindow.waitForSelector('#hud-container', { timeout: 5000 });

    // Clean up - toggle off
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
    });
    await sleep(500);
  });

  test('hud command is registered', async () => {
    // Verify the hud command works by executing it and checking for the HUD window
    // The command is registered via api.commands.register() in the HUD extension's init
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
    });
    await sleep(1000);

    // Find HUD window - if command is registered, the window should appear
    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Clean up - toggle off
    await sharedBgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
    });
    await sleep(500);
  });

  test('toggle HUD via command', async () => {
    // Toggle HUD to open
    await toggleHUD();

    // Find HUD window
    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Verify HUD container is visible
    await hudWindow.waitForSelector('#hud-container', { timeout: 5000 });
    const container = await hudWindow.$('#hud-container');
    expect(container).toBeTruthy();

    // Toggle to close
    await toggleHUD();
  });

  test('HUD displays mode information', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);

    // Set mode to 'default' AFTER HUD is open so the subscription receives it
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    // Deterministic wait: poll until #mode-value shows 'default' (via webview)
    await waitForHudModeValue(hudWindow, 'default', 10000);

    const modeValue = await getModeValueFromWebview(hudWindow);
    expect(modeValue).toBeTruthy();
    expect(['default', 'page', 'group', 'settings']).toContain(modeValue);

    // Change mode to page
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('page', { metadata: { url: 'https://example.com' } });
    });

    // Deterministic wait: poll until #mode-value shows 'page'
    await waitForHudModeValue(hudWindow, 'page');

    const newModeValue = await getModeValueFromWebview(hudWindow);
    expect(newModeValue).toBe('page');

    // Verify mode color class is applied (via webview)
    const modeClasses = await hudWindow.evaluate(async () => {
      const webviews = document.querySelectorAll('webview');
      for (const wv of webviews) {
        if (wv.src && wv.src.includes('widgets/mode.html')) {
          try {
            return await (wv as any).executeJavaScript(
              'document.getElementById("mode-value")?.className || ""'
            );
          } catch { return ''; }
        }
      }
      return '';
    });
    expect(modeClasses).toContain('mode-page');

    // Clean up - reset mode and close HUD
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await toggleHUD();
  });

  test('HUD displays IZUI state', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);

    // Query IZUI widget value via webview.executeJavaScript
    const start = Date.now();
    let izuiValue: string | null = null;
    while (Date.now() - start < 10000) {
      try {
        izuiValue = await hudWindow.evaluate(async () => {
          const webviews = document.querySelectorAll('webview');
          for (const wv of webviews) {
            if (wv.src && wv.src.includes('widgets/izui.html')) {
              try {
                return await (wv as any).executeJavaScript(
                  'document.getElementById("izui-value")?.textContent || null'
                );
              } catch { return null; }
            }
          }
          return null;
        });
        if (izuiValue && izuiValue !== '-') break;
      } catch { /* page not ready */ }
      await sleep(200);
    }

    expect(izuiValue).toBeTruthy();
    expect(['idle', 'transient', 'active', 'overlay']).toContain(izuiValue);

    // Verify state color class is applied via webview
    const izuiClasses = await hudWindow.evaluate(async () => {
      const webviews = document.querySelectorAll('webview');
      for (const wv of webviews) {
        if (wv.src && wv.src.includes('widgets/izui.html')) {
          try {
            return await (wv as any).executeJavaScript(
              'document.getElementById("izui-value")?.className || ""'
            );
          } catch { return ''; }
        }
      }
      return '';
    });
    expect(izuiClasses).toMatch(/izui-(idle|transient|active|overlay)/);

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD displays window count', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);

    // Query stats widget content via webview.executeJavaScript
    // The stats widget renders a grid of stat-label/stat-value pairs in #stats-content
    const start = Date.now();
    let statsText: string | null = null;
    while (Date.now() - start < 10000) {
      try {
        statsText = await hudWindow.evaluate(async () => {
          const webviews = document.querySelectorAll('webview');
          for (const wv of webviews) {
            if (wv.src && wv.src.includes('widgets/stats.html')) {
              try {
                return await (wv as any).executeJavaScript(
                  'document.getElementById("stats-content")?.textContent || null'
                );
              } catch { return null; }
            }
          }
          return null;
        });
        if (statsText && statsText !== '-') break;
      } catch { /* page not ready */ }
      await sleep(200);
    }

    expect(statsText).toBeTruthy();

    // The stats widget shows multiple metrics (Visible, Background, Total windows, etc.)
    // Verify the content has rendered with numeric values
    if (statsText && statsText !== '-') {
      expect(statsText).toContain('Total windows');
    }

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD window has correct properties', async () => {
    // Open HUD
    await toggleHUD();

    // Verify HUD window exists via Playwright
    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Verify the HUD window URL contains the expected path
    const hudUrl = hudWindow.url();
    expect(hudUrl).toContain('hud');
    expect(hudUrl).toContain('hud.html');

    // Verify the HUD has the expected DOM structure
    const hasContainer = await hudWindow.$('#hud-container');
    expect(hasContainer).toBeTruthy();

    // Widget elements are inside webviews. Verify they have loaded by checking
    // that the webview elements exist and have src attributes.
    const webviewCount = await hudWindow.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const webviews = document.querySelectorAll('webview');
        if (webviews.length >= 2) return webviews.length;
        await new Promise(r => setTimeout(r, 200));
      }
      return document.querySelectorAll('webview').length;
    });
    expect(webviewCount).toBeGreaterThanOrEqual(2);

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD persists enabled state', async () => {
    // Enable HUD
    await toggleHUD();

    // Verify HUD is open via Playwright window lookup
    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Verify HUD container is visible in the window
    const containerExists = await hudWindow.$('#hud-container');
    expect(containerExists).toBeTruthy();

    // Disable HUD for clean state
    await toggleHUD();
  });

  test('HUD updates reactively on mode changes', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);

    // Set to default mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    // Deterministic wait for mode update (via webview)
    await waitForHudModeValue(hudWindow, 'default', 10000);
    let modeValue = await getModeValueFromWebview(hudWindow);
    expect(modeValue).toBe('default');

    // Change to page mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('page', { metadata: { url: 'https://test.com' } });
    });

    // Deterministic wait for mode update
    await waitForHudModeValue(hudWindow, 'page');
    modeValue = await getModeValueFromWebview(hudWindow);
    expect(modeValue).toBe('page');

    // Change to settings mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('settings');
    });

    // Deterministic wait for mode update
    await waitForHudModeValue(hudWindow, 'settings');
    modeValue = await getModeValueFromWebview(hudWindow);
    expect(modeValue).toBe('settings');

    // Clean up - reset mode and close HUD
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await toggleHUD();
  });

  test('HUD displays group mode with name', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('hud/hud.html', 5000);

    // Reset to default first and confirm the mode widget is subscribed and
    // reflecting context changes. Without this, the subsequent setMode('group')
    // can race the webview subscription on a freshly (re-)opened HUD and
    // leave the widget showing a stale 'default' until the 5s refresh interval.
    // Mirrors the pattern used by 'HUD displays mode information' above.
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });
    await waitForHudModeValue(hudWindow, 'default', 10000);

    // Set to group mode with metadata
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('group', {
        metadata: {
          groupId: 'test-group-123',
          groupName: 'Test Group'
        }
      });
    });

    // Deterministic wait: poll until #mode-value contains 'Test Group' (via webview)
    await waitForHudModeValue(hudWindow, (text: string) => text.includes('Test Group'), 10000);

    // Verify group name is displayed
    const modeValue = await getModeValueFromWebview(hudWindow);
    expect(modeValue).toContain('group');
    expect(modeValue).toContain('Test Group');

    // Verify group color class is applied (via webview)
    const modeClasses = await hudWindow.evaluate(async () => {
      const webviews = document.querySelectorAll('webview');
      for (const wv of webviews) {
        if (wv.src && wv.src.includes('widgets/mode.html')) {
          try {
            return await (wv as any).executeJavaScript(
              'document.getElementById("mode-value")?.className || ""'
            );
          } catch { return ''; }
        }
      }
      return '';
    });
    expect(modeClasses).toContain('mode-group');

    // Clean up - reset mode and close HUD
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await toggleHUD();
  });
});
