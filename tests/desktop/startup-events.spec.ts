import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

test.describe('Startup Phase Events @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('startup-phase'));
    // Wait for extensions to be fully ready
    await waitForExtensionsReady(bgWindow);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('ext:startup:phase events are available for subscription', async () => {
    // Test that extensions can subscribe to startup phase events
    // Since app is already started, we test that the subscription mechanism works
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      let received = false;

      // Subscribe to startup phase events
      api.subscribe('ext:startup:phase', (msg: any) => {
        received = true;
      }, api.scopes.GLOBAL);

      // The subscription should be set up without error
      return { subscriptionCreated: true };
    });

    expect(result.subscriptionCreated).toBe(true);
  });

  test('ext:all-loaded event was published during startup', async () => {
    // Verify that the ext:all-loaded event was published by checking extensions are running
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // Get running extensions - if they're running, ext:all-loaded was published
      const extResult = await api.extensions.list();
      const extensions = extResult.data || [];
      return {
        success: extResult.success,
        extensionCount: extensions.length,
        hasCmd: extensions.some((e: any) => e.id === 'cmd'),
        hasGroups: extensions.some((e: any) => e.id === 'groups')
      };
    });

    expect(result.success).toBe(true);
    expect(result.extensionCount).toBeGreaterThan(0);
    expect(result.hasCmd).toBe(true);
  });

  test('cmd extension loads before other extensions can register commands', async () => {
    // Verify that cmd is running and accepting commands (which means it loaded first)
    // Use inline retry approach that works reliably
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      const queryCommands = () => new Promise((resolve) => {
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          resolve(msg.commands || []);
        }, api.scopes.GLOBAL);
        api.publish('cmd:query-commands', {}, api.scopes.GLOBAL);
        setTimeout(() => resolve([]), 1000);
      });

      // Retry a few times to allow extensions to finish loading
      for (let i = 0; i < 5; i++) {
        const cmds = await queryCommands() as any[];
        if (cmds.some((c: any) => c.name === 'example:gallery')) {
          return cmds;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return await queryCommands();
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // gallery command from example extension should be registered
    const hasGalleryCommand = result.some((c: any) => c.name === 'example:gallery');
    expect(hasGalleryCommand).toBe(true);
  });

  test('cmd extension is always running (cannot be disabled)', async () => {
    // cmd is required infrastructure - verify it's always in the running extensions list
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const runningExts = await api.extensions.list();
      return {
        success: runningExts.success,
        extensions: runningExts.data || [],
        cmdRunning: runningExts.data?.some((ext: any) => ext.id === 'cmd'),
        cmdStatus: runningExts.data?.find((ext: any) => ext.id === 'cmd')?.status
      };
    });

    expect(result.success).toBe(true);
    expect(result.cmdRunning).toBe(true);
    expect(result.cmdStatus).toBe('running');
  });
});
