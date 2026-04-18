/**
 * Minimal reproducer for the v2-tile pubsub routing bug that blocked
 * v1-removal Phase 2.
 *
 * Approach: use windows that already exist post-Phase-1 as a pure
 * v2→v2 pubsub round-trip. Both cmd (via cmd-glue) and hud (via
 * hud-glue) are trustedBuiltin tile renderers loaded at startup
 * with `tile-preload.cjs`. cmd publishes, hud subscribes. If the
 * subscriber never fires, the v2→v2 pubsub path is broken — no test
 * fixture needed.
 *
 * Observed: under `yarn test:grep` (E2E test profile), hud window is
 * NOT present in `electronApp.windows()` (only cmd, app/background,
 * app/extension-host, app/settings). Falls back to looking for ANY
 * other v2 tile window (e.g. entities/background.html) as subscriber.
 * Test throws with the available URL list when no pairing is found —
 * serves as diagnostic output for later investigation.
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
  // Give hud/page glue time to launch their resident renderers.
  // initHud / initPage are awaited inside loadExtensions() but the
  // BrowserWindow's URL may not resolve to the final peek:// host until
  // the protocol handler fires. 2s is generous.
  await new Promise(r => setTimeout(r, 2000));

  const urls = sharedApp.windows().map(w => w.url());
  console.log('[repro] available window URLs:', JSON.stringify(urls));

  // cmd resident (publisher) — trustedBuiltin tile from cmd-glue
  const cmdWin = findTileWindow(sharedApp, 'peek://cmd/index.html');
  if (!cmdWin) {
    throw new Error(`cmd window not found. URLs: ${JSON.stringify(urls)}`);
  }

  // Pick any second v2 tile window (subscriber). Try hud, then page,
  // then any eager feature tile.
  const subWin =
    findTileWindow(sharedApp, 'peek://hud/index.html') ||
    findTileWindow(sharedApp, 'peek://page/') ||
    findTileWindow(sharedApp, 'peek://entities/') ||
    findTileWindow(sharedApp, 'peek://me/') ||
    findTileWindow(sharedApp, 'peek://atproto/');

  if (!subWin) {
    throw new Error(
      `No second v2 tile window found for subscriber pairing. ` +
      `Available URLs: ${JSON.stringify(urls)}`
    );
  }
  console.log('[repro] subscriber window:', subWin.url());

  // 1. Subscribe on the second v2 tile.
  await subWin.evaluate(() => {
    const api = (window as any).app;
    (window as any).__reproReceived = null;
    (window as any).__reproDiag = {
      apiExists: !!api,
      hasSubscribe: !!(api && api.subscribe),
      hasScopes: !!(api && api.scopes),
      scopeGlobal: api && api.scopes && api.scopes.GLOBAL,
    };
    if (api && api.subscribe && api.scopes) {
      api.subscribe('repro:v2-v2-hello', (msg: unknown) => {
        (window as any).__reproReceived = msg;
      }, api.scopes.GLOBAL);
      (window as any).__reproDiag.subscribed = true;
    }
  });

  // Small buffer: IPC subscribe is async in main.
  await new Promise(r => setTimeout(r, 200));

  // 2. Publish from cmd.
  const pubResult = await cmdWin.evaluate(() => {
    const api = (window as any).app;
    const diag: any = {
      apiExists: !!api,
      hasPublish: !!(api && api.publish),
      scopeGlobal: api && api.scopes && api.scopes.GLOBAL,
    };
    if (api && api.publish && api.scopes) {
      api.publish('repro:v2-v2-hello', { from: 'cmd', ts: Date.now() }, api.scopes.GLOBAL);
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

  expect(pubResult.published, `cmd failed to publish: ${JSON.stringify(pubResult)}`).toBe(true);
  expect(received, 'subscriber never received cmd publish — v2 pubsub routing broken').not.toBeNull();
});
