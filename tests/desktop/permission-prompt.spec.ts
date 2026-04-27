/**
 * Permission prompt — Phase 2 integration test.
 *
 * Drives the full deferred-callback flow:
 *   1. Open a page-host on a test HTTP origin.
 *   2. Inside the guest webview, call navigator.geolocation.getCurrentPosition.
 *   3. Backend permission-handler resolves the policy to 'prompt', stores
 *      the callback, and publishes `page:permission-request` to the host
 *      renderer.
 *   4. The page-host renderer renders `.permission-prompt` near the top.
 *   5. Click "Deny" — page.js publishes `page:permission-response`, backend
 *      resolves the deferred callback with false, geolocation rejects with
 *      PERMISSION_DENIED in the guest.
 *
 * The Allow path is symmetric (asserted via the second test).
 *
 * Run with: yarn test:grep "Permission Prompt"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Permission Prompt @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('permission-prompt'));

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<body>
<h1>perm test</h1>
<script>
  window.__lastGeoResult = null;
  window.__requestGeo = function() {
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        () => { window.__lastGeoResult = 'allowed'; resolve('allowed'); },
        (err) => {
          window.__lastGeoResult = 'denied:' + err.code;
          resolve('denied:' + err.code);
        },
        { timeout: 5000 }
      );
    });
  };
</script>
</body>
</html>`);
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

  async function openPageHost(slug: string): Promise<Page> {
    const url = `http://127.0.0.1:${serverPort}/${slug}`;
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const pageWindow = await app.getWindow(slug, 15000);
    await pageWindow.waitForFunction(() => (window as any).__pageModuleReady === true);
    // Wait for the guest webview's content to be ready (the script tag needs
    // to have executed for window.__requestGeo to exist on the guest).
    await pageWindow.waitForFunction(() => {
      const wv = document.getElementById('content') as any;
      return wv && typeof wv.executeJavaScript === 'function';
    });
    return pageWindow;
  }

  test('geolocation request renders prompt; Deny resolves with PERMISSION_DENIED', async () => {
    const pageWindow = await openPageHost('perm-deny');

    const webview = await pageWindow.evaluateHandle(() => document.getElementById('content'));

    // Kick off the geolocation request from inside the guest. We don't await
    // it — the call blocks until the user responds. The promise resolves
    // after we click Deny below.
    await pageWindow.evaluate((wv: any) => {
      // Stash the result promise on the host window so we can read its
      // resolution after clicking the prompt.
      (window as any).__geoPromise = wv.executeJavaScript('window.__requestGeo()');
    }, webview);

    // Wait for the prompt to appear in the host renderer.
    const prompt = pageWindow.locator('.permission-prompt').first();
    await expect(prompt).toBeVisible({ timeout: 5000 });
    await expect(prompt).toContainText('know your location');
    await expect(prompt.locator('.permission-prompt-origin')).toContainText('127.0.0.1');

    // Click Deny.
    await prompt.locator('.permission-prompt-deny').click();

    // Prompt removes itself.
    await expect(prompt).toHaveCount(0);

    // The guest's geolocation promise resolves with PERMISSION_DENIED (code 1).
    const result = await pageWindow.evaluate(() => (window as any).__geoPromise);
    expect(result).toBe('denied:1');
  });

  test('geolocation request renders prompt; Allow attempts the actual call', async () => {
    const pageWindow = await openPageHost('perm-allow');

    const webview = await pageWindow.evaluateHandle(() => document.getElementById('content'));

    await pageWindow.evaluate((wv: any) => {
      (window as any).__geoPromise = wv.executeJavaScript('window.__requestGeo()');
    }, webview);

    const prompt = pageWindow.locator('.permission-prompt').first();
    await expect(prompt).toBeVisible({ timeout: 5000 });

    await prompt.locator('.permission-prompt-allow').click();

    await expect(prompt).toHaveCount(0);

    // After Allow, Chromium proceeds with the actual geolocation lookup.
    // In headless test mode this typically fails with POSITION_UNAVAILABLE
    // (code 2) or TIMEOUT (code 3) since the OS geolocation service is
    // off — but it MUST NOT be PERMISSION_DENIED (code 1). That's the
    // assertion that proves Allow actually allowed.
    const result = await pageWindow.evaluate(() => (window as any).__geoPromise);
    expect(result).not.toBe('denied:1');
  });
});
