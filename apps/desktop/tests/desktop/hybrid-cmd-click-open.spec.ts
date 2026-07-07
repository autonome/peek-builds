/**
 * Regression (peek bebfd212): cmd+click a URL must open a NEW window that LOADS
 * and RENDERS the target — not a blank/black window.
 *
 * cmd/ctrl+click on a link is a "background-tab" open. Chromium routes it
 * through the hybrid content `setWindowOpenHandler` (installed by
 * `wireHybridContentEvents`), but for the background-tab disposition it hands the
 * handler's `createWindow` callback NO opener `webContents` to adopt (unlike a
 * scripted `window.open` / OAuth popup, where Chromium pre-creates an
 * opener-wired guest). The `allow`+`createWindow` popup path (introduced by
 * 12dec0749 for the OAuth opener bridge) minted a fresh content WC in that case
 * but never called `loadURL` on it — it assumed "Chromium navigates the returned
 * WC itself", which is only true for the ADOPTED guest. Result: the popup window
 * opened but its content WC stayed un-navigated → blank/black window.
 *
 * This test reproduces the EXACT path with a real modified click (a synthetic JS
 * `.click()` with `metaKey` does NOT carry modifier state into Chromium's
 * disposition, so only `sendInputEvent` reproduces background-tab). Everything is
 * loopback-served (network-free) and focus-free (headless, opacity 0).
 *
 * Run with:
 *   yarn test:grep "cmd-click opens a loaded"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Hybrid cmd-click open @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-cmd-click-open'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/target')) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!DOCTYPE html><title>Target</title><body id="t">target-page</body>');
          return;
        }
        // `/opener`: a full-viewport link to /target. A real cmd+left-click
        // anywhere on it triggers a background-tab open of the target URL.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<!DOCTYPE html><title>Opener</title>' +
            `<body style="margin:0"><a id="lnk" href="http://127.0.0.1:${serverPort}/target"` +
            ' style="position:fixed;inset:0;display:block">open</a></body>',
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

  const hybridBridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('cmd-click opens a loaded page, not a blank window', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');

    const openerUrl = `http://127.0.0.1:${serverPort}/opener`;
    const targetUrl = `http://127.0.0.1:${serverPort}/target`;

    // Open the opener page via the REAL production window-open path.
    await bgWindow.evaluate((u: string) => {
      (window as any).app.window.open(u, { width: 700, height: 500 });
    }, openerUrl);

    // Resolve the opener's hybrid window id.
    const openerId = (await app.evaluateMain!(((_e: unknown, arg: { url: string }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl(arg.url, [], 8000) as Promise<number | null>;
    }) as any, { url: openerUrl })) as number | null;
    expect(openerId, 'opener hybrid host should be registered').not.toBeNull();

    // Wait until the opener's content has actually committed (the link DOM is
    // present) before clicking it.
    await expect
      .poll(async () =>
        app.evaluateMain!(((_e: unknown, id: number) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl(id).includes('/opener');
        }) as any, openerId),
      )
      .toBe(true);

    // Snapshot existing hybrid ids so we can spot the NEW popup window.
    const before = (await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hybridIds() as number[];
    })) as number[];

    // REAL cmd+left-click on the full-viewport link → background-tab open.
    await app.evaluateMain!(((_e: unknown, id: number) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.sendContentModifiedClick(id, 350, 250, 'meta');
    }) as any, openerId);

    // A NEW hybrid window (id not in `before`) must appear.
    const newId = (await (async () => {
      let found: number | null = null;
      await expect
        .poll(async () => {
          const ids = (await app.evaluateMain!(() => {
            const b = (globalThis as any).__peekHybridOverlayTest;
            return b.hybridIds() as number[];
          })) as number[];
          const fresh = ids.find((i) => !before.includes(i));
          if (fresh != null) found = fresh;
          return fresh != null;
        }, { timeout: 8000 })
        .toBe(true);
      return found;
    })()) as number | null;
    expect(newId, 'cmd-click should open a new window').not.toBeNull();

    // CORE assertion: the new window's content actually LOADED the target URL.
    // Pre-fix the fresh-minted popup WC is never navigated, so its live URL
    // stays '' (blank/black window) and this poll times out. Post-fix it commits
    // the target URL.
    await expect
      .poll(async () =>
        app.evaluateMain!(((_e: unknown, id: number) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.contentUrl(id);
        }) as any, newId),
      )
      .toContain('/target');

    void targetUrl;
  });
});
