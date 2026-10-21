import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

/**
 * Backend-layer SECURITY chokepoint coverage.
 *
 * Peek requires every renderer to live inside its preload + capability
 * system — `nodeIntegration: false`, `contextIsolation: true`, with a
 * known preload script. A raw `new BrowserWindow(...)` outside this
 * system would expose full Electron privileges to whatever URL it loads.
 *
 * The chokepoint lives in `entry.ts` as part of the `web-contents-created`
 * listener. It does three things:
 *   1. Validates `nodeIntegration`/`contextIsolation`/`webSecurity` on
 *      every new webContents and REFUSES a violation in every build: the
 *      webContents loads nothing and its window is torn down.
 *   2. Installs a default-deny `setWindowOpenHandler` on every
 *      'window'/'webview' webContents. Per-window code that calls
 *      `setWindowOpenHandler` later REPLACES this default — so an
 *      explicit handler wins, but unhandled `window.open(...)` from
 *      a renderer fails closed.
 *   3. Refuses a `<webview>` attach whose resulting prefs violate the
 *      policy.
 *
 * A fourth check sits one step earlier, in `ipc.ts windowOpenHandler`: a
 * window-open request carrying unsafe `webPreferences` is refused before
 * any window is built.
 *
 * These tests exercise the major flows and assert the policy holds, and
 * one test per window-open path asserts the webContents it produces is
 * isolated AND registered with the window system.
 */

test.describe('No raw BrowserWindow @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let origin = '';
  /** Every path the probe server was asked for, newest last. */
  const serverHits: string[] = [];

  test.beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        serverHits.push(req.url || '');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><title>${req.url}</title><body>${req.url}</body>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
    ({ app, bgWindow } = await createPerDescribeApp('no-raw-browserwindow'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Open a window through the canonical IPC path the way a tile does. */
  const openWindow = async (url: string, options: Record<string, unknown> = {}) =>
    bgWindow.evaluate(
      async (arg: { url: string; options: Record<string, unknown> }) =>
        await (window as unknown as {
          app: { window: { open: (u: string, o: unknown) => Promise<{ success: boolean; id?: number; error?: string }> } };
        }).app.window.open(arg.url, arg.options),
      { url, options },
    );

  const closeWindow = async (id: number | undefined) => {
    if (!id) return;
    try {
      await bgWindow.evaluate(
        async (winId: number) =>
          await (window as unknown as { app: { window: { close: (i: number) => Promise<unknown> } } })
            .app.window.close(winId),
        id,
      );
    } catch {
      // Already closed — nothing for the cleanup to do.
    }
  };

  /** The policy audit for a BrowserWindow: isolated, sandboxed, and known to Electron. */
  const auditBrowserWindow = async (id: number) => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    return app.evaluateMain<{
      registered: boolean;
      nodeIntegration: boolean;
      contextIsolation: boolean;
      sandbox: boolean;
      url: string;
    } | null, number>(({ BrowserWindow }, winId: number) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.id === winId);
      if (!win) return null;
      const p = win.webContents.getLastWebPreferences();
      return {
        registered: true,
        nodeIntegration: p?.nodeIntegration === true,
        contextIsolation: p?.contextIsolation !== false,
        sandbox: p?.sandbox !== false,
        url: win.webContents.getURL(),
      };
    }, id);
  };

  /**
   * The same audit for a hybrid page host. `BrowserWindow.getAllWindows()`
   * cannot see one — a host is a BaseWindow — so registration is read from
   * the hybrid registry through the overlay test bridge, which answers out
   * of `getAllHybridWindows()` and `getHybridContentWcIdForTest`.
   */
  const auditPageHost = async (id: number) => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    return app.evaluateMain<{
      registered: boolean;
      nodeIntegration: boolean;
      contextIsolation: boolean;
      sandbox: boolean;
      url: string;
    } | null, number>(({ webContents }, winId: number) => {
      const bridge = (globalThis as { __peekHybridOverlayTest?: { hybridIds(): number[] } }).__peekHybridOverlayTest;
      const probe = (globalThis as { __peek_test?: { getHybridContentWcIdForTest(id: number): number | null } }).__peek_test;
      if (!bridge || !probe) return null;
      if (!bridge.hybridIds().includes(winId)) return null;
      const wcId = probe.getHybridContentWcIdForTest(winId);
      if (wcId == null) return null;
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return null;
      const p = wc.getLastWebPreferences();
      return {
        registered: true,
        nodeIntegration: p?.nodeIntegration === true,
        contextIsolation: p?.contextIsolation !== false,
        sandbox: p?.sandbox !== false,
        url: wc.getURL(),
      };
    }, id);
  };

  const expectCompliant = (
    audit: { registered: boolean; nodeIntegration: boolean; contextIsolation: boolean; sandbox: boolean } | null,
    where: string,
  ) => {
    expect(audit, `${where}: the webContents must be registered with the window system`).not.toBeNull();
    expect(audit!.nodeIntegration, `${where}: nodeIntegration must be false`).toBe(false);
    expect(audit!.contextIsolation, `${where}: contextIsolation must be true`).toBe(true);
    expect(audit!.sandbox, `${where}: sandbox must be true`).toBe(true);
  };

  test('window-open IPC produces a webContents with policy-compliant prefs', async () => {
    // The canonical path: a tile (in this case the background, which
    // shares the IPC sender role with any tile) calls window.app.window.open
    // and the resulting BrowserWindow goes through Peek's pipeline.
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 400,
        height: 300,
      });
    });
    expect(result.success).toBe(true);

    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const prefs = await app.evaluateMain<{
      nodeIntegration: boolean;
      contextIsolation: boolean;
    } | null, number>(({ BrowserWindow }, id: number) => {
      const win = BrowserWindow.fromId(id);
      if (!win) return null;
      const p = win.webContents.getLastWebPreferences();
      if (!p) return null;
      return {
        nodeIntegration: p.nodeIntegration === true,
        contextIsolation: p.contextIsolation !== false,
      };
    }, result.id);

    expect(prefs).not.toBeNull();
    expect(prefs!.nodeIntegration).toBe(false);
    expect(prefs!.contextIsolation).toBe(true);

    // Clean up
    if (result.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, result.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('default-deny chokepoint blocks raw window.open from a tile renderer', async () => {
    // Open a peek:// content window. No code in Peek installs an explicit
    // setWindowOpenHandler on tile renderers' webContents (only on canvas
    // page-host guest webviews and on chrome-extension popups). The
    // chokepoint's default-deny handler therefore applies — a renderer
    // calling window.open() from inside this window must get null back
    // and NO new BrowserWindow should appear.
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://groups/home.html', {
        width: 400,
        height: 300,
      });
    });
    expect(result.success).toBe(true);
    const opened = await app.getWindow('groups/home.html', 5000);
    expect(opened).toBeTruthy();
    await opened.waitForLoadState('domcontentloaded');

    if (!app.evaluateMain) throw new Error('evaluateMain not available');

    // Invoke window.open from inside the groups renderer. Expect denial.
    const openResult = await opened.evaluate(() => {
      try {
        const w = window.open('https://example.com');
        return { returned: w === null ? 'null' : 'window', threw: false };
      } catch (e) {
        return { returned: 'error', threw: true, msg: (e as Error).message };
      }
    });

    // The deny is synchronous — no settle wait needed. Assert the specific
    // denied URL never surfaced as a BrowserWindow, regardless of concurrent
    // unrelated window churn from other tests or extension respawns.
    const exampleWindowExists = await app.evaluateMain<boolean, void>(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => {
          try { return w.webContents.getURL().startsWith('https://example.com'); }
          catch { return false; }
        }),
    );
    expect(exampleWindowExists).toBe(false);
    expect(openResult.returned).not.toBe('window');

    // Clean up
    if (result.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, result.id);
      } catch {
        // Window may already be closed
      }
    }
  });

  test('every visible top-level BrowserWindow honors the isolation policy', async () => {
    // Snapshot every currently-live BrowserWindow's webPreferences and
    // assert nodeIntegration: false and contextIsolation: true across
    // the board. Catches future regressions where a new BrowserWindow
    // construction site forgets to set them explicitly.
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const audit = await app.evaluateMain<Array<{
      id: number;
      url: string;
      type: string;
      nodeIntegration: boolean;
      contextIsolation: boolean;
    }>, void>(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().map(w => {
        const p = w.webContents.getLastWebPreferences();
        return {
          id: w.id,
          url: w.webContents.getURL(),
          type: w.webContents.getType(),
          nodeIntegration: p?.nodeIntegration === true,
          contextIsolation: p?.contextIsolation !== false,
        };
      });
    });

    for (const w of audit) {
      const where = `window ${w.id} (type=${w.type}, url=${w.url.slice(0, 80)})`;
      expect(w.nodeIntegration, `${where}: nodeIntegration must be false`).toBe(false);
      expect(w.contextIsolation, `${where}: contextIsolation must be true`).toBe(true);
    }
  });

  test('a provoked violation is refused: no content runs, the window is destroyed, the app lives', async () => {
    // Construct a BrowserWindow the way nothing in Peek does — outside the
    // pipeline, with nodeIntegration on. `sandbox` stays TRUE on purpose:
    // sandbox:false is a separate, FATAL check (sandbox-enforcement.ts) that
    // would exit the app instead of exercising this refusal.
    //
    // The page proves whether it ran by reaching the probe server; the request
    // lands whether or not the renderer can be inspected afterwards, which it
    // cannot once the window is gone.
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const markerPath = '/unsafe-window-marker';
    const markerUrl = `${origin}${markerPath}`;
    const page =
      `data:text/html,<img src="${markerUrl}">` +
      `<script>fetch(${JSON.stringify(markerUrl)},{mode:'no-cors'}).catch(function(){})</script>`;

    const constructed = await app.evaluateMain<{ id: number | null }, string>(
      ({ BrowserWindow }, url: string) => {
        let id: number | null = null;
        try {
          const win = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: true, sandbox: true },
          });
          // Reading `id` throws once the refusal has destroyed the window,
          // which is itself a pass — the assertions below accept either.
          try { id = win.id; } catch { id = null; }
          try { void win.loadURL(url).catch(() => {}); } catch { /* already gone */ }
        } catch { /* construction itself may not survive the refusal */ }
        return { id };
      },
      page,
    );

    // The refused window is torn down. Poll rather than assert once: the owner
    // only resolves at the first navigation, which is one event away.
    await expect
      .poll(
        async () =>
          constructed.id === null ||
          (await app.evaluateMain!<boolean, number>(
            ({ BrowserWindow }, winId: number) =>
              !BrowserWindow.getAllWindows().some((w) => w.id === winId),
            constructed.id,
          )),
        { message: 'the refused window must be destroyed' },
      )
      .toBe(true);

    // Nothing in it ever ran.
    expect(serverHits.filter((p) => p === markerPath), 'the refused page must never load').toEqual([]);

    // And the app is still here — a refusal contains one window, it does not
    // exit the process the way a sandbox violation does.
    const after = await openWindow('peek://groups/home.html', { width: 400, height: 300 });
    expect(after.success, 'the app keeps serving window-open after a refusal').toBe(true);
    await closeWindow(after.id);
  });

  test('a window-open request carrying unsafe webPreferences is refused and builds no window', async () => {
    const path = '/unsafe-override';
    const result = await openWindow(`${origin}${path}`, {
      width: 400,
      height: 300,
      webPreferences: { nodeIntegration: true },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('nodeIntegration=true');
    expect(result.id).toBeFalsy();
    // No window was built, so nothing ever fetched the URL.
    expect(serverHits.filter((p) => p === path), 'no window may be built for a refused request').toEqual([]);
  });

  test('window-open path: a tile window (also the path session restore and tile:window:open take)', async () => {
    // Session restore and the strict `tile:window:open` IPC create no window
    // of their own — both route through `invokeWindowOpen`, which is this
    // path — so this test covers all three.
    const result = await openWindow('peek://groups/home.html', { width: 400, height: 300 });
    expect(result.success).toBe(true);

    expectCompliant(await auditBrowserWindow(result.id!), 'tile window via window-open');
    await closeWindow(result.id);
  });

  test('window-open path: the direct BrowserWindow branch (about:blank)', async () => {
    // `about:blank` takes windowOpenHandler's direct `new BrowserWindow`
    // branch rather than the tile branch, and that branch spreads the
    // caller's webPreferences — so it is the one that most needs this audit.
    const result = await openWindow('about:blank', { width: 400, height: 300 });
    expect(result.success).toBe(true);

    expectCompliant(await auditBrowserWindow(result.id!), 'direct BrowserWindow branch (about:blank)');
    await closeWindow(result.id);
  });

  test('window-open path: a page host for a web URL', async () => {
    const result = await openWindow(`${origin}/page-host`, { width: 700, height: 500 });
    expect(result.success).toBe(true);

    await expect
      .poll(async () => (await auditPageHost(result.id!)) !== null, {
        message: 'the page host must register with the hybrid registry',
      })
      .toBe(true);
    expectCompliant(await auditPageHost(result.id!), 'page host for a web URL');
    await closeWindow(result.id);
  });

  test('window-open path: a popup opened by window.open from inside a page host', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const bridgePresent = await app.evaluateMain<boolean, void>(
      () => !!(globalThis as { __peekHybridOverlayTest?: unknown }).__peekHybridOverlayTest,
    );
    test.skip(!bridgePresent, 'no hybrid overlay test bridge in this configuration');

    const opener = await openWindow(`${origin}/popup-opener`, { width: 700, height: 500 });
    expect(opener.success).toBe(true);
    await expect
      .poll(async () => (await auditPageHost(opener.id!)) !== null, { message: 'opener host must register' })
      .toBe(true);

    const existing = await app.evaluateMain<number[], void>(
      () => (globalThis as unknown as { __peekHybridOverlayTest: { hybridIds(): number[] } })
        .__peekHybridOverlayTest.hybridIds(),
    );
    const targetUrl = `${origin}/popup-target`;
    await app.evaluateMain<unknown, { id: number; url: string }>(
      async (_e, arg) =>
        (globalThis as unknown as { __peekHybridOverlayTest: { evalInHybridContent(id: number, code: string): Promise<unknown> } })
          .__peekHybridOverlayTest.evalInHybridContent(
            arg.id,
            `window.open(${JSON.stringify(arg.url)}); true`,
          ),
      { id: opener.id!, url: targetUrl },
    );

    const popupId = await app.evaluateMain<number | null, { url: string; existing: number[] }>(
      async (_e, arg) =>
        (globalThis as unknown as {
          __peekHybridOverlayTest: { waitHybridForUrl(u: string, exclude: number[]): Promise<number | null> };
        }).__peekHybridOverlayTest.waitHybridForUrl(arg.url, arg.existing),
      { url: targetUrl, existing },
    );
    expect(popupId, 'the popup is adopted into a page host').not.toBeNull();

    expectCompliant(await auditPageHost(popupId!), 'popup from window.open in a page host');
    await closeWindow(popupId!);
    await closeWindow(opener.id);
  });

  test('window-open path: a chrome-extension page', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const extensionWindowIds = await app.evaluateMain<number[], void>(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => {
          try { return w.webContents.getURL().startsWith('chrome-extension://'); }
          catch { return false; }
        })
        .map((w) => w.id),
    );
    test.skip(
      extensionWindowIds.length === 0,
      'the test profile has no chrome-extension window live — nothing on this path to audit',
    );

    for (const id of extensionWindowIds) {
      expectCompliant(await auditBrowserWindow(id), `chrome-extension window ${id}`);
    }
  });
});
