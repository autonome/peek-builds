import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

test.describe('Command Registration Performance @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-perf'));
    // Wait for cmd extension to be fully ready before running performance tests
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('cmd:register-batch is handled by cmd extension', async () => {
    // Test that batch registration works by sending a batch and verifying commands appear
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      // Send a batch of test commands
      api.publish('cmd:register-batch', {
        commands: [
          { name: 'test-batch-cmd-1', description: 'Test batch command 1', source: 'test' },
          { name: 'test-batch-cmd-2', description: 'Test batch command 2', source: 'test' },
          { name: 'test-batch-cmd-3', description: 'Test batch command 3', source: 'test' }
        ]
      }, api.scopes.GLOBAL);

      // Poll for commands to appear (deterministic retry instead of fixed timeout)
      const maxAttempts = 20;
      const pollInterval = 100;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, pollInterval));

        const commands = await new Promise<any[]>((resolve) => {
          const unsub = api.subscribe('cmd:query-commands-response', (msg: any) => {
            unsub?.();
            resolve(msg.commands || []);
          }, api.scopes.GLOBAL);
          api.publish('cmd:query-commands', {}, api.scopes.GLOBAL);
          setTimeout(() => resolve([]), 500);
        });

        const batchCmds = commands.filter((c: any) => c.name.startsWith('test-batch-cmd-'));
        if (batchCmds.length === 3) {
          return {
            totalCommands: commands.length,
            batchCommandsFound: batchCmds.length,
            batchCommandNames: batchCmds.map((c: any) => c.name)
          };
        }
      }

      return { totalCommands: 0, batchCommandsFound: 0, batchCommandNames: [] };
    });

    expect(result.batchCommandsFound).toBe(3);
    expect(result.batchCommandNames).toContain('test-batch-cmd-1');
    expect(result.batchCommandNames).toContain('test-batch-cmd-2');
    expect(result.batchCommandNames).toContain('test-batch-cmd-3');
  });

});
