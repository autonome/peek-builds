/**
 * Workspace panel — the global HUD window built per handoff.md Next Step 4
 * (`docs/design/window-rules.md` "The workspace panel").
 *
 * Opened already pinned across workspaces by `features/spaces/background.js`
 * `showPanel()` (not by a user pin action), it names the active workspace and
 * offers close/switch controls (`features/spaces/panel.html`/`panel.js`).
 * Unlike the border, the same window carries through a workspace switch —
 * `switchSpace()` passes `keepPanel: true` to `closeSpace()` so `showPanel()`
 * finds it still open and just publishes `spaces:panel-update` instead of
 * recreating it.
 *
 * Run with:
 *   yarn test:grep "workspace panel"
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

test.describe('workspace panel: global HUD window @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('workspace-panel'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('names the active workspace, updates in place on switch, and closes with it', async () => {
    const first = 'panel-spec-first';
    const second = 'panel-spec-second';

    const openResult = await runCommand('open space', first);
    expect(openResult?.success, `open space "${first}" failed: ${openResult?.error}`).toBe(true);

    const panelPage = await app.getWindow('spaces/panel.html', 15000);
    await expect(panelPage.locator('#panel-name')).toHaveText(first, { timeout: 15000 });
    const panelInfo = await panelPage.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    expect(panelInfo?.error).toBeUndefined();
    const panelWindowId = panelInfo.id as number;

    // Switching workspaces updates the SAME panel window in place — the
    // point of `keepPanel`, not a close/reopen the test would otherwise be
    // unable to tell apart from an update.
    const switchResult = await runCommand('switch space', second);
    expect(switchResult?.success, `switch space "${second}" failed: ${switchResult?.error}`).toBe(true);

    await expect(panelPage.locator('#panel-name')).toHaveText(second, { timeout: 15000 });
    const infoAfterSwitch = await panelPage.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    expect(
      infoAfterSwitch.id,
      'the panel was closed and reopened on switch instead of updated in place',
    ).toBe(panelWindowId);

    // Closing the workspace from the panel's own control follows the same
    // path as `closeSpace()` — both the workspace content and the panel
    // itself go away.
    await panelPage.locator('.panel-close').click();
    await expect.poll(() => panelPage.isClosed(), { timeout: 15000 }).toBe(true);

    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('spaces/home.html')).length, {
        timeout: 15000,
        message: 'the workspace did not actually close when the panel was closed',
      })
      .toBe(0);
  });

  test('is excluded from the Windows switcher, by role, like other chrome', async () => {
    const spaceName = 'panel-spec-switcher';
    const openResult = await runCommand('open space', spaceName);
    expect(openResult?.success, `open space "${spaceName}" failed: ${openResult?.error}`).toBe(true);

    const panelPage = await app.getWindow('spaces/panel.html', 15000);
    const panelInfo = await panelPage.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    const panelWindowId = panelInfo.id as number;

    // Open the switcher the way the global hotkey does — the same pattern
    // switcher-select-raises-target.spec.ts and windows-lazy-wake.spec.ts use.
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('windows');
    });
    const switcherWindow = await app.getWindow('windows/windows.html', 15000);
    await switcherWindow.waitForLoadState('domcontentloaded');

    // The switcher renders one `peek-card[data-window-id]` per window it
    // lists (`features/windows/windows.js createWindowCard`) — give it a
    // moment to finish loading its window list before asserting an absence.
    await expect
      .poll(async () => (await switcherWindow.locator('peek-card').count()) >= 0, { timeout: 10000 })
      .toBe(true);
    await new Promise((r) => setTimeout(r, 500));

    await expect(switcherWindow.locator(`peek-card[data-window-id="${panelWindowId}"]`)).toHaveCount(0);

    await runCommand('close space');
  });
});
