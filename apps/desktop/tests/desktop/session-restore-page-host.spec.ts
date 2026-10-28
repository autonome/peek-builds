/**
 * Session restore — page-host state coherence
 *
 * User-reported regression: page hosts restored after a session are broken
 * — can't execute shortcuts, can't resize, "looks like a maximize call is
 * being made". Working hypothesis: the page-host's JS state (`isMaximized`,
 * body class, resize-handle visibility, screenBounds) and its OS-level
 * BrowserWindow bounds drift apart on restore because session restore
 * reconstitutes only the bounds — never the maximized flag — and the
 * page-host never re-derives "I was maximized" from its inputs.
 *
 * These tests pin the failure with a deterministic save+restore cycle
 * driven via `__peek_test.forceSaveSession` / `forceRestoreSession`
 * (which bypass the test-profile guard in `session.ts`). The expected
 * post-FSM behavior is encoded as assertions; today the maximized-restore
 * test will fail.
 *
 * Run with:
 *   yarn test:grep "Session Restore Page Host"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { publishOverlayTopic } from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Session Restore Page Host @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-page-host'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
            `<body><h1>${req.url}</h1></body></html>`,
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

  async function openPageHost(url: string): Promise<{ pageWindow: Page; windowId: number }> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    // Match by the URL slug so we don't pick up a leftover page-host
    // from an earlier test that has a different inner http URL. Slug
    // chosen unique per test (e.g. 'normal-roundtrip', 'max-roundtrip')
    // and survives URL-encoding of the page-host's `?url=` query value.
    const slug = new URL(url).pathname.slice(1);
    const pageWindow = await app.getWindow(slug, 15000);
    return { pageWindow, windowId: result.id };
  }

  /**
   * Reset window state to a clean slate before each test. Closes EVERY
   * non-internal window — not just page-hosts. A prior test can leak a
   * non-page-host window (e.g. the focus-order test opens a Settings window and
   * closes it fire-and-forget); if that survives into the next test it gets
   * captured in that test's forceSaveSession snapshot, which pushes the intended
   * target past the eager-restore cutoff into the deferred path (whose content
   * only loads on a host-window focus event that never fires headless) — so the
   * restored target never appears and the test times out. Closing all
   * non-internal windows here makes each test independent of what a sibling left
   * behind, regardless of close ordering.
   */
  async function resetState() {
    await bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return;
      for (const w of list.windows || []) {
        await (window as any).app.window.close(w.id);
      }
    });
    // Wait for close to complete: poll the list until no non-internal windows remain.
    await bgWindow.waitForFunction(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      return (list.windows || []).length === 0;
    });
  }

  async function getHostState(pageWindow: Page) {
    return await pageWindow.evaluate(() => {
      return {
        bodyMaximized: document.body.classList.contains('maximized'),
        urlParams: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
        // Resize handles stay reachable in maximized so the user can grab
        // a corner/edge to exit-and-resize in one gesture (RESIZE_START
        // transition from MAXIMIZED). The pre-2026-05-05 behavior set them
        // display:none in maximized; this test now just confirms the handle
        // exists in the DOM.
        seHandleExists: !!document.getElementById('resize-se'),
      };
    });
  }

  /**
   * Trigger the page-host's `toggleMaximize` by dispatching a dblclick on
   * the navbar element — same path the user takes. Waits for
   * `window.__pageModuleReady` (set at the end of page.js module eval) so
   * the dblclick listener at the bottom of page.js is guaranteed installed
   * before we dispatch.
   */
  async function maximizePageHost(pageWindow: Page) {
    await pageWindow.waitForFunction(() => (window as any).__pageModuleReady === true);
    await pageWindow.evaluate(() => {
      const nav = document.getElementById('navbar')!;
      nav.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
  }

  async function waitForBodyMaximized(pageWindow: Page, expected: boolean, timeoutMs = 5000) {
    await pageWindow.waitForFunction(
      (want: boolean) => document.body.classList.contains('maximized') === want,
      expected,
      { timeout: timeoutMs },
    );
  }

  /**
   * The window-registry entry for `id`, or null. This is how geometry is read
   * for a hybrid page host: it is a BaseWindow, so `BrowserWindow.fromId()`
   * returns null for it, and the presenter behind `app.window.list` is the seam
   * that reports `bounds` / `maximized` / `preMaxBounds` for hybrid and
   * non-hybrid windows alike.
   */
  async function findEntry(id: number) {
    return bgWindow.evaluate(async (targetId: number) => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return null;
      return (r.windows || []).find((w: any) => w.id === targetId) ?? null;
    }, id);
  }

  /**
   * Wait until `id`'s registry entry reports `maximized === want` and, when
   * `bounds` is given, exactly those bounds. Waits on the state transition
   * itself rather than on elapsed time — the topics below are published
   * fire-and-forget, so the entry IS the completion signal.
   */
  async function waitForEntry(
    id: number,
    want: { maximized?: boolean; bounds?: { x: number; y: number; width: number; height: number } },
  ) {
    // `expect.poll`, NOT `page.waitForFunction`. The predicate has to await an
    // IPC round trip, and waitForFunction does not await a promise its
    // predicate returns — it tests the returned Promise object for truthiness,
    // which is always true, so the wait resolves on the first tick and guards
    // nothing. `expect.poll` awaits the async poller properly.
    await expect
      .poll(async () => {
        const e = await findEntry(id);
        if (!e) return null;
        return { maximized: e.maximized, bounds: e.bounds };
      }, { timeout: 10000 })
      .toEqual(
        want.bounds !== undefined && want.maximized !== undefined
          ? { maximized: want.maximized, bounds: want.bounds }
          : expect.objectContaining(
              want.bounds !== undefined ? { bounds: want.bounds } : { maximized: want.maximized },
            ),
      );
  }

  /** Close `id` and resolve once it is gone from the registry. */
  async function closeAndAwait(id: number) {
    await bgWindow.evaluate(async (targetId: number) => {
      await (window as any).app.window.close(targetId);
    }, id);
    await bgWindow.waitForFunction(async (targetId: number) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      return !(list.windows || []).some((w: any) => w.id === targetId);
    }, id);
  }

  /** Force a restore, then resolve the restored window's id by URL slug. */
  async function restoreAndFind(slug: string): Promise<number> {
    const restoreResult = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as any) as
      { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThanOrEqual(1);

    const restoredPageWindow = await app.getWindow(slug, 15000);
    await restoredPageWindow.waitForLoadState('domcontentloaded');
    const restoredId = await bgWindow.evaluate(async (s: string) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return null;
      const match = (list.windows || []).find(
        (w: any) => typeof w.url === 'string' && w.url.includes(s),
      );
      return match ? match.id : null;
    }, slug) as number | null;
    expect(restoredId, `restored window for ${slug} should be in the registry`).not.toBeNull();
    return restoredId!;
  }

  /** Open a hybrid page host for `slug`, skipping if it did not come back hybrid. */
  async function openHybridPageHost(slug: string): Promise<number> {
    const { pageWindow, windowId } = await openPageHost(`http://127.0.0.1:${serverPort}/${slug}`);
    await pageWindow.waitForLoadState('domcontentloaded');
    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    test.skip(!isHybrid, 'not a hybrid page-host');
    return windowId;
  }

  test.beforeEach(async () => {
    await resetState();
  });

  // Tests ----------------------------------------------------------------

  // The four tests immediately below are canvas-only and all skip under hybrid,
  // which is the only page-host architecture that ships. They assert geometry
  // by reading `?width`/`?height` off the shell page's URL, and a hybrid page
  // host has no shell page. Where each one's hybrid coverage lives, so a skip
  // is not mistaken for an uncovered behaviour:
  //
  //   non-maximized bounds round-trip      → 'hybrid page host: bounds round-trip
  //                                           through save+restore'
  //   max → unmax → resize → restart       → 'hybrid page host: maximize →
  //                                           unmaximize → resize smaller → …'
  //
  // (The canvas maximize round-trip tests were removed with the behaviour they
  // asserted: a maximized window is no longer restored maximized — see
  // 'hybrid page host: a window maximized at save time restores unmaximized …'.)
  //
  //   edge resize handle (drag E)          → NO HYBRID PORT. Asserts the shell
  //                                           page's `#resize-e` DOM handle;
  //                                           a hybrid host has no such element.
  //   maximized corner resize (drag SE)    → NO HYBRID PORT, same reason.
  //
  // The two unported ones are real gaps: resize-gesture behaviour on a hybrid
  // host is untested here. Gesture coverage that does exist lives in
  // `hybrid-content-window-gesture.spec.ts` and the hold-to-drag group in
  // `hybrid-overlay.spec.ts`, neither of which covers edge/corner resize.

  test('non-maximized page host: bounds round-trip through save+restore', async () => {
    const url = `http://127.0.0.1:${serverPort}/normal-roundtrip`;
    const { pageWindow, windowId } = await openPageHost(url);

    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    test.skip(isHybrid, 'canvas page-host only — hybrid loads the bare site URL with no ?width/?height chrome params these assertions need');

    // Wait for page-host to fully initialize (URL params populated).
    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const beforeState = await getHostState(pageWindow);
    expect(beforeState.bodyMaximized).toBe(false);

    // Save the snapshot before closing.
    await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

    // Close the window and wait for window:removed for determinism.
    const initialWindowId = await pageWindow.evaluate(async () => {
      const r = await (window as any).app.window.getInfo();
      return r?.id ?? null;
    });
    await bgWindow.evaluate((id: number) => {
      (window as any).__sessionRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === id) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
      (window as any).app.window.close(id);
    }, initialWindowId);
    await bgWindow.evaluate(() => (window as any).__sessionRemoved);

    // Now restore.
    const restoreResult = await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThan(0);

    // Wait for the restored window to appear.
    const restoredPageWindow = await app.getWindow('normal-roundtrip', 15000);
    await restoredPageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const afterState = await getHostState(restoredPageWindow);
    expect(afterState.bodyMaximized).toBe(false);
    expect(afterState.urlParams.width).toBe(beforeState.urlParams.width);
    expect(afterState.urlParams.height).toBe(beforeState.urlParams.height);
  });

  test('maximize → unmaximize → resize smaller → restart: bounds restore at resized size, not maximized', async () => {
    const url = `http://127.0.0.1:${serverPort}/unmax-resize-roundtrip`;
    const { pageWindow, windowId } = await openPageHost(url);

    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    test.skip(isHybrid, 'canvas page-host only — hybrid loads the bare site URL with no ?width/?height chrome params these assertions need');

    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    // Capture pre-maximize URL bounds for comparison.
    const preMaximizeUrl = await getHostState(pageWindow);
    const preMaximizeWidth = parseInt(preMaximizeUrl.urlParams.width as string, 10);
    const preMaximizeHeight = parseInt(preMaximizeUrl.urlParams.height as string, 10);

    // Maximize.
    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, true);

    // Unmaximize via the same navbar dblclick path.
    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, false);

    // Resize smaller through the SE corner handle — pointer events drive
    // the same FSM path the user does. Drag the SE handle 200px up-left
    // to shrink the window.
    await pageWindow.evaluate(() => {
      const handle = document.getElementById('resize-se')!;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1, screenX: 600, screenY: 500,
      }));
      handle.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1, pointerId: 1, screenX: 400, screenY: 300,
      }));
      handle.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, button: 0, pointerId: 1,
      }));
    });

    // Wait for the resize to settle in URL params.
    await pageWindow.waitForFunction(({ w, h }) => {
      const p = new URL(window.location.href).searchParams;
      const cw = parseInt(p.get('width') || '0', 10);
      const ch = parseInt(p.get('height') || '0', 10);
      return cw < w && ch < h && !p.has('maximized');
    }, { w: preMaximizeWidth, h: preMaximizeHeight });

    const beforeState = await getHostState(pageWindow);
    expect(beforeState.bodyMaximized,
      `pre-save: body.maximized must be false after unmaximize+resize`).toBe(false);
    expect(beforeState.urlParams.maximized,
      `pre-save: URL must NOT carry maximized=1 after unmaximize+resize`).toBeUndefined();
    const resizedWidth = parseInt(beforeState.urlParams.width as string, 10);
    const resizedHeight = parseInt(beforeState.urlParams.height as string, 10);

    // Save.
    await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

    // Close.
    await bgWindow.evaluate((id: number) => {
      (window as any).__unmaxRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === id) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
      (window as any).app.window.close(id);
    }, windowId);
    await bgWindow.evaluate(() => (window as any).__unmaxRemoved);

    // Restore.
    const restoreResult = await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThan(0);

    const restoredPageWindow = await app.getWindow('unmax-resize-roundtrip', 15000);
    await restoredPageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const afterState = await getHostState(restoredPageWindow);

    expect(afterState.bodyMaximized,
      `restored page host should NOT be maximized — user unmaximized + resized before restart`).toBe(false);
    expect(afterState.urlParams.maximized,
      `restored URL should NOT carry maximized=1`).toBeUndefined();
    expect(parseInt(afterState.urlParams.width as string, 10),
      `restored width should match resized width`).toBe(resizedWidth);
    expect(parseInt(afterState.urlParams.height as string, 10),
      `restored height should match resized height`).toBe(resizedHeight);
  });

  test('edge resize handle: dragging E changes width only, not height', async () => {
    const url = `http://127.0.0.1:${serverPort}/edge-resize`;
    const { pageWindow, windowId } = await openPageHost(url);

    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    test.skip(isHybrid, 'canvas page-host only — hybrid loads the bare site URL with no ?width/?height chrome params these assertions need');

    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const before = await getHostState(pageWindow);
    const startW = parseInt(before.urlParams.width as string, 10);
    const startH = parseInt(before.urlParams.height as string, 10);

    await pageWindow.evaluate(() => {
      const handle = document.getElementById('resize-e')!;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1, screenX: 800, screenY: 400,
      }));
      handle.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1, pointerId: 1, screenX: 700, screenY: 400,
      }));
      handle.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, button: 0, pointerId: 1,
      }));
    });

    await pageWindow.waitForFunction((w) => {
      const p = new URL(window.location.href).searchParams;
      return parseInt(p.get('width') || '0', 10) < w;
    }, startW);

    const after = await getHostState(pageWindow);
    const endW = parseInt(after.urlParams.width as string, 10);
    const endH = parseInt(after.urlParams.height as string, 10);
    expect(endW, 'E-edge drag should shrink width').toBeLessThan(startW);
    expect(endH, 'E-edge drag must NOT change height').toBe(startH);
  });

  test('maximized corner resize: drag SE inward exits maximize and shrinks in one gesture', async () => {
    const url = `http://127.0.0.1:${serverPort}/max-corner-resize`;
    const { pageWindow, windowId } = await openPageHost(url);

    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    test.skip(isHybrid, 'canvas page-host only — hybrid loads the bare site URL with no ?width/?height chrome params these assertions need');

    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, true);

    const maxState = await getHostState(pageWindow);
    const maxW = parseInt(maxState.urlParams.width as string, 10);
    const maxH = parseInt(maxState.urlParams.height as string, 10);

    await pageWindow.evaluate(() => {
      const handle = document.getElementById('resize-se')!;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1, screenX: 1400, screenY: 800,
      }));
      handle.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1, pointerId: 1, screenX: 1000, screenY: 600,
      }));
      handle.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, button: 0, pointerId: 1,
      }));
    });

    await waitForBodyMaximized(pageWindow, false);

    const after = await getHostState(pageWindow);
    expect(after.bodyMaximized, 'should have exited maximize').toBe(false);
    expect(after.urlParams.maximized, 'URL should not carry maximized=1 after resize-from-max').toBeUndefined();
    const endW = parseInt(after.urlParams.width as string, 10);
    const endH = parseInt(after.urlParams.height as string, 10);
    expect(endW, 'width should have shrunk from maximized size').toBeLessThan(maxW);
    expect(endH, 'height should have shrunk from maximized size').toBeLessThan(maxH);
  });

  // ── Focus-order regression (hybrid page-host) ──────────────────────────
  //
  // User-observed bug (hybrid page-host): open a Settings window, then
  // open a web page (a hybrid page-host) so the WEB PAGE is the frontmost /
  // focused window. Quit. Relaunch. EXPECTED: the web page is restored as the
  // frontmost/focused window. ACTUAL (bug): Settings is in front; the web page
  // is not raised.
  //
  // This is a REAL-OUTCOME test, not a proxy: it drives the genuine focus path
  // (the host BaseWindow's 'focus' event — the exact event Electron fires on OS
  // focus; `baseWin.focus()` cannot grant real focus on macOS-headless), then
  // the real save→restore cycle, and asserts the OUTCOME — the snapshot marks
  // the web page focused, and after restore the IZUI coordinator's focused
  // window IS the restored web page (not Settings).
  test('focus-order: a focused hybrid web page is restored frontmost over a Settings window', async () => {
    const slug = 'focus-order-roundtrip';
    const url = `http://127.0.0.1:${serverPort}/${slug}`;

    // Open Settings (a peek:// BrowserWindow). It updates the per-app focus
    // tracker (lastFocusedVisibleWindowId) on focus, exactly like the real app.
    const settingsResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://app/settings/settings.html', {
        width: 1000, height: 700, key: 'focus-order-settings',
      });
    });
    expect(settingsResult.success).toBe(true);
    const settingsWindowId = settingsResult.id as number;
    const settingsWindow = await app.getWindow('settings/settings.html', 15000);
    await settingsWindow.waitForLoadState('domcontentloaded');

    // Open the web page. This is a BaseWindow page-host; its content
    // webContents loads the bare http URL (no canvas ?width/height wrapper),
    // so we just wait for the page to load.
    const { pageWindow, windowId: webWindowId } = await openPageHost(url);
    await pageWindow.waitForLoadState('domcontentloaded');

    // Defensive: skip cleanly if the opened window is not a live hybrid
    // page-host, the same way the hybrid-overlay suite does.
    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, webWindowId) as boolean;
    test.skip(!isHybrid, 'not a hybrid page-host — focus-order bug is hybrid-only');

    // The user clicks into the web page → it becomes frontmost/focused. Drive
    // the REAL host-BaseWindow 'focus' event (Electron's own event on OS focus).
    const focused = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as any, webWindowId) as boolean;
    expect(focused, 'focusHybridWindowForTest should find the live hybrid window').toBe(true);

    // Save the snapshot.
    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as any);

    // OUTCOME 1 (save side): the snapshot must mark the WEB PAGE as the focused
    // descriptor — not Settings. With the bug, the hybrid focus never updates
    // lastFocusedVisibleWindowId, so Settings (the last BrowserWindow to update
    // it) is recorded focused.
    const snapshot = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as any) as
      { windows: Array<{ url: string; focused: boolean }> } | null;
    expect(snapshot, 'snapshot should exist after forceSaveSession').not.toBeNull();
    const focusedDescriptor = (snapshot!.windows || []).find((w) => w.focused) || null;
    expect(focusedDescriptor, 'snapshot must carry exactly one focused descriptor').not.toBeNull();
    expect(
      focusedDescriptor!.url,
      'snapshot focused window must be the WEB PAGE, not Settings (save-side: hybrid focus must feed lastFocusedVisibleWindowId)',
    ).toContain(slug);

    // Close both windows so restore has work to do.
    await bgWindow.evaluate(async (ids: number[]) => {
      for (const id of ids) {
        await (window as any).app.window.close(id);
      }
    }, [webWindowId, settingsWindowId]);
    await bgWindow.waitForFunction(async (ids: number[]) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      const live = new Set((list.windows || []).map((w: any) => w.id));
      return ids.every((id) => !live.has(id));
    }, [webWindowId, settingsWindowId]);

    // Restore with the app focused (so the restore focus path actually runs).
    await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.setAppFocusedForTest(true)) as any);
    const restoreResult = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as any) as
      { restored: number; failed: number; total: number };
    expect(restoreResult.restored, 'both windows should restore').toBeGreaterThanOrEqual(2);

    // Find the restored web page window (its content URL carries the slug).
    const restoredPageWindow = await app.getWindow(slug, 15000);
    await restoredPageWindow.waitForLoadState('domcontentloaded');
    // Resolve the restored hybrid window id by matching the slug in the live
    // window list (the restored window has a fresh id; match on content URL).
    const restoredId = await bgWindow.evaluate(async (s: string) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return null;
      const match = (list.windows || []).find(
        (w: any) => typeof w.url === 'string' && w.url.includes(s),
      );
      return match ? match.id : null;
    }, slug) as number | null;
    expect(restoredId, 'restored web window must be enumerable').not.toBeNull();

    // OUTCOME 2 (restore side): the focused hybrid window must have actually
    // been RAISED + focused. restoreSessionSnapshot's post-loop focus block
    // resolves the focused window via getLiveWindow (BrowserWindow.fromId) —
    // which returns null for a hybrid BaseWindow — and only increments the
    // `focuses` counter when it actually calls .focus() on the resolved window.
    // With the bug, the hybrid window is never resolved, so .focus() is skipped
    // and `focuses` stays 0 (Settings stays frontmost). The fix falls back to
    // the hybrid registry's baseWin and raises it. This counter is the real
    // signal that the raise happened — not just that izui's id was seeded.
    const counters = await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.getRestoreFocusCounters()) as any) as
      { shows: number; showInactives: number; focuses: number };
    expect(
      counters.focuses,
      'restore must actually raise+focus the restored hybrid web page (not skip it because getLiveWindow returns null for a BaseWindow)',
    ).toBeGreaterThanOrEqual(1);

    // The app's notion of the frontmost window must be the restored WEB PAGE,
    // not Settings. Assert against the window-state machine's `front` — the
    // sole focus authority since step 8c deleted the izui coordinator's own
    // tracker. Machine ids are branded strings ("wm-1"), so map the restored
    // window's numeric id through the machine registry first.
    const machineRestoredId = await app.evaluateMain!(((_e: unknown, numericId: number) =>
      (globalThis as any).__peek_test.getMachineWindowIdFor(numericId)) as any,
      restoredId) as string | null;
    expect(machineRestoredId, 'restored web page is registered with the window-state machine').not.toBeNull();
    const frontWindowId = await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.getFrontWindowId()) as any) as string | null;
    expect(
      frontWindowId,
      'after restore, the machine front must be the restored web page (raised over Settings), not Settings',
    ).toBe(machineRestoredId);

    // Cleanup: close everything this test opened + release the focus override.
    await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.clearAppFocusedForTest()) as any);
    await bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return;
      for (const w of list.windows || []) {
        if (typeof w.url === 'string'
          && (w.url.includes('focus-order-roundtrip') || w.url.includes('settings/settings.html'))) {
          await (window as any).app.window.close(w.id);
        }
      }
    });
  });

  // Hybrid ports of the canvas-only geometry round-trips ------------------
  //
  // The canvas tests above assert geometry by reading `?width`/`?height`
  // off the page-host shell page's URL, and a hybrid page host has no shell
  // page — so all six skip, and geometry round-trip had no coverage at all on
  // the only page-host architecture that exists. These three read geometry from
  // the registry instead, which is architecture-independent. Two of the canvas
  // six have no port and are marked as such at their skip.

  test('hybrid page host: bounds round-trip through save+restore', async () => {
    const slug = 'hybrid-bounds-roundtrip';
    const windowId = await openHybridPageHost(slug);

    // Drive the window to distinctive bounds first. Asserting the round trip
    // against whatever the open happened to produce would pass on a restore
    // that ignored the snapshot and re-applied the same open-time defaults.
    const target = { x: 120, y: 140, width: 720, height: 480 };
    await publishOverlayTopic(app, 'page:set-bounds', { windowId, bounds: target });
    await waitForEntry(windowId, { maximized: false, bounds: target });

    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as any);
    await closeAndAwait(windowId);

    const restoredId = await restoreAndFind(slug);
    const restored = await findEntry(restoredId);
    expect(restored?.bounds, 'restored window must come back at the saved bounds').toEqual(target);
    expect(restored?.maximized, 'a window saved unmaximized must not come back maximized').toBe(false);

    await closeAndAwait(restoredId);
  });

  test('hybrid page host: maximize → unmaximize → resize smaller → save+restore comes back resized, not maximized', async () => {
    const slug = 'hybrid-resize-after-unmaximize';
    const windowId = await openHybridPageHost(slug);

    await publishOverlayTopic(app, 'page:maximize', { windowId });
    await waitForEntry(windowId, { maximized: true });

    await publishOverlayTopic(app, 'page:unmaximize', { windowId });
    await waitForEntry(windowId, { maximized: false });

    // Resize smaller AFTER unmaximizing. The failure this guards is a restore
    // that reads the stale maximize stash rather than the current bounds, and
    // brings the window back maximized (or at the pre-maximize size).
    const smaller = { x: 200, y: 180, width: 420, height: 320 };
    await publishOverlayTopic(app, 'page:set-bounds', { windowId, bounds: smaller });
    await waitForEntry(windowId, { maximized: false, bounds: smaller });

    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as any);
    await closeAndAwait(windowId);

    const restoredId = await restoreAndFind(slug);
    const restored = await findEntry(restoredId);
    expect(restored?.maximized, 'a window unmaximized before save must not come back maximized').toBe(false);
    expect(restored?.bounds, 'restored window must come back at the post-unmaximize resized bounds').toEqual(smaller);

    await closeAndAwait(restoredId);
  });

  test('hybrid page host: unmaximize returns a LIVE window to its pre-maximize bounds', async () => {
    // The control for the save+restore test below. If both fail, unmaximize
    // never restores bounds on a hybrid host and `preMaxBounds` is a stash
    // nothing consumes; if only the restore one fails, the stash survives the
    // round trip as data but stops driving the window.
    const slug = 'hybrid-live-unmaximize';
    const windowId = await openHybridPageHost(slug);

    const original = { x: 170, y: 160, width: 660, height: 450 };
    await publishOverlayTopic(app, 'page:set-bounds', { windowId, bounds: original });
    await waitForEntry(windowId, { maximized: false, bounds: original });

    await publishOverlayTopic(app, 'page:maximize', { windowId });
    await waitForEntry(windowId, { maximized: true });

    await publishOverlayTopic(app, 'page:unmaximize', { windowId });
    await waitForEntry(windowId, { maximized: false, bounds: original });

    await closeAndAwait(windowId);
  });

  test('hybrid page host: a window maximized at save time restores maximized, keeping its pre-maximize bounds', async () => {
    // Maximize is restored (window-rules G12). The snapshot saves the rect the
    // window unmaximizes back to, with maximized: true; restore opens the
    // window at that rect and then maximizes it through the kernel.
    const slug = 'hybrid-premax-roundtrip';
    const windowId = await openHybridPageHost(slug);

    const original = { x: 160, y: 150, width: 640, height: 440 };
    await publishOverlayTopic(app, 'page:set-bounds', { windowId, bounds: original });
    await waitForEntry(windowId, { maximized: false, bounds: original });

    await publishOverlayTopic(app, 'page:maximize', { windowId });
    await waitForEntry(windowId, { maximized: true });

    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as any);

    const snapshot = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as any) as
      { windows: Array<{ url: string; bounds: unknown; params: Record<string, unknown> }> } | null;
    const saved = (snapshot?.windows || []).find((w) => w.url.includes(slug));
    expect(saved?.bounds, 'a maximized window is saved at its pre-maximize bounds').toEqual(original);
    expect(saved?.params.maximized, 'the snapshot records that the window was maximized').toBe(true);
    expect(saved?.params.preMaxBounds, 'the pre-maximize stash is not written to the snapshot').toBeUndefined();

    await closeAndAwait(windowId);

    const restoredId = await restoreAndFind(slug);
    await waitForEntry(restoredId, { maximized: true });

    // Unmaximizing returns the restored window to its pre-maximize bounds.
    await publishOverlayTopic(app, 'page:unmaximize', { windowId: restoredId });
    await waitForEntry(restoredId, { maximized: false, bounds: original });

    await closeAndAwait(restoredId);
  });
});
