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
 * the app activating, losing key ends the side task and reopens the page as an
 * ordinary window on one desktop (G13), and Escape closes it. Real OS focus and
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
    // the page is a side task (docs/design/window-rules.md G1): built
    // non-activating, raised with the user's intent, and handed key — all with
    // the app still inactive. It is held above other apps until the app next
    // becomes active, so it does not stay above every app for good. The native
    // level is not asserted — the executor does not realize the hold headless.
    expect(page!.nonActivating, timeline.join('\n')).toBe(true);
    expect(effectsFor(timeline, 'RaiseWindow', pageWmId)[0], timeline.join('\n')).toContain(`RaiseWindow(${pageWmId}):user`);
    expect(state.key, timeline.join('\n')).toBe(pageWmId);
    expect(page!.heldAboveOtherApps, timeline.join('\n')).toBe(true);
    expect(effectsFor(timeline, 'HoldAboveOtherApps', pageWmId).length, timeline.join('\n')).toBe(1);

    // The side task ends when the page loses key with the app still inactive
    // (window-rules.md G13): the user clicked the other app. The real `blur`
    // on the host is what the OS would fire; the backend's settle turns it
    // into the key window losing focus. The kernel then asks for the page to
    // be reopened as an ordinary window, and the backend replaces the panel
    // host with a new one at the same address, shown without focus.
    const blurred = await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peek_test.blurHybridWindowForTest(id);
    }) as any, opened.id);
    expect(blurred).toBe(true);
    await expect.poll(async () => {
      const s = await readState();
      const old = s.order.find((w) => w.id === pageWmId);
      const fresh = s.order.find((w) => w.id !== pageWmId && w.kind === 'page-host' && w.role === 'content' && w.visible);
      return `${old === undefined ? 'old-closed' : 'old-present'}:${fresh === undefined ? 'no-reopen' : 'reopened'}`;
    }, { timeout: 10000 }).toBe('old-closed:reopened');
    const afterBlur = await readState();
    const reopened = afterBlur.order.find((w) => w.id !== pageWmId && w.kind === 'page-host' && w.role === 'content' && w.visible)!;
    expect(reopened.nonActivating === true, 'the reopened window is still non-activating').toBe(false);
    expect(reopened.heldAboveOtherApps === true, 'the reopened window is held above other apps').toBe(false);
    expect(afterBlur.key, 'the reopened window took key').not.toBe(reopened.id);
    expect(afterBlur.appActive, 'the reopen activated the app').toBe(false);
    const timelineAfterBlur = await readTimeline(baselineLen);
    expect(effectsFor(timelineAfterBlur, 'ReopenAsOrdinaryWindow', pageWmId).length, timelineAfterBlur.join('\n')).toBe(1);
    expect(timelineAfterBlur.filter((l) => l.includes('HideApp')), timelineAfterBlur.join('\n')).toEqual([]);

    // Exactly one window shows the page, with a new native id, and it is an
    // ordinary window: on one desktop, not floating. The list reads each
    // window's live URL, which the replacement reports once its page loads.
    const listShowing = async () => {
      const l = await bgWindow.evaluate(async () => (window as any).app.window.list());
      return (l.windows ?? []).filter((w: { url?: string }) => w.url && w.url.includes(url)) as Array<{ id: number }>;
    };
    await expect.poll(async () => (await listShowing()).length, { timeout: 10000 }).toBe(1);
    const showing = await listShowing();
    expect(showing[0].id).not.toBe(opened.id);
    const nativeAfter = await app.evaluateMain!((({ BaseWindow }: any, id: number) => {
      const win = BaseWindow.getAllWindows().find((w: any) => w.id === id);
      return win ? { visible: win.isVisible(), allDesktops: win.isVisibleOnAllWorkspaces(), floating: win.isAlwaysOnTop() } : null;
    }) as any, showing[0].id);
    expect(nativeAfter).toEqual({ visible: true, allDesktops: false, floating: false });

    // Escape on a page taking Escape while the app is inactive closes it,
    // with the app still inactive, and a closed window is not reopened.
    const reopenedWmId = reopened.id;
    await app.evaluateMain!((async (_e: unknown, id: number) => {
      await (globalThis as any).__peekHybridOverlayTest.runHybridEscape(id);
    }) as any, showing[0].id);
    await expect.poll(async () => {
      const s = await readState();
      const rec = s.order.find((w) => w.id === reopenedWmId);
      return rec === undefined ? `closed:${s.appActive ? 'active' : 'inactive'}` : `${rec.visible ? 'visible' : 'hidden'}`;
    }, { timeout: 5000 }).toBe('closed:inactive');
    const afterEscape = await readTimeline(baselineLen);
    expect(effectsFor(afterEscape, 'ReopenAsOrdinaryWindow', reopenedWmId), afterEscape.join('\n')).toEqual([]);
  });

  test('the app activating while the side task holds key reopens the page as the front window', async () => {
    const url = `http://127.0.0.1:${serverPort}/activated`;
    const { opened, pageWmId } = await openPageFromPaletteInBackground(url);

    const before = await readState();
    expect(before.appActive).toBe(false);
    expect(before.key, 'the page did not take key as a side task').toBe(pageWmId);

    // The user brings the app forward (cmd+tab) while the side task holds
    // key: the same `AppActivated` the backend feeds from the OS. The side
    // task ends (window-rules.md G13 step 5e) and the reopened page must be
    // the front window: the replacement opens before the panel host closes,
    // so the close's successor raise (F7) lands on it and on nothing else.
    const sinceActivation = (await app.evaluateMain!((_e: unknown) => {
      const len = (globalThis as any).__peek_test.kernelTimelineForTest().length;
      (globalThis as any).__peek_test.setAppFocusedForTest(true);
      return len;
    })) as number;

    const reopenProgress = async () => {
      const s = await readState();
      const old = s.order.find((w) => w.id === pageWmId);
      const fresh = s.order.find((w) => w.id !== pageWmId && w.kind === 'page-host' && w.role === 'content' && w.visible);
      return `${old === undefined ? 'old-closed' : 'old-present'}:${fresh === undefined ? 'no-reopen' : 'reopened'}`;
    };
    try {
      await expect.poll(reopenProgress, { timeout: 10000 }).toBe('old-closed:reopened');
    } catch (err) {
      const s = await readState();
      throw new Error(`${(err as Error).message}\n${JSON.stringify(s.order)}\n${(await readTimeline(sinceActivation)).join('\n')}`);
    }

    const after = await readState();
    const reopened = after.order.find((w) => w.id !== pageWmId && w.kind === 'page-host' && w.role === 'content' && w.visible)!;
    expect(after.appActive).toBe(true);
    expect(reopened.nonActivating === true, 'the reopened window is still non-activating').toBe(false);
    expect(reopened.heldAboveOtherApps === true, 'the reopened window is held above other apps').toBe(false);

    const timeline = await readTimeline(sinceActivation);
    expect(effectsFor(timeline, 'ReopenAsOrdinaryWindow', pageWmId).length, timeline.join('\n')).toBe(1);
    // The activation itself raises the window it releases from above other
    // apps (G1), which is the side task about to close. From its close on, the
    // only raise is the successor raise, and it lands on the replacement.
    const closeAt = timeline.findIndex((l) => l.includes(`WindowClosed(${pageWmId})`));
    expect(closeAt, timeline.join('\n')).toBeGreaterThan(-1);
    const raises = timeline.slice(closeAt).filter((l) => l.includes('RaiseWindow('));
    expect(raises, timeline.join('\n')).toHaveLength(1);
    expect(raises[0], timeline.join('\n')).toContain(`RaiseWindow(${reopened.id})`);

    // The reopened page is the topmost of the app's windows.
    const contentIds = after.order.filter((w) => w.kind === 'page-host' && w.role === 'content' && w.visible).map((w) => w.id);
    expect(contentIds[contentIds.length - 1], JSON.stringify(after.order)).toBe(reopened.id);

    // Exactly one window shows the page, with a new native id. The list reads
    // each window's live URL, which the replacement reports once its page loads.
    const listShowing = async () => {
      const l = await bgWindow.evaluate(async () => (window as any).app.window.list());
      return (l.windows ?? []).filter((w: { url?: string }) => w.url && w.url.includes(url)) as Array<{ id: number }>;
    };
    await expect.poll(async () => (await listShowing()).length, { timeout: 10000 }).toBe(1);
    const showing = await listShowing();
    expect(showing[0].id).not.toBe(opened.id);

    // Leave the page closed for whatever runs next.
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, showing[0].id);
    await expect.poll(async () => {
      const s = await readState();
      return s.order.find((w) => w.id === reopened.id) === undefined;
    }, { timeout: 5000 }).toBe(true);
  });
});
