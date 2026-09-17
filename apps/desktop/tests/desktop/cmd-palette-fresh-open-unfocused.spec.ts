/**
 * The cmd palette's FIRST open in a fresh app instance, made while another
 * app is frontmost.
 *
 * `renderer/cmd/background.js openPanelWindow()` opens the palette with
 * `activation: 'user'` precisely so its raise is admitted even though the
 * app is inactive (`window-kernel.ts` `FocusRaiseRequested`, rule F6). The
 * window-open handler's REUSE path (`main/ipc.ts`) forwards that fact to the
 * raise request it makes; the FRESH-open path — the one this spec exercises,
 * since a per-describe app starts with no palette window yet — must carry it
 * through the same way, or the palette's first raise is indistinguishable
 * from an unrequested one and gets suppressed (`window-kernel-executor.ts
 * planRaise` answers `suppressed` for a backgrounded app with no intent).
 *
 * Real OS focus/stacking is unobservable headless (see `apps/desktop/
 * CLAUDE.md`); this pins the kernel fact behind the visible symptom — the
 * timeline's `RaiseWindow` effect for the palette carries `intent: 'user'`.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('cmd palette fresh open while the app is in the background @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-palette-fresh-open-unfocused'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test("the palette's first raise carries user intent", async () => {
    // The app is not frontmost: the same `AppResigned` the backend feeds from
    // the OS.
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.setAppFocusedForTest(false);
    });

    const baselineLen = (await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelTimelineForTest().length;
    })) as number;

    // The palette as `renderer/cmd/background.js openPanelWindow()` opens
    // it — no reuse possible here, since this app instance has never opened
    // the palette before, so this is the fresh-open path.
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        role: 'palette',
        key: 'peek://cmd/panel.html',
        modal: true,
        type: 'panel',
        activation: 'user',
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
      });
    });
    expect(openResult.success).toBe(true);
    expect(openResult.reused, 'this must be the fresh-open path, not a reuse').toBeFalsy();

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    const paletteWmId = (await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peek_test.getMachineWindowIdFor(id);
    }) as any, openResult.id)) as string;
    expect(paletteWmId).toBeTruthy();

    const timeline = ((await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelTimelineForTest();
    })) as string[]).slice(baselineLen);

    const raiseLines = timeline.filter((l) => l.includes(`RaiseWindow(${paletteWmId})`));
    expect(raiseLines.length, `no raise for the palette\n${timeline.join('\n')}`).toBeGreaterThan(0);
    expect(
      raiseLines[0].includes(`RaiseWindow(${paletteWmId}):user`),
      `first raise carries no user intent\n${timeline.join('\n')}`,
    ).toBe(true);
  });
});
