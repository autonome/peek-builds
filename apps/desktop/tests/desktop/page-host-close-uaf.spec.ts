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
 * Why every plain http page-host has the relay: TWP (bundled, `<all_urls>`
 * ISOLATED content scripts) matches any http URL, so
 * `getRuntimeExternalWebPrefsForUrl` installs `runtime-external-preload.cjs`
 * on the guest. That preload's window→IPC bridge (runtime-external-preload.cjs
 * ~line 213) relays ANY `{__peekRuntimeExternal:'request'}` postMessage from
 * the guest's MAIN world via `ipcRenderer.invoke`. We use that to drive a
 * deterministic stream of in-flight invokes, then close mid-stream.
 *
 * The original report noted the crash needs concurrent load + an in-flight
 * message and that a settled-close micro-repro (open→close ×40) PASSES. This
 * spec supplies the missing ingredient (in-flight invokes at close) and a
 * close cadence; if the app survives the loop, the UAF is fixed.
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
   * In the page-host's <webview> guest MAIN world, fire a heavy burst of relay
   * requests (no await) so many `ipcRenderer.invoke('peek:runtime-external:send')`
   * are in transit, then keep a fast interval going. Returns once the burst is
   * posted (interval keeps running until the guest is destroyed by close).
   */
  async function startRelayStorm(pageWindow: import('@playwright/test').Page, burst = 2000): Promise<boolean> {
    return await pageWindow.evaluate((n: number) => {
      const wv = document.querySelector('webview') as any;
      if (!wv) return false;
      const code = `(() => {
        let seq = 0;
        function fire() {
          window.postMessage({
            __peekRuntimeExternal: 'request',
            reqId: 'uaf-' + (++seq) + '-' + Math.random().toString(36).slice(2),
            extId: 'uaf-nonexistent-ext',
            message: { type: 'UAF_PROBE', n: seq },
            origin: location.href,
            internal: true,
          }, location.origin);
        }
        for (let i = 0; i < ${n}; i++) fire();
        // Keep the pressure on right up to close — a fast, fat interval so
        // there are always invokes in transit when the host window closes.
        const t = setInterval(() => { for (let i = 0; i < 100; i++) fire(); }, 2);
        window.__uafStorm = t;
        return true;
      })()`;
      // executeJavaScript runs in the guest MAIN world, where the preload's
      // window 'message' listener picks the envelopes up and invokes IPC.
      wv.executeJavaScript(code).catch(() => {});
      return true;
    }, burst);
  }

  /** Probe that the relay preload bridge is actually live on this guest. */
  async function relayBridgeIsLive(pageWindow: import('@playwright/test').Page): Promise<boolean> {
    return await pageWindow.evaluate(async () => {
      const wv = document.querySelector('webview') as any;
      if (!wv) return false;
      // The MAIN-world polyfill sets chrome.runtime.id to the matched ext id
      // (TWP's runtime hash) when the runtime-external preload installed.
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
    // anything. If TWP isn't matching (env without bundled extensions), fail
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
    expect(live, 'runtime-external relay preload must be installed on the http page-host guest (is TWP loaded?)').toBe(true);
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

    // Concentrate the race: open several page-hosts concurrently, start a relay
    // storm on each, then close them all in quick succession while invokes are
    // still in transit. Concurrent closes + concurrent in-flight relay IPC is
    // the load condition the field crashes need (the report notes a single
    // settled close — even repeat-each=30 — does NOT reproduce it).
    const ROUNDS = 15;
    const CONCURRENCY = 8;
    for (let round = 0; round < ROUNDS; round++) {
      const hosts = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_v, k) =>
          openPageHost(`uaf-${round}-${k}`).catch(() => null)),
      );
      // Storm all guests (tolerate a page that already went away — only the
      // main-process death matters, checked below).
      await Promise.all(
        hosts.filter(Boolean).map(async (h) => {
          await h!.pageWindow.waitForLoadState('domcontentloaded').catch(() => {});
          await startRelayStorm(h!.pageWindow).catch(() => {});
        }),
      );
      await assertMainAlive(`during storm, round ${round}`);

      // Close them all near-simultaneously, mid-storm (one bgWindow round-trip).
      await bgWindow.evaluate((ids: number[]) => {
        for (const id of ids) (window as any).app.window.close(id);
      }, hosts.filter(Boolean).map((h) => h!.windowId)).catch(() => {});

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
