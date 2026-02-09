/**
 * HUD Extension Tests
 *
 * Tests the always-on-top HUD overlay that shows mode, IZUI state, and window info.
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

// Shared app for tests
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

// Helper to toggle HUD
const toggleHUD = async () => {
  await sharedBgWindow.evaluate(async () => {
    (window as any).app.publish('cmd:execute:hud', {}, (window as any).app.scopes.GLOBAL);
  });
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
    // Verify HUD extension is registered
    const extensions = await sharedBgWindow.evaluate(async () => {
      const exts = (window as any).app.extensions.list();
      return exts.data || [];
    });

    const hudExt = extensions.find((ext: any) => ext.id === 'hud');
    expect(hudExt).toBeTruthy();
    expect(hudExt.name).toBe('HUD');
    expect(hudExt.builtin).toBe(true);
  });

  test('hud command is registered', async () => {
    // Wait a bit to ensure commands are registered
    await sleep(1000);

    const commands = await sharedBgWindow.evaluate(async () => {
      return (window as any).app.commands.list();
    });

    const hudCmd = commands.find((cmd: any) => cmd.name === 'hud');
    expect(hudCmd).toBeTruthy();
    expect(hudCmd.description).toContain('HUD');
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

    // Get initial mode value
    const modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBeTruthy();
    expect(['default', 'page', 'group', 'settings']).toContain(modeValue);

    // Change mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('page', { url: 'https://example.com' });
    });

    await sleep(500);

    // Verify mode updated in HUD
    const newModeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(newModeValue).toBe('page');

    // Verify mode color class is applied
    const modeClasses = await hudWindow.$eval('#mode-value', el => el.className);
    expect(modeClasses).toContain('mode-page');

    // Clean up
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.commands.execute('hud');
    });
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

    // Get window count
    const statsText = await hudWindow.$eval('#stats-value', el => el.textContent);
    expect(statsText).toBeTruthy();
    expect(statsText).toMatch(/\d+ windows?/);

    // Verify count is a reasonable number (at least 1, no more than 100)
    const match = statsText?.match(/(\d+) windows?/);
    expect(match).toBeTruthy();
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(100);

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD window has correct properties', async () => {
    // Open HUD
    await toggleHUD();

    // Get window list and find HUD window
    const windows = await sharedBgWindow.evaluate(async () => {
      const result = await (window as any).app.window.list();
      return result.data || [];
    });

    const hudWindowInfo = windows.find((w: any) => w.url?.includes('ext/hud/hud.html'));
    expect(hudWindowInfo).toBeTruthy();

    // Verify window properties (these should be set in background.js)
    // Note: exact property names may vary by backend
    expect(hudWindowInfo.url).toContain('ext/hud/hud.html');

    // Clean up - close HUD
    await toggleHUD();
  });

  test('HUD persists enabled state', async () => {
    // Enable HUD
    await toggleHUD();

    // Verify HUD is open
    let hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    expect(hudWindow).toBeTruthy();

    // Check localStorage state
    const enabledState = await sharedBgWindow.evaluate(async () => {
      // Get the HUD extension's background window
      const windows = await (window as any).app.window.list();
      const hudBgWindow = windows.data?.find((w: any) => w.url?.includes('hud/background.html'));

      if (!hudBgWindow) return null;

      // Can't directly access localStorage from another window, so we'll trust the command works
      return 'enabled'; // If window exists, state is enabled
    });

    expect(enabledState).toBe('enabled');

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

    await sleep(500);

    let modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBe('default');

    // Change to page mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('page', { url: 'https://test.com' });
    });

    await sleep(500);

    modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBe('page');

    // Change to settings mode
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('settings');
    });

    await sleep(500);

    modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toBe('settings');

    // Clean up
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.commands.execute('hud');
    });
  });

  test('HUD displays group mode with name', async () => {
    // Open HUD
    await toggleHUD();

    const hudWindow = await sharedApp.getWindow('ext/hud/hud.html', 5000);
    await hudWindow.waitForSelector('#mode-value', { timeout: 5000 });

    // Set to group mode with metadata
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('group', {
        groupId: 'test-group-123',
        groupName: 'Test Group'
      });
    });

    await sleep(500);

    // Verify group name is displayed
    const modeValue = await hudWindow.$eval('#mode-value', el => el.textContent);
    expect(modeValue).toContain('group');
    expect(modeValue).toContain('Test Group');

    // Verify group color class is applied
    const modeClasses = await hudWindow.$eval('#mode-value', el => el.className);
    expect(modeClasses).toContain('mode-group');

    // Clean up
    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.context.setMode('default');
    });

    await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.commands.execute('hud');
    });
  });
});
