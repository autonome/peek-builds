/**
 * Hybrid page-host: window appears at LOAD-START (not load-finish).
 *
 * Feature (2026-06-25): clicking to open a page must surface the window — its
 * bordered/rounded native frame + shadow + a loading-background fill — the
 * INSTANT the load begins, as the soonest possible confirmation of the click.
 *
 * Before the fix, the hybrid open path (`ipc.ts` window-open handler, hybrid
 * EARLY BRANCH) awaited `view.webContents.loadURL(url)` to COMPLETION and only
 * then called `showHybridHost`. So a click to open a (slow) page showed NOTHING
 * — no window, no border — until the page finished loading. The fix moves the
 * `showHybridHost` call to BEFORE the `await loadURL`, and gives the BaseWindow a
 * theme `backgroundColor` so the early frame reads as a loading surface instead
 * of flashing as an empty white box. This mirrors the canvas path, where
 * `loadingLifecycle.startLoading()` adds the bordered `.loading` frame at
 * load-start.
 *
 * Observability: real OS focus/first-responder is unobservable in
 * macOS-headless, so we assert the HOST BASEWINDOW's `isVisible()` state via the
 * test bridge (the hybrid show seam is `showInactive()`+opacity-0 under
 * headless, which still flips `isVisible()` → true). We open a REAL hybrid
 * page-host (the production `app.window.open` → `invokeWindowOpen` path) against
 * a SLOW server endpoint that withholds its response, WITHOUT awaiting the open,
 * then assert the host is already VISIBLE while its content is still loading
 * (URL not yet the target). Pre-fix this is false (visible only after load);
 * post-fix it is true.
 *
 * Run with:
 *   yarn test:grep "Hybrid Load-Start Show"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;
// Holds each pending request's `res` so afterAll can release any that are still
// withheld (the test deliberately leaves a response hanging mid-load).
const pendingResponses = new Set<http.ServerResponse>();

test.describe('Hybrid Load-Start Show @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-load-start-show'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        // `/slow/*` endpoints withhold the response body for a while, so the
        // content WC stays in the LOADING state long enough for the test to
        // observe the host window already on screen. `/fast/*` responds at once.
        if (req.url && req.url.startsWith('/slow')) {
          pendingResponses.add(res);
          setTimeout(() => {
            if (pendingResponses.delete(res)) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
            }
          }, 3000);
          return;
        }
        // `/strand` delays ~1.5s then answers HTTP 204 No Content: the main-frame
        // navigation aborts with NOTHING committed (empirically: no
        // did-finish-load, getURL() stays empty) — the stranded-blank case. The
        // delay lets the test capture the host id while it is still loading,
        // before the cleanup closes it.
        if (req.url && req.url.startsWith('/strand')) {
          setTimeout(() => {
            try {
              res.writeHead(204);
              res.end();
            } catch {
              /* socket already gone */
            }
          }, 1500);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    // Release any withheld responses so nothing dangles, then shut down.
    for (const res of pendingResponses) {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><title>drained</title><body>drained</body>');
      } catch {
        /* socket already gone */
      }
    }
    pendingResponses.clear();
    if (server) server.close();
    if (app) await app.close();
  });

  const hybridBridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('the host window is visible (loading frame) while content is still loading', async () => {
    test.skip(!(await hybridBridgePresent()), 'hybrid flag off — no overlay bridge');

    const slowUrl = `http://127.0.0.1:${serverPort}/slow/load-start`;

    // Snapshot the hybrid window ids that already exist so we can identify the
    // NEW one this open creates.
    const before = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return (b.hybridIds ? b.hybridIds() : []) as number[];
    });

    // Kick off the REAL open (production window-open IPC) WITHOUT awaiting it.
    // Awaiting would block until loadURL resolves (~3s here), defeating the
    // point — we want to observe the window WHILE the content is still loading.
    await bgWindow.evaluate((u: string) => {
      (window as any).__loadStartOpen = (window as any).app.window.open(u, {
        width: 800,
        height: 600,
      });
    }, slowUrl);

    // Resolve the new hybrid window id by its REQUESTED address (set in the
    // window registry the moment the host is registered — before the content
    // finishes loading). Network-free match on the requested URL.
    const newId = await app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl(arg.url, arg.before, 8000) as Promise<number | null>;
    }) as any, { url: slowUrl, before }) as number | null;

    expect(newId, 'a new hybrid page-host should be registered for the slow URL').not.toBeNull();

    // CORE assertion: while the content is STILL loading (URL not yet the
    // target), the host BaseWindow is already VISIBLE — the loading frame is on
    // screen as the load-start confirmation. Pre-fix the host is shown only
    // AFTER loadURL resolves, so this poll never reaches { visible:true,
    // stillLoading:true } and times out (fails). Post-fix it's true immediately.
    await expect
      .poll(async () =>
        app.evaluateMain!(((_e: unknown, id: number) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const vis = b.hostVisibility(id);
          const liveUrl = b.contentUrl(id);
          if (!vis) return null;
          // "still loading" = the content WC has NOT yet committed the target
          // slow URL (it's about:blank / empty during the withheld response).
          const stillLoading = !liveUrl.includes('/slow/load-start');
          return { visible: vis.visible, stillLoading };
        }) as any, newId),
      )
      .toEqual({ visible: true, stillLoading: true });

    // Sanity: the host's BACKGROUND is an opaque theme fill (not the empty white
    // default), so the early frame reads as a loading surface, not a white box.
    const bg = await app.evaluateMain!(((_e: unknown, id: number) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBackgroundColor ? b.hostBackgroundColor(id) : null;
    }) as any, newId) as string | null;
    // #ffffff (light) or #1e1e1e (dark) — the theme background, never empty.
    expect(bg, 'host has an explicit loading-background fill').toMatch(/^#(ffffff|1e1e1e)/i);

    // Clean up: close the real page-host window (it was opened via the real
    // window-open IPC, so it's not a fake-bridge host — close it via the app
    // window API). The afterAll drains the still-withheld server response.
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, newId as number);
  });

  // Helper: snapshot existing hybrid ids, fire a real (non-awaited) open, and
  // resolve the NEW host id by its requested address — shared by the
  // fail-load cleanup cases below.
  async function openAndResolveId(url: string): Promise<number | null> {
    const before = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return (b.hybridIds ? b.hybridIds() : []) as number[];
    });
    await bgWindow.evaluate((u: string) => {
      (window as any).__failOpen = (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    return app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl(arg.url, arg.before, 8000) as Promise<number | null>;
    }) as any, { url, before }) as Promise<number | null>;
  }

  test('a stranded-blank initial load (HTTP 204, nothing committed) closes the host', async () => {
    test.skip(!(await hybridBridgePresent()), 'hybrid flag off — no overlay bridge');

    // `/strand` waits ~1.5s then answers 204 No Content. The main-frame nav
    // aborts with NO committed document: did-finish-load never fires and
    // getURL() stays empty — a blank window on the loading fill.
    const strandUrl = `http://127.0.0.1:${serverPort}/strand`;
    const id = await openAndResolveId(strandUrl);
    expect(id, 'a hybrid host should be registered for the strand URL').not.toBeNull();

    // It is visible while loading (the load-start frame), before the 204 lands.
    await expect
      .poll(async () =>
        app.evaluateMain!(((_e: unknown, hid: number) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          const v = b.hostVisibility(hid);
          return v ? v.visible : null;
        }) as any, id),
      )
      .toBe(true);

    // CORE assertion: once the 204 settles the initial load with nothing
    // committed, the stranded host is CLOSED — `hostVisibility` returns null
    // because the hybrid registry entry is gone (and the BaseWindow destroyed).
    // Pre-fix there is no cleanup, so the blank host lingers visible forever and
    // this poll times out (fails).
    await expect
      .poll(
        async () =>
          app.evaluateMain!(((_e: unknown, hid: number) => {
            const b = (globalThis as any).__peekHybridOverlayTest;
            return b.hostVisibility(hid) === null;
          }) as any, id),
        { timeout: 12000 },
      )
      .toBe(true);
  });

  test('a committed Chromium error page is NOT closed (no over-close)', async () => {
    test.skip(!(await hybridBridgePresent()), 'hybrid flag off — no overlay bridge');

    // `.invalid` is RFC-2606 reserved → ERR_NAME_NOT_RESOLVED, which COMMITS
    // Chromium's native error page (did-finish-load fires, getURL() = the failed
    // URL). That "This site can't be reached" page is a useful display: the
    // cleanup must KEEP it, not close the window.
    const badUrl = 'http://nonexistent-host-strand-keep.invalid/';
    const id = await openAndResolveId(badUrl);
    expect(id, 'a hybrid host should be registered for the bad URL').not.toBeNull();

    // Wait for the error-page load to settle: the content WC commits the failed
    // URL (chrome-error page lives at the requested URL).
    await expect
      .poll(async () =>
        app.evaluateMain!(((_e: unknown, hid: number) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl(hid);
        }) as any, id),
      )
      .toContain('nonexistent-host-strand-keep.invalid');

    // The host must STAY alive (committed error page is worth showing). Assert it
    // is still a live, visible hybrid window across a short stability window —
    // the cleanup must NOT have fired for a committed document.
    for (let i = 0; i < 3; i++) {
      const vis = await app.evaluateMain!(((_e: unknown, hid: number) => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return b.hostVisibility(hid);
      }) as any, id) as { visible: boolean } | null;
      expect(vis, 'committed-error-page host must not be closed').not.toBeNull();
      expect(vis!.visible).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
    }

    // Clean up the still-open host.
    await bgWindow.evaluate(async (hid: number) => {
      await (window as any).app.window.close(hid);
    }, id as number);
  });
});
