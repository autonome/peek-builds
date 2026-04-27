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
  window.__requestMedia = function() {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(() => 'allowed')
      .catch(err => 'denied:' + (err && err.name ? err.name : 'unknown'));
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

  test('Remember-this-decision: clicking Deny + checkbox persists, second request skips prompt', async () => {
    // First page-host: deny + remember.
    const first = await openPageHost('perm-remember-1');
    const webview1 = await first.evaluateHandle(() => document.getElementById('content'));
    await first.evaluate((wv: any) => {
      (window as any).__geoPromise = wv.executeJavaScript('window.__requestGeo()');
    }, webview1);

    const prompt1 = first.locator('.permission-prompt').first();
    await expect(prompt1).toBeVisible({ timeout: 5000 });

    // Tick the remember checkbox, then deny.
    await prompt1.locator('.permission-prompt-remember input[type="checkbox"]').check();
    await prompt1.locator('.permission-prompt-deny').click();
    await expect(prompt1).toHaveCount(0);

    const r1 = await first.evaluate(() => (window as any).__geoPromise);
    expect(r1).toBe('denied:1');

    // Second page-host on the SAME origin (note: same hostname:port via
    // different path, so origin matches). The stored decision should be
    // applied without rendering a prompt.
    const second = await openPageHost('perm-remember-2');
    const webview2 = await second.evaluateHandle(() => document.getElementById('content'));
    await second.evaluate((wv: any) => {
      (window as any).__geoPromise = wv.executeJavaScript('window.__requestGeo()');
    }, webview2);

    // The geolocation promise should resolve quickly with PERMISSION_DENIED
    // (code 1) — the stored decision short-circuits the prompt.
    const r2 = await second.evaluate(() => (window as any).__geoPromise);
    expect(r2).toBe('denied:1');

    // No prompt should have appeared in the second window.
    const promptCount = await second.locator('.permission-prompt').count();
    expect(promptCount).toBe(0);
  });

  test('Phase 5 — queueing: synthetic concurrent requests show one prompt + pending badge; resolving advances queue', async () => {
    // Earlier "Remember-this-decision" test persisted a deny for
    // 127.0.0.1 geolocation. Clear it so this test gets a fresh prompt.
    await bgWindow.evaluate(async () => {
      await (window as any).app.permissions.forgetAll();
    });

    const pageWindow = await openPageHost('perm-queue');
    const myWindowId = await pageWindow.evaluate(async () => {
      const r = await (window as any).app.window.getWindowId();
      return (r && typeof r === 'object' && 'id' in r) ? r.id : r;
    });

    // Drive the renderer queue directly via two synthetic
    // `page:permission-request` publishes. The queueing UX lives entirely
    // in page.js — independent of which Chromium permission triggered it
    // — so this test isolates the renderer logic from the (flaky in
    // headless) media-device path.
    await bgWindow.evaluate(async (windowId) => {
      const api = (window as any).app;
      api.pubsub.publish('page:permission-request', {
        requestId: 'q1', windowId,
        permission: 'geolocation', origin: 'https://example.com',
        label: 'know your location',
      });
      api.pubsub.publish('page:permission-request', {
        requestId: 'q2', windowId,
        permission: 'media', origin: 'https://meet.example.com',
        label: 'use your camera and microphone',
      });
    }, myWindowId);

    // Only ONE prompt visible (queue head); badge shows "+1 more pending".
    await pageWindow.waitForFunction(() => {
      const prompts = document.querySelectorAll('.permission-prompt');
      const badge = document.querySelector('.permission-prompt-pending-badge') as HTMLElement | null;
      return prompts.length === 1
        && badge
        && badge.style.display !== 'none'
        && /\+1 more pending/.test(badge.textContent || '');
    }, undefined, { timeout: 5000 });

    // The visible prompt is for the FIRST request (geolocation).
    const firstText = await pageWindow.locator('.permission-prompt').innerText();
    expect(firstText).toContain('know your location');
    expect(firstText).toContain('https://example.com');

    // Click Deny on the first prompt — second prompt should take its place.
    await pageWindow.locator('.permission-prompt .permission-prompt-deny').click();

    await pageWindow.waitForFunction(() => {
      const p = document.querySelector('.permission-prompt');
      return p && /camera and microphone/i.test(p.textContent || '');
    }, undefined, { timeout: 5000 });

    // Still only ONE prompt; badge gone.
    const after = await pageWindow.evaluate(() => {
      const prompts = document.querySelectorAll('.permission-prompt');
      const badge = document.querySelector('.permission-prompt-pending-badge') as HTMLElement | null;
      return {
        promptCount: prompts.length,
        badgeVisible: !!(badge && badge.style.display !== 'none'),
      };
    });
    expect(after.promptCount).toBe(1);
    expect(after.badgeVisible).toBe(false);

    // Resolve the second one — queue empty, no prompts left.
    await pageWindow.locator('.permission-prompt .permission-prompt-deny').click();
    await pageWindow.waitForFunction(
      () => document.querySelectorAll('.permission-prompt').length === 0,
      undefined,
      { timeout: 5000 },
    );
  });

  test('Phase 5 — favicon img renders with origin-derived src in the prompt', async () => {
    // Same reason as above — clear any stored decisions so the prompt fires.
    await bgWindow.evaluate(async () => {
      await (window as any).app.permissions.forgetAll();
    });

    const pageWindow = await openPageHost('perm-favicon');
    const webview = await pageWindow.evaluateHandle(() => document.getElementById('content'));
    await pageWindow.evaluate((wv: any) => {
      (window as any).__geoPromise = wv.executeJavaScript('window.__requestGeo()');
    }, webview);

    await pageWindow.waitForSelector('.permission-prompt-favicon', { timeout: 5000 });

    const faviconSrc = await pageWindow.locator('.permission-prompt-favicon').getAttribute('src');
    expect(faviconSrc).toBeTruthy();
    // Either Google s2 favicons URL with the host, or the globe-emoji SVG fallback.
    // 127.0.0.1 routes through the Google service path.
    expect(faviconSrc).toMatch(/google\.com\/s2\/favicons\?domain=127\.0\.0\.1/);

    // Cleanup — deny so the deferred Chromium callback resolves.
    await pageWindow.locator('.permission-prompt .permission-prompt-deny').click();
    await pageWindow.waitForFunction(
      () => document.querySelectorAll('.permission-prompt').length === 0,
      undefined,
      { timeout: 5000 },
    );
  });
});
