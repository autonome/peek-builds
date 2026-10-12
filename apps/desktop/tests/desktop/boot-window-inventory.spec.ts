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
 * That is now the entire PRODUCTION fixed set (1). mcp-server, windows,
 * websearch, peeks AND slides are all lazy (no resident entry) and are NOT
 * in the boot set; each loads on first command invocation or lazyEvent
 * (windows additionally wakes on its manifest global hotkey via the
 * main-side feature-shortcut-registrar; websearch wakes on the core
 * `page:search-engine-discovered` lazyEvent; peeks wakes on its
 * `cli:peek-open` lazyEvent; slides wakes on its `cli:slide-open` lazyEvent
 * — both fired by their static-default global wake hotkeys registered at
 * boot by the registrar). Under E2E_TEST=true the boot inventory also
 * carries a settings host (peek://app/settings/) and the test-fixture
 * renderer (peek://test/), so the measured fixed count here is 3.
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
import { hybridBridgePresent } from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

// URL substrings that MUST all be present among the boot windows before we
// consider the fixed inventory settled. Just the core orchestrator now —
// mcp-server, windows, websearch, peeks AND slides are all lazy (no resident
// entry) and none appears at boot; windows wakes on its global hotkey /
// cmd:execute:windows, websearch wakes on the core
// `page:search-engine-discovered` lazyEvent, peeks wakes on its
// `cli:peek-open` lazyEvent, and slides wakes on its `cli:slide-open`
// lazyEvent (the last two fired by their static-default global wake hotkeys).
const EXPECTED_RESIDENT_URLS = [
  'peek://app/background.html',
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

  test('fixed boot inventory: no new resident tile sneaks into the boot set', async () => {
    // The FIXED half, split out of the per-page-host measurement below so it
    // runs under hybrid. It was previously interleaved with that measurement's
    // canvas-only structural asserts, so the skip that had to cover those also
    // masked this guard — the whole file reported a skip and guarded nothing.
    // Nothing here is page-host-shape dependent: it counts the boot window set
    // and asserts what must not be in it.
    //
    // This test must stay FIRST in the file. It reads the boot inventory, and
    // the measurement below opens four page-hosts that would contaminate it.

    // ── 1. Deterministically wait for boot to settle ──────────────────────
    // Poll the live window set (MAIN process) until every expected
    // resident-tile URL is present and no window is still without a URL. No
    // timers — this resolves the instant the last resident tile finishes
    // loading its URL. The no-empty-URL half matters because the chrome
    // extension bridge window (`chrome-extensions.ts _spawnBridgeWindow`) is
    // created whenever its service worker starts, and until its load commits
    // it cannot be told apart from a new resident tile by URL.
    await app.evaluateMain!(((electron: typeof import('electron'), expected: string[]) => {
      const { BrowserWindow } = electron;
      return new Promise<void>((resolve) => {
        const check = () => {
          const urls = BrowserWindow.getAllWindows().map((w) => {
            try { return w.webContents.getURL(); } catch { return ''; }
          });
          const allPresent = expected.every((needle) =>
            urls.some((u) => u.includes(needle)));
          if (allPresent && urls.every((u) => u !== '')) { resolve(); return; }
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

    // peeks is now lazy: its background window must NOT be in the boot set.
    const peeksAtBoot = fixed.windows.some((w) => w.url.includes('peek://peeks/'));
    expect(peeksAtBoot).toBe(false);

    // slides is now lazy too: its background window must NOT be in the boot set.
    const slidesAtBoot = fixed.windows.some((w) => w.url.includes('peek://slides/'));
    expect(slidesAtBoot).toBe(false);

    // ── 3. Regression assertion on the FIXED background-window count ───────
    // Observed fixed count, macOS 2026-08-18, hybrid: 4.
    // Breakdown:
    //   - peek://app/background.html         core orchestrator
    //   - peek://app/settings/settings.html  settings host present at boot
    //   - peek://test/index.html             E2E test-fixture renderer
    //                                        (test-only; only when E2E_TEST=true)
    //   - peek://app/page/overlay.html       the shared chrome overlay
    //                                        (`hybrid-overlay.ts`), hidden
    // The overlay is the one that was never recorded here: this guard was
    // written for the canvas era and last observed 3, before the overlay
    // became a resident boot window. It is a single shared window for all
    // page-hosts, not per-page, so it belongs in the FIXED half.
    // The PRODUCTION fixed background-window count is 2 (core + overlay); the
    // other two are settings + the test fixture. There are NO resident
    // feature bg tiles left. mcp-server, windows, websearch, peeks and slides
    // are all lazy (no resident entry) and none is in the boot set; windows
    // wakes on its global hotkey via the main-side feature-shortcut-registrar
    // publishing cmd:execute:windows, websearch wakes on the core
    // `page:search-engine-discovered` lazyEvent, peeks wakes on its
    // `cli:peek-open` lazyEvent, and slides wakes on its `cli:slide-open`
    // lazyEvent (peeks/slides fired by their static-default global wake
    // hotkeys registered at boot by the registrar).
    // Ceiling is the observed count exactly, so a NEW resident tile sneaking
    // into the boot set fails the test. It used to carry +1 of slack, which is
    // what let the overlay land here unnoticed; the slack is not restored.
    //
    // Two kinds of window are left out of the count because they are not
    // tiles and whether they exist yet at this point is not fixed:
    //   - desktop markers (`peek://spaces/signal.html`,
    //     `desktop-marker-manager.ts`): one per visited desktop, minted only
    //     when the run is not headless — always the case on Linux, where
    //     `scripts/playwright-with-display.sh` unsets HEADLESS.
    //   - chrome extension bridge windows (`chrome-extension://…`): one per
    //     enabled extension that declares externally_connectable, spawned
    //     once its service worker is running, off the boot path.
    const residentCount = fixed.windows
      .filter((w) => !w.url.includes('peek://spaces/signal.html'))
      .filter((w) => !w.url.startsWith('chrome-extension://')).length;
    expect(residentCount).toBeLessThanOrEqual(4);
  });

  test('per-page-host cost', async () => {
    // CANVAS-ONLY structural measurement — skipped now that hybrid is the only page-host.
    // This test asserts the canvas page-host SHAPE:
    // each opened page-host is a window whose URL contains `peek://app/page/`
    // (the canvas shell) PLUS exactly one embedded `<webview>` webContents
    // (expectations at the bottom: pageHostWindows===K, pageHostWebviews===K,
    // and the deterministic wait that polls for K `peek://app/page/` windows +
    // K `getType()==='webview'` WCs). In the current (hybrid-only) architecture
    // a page-host is an OPAQUE WebContentsView inside a BaseWindow: the host
    // window's URL is the real http(s) content URL (no `peek://app/page/`
    // shell) and there is NO `<webview>` (the content WC type is
    // 'browserView'). So the page-host poll never satisfies (60s timeout) and
    // the per-page structural counts can't hold — this is a fundamental
    // measurement-shape difference, NOT a product bug. Hybrid page-host
    // enumeration/structure is covered by hybrid-windows-feature.spec.ts and
    // hybrid-overlay.spec.ts; a hybrid boot-inventory measurement (1 BaseWindow
    // + 1 WebContentsView per page, no shell/webview) is a separate rewrite.
    // TODO(pagehost-hybrid): port the per-page-host cost measurement to the
    // hybrid shape. Tracked for Batch D. The FIXED boot-count regression guard
    // that used to sit inside this test is now its own test above, so this skip
    // no longer masks it.
    test.skip(
      await hybridBridgePresent(app),
      'canvas-only page-host structural measurement (peek://app/page/ shell + embedded <webview>); hybrid page-hosts have neither (TODO Batch D rewrite)',
    );

    // Baseline for the gross-delta log below. Boot has already settled — the
    // fixed-inventory test above waited for it, and Playwright runs this file's
    // tests in order in a single worker against one app instance.
    const before = await captureInventory();
    const fixedWindowCount = before.windowCount;
    const fixedWcCount = before.webContentsCount;

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
  });
});
