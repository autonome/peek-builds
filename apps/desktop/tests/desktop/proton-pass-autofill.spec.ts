/**
 * Regression spec for Proton Pass autofill in the hybrid page-host.
 *
 * Bug (historical): Proton Pass autofill UI never appeared in form fields.
 * THREE distinct compat-layer causes were found and fixed; all are resolved:
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
 *   3. (Electron 43, fixed 2026-07-07, commit d9acbf6d — the real downstream
 *      break) The hidden chrome-extension bridge window (peek-bridge.html) ran
 *      with `sandbox:false`; under Electron 43 a `sandbox:false` chrome-extension
 *      renderer hits the `sandbox_bundle` init crash ("Cannot destructure
 *      property 'preloadScripts' of 'binding.startupData' as it is null"), which
 *      silently aborts the bridge preload → `window.peekBridge` never exposed →
 *      the bridge never relays runtime messages to the BG SW. Every
 *      `LOAD_CONTENT_SCRIPT` / `AUTOFILL_LOGIN_QUERY` forwarded to the bridge
 *      timed out at 30s, so Proton's `client.js` autofill dropdown never injected
 *      (`protonNodes: 0`). Fixed by `sandbox:true` on the bridge window
 *      (chrome-extensions.ts) — its preload only needs electron ipcRenderer +
 *      contextBridge, both available to sandboxed preloads. Verified live: bridge
 *      relay round-trips, and focusing a login field injects `protonpass-root-*`
 *      shadow hosts + `data-protonpass-*` attrs on github.com/login AND the local
 *      form. (This corrects the session-2 "no unlocked vault" theory — the bridge
 *      crash, not vault state, was the dominant blocker.)
 *
 * PORTED off the canvas `<webview>` page host (removed 2026-07, peek e8081cce)
 * to the hybrid `WebContentsView` model — drive the REAL page-host pipeline
 * (`app.window.open`), resolve the content WC via
 * `__peek_test.getHybridContentWcIdForTest`, and probe its DOM through
 * `wc.executeJavaScript` (there is no in-window `#content` webview anymore).
 * Mirrors runtime-external-polyfill.spec.ts.
 *
 * ── DELIBERATELY SKIPPED, INDEFINITELY — this cannot be a CI test (decision 2026-07-07). ──
 * The injection mechanism is fixed (cause 3 above), but this spec's assertion —
 * that `data-protonpass-*` markers appear in the form — only holds when Proton
 * Pass has a real, UNLOCKED vault. `createPerDescribeApp` gives every run a FRESH
 * temp profile with no logged-in vault, and a password manager with no
 * credentials has nothing to autofill. The ONLY way to satisfy the assert is a
 * live/seeded unlocked vault — i.e. real Proton credentials — which are NOT
 * committable to a CI-safe fixture. So this is NOT a "waiting for someone to
 * build a seeded-vault fixture" TODO; seeding a vault means committing live
 * secrets, which we will not do. It is kept skipped ON PURPOSE, as a permanent
 * manual / dev-profile-only check.
 *
 * Why keeping it skipped loses no AUTOMATED coverage: the compat-layer fixes
 * behind causes 1–3 each have their own credential-free coverage — the
 * `chrome.runtime.sendMessage` cross-origin polyfill in
 * runtime-external-polyfill.spec.ts, and the bridge window's now-MANDATORY
 * sandboxing (cause 3) enforced by main/sandbox-enforcement.test.ts (runtime
 * guard + static source-scan). What is UNIQUE to this spec — and un-automatable
 * CI-side — is the aggregate, live-vault, end-to-end autofill DOM assertion.
 * That was verified BY HAND on the dev profile (live-logged-in vault) when cause
 * 3 was fixed (commit d9acbf6d). The separate live-creds-only OAuth gap lives in
 * tests/manual/proton-auth.harness.ts.
 *
 * TO RUN IT MANUALLY (never in CI): point it at a profile with a real, unlocked
 * Proton Pass vault (dev profile with a live login, or a locally-seeded vault),
 * flip `describe.skip` → `describe`, and confirm the `data-protonpass-*` markers
 * appear.
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
