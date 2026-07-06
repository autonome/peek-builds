/**
 * Regression spec for Proton Pass autofill in the hybrid page-host.
 *
 * Bug (historical): Proton Pass autofill UI never appeared in form fields.
 * Root cause was Electron's native `browser` polyfill in service-worker
 * contexts omitting `permissions`, aborting Proton's BG SW before it
 * registered its onMessage handler. Fixed by scripts/patch-chrome-extensions.js
 * installing `globalThis.browser.permissions` on the SW.
 *
 * PORTED off the canvas `<webview>` page host (removed 2026-07, peek e8081cce)
 * to the hybrid `WebContentsView` model — drive the REAL page-host pipeline
 * (`app.window.open`), resolve the content WC via
 * `__peek_test.getHybridContentWcIdForTest`, and probe its DOM through
 * `wc.executeJavaScript` (there is no in-window `#content` webview anymore).
 * Mirrors runtime-external-polyfill.spec.ts.
 *
 * ── STILL SKIPPED — and the original "CI-safe, no live creds" premise was
 *    wrong (verified 2026-07-06). ────────────────────────────────────────────
 * Investigating the port revealed that content-script injection is NOT the
 * problem on the hybrid page-host: instrumenting the content WC's console
 * showed Proton's ISOLATED-world content scripts DO run there —
 *   [peek:cs-compat] ISOLATED-world sendMessage shim installed, extId=…
 *   [peek:cs-compat] sendMessage … type=UNLOAD_CONTENT_SCRIPT
 * i.e. Electron 43 natively injects ISOLATED content_scripts into the
 * `WebContentsView`, and peek's relay forwards their messages. So there is NO
 * autofill content-script-injection regression on the hybrid page-host.
 *
 * What's missing is the downstream autofill UI: the content script runs, then
 * sends `UNLOAD_CONTENT_SCRIPT` and injects no dropdown. The overwhelmingly
 * likely cause is that `createPerDescribeApp` uses a FRESH temp profile in
 * which Proton Pass has NO logged-in / unlocked vault — a password manager with
 * no account offers nothing to autofill and unloads, so no `data-protonpass-*`
 * markers ever appear. That makes the DOM-marker assertion depend on a seeded /
 * live Proton Pass login; it is NOT CI-safe as originally assumed.
 *
 * TO UN-SKIP: run against a profile with a real, unlocked Proton Pass vault
 * (a live-login session, or a seeded-vault fixture) and confirm the markers
 * appear. Until then this stays skipped. The genuinely live-creds-only OAuth
 * gap is separate and lives in tests/manual/proton-auth.harness.ts.
 *
 * Peek follow-up: 976a7700.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { hybridBridgePresent } from '../helpers/hybrid-page';
import http from 'http';

test.describe.skip('Proton Pass autofill in page-host @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let port: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('proton-pass-autofill'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/login') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html>
<html><head><title>Login</title></head>
<body>
<h1 id="title">Login</h1>
<form id="loginForm" action="/submit" method="post">
  <input id="username" name="username" type="text" autocomplete="username" />
  <input id="password" name="password" type="password" autocomplete="current-password" />
  <button id="submit" type="submit">Sign in</button>
</form>
</body></html>`);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (app) await app.close();
  });

  test('Proton Pass injects autofill UI into form fields', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no page-host bridge in this configuration');

    const url = `http://127.0.0.1:${port}/login`;

    const openResult = await bgWindow.evaluate(async (targetUrl: string) => {
      return await (window as any).app.window.open(targetUrl, { width: 800, height: 600 });
    }, url);
    expect(openResult.success).toBe(true);
    const windowId = openResult.id as number;

    // Wait for the hybrid content WC to surface as a Playwright page + load.
    const pageWindow = await app.getWindow('127.0.0.1', 15000);
    expect(pageWindow).toBeTruthy();
    await pageWindow.waitForLoadState('domcontentloaded');

    // Resolve the opaque content WC id for a direct DOM probe (there is no
    // in-window `#content` webview on the hybrid page-host).
    const contentWcId = (await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.getHybridContentWcIdForTest(id)) as any,
      windowId,
    )) as number | null;
    expect(contentWcId, 'a live hybrid must expose its content wc id').not.toBeNull();

    // Poll up to 10s for Proton's autofill chain to inject DOM markers into the
    // content WC's document (popup-content-script → SW → executeScript client.js).
    // NOTE: this only succeeds when Proton Pass has an unlocked vault — see the
    // file header for why this describe stays skipped until run with a live login.
    let result = { protonNodeCount: 0, protonIframeCount: 0 };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      result = (await app.evaluateMain!(
        (async ({ webContents }, wcId: number) => {
          const wc = webContents.fromId(wcId);
          if (!wc || wc.isDestroyed()) return { protonNodeCount: 0, protonIframeCount: 0 };
          const protonNodeCount = await wc.executeJavaScript(
            `document.querySelectorAll('[class*="proton"],[id*="proton"],[data-protonpass-role],[data-protonpass-base-css]').length`,
          );
          const protonIframeCount = await wc.executeJavaScript(
            `document.querySelectorAll('iframe[src*="chrome-extension://"]').length`,
          );
          return { protonNodeCount, protonIframeCount };
        }) as any,
        contentWcId as number,
      )) as { protonNodeCount: number; protonIframeCount: number };
      if (result.protonNodeCount + result.protonIframeCount > 0) break;
      await pageWindow.waitForTimeout(250);
    }

    console.log('[autofill] final injection counts:', JSON.stringify(result));
    expect(result.protonNodeCount + result.protonIframeCount).toBeGreaterThan(0);
  });
});
