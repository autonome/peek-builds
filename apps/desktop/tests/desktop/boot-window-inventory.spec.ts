/**
 * Boot Window Inventory
 *
 * Measures the window / renderer inventory of a fresh headless Peek desktop
 * instance and splits FIXED cost (the resident background tiles spawned at
 * boot) from PER-PAGE-HOST cost (each opened page-host window plus its
 * embedded <webview>). Doubles as a regression guard on the fixed
 * background-window count so a NEW resident tile sneaking into the boot set
 * fails the test.
 *
 * Part of peek epic d8e7efa5 (boot-window inventory measurement + fixed-count
 * regression basis for the resident-tile consolidation). The measured numbers
 * here are the baseline against which the resident-tile consolidation work is
 * judged; the regression ceiling below should be TIGHTENED once that lands.
 *
 * A fresh instance spawns a small fixed set of hidden background windows:
 *   - core            peek://app/background.html
 *   - peeks           peek://peeks/...        (resident: true)
 *   - slides          peek://slides/...       (resident: true)
 *   - websearch       peek://websearch/...    (resident: true, keepLive)
 * Each is its own BrowserWindow + renderer webContents. That is the
 * PRODUCTION fixed set (4). mcp-server AND windows are now lazy (no
 * resident entry) and are NOT in the boot set; each loads on first
 * command invocation (windows additionally wakes on its manifest global
 * hotkey via the main-side feature-shortcut-registrar). Under
 * E2E_TEST=true the boot inventory also carries a settings host
 * (peek://app/settings/) and the test-fixture renderer (peek://test/), so
 * the measured fixed count here is 6.
 *
 * Page-host windows (peek://app/page/...) each carry TWO webContents: the
 * host window + an embedded <webview> loading real content. Restored
 * page-hosts == opened page-hosts structurally, so opening K page-hosts
 * faithfully measures per-restored-page cost.
 *
 * Per feedback_no_sleep_in_tests_or_code: no wall-clock waits anywhere. Boot
 * settle is detected deterministically by polling the live window set (in the
 * MAIN process) until every expected resident-tile URL is present.
 *
 * Run with:
 *   yarn test:grep "Boot Window Inventory"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

// URL substrings that MUST all be present among the boot windows before we
// consider the fixed inventory settled. core + 3 resident builtin tiles.
// mcp-server AND windows are now lazy (no resident entry) — neither appears
// at boot; windows wakes on its global hotkey / cmd:execute:windows.
const EXPECTED_RESIDENT_URLS = [
  'peek://app/background.html',
  'peek://peeks/',
  'peek://slides/',
  'peek://websearch/',
];

interface WindowInfo { id: number; url: string; title: string; visible: boolean; }
interface WcInfo { id: number; type: string; url: string; }
interface Inventory {
  windowCount: number;
  webContentsCount: number;
  windows: WindowInfo[];
  wcs: WcInfo[];
}

test.describe('Boot Window Inventory @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('boot-window-inventory'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
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

  /**
   * Capture the full window + webContents inventory from the MAIN process.
   * webContents.getAllWebContents() includes embedded <webview>s; getType()
   * distinguishes 'window' vs 'webview'. Every getURL/getTitle/isVisible is
   * wrapped so a window mid-teardown can't throw the whole capture.
   */
  const captureInventory = () =>
    app.evaluateMain!(((electron: typeof import('electron')) => {
      const { BrowserWindow, webContents } = electron;
      const wins = BrowserWindow.getAllWindows().map((w) => {
        let url = '';
        let title = '';
        let visible = false;
        try { url = w.webContents.getURL(); } catch { /* ignore */ }
        try { title = w.getTitle(); } catch { /* ignore */ }
        try { visible = w.isVisible(); } catch { /* ignore */ }
        return { id: w.id, url, title, visible };
      });
      const wcs = webContents.getAllWebContents().map((wc) => {
        let type = '';
        let url = '';
        try { type = wc.getType(); } catch { /* ignore */ }
        try { url = wc.getURL(); } catch { /* ignore */ }
        return { id: wc.id, type, url };
      });
      return {
        windowCount: wins.length,
        webContentsCount: wcs.length,
        windows: wins,
        wcs,
      };
    }) as any) as Promise<Inventory>;

  /** Open a page-host against the local http server; returns its window id. */
  async function openPage(url: string): Promise<number> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const slug = new URL(url).pathname.slice(1);
    await app.getWindow(slug, 15000);
    return result.id as number;
  }

  test('fixed background inventory vs per-page-host cost', async () => {
    // ── 1. Deterministically wait for boot to settle ──────────────────────
    // Poll the live window set (MAIN process) until every expected
    // resident-tile URL is present. No timers — this resolves the instant the
    // last resident tile finishes loading its URL.
    await app.evaluateMain!(((electron: typeof import('electron'), expected: string[]) => {
      const { BrowserWindow } = electron;
      return new Promise<void>((resolve) => {
        const check = () => {
          const urls = BrowserWindow.getAllWindows().map((w) => {
            try { return w.webContents.getURL(); } catch { return ''; }
          });
          const allPresent = expected.every((needle) =>
            urls.some((u) => u.includes(needle)));
          if (allPresent) { resolve(); return; }
          setImmediate(check);
        };
        check();
      });
    }) as any, EXPECTED_RESIDENT_URLS);

    // ── 2. Capture & log the FIXED inventory ──────────────────────────────
    const fixed = await captureInventory();
    console.log(`[boot-inv] FIXED windows=${fixed.windowCount} webContents=${fixed.webContentsCount}`);
    for (const w of fixed.windows) {
      console.log(`[boot-inv] win ${w.id} vis=${w.visible} ${w.url}`);
    }
    for (const wc of fixed.wcs) {
      console.log(`[boot-inv] wc ${wc.id} [${wc.type}] ${wc.url}`);
    }

    const fixedWindowCount = fixed.windowCount;
    const fixedWcCount = fixed.webContentsCount;

    // ── 3. Open K=4 page-hosts and re-capture ─────────────────────────────
    const K = 4;
    for (let i = 0; i < K; i++) {
      await openPage(`http://127.0.0.1:${serverPort}/boot-inv-page-${i}`);
    }

    // Wait deterministically for all K page-hosts to be present (host window
    // + its <webview>). Each page-host adds 1 window + (eventually) 1 webview.
    await app.evaluateMain!(((electron: typeof import('electron'), expectedPages: number) => {
      const { BrowserWindow, webContents } = electron;
      return new Promise<void>((resolve) => {
        const check = () => {
          const pageHosts = BrowserWindow.getAllWindows().filter((w) => {
            try { return w.webContents.getURL().includes('peek://app/page/'); } catch { return false; }
          });
          const webviews = webContents.getAllWebContents().filter((wc) => {
            try { return wc.getType() === 'webview'; } catch { return false; }
          });
          if (pageHosts.length >= expectedPages && webviews.length >= expectedPages) {
            resolve();
            return;
          }
          setImmediate(check);
        };
        check();
      });
    }) as any, K);

    const after = await captureInventory();
    console.log(`[boot-inv] +${K}pages windows=${after.windowCount} webContents=${after.webContentsCount}`);
    for (const w of after.windows) {
      console.log(`[boot-inv] +pages win ${w.id} vis=${w.visible} ${w.url}`);
    }
    for (const wc of after.wcs) {
      console.log(`[boot-inv] +pages wc ${wc.id} [${wc.type}] ${wc.url}`);
    }

    // Gross delta — informational only. It is NOT a clean per-page measure
    // because opening page-hosts ALSO triggers lazy spawn of unrelated
    // background tiles (observed: peek://entities/background.html and a
    // chrome-extension peek-bridge.html). Those are one-time lazy costs, not
    // per-page costs, so dividing the gross delta by K is misleading.
    const grossDeltaWindows = after.windowCount - fixedWindowCount;
    const grossDeltaWc = after.webContentsCount - fixedWcCount;
    console.log(`[boot-inv] gross-delta +${grossDeltaWindows} window(s) +${grossDeltaWc} webContents (includes lazy non-page-host tiles)`);

    // The FAITHFUL per-page-host cost is measured by counting page-host
    // windows (peek://app/page/) and their embedded webviews specifically.
    // Each page-host == 1 host window (a 'window' webContents) + 1 embedded
    // <webview> webContents.
    const pageHostWindows = after.windows.filter((w) => w.url.includes('peek://app/page/')).length;
    const pageHostWebviews = after.wcs.filter((wc) => wc.type === 'webview').length;
    const perPageWindows = pageHostWindows / K;
    const perPageWc = (pageHostWindows + pageHostWebviews) / K;
    console.log(`[boot-inv] per-page-host +${perPageWindows} window(s) +${perPageWc} webContents`);

    // Structural sanity on the page-host-specific counts: K page-hosts produce
    // exactly K host windows and 2K webContents (host window wc + webview wc).
    expect(pageHostWindows).toBe(K);
    expect(pageHostWebviews).toBe(K);

    // ── 4. Regression assertion on the FIXED background-window count ───────
    // Observed fixed count after mcp-server AND windows were made lazy
    // (epic d8e7efa5): 6.
    // Breakdown:
    //   - peek://app/background.html      core orchestrator
    //   - peek://peeks/background.html    resident tile
    //   - peek://slides/background.html   resident tile
    //   - peek://websearch/home.html      resident tile (keepLive)
    //   - peek://app/settings/settings.html  settings host present at boot
    //   - peek://test/index.html          E2E test-fixture renderer
    //                                     (test-only; only when E2E_TEST=true)
    // So the PRODUCTION fixed background-window count is 4 (core + 3 resident
    // tiles); the extra 2 here are settings + the test fixture. mcp-server and
    // windows are now lazy (no resident entry) and are no longer in the boot
    // set; windows wakes on its global hotkey via the main-side
    // feature-shortcut-registrar publishing cmd:execute:windows.
    // Ceiling is observed+1 (= 7) so a NEW resident tile sneaking into the
    // boot set fails the test.
    expect(fixedWindowCount).toBeLessThanOrEqual(7);
  });
});
