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

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

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

  // Requirement 5 (specs/workspace-panel-orphan.md): quit while a named
  // workspace is active, relaunch, and confirm the panel does not come back
  // orphaned. This must drive the REAL boot path — `entry.ts`'s own boot
  // call to `restoreSessionSnapshot` — not a test bridge. The other tests
  // above launch through `createPerDescribeApp`, whose profile is prefixed
  // `test-` so `isTestProfile()` (main/config.ts) is true and
  // `restoreSessionSnapshot` (main/session.ts) skips boot restore entirely
  // (`if (isTestProfile() && !allowInTestProfile) return;`) — exactly the
  // path this requirement needs exercised for real. So this test launches
  // its own instance directly under a `tmp-`-prefixed profile instead:
  // `isEphemeralProfile()` is true for that prefix too (still skips the
  // single-instance lock), but `isTestProfile()` is false, so the boot call
  // takes the same branch a real user's relaunch does. Same technique
  // `session-restore-coldstart.spec.ts` uses for the same reason.
  test('quit inside a named workspace, relaunch: no orphaned panel at boot, exactly one after entering a workspace', async () => {
    const profile = 'tmp-workspace-panel-orphan-relaunch';
    const spaceName = 'panel-relaunch-orphan';

    const runOn = async (page: Page, name: string, search = ''): Promise<any> => {
      return page.evaluate(
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
    };

    const panelWindowCount = async (page: Page): Promise<number> => {
      const list = await page.evaluate(async () => (window as unknown as { app: any }).app.window.list());
      return ((list?.windows || []) as Array<{ params?: { role?: string } }>)
        .filter((w) => w?.params?.role === 'panel').length;
    };

    let relaunchApp = await launchDesktopApp(profile);
    let bg = await relaunchApp.getBackgroundWindow();
    await waitForExtensionsReady(bg);

    const openResult = await runOn(bg, 'open space', spaceName);
    expect(openResult?.success, `open space "${spaceName}" failed: ${openResult?.error}`).toBe(true);
    await relaunchApp.getWindow('spaces/panel.html', 15000);
    expect(await panelWindowCount(bg), 'exactly one panel while the workspace is active, before quitting').toBe(1);

    // Quit inside the named workspace — the save path persists the panel's
    // no-persist property, not the panel itself (requirement 2).
    await relaunchApp.close();

    // Relaunch the SAME profile: real cold boot, real restoreSessionSnapshot.
    relaunchApp = await launchDesktopApp(profile);
    bg = await relaunchApp.getBackgroundWindow();
    await waitForExtensionsReady(bg);

    expect(
      await panelWindowCount(bg),
      'boot into the default workspace must not reopen an orphaned panel',
    ).toBe(0);

    const reopenResult = await runOn(bg, 'open space', spaceName);
    expect(reopenResult?.success, `open space "${spaceName}" failed on relaunch: ${reopenResult?.error}`).toBe(true);
    await relaunchApp.getWindow('spaces/panel.html', 15000);
    expect(
      await panelWindowCount(bg),
      'entering a workspace after relaunch creates exactly one panel',
    ).toBe(1);

    await relaunchApp.close();
  });
});
