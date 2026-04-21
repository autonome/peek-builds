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
    // After v2 tile migration:
    // - V2 features load as separate background BrowserWindows (peek://{id}/background.html)
    // - Eager v2 features (e.g. entities, peeks, slides) launch at startup;
    //   lazy v2 features (e.g. example) launch on first command/event

    // Check that at least one eager v2 background tile window exists.
    // peeks and slides are eager v2 background tiles that launch at startup.
    const v2BgWindow = await waitForWindow(
      () => app.windows(),
      'peek://peeks/background.html',
      15000
    );
    expect(v2BgWindow).toBeDefined();
  });

  test('database is accessible', async () => {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.getStats();
    });
    expect(result.success).toBe(true);
    expect(typeof result.data.totalAddresses).toBe('number');
  });

  test('commands are registered', async () => {
    // Commands are now owned by the cmd extension via pubsub
    // Query via cmd:query-commands topic with retry for extension loading
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
        }, api.scopes.GLOBAL);
        api.publish('cmd:query-commands', {}, api.scopes.GLOBAL);
        setTimeout(() => resolve({ hasQuit: false, hasRestart: false }), 2000);
      });
    });

    expect(result.hasQuit).toBe(true);
    expect(result.hasRestart).toBe(true);
    expect(result.quitCmd?.description).toBe('Quit the application');
    expect(result.restartCmd?.description).toBe('Restart the application');
  });

  test('reload extension command is registered', async () => {
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          const commands = msg.commands || [];
          const reloadCmd = commands.find((c: any) => c.name === 'reload extension');
          resolve({
            hasReloadExtension: !!reloadCmd,
            description: reloadCmd?.description
          });
        }, api.scopes.GLOBAL);
        api.publish('cmd:query-commands', {}, api.scopes.GLOBAL);
        setTimeout(() => resolve({ hasReloadExtension: false }), 2000);
      });
    });

    expect(result.hasReloadExtension).toBe(true);
    expect(result.description).toBe('Reload an external extension by ID');
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
