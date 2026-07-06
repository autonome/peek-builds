/**
 * Hybrid page-host: favicon + spinner LOADING CARD (issue #3, black-screen fix).
 *
 * A fresh / session-restored / deferred-restore-on-focus hybrid window shows
 * nothing but its content view's un-painted fill until the first frame commits —
 * the "black screen while restoring" the user reported. Two-part fix:
 *   (A) the content WebContentsView gets the theme background (kills the BLACK),
 *   (B) the shared overlay paints a favicon+spinner card over the content rect
 *       while the FIRST load is in flight, removed the instant it settles.
 *
 * The card is gated on `firstLoad` (a never-painted window): an in-page
 * navigation of an already-painted window keeps the old page visible, so it must
 * NOT get an opaque card. This spec pins both: the card appears on first load and
 * is removed on settle, and it does NOT appear on a subsequent navigation.
 *
 * Observability: real pixels are unobservable in macOS-headless, but the card is
 * a real overlay DOM element, so we assert its presence/absence in the overlay
 * window (same approach as the branded error card in page-load-failure.spec).
 *
 * Run with:
 *   yarn test:grep "Hybrid Loading Card"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;
let server: http.Server;
let serverPort: number;
// Withheld responses released in afterAll so nothing dangles mid-load.
const pending = new Set<http.ServerResponse>();

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);

  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/slow')) {
        // Hold the response so the content WC stays in the LOADING state long
        // enough for the test to observe the card, then answer.
        pending.add(res);
        setTimeout(() => {
          if (pending.delete(res)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
          }
        }, 2000);
        return;
      }
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
  for (const res of pending) {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><title>drained</title><body>drained</body>');
    } catch { /* socket gone */ }
  }
  pending.clear();
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

async function destroyHybridHost(id: number): Promise<void> {
  await sharedApp.evaluateMain!(((_e: unknown, arg: { id: number }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    b.destroyFakeHybridWindow(arg.id);
  }) as any, { id });
}

async function overlayLoading(): Promise<boolean> {
  return sharedApp.evaluateMain!(async () => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    const s = await b.overlayChromeState();
    return s ? !!s.loading : false;
  });
}

test.describe('Hybrid Loading Card @desktop', () => {
  test('first load: favicon+spinner card appears while loading, removed on settle', async () => {
    const slowUrl = `http://127.0.0.1:${serverPort}/slow/first`;
    const { id, overlayWindow } = await openHybridHost();
    try {
      // Never painted yet → firstLoad is true.
      const paintedBefore = await sharedApp.evaluateMain!(((_e: unknown, i: number) => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return b.hybridHasPainted(i) as boolean;
      }) as any, id) as boolean;
      expect(paintedBefore).toBe(false);

      await navigateHybridHost(id, slowUrl);

      // The loading card (with spinner) appears while the first load is in flight.
      await overlayWindow.waitForFunction(() => {
        const card = document.querySelector('.loading-overlay');
        return !!card && !!card.querySelector('.loading-spinner');
      }, undefined, { timeout: 10000 });

      // No favicon is stored for this test URL, so the card is spinner-only.
      const hasFavicon = await overlayWindow.evaluate(
        () => !!document.querySelector('.loading-overlay .loading-favicon'),
      );
      expect(hasFavicon).toBe(false);

      // Once the withheld response arrives, the load settles → card removed.
      await overlayWindow.waitForFunction(
        () => !document.querySelector('.loading-overlay'),
        undefined,
        { timeout: 10000 },
      );
    } finally {
      await destroyHybridHost(id);
    }
  });

  test('second navigation (already painted) does NOT show the loading card', async () => {
    const goodUrl = `http://127.0.0.1:${serverPort}/ok`;
    const slowUrl = `http://127.0.0.1:${serverPort}/slow/second`;
    const { id, overlayWindow } = await openHybridHost();
    try {
      // First load settles → the window is now painted.
      await navigateHybridHost(id, goodUrl);
      await expect
        .poll(() => sharedApp.evaluateMain!(((_e: unknown, i: number) => {
          const b = (globalThis as any).__peekHybridOverlayTest;
          return b.hybridHasPainted(i) as boolean;
        }) as any, id), { timeout: 15000 })
        .toBe(true);
      // Card gone after settle.
      await overlayWindow.waitForFunction(
        () => !document.querySelector('.loading-overlay'),
        undefined,
        { timeout: 10000 },
      );

      // Second navigation to a slow URL: loading goes true, but firstLoad is now
      // false → the opaque card must NOT be created (old page stays visible).
      await navigateHybridHost(id, slowUrl);
      await expect.poll(() => overlayLoading(), { timeout: 10000 }).toBe(true);
      const cardDuringSecond = await overlayWindow.evaluate(
        () => !!document.querySelector('.loading-overlay'),
      );
      expect(cardDuringSecond).toBe(false);
    } finally {
      await destroyHybridHost(id);
    }
  });
});
