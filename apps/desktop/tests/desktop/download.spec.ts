/**
 * Download Navigation Tests
 *
 * Verifies that downloads in webviews don't leave the page blank or
 * create orphan popup windows.
 *
 * Run with:
 *   yarn test:electron -- --grep "download"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';
import http from 'http';

// Shared app instance
let sharedApp: DesktopApp;
let sharedBgWindow: Page;
let downloadServer: http.Server;
let serverPort: number;

// Track requests to verify downloads happened
let downloadCount = 0;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);

  // Local HTTP server that serves a page with download links
  await new Promise<void>((resolve) => {
    downloadServer = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Download Test Page</title></head>
          <body>
            <h1>Download Test</h1>
            <a id="direct-download" href="/download">Direct Download</a>
            <a id="blank-download" href="/download" target="_blank">Blank Download</a>
          </body>
          </html>
        `);
      } else if (req.url === '/download') {
        downloadCount++;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="test-file.bin"',
          'Content-Length': '12',
        });
        res.end('file content');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    downloadServer.listen(0, '127.0.0.1', () => {
      const addr = downloadServer.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (downloadServer) {
    downloadServer.close();
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

async function waitForPageLoaded(pageWindow: Page, timeout = 30000): Promise<void> {
  await pageWindow.waitForFunction(
    () => {
      const webview = document.getElementById('content');
      return webview && webview.classList.contains('loaded');
    },
    undefined,
    { timeout }
  );
}

async function getWebviewUrl(pageWindow: Page): Promise<string | null> {
  return pageWindow.evaluate(() => {
    const webview = document.getElementById('content') as any;
    return webview ? webview.getURL() : null;
  });
}

// ============================================================================
// Download Tests
// ============================================================================

test.describe('Download Navigation @desktop', () => {
  test('direct download link keeps page on original URL', async () => {
    downloadCount = 0;

    const pageUrl = `http://127.0.0.1:${serverPort}/page`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, pageUrl);
    await waitForPageLoaded(pageWindow);

    const urlBefore = await getWebviewUrl(pageWindow);
    expect(urlBefore).toContain('/page');

    // Click a same-page download link (no target="_blank")
    await pageWindow.evaluate(() => {
      const webview = document.getElementById('content') as any;
      return webview.executeJavaScript(`
        document.getElementById('direct-download').click();
      `);
    });

    // Wait for download to be processed
    await sleep(3000);

    // Webview should still show the original page
    const urlAfter = await getWebviewUrl(pageWindow);
    expect(urlAfter).toContain('/page');
    expect(downloadCount).toBeGreaterThan(0);

    await sharedBgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  });

  test('target=_blank download cleans up the popup window', async () => {
    downloadCount = 0;

    const pageUrl = `http://127.0.0.1:${serverPort}/page`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, pageUrl);
    await waitForPageLoaded(pageWindow);

    const windowCountBefore = sharedApp.windows().length;

    // Click a target="_blank" download link.
    // This opens a new popup window for the download URL.
    // The popup should be cleaned up after the download starts.
    await pageWindow.evaluate(() => {
      const webview = document.getElementById('content') as any;
      return webview.executeJavaScript(`
        document.getElementById('blank-download').click();
      `);
    });

    // Wait for download and window cleanup
    await sleep(5000);

    expect(downloadCount).toBeGreaterThan(0);

    // Original page should still be intact
    const urlAfter = await getWebviewUrl(pageWindow);
    expect(urlAfter).toContain('/page');

    // The popup window should have been cleaned up — no leftover blank windows
    const windowCountAfter = sharedApp.windows().length;
    expect(windowCountAfter).toBeLessThanOrEqual(windowCountBefore);

    await sharedBgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);
  });
});
