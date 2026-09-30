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
 * the native window reports visible, the page takes key as a transient page-host window without
 * the app activating, and losing key ends the transient page-host window and closes it outright
 * (G13) — including when the app comes forward while the page still holds key. Real OS focus and
 * what the display actually shows with another app frontmost are unobservable
 * headless, so the assertions read the kernel's own record — `State` and the
 * applied-transition timeline (`window-kernel-executor.ts timelineForTests`).
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

  // Off darwin `main/main.ts` feeds `kernelAppActivated()` from
  // `browser-window-focus`, so any Peek window taking OS focus marks the app
  // active — under Xvfb/openbox the palette is focused the moment it maps,
  // which flips `appActive` back to true right after
  // `setAppFocusedForTest(false)`. Key-without-activation is a macOS-only
  // model (docs/design/window-rules.md G1) and is not observable elsewhere,
  // and every assertion in this file assumes the app stayed inactive.
  test.beforeEach(() => {
    test.skip(
      process.platform !== 'darwin',
      'key-without-activation is macOS-only; off darwin browser-window-focus marks the app active',
    );
  });

  type KernelState = {
    appActive: boolean;
    key: string | null;
    order: Array<{
      id: string;
      kind?: string;
      role?: string;
      visible: boolean;
      pendingHidden?: boolean;
      nonActivating?: boolean;
      heldAboveOtherApps?: boolean;
    }>;
  };
  const readState = async (): Promise<KernelState> =>
    (await app.evaluateMain!((_e: unknown) => (globalThis as any).__peek_test.kernelStateForTest())) as KernelState;
  const readTimeline = async (from: number): Promise<string[]> =>
    ((await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelTimelineForTest();
    })) as string[]).slice(from);
  const effectsFor = (lines: string[], effect: string, id: string) =>
    lines.filter((l) => l.includes(`${effect}(${id})`));

  /**
   * With the app in the background, open the palette the way the hotkey does
   * and enter `url` into it. Returns the page window's native and kernel ids
   * and the timeline length from just before the page was asked for.
   */
  async function openPageFromPaletteInBackground(url: string) {
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
      const state = await readState();
      return state.order.some((w) => w.role === 'palette' && w.visible);
    }, { timeout: 5000 }).toBe(false);

    return { opened: opened as { id: number }, pageWmId, baselineLen };
  }

  test('the kernel keeps the page window on screen and never hides the app', async () => {
    const url = `http://127.0.0.1:${serverPort}/`;
    const { opened, pageWmId, baselineLen } = await openPageFromPaletteInBackground(url);

    const state = await readState();
    const timeline = await readTimeline(baselineLen);

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
    // the page is a transient page-host window (docs/design/window-rules.md G1): built
    // non-activating, raised with the user's intent, and handed key — all with
    // the app still inactive. It is held above other apps until the app next
    // becomes active, so it does not stay above every app for good. The native
    // level is not asserted — the executor does not realize the hold headless.
    expect(page!.nonActivating, timeline.join('\n')).toBe(true);
    expect(effectsFor(timeline, 'RaiseWindow', pageWmId)[0], timeline.join('\n')).toContain(`RaiseWindow(${pageWmId}):user`);
    expect(state.key, timeline.join('\n')).toBe(pageWmId);
    expect(page!.heldAboveOtherApps, timeline.join('\n')).toBe(true);
    expect(effectsFor(timeline, 'HoldAboveOtherApps', pageWmId).length, timeline.join('\n')).toBe(1);

    // The transient page-host window closes when the page loses key with the
    // app still inactive (window-rules.md G13, row 5c): the user clicked the
    // other app. The real `blur` on the host is what the OS would fire; the
    // backend's settle turns it into the key window losing focus. Nothing
    // replaces it, and the app stays inactive.
    const blurred = await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peek_test.blurHybridWindowForTest(id);
    }) as any, opened.id);
    expect(blurred).toBe(true);
    await expect.poll(async () => {
      const s = await readState();
      const old = s.order.find((w) => w.id === pageWmId);
      const fresh = s.order.find((w) => w.id !== pageWmId && w.kind === 'page-host' && w.role === 'content' && w.visible);
      return `${old === undefined ? 'old-closed' : 'old-present'}:${fresh === undefined ? 'no-reopen' : 'reopened'}`;
    }, { timeout: 10000 }).toBe('old-closed:no-reopen');
    const afterBlur = await readState();
    expect(afterBlur.appActive, 'the close activated the app').toBe(false);
    const timelineAfterBlur = await readTimeline(baselineLen);
    expect(effectsFor(timelineAfterBlur, 'DismissWindow', pageWmId).length, timelineAfterBlur.join('\n')).toBe(1);
    expect(timelineAfterBlur.filter((l) => l.includes('HideApp')), timelineAfterBlur.join('\n')).toEqual([]);
  });

  test('a link the transient page opens in a new window is transient too, at the default size', async () => {
    const url = `http://127.0.0.1:${serverPort}/opener`;
    const { opened, pageWmId } = await openPageFromPaletteInBackground(url);
    const before = await readState();
    expect(before.key, 'the page did not take key as a transient page-host window').toBe(pageWmId);

    // A target=_blank click in the page, the way a cmd+click or a link with a
    // target opens a new window: Chromium hands the popup path an 800x600 size
    // the page never asked for.
    const popupUrl = `http://127.0.0.1:${serverPort}/popup`;
    const existing = await app.evaluateMain!(() => (globalThis as any).__peekHybridOverlayTest.hybridIds());
    const ran = await app.evaluateMain!(((_e: unknown, arg: { id: number; popupUrl: string }) => {
      return (globalThis as any).__peekHybridOverlayTest.triggerBlankLinkClick(arg.id, arg.popupUrl);
    }) as any, { id: opened.id, popupUrl });
    expect(ran).toBe(true);
    const popupId = (await app.evaluateMain!(((_e: unknown, arg: { popupUrl: string; existing: number[] }) => {
      return (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(arg.popupUrl, arg.existing);
    }) as any, { popupUrl, existing })) as number | null;
    expect(popupId).not.toBeNull();
    const popupWmId = (await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peekHybridOverlayTest.machineWindowIdFor(id);
    }) as any, popupId)) as string;

    // It is a transient page-host window like its opener: non-activating, and
    // it takes key with the app still in the background rather than opening
    // behind the other app.
    await expect.poll(async () => (await readState()).key, { timeout: 5000 }).toBe(popupWmId);
    const state = await readState();
    const popup = state.order.find((w) => w.id === popupWmId) as (KernelState['order'][number] & { transient?: boolean }) | undefined;
    expect(popup, 'the popup is not in the kernel').toBeTruthy();
    expect(popup!.nonActivating).toBe(true);
    expect(popup!.transient).toBe(true);
    expect(state.appActive).toBe(false);
    // The popup taking key does not end the page that opened it.
    expect(state.order.find((w) => w.id === pageWmId)?.visible, JSON.stringify(state.order)).toBe(true);

    const size = await app.evaluateMain!((({ BaseWindow }: any, id: number) => {
      const win = BaseWindow.getAllWindows().find((w: any) => w.id === id);
      return win ? win.getContentBounds() : null;
    }) as any, popupId);
    expect(size).toMatchObject({ width: 1024, height: 768 });

    // The user clicks the other app: the popup loses key, and the task ends —
    // the popup and the page it came from both close, and nothing comes forward.
    const blurred = await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peek_test.blurHybridWindowForTest(id);
    }) as any, popupId);
    expect(blurred).toBe(true);
    await expect.poll(async () => {
      const s = await readState();
      return [pageWmId, popupWmId].filter((id) => s.order.some((w) => w.id === id)).length;
    }, { timeout: 10000 }).toBe(0);
    expect((await readState()).appActive).toBe(false);
  });

  test('the app activating while the transient page-host window holds key closes the page', async () => {
    const url = `http://127.0.0.1:${serverPort}/activated`;
    const { pageWmId } = await openPageFromPaletteInBackground(url);

    const before = await readState();
    expect(before.appActive).toBe(false);
    expect(before.key, 'the page did not take key as a transient page-host window').toBe(pageWmId);

    // The user brings the app forward (cmd+tab) while the transient page-host window holds
    // key: the same `AppActivated` the backend feeds from the OS. The task
    // ends exactly as it does with the app staying inactive (window-rules.md
    // G13 step 5e): the page was asked for while Peek was not focused, so the
    // task ends when that moment ends, and the page closes rather than
    // reappearing as an ordinary window.
    const sinceActivation = (await app.evaluateMain!((_e: unknown) => {
      const len = (globalThis as any).__peek_test.kernelTimelineForTest().length;
      (globalThis as any).__peek_test.setAppFocusedForTest(true);
      return len;
    })) as number;

    await expect.poll(async () => {
      const s = await readState();
      return s.order.find((w) => w.id === pageWmId) === undefined;
    }, { timeout: 10000 }).toBe(true);

    const after = await readState();
    expect(after.appActive).toBe(true);
    expect(
      after.order.some((w) => w.kind === 'page-host' && w.role === 'content' && w.visible),
      JSON.stringify(after.order),
    ).toBe(false);

    const timeline = await readTimeline(sinceActivation);
    expect(effectsFor(timeline, 'DismissWindow', pageWmId).length, timeline.join('\n')).toBe(1);

    // No window shows the page any more — it stays reachable from history, not on screen.
    const listShowing = async () => {
      const l = await bgWindow.evaluate(async () => (window as any).app.window.list());
      return (l.windows ?? []).filter((w: { url?: string }) => w.url && w.url.includes(url)) as Array<{ id: number }>;
    };
    await expect.poll(async () => (await listShowing()).length, { timeout: 5000 }).toBe(0);
  });
});
