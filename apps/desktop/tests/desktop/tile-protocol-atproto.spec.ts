/**
 * Integration spec for the `atproto` Web Tiles protocol.
 *
 * A tile reaches the protocol by importing it from its own host:
 *
 *   await import('/.well-known/web-tiles/atproto.js')
 *
 * which resolves to `peek://<tile-id>/.well-known/web-tiles/atproto.js`. The
 * host names the requesting tile, so what is served depends on that tile's
 * grant. Three things are pinned here: a granted tile gets a module whose
 * methods answer exactly as the `window.app.atproto` copy does; a tile without
 * the gating `network` capability gets a rejected import; and an unknown
 * protocol rejects the same way, so a tile cannot tell a refusal from an
 * absent API.
 *
 * The fourth test is the reason the move is observable at all: a protocol
 * module is ordinary page code, so the publish wizard's own import can be
 * watched from here, which `window.app` never allowed.
 *
 * Fresh profile, so the session is signed out and no network call is made.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

const MODULE_URL = '/.well-known/web-tiles/atproto.js';

/** Import a protocol module in a page and report what happened. */
async function tryImport(page: Page, url: string): Promise<{ ok: boolean; exports?: string[] }> {
  return await page.evaluate(async (u) => {
    try {
      const mod = await import(u);
      return { ok: true, exports: Object.keys(mod).filter((k) => k !== 'default').sort() };
    } catch {
      return { ok: false };
    }
  }, url);
}

test.describe('atproto as a Web Tiles protocol @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tile-protocol-atproto'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /** Open a feature page and hand back its Playwright page. */
  async function openTile(url: string, key: string, match: string): Promise<Page> {
    const opened = await bgWindow.evaluate(
      async ({ u, k }) => await (window as any).app.window.open(u, {
        role: 'workspace',
        key: k,
        width: 700,
        height: 600,
      }),
      { u: url, k: key },
    );
    expect(opened.success).toBe(true);
    const page = await app.getWindow(match, 15_000);
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  test('a granted tile imports the module and gets the declared methods', async () => {
    const tile = await openTile('peek://features-manager/publish.html', 'proto-granted', 'features-manager/publish.html');
    const imported = await tryImport(tile, MODULE_URL);
    expect(imported.ok).toBe(true);
    expect(imported.exports).toEqual(['request', 'sessionInfo', 'uploadBlob']);
  });

  test('sessionInfo() through the protocol matches window.app.atproto.sessionInfo()', async () => {
    const tile = await openTile('peek://features-manager/publish.html', 'proto-session', 'features-manager/publish.html');
    const both = await tile.evaluate(async (u) => {
      const mod = await import(u);
      return {
        viaProtocol: await mod.sessionInfo(),
        viaWindowApp: await (window as any).app.atproto.sessionInfo(),
      };
    }, MODULE_URL);
    // Fresh profile: no stored session, so both report signed out.
    expect(both.viaProtocol).toEqual({ signedIn: false });
    expect(both.viaProtocol).toEqual(both.viaWindowApp);
  });

  test('a tile without the network capability gets a rejected import', async () => {
    // hello-world declares no `network` capability, so `atproto` does not
    // exist for it and the module is not served.
    const tile = await openTile('peek://hello-world/home.html', 'proto-ungranted', 'hello-world/home.html');
    expect(await tryImport(tile, MODULE_URL)).toEqual({ ok: false });
  });

  test('an unknown protocol rejects the same way an ungranted one does', async () => {
    const tile = await openTile('peek://features-manager/publish.html', 'proto-unknown', 'features-manager/publish.html');
    expect(await tryImport(tile, '/.well-known/web-tiles/nonexistent.js')).toEqual({ ok: false });
  });

  test('the publish wizard loads with its atproto import resolved', async () => {
    const tile = await openTile('peek://features-manager/publish.html', 'proto-publish', 'features-manager/publish.html');
    const resolved = await tile.evaluate(
      async () => await (window as any).__peekAtprotoProtocolResolved,
    );
    expect(resolved).toBe(true);
  });
});
