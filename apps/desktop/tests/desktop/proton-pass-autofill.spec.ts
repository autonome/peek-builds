/**
 * Regression spec for Proton Pass autofill in the hybrid page-host.
 *
 * Bug (historical): Proton Pass autofill UI never appeared in form fields.
 * Two distinct compat-layer causes have been found and fixed in the BG SW:
 *   1. Electron's native `browser` polyfill in service-worker contexts omitted
 *      `permissions`, aborting Proton's BG SW before it registered its onMessage
 *      handler. Fixed by scripts/patch-chrome-extensions.js installing
 *      `globalThis.browser.permissions` on the SW.
 *   2. (Electron 43, fixed 2026-07-07, commit 3ee805a5) Electron 43 does not
 *      register the `webRequest` module resource in a BLESSED_EXTENSION SW
 *      context, so `chrome.webRequest` is `undefined`. Proton's background.js
 *      declares the `webRequest` permission and calls
 *      `chrome.webRequest.{onAuthRequired,…}.addListener()` at sync init → first
 *      `.addListener` on undefined throws → "Service worker registration failed.
 *      Status code: 15" → the SW never runs → the popup is a hollow theme-only
 *      shell (no buttons/inputs), no vault, no autofill. Fixed by the
 *      `WEBREQUEST_SHIM` in patch-chrome-extensions.js (noop `chrome.webRequest`
 *      + `browser.webRequest`; Electron delivers no webRequest events anyway).
 *      Verified live: clean boot logs "SW running for Proton Pass", popup
 *      renders the real unlocked vault.
 *
 * PORTED off the canvas `<webview>` page host (removed 2026-07, peek e8081cce)
 * to the hybrid `WebContentsView` model — drive the REAL page-host pipeline
 * (`app.window.open`), resolve the content WC via
 * `__peek_test.getHybridContentWcIdForTest`, and probe its DOM through
 * `wc.executeJavaScript` (there is no in-window `#content` webview anymore).
 * Mirrors runtime-external-polyfill.spec.ts.
 *
 * ── STILL SKIPPED — downstream autofill-injection break, NOT vault state. ─────
 * The session-2 "fresh temp profile has no unlocked vault → nothing to autofill"
 * theory was REFUTED (2026-07-07): with the SW alive (vault unlocked, popup
 * renders items), Proton Pass autofill STILL does not decorate form fields on
 * the hybrid page-host. Probed both the spec's local form and real
 * https://github.com/login → `protonNodes: 0`, no `iframe[src*=chrome-extension]`,
 * no `data-protonpass-*` attrs, before AND after focusing the field. NOT a
 * localhost/http exclusion (real https failed identically). The ISOLATED-world
 * content script DOES run (confirmed session 2 —
 *   [peek:cs-compat] ISOLATED-world sendMessage shim installed, extId=…
 * i.e. Electron 43 natively injects ISOLATED content_scripts and peek's relay
 * forwards their messages) — but the autofill decoration / dropdown iframe never
 * reaches the page DOM. So there is NO content-script-injection regression; the
 * break is downstream: content-script field detection → message to SW → SW
 * `chrome.scripting.executeScript('client.js')` → dropdown-iframe injection.
 *
 * TO UN-SKIP: fix that downstream chain (peek 976a7700) and confirm the
 * `data-protonpass-*` markers appear. The genuinely live-creds-only OAuth gap is
 * separate and lives in tests/manual/proton-auth.harness.ts.
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
