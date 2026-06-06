/**
 * Page Host Load Failure Tests
 *
 * Regression: navigating to a URL that fails to load (DNS failure, server
 * not found, connection refused) used to leave a blank white page forever
 * with no UI feedback. The fix is a Peek-branded error overlay rendered
 * inside the page host when did-fail-load fires for the main frame.
 *
 * Run with:
 *   yarn test:grep "Page Host Load Failure"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { hybridFlagOn } from '../helpers/hybrid-page';
import http from 'http';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;
let server: http.Server;
let serverPort: number;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);

  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1 id="title">OK</h1></body></html>');
      } else if (req.url === '/hang') {
        // Accept the connection but never respond — drives the page-host's
        // loading-timeout safety net. Repro for the user-reported bug
        // ("metikmusic.com — endless glow border, blank white page").
        // No-op handler keeps the socket open until the test closes.
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
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
  await closeSharedApp();
});

async function openCanvasPage(
  bgWindow: Page,
  url: string,
): Promise<{ pageWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(async (targetUrl: string) => {
    return await (window as any).app.window.open(targetUrl, {
      width: 800,
      height: 600,
    });
  }, url);
  expect(result.success).toBe(true);
  const pageWindow = await sharedApp.getWindow('page/index.html', 15000);
  expect(pageWindow).toBeTruthy();
  return { pageWindow, windowId: result.id };
}

async function closeWindow(bgWindow: Page, windowId: number) {
  await bgWindow.evaluate(async (id: number) => {
    return await (window as any).app.window.close(id);
  }, windowId);
}

async function waitForErrorOverlay(pageWindow: Page, timeout = 15000) {
  await pageWindow.waitForFunction(
    () => !!document.querySelector('.load-error-overlay'),
    undefined,
    { timeout },
  );
}

test.describe('Page Host Load Failure @desktop', () => {
  test('DNS failure: shows branded error overlay with URL and retry button', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: branded load-error-overlay chrome not in overlay yet');
    // .invalid is reserved by RFC 2606 — guaranteed to never resolve.
    const badUrl = 'http://nonexistent-host-xyz123.invalid/';
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, badUrl);

    try {
      await waitForErrorOverlay(pageWindow);

      const overlay = await pageWindow.evaluate(() => {
        const el = document.querySelector('.load-error-overlay');
        if (!el) return null;
        return {
          urlText: el.querySelector('.load-error-url')?.textContent || '',
          reasonText: el.querySelector('.load-error-reason')?.textContent || '',
          hasRetry: !!el.querySelector('.load-error-retry'),
          hasClose: !!el.querySelector('.load-error-close'),
        };
      });

      expect(overlay).toBeTruthy();
      expect(overlay!.urlText).toContain('nonexistent-host-xyz123.invalid');
      // Some Chromium build of the error mentions DNS / NAME_NOT_RESOLVED
      expect(overlay!.reasonText.toLowerCase()).toMatch(/name|resolve|dns|not.found|failed/);
      expect(overlay!.hasRetry).toBe(true);
      expect(overlay!.hasClose).toBe(true);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('Connection refused: shows branded error overlay', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: branded load-error-overlay chrome not in overlay yet');
    // Port 1 is reserved and nothing listens — connection refused.
    const badUrl = 'http://127.0.0.1:1/';
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, badUrl);

    try {
      await waitForErrorOverlay(pageWindow);

      const urlText = await pageWindow.evaluate(() => {
        return document.querySelector('.load-error-url')?.textContent || '';
      });
      expect(urlText).toContain('127.0.0.1:1');
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('Successful load after error: clicking Retry on a now-reachable URL clears the overlay', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: branded load-error-overlay chrome not in overlay yet');
    // Start by hitting a port we can later make reachable: instead of stopping a server,
    // we navigate first to a bad URL, then call the address bar with a good one.
    const badUrl = 'http://nonexistent-host-xyz456.invalid/';
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, badUrl);

    try {
      await waitForErrorOverlay(pageWindow);

      // Programmatic navigation to a working URL — the overlay should clear
      // once load succeeds.
      await pageWindow.evaluate((url: string) => {
        const webview = document.getElementById('content') as any;
        webview.loadURL(url);
      }, goodUrl);

      await pageWindow.waitForFunction(
        () => !document.querySelector('.load-error-overlay'),
        undefined,
        { timeout: 15000 },
      );
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('Successful initial load: no error overlay appears', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: branded load-error-overlay chrome not in overlay yet');
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, goodUrl);

    try {
      await pageWindow.waitForFunction(
        () => {
          const webview = document.getElementById('content');
          return webview && webview.classList.contains('loaded');
        },
        undefined,
        { timeout: 15000 },
      );

      const hasOverlay = await pageWindow.evaluate(
        () => !!document.querySelector('.load-error-overlay'),
      );
      expect(hasOverlay).toBe(false);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });

  test('Re-opening a previously-failed URL still shows the overlay (session-restore parity)', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: branded load-error-overlay chrome not in overlay yet');
    // User-reported regression: closing the app while a tab is on a failed
    // URL, then restarting, leaves the restored tab stuck on a blank page
    // with the loading glow permanently on. Session restore re-opens the
    // page-host pointing at the same URL — same code path as the user
    // hitting the URL again. This test simulates that by opening a new
    // page-host on a known-failed URL after closing the previous one.
    const badUrl = 'http://nonexistent-host-restoresim.invalid/';

    // First open — confirm the overlay shows.
    const first = await openCanvasPage(sharedBgWindow, badUrl);
    await waitForErrorOverlay(first.pageWindow);

    // Arm a `window:removed` subscription BEFORE closing — this event is
    // published in main.ts AFTER `windowRegistry.delete`, so it's the
    // authoritative signal that the window is fully gone (and openWindow's
    // dedup-by-URL can no longer match the previous instance).
    await sharedBgWindow.evaluate((id: number) => {
      (window as any).__windowRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === id) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
    }, first.windowId);

    await closeWindow(sharedBgWindow, first.windowId);

    // Resolves when window:removed for first.windowId fires — no polling.
    await sharedBgWindow.evaluate(() => (window as any).__windowRemoved);

    // Second open — same URL, fresh page-host. The overlay must show again
    // and the loading glow must NOT be stuck on.
    const second = await openCanvasPage(sharedBgWindow, badUrl);
    try {
      await waitForErrorOverlay(second.pageWindow, 20000);
      // After the overlay shows, the webview must not be in 'loading' state.
      const stuckOnLoading = await second.pageWindow.evaluate(() => {
        const webview = document.getElementById('content');
        return !!(webview && webview.classList.contains('loading'));
      });
      expect(stuckOnLoading).toBe(false);
    } finally {
      await closeWindow(sharedBgWindow, second.windowId);
    }
  });

  test('Hung load: loading-timeout safety net surfaces the error overlay (regression: blank-white-page-forever)', async () => {
    test.skip(await hybridFlagOn(sharedApp), 'deferred to Stage B: branded load-error-overlay chrome not in overlay yet');
    // User-reported: http://www.metikmusic.com/ — DNS resolves, server
    // accepts the connection, but never responds. Before this fix, the
    // page-host's 30s loading timeout silently flipped the spinner off
    // and left the user staring at a blank white page with no feedback.
    // Now the timeout surfaces the same overlay as did-fail-load.
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;
    const hangUrl = `http://127.0.0.1:${serverPort}/hang`;
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, goodUrl);

    try {
      // Wait for the initial load to complete so we don't race the
      // loading-timeout override with the first navigation's setTimeout.
      await pageWindow.waitForFunction(
        () => {
          const webview = document.getElementById('content');
          return webview && webview.classList.contains('loaded');
        },
        undefined,
        { timeout: 15000 },
      );

      // Override the loading timeout to 1.5s so the hung-load path fires
      // before the test wall-clock budget. Production stays at 30s.
      await pageWindow.evaluate(() => {
        (window as any).__loadingTimeoutMs = 1500;
      });

      // Navigate the webview to the hung endpoint. Server accepts the
      // connection but never sends a response → loading state stays
      // 'loading' until the safety-net timeout fires.
      await pageWindow.evaluate((u: string) => {
        const webview = document.getElementById('content') as any;
        webview.loadURL(u);
      }, hangUrl);

      // Overlay must appear within ~3s (1.5s timeout + headroom).
      await waitForErrorOverlay(pageWindow, 5000);

      const overlay = await pageWindow.evaluate(() => {
        const el = document.querySelector('.load-error-overlay');
        if (!el) return null;
        return {
          urlText: el.querySelector('.load-error-url')?.textContent || '',
          reasonText: el.querySelector('.load-error-reason')?.textContent || '',
          hasRetry: !!el.querySelector('.load-error-retry'),
        };
      });
      expect(overlay).toBeTruthy();
      expect(overlay!.urlText).toContain('/hang');
      expect(overlay!.reasonText.toLowerCase()).toContain('took too long');
      expect(overlay!.hasRetry).toBe(true);

      // The webview must NOT still be in 'loading' state — that was the
      // original "endless glow border" symptom.
      const stuckOnLoading = await pageWindow.evaluate(() => {
        const webview = document.getElementById('content');
        return !!(webview && webview.classList.contains('loading'));
      });
      expect(stuckOnLoading).toBe(false);
    } finally {
      await closeWindow(sharedBgWindow, windowId);
    }
  });
});
