import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForWindow, waitForCommand } from '../helpers/window-utils';

test.describe('Core Functionality @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('core'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('app launches and extensions load', async () => {
    // App readiness, asserted WITHOUT relying on any lazy feature's
    // background window. peeks is now lazy (no resident entry) and is NOT in
    // the boot set, so we can't wait on peek://peeks/background.html here.
    //
    // Two independent readiness signals:
    //   1. The core orchestrator window (peek://app/background.html) — always
    //      resident — exists. This is what "app launched" means.
    //   2. peeks is registered in the builtin feature registry. features.list
    //      reads the registry, not the loaded-window set, so a LAZY (unloaded)
    //      tile still surfaces here — proving extensions loaded/registered.
    const coreWindow = await waitForWindow(
      () => app.windows(),
      'peek://app/background.html',
      15000
    );
    expect(coreWindow).toBeDefined();

    const builtins = await bgWindow.evaluate(async () => {
      return await (window as any).app.features.list('builtin');
    });
    const hasPeeks = builtins.entries?.some((ext: any) => ext.id === 'peeks');
    expect(hasPeeks).toBe(true);
  });

  test('database is accessible', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getStats();
    });
    expect(result.success).toBe(true);
    expect(typeof result.data.totalAddresses).toBe('number');
  });

  test('commands are registered', async () => {
    // Commands are owned by the cmd extension via pubsub. Synchronize on the
    // cmd:query-commands-response topic itself: subscribe once, then re-emit
    // the query whenever a response arrives that doesn't yet contain the
    // target command, and resolve the instant it does. No fixed-duration
    // waits — a single Playwright timeout bounds the whole thing
    // (per feedback_no_sleep_in_tests_or_code).
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      return await new Promise<any[]>((resolve) => {
        let done = false;
        const tryResolve = (cmds: any[]) => {
          if (done) return;
          if (cmds.some((c: any) => c.name === 'example:gallery')) {
            done = true;
            resolve(cmds);
          }
        };
        // Resolve as soon as a query response carries example:gallery.
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          tryResolve((msg.commands || []) as any[]);
        });
        // Re-query whenever a command (batch) registers — the deterministic
        // signal that the registry grew. This fires the response handler
        // above; no fixed-duration polling.
        api.subscribe('cmd:register', () => api.publish('cmd:query-commands', {}));
        api.subscribe('cmd:register-batch', () => api.publish('cmd:query-commands', {}));
        // Kick the first query (commands may already be registered from cache).
        api.publish('cmd:query-commands', {});
      });
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    // Should have gallery command from example extension
    const galleryCmd = result.find((c: any) => c.name === 'example:gallery');
    expect(galleryCmd).toBeTruthy();
  });

  test('quit and restart commands are registered', async () => {
    // quit/restart are registered asynchronously during app boot (app/index.js).
    // Poll via waitForCommand before querying details to avoid startup-race flake.
    await waitForCommand(bgWindow, 'quit', 10000);
    await waitForCommand(bgWindow, 'restart', 10000);

    // Query commands via cmd extension to verify descriptions
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          const commands = msg.commands || [];
          resolve({
            hasQuit: commands.some((c: any) => c.name === 'quit'),
            hasRestart: commands.some((c: any) => c.name === 'restart'),
            quitCmd: commands.find((c: any) => c.name === 'quit'),
            restartCmd: commands.find((c: any) => c.name === 'restart')
          });
        });
        api.publish('cmd:query-commands', {});
        setTimeout(() => resolve({ hasQuit: false, hasRestart: false }), 2000);
      });
    });

    expect(result.hasQuit).toBe(true);
    expect(result.hasRestart).toBe(true);
    expect(result.quitCmd?.description).toBe('Quit the application');
    expect(result.restartCmd?.description).toBe('Restart the application');
  });

  test('reload feature command is registered', async () => {
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          const commands = msg.commands || [];
          const reloadCmd = commands.find((c: any) => c.name === 'reload feature');
          resolve({
            hasReloadFeature: !!reloadCmd,
            description: reloadCmd?.description
          });
        });
        api.publish('cmd:query-commands', {});
        setTimeout(() => resolve({ hasReloadFeature: false }), 2000);
      });
    });

    expect(result.hasReloadFeature).toBe(true);
    expect(result.description).toBe('Reload an installed feature by ID');
  });

  test('api.quit and api.restart functions exist', async () => {
    const result = await bgWindow.evaluate(() => {
      const api = (window as any).app;
      return {
        hasQuit: typeof api.quit === 'function',
        hasRestart: typeof api.restart === 'function'
      };
    });

    expect(result.hasQuit).toBe(true);
    expect(result.hasRestart).toBe(true);
  });

  test('window management works', async () => {
    // Open a test window
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('about:blank', {
        width: 400,
        height: 300
      });
    });
    expect(openResult.success).toBe(true);
    expect(openResult.id).toBeDefined();

    // Wait for window to open
    await app.getWindow('about:blank', 5000);

    // List windows
    const listResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    expect(listResult.success).toBe(true);
    expect(Array.isArray(listResult.windows)).toBe(true);

    // Close the window
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, openResult.id);
  });
});
