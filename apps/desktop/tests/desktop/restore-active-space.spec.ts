/**
 * The workspace that is active when Peek quits is the one active after it
 * relaunches.
 *
 * A quit while a named workspace is active saves THAT workspace's row
 * (`snapshot:<tagId>`, `main/session.ts saveSessionSnapshot` "Active
 * workspace"). Boot restores the default workspace's row and starts with the
 * default active, so the named workspace's windows stay closed and the next
 * ambient save writes the default's row.
 *
 * A relaunch is simulated in one process: save while the named workspace is
 * active, close its windows, put the main process's active workspace back to
 * the default (what a fresh process starts with), then run the boot restore
 * through `__peek_test.forceColdStartRestoreSession` — startup skips restore
 * in test profiles.
 *
 * Run with:
 *   yarn test:grep "restore active space"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

let app: DesktopApp;
let bgWindow: Page;

async function runCommand(name: string, search = ''): Promise<any> {
  return bgWindow.evaluate(
    async (arg: { name: string; search: string }) => {
      const api = (window as unknown as { app: any }).app;
      return await new Promise((resolve) => {
        const resultTopic = `cmd:execute:${arg.name}:result:${Date.now()}:${Math.random()}`;
        api.subscribe(resultTopic, (r: unknown) => resolve(r));
        api.publish(`cmd:execute:${arg.name}`, {
          search: arg.search,
          params: [],
          expectResult: true,
          resultTopic,
        });
        setTimeout(() => resolve({ error: `timeout waiting for ${arg.name}` }), 20000);
      });
    },
    { name, search },
  );
}

function spaceHomeWindows(spaceId: string): Page[] {
  return app
    .windows()
    .filter((p) => !p.isClosed() && p.url().includes('spaces/home.html') && p.url().includes(encodeURIComponent(spaceId)));
}

test.describe('restore active space across a relaunch @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('restore-active-space'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a cold-start restore reopens the workspace that was active at quit and leaves it active', async () => {
    const spaceName = 'restore-active-space-spec';
    const opened = await runCommand('open space', spaceName);
    expect(opened?.success, `open space "${spaceName}" failed: ${opened?.error}`).toBe(true);
    const spaceId = opened.spaceId as string;
    expect(spaceId).toBeTruthy();
    await expect.poll(() => spaceHomeWindows(spaceId).length, { timeout: 15000 }).toBe(1);

    // The quit-time save: an ambient save writes the active workspace's row.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    // The relaunch: nothing is open and the main process starts on the default.
    for (const page of spaceHomeWindows(spaceId)) {
      const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
      await bgWindow.evaluate(
        async (id: number) => (window as unknown as { app: any }).app.window.close(id),
        info.id as number,
      );
    }
    await expect
      .poll(() => spaceHomeWindows(spaceId).length, {
        timeout: 15000,
        message: 'the workspace window never closed; the restore below would be unfalsifiable',
      })
      .toBe(0);
    const reset = await bgWindow.evaluate(
      async () => await (window as unknown as { app: any }).app.session.setActiveWorkspace('default'),
    );
    expect(reset?.success).toBe(true);

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceColdStartRestoreSession()) as any);

    await expect
      .poll(() => spaceHomeWindows(spaceId).length, {
        timeout: 15000,
        message: 'the workspace active at quit did not reopen its windows on relaunch',
      })
      .toBe(1);
    const activeKey = await app.evaluateMain!(
      (() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any,
    );
    expect(activeKey, 'the workspace active at quit is not the active workspace after relaunch').toBe(spaceId);
  });
});
