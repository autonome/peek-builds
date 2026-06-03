/**
 * Regression repro: ESC at the root of a feature window should open the
 * Windows switcher.
 *
 * Symptom (user report): open the Hello World feature, press Escape — the
 * Windows feature (switcher overlay) does NOT open.
 *
 * This drives the REAL path:
 *   - open hello-world via its command (cmd:execute:hello world), the same
 *     way the cmd panel does — so the window gets its real inferred role.
 *   - press Escape via keyboard, exercising the full backend chain
 *     before-input-event → handleEscapeForWindow → escPolicy →
 *     escUnhandledPolicy → publish(cmd:execute:windows) → lazy windows wake.
 *   - assert the windows switcher overlay (peek://windows/windows.html) appears.
 *
 * Run with:
 *   DEBUG=1 yarn test:grep "Hello World ESC opens switcher"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;

const publishCmdExecute = (command: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, cmd: string) => {
    (globalThis as any).__peek_test.publishCmdExecute(cmd);
  }) as any, command);

test.describe('Hello World ESC opens switcher @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hello-world-esc'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('opening Hello World then pressing Escape opens the Windows switcher', async () => {
    // Open Hello World the way the cmd panel does.
    await publishCmdExecute('hello world');

    const helloWindow = await app.getWindow('hello-world/home.html', 15000);
    expect(helloWindow).toBeTruthy();
    await helloWindow.waitForLoadState('domcontentloaded');

    // Sanity: switcher not open yet.
    const switcherBefore = await app.getWindow('windows/windows.html', 1000).catch(() => null);
    expect(switcherBefore).toBeFalsy();

    // Press Escape through the full backend ESC path. Playwright's
    // keyboard.press('Escape') does NOT reliably trigger Electron's
    // before-input-event (see tests/README.md), so inject the keystroke at
    // the webContents level — the same way cmdl-on-error-page.spec.ts does —
    // which is exactly what fires the before-input-event → handleEscapeForWindow
    // chain the ESC handler listens on.
    const sendResult = await app.evaluateMain!(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((w: Electron.BrowserWindow) =>
        w.webContents.getURL().includes('hello-world/home.html'),
      );
      if (!host) return { error: 'no hello-world window found' };
      host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as any);
      host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as any);
      return { ok: true, hostId: host.id };
    }) as any;
    expect(sendResult.error, JSON.stringify(sendResult)).toBeUndefined();

    // The switcher overlay should appear. getWindow's timeout is a
    // failure-deadline: if the bug is present this throws and the test fails.
    const switcher = await app.getWindow('windows/windows.html', 8000);
    expect(switcher).toBeTruthy();
  });
});
