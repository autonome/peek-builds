/**
 * Hybrid page-host: same-URL Retry CAP (issue #1).
 *
 * The branded load-error card's "Retry" button publishes `page:reload`, which
 * reloaded the same failing URL with zero backoff — so mashing Retry on a
 * permanently-broken URL hammered it (the user read this as an "infinite loop").
 *
 * Fix: main caps the number of consecutive Retry reloads of the SAME failing URL
 * (HYBRID_SAME_URL_RETRY_CAP). The cap is gated on there being an OUTSTANDING
 * load failure — a normal Cmd+R / same-URL-window-reuse reload is never
 * throttled. When the cap is hit, main refuses the reload and publishes
 * `page:retry-capped`, which the overlay reflects by disabling the Retry button.
 *
 * The retry record is deterministic (attempt count off the load lifecycle, no
 * wall-clock timer) and separate from the flickering load-error state, so a fast
 * mash that lands mid-reload can't reset the counter. We drive it via the
 * `__peekHybridOverlayTest` bridge and assert both the main-side count and the
 * overlay's disabled Retry button.
 *
 * Run with:
 *   yarn test:grep "Hybrid Retry Cap"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;
let server: http.Server;
let serverPort: number;

const RETRY_CAP = 3; // must match HYBRID_SAME_URL_RETRY_CAP

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);

  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
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

async function openHybridHost(): Promise<{ id: number; overlayWindow: Page }> {
  const id = await sharedApp.evaluateMain!(() => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    return b.makeWiredHybridHost({ x: 100, y: 100, width: 800, height: 600 }) as number;
  });
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.setActive(arg.id);
  }) as any, { id });
  const overlayWindow = await sharedApp.getWindow('page/overlay.html', 20000);
  await overlayWindow.waitForFunction(
    () => (window as any).__overlayReady === true,
    undefined,
    { timeout: 10000 },
  );
  return { id, overlayWindow };
}

async function navigateHybridHost(id: number, url: string): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number; url: string }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.publishTopic('page:navigate', { windowId: arg.id, url: arg.url });
  }) as any, { id, url });
}

async function publishReload(id: number): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, i: number) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.publishTopic('page:reload', { windowId: i });
  }) as any, id);
}

async function retryAttempts(id: number): Promise<number> {
  return sharedApp.evaluateMain!(((_e: unknown, i: number) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    return b.hybridRetryAttempts(i) as number;
  }) as any, id) as Promise<number>;
}

async function hasOutstandingFailure(id: number): Promise<boolean> {
  return sharedApp.evaluateMain!(((_e: unknown, i: number) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    return b.hybridHasOutstandingFailure(i) as boolean;
  }) as any, id) as Promise<boolean>;
}

async function destroyHybridHost(id: number): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.destroyFakeHybridWindow(arg.id);
  }) as any, { id });
}

async function waitForErrorOverlay(overlayWindow: Page, timeout = 20000): Promise<void> {
  await overlayWindow.waitForFunction(
    () => !!document.querySelector('.load-error-overlay'),
    undefined,
    { timeout },
  );
}

test.describe('Hybrid Retry Cap @desktop', () => {
  test('mashing Retry on a permanently-failing URL is capped; Retry disables', async () => {
    const badUrl = 'http://nonexistent-retrycap-xyz.invalid/';
    const { id, overlayWindow } = await openHybridHost();
    try {
      await navigateHybridHost(id, badUrl);
      await waitForErrorOverlay(overlayWindow);
      // Failure recorded; no retry yet.
      expect(await hasOutstandingFailure(id)).toBe(true);
      expect(await retryAttempts(id)).toBe(0);

      // Fire exactly CAP Retry reloads. Each is allowed (attempts < cap), reloads,
      // re-fails, and re-shows the error card. Poll the deterministic main-side
      // attempt count between presses so the sequence can't race.
      for (let i = 1; i <= RETRY_CAP; i++) {
        await publishReload(id);
        await expect.poll(() => retryAttempts(id), { timeout: 20000 }).toBe(i);
        await waitForErrorOverlay(overlayWindow); // reload re-failed → card back
      }
      expect(await retryAttempts(id)).toBe(RETRY_CAP);

      // One more Retry — now at the cap. Main refuses the reload (attempt count
      // stays at CAP) and publishes page:retry-capped → overlay disables Retry.
      await publishReload(id);
      await overlayWindow.waitForFunction(() => {
        const btn = document.querySelector('.load-error-retry') as HTMLButtonElement | null;
        return !!btn && btn.disabled && /too many/i.test(btn.textContent || '');
      }, undefined, { timeout: 10000 });

      // The reload was blocked — attempt count did not grow past the cap, and the
      // error card is STILL present (not blanked into an empty page).
      expect(await retryAttempts(id)).toBe(RETRY_CAP);
      const cardPresent = await overlayWindow.evaluate(
        () => !!document.querySelector('.load-error-overlay'),
      );
      expect(cardPresent).toBe(true);
    } finally {
      await destroyHybridHost(id);
    }
  });

  test('a successful load has no outstanding failure — a reload is not throttled', async () => {
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;
    const { id } = await openHybridHost();
    try {
      await navigateHybridHost(id, goodUrl);
      // After a genuine success there is no outstanding failure, so the reload
      // cap gate is never entered (a normal Cmd+R reloads freely).
      await expect.poll(() => hasOutstandingFailure(id), { timeout: 15000 }).toBe(false);
      await publishReload(id);
      expect(await retryAttempts(id)).toBe(0);
      expect(await hasOutstandingFailure(id)).toBe(false);
    } finally {
      await destroyHybridHost(id);
    }
  });
});
