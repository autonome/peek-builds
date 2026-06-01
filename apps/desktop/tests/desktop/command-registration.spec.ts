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
    // Send a batch of test commands. cmd:register-batch is fire-and-forget;
    // the registry processes it asynchronously.
    await bgWindow.evaluate(async () => {
      (window as any).app.publish('cmd:register-batch', {
        commands: [
          { name: 'test-batch-cmd-1', description: 'Test batch command 1', source: 'test' },
          { name: 'test-batch-cmd-2', description: 'Test batch command 2', source: 'test' },
          { name: 'test-batch-cmd-3', description: 'Test batch command 3', source: 'test' }
        ]
      });
    });

    // Synchronize on the registry actually carrying the 3 batch commands.
    // Each evaluation does ONE race-free round-trip: subscribe to the
    // response topic BEFORE publishing the query, so the producer's
    // synchronous `cmd:query-commands-response` can't be missed. The
    // predicate is the real populated command set (not a clock); the cmd
    // extension's batch-processing latency is absorbed by waitForFunction
    // re-evaluating the round-trip, and the deadline is a failure deadline.
    await bgWindow.waitForFunction(async () => {
      const api = (window as any).app;
      const commands: any[] = await new Promise((resolve) => {
        const unsub = api.subscribe('cmd:query-commands-response', (msg: any) => {
          unsub?.();
          resolve(msg.commands || []);
        });
        api.publish('cmd:query-commands', {});
      });
      return commands.filter((c) => c.name.startsWith('test-batch-cmd-')).length === 3;
    }, undefined, { timeout: 5000 });

    // Read the batch command names out of one more round-trip for assertion.
    const batchCommandNames = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const commands: any[] = await new Promise((resolve) => {
        const unsub = api.subscribe('cmd:query-commands-response', (msg: any) => {
          unsub?.();
          resolve(msg.commands || []);
        });
        api.publish('cmd:query-commands', {});
      });
      return commands
        .filter((c) => c.name.startsWith('test-batch-cmd-'))
        .map((c) => c.name);
    });

    expect(batchCommandNames).toContain('test-batch-cmd-1');
    expect(batchCommandNames).toContain('test-batch-cmd-2');
    expect(batchCommandNames).toContain('test-batch-cmd-3');
  });

});
