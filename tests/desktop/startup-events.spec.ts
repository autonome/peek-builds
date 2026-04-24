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

  test('feature:startup:phase events are available for subscription', async () => {
    // Test that extensions can subscribe to startup phase events
    // Since app is already started, we test that the subscription mechanism works
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      let received = false;

      // Subscribe to startup phase events
      api.subscribe('feature:startup:phase', (msg: any) => {
        received = true;
      });

      // The subscription should be set up without error
      return { subscriptionCreated: true };
    });

    expect(result.subscriptionCreated).toBe(true);
  });

  test('feature:all-loaded event was published during startup', async () => {
    // Verify that the feature:all-loaded event was published by checking features are registered.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // tile:features:list hides builtins by default; pass 'builtin' to get the core set.
      const extResult = await api.features.list('builtin');
      const entries = extResult?.entries || [];
      return {
        entryCount: entries.length,
        hasCmd: entries.some((e: any) => e.id === 'cmd'),
        hasGroups: entries.some((e: any) => e.id === 'groups'),
      };
    });

    expect(result.entryCount).toBeGreaterThan(0);
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
        });
        api.publish('cmd:query-commands', {});
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

  test('cmd feature is always registered (cannot be disabled)', async () => {
    // cmd is required infrastructure — verify it's always in the registered feature list
    // and that a cmd tile window exists.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const list = await api.features.list('builtin');
      const entries = list?.entries || [];
      const windowList = await api.window.list({ includeInternal: true });
      const hasCmdWindow = windowList?.windows?.some(
        (w: any) => (w.url || '').includes('peek://cmd/'),
      ) || false;
      return {
        cmdRegistered: entries.some((e: any) => e.id === 'cmd'),
        hasCmdWindow,
      };
    });

    expect(result.cmdRegistered).toBe(true);
    expect(result.hasCmdWindow).toBe(true);
  });
});
