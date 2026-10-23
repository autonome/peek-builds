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

    // Running the command again closes the open HUD (toggle), and a third run opens it.
    const again = await runCommand('hud');
    expect(again?.success).toBe(true);
    expect(again.closed, 'a second hud did not close the open HUD').toBe(true);
    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('app/hud/hud.html')).length, {
        timeout: 15000,
      })
      .toBe(0);
    const third = await runCommand('hud');
    expect(third?.success).toBe(true);
    expect(third.closed).toBeUndefined();
    await getWindowById(third.windowId as number);
  });

  test('the close button at the top right of the HUD closes its window', async () => {
    const opened = await runCommand('hud');
    expect(opened?.success, `hud failed: ${opened?.error}`).toBe(true);
    const page = await getWindowById(opened.windowId as number);
    await page.locator('#close-hud').click();
    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('app/hud/hud.html')).length, {
        timeout: 15000,
        message: 'the close button did not close the HUD',
      })
      .toBe(0);
  });

  test('the HUD takes its colours from the theme and follows a theme switch while open', async () => {
    const opened = await runCommand('hud');
    expect(opened?.success, `hud failed: ${opened?.error}`).toBe(true);
    const page = await getWindowById(opened.windowId as number);

    // The body background against the theme's background colour, both
    // resolved to computed rgb() strings through a probe element.
    const colours = () => page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--theme-bg)';
      document.body.appendChild(probe);
      const themeBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { body: getComputedStyle(document.body).backgroundColor, themeBg };
    });
    const themeApi = (method: string, arg?: string) => bgWindow.evaluate(
      async (a: { method: string; arg?: string }) =>
        (window as unknown as { app: any }).app.theme[a.method](a.arg),
      { method, arg },
    );

    await expect.poll(async () => {
      const c = await colours();
      return c.themeBg !== 'rgba(0, 0, 0, 0)' && c.body === c.themeBg;
    }, { timeout: 10000, message: 'the HUD background is not the theme background' }).toBe(true);
    const before = (await colours()).body;

    // The bundled themes have different backgrounds (peek #f6f6f6, basic
    // #ffffff), so a switch must visibly restyle the open window. A colour
    // scheme switch is not used: in the test build it does not reach the
    // page's prefers-color-scheme.
    const initial = await themeApi('get');
    const target = initial.themeId === 'basic' ? 'peek' : 'basic';
    try {
      expect((await themeApi('setTheme', target))?.success).toBe(true);
      await expect.poll(async () => (await colours()).body, {
        timeout: 10000,
        message: 'the open HUD kept its colours after the theme switch',
      }).not.toBe(before);
      const after = await colours();
      expect(after.body, 'the HUD background left the theme after the switch').toBe(after.themeBg);
    } finally {
      await themeApi('setTheme', initial.themeId);
    }
  });

  test('the HUD comes back after a restart, still pinned across workspaces and still the one hud reuses', async () => {
    const opened = await runCommand('hud');
    expect(opened?.success, `hud failed: ${opened?.error}`).toBe(true);
    const hudId = opened.windowId as number;

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    // Close it so the only way it can be on screen afterward is restore.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      hudId,
    );
    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('app/hud/hud.html')).length, {
        timeout: 15000,
        message: 'the HUD never closed — restore would be unfalsifiable',
      })
      .toBe(0);

    // A cold-start restore of the default snapshot is what boot runs; a live
    // in-session restore skips windows pinned across workspaces on purpose.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceColdStartRestoreSession()) as any);

    const page = await app.getWindow('app/hud/hud.html', 15000);
    const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    expect(info?.error).toBeUndefined();
    const restoredId = info.id as number;

    const pinEntry = await getPinContext(restoredId);
    expect(pinEntry?.value, 'the restored HUD is not recorded as pinned across workspaces').toBe('global');
    await expect(page.locator('#memory-total')).toHaveText(/^[1-9][\d.]* (MB|GB)$/, { timeout: 15000 });

    // The restored window is the one hud finds: running it closes that window
    // instead of opening a second.
    const again = await runCommand('hud');
    expect(again?.success).toBe(true);
    expect(again.closed, 'hud did not find the restored HUD').toBe(true);
  });
});
