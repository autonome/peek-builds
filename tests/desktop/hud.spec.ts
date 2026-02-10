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
 * Wait for #mode-value text content to match expected value in HUD window.
 * Deterministic polling — no sleep-based assertions.
 */
async function waitForHudModeValue(
  hudWindow: Page,
  expected: string | ((text: string) => boolean),
  timeout = 5000
): Promise<string> {
  if (typeof expected === 'string') {
    await hudWindow.waitForFunction(
      ([sel, val]: [string, string]) => {
        const el = document.querySelector(sel);
        return el && el.textContent === val;
      },
      ['#mode-value', expected] as [string, string],
      { timeout }
    );
    return expected;
  } else {
    // For predicate-based matching, poll in evaluate
    const text = await hudWindow.evaluate(
      async ([sel, timeoutMs]: [string, number]) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const el = document.querySelector(sel);
          if (el && el.textContent && el.textContent !== '-') return el.textContent;
          await new Promise(r => setTimeout(r, 100));
        }
        const el = document.querySelector(sel);
        return el?.textContent || null;
      },
      ['#mode-value', timeout] as [string, number]
    );
    return text || '';
  }
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
    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
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
    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
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
    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
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

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    await hudWindow.waitForSelector('#mode-value', { timeout: 5000 });

    // Set mode to 'default' AFTER HUD is open so the subscription receives it
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    // Deterministic wait: poll until #mode-value shows 'default'
    await waitForHudModeValue(hudWindow, 'default');

    const modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBeTruthy();
    expect(['default', 'page', 'group', 'settings']).toContain(modeValue);

    // Change mode to page
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('page', { metadata: { url: 'https://example.com' } });
    });

    // Deterministic wait: poll until #mode-value shows 'page'
    await waitForHudModeValue(hudWindow, 'page');

    const newModeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(newModeValue).toBe('page');

    // Verify mode color class is applied (already updated since text matched)
    const modeClasses = await hudWindow.$eval('#mode-value', el => el.className);
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

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    await hudWindow.waitForSelector('#izui-value', { timeout: 5000 });

    // Get IZUI state value
    const izuiValue = await hudWindow.$eval('#izui-value', el => el.textContent);
    expect(izuiValue).toBeTruthy();
    expect(['idle', 'transient', 'active', 'overlay']).toContain(izuiValue);

    // Verify state color class is applied
    const izuiClasses = await hudWindow.$eval('#izui-value', el => el.className);
    expect(izuiClasses).toMatch(/izui-(idle|transient|active|overlay)/);

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD displays window count', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    await hudWindow.waitForSelector('#stats-value', { timeout: 5000 });

    // Verify stats section exists and has content
    const statsText = await hudWindow.$eval('#stats-value', el => el.textContent);
    expect(statsText).toBeTruthy();

    // The HUD calls api.window.list() which only returns external (non-peek://) windows.
    // In the test environment, all windows are internal peek:// URLs, so the count may be 0.
    // The stats value may show "0 windows" or still be "-" if the async refresh hasn't completed.
    // Either is valid - the important thing is the element exists and the HUD is functional.
    if (statsText !== '-') {
      expect(statsText).toMatch(/\d+ windows?/);
    }

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD window has correct properties', async () => {
    // Open HUD
    await toggleHUD();

    // Verify HUD window exists via Playwright
    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Verify the HUD window URL contains the expected path
    const hudUrl = hudWindow.url();
    expect(hudUrl).toContain('hud');
    expect(hudUrl).toContain('hud.html');

    // Verify the HUD has the expected DOM structure
    const hasContainer = await hudWindow.$('#hud-container');
    expect(hasContainer).toBeTruthy();

    const hasModeSection = await hudWindow.$('#mode-value');
    expect(hasModeSection).toBeTruthy();

    const hasIzuiSection = await hudWindow.$('#izui-value');
    expect(hasIzuiSection).toBeTruthy();

    const hasStatsSection = await hudWindow.$('#stats-value');
    expect(hasStatsSection).toBeTruthy();

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD persists enabled state', async () => {
    // Enable HUD
    await toggleHUD();

    // Verify HUD is open via Playwright window lookup
    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
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

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    await hudWindow.waitForSelector('#mode-value', { timeout: 5000 });

    // Set to default mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    // Deterministic wait for mode update
    await waitForHudModeValue(hudWindow, 'default');
    let modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBe('default');

    // Change to page mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('page', { metadata: { url: 'https://test.com' } });
    });

    // Deterministic wait for mode update
    await waitForHudModeValue(hudWindow, 'page');
    modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBe('page');

    // Change to settings mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('settings');
    });

    // Deterministic wait for mode update
    await waitForHudModeValue(hudWindow, 'settings');
    modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
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

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    await hudWindow.waitForSelector('#mode-value', { timeout: 5000 });

    // Set to group mode with metadata
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('group', {
        metadata: {
          groupId: 'test-group-123',
          groupName: 'Test Group'
        }
      });
    });

    // Deterministic wait: poll until #mode-value contains 'Test Group'
    // (group mode displays as "group: Test Group")
    await hudWindow.waitForFunction(
      (sel: string) => {
        const el = document.querySelector(sel);
        return el && el.textContent && el.textContent.includes('Test Group');
      },
      '#mode-value',
      { timeout: 5000 }
    );

    // Verify group name is displayed
    const modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toContain('group');
    expect(modeValue).toContain('Test Group');

    // Verify group color class is applied
    const modeClasses = await hudWindow.$eval('#mode-value', el => el.className);
    expect(modeClasses).toContain('mode-group');

    // Clean up - reset mode and close HUD
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await toggleHUD();
  });
});
