/**
 * Memory HUD — the `hud` palette command.
 *
 * The HUD is an ordinary, interactive Peek window pinned across workspaces
 * (`docs/design/window-rules.md` "Persistent windows: workspace-pinned and
 * global HUD"). The `hud` command (`renderer/index.js registerCoreCommands()`)
 * opens `peek://app/hud/hud.html`, pins it across workspaces the same way the
 * "pin across workspaces" command does (`api.window.setPinned` + the 'pin'
 * context key), and focuses the existing window instead of opening a second
 * one when it is already open. The page reads the aggregate memory total from
 * `api.app.metrics()` (`main/process-metrics.ts summarizeMemory()`).
 *
 * Run with:
 *   yarn test:grep "memory hud"
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

async function getWindowById(windowId: number, timeout = 15000): Promise<Page> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const p of app.windows()) {
      if (p.isClosed()) continue;
      try {
        const info = await p.evaluate(() => (window as unknown as { app: any }).app?.window?.getInfo?.());
        if (info && !info.error && info.id === windowId) return p;
      } catch {
        // Page navigating/closing — try the next one.
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No window with id ${windowId} found within ${timeout}ms`);
}

async function getPinContext(windowId: number): Promise<{ value?: string } | null> {
  const entry = await app.evaluateMain!(
    ((_e: unknown, wid: number) =>
      (globalThis as any).__peek_test.getContextEntryForTest('pin', wid)) as any,
    windowId,
  );
  return entry as { value?: string } | null;
}

test.describe('memory hud @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hud'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('the hud command opens the stats page pinned across workspaces and shows a memory total', async () => {
    const result = await runCommand('hud');
    expect(result?.error, `hud failed: ${result?.error}`).toBeUndefined();
    expect(result?.success).toBe(true);
    const hudId = result.windowId as number;
    expect(typeof hudId).toBe('number');

    const page = await getWindowById(hudId);
    expect(page.url()).toContain('app/hud/hud.html');

    const pinEntry = await getPinContext(hudId);
    expect(pinEntry?.value, 'the HUD window is not recorded as pinned across workspaces').toBe('global');

    // A real total: the page shows a number above zero with a unit.
    await expect(page.locator('#memory-total')).toHaveText(/^[1-9][\d.]* (MB|GB)$/, { timeout: 15000 });
    await expect(page.locator('#process-count')).toHaveText(/^[1-9]\d*$/);

    // Running the command again focuses the open HUD rather than opening another.
    const again = await runCommand('hud');
    expect(again?.success).toBe(true);
    expect(again.windowId, 'a second hud opened a new window').toBe(hudId);
  });
});
