/**
 * Smoke test for the chrome.runtime.sendMessage cross-origin polyfill
 * (hybrid page-host).
 *
 * Covers the NEGATIVE case of the runtime-external preload URL matcher: after
 * loading the Proton Pass extension, navigating a page-host to a URL that does
 * NOT match its externally_connectable.matches (https://account.proton.me/*)
 * must NOT install our `peek-rt` sendMessage polyfill in the page's MAIN world.
 * This confirms the URL-matcher in entry.ts / getRuntimeExternalWebPrefsForUrl
 * does not false-positive on an unrelated origin.
 *
 * Migrated off the canvas `<webview>` page host. On the hybrid page-host
 * the page content is an OPAQUE WebContentsView whose runtime-external preload
 * is selected at CONSTRUCTION via `getRuntimeExternalWebPrefsForUrl(url,
 * 'hybrid')` — there is no in-window `#content` webview to read. We still drive
 * the REAL page-host pipeline (`app.window.open`, which under the flag takes the
 * hybrid early branch and applies the real preload selection), then read the
 * content WC's MAIN world directly via the `__peek_test` content-wc accessor.
 * The describe block skips itself when the hybrid bridge is absent (flag off).
 *
 * What this does NOT cover (deferred to manual verification / follow-up):
 *   - The full Proton OAuth fork flow ending in /auth-ext delivering tokens
 *     to the BG SW. That requires authenticated Proton credentials and a
 *     real network round-trip.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { hybridBridgePresent } from '../helpers/hybrid-page';
import http from 'http';

test.describe('runtime-external polyfill @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let port: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('runtime-external-polyfill'));
    await waitForExtensionsReady(bgWindow, 15000);

    // We can't reach real account.proton.me in a test, so we don't try.
    // Instead the test loads a local server that returns minimal HTML
    // matching the same patterns we'd inspect on a Proton page.
    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Test</title></head><body><h1 id="t">probe</h1></body></html>`);
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

  test('preload + page polyfill are NOT injected when URL does not match externally_connectable', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    // Deliberately a NON-matching URL (127.0.0.1) to confirm the negative case:
    // no runtime-external preload should be selected, so chrome.runtime should
    // NOT carry our `peek-rt` sendMessage polyfill.
    const url = `http://127.0.0.1:${port}/`;
    const openResult = await bgWindow.evaluate(async (targetUrl: string) => {
      return await (window as any).app.window.open(targetUrl, { width: 800, height: 600 });
    }, url);
    expect(openResult.success).toBe(true);
    const windowId = openResult.id as number;

    // Wait for the hybrid content WC to surface as a Playwright page + load.
    const pageWindow = await app.getWindow('127.0.0.1', 15000);
    expect(pageWindow).toBeTruthy();
    await pageWindow.waitForLoadState('domcontentloaded');

    // Confirm this is the hybrid path (it must be, since the bridge is present),
    // and resolve the content WC id for a direct MAIN-world read.
    const contentWcId = await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.getHybridContentWcIdForTest(id)) as any,
      windowId,
    ) as number | null;
    expect(contentWcId, 'a live hybrid must expose its content wc id').not.toBeNull();

    // Sanity probe in the content WC's MAIN world: chrome.runtime.sendMessage
    // from a non-matching origin must NOT be our polyfilled function. Either
    // undefined or the Electron native stub — we just make sure our `peek-rt`
    // marker isn't present (proves the URL matcher didn't false-positive).
    const probe = await app.evaluateMain!(
      (async ({ webContents }, wcId: number) => {
        const wc = webContents.fromId(wcId);
        if (!wc || wc.isDestroyed()) return null;
        return wc.executeJavaScript(`(function(){
          return {
            hasChrome: typeof chrome !== 'undefined',
            hasRuntime: !!(typeof chrome !== 'undefined' && chrome.runtime),
            hasSendMessage: !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage),
            isPeekPolyfilled: !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage &&
              chrome.runtime.sendMessage.toString().includes('peek-rt')),
          };
        })()`);
      }) as any,
      contentWcId as number,
    ) as { hasChrome: boolean; hasRuntime: boolean; hasSendMessage: boolean; isPeekPolyfilled: boolean } | null;
    console.log('[runtime-external-polyfill] non-matching origin probe:', probe);

    expect(probe).not.toBeNull();
    // We don't assert hasChrome/hasRuntime — Electron's behavior on
    // non-extension origins is version-dependent. We DO assert that our
    // polyfill (signature contains 'peek-rt') is NOT installed.
    expect(probe!.isPeekPolyfilled).toBe(false);
  });
});
