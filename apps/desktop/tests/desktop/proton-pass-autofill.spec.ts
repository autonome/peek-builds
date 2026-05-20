/**
 * Regression spec for Proton Pass autofill in webview guests.
 *
 * Bug: Proton Pass autofill UI never appeared in form fields. Root cause:
 * Electron's native `browser` polyfill in service-worker contexts omits
 * `permissions` (only exposes APIs Electron implements natively). Proton's
 * BG SW calls `browser.permissions.onAdded.addListener` at sync init,
 * throws TypeError, and aborts BG before any chrome.runtime.onMessage
 * handler is registered — so the popup-content-script
 * → SW → chrome.scripting.executeScript('client.js') chain that injects the
 * autofill UI never starts.
 *
 * Fix: scripts/patch-chrome-extensions.js's PERMISSIONS_SHIM now also
 * installs `globalThis.browser.permissions = _shimPerms` (locked
 * non-writable) when patching background.js, so Proton's
 * webextension-polyfill consumer finds permissions on browser.
 *
 * This spec asserts that after navigating a webview to a login form,
 * Proton's content scripts inject DOM nodes (data-protonpass-* markers
 * or the dropdown iframe).
 */

import { test, expect } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

test.describe.skip('Proton Pass autofill in webview @desktop', () => {
  let app: any;
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
    const url = `http://127.0.0.1:${port}/login`;

    const openResult = await bgWindow.evaluate(async (targetUrl: string) => {
      return await (window as any).app.window.open(targetUrl, { width: 800, height: 600 });
    }, url);
    expect(openResult.success).toBe(true);

    const pageWindow = await app.getWindow('page/index.html', 15000);
    expect(pageWindow).toBeTruthy();

    await pageWindow.waitForFunction(
      () => {
        const wv = document.getElementById('content');
        return wv && wv.classList.contains('loaded');
      },
      undefined,
      { timeout: 20000 },
    );

    // Poll up to 10s for Proton's autofill chain to inject DOM markers.
    // Manual loop avoids waitForFunction's quirky handling of async predicates
    // that depend on webview.executeJavaScript().
    let result = { protonNodeCount: 0, protonIframeCount: 0 };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      result = await pageWindow.evaluate(async () => {
        const wv = document.getElementById('content') as any;
        const protonNodeCount = await wv.executeJavaScript(`
          document.querySelectorAll('[class*="proton"],[id*="proton"],[data-protonpass-role],[data-protonpass-base-css]').length
        `);
        const protonIframeCount = await wv.executeJavaScript(`
          document.querySelectorAll('iframe[src*="chrome-extension://"]').length
        `);
        return { protonNodeCount, protonIframeCount };
      });
      if (result.protonNodeCount + result.protonIframeCount > 0) break;
      await pageWindow.waitForTimeout(250);
    }

    console.log('[autofill] final injection counts:', JSON.stringify(result));
    expect(result.protonNodeCount + result.protonIframeCount).toBeGreaterThan(0);
  });
});
