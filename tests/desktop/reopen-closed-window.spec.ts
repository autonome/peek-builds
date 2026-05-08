/**
 * Reopen Last Closed Window (cmd+shift+t) Tests
 *
 * Repro for user-reported flakiness: cmd+shift+t "doesn't work a lot of
 * the time". Hypothesis from architecture audit:
 *   reopenLastClosedWindow() pops from the in-memory stack and publishes
 *   `window:reopen-request` to the bgWindow via fire-and-forget pubsub.
 *   If the bgWindow's createWindow call throws/races, the entry is gone
 *   from the stack and no window comes back.
 *
 * These tests open + close + reopen N times in a tight loop to surface
 * the flakiness deterministically.
 *
 * Run with:
 *   yarn test:grep "Reopen Last Closed"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { sleep } from '../helpers/window-utils';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Reopen Last Closed Window @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('reopen-closed'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const path = req.url || '/';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${path}</title></head>` +
            `<body><h1 id="page">${path}</h1></body></html>`,
        );
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

  // Helpers --------------------------------------------------------------

  async function openWindow(url: string): Promise<number> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 700, height: 500 });
    }, url);
    expect(result.success).toBe(true);
    return result.id;
  }

  /**
   * Close a window and wait for the close to settle to a terminal state.
   *
   * api.window.close resolves on IPC dispatch, but the actual BrowserWindow
   * teardown (or hide, for keepLive tiles) happens a tick or two later.
   * If the test then runs `evaluateMain` — which Playwright routes through
   * a CDP session tracking every BrowserWindow — it can land right as a
   * context is being torn down. Result: "execution context destroyed,
   * most likely because of a navigation". This helper waits for one of
   * two terminal states so the next evaluateMain call is safe:
   *
   *   1. Window destroyed (`BrowserWindow.fromId` returns null) — real
   *      close, BrowserWindow is gone.
   *   2. Window hidden (`isVisible() === false`) — keepLive hide, the
   *      BrowserWindow is alive but evaluation against any other context
   *      is no longer racing with its teardown.
   *
   * Polled via a single evaluateMain that returns a string label for the
   * terminal state, so we don't need separate code paths for keepLive.
   */
  async function closeWindowById(windowId: number): Promise<void> {
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      let state: string;
      try {
        state = await app.evaluateMain!(({ BrowserWindow }, id: number) => {
          const w = BrowserWindow.fromId(id);
          if (!w || w.isDestroyed()) return 'destroyed';
          if (!w.isVisible()) return 'hidden';
          return 'open';
        }, windowId) as string;
      } catch (err) {
        // "Execution context was destroyed, most likely because of a
        // navigation" is THE signal we're waiting for — the BrowserWindow's
        // CDP context is being torn down right now. Treat as in-progress
        // and re-poll until destruction settles.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Execution context was destroyed')) {
          await sleep(25);
          continue;
        }
        throw err;
      }
      if (state === 'destroyed' || state === 'hidden') return;
      await sleep(25);
    }
    throw new Error(`closeWindowById timeout — window ${windowId} never settled (still open after 3s)`);
  }

  /**
   * Tight retry-once wrapper for an evaluateMain call. Used by the
   * stack-count helpers because Playwright's `electronApp.evaluate`
   * occasionally throws "Execution context was destroyed, most likely
   * because of a navigation" during a window-attach/detach transition
   * (a new BrowserWindow's CDP session is mid-attach, or one is being
   * torn down). The transient is bounded — by the time the retry fires
   * a moment later the helper context is stable. NOT a generic retry:
   * only the named error is caught; everything else propagates.
   */
  async function evalMainStable<T>(fn: () => T): Promise<T> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    try {
      return (await app.evaluateMain(fn)) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Execution context was destroyed')) throw err;
      await sleep(50);
      return (await app.evaluateMain(fn)) as T;
    }
  }

  async function getStackCount(): Promise<number> {
    return await evalMainStable<number>(() => {
      return (globalThis as any).__peek_test.getClosedWindowCount();
    });
  }

  /**
   * Wait for the closed-window stack to reach an expected count. Polls
   * `getStackCount()` until the predicate matches or the timeout elapses.
   * Used after a `window.close()` call to give the 'closed' event handler
   * time to run and push the entry onto the stack — the close-to-push
   * path is async, but it's bounded; this is the deterministic wait the
   * test needs instead of a fixed sleep.
   */
  async function waitForStackCount(expected: number, timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = await getStackCount();
    while (last !== expected && Date.now() < deadline) {
      await sleep(50);
      last = await getStackCount();
    }
    return last;
  }

  async function reopenViaShortcut(): Promise<{ success: boolean; url?: string; error?: string }> {
    return (await app.evaluateMain!(() => {
      return (globalThis as any).__peek_test.reopenLastClosedWindow();
    })) as any;
  }

  /**
   * Wait for a Page whose URL contains the given substring AND whose
   * load has settled. Returning the Page the moment it appears in
   * `app.windows()` is too eager — the CDP session may still be
   * attaching, and a subsequent `evaluateMain` can race with that
   * attach and throw "Execution context was destroyed". Waiting for
   * `domcontentloaded` (or 'load' if the renderer is fast) gates the
   * caller until the window's context is stable.
   */
  async function findWindowWithUrl(urlSubstr: string, timeoutMs = 5000): Promise<Page | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const w of app.windows()) {
        if (w.url().includes(urlSubstr)) {
          try {
            await w.waitForLoadState('domcontentloaded', { timeout: 1000 });
          } catch { /* page may already be loaded — ignore */ }
          return w;
        }
      }
      await sleep(100);
    }
    return null;
  }

  // Tests ----------------------------------------------------------------

  test('open → close → reopen brings the URL back (single round trip)', async () => {
    const url = `http://127.0.0.1:${serverPort}/single`;

    const id = await openWindow(url);
    await findWindowWithUrl('/single');

    const stackBefore = await getStackCount();
    await closeWindowById(id);

    // The 'closed' event handler runs async after window.close() resolves;
    // it's the path that pushes the URL onto the closed-window stack.
    // Wait deterministically for the push to land instead of the prior
    // placeholder waitForFunction that returned `true` immediately and
    // raced.
    const stackAfter = await waitForStackCount(stackBefore + 1);
    expect(stackAfter).toBe(stackBefore + 1);

    const result = await reopenViaShortcut();
    expect(result.success).toBe(true);
    expect(result.url).toContain('/single');

    const reopened = await findWindowWithUrl('/single', 8000);
    expect(reopened).toBeTruthy();
  });

  test('rapid open/close/reopen — 5 iterations, each must come back', async () => {
    // Tight loop to surface the fire-and-forget pubsub race. If the
    // background window misses any `window:reopen-request` event, an
    // entry will be popped from the stack but no window will appear.
    const failures: string[] = [];

    for (let i = 0; i < 5; i++) {
      const tag = `iter-${i}-${Date.now()}`;
      const url = `http://127.0.0.1:${serverPort}/${tag}`;

      const id = await openWindow(url);
      const opened = await findWindowWithUrl(tag, 5000);
      if (!opened) {
        failures.push(`${tag}: window did not open`);
        continue;
      }

      const stackBefore = await getStackCount();
      await closeWindowById(id);
      // Wait deterministically for the 'closed' handler to push instead
      // of a fixed sleep — the rapid-loop is precisely where a 150ms
      // assumption fails on a slow CI runner.
      const stackCount = await waitForStackCount(stackBefore + 1);
      if (stackCount !== stackBefore + 1) {
        failures.push(`${tag}: closed window not on stack (count=${stackCount}, expected ${stackBefore + 1})`);
        continue;
      }

      const result = await reopenViaShortcut();
      if (!result.success) {
        failures.push(`${tag}: reopen returned !success: ${result.error}`);
        continue;
      }

      const reopened = await findWindowWithUrl(tag, 8000);
      if (!reopened) {
        failures.push(`${tag}: reopen reported success but no window appeared`);
        continue;
      }

      // Cleanup the reopened window for the next iteration. Pop it off
      // by id so it doesn't pollute the stack for the next reopen.
      try {
        const reopenedId = await bgWindow.evaluate(async (u: string) => {
          const r = await (window as any).app.window.list({ includeInternal: false });
          if (!r.success) return null;
          const win = r.windows.find((w: any) => w.url?.includes(u));
          return win?.id ?? null;
        }, tag);
        if (reopenedId != null) await closeWindowById(reopenedId);
        await sleep(100);
      } catch {}
    }

    expect(failures).toEqual([]);
  });

  test('cmd+shift+T from inside webview content triggers reopen (regression: guest webContents must delegate to handleLocalShortcut)', async () => {
    // The user-reported "doesn't work a lot of the time" symptom: when
    // focus is inside the page content (the webview guest), pressing
    // cmd+shift+T silently does nothing. The webview guest's
    // `before-input-event` handler in `ipc.ts` only handles
    // page-specific shortcuts (cmd+L, R, F, …) and never delegates
    // unmatched keys to the global `handleLocalShortcut`.

    // Stack a closeable URL so the reopen has something to bring back.
    const reopenableUrl = `http://127.0.0.1:${serverPort}/from-webview-shortcut`;
    const id1 = await openWindow(reopenableUrl);
    await findWindowWithUrl('/from-webview-shortcut');
    await closeWindowById(id1);
    await sleep(200);
    expect(await getStackCount()).toBeGreaterThan(0);

    // Open a SECOND page with its own webview guest. Focus will start
    // inside this guest content (Peek's page tile auto-focuses the
    // webview after dom-ready).
    const activeUrl = `http://127.0.0.1:${serverPort}/active-page`;
    const id2 = await openWindow(activeUrl);
    await findWindowWithUrl('/active-page');
    // Give the page tile time to attach the webview + auto-focus it.
    await sleep(500);

    // Synthesize cmd+shift+T into the GUEST webContents — i.e. simulate
    // pressing the shortcut while focus is inside the webpage the user
    // is reading. This is what triggers the page-host's webview
    // before-input-event listener.
    const result = (await app.evaluateMain!(({ webContents }) => {
      const all = webContents.getAllWebContents();
      const guests = all.filter((wc: any) => typeof wc.hostWebContents !== 'undefined' && wc.hostWebContents);
      if (guests.length === 0) return { error: 'no guest webContents found', total: all.length };
      // Pick the most recently created guest — the active-page webview.
      const guest = guests[guests.length - 1];
      try {
        guest.sendInputEvent({
          type: 'keyDown',
          keyCode: 'T',
          modifiers: process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift'],
        } as any);
        return { ok: true, url: guest.getURL() };
      } catch (e: any) {
        return { error: e.message };
      }
    })) as any;

    expect(result.error, JSON.stringify(result)).toBeUndefined();

    const reopened = await findWindowWithUrl('/from-webview-shortcut', 8000);
    expect(reopened, 'cmd+shift+T from inside the webview must reopen the closed window').toBeTruthy();

    // Cleanup
    await closeWindowById(id2);
    if (reopened) {
      const reopenedId = await bgWindow.evaluate(async (u: string) => {
        const r = await (window as any).app.window.list({ includeInternal: false });
        if (!r.success) return null;
        const w = r.windows.find((win: any) => win.url?.includes(u));
        return w?.id ?? null;
      }, '/from-webview-shortcut');
      if (reopenedId != null) await closeWindowById(reopenedId);
    }
  });

  test('reopened window has same webview screenBounds as original (regression: width/height growth)', async () => {
    // User-reported regression: closing a web-page window and using
    // cmd+shift+T to undo-close brings it back "wayyy wider". Root cause:
    // the close handler subtracted only the fixed canvas chrome from the
    // OS window bounds, so any side-panel extraWidth (entities/notes/…)
    // stayed in the saved width. On reopen that inflated value became the
    // WEBVIEW size, then panels expanded the window again — each cycle
    // compounded. The page-host URL params (x/y/width/height) hold the
    // canonical webview screenBounds and must round-trip exactly.

    const url = `http://127.0.0.1:${serverPort}/bounds-roundtrip`;
    const explicitW = 720;
    const explicitH = 540;

    // Open with explicit width/height (passed through to api.window.open).
    const openResult = await bgWindow.evaluate(async (args: { u: string; w: number; h: number }) => {
      return await (window as any).app.window.open(args.u, { width: args.w, height: args.h });
    }, { u: url, w: explicitW, h: explicitH });
    expect(openResult.success).toBe(true);
    const id = openResult.id as number;

    await findWindowWithUrl('bounds-roundtrip');

    // Read page-host URL params — the authoritative webview screenBounds.
    const originalParams = (await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.getHostUrlParamsByUrl('bounds-roundtrip');
    }) as any)) as { x: number; y: number; width: number; height: number } | null;
    expect(originalParams).not.toBeNull();
    expect(originalParams!.width).toBe(explicitW);
    expect(originalParams!.height).toBe(explicitH);

    // Subscribe to window:removed BEFORE closing for a deterministic gate.
    await bgWindow.evaluate((closingId: number) => {
      (window as any).__roundtripRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === closingId) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
    }, id);

    await closeWindowById(id);
    await bgWindow.evaluate(() => (window as any).__roundtripRemoved);

    // Reopen via the shortcut — same code path the user hits with cmd+shift+T.
    const reopenResult = await reopenViaShortcut();
    expect(reopenResult.success).toBe(true);
    expect(reopenResult.url).toContain('bounds-roundtrip');

    const reopened = await findWindowWithUrl('bounds-roundtrip', 8000);
    expect(reopened).toBeTruthy();

    const reopenedParams = (await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.getHostUrlParamsByUrl('bounds-roundtrip');
    }) as any)) as { x: number; y: number; width: number; height: number } | null;
    expect(reopenedParams).not.toBeNull();

    expect(reopenedParams!.width,
      `width drift: original=${originalParams!.width} reopened=${reopenedParams!.width}`).toBe(originalParams!.width);
    expect(reopenedParams!.height,
      `height drift: original=${originalParams!.height} reopened=${reopenedParams!.height}`).toBe(originalParams!.height);

    // Cleanup.
    const reopenedId = await bgWindow.evaluate(async (u: string) => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r.success) return null;
      const w = r.windows.find((win: any) => win.url?.includes(u));
      return w?.id ?? null;
    }, 'bounds-roundtrip') as number | null;
    if (reopenedId != null) await closeWindowById(reopenedId);
  });

  test('hide-then-close keepLive tile: stack does NOT lose the most recent real close', async () => {
    // A workspace tile that is `keepLive: true` is hidden (not closed)
    // when you cmd+W it. If the most-recently-pushed entry was a real
    // page close before that, undo-close should still bring back the page.
    // Also covers the inverse: closing a non-reopenable window (HUD,
    // background) shouldn't break the stack for a subsequent real close.

    const pageUrl = `http://127.0.0.1:${serverPort}/before-keep-live`;
    const pageId = await openWindow(pageUrl);
    await findWindowWithUrl('/before-keep-live');

    // Now open and close a websearch home tile (keepLive workspace).
    // Closing it should hide, not push to stack.
    await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      api.publish('cmd:execute:open web search', {});
    });

    // Wait for the websearch window to appear, then close it.
    let websearchId: number | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await bgWindow.evaluate(async () => {
        const r = await (window as any).app.window.list({ includeInternal: true });
        if (!r.success) return null;
        const win = r.windows.find((w: any) => (w.url || '').includes('peek://websearch/'));
        return win?.id ?? null;
      });
      if (result != null) {
        websearchId = result;
        break;
      }
      await sleep(150);
    }
    expect(websearchId).not.toBeNull();

    const stackBeforeWebsearchClose = await getStackCount();
    await closeWindowById(websearchId!);
    await sleep(300);
    const stackAfterWebsearchClose = await getStackCount();
    // keepLive tile hides — must NOT push.
    expect(stackAfterWebsearchClose).toBe(stackBeforeWebsearchClose);

    // Now close the page tile.
    await closeWindowById(pageId);
    await sleep(300);

    // Reopen — should bring back the page tile, not anything else.
    const result = await reopenViaShortcut();
    expect(result.success).toBe(true);
    expect(result.url).toContain('/before-keep-live');
    const reopened = await findWindowWithUrl('/before-keep-live', 8000);
    expect(reopened).toBeTruthy();
  });
});
