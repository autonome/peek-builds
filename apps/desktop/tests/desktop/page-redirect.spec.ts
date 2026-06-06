/**
 * Page Host Redirect Navigation Tests (hybrid page-host).
 *
 * Tests that server-side HTTP 301/302 redirects are handled correctly: the
 * content webContents follows the redirect and ends up at the final target URL
 * (not a blank page). The original bug was that did-redirect-navigation was not
 * tracked, so did-fail-load(-3) for the original URL called stopLoading() while
 * the redirect target was still loading — leaving the page blank.
 *
 * Bug: post.nl (301→postnl.nl) shows blank page instead of following redirect.
 *
 * Migrated off the canvas `<webview>` page host. Under PEEK_PAGEHOST_HYBRID=1
 * the page content lives in an OPAQUE content `BaseWindow` (no in-window
 * `#content` webview, no `.loading`/`.loaded` CSS classes). The redirect intent
 * is a CONTENT-WC behavior, so these assertions drive the hybrid content WC via
 * the shared `openHybridPage` helper: `loadFakeContent` runs `contentWC.loadURL`
 * to completion (following redirects), and `contentUrl` reports the live final
 * URL. The describe block skips itself when the hybrid bridge is absent.
 *
 * Run with:
 *   PEEK_PAGEHOST_HYBRID=1 BACKEND=electron yarn test:electron -- --grep "redirect"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  hybridBridgePresent,
  openHybridPage,
  contentUrl,
  closeHybridPage,
  HybridPageHandle,
} from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let redirectServer: http.Server;
let serverPort: number;

test.beforeAll(async () => {
  ({ app } = await createPerDescribeApp('page-redirect'));

  // Local HTTP server that serves redirect responses
  await new Promise<void>((resolve) => {
    redirectServer = http.createServer((req, res) => {
      if (req.url === '/redirect-301') {
        // 301 Permanent Redirect to /target
        res.writeHead(301, { Location: `http://127.0.0.1:${serverPort}/target` });
        res.end();
      } else if (req.url === '/redirect-302') {
        // 302 Temporary Redirect to /target
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/target` });
        res.end();
      } else if (req.url === '/redirect-chain') {
        // Two-hop redirect: /redirect-chain → /hop1 → /target
        res.writeHead(301, { Location: `http://127.0.0.1:${serverPort}/hop1` });
        res.end();
      } else if (req.url === '/hop1') {
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/target` });
        res.end();
      } else if (req.url === '/target') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Redirect Target</title></head><body><h1 id="title">Redirect Target</h1></body></html>');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    redirectServer.listen(0, '127.0.0.1', () => {
      const addr = redirectServer.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (redirectServer) {
    redirectServer.close();
  }
  if (app) await app.close();
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read the text content of an element in the hybrid content WC. Used to confirm
 * the redirect target's body actually rendered (not a blank page). This is a
 * test-local read of the content WC by id (from the handle); it does not poke
 * any in-window chrome DOM.
 */
async function contentElementText(
  a: DesktopApp,
  h: HybridPageHandle,
  selector: string,
): Promise<string | null> {
  if (h.contentWcId == null) return null;
  return a.evaluateMain!(async ({ webContents }, arg) => {
    const wc = webContents.fromId(arg.wcId);
    if (!wc || wc.isDestroyed()) return null;
    return wc.executeJavaScript(
      `document.querySelector(${JSON.stringify(arg.selector)})?.textContent ?? null`,
    );
  }, { wcId: h.contentWcId, selector } as { wcId: number; selector: string });
}

// ============================================================================
// Redirect Tests
// ============================================================================

test.describe('Page Host Redirect Navigation @desktop', () => {
  test('HTTP 301 redirect: content loads the redirect target, not blank', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-301`;
    // openHybridPage runs contentWC.loadURL to completion, following redirects.
    const h = await openHybridPage(app, redirectUrl);

    // The content WC should now be at the redirect target URL (not stalled blank).
    expect(await contentUrl(app, h)).toContain('/target');

    // Confirm the redirect target content actually rendered (not a blank page).
    expect(await contentElementText(app, h, '#title')).toBe('Redirect Target');

    await closeHybridPage(app, h);
  });

  test('HTTP 302 redirect: content loads the redirect target', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-302`;
    const h = await openHybridPage(app, redirectUrl);

    expect(await contentUrl(app, h)).toContain('/target');

    await closeHybridPage(app, h);
  });

  test('Redirect chain (301→302): content loads the final target', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-chain`;
    const h = await openHybridPage(app, redirectUrl);

    // Should end up at /target after two hops.
    expect(await contentUrl(app, h)).toContain('/target');

    await closeHybridPage(app, h);
  });

  test('Redirect: content reaches the target without stalling blank', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    // The canvas version polled webview CSS classes to detect a blank
    // (opacity-0, no loading/loaded class) frame. In the hybrid model the
    // content paints opaque from its own BaseWindow — there is no canvas
    // opacity/class to go blank. The load-stall regression manifests as the
    // load NEVER completing at the target. openHybridPage awaits the loadURL
    // promise, so its resolution + the final URL is the real assertion: if the
    // did-fail-load stopLoading() bug were present, the URL would not reach
    // /target.
    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-301`;
    const h = await openHybridPage(app, redirectUrl);

    expect(await contentUrl(app, h)).toContain('/target');
    expect(await contentElementText(app, h, '#title')).toBe('Redirect Target');

    await closeHybridPage(app, h);
  });
});
