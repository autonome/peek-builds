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

// ── Hybrid path helpers ──────────────────────────────────────────────────────
// On the hybrid path there is no per-page canvas window (`page/index.html`).
// The branded error card lives in the shared chrome overlay (`page/overlay.html`).
// All helpers below drive the hybrid E2E bridge (`__peekHybridOverlayTest`).

/**
 * Create a wired hybrid host (real `wireHybridContentEvents` so `did-fail-load`
 * events propagate), set it active so the overlay frames it, and return the host
 * id + a Playwright handle to the overlay window. Waits for the overlay renderer
 * to be ready before returning so DOM reads are immediately observable.
 */
async function openHybridHost(): Promise<{ id: number; overlayWindow: Page }> {
  // makeWiredHybridHost: real BaseWindow + WebContentsView + wireHybridContentEvents
  const id = await sharedApp.evaluateMain!(() => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    return b.makeWiredHybridHost({ x: 100, y: 100, width: 800, height: 600 }) as number;
  });
  // setActive fires the active-window push signal → overlay retargets onto this host.
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.setActive(arg.id);
  }) as any, { id });
  // The overlay BrowserWindow is created lazily on the first setActive.
  const overlayWindow = await sharedApp.getWindow('page/overlay.html', 20000);
  // Wait for overlay.js to subscribe before we read its DOM.
  await overlayWindow.waitForFunction(
    () => (window as any).__overlayReady === true,
    undefined,
    { timeout: 10000 },
  );
  return { id, overlayWindow };
}

/** Fire-and-forget navigation on a hybrid host's content WC via pubsub. */
async function navigateHybridHost(id: number, url: string): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number; url: string }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.publishTopic('page:navigate', { windowId: arg.id, url: arg.url });
  }) as any, { id, url });
}

/** Destroy a fake wired hybrid host (drops it from the registry). */
async function destroyHybridHost(id: number): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.destroyFakeHybridWindow(arg.id);
  }) as any, { id });
}

/** Lower the hybrid loading-timeout for the hung-load spec (test bridge). */
async function setHybridTimeoutMs(ms: number): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, arg: { ms: number }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.setHybridLoadingTimeoutMs(arg.ms);
  }) as any, { ms });
}

/**
 * Wait for the `.load-error-overlay` to appear in the shared overlay window.
 * The overlay window is the hybrid equivalent of `pageWindow` for the error card.
 */
async function waitForHybridErrorOverlay(overlayWindow: Page, timeout = 15000): Promise<void> {
  await overlayWindow.waitForFunction(
    () => !!document.querySelector('.load-error-overlay'),
    undefined,
    { timeout },
  );
}

test.describe('Page Host Load Failure @desktop', () => {
  test('DNS failure: shows branded error overlay with URL and retry button', async () => {
    // .invalid is reserved by RFC 2606 — guaranteed to never resolve.
    const badUrl = 'http://nonexistent-host-xyz123.invalid/';

    const { id, overlayWindow } = await openHybridHost();
    try {
      await navigateHybridHost(id, badUrl);
      await waitForHybridErrorOverlay(overlayWindow);

      const overlay = await overlayWindow.evaluate(() => {
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
      await destroyHybridHost(id);
    }
  });

  test('Connection refused: shows branded error overlay', async () => {
    // Port 1 is reserved and nothing listens — connection refused.
    const badUrl = 'http://127.0.0.1:1/';

    const { id, overlayWindow } = await openHybridHost();
    try {
      await navigateHybridHost(id, badUrl);
      await waitForHybridErrorOverlay(overlayWindow);
      const urlText = await overlayWindow.evaluate(
        () => document.querySelector('.load-error-url')?.textContent || '',
      );
      expect(urlText).toContain('127.0.0.1:1');
    } finally {
      await destroyHybridHost(id);
    }
  });

  test('Successful load after error: clicking Retry on a now-reachable URL clears the overlay', async () => {
    // Start by hitting a bad URL, then navigate to a working one — the overlay must clear.
    const badUrl = 'http://nonexistent-host-xyz456.invalid/';
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;

    const { id, overlayWindow } = await openHybridHost();
    try {
      await navigateHybridHost(id, badUrl);
      await waitForHybridErrorOverlay(overlayWindow);
      // Navigate to working URL via pubsub — triggers did-start-loading which
      // clears the error (setHybridLoadError null → page:load-error null → clearLoadErrorOverlay).
      await navigateHybridHost(id, goodUrl);
      await overlayWindow.waitForFunction(
        () => !document.querySelector('.load-error-overlay'),
        undefined,
        { timeout: 15000 },
      );
    } finally {
      await destroyHybridHost(id);
    }
  });

  test('Successful initial load: no error overlay appears', async () => {
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;

    const { id, overlayWindow } = await openHybridHost();
    try {
      await navigateHybridHost(id, goodUrl);
      // Wait for the load to settle: the overlay's loading spinner clears.
      // Poll the bridge's chrome state — loading:false means did-stop-loading fired.
      await expect
        .poll(async () =>
          sharedApp.evaluateMain!(async () => {
            const b = (globalThis as any).__peekHybridOverlayTest;
            const s = await b.overlayChromeState();
            return s ? s.loading : true;
          }),
          { timeout: 15000 },
        )
        .toBe(false);
      const hasOverlay = await overlayWindow.evaluate(
        () => !!document.querySelector('.load-error-overlay'),
      );
      expect(hasOverlay).toBe(false);
    } finally {
      await destroyHybridHost(id);
    }
  });

  test('Re-opening a previously-failed URL still shows the overlay (session-restore parity)', async () => {
    // User-reported regression: closing the app while a tab is on a failed URL,
    // then restarting, leaves the restored tab stuck on a blank page with the
    // loading glow permanently on. This test simulates that by opening a new
    // page-host on a known-failed URL after closing the previous one.
    const badUrl = 'http://nonexistent-host-restoresim.invalid/';

    // First hybrid host — confirm the overlay shows.
    const { id: firstId, overlayWindow } = await openHybridHost();
    await navigateHybridHost(firstId, badUrl);
    await waitForHybridErrorOverlay(overlayWindow, 20000);
    // Destroy the first host synchronously (registry entry removed immediately).
    await destroyHybridHost(firstId);

    // Second hybrid host — same bad URL, fresh wired host. The overlay must
    // show again and loading must NOT be stuck on.
    const secondId = await sharedApp.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybridHost({ x: 100, y: 100, width: 800, height: 600 }) as number;
    });
    try {
      await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number }) => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        b.setActive(arg.id);
      }) as any, { id: secondId });
      await navigateHybridHost(secondId, badUrl);
      await waitForHybridErrorOverlay(overlayWindow, 20000);
      // After the overlay shows, the overlay's loading spinner must be off.
      const stuckOnLoading = await sharedApp.evaluateMain!(async () => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        const s = await b.overlayChromeState();
        return s ? !!s.loading : false;
      });
      expect(stuckOnLoading).toBe(false);
    } finally {
      await destroyHybridHost(secondId);
    }
  });

  test('Hung load: loading-timeout safety net surfaces the error overlay (regression: blank-white-page-forever)', async () => {
    // User-reported: http://www.metikmusic.com/ — DNS resolves, server accepts
    // the connection, but never responds. The 30s loading-timeout safety net
    // surfaces the same branded error card as did-fail-load.
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;
    const hangUrl = `http://127.0.0.1:${serverPort}/hang`;

    const { id, overlayWindow } = await openHybridHost();
    try {
      // Load a working page first so `did-start-loading` arms the timer on a
      // clean slate before we lower the timeout.
      await navigateHybridHost(id, goodUrl);
      // Wait for did-stop-loading (loading:false) so the first navigation's
      // timer is cleared before we set the short test timeout.
      await expect
        .poll(async () =>
          sharedApp.evaluateMain!(async () => {
            const b = (globalThis as any).__peekHybridOverlayTest;
            const s = await b.overlayChromeState();
            return s ? s.loading : true;
          }),
          { timeout: 15000 },
        )
        .toBe(false);

      // Lower the loading-timeout so the hung-load fires quickly in the test.
      // setHybridLoadingTimeoutMs is read by wireHybridContentEvents on each
      // did-start-loading — set BEFORE navigating to the hung endpoint.
      await setHybridTimeoutMs(1500);

      // Navigate to the hung endpoint via pubsub (fire-and-forget: the server
      // accepts the connection but never sends a response).
      await navigateHybridHost(id, hangUrl);

      // Overlay must appear within ~3s (1.5s timeout + headroom).
      await waitForHybridErrorOverlay(overlayWindow, 5000);

      const overlay = await overlayWindow.evaluate(() => {
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

      // The overlay's loading spinner must be off — not the "endless glow border".
      const stuckOnLoading = await sharedApp.evaluateMain!(async () => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        const s = await b.overlayChromeState();
        return s ? !!s.loading : false;
      });
      expect(stuckOnLoading).toBe(false);
    } finally {
      // Restore the production timeout so other tests aren't affected.
      await setHybridTimeoutMs(30000);
      await destroyHybridHost(id);
    }
  });
});
