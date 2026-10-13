/**
 * Page-host close use-after-free repro (peek task d1cf0b9a / 4b2cc09d).
 *
 * Native crash: closing a page-host window whose http guest carries the
 * chrome-extension runtime-external relay preload, while a relay
 * `ipcRenderer.invoke('peek:runtime-external:send')` is in flight, faults the
 * main process — `EXC_BAD_ACCESS / KERN_INVALID_ADDRESS at 0x230`, a freed
 * cppgc (Blink GC) object derefed inside `-[NSWindow __close]` (the
 * `performClose:` path `app.window.close()` uses).
 *
 * Why every plain http page-host has the relay: Proton Pass (bundled, enabled
 * by default, ISOLATED content scripts matching `http://*\/*` and
 * `https://*\/*`) matches any http URL, so
 * `getRuntimeExternalWebPrefsForUrl` installs `runtime-external-preload.cjs`
 * on the guest. That preload's window→IPC bridge (runtime-external-preload.cjs
 * ~line 213) relays ANY `{__peekRuntimeExternal:'request'}` postMessage from
 * the guest's MAIN world via `ipcRenderer.invoke`. We use that to drive a
 * deterministic stream of in-flight invokes, then close mid-stream.
 *
 * Scope / honesty note: the field crash is LOAD-DEPENDENT — it only fires
 * under the full suite's concurrent main-thread pressure, where an invoke is
 * mid-deserialize exactly when a close lands. It is NOT reproducible in
 * isolation: this spec PASSES with the guard both ON and OFF when run alone
 * (verified). So treat it as (a) a smoke guard for the page-host close path
 * under relay traffic, and (b) extra in-flight-at-close pressure that RAISES
 * the crash probability when it runs as part of the full `yarn
 * test:desktop:electron` suite. The real before/after verification of the fix
 * is the full suite: pre-fix it produces `EXC_BAD_ACCESS` crash reports
 * (~1/2 runs); post-fix it must produce none. Do NOT crank the burst into a
 * sustained flood to force an isolated crash — that trips a DIFFERENT relay
 * bug (SIGTRAP on the IO thread) the close-guard does not address.
 *
 * The guard itself is A/B-testable via `PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1`
 * (reverts closeHostWindow to the raw pre-fix close).
 *
 * Run with:
 *   yarn test:grep "page-host close does not crash"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: import('@playwright/test').Page;
let server: http.Server;
let serverPort: number;

test.describe('Page-host close UAF @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-close-uaf'));

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

  /** Open a page-host and return its window id + the slug-matched Page. */
  async function openPageHost(slug: string): Promise<{ pageWindow: import('@playwright/test').Page; windowId: number }> {
    const url = `http://127.0.0.1:${serverPort}/${slug}`;
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const pageWindow = await app.getWindow(slug, 15000);
    return { pageWindow, windowId: result.id };
  }

  /**
   * In the page-host's <webview> guest MAIN world, fire a modest burst of relay
   * requests so a batch of `ipcRenderer.invoke('peek:runtime-external:send')` is
   * in transit / mid-deserialize when the host closes a moment later. NO
   * sustained interval — a fat continuous flood crashes the relay on a
   * *different* path (SIGTRAP on the IO thread), which is not the close-time
   * use-after-free under test. We await so the burst is definitely posted (and
   * thus the invokes are in flight) before the caller closes the host.
   */
  async function fireRelayBurst(pageWindow: import('@playwright/test').Page, burst = 150): Promise<void> {
    await pageWindow.evaluate(async (n: number) => {
      const wv = document.querySelector('webview') as any;
      if (!wv) return;
      const code = `(() => {
        for (let i = 0; i < ${n}; i++) {
          window.postMessage({
            __peekRuntimeExternal: 'request',
            reqId: 'uaf-' + i + '-' + Math.random().toString(36).slice(2),
            extId: 'uaf-nonexistent-ext',
            message: { type: 'UAF_PROBE', n: i },
            origin: location.href,
            internal: true,
          }, location.origin);
        }
        return true;
      })()`;
      // executeJavaScript runs in the guest MAIN world, where the preload's
      // window 'message' listener picks the envelopes up and invokes IPC.
      await wv.executeJavaScript(code).catch(() => {});
    }, burst);
  }

  /** Probe that the relay preload bridge is actually live on this guest. */
  async function relayBridgeIsLive(pageWindow: import('@playwright/test').Page): Promise<boolean> {
    return await pageWindow.evaluate(async () => {
      const wv = document.querySelector('webview') as any;
      if (!wv) return false;
      // The MAIN-world polyfill sets chrome.runtime.id to the matched ext id
      // (Proton Pass's runtime hash) when the runtime-external preload installed.
      const id = await wv.executeJavaScript(
        '(window.chrome && window.chrome.runtime && window.chrome.runtime.id) || null',
      ).catch(() => null);
      return typeof id === 'string' && id.length > 0;
    });
  }

  test('page-host close does not crash with in-flight relay invokes (UAF regression)', async () => {
    // 120 page-host open/storm/close cycles take a while even when healthy;
    // give headroom over the default 60s so a clean (fixed) run completes.
    test.setTimeout(180_000);

    // Sanity: the relay preload must be installed for this repro to mean
    // anything. If Proton Pass isn't matching (env without bundled extensions), fail
    // loudly rather than green-washing.
    const { pageWindow: probeWin, windowId: probeId } = await openPageHost('uaf-probe');
    await probeWin.waitForLoadState('domcontentloaded').catch(() => {});
    // Give the guest a beat to attach its preload + page polyfill.
    const live = await probeWin.waitForFunction(async () => {
      const wv = document.querySelector('webview') as any;
      if (!wv) return false;
      const id = await wv.executeJavaScript(
        '(window.chrome && window.chrome.runtime && window.chrome.runtime.id) || null',
      ).catch(() => null);
      return typeof id === 'string' && id.length > 0;
    }, undefined, { timeout: 15000 }).then(() => true).catch(() => false);
    expect(live, 'runtime-external relay preload must be installed on the http page-host guest (is Proton Pass loaded?)').toBe(true);
    await bgWindow.evaluate((id: number) => (window as any).app.window.close(id), probeId);

    // The crash signal is the MAIN process dying, which we detect by probing
    // the bgWindow (a different, durable window). A stray page-host close is
    // NOT a crash, so we never assert on a page-host page directly — only on
    // bgWindow surviving each round. Race the probe against a short deadline so
    // a dead/half-dead main faults the test FAST instead of hanging to timeout.
    const assertMainAlive = async (where: string) => {
      const alive = await Promise.race([
        bgWindow.evaluate(() => true).catch(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
      ]);
      expect(alive, `main process crashed (${where}) — page-host close UAF (d1cf0b9a)`).toBe(true);
    };

    // The trigger is CLOSING a page-host whose guest has relay IPC in flight.
    // Open a few page-hosts concurrently (some main-thread busyness so an
    // invoke is mid-deserialize when a close lands), fire a modest relay burst
    // on each, then close them all immediately — mid-flight. Repeat many rounds
    // to catch the close/deserialize coincidence the field crash needs.
    const ROUNDS = 30;
    const CONCURRENCY = 4;
    for (let round = 0; round < ROUNDS; round++) {
      const hosts = (await Promise.all(
        Array.from({ length: CONCURRENCY }, (_v, k) =>
          openPageHost(`uaf-${round}-${k}`).catch(() => null)),
      )).filter(Boolean) as Array<{ pageWindow: import('@playwright/test').Page; windowId: number }>;

      await Promise.all(
        hosts.map(async (h) => {
          await h.pageWindow.waitForLoadState('domcontentloaded').catch(() => {});
          await fireRelayBurst(h.pageWindow).catch(() => {});
        }),
      );

      // Close them all immediately while the burst's invokes are in flight.
      await bgWindow.evaluate((ids: number[]) => {
        for (const id of ids) (window as any).app.window.close(id);
      }, hosts.map((h) => h.windowId)).catch(() => {});

      await assertMainAlive(`after close, round ${round}`);

      // Let the closes settle before the next round so windows don't pile up.
      await bgWindow.waitForFunction(async () => {
        const list = await (window as any).app.window.list({ includeInternal: false });
        if (!list?.success) return false;
        return !(list.windows || []).some((w: any) =>
          typeof w.url === 'string' && w.url.startsWith('peek://app/page/'));
      }).catch(() => {});
    }
  });
});
