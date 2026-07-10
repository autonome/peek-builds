/**
 * ORACLE-BACKED restore-fidelity harness — the repro both prior fix attempts
 * lacked. Reproduces the user's "session restore order is nowhere near what I
 * left" bug with a MIX of window kinds and asserts the restored macOS window
 * stack (CGWindowList ground truth) equals the arranged-and-saved stack.
 *
 * WHY NON-HEADLESS: internal-tile BrowserWindows are the crux of the bug, and
 * `BrowserWindow.prototype.moveTop` is patched to a no-op at opacity 0 (headless)
 * in entry.ts — so a headless run cannot reproduce or validate the restore
 * moveTop pass for tiles. Hybrid page-hosts are BaseWindows (unpatched), so a
 * headless run silently "passes" the hybrid half while the tile half is a no-op.
 * This spec MUST run with real opacity (HEADLESS=0) so moveTop actually reorders
 * both kinds and CGWindowList reads the true stack. Under headless (the default
 * gate, PEEK_HEADLESS=1) macOS makes windows orderable only for the FRONTMOST app
 * and Playwright never makes Electron frontmost, so the restore moveTops are
 * window-server no-ops and the CG stack cannot reproduce the saved order — the
 * spec would fail for a harness reason, not a product bug. So it SKIPS unless
 * HEADLESS=0 is explicitly set (the run-oracle.sh path below); the gate's
 * headless-observable coverage of the same mechanism lives in
 * session-restore-focus.spec.ts (moveTops === restored count) and
 * session-restore-coldstart.spec.ts (first-frame ordered re-assert counters).
 *
 * Run (visible; paints a few windows + one focus-steal at launch):
 *   bash apps/desktop/tests/helpers/restore-proof/run-oracle.sh
 *   # or: cd apps/desktop && HEADLESS=0 BACKEND=electron npx playwright test \
 *     --config playwright.config.ts --grep "Restore Oracle"
 *
 * The window set mirrors the reported scenario: web PAGES (hybrid) in front,
 * internal TILES (editors/tags — plain BrowserWindows) behind.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { execFileSync } from 'child_process';
import http from 'http';
import path from 'path';

// Resolved against the repo root (the runner cd's there) to avoid __dirname,
// which is undefined when this spec is loaded as an ES module.
const CG_HELPER = path.resolve('apps/desktop/tests/helpers/cg-windows.swift');

let app: DesktopApp;
let bgWindow: import('@playwright/test').Page;
let server: http.Server;
let serverPort: number;

// Distinct X per slug so a CGWindow entry maps back to a slug by its X bound.
// Front→back TARGET order: web pages (hybrid) cascaded in front, editor/tiles
// behind — the reported arrangement. EIGHT windows on purpose: the eager cap is
// SESSION_EAGER_RESTORE_COUNT = 5, so with 8 windows the front 5 restore EAGER
// (real content) and the back 3 restore DEFERRED (restoreBlank, navigate-on-
// focus). The 5-window harness passed precisely because nothing was deferred;
// the live regression lives in the deferred set, so we must cross the boundary.
const TARGET_FRONT_TO_BACK = ['P1', 'P2', 'P3', 'P4', 'P5', 'T1', 'T2', 'T3'] as const;
type Slug = (typeof TARGET_FRONT_TO_BACK)[number];
// Unusual, well-separated X values (app chrome won't sit at these), matched by
// PROXIMITY (±20) not exact bounds — internal tiles may enforce a min-width
// larger than we request, growing W but not shifting X. Windows may overlap;
// z-order is what matters, and CGWindowList reports each window's own X.
const X_OF: Record<Slug, number> = {
  P1: 90, P2: 190, P3: 290, P4: 390, P5: 490, T1: 590, T2: 690, T3: 790,
};
const IS_TILE: Record<Slug, boolean> = {
  P1: false, P2: false, P3: false, P4: false, P5: false, T1: true, T2: true, T3: true,
};
const TILE_URL: Record<string, string> = {
  T1: 'peek://tags/home.html',
  T2: 'peek://groups/home.html',
  T3: 'peek://search/home.html',
};
const W = 240;
const H = 200;
const Y = 90;

test.describe('Restore Oracle @desktop', () => {
  // Headed-only: the CG-stack assertion needs real opacity + a frontmost app,
  // neither of which the headless gate provides (see file header). Runs only when
  // HEADLESS=0 is explicitly set (run-oracle.sh); skipped under the gate so it
  // never fails for a harness reason. Mechanism coverage that IS headless-safe
  // lives in the focus + coldstart specs.
  test.skip(
    process.env.HEADLESS !== '0',
    'warm restore oracle needs a frontmost, real-opacity run (HEADLESS=0)',
  );

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('restore-oracle'));
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
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

  const urlFor = (s: Slug) => (IS_TILE[s] ? TILE_URL[s] : `http://127.0.0.1:${serverPort}/${s}`);

  async function openWindow(slug: Slug): Promise<number> {
    const r = await bgWindow.evaluate(
      async (arg: { u: string; x: number; y: number; w: number; h: number }) =>
        (window as any).app.window.open(arg.u, { x: arg.x, y: arg.y, width: arg.w, height: arg.h }),
      { u: urlFor(slug), x: X_OF[slug], y: Y, w: W, h: H },
    );
    expect(r.success, `open ${slug}`).toBe(true);
    return r.id as number;
  }

  /** Map a CGWindow x-bound back to a slug (nearest known X within tolerance). */
  function slugForX(x: number): Slug | null {
    for (const s of TARGET_FRONT_TO_BACK) if (Math.abs(x - X_OF[s]) <= 20) return s;
    return null;
  }

  /** True macOS stack (front→back) restricted to our test windows, as slugs.
   *  Matches by X-proximity (robust to tiles growing wider than requested); a
   *  loose size gate drops the full-screen-ish background window; dedupe keeps
   *  each slug's FRONTMOST occurrence so shadows/children don't double-count. */
  function cgStack(pid: number): string[] {
    let raw: Array<{ x: number; y: number; w: number; h: number; layer: number }> = [];
    try {
      raw = JSON.parse(execFileSync('swift', [CG_HELPER, String(pid)], { encoding: 'utf8' }));
    } catch (e) {
      return [`<swift error: ${(e as Error).message.split('\n')[0]}>`];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of raw) {
      if (w.layer !== 0) continue; // normal windows only (drop overlays/panels)
      if (Math.abs(w.y - Y) > 40) continue; // our windows all sit at Y — this
      // gate is what isolates the test row from fixed app windows whose X might
      // otherwise alias to a slug once slugs are packed 100px apart.
      if (w.w <= 100 || w.w >= 1200) continue; // exclude bg / chrome windows
      const s = slugForX(w.x);
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  /** Count open windows in main by kind, so we can PROVE close/restore happened
   *  rather than trusting CG proximity (which false-passes if close no-ops). */
  async function windowCounts(): Promise<{ base: number; browser: number }> {
    return (await app.evaluateMain!(((electron: any) => ({
      base: electron.BaseWindow.getAllWindows().length,
      browser: electron.BrowserWindow.getAllWindows().length,
    })) as any)) as { base: number; browser: number };
  }

  test('restored macOS stack reproduces the arranged+saved stack', async () => {
    const pid = (await app.evaluateMain!((() => process.pid) as any)) as number;

    // 1. Open the mix (order here is irrelevant; we arrange explicitly next).
    const ids: Record<Slug, number> = {} as Record<Slug, number>;
    for (const s of TARGET_FRONT_TO_BACK) {
      ids[s] = await openWindow(s);
      // Let the window fully materialize (hybrid content WC / tile renderer).
      await app.getWindow(IS_TILE[s] ? urlFor(s) : `/${s}`, 15000).catch(() => null);
    }

    // 2. Arrange to TARGET by driving BOTH real z (moveTop) AND the focus-recency
    //    ledger (fireWindowFocus) per window, back→front, so a normal-user click
    //    order is modeled and the saved zOrder matches the visual stack.
    const backToFront = [...TARGET_FRONT_TO_BACK].reverse();
    for (const s of backToFront) {
      await app.evaluateMain!(((electron: any, id: number) => {
        const w = electron.BaseWindow.getAllWindows().find((x: any) => x.id === id);
        if (w && typeof w.moveTop === 'function') w.moveTop();
      }) as any, ids[s]);
      await app.evaluateMain!(((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.fireWindowFocus(id)) as any, ids[s]);
    }

    // 3. Baseline: CG stack must equal TARGET (arrangement actually took).
    const baseline = cgStack(pid);
    const openCounts = await windowCounts();
    console.log(`\n[oracle] BASELINE (arranged) front→back: ${baseline.join(' ')}  (target ${TARGET_FRONT_TO_BACK.join(' ')})`);
    console.log(`[oracle] WINDOW COUNTS after open+arrange: base=${openCounts.base} browser=${openCounts.browser}`);

    // 4. Save, then inspect the saved snapshot's zOrder/focused for the mix.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);
    const snap = (await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as any)) as any;
    const snapWins = snap?.windows ?? [];
    console.log(`[oracle] SAVED snapshot: reason=${snap?.reason} windows=${snapWins.length} (url → zOrder,focused):`);
    for (const w of snapWins) {
      console.log(`         ${String(w.url).slice(0, 48).padEnd(48)} z=${w.zOrder} focused=${w.focused}`);
    }
    expect(snapWins.length, 'saved snapshot must capture our windows').toBeGreaterThanOrEqual(TARGET_FRONT_TO_BACK.length);

    // 5. Close every restored window (registry-id API handles both kinds).
    for (const s of TARGET_FRONT_TO_BACK) {
      await bgWindow.evaluate((id: number) => (window as any).app.window.close(id), ids[s]).catch(() => null);
    }

    // 5b. PROVE the close actually happened — else restore is a no-op over still-
    //     open baseline windows and the CG match below is a false positive.
    //     Main-process destroy is the DETERMINISTIC signal (registry counts drop
    //     synchronously); the macOS window-server then tears the NSWindows down
    //     ASYNCHRONOUSLY, so CG lingers briefly. Poll CG to DRAIN (a genuine
    //     window-server boundary) before restoring, so the post-restore read
    //     cannot see the just-closed originals' lingering NSWindows.
    const afterClose = await windowCounts();
    console.log(`[oracle] WINDOW COUNTS after close: base=${afterClose.base} browser=${afterClose.browser} (was base=${openCounts.base} browser=${openCounts.browser})`);
    let closedCg: string[] = [];
    for (let i = 0; i < 40; i++) {
      closedCg = cgStack(pid);
      if (closedCg.length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`[oracle] CG stack after close-drain (should be empty of our slugs): ${closedCg.join(' ') || '<none>'}`);
    expect(closedCg, 'our windows must be gone from the screen after close').toEqual([]);

    // 6. Restore with the app treated as focused so the reconstruction pass runs
    //    (willActivate = appFocused || (coldStart && !headless)). evaluateMain
    //    awaits the returned promise, so this resolves only AFTER the restore
    //    loop + moveTop reconstruction pass have run — a deterministic signal,
    //    no timer needed to know restore is done.
    await app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.setAppFocusedForTest(true)) as any);
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceRestoreSession()) as any);

    // 7. Read the true stack. Restore has resolved (step 6 awaited it); the short
    //    bounded retry only absorbs the OS window-server / swift-helper read lag
    //    (a genuine OS boundary), not an app-state race.
    let restored: string[] = [];
    for (let i = 0; i < 20; i++) {
      restored = cgStack(pid);
      if (restored.length >= TARGET_FRONT_TO_BACK.length) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const afterRestore = await windowCounts();
    console.log(`[oracle] WINDOW COUNTS after restore: base=${afterRestore.base} browser=${afterRestore.browser}`);
    console.log(`[oracle] RESTORED front→back: ${restored.join(' ')}  (target ${TARGET_FRONT_TO_BACK.join(' ')})\n`);

    // 8. The requirement: restored stack === arranged/saved stack, exactly.
    expect(restored).toEqual([...TARGET_FRONT_TO_BACK]);
  });
});
