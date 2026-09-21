/**
 * External links — a URL from another app lands in the default workspace.
 *
 * Covers handoff.md's Goal for Next Step 2 and `features/spaces/DESIGN.md`
 * "External links": macOS open-url, the Windows/Linux second-instance
 * handoff, and a main-process CLI arg all funnel through
 * `main/main.ts handleExternalUrl()`, which publishes `external:open-url`.
 * `renderer/index.js`'s subscriber — core, never lazy — resolves
 * `space:default` itself and opens the window with that as its explicit
 * `spaceMode` option, tagging it into the default at open time regardless of
 * which workspace is active, without calling `openSpace('default')` (so the
 * active workspace is never saved, closed, or left).
 *
 * Run with:
 *   yarn test:grep "external links land in the default workspace"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;

async function runCommand(name: string, search = ''): Promise<any> {
  return bgWindow.evaluate(
    async (arg: { name: string; search: string }) => {
      const api = (window as unknown as { app: any }).app;
      return await new Promise((resolve) => {
        const resultTopic = `cmd:execute:${arg.name}:result:${Date.now()}:${Math.random()}`;
        api.subscribe(resultTopic, (r: unknown) => resolve(r));
        api.publish(`cmd:execute:${arg.name}`, {
          search: arg.search,
          params: [],
          expectResult: true,
          resultTopic,
        });
        setTimeout(() => resolve({ error: `timeout waiting for ${arg.name}` }), 20000);
      });
    },
    { name, search },
  );
}

/** Trigger the real main-process external-URL path (same call an OS open-url
 *  or second-instance event, or a CLI arg, would make) and wait for the
 *  resulting window's `window:opened` event, returning its id. */
async function openExternalUrlAndWait(url: string): Promise<number> {
  await bgWindow.evaluate((u: string) => {
    (window as unknown as { __extLinkOpened: unknown }).__extLinkOpened = null;
    (window as unknown as { app: any }).app.subscribe('window:opened', (msg: any) => {
      if (msg?.url && (msg.url.includes(u) || msg.url.includes(encodeURIComponent(u)))) {
        (window as unknown as { __extLinkOpened: unknown }).__extLinkOpened = msg;
      }
    });
  }, url);

  const mainResult = await app.evaluateMain!((_electron, testUrl: string) => {
    const { handleExternalUrl } = (globalThis as any).__peek_test;
    if (!handleExternalUrl) return { error: 'handleExternalUrl not found on __peek_test' };
    handleExternalUrl(testUrl, 'os');
    return { success: true };
  }, url);
  expect((mainResult as any).error).toBeUndefined();

  await bgWindow.waitForFunction(
    () => (window as unknown as { __extLinkOpened: unknown }).__extLinkOpened !== null,
    undefined,
    { timeout: 10000 },
  );

  const msg = await bgWindow.evaluate(() => (window as unknown as { __extLinkOpened: any }).__extLinkOpened);
  return msg.id as number;
}

test.describe('external links land in the default workspace @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('external-link-default-workspace'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a link from another app is tagged into space:default', async () => {
    const defaultTagId = (await bgWindow.evaluate(async () => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.datastore.getOrCreateTag('space:default');
      return r?.data?.tag?.id ?? null;
    })) as string | null;
    expect(defaultTagId).toBeTruthy();

    const windowId = await openExternalUrlAndWait('https://example.com/default-workspace-link');

    const modeEntry = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      return await api.context.get('mode', id);
    }, windowId);
    expect((modeEntry as any)?.data?.value).toBe('space');
    expect((modeEntry as any)?.data?.metadata?.spaceId).toBe(defaultTagId);

    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      windowId,
    );
  });

  test('a link arriving while a named workspace is active opens in the default without leaving it', async () => {
    const defaultTagId = (await bgWindow.evaluate(async () => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.datastore.getOrCreateTag('space:default');
      return r?.data?.tag?.id ?? null;
    })) as string | null;

    const openResult = await runCommand('open space', 'external-link-spec-workspace');
    expect(openResult?.success, `open space failed: ${openResult?.error}`).toBe(true);
    const namedWorkspacePage = await app.getWindow('spaces/home.html', 15000);
    const namedWorkspaceInfo = await namedWorkspacePage.evaluate(() =>
      (window as unknown as { app: any }).app.window.getInfo(),
    );
    const namedWindowId = namedWorkspaceInfo.id as number;

    const linkWindowId = await openExternalUrlAndWait('https://example.com/link-while-workspace-active');

    // The active (named) workspace's own window must still be open — the
    // link did not go through openSpace('default') and sweep it.
    const namedStillOpen = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.window.exists(id);
      return r?.exists;
    }, namedWindowId);
    expect(namedStillOpen, 'a link from another app closed the active workspace\'s window').toBe(true);

    // The link's window is tagged into the default, not the active named workspace.
    const modeEntry = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      return await api.context.get('mode', id);
    }, linkWindowId);
    expect((modeEntry as any)?.data?.metadata?.spaceId).toBe(defaultTagId);

    // Clean up: close the link window, then leave the named workspace the
    // normal way so the app is back in the default when the suite ends.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      linkWindowId,
    );
    const closeResult = await runCommand('close space');
    expect(closeResult?.success, `close space failed: ${closeResult?.error}`).toBe(true);
  });
});
