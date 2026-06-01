/**
 * Minimal reproducer for the v2-tile pubsub routing bug that blocked
 * v1-removal Phase 2.
 *
 * Post-consolidation (cmd + hud + page merged into the core background
 * renderer), and after the lazy-feature workstream (peek epic d8e7efa5 /
 * task 921b54b3), there are NO eager feature tiles left at boot — peeks,
 * slides, websearch, windows and mcp-server are all lazy. So this repro can
 * no longer just grab whatever feature tile happens to be resident; instead
 * it DETERMINISTICALLY WAKES a lazy tile (peeks) to READY and uses that
 * woken renderer as the subscriber:
 *   - publisher: the core background renderer (peek://app/background.html)
 *   - subscriber: the peeks tile, woken via its `cli:peek-open` lazyEvent
 *     (driven through the System hook exactly as its wake hotkey would)
 *
 * core publishes; the woken feature tile subscribes. If the subscriber
 * never fires, the v2 pubsub routing is broken.
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

  // Subscriber: there are no eager feature tiles at boot anymore (all lazy).
  // Deterministically WAKE the peeks tile to READY, then use it as the
  // subscriber. We arm the FSM observer BEFORE firing the wake topic so the
  // cold-boot READY transition can't race ahead, then publish the exact
  // output of the peeks wake hotkey: cli:peek-open {args:['0']} on System.
  const readyPromise = sharedApp.evaluateMain!(((_e: unknown) =>
    (globalThis as any).__peek_test.waitForTileState('peeks', 'ready', 15000)) as any);
  await sharedApp.evaluateMain!(((_e: unknown) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:peek-open', { args: ['0'] });
  }) as any);
  await readyPromise;

  // Now the peeks bg renderer exists. Grab it as the subscriber. getWindow's
  // timeout is a failure-deadline (the tile is already READY), not a settle-
  // wait — it just covers the tick between READY and Playwright enumerating
  // the new BrowserWindow.
  const subWin = await sharedApp.getWindow('peek://peeks/', 15000);

  if (!subWin) {
    throw new Error(
      `No feature tile window found for subscriber pairing. ` +
      `Available URLs: ${JSON.stringify(sharedApp.windows().map(w => w.url()))}`
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
