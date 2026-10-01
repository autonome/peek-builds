/**
 * Page host stays usable while its page's renderer is blocked.
 *
 * A page can block its renderer two ways: an infinite script loop, or a
 * blocking dialog (alert, confirm, prompt, beforeunload). In every case the
 * chrome overlay must attach to the host, the open call must report the
 * window, and the user must still be able to navigate elsewhere and close.
 *
 * Run with:
 *   yarn test:grep "Page host blocked renderer"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady } from '../helpers/hybrid-page';
import http from 'http';
import net from 'net';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;
const sockets = new Set<net.Socket>();

// Inline scripts run before dom-ready, so the headless dialog neutralisation
// (injected on dom-ready) has not replaced alert/confirm/prompt yet: these hit
// the real blocking dialog path.
const PAGES: Record<string, string> = {
  loop: '<script>for(;;){}</script>',
  alert: '<script>alert("blocked")</script>',
  confirm: '<script>confirm("blocked")</script>',
  prompt: '<script>prompt("blocked")</script>',
  // beforeunload only prompts after a user gesture; the body handler is
  // registered up front and the test sends a click first.
  beforeunload:
    '<body style="margin:0"><div style="width:800px;height:600px">x</div>' +
    '<script>window.addEventListener("beforeunload",function(e){e.preventDefault();e.returnValue="stay"})</script></body>',
};

test.describe('Page host blocked renderer @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-blocked-renderer'));
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const m = /^\/block\/(\w+)/.exec(req.url || '');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (m && PAGES[m[1]]) {
          res.end(`<!DOCTYPE html><title>${m[1]}</title>${PAGES[m[1]]}`);
        } else {
          res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
        }
      });
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    for (const s of sockets) s.destroy();
    if (server) server.close();
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // Runs `fn(bridge, arg)` in the main process; the function is shipped as source.
  const bridge = <T>(fn: (b: any, arg: any) => T, arg?: unknown) =>
    app.evaluateMain!(((_e: unknown, a: { src: string; arg: unknown }) =>
      new Function('b', 'arg', `return (${a.src})(b, arg)`)(
        (globalThis as any).__peekHybridOverlayTest,
        a.arg,
      )) as any, { src: fn.toString(), arg }) as Promise<Awaited<T>>;

  const publish = (topic: string, msg: Record<string, unknown>) =>
    bridge((b, a) => b.publishTopic(a.topic, a.msg), { topic, msg });

  const openBlocked = async (kind: string): Promise<number> => {
    const url = `http://127.0.0.1:${serverPort}/block/${kind}`;
    const before = await bridge((b) => (b.hybridIds ? b.hybridIds() : []) as number[]);
    await bgWindow.evaluate((u: string) => {
      const w = window as any;
      w.__blockedOpen = { settled: false, result: null as unknown };
      w.app.window.open(u, { width: 800, height: 600 }).then((r: unknown) => {
        w.__blockedOpen.settled = true;
        w.__blockedOpen.result = r;
      });
    }, url);
    const id = await bridge((b, a) => b.waitHybridForUrl(a.url, a.before, 8000) as Promise<number | null>, {
      url,
      before,
    });
    expect(id, 'a hybrid page-host should be registered').not.toBeNull();
    return id as number;
  };

  const closeWindow = (id: number) => bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id);

  for (const kind of Object.keys(PAGES)) {
    // A headless run auto-accepts beforeunload (entry.ts headless guard), so a
    // navigation away from such a page cannot be observed blocked here; only
    // the stop/close test below runs for it.
    const navigates = kind !== 'beforeunload';
    (navigates ? test : test.skip)(`${kind}: chrome attaches, open reports, navigate and close work`, async () => {
      test.setTimeout(60000);
      test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');
      const id = await openBlocked(kind);

      // The open call reports the window even though the page is blocked.
      await expect
        .poll(() => bgWindow.evaluate(() => (window as any).__blockedOpen as { settled: boolean; result: any }), {
          timeout: 6000,
        })
        .toMatchObject({ settled: true, result: { success: true, id } });

      // Chrome overlay attaches to the host.
      await bridge((b, i) => b.setActive(i), id);
      await expect
        .poll(() => bridge((b) => b.activeId() as number | null), { timeout: 8000 })
        .toBe(id);
      await waitOverlayReady(app);

      // Navigating elsewhere works (the blocked page goes away).
      const target = `http://127.0.0.1:${serverPort}/ok/after-${kind}`;
      await publish('page:navigate', { windowId: id, url: target });
      await expect
        // A stuck renderer is probed a few seconds after the navigation starts.
        .poll(() => bridge((b, i) => b.contentUrl(i) as string, id), { timeout: 15000 })
        .toContain(`/ok/after-${kind}`);

      // Close works.
      const closed = await Promise.race([
        bgWindow.evaluate(async (i: number) => {
          await (window as any).app.window.close(i);
          return true;
        }, id),
        new Promise<boolean>((r) => setTimeout(() => r(false), 6000)),
      ]);
      expect(closed, 'window.close resolves').toBe(true);
      await expect
        .poll(() => bridge((b, i) => b.hostVisibility(i), id), { timeout: 5000 })
        .toBeFalsy();
    });

    test(`${kind}: stop and close work without navigating`, async () => {
      test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');
      const id = await openBlocked(kind);
      await publish('page:stop', { windowId: id });
      const closed = await Promise.race([
        closeWindow(id).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 6000)),
      ]);
      expect(closed, 'window.close resolves').toBe(true);
      await expect
        .poll(() => bridge((b, i) => b.hostVisibility(i), id), { timeout: 5000 })
        .toBeFalsy();
    });
  }
});
