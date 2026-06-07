/**
 * Page-host close LATENCY perf harness (peek d1cf0b9a follow-up).
 *
 * The close UAF fix (190f1a3d) routes every page-host close through
 * `closeHostWindow`, which — for a host that owns guest WebContents — DESTROYS
 * the guests and AWAITS their `'destroyed'` event (bounded by a 2000ms
 * fallback) BEFORE closing the host BaseWindow. No-guest windows keep the
 * byte-identical synchronous `win.close()` fast path.
 *
 * This harness quantifies the latency that await adds to a page-host close,
 * versus the raw pre-fix close. It is A/B'd via the same seam the fix exposes:
 *
 *   guard ON  (default)                          → ordered guest-teardown close
 *   guard OFF (PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1) → raw win.close() (pre-fix)
 *
 * Two scenarios per config:
 *   - settled : open page-host, let it quiesce, then close. The common user
 *               action (closing a tab). No relay IPC in flight.
 *   - inflight: open, fire a relay burst, then close mid-flight. The guard's
 *               worst case (guest is busy when destroy() lands).
 *
 * FLAG-GATED OUT of the normal gate: the whole describe self-skips unless
 * PEEK_RUN_PERF=1 (same pattern as the hybrid specs). It's slow and timing-
 * noisy; it is a manual harness, not a gate test.
 *
 * Run (on a QUIET, SETTLED machine — no concurrent build/test load):
 *   guard ON:  PEEK_RUN_PERF=1 yarn test:desktop:electron:spec apps/desktop/tests/desktop/page-host-close-latency.perf.spec.ts
 *   guard OFF: PEEK_RUN_PERF=1 PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1 yarn test:desktop:electron:spec apps/desktop/tests/desktop/page-host-close-latency.perf.spec.ts
 *
 * The harness prints a `PERF[close-latency]` JSON line per scenario with
 * median / p95 / max over N samples; compare ON vs OFF.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

const RUN = process.env.PEEK_RUN_PERF === '1';
const GUARD_OFF = process.env.PEEK_DISABLE_PAGEHOST_CLOSE_GUARD === '1';
const SAMPLES = Number(process.env.PEEK_PERF_SAMPLES || '40');

let app: DesktopApp;
let bgWindow: import('@playwright/test').Page;
let server: http.Server;
let serverPort: number;

function stats(xs: number[]): { n: number; median: number; p95: number; max: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, median: at(0.5), p95: at(0.95), max: s[s.length - 1], mean: Math.round(mean * 10) / 10 };
}

test.describe('Page-host close latency @desktop', () => {
  test.skip(!RUN, 'perf harness — set PEEK_RUN_PERF=1 to run');

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-close-latency'));
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

  async function openPageHost(slug: string): Promise<{ pageWindow: import('@playwright/test').Page; windowId: number }> {
    const url = `http://127.0.0.1:${serverPort}/${slug}`;
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const pageWindow = await app.getWindow(slug, 15000);
    return { pageWindow, windowId: result.id };
  }

  async function fireRelayBurst(pageWindow: import('@playwright/test').Page, burst = 150): Promise<void> {
    await pageWindow.evaluate(async (n: number) => {
      const wv = document.querySelector('webview') as any;
      if (!wv) return;
      const code = `(() => { for (let i = 0; i < ${n}; i++) { window.postMessage({ __peekRuntimeExternal: 'request', reqId: 'perf-' + i, extId: 'perf-nonexistent', message: { type: 'PERF', n: i }, origin: location.href, internal: true }, location.origin); } return true; })()`;
      await wv.executeJavaScript(code).catch(() => {});
    }, burst);
  }

  /**
   * Time, in the bgWindow renderer's clock, from issuing the close to the
   * page-host actually disappearing from the live window list. IPC round-trip +
   * registry-removal noise is COMMON to both guard configs; the ON-vs-OFF delta
   * is the cost the ordered guest-teardown adds.
   */
  async function timeClose(windowId: number): Promise<number> {
    return await bgWindow.evaluate(async (id: number) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const gone = async () => {
        const list = await (window as any).app.window.list({ includeInternal: false });
        if (!list?.success) return false;
        return !(list.windows || []).some((w: any) => w.id === id);
      };
      const t0 = performance.now();
      await (window as any).app.window.close(id);
      // Bounded poll — if it somehow never goes (shouldn't), cap at 5s.
      const deadline = t0 + 5000;
      while (performance.now() < deadline) {
        if (await gone()) break;
        await sleep(3);
      }
      return performance.now() - t0;
    }, windowId);
  }

  async function measure(scenario: 'settled' | 'inflight'): Promise<void> {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { pageWindow, windowId } = await openPageHost(`perf-${scenario}-${i}`);
      await pageWindow.waitForLoadState('domcontentloaded').catch(() => {});
      // Ensure the relay guest preload is attached so the close exercises the
      // guest-teardown path (both scenarios own a guest; only inflight is busy).
      await pageWindow.waitForFunction(async () => {
        const wv = document.querySelector('webview') as any;
        if (!wv) return false;
        const rid = await wv.executeJavaScript('(window.chrome && window.chrome.runtime && window.chrome.runtime.id) || null').catch(() => null);
        return typeof rid === 'string' && rid.length > 0;
      }, undefined, { timeout: 15000 }).catch(() => {});

      if (scenario === 'settled') {
        await bgWindow.waitForTimeout(50); // let it quiesce
      } else {
        await fireRelayBurst(pageWindow).catch(() => {});
      }

      samples.push(await timeClose(windowId));

      // Let the close settle before the next sample.
      await bgWindow.waitForFunction(async () => {
        const list = await (window as any).app.window.list({ includeInternal: false });
        if (!list?.success) return false;
        return !(list.windows || []).some((w: any) => typeof w.url === 'string' && w.url.startsWith('peek://app/page/'));
      }).catch(() => {});
    }
    const guard = GUARD_OFF ? 'OFF(raw-close)' : 'ON(ordered-teardown)';
    // Emit a single machine-greppable line per scenario.
    console.log(`PERF[close-latency] ${JSON.stringify({ guard, scenario, ...stats(samples), ms: 'all-fields-ms' })}`);
  }

  test('settled-close latency', async () => {
    test.setTimeout(180_000);
    await measure('settled');
  });

  test('inflight-close latency', async () => {
    test.setTimeout(180_000);
    await measure('inflight');
  });
});
