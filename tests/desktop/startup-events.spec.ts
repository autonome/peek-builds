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
    // cmd is a core renderer (lives in app/cmd, no features/cmd manifest) and does NOT
    // appear in the feature registry — assert against an actual builtin feature instead.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // tile:features:list hides builtins by default; pass 'builtin' to get the core set.
      const extResult = await api.features.list('builtin');
      const entries = extResult?.entries || [];
      return {
        entryCount: entries.length,
        hasGroups: entries.some((e: any) => e.id === 'groups'),
      };
    });

    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.hasGroups).toBe(true);
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

  test('cmd is always running (core renderer, cannot be disabled)', async () => {
    // cmd is required infrastructure — it's a core renderer (NOT a registry feature
    // and NOT a window at startup; the panel window is created on demand). Verify
    // the cmd registry is alive by querying for any registered command.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      return new Promise((resolve) => {
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          const commands = msg?.commands || [];
          resolve({ commandCount: commands.length });
        });
        api.publish('cmd:query-commands', {});
        setTimeout(() => resolve({ commandCount: 0 }), 2000);
      });
    });

    expect(result.commandCount).toBeGreaterThan(0);
  });
});
