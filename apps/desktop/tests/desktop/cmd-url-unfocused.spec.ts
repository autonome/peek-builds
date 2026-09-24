/**
 * A URL opened from the cmd palette while another app is frontmost.
 *
 * The palette is a panel: it takes typing while the app stays in the
 * background (docs/design/window-rules.md G1). A page opened from it in that
 * state must stay on screen, and the palette's close must not take the app off
 * screen with it.
 *
 * This pins the kernel's half only: with the app inactive the page record is
 * shown and stays visible, no `HideApp` is issued when the palette goes away,
 * the native window reports visible, the page takes key as a side task without
 * the app activating, and Escape takes it off screen without closing it. Real OS focus and what the display
 * actually shows with another app frontmost are unobservable headless, so the
 * assertions read the kernel's own record — `State` and the applied-transition
 * timeline (`window-kernel-executor.ts timelineForTests`).
 *
 * This runs on macOS only — off darwin the app counts as active the moment any
 * window takes OS focus, so the inactive-app premise cannot hold; Linux keeps
 * its coverage of the decision through the `window-kernel-executor.ts
 * planRaise()` unit tests named above.
 */

import * as http from 'http';
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('cmd URL open while the app is in the background @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort = 0;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-unfocused'));
    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Background Open</title></head><body>page</body></html>');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('the kernel keeps the page window on screen and never hides the app', async () => {
    // Off darwin `main/main.ts` feeds `kernelAppActivated()` from
    // `browser-window-focus`, so any Peek window taking OS focus marks the app
    // active — under Xvfb/openbox the palette is focused the moment it maps,
    // which flips `appActive` back to true right after
    // `setAppFocusedForTest(false)`. Key-without-activation is a macOS-only
    // model (docs/design/window-rules.md G1) and is not observable elsewhere,
    // and every assertion below assumes the app stayed inactive.
    test.skip(
      process.platform !== 'darwin',
      'key-without-activation is macOS-only; off darwin browser-window-focus marks the app active',
    );

    const url = `http://127.0.0.1:${serverPort}/`;

    // The app is not frontmost: the same `AppResigned` the backend feeds from
    // the OS.
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.setAppFocusedForTest(false);
    });

    // The palette as `renderer/cmd/background.js openPanelWindow()` opens it.
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

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    const appActiveBefore = await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelStateForTest().appActive;
    });
    expect(appActiveBefore, 'the palette must not have activated the app').toBe(false);

    const baselineLen = (await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelTimelineForTest().length;
    })) as number;

    await bgWindow.evaluate((u: string) => {
      (window as any).__bgOpenWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && msg.url.includes(u)) (window as any).__bgOpenWindowOpened = msg;
      });
    }, url);

    await cmdWindow.fill('input', url);
    await cmdWindow.keyboard.press('Enter');

    await bgWindow.waitForFunction(
      () => (window as any).__bgOpenWindowOpened !== null,
      undefined,
      { timeout: 10000 },
    );

    const list = await bgWindow.evaluate(async () => (window as any).app.window.list());
    const opened = list.windows?.find((w: { url?: string }) => w.url && w.url.includes(url));
    expect(opened, 'the page window is not in the window list').toBeTruthy();

    const pageWmId = (await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peekHybridOverlayTest.machineWindowIdFor(id);
    }) as any, opened.id)) as string;
    expect(pageWmId).toBeTruthy();

    // The palette hides itself ~100ms after Enter; wait for the kernel to see it.
    await expect.poll(async () => {
      const state = (await app.evaluateMain!((_e: unknown) => {
        return (globalThis as any).__peek_test.kernelStateForTest();
      })) as { order: Array<{ role?: string; visible: boolean }> };
      return state.order.some((w) => w.role === 'palette' && w.visible);
    }, { timeout: 5000 }).toBe(false);

    const state = (await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelStateForTest();
    })) as {
      appActive: boolean;
      key: string | null;
      order: Array<{
        id: string;
        visible: boolean;
        pendingHidden?: boolean;
        heldAboveOtherApps?: boolean;
        nonActivating?: boolean;
      }>;
    };
    const timeline = ((await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelTimelineForTest();
    })) as string[]).slice(baselineLen);

    const page = state.order.find((w) => w.id === pageWmId);
    expect(page, 'the page window left the kernel').toBeTruthy();
    expect(page!.visible, `page not visible\n${timeline.join('\n')}`).toBe(true);
    expect(page!.pendingHidden === true, 'page is marked for dismissal').toBe(false);

    // The app stayed in the background and was not taken off screen.
    expect(state.appActive).toBe(false);
    expect(timeline.filter((l) => l.includes('HideApp')), timeline.join('\n')).toEqual([]);

    // The page was put on screen by a show, which takes no focus. The raise
    // that follows it is decided by `window-kernel-executor.ts planRaise()`,
    // which answers `inactive-show` for every headless run, so what it does
    // with the app in the background is pinned in its unit tests, not here.
    expect(timeline.some((l) => new RegExp(`ShowWindow\\(${pageWmId}\\)`).test(l)), timeline.join('\n')).toBe(true);

    // The native window agrees with the kernel once the palette is gone.
    const nativeVisible = await app.evaluateMain!((({ BaseWindow }: any, id: number) => {
      const win = BaseWindow.getAllWindows().find((w: any) => w.id === id);
      return win ? win.isVisible() : null;
    }) as any, opened.id);
    expect(nativeVisible).toBe(true);

    // The palette held key over the other app when the page was asked for, so
    // the page is a side task (docs/design/window-rules.md G1): built
    // non-activating, raised with the user's intent, and handed key — all with
    // the app still inactive. It is held above other apps until the app next
    // becomes active, so it does not stay above every app for good. The native
    // level is not asserted — the executor does not realize the hold headless.
    const effectsFor = (lines: string[], effect: string) =>
      lines.filter((l) => l.includes(`${effect}(${pageWmId})`));
    expect(page!.nonActivating, timeline.join('\n')).toBe(true);
    expect(effectsFor(timeline, 'RaiseWindow')[0], timeline.join('\n')).toContain(`RaiseWindow(${pageWmId}):user`);
    expect(state.key, timeline.join('\n')).toBe(pageWmId);
    expect(page!.heldAboveOtherApps, timeline.join('\n')).toBe(true);
    expect(effectsFor(timeline, 'HoldAboveOtherApps').length, timeline.join('\n')).toBe(1);

    // Escape on the side task takes it off screen and leaves it open
    // (`window-escape.ts SIDE_TASK_ESCAPE`), with the app still inactive.
    await app.evaluateMain!((async (_e: unknown, id: number) => {
      await (globalThis as any).__peekHybridOverlayTest.runHybridEscape(id);
    }) as any, opened.id);
    await expect.poll(async () => {
      const s = (await app.evaluateMain!((_e: unknown) => {
        return (globalThis as any).__peek_test.kernelStateForTest();
      })) as { appActive: boolean; order: Array<{ id: string; visible: boolean }> };
      const rec = s.order.find((w) => w.id === pageWmId);
      return rec === undefined ? 'closed' : `${rec.visible ? 'visible' : 'hidden'}:${s.appActive ? 'active' : 'inactive'}`;
    }, { timeout: 5000 }).toBe('hidden:inactive');
  });
});
