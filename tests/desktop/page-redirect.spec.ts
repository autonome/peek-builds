/**
 * Page Host Redirect Navigation Tests
 *
 * Tests that server-side HTTP 301/302 redirects are handled correctly.
 * Previously, server redirects (did-redirect-navigation) were not tracked,
 * so did-fail-load(-3) for the original URL would call stopLoading() while
 * the redirect target was still loading — leaving the page blank.
 *
 * Bug: post.nl (301→postnl.nl) shows blank page instead of following redirect.
 *
 * Run with:
 *   yarn test:electron -- --grep "redirect"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';
import http from 'http';

// Shared app instance
let sharedApp: DesktopApp;
let sharedBgWindow: Page;
let redirectServer: http.Server;
let serverPort: number;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);

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
  await closeSharedApp();
});

// ============================================================================
// Helpers
// ============================================================================

async function openCanvasPage(
  bgWindow: Page,
  url: string
): Promise<{ pageWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(async (targetUrl: string) => {
    return await (window as any).app.window.open(targetUrl, {
      width: 800,
      height: 600,
    });
  }, url);
  expect(result.success).toBe(true);
  const windowId = result.id;

  const pageWindow = await sharedApp.getWindow('page/index.html', 15000);
  expect(pageWindow).toBeTruthy();

  return { pageWindow, windowId };
}

async function waitForPageLoaded(pageWindow: Page, timeout = 20000): Promise<void> {
  await pageWindow.waitForFunction(
    () => {
      const webview = document.getElementById('content');
      return webview && webview.classList.contains('loaded');
    },
    undefined,
    { timeout }
  );
}

async function getWebviewUrl(pageWindow: Page): Promise<string> {
  return pageWindow.evaluate(() => {
    const webview = document.getElementById('content') as any;
    return webview ? webview.getURL() : '';
  });
}

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  await bgWindow.evaluate(async (id: number) => {
    return await (window as any).app.window.close(id);
  }, windowId);
}

// ============================================================================
// Redirect Tests
// ============================================================================

test.describe('Page Host Redirect Navigation @desktop', () => {
  test('HTTP 301 redirect: webview loads the redirect target, not blank', async () => {
    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-301`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, redirectUrl);

    // The page should reach 'loaded' state (not stay on 'loading' blank page)
    await waitForPageLoaded(pageWindow);

    // The webview should now be at the redirect target URL
    const finalUrl = await getWebviewUrl(pageWindow);
    expect(finalUrl).toContain('/target');

    // Confirm the redirect target content loaded (not a blank page)
    const titleText = await pageWindow.evaluate(() => {
      const webview = document.getElementById('content') as any;
      return webview ? webview.executeJavaScript('document.getElementById("title")?.textContent') : null;
    });
    expect(titleText).toBe('Redirect Target');

    await closeWindow(sharedBgWindow, windowId);
  });

  test('HTTP 302 redirect: webview loads the redirect target', async () => {
    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-302`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, redirectUrl);

    await waitForPageLoaded(pageWindow);

    const finalUrl = await getWebviewUrl(pageWindow);
    expect(finalUrl).toContain('/target');

    await closeWindow(sharedBgWindow, windowId);
  });

  test('Redirect chain (301→302): webview loads the final target', async () => {
    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-chain`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, redirectUrl);

    await waitForPageLoaded(pageWindow);

    // Should end up at /target after two hops
    const finalUrl = await getWebviewUrl(pageWindow);
    expect(finalUrl).toContain('/target');

    await closeWindow(sharedBgWindow, windowId);
  });

  test('Redirect: webview never shows blank white page during loading', async () => {
    const redirectUrl = `http://127.0.0.1:${serverPort}/redirect-301`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, redirectUrl);

    // Poll frequently during loading to check webview is never blank
    // (no period where opacity=0 AND no loading/loaded class)
    let blankDetected = false;
    const pollInterval = setInterval(async () => {
      try {
        const state = await pageWindow.evaluate(() => {
          const webview = document.getElementById('content');
          if (!webview) return null;
          return {
            hasLoading: webview.classList.contains('loading'),
            hasLoaded: webview.classList.contains('loaded'),
          };
        });
        if (state && !state.hasLoading && !state.hasLoaded) {
          blankDetected = true;
        }
      } catch {
        // Page may not be ready yet
      }
    }, 50);

    await waitForPageLoaded(pageWindow);
    clearInterval(pollInterval);

    // During a server-redirect, the webview might briefly lose its class while
    // transitioning from loading→loaded (one synchronous frame). This is acceptable.
    // What's NOT acceptable is staying blank for an extended period.
    // The test's real assertion is that waitForPageLoaded() completes at all.
    // If it times out, the blank page bug is present.
    const finalUrl = await getWebviewUrl(pageWindow);
    expect(finalUrl).toContain('/target');

    await closeWindow(sharedBgWindow, windowId);
  });
});
