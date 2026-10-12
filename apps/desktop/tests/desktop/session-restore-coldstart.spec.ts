/**
 * COLD-START restore-fidelity harness — the faithful repro the warm oracle
 * (session-restore-oracle.spec.ts) structurally cannot produce.
 *
 * WHY A SEPARATE SPEC: the warm oracle proved the moveTop reconstruction is
 * correct up to 8 windows (incl. the deferred set) when restore is invoked in an
 * ALREADY-RUNNING process via __peek_test.forceRestoreSession. But the live
 * regression is at real cold start: `restoreSessionSnapshot(..., isColdStart=true)`
 * is awaited INSIDE the async `prefs` handler (entry.ts:1429), racing the app's
 * own boot-window creation (settings host, test fixture, overlays). The warm
 * bridge can't exercise that race.
 *
 * Two hard gates that shape this harness (verified in source):
 *   1. Boot auto-restore is SKIPPED for test profiles — `isTestProfile()` keys on
 *      the profile name starting with "test" (config.ts:70) and
 *      restoreSessionSnapshot early-returns for it (session.ts:960). So we launch
 *      under a `tmp-` profile: `isEphemeralProfile()` true (skips the single-
 *      instance lock, config.ts:90) but `isTestProfile()` FALSE, so the real
 *      boot restore path runs.
 *   2. The privileged test-fixture renderer (`peek://test/`, needed for
 *      evaluateMain / bgWindow) is gated by the `E2E_TEST` env var, NOT the
 *      profile name (desktop-app.ts:244) — the fixture always sets it — so it
 *      still attaches under a `tmp-` profile.
 *
 * The fixture's getOrCreateTempDir reuses one temp dir per profile string within
 * a run (desktop-app.ts:90), so relaunching the SAME profile string persists the
 * saved snapshot into the second (cold) launch.
 *
 * WHAT IT ASSERTS: the deterministic first-frame → ordered-re-assert WIRING (via
 * getRestoreFocusCounters: firstFrameReasserts === pageHosts). It does NOT assert
 * the on-screen stack, because macOS only makes a window orderable for the
 * FRONTMOST app and Playwright never makes Electron frontmost — the moveTops are
 * window-server no-ops under the harness. The actual pixels are proven on a real
 * frontmost launch by apps/desktop/tests/helpers/restore-proof/run-real-coldstart.sh
 * (verified PASS). Pass-ordering
 * correctness is covered by the warm oracle (session-restore-oracle.spec.ts).
 *
 * Run (visible; paints windows twice):
 *   bash apps/desktop/tests/helpers/restore-proof/run-coldstart.sh       # this spec (mechanism, under Playwright)
 *   bash apps/desktop/tests/helpers/restore-proof/run-real-coldstart.sh  # real frontmost launch — proves the pixels
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import http from 'http';
import path from 'path';

const CG_HELPER = path.resolve('apps/desktop/tests/helpers/cg-windows.swift');

// Non-test, ephemeral profile: boot auto-restore RUNS, instance lock SKIPPED.
// A fixed string is fine — getOrCreateTempDir appends a per-process suffix, so
// each run gets a fresh dir, reused across this run's two same-profile launches.
const PROFILE = 'tmp-restore-coldstart';

// Front→back TARGET: 5 hybrid web pages in front, 3 internal tiles behind. With
// SESSION_EAGER_RESTORE_COUNT=5 the back 3 restore DEFERRED (restoreBlank).
const TARGET_FRONT_TO_BACK = ['P1', 'P2', 'P3', 'P4', 'P5', 'T1', 'T2', 'T3'] as const;
type Slug = (typeof TARGET_FRONT_TO_BACK)[number];
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

let server: http.Server;
let serverPort = 0;

test.describe('Restore Cold-Start Oracle @desktop', () => {
  test.beforeAll(async () => {
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
  });

  const urlFor = (s: Slug) => (IS_TILE[s] ? TILE_URL[s] : `http://127.0.0.1:${serverPort}/${s}`);

  function slugForX(x: number): Slug | null {
    for (const s of TARGET_FRONT_TO_BACK) if (Math.abs(x - X_OF[s]) <= 20) return s;
    return null;
  }

  /** Map a saved-snapshot window URL back to a slug (page = /Pn suffix; tile =
   *  exact peek:// URL). Lets us read the saved ledger order independent of CG. */
  function slugForUrl(url: string): Slug | null {
    for (const s of TARGET_FRONT_TO_BACK) {
      if (IS_TILE[s]) {
        if (url === TILE_URL[s]) return s;
      } else if (url.endsWith(`/${s}`)) {
        return s;
      }
    }
    return null;
  }

  /** True macOS stack (front→back) restricted to our test windows, as slugs.
   *  Gated by layer==0 (normal windows) and Y≈row so fixed app windows whose X
   *  aliases to a slug at the tight spacing are excluded. */
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
      if (w.layer !== 0) continue;
      if (Math.abs(w.y - Y) > 40) continue;
      if (w.w <= 100 || w.w >= 1200) continue;
      const s = slugForX(w.x);
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  async function pidOf(app: DesktopApp): Promise<number> {
    return (await app.evaluateMain!((() => process.pid) as any)) as number;
  }

  async function openWindow(bg: Page, slug: Slug): Promise<number> {
    const r = await bg.evaluate(
      async (arg: { u: string; x: number; y: number; w: number; h: number }) =>
        (window as any).app.window.open(arg.u, { x: arg.x, y: arg.y, width: arg.w, height: arg.h }),
      { u: urlFor(slug), x: X_OF[slug], y: Y, w: W, h: H },
    );
    expect(r.success, `open ${slug}`).toBe(true);
    return r.id as number;
  }

  test('cold-start restore fires the ordered z-order re-assert for every page-host', async () => {
    // ---- LAUNCH 1: arrange + save, then quit ----
    let app = await launchDesktopApp(PROFILE);
    let bg = await app.getBackgroundWindow();
    await waitForExtensionsReady(bg);
    const pid1 = await pidOf(app);

    const ids: Record<Slug, number> = {} as Record<Slug, number>;
    for (const s of TARGET_FRONT_TO_BACK) {
      ids[s] = await openWindow(bg, s);
      await app.getWindow(IS_TILE[s] ? urlFor(s) : `/${s}`, 15000).catch(() => null);
    }

    // Arrange to TARGET: drive real z (moveTop) AND the focus-recency ledger
    // (fireWindowFocus) per window, back→front. One pass = one sweep.
    const backToFront = [...TARGET_FRONT_TO_BACK].reverse();
    const applyArrangement = async () => {
      for (const s of backToFront) {
        await app.evaluateMain!(((electron: any, id: number) => {
          const w = electron.BaseWindow.getAllWindows().find((x: any) => x.id === id);
          if (w && typeof w.moveTop === 'function') w.moveTop();
        }) as any, ids[s]);
        await app.evaluateMain!(((_e: unknown, id: number) =>
          (globalThis as any).__peek_test.fireWindowFocus(id)) as any, ids[s]);
      }
    };

    // Re-apply the arrangement until the on-screen stack SETTLES to target. This
    // is TEST SETUP, not a workaround in the system under test (cold restore):
    // at HEADLESS=0 real windows grab OS focus on show, firing async 'focus'
    // events that bump the focus-recency ledger AFTER our scripted sweep — a
    // genuine window-server boundary. We nudge until the stack matches, exactly
    // as a user drags windows until the layout looks right, then save THAT. If it
    // never converges, the non-convergence is itself the finding: a tile that
    // refuses to stay back = a focus-steal-on-show root cause (report it).
    //
    // The on-screen stack is read through CGWindowList (cg-windows.swift), which
    // exists only on macOS. Elsewhere the loop settles on the saved snapshot's
    // order instead — the same focus-recency ledger the restore imports, and
    // what the snapshot assertion below checks.
    const canReadStack = process.platform === 'darwin';
    const readArrangement = async (): Promise<string[]> => {
      if (canReadStack) return cgStack(pid1);
      await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);
      const s = (await app.evaluateMain!((() =>
        (globalThis as any).__peek_test.getLastSnapshot()) as any)) as any;
      return (s?.windows ?? [])
        .filter((w: any) => slugForUrl(String(w.url)))
        .sort((a: any, b: any) => b.zOrder - a.zOrder)
        .map((w: any) => slugForUrl(String(w.url)) as string);
    };
    const targetKey = TARGET_FRONT_TO_BACK.join(' ');
    let baseline: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      await applyArrangement();
      await new Promise((r) => setTimeout(r, 200));
      baseline = await readArrangement();
      if (baseline.join(' ') === targetKey) break;
      if (attempt === 19) {
        console.log(`[coldstart] BASELINE never converged after ${attempt + 1} sweeps — last: ${baseline.join(' ')}`);
      }
    }
    console.log(`\n[coldstart] BASELINE (arranged) front→back: ${baseline.join(' ')}  (target ${targetKey})`);

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);
    const snap = (await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as any)) as any;
    const snapWins = (snap?.windows ?? []).filter((w: any) => slugForUrl(String(w.url)));
    const snapOrder = [...snapWins]
      .sort((a: any, b: any) => b.zOrder - a.zOrder)
      .map((w: any) => slugForUrl(String(w.url)));
    console.log(`[coldstart] SAVED snapshot: reason=${snap?.reason} ourWindows=${snapWins.length} order=${snapOrder.join(' ')}`);
    for (const w of snapWins) {
      console.log(`           ${String(w.url).slice(0, 48).padEnd(48)} z=${w.zOrder} focused=${w.focused}`);
    }
    expect(snapWins.length, 'saved snapshot must capture our windows').toBeGreaterThanOrEqual(TARGET_FRONT_TO_BACK.length);

    expect(baseline, 'arrangement must have taken before quitting').toEqual([...TARGET_FRONT_TO_BACK]);
    expect(snapOrder, 'saved snapshot order must match arrangement').toEqual([...TARGET_FRONT_TO_BACK]);

    // Quit the first instance. The snapshot is already persisted (forceSaveSession
    // wrote feature_settings); close() terminates the process for a true cold start.
    await app.close();

    // ---- LAUNCH 2: cold start — boot auto-restore runs (non-test profile) ----
    app = await launchDesktopApp(PROFILE);
    bg = await app.getBackgroundWindow();
    const pid2 = await pidOf(app);

    // WHAT THIS ASSERTS — and why NOT the on-screen stack. Cold-start restore
    // re-asserts the saved z-order each time a page-host reports its FIRST
    // COMPOSITED FRAME (the private hybrid:first-frame IPC → the session.ts
    // producer dispatches WINDOW_CONTENT_ORDERABLE and the window-state machine
    // re-drives SET_STACKING for the window + everything above it in the
    // imported saved order). That wiring is deterministic and observable here:
    // getRestoreFocusCounters() reports pageHosts (registered) and
    // firstFrameReasserts (page-hosts that composited and drove a re-drive).
    //
    // But whether each moveTop then STICKS is gated by macOS window-server
    // orderability, which holds ONLY for the OS-frontmost app. Playwright launches
    // Electron WITHOUT making it frontmost (did-become-active never fires,
    // isAppFocused() is false), so the moveTops are window-server no-ops and the CG
    // stack stays tiles-in-front — a HARNESS limitation, not a product bug. The
    // real on-screen result is proven on a genuine frontmost launch by
    // helpers/restore-proof/run-real-coldstart.sh (verified PASS: P1 P2 P3 P4 P5 T1 T2 T3). So here we
    // assert the MECHANISM fired for every page-host and only LOG the
    // (expected-wrong-under-Playwright) CG stack. Ordering correctness of the pass
    // itself is covered by the warm oracle (session-restore-oracle.spec.ts).
    await waitForExtensionsReady(bg).catch(() => null);
    const readCounters = () => app.evaluateMain!(
      (() => (globalThis as any).__peek_test.getRestoreFocusCounters()) as any,
    ) as Promise<{ pageHosts: number; firstFrameReasserts: number }>;
    let counters = { pageHosts: 0, firstFrameReasserts: 0 };
    for (let i = 0; i < 40; i++) {
      counters = await readCounters();
      if (counters.pageHosts > 0 && counters.firstFrameReasserts >= counters.pageHosts) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const restored = canReadStack ? cgStack(pid2) : ['<no CGWindowList off macOS>'];
    const counts = (await app.evaluateMain!(((electron: any) => ({
      base: electron.BaseWindow.getAllWindows().length,
      browser: electron.BrowserWindow.getAllWindows().length,
    })) as any)) as { base: number; browser: number };
    console.log(`[coldstart] WINDOW COUNTS after cold restore: base=${counts.base} browser=${counts.browser}`);
    console.log(`[coldstart] MECHANISM counters: pageHosts=${counters.pageHosts} firstFrameReasserts=${counters.firstFrameReasserts}`);
    console.log(`[coldstart] CG stack (NOT asserted — Playwright not frontmost): ${restored.join(' ')}  (real-launch proof: apps/desktop/tests/helpers/restore-proof/run-real-coldstart.sh)\n`);

    await app.close();

    // The deterministic requirement Playwright CAN verify: every restored page-host
    // composited and re-ran the ordered z-order pass. The pixels are proven
    // separately (frontmost) by helpers/restore-proof/run-real-coldstart.sh.
    expect(counters.pageHosts, 'all 5 restored web pages must arm the first-frame re-assert').toBe(5);
    expect(counters.firstFrameReasserts,
      'every armed page-host must report first-frame and drive a re-assert').toBe(counters.pageHosts);
  });
});
