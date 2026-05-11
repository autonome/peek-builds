import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Backend-layer SECURITY chokepoint coverage.
 *
 * Peek requires every renderer to live inside its preload + capability
 * system — `nodeIntegration: false`, `contextIsolation: true`, with a
 * known preload script. A raw `new BrowserWindow(...)` outside this
 * system would expose full Electron privileges to whatever URL it loads.
 *
 * The chokepoint lives in `entry.ts` as part of the `web-contents-created`
 * listener. It does two things:
 *   1. Validates `nodeIntegration`/`contextIsolation` on every new
 *      webContents. Violations log + (in dev/test) throw.
 *   2. Installs a default-deny `setWindowOpenHandler` on every
 *      'window'/'webview' webContents. Per-window code that calls
 *      `setWindowOpenHandler` later REPLACES this default — so an
 *      explicit handler wins, but unhandled `window.open(...)` from
 *      a renderer fails closed.
 *
 * These tests exercise the major flows and assert the policy holds.
 */

test.describe('No raw BrowserWindow @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('no-raw-browserwindow'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

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
    const countBefore = await app.evaluateMain<number, void>(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );

    // Invoke window.open from inside the groups renderer. Expect denial.
    const openResult = await opened.evaluate(() => {
      try {
        const w = window.open('https://example.com');
        return { returned: w === null ? 'null' : 'window', threw: false };
      } catch (e) {
        return { returned: 'error', threw: true, msg: (e as Error).message };
      }
    });

    // Wait long enough for any errant window to actually surface
    await new Promise(resolve => setTimeout(resolve, 500));

    const countAfter = await app.evaluateMain<number, void>(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );

    // Either the call returned null (Electron's default on deny), or the
    // call threw. EITHER way, the window count must not have grown.
    expect(countAfter).toBe(countBefore);
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
});
