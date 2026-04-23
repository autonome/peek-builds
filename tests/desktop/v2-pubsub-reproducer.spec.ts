/**
 * Minimal reproducer for the v2-tile pubsub routing bug that blocked
 * v1-removal Phase 2.
 *
 * Post-consolidation (cmd + hud + page merged into the core background
 * renderer), the trustedBuiltin tile windows we can use for a pure v2
 * pubsub round-trip are:
 *   - the core background renderer (peek://app/background.html)
 *   - any eager feature tile (e.g. peek://entities/home.html)
 *
 * core publishes; the feature tile subscribes. If the subscriber never
 * fires, the v2 pubsub routing is broken.
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

function findTileWindow(app: DesktopApp, urlMatch: string): Page | null {
  for (const w of app.windows()) {
    if (w.url().includes(urlMatch)) return w;
  }
  return null;
}

test('v2 trustedBuiltin tile → v2 trustedBuiltin tile pubsub round-trip', async () => {
  const urls = sharedApp.windows().map(w => w.url());
  console.log('[repro] available window URLs:', JSON.stringify(urls));

  // Publisher: core background renderer — trustedBuiltin tile.
  const pubWin = findTileWindow(sharedApp, 'peek://app/background.html');
  if (!pubWin) {
    throw new Error(`core window not found. URLs: ${JSON.stringify(urls)}`);
  }

  // Subscriber: any eager feature tile.
  const subWin =
    findTileWindow(sharedApp, 'peek://entities/') ||
    findTileWindow(sharedApp, 'peek://page/') ||
    findTileWindow(sharedApp, 'peek://me/') ||
    findTileWindow(sharedApp, 'peek://atproto/');

  if (!subWin) {
    throw new Error(
      `No feature tile window found for subscriber pairing. ` +
      `Available URLs: ${JSON.stringify(urls)}`
    );
  }
  console.log('[repro] subscriber window:', subWin.url());

  // 1. Subscribe on the feature tile.
  await subWin.evaluate(() => {
    const api = (window as any).app;
    (window as any).__reproReceived = null;
    (window as any).__reproDiag = {
      apiExists: !!api,
      hasSubscribe: !!(api && api.subscribe),
    };
    if (api && api.subscribe) {
      api.subscribe('repro:v2-v2-hello', (msg: unknown) => {
        (window as any).__reproReceived = msg;
      });
      (window as any).__reproDiag.subscribed = true;
    }
  });

  // Small buffer: IPC subscribe is async in main.
  await new Promise(r => setTimeout(r, 200));

  // 2. Publish from core.
  const pubResult = await pubWin.evaluate(() => {
    const api = (window as any).app;
    const diag: any = {
      apiExists: !!api,
      hasPublish: !!(api && api.publish),
    };
    if (api && api.publish) {
      api.publish('repro:v2-v2-hello', { from: 'core', ts: Date.now() });
      diag.published = true;
    }
    return diag;
  });
  console.log('[repro] publish diag:', JSON.stringify(pubResult));

  // 3. Wait for subscriber to receive. 5s is generous — v1 pubsub
  //    round-trips finish in <50ms.
  const received = await subWin.waitForFunction(
    () => (window as any).__reproReceived !== null,
    undefined,
    { timeout: 5000 }
  ).then(h => h.jsonValue()).catch(async () => {
    const diag = await subWin.evaluate(() => (window as any).__reproDiag);
    console.log('[repro] sub diag at timeout:', JSON.stringify(diag));
    return null;
  });
  console.log('[repro] received:', JSON.stringify(received));

  expect(pubResult.published, `core failed to publish: ${JSON.stringify(pubResult)}`).toBe(true);
  expect(received, 'subscriber never received core publish — v2 pubsub routing broken').not.toBeNull();
});
