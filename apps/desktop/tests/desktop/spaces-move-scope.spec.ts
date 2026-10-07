/**
 * "move to space" acts on the one window it was run on.
 *
 * Several pages are open in the default workspace; "move to space <name>" is
 * run with one of them focused. Only that page may leave the default
 * workspace: the others stay open and stay in the default, the target
 * workspace's saved row holds that one page and nothing else, entering the
 * target workspace opens that one page, and no saved item gains the target
 * space's tag. Covers `features/spaces/background.js moveToSpace()` and
 * `main/session.ts addWindowToWorkspaceSnapshot()`.
 *
 * Network-free: content is served by a local loopback server.
 *
 * Run with:
 *   yarn test:grep "move to space scope"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady } from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

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

async function windowExists(id: number): Promise<boolean> {
  return bgWindow.evaluate(async (wid: number) => {
    const r = await (window as unknown as { app: any }).app.window.exists(wid);
    return !!r?.exists;
  }, id);
}

async function modeSpaceId(id: number): Promise<string | null> {
  return bgWindow.evaluate(async (wid: number) => {
    const r = await (window as unknown as { app: any }).app.context.get('mode', wid);
    return (r?.data?.metadata?.spaceId ?? null) as string | null;
  }, id);
}

/** Make a page host the one the shared chrome overlay frames. */
async function setActiveHost(id: number): Promise<void> {
  const ok = await app.evaluateMain!(
    ((_e: unknown, wid: number) =>
      (globalThis as any).__peekHybridOverlayTest.setActive(wid)) as any,
    id,
  );
  expect(ok, `could not make window ${id} the active page host`).toBe(true);
}

/** The space name the page-host chrome's SPACE widget shows, or null when it shows none. */
async function spaceWidgetText(): Promise<string | null> {
  const overlay = app.windows().find((p) => !p.isClosed() && p.url().includes('page/overlay.html'));
  if (!overlay) return null;
  return overlay.evaluate(() => document.querySelector('.space-mode-name')?.textContent ?? null);
}

async function tagId(name: string): Promise<string> {
  const id = await bgWindow.evaluate(async (n: string) => {
    const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(n);
    return (r?.data?.tag?.id ?? null) as string | null;
  }, name);
  expect(id, `could not resolve tag ${name}`).toBeTruthy();
  return id as string;
}

test.describe('move to space scope @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('spaces-move-scope'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
            `<body><h1>${req.url}</h1></body></html>`,
        );
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
    if (app) await app.close();
  });

  test('moving one page to an inactive space moves only that page', async () => {
    const defaultId = await tagId('space:default');
    const targetName = 'move-scope-target';

    // Three pages in the default workspace, opened through the production
    // window-open path (each is born in the active workspace).
    const urls = [1, 2, 3].map((n) => `http://127.0.0.1:${serverPort}/move-scope-page-${n}`);
    const ids: number[] = [];
    for (const url of urls) {
      const opened = await bgWindow.evaluate(
        async (u: string) =>
          await (window as unknown as { app: any }).app.window.open(u, { width: 800, height: 600 }),
        url,
      );
      expect(opened?.success, `opening ${url} failed: ${opened?.error}`).toBe(true);
      ids.push(opened.id as number);
    }
    for (let n = 1; n <= 3; n++) await app.getWindow(`move-scope-page-${n}`, 15000);
    // A window opened from the test harness's own page is not stamped with a
    // workspace, so put each one in the default directly — the same write
    // `adoptOpenWindowsIntoDefault()` performs.
    for (const id of ids) {
      const ctx = await bgWindow.evaluate(
        async (arg: { id: number; spaceId: string }) =>
          await (window as unknown as { app: any }).app.context.setMode('space', {
            windowId: arg.id,
            metadata: { spaceId: arg.spaceId, spaceName: 'default' },
          }),
        { id, spaceId: defaultId },
      );
      expect(ctx?.success).toBe(true);
      expect(await modeSpaceId(id), `window ${id} is not in the default workspace`).toBe(defaultId);
    }

    // Before the move the shared page-host chrome's SPACE widget names the
    // default space on a page in it — proves the widget read below works.
    await setActiveHost(ids[0]);
    await waitOverlayReady(app);
    await expect.poll(() => spaceWidgetText(), { timeout: 10000 }).toBe('default');

    // Focus the middle page and move it.
    const movedId = ids[1];
    await bgWindow.evaluate(async (id: number) => {
      await (window as unknown as { app: any }).app.window.focus(id);
    }, movedId);
    await new Promise((r) => setTimeout(r, 300));

    const result = await runCommand('move to space', targetName);
    expect(result?.error, `move to space failed: ${result?.error}`).toBeUndefined();
    expect(result?.success).toBe(true);
    expect(result?.windowId, 'the command moved a window other than the focused one').toBe(movedId);
    const targetId = result.spaceId as string;
    expect(targetId).toBeTruthy();

    // Windows: only the moved page leaves the screen; the others stay in the default.
    await expect.poll(() => windowExists(movedId), { timeout: 10000 }).toBe(false);
    for (const id of [ids[0], ids[2]]) {
      expect(await windowExists(id), `window ${id} was closed by moving a different window`).toBe(true);
      expect(await modeSpaceId(id), `window ${id} changed workspace when a different window moved`).toBe(defaultId);
    }

    // Chrome: the page-host chrome's SPACE widget on a page that stayed must
    // still name the default space, not the target.
    await setActiveHost(ids[0]);
    await waitOverlayReady(app);
    await expect
      .poll(() => spaceWidgetText(), {
        timeout: 10000,
        message: 'the SPACE widget on a page that was not moved names the wrong space',
      })
      .toBe('default');

    // Saved row: the target workspace holds the moved page and nothing else.
    const info = await bgWindow.evaluate(
      async (key: string) => await (window as unknown as { app: any }).app.session.getWorkspaceSnapshotInfo(key),
      targetId,
    );
    expect(info?.success, `reading the target row failed: ${info?.error}`).toBe(true);
    const savedUrls = (info.windows ?? []).map((w: { url: string }) => w.url);
    expect(savedUrls, 'the target workspace row holds more than the moved page').toEqual([urls[1]]);

    // Datastore: no saved item gained the target space's tag except, at most, the moved page.
    const tagged = await bgWindow.evaluate(
      async (id: string) => await (window as unknown as { app: any }).app.datastore.getItemsByTag(id),
      targetId,
    );
    const taggedUrls = ((tagged?.data ?? []) as { content?: string }[]).map((i) => i.content);
    for (const url of [urls[0], urls[2]]) {
      expect(taggedUrls, `${url} was tagged into the target space`).not.toContain(url);
    }

    // Entering the target opens the moved page and only it.
    const switched = await runCommand('switch space', targetName);
    expect(switched?.success, `switch space failed: ${switched?.error}`).toBe(true);
    await app.getWindow('move-scope-page-2', 15000);
    await new Promise((r) => setTimeout(r, 1000));
    const openPages = app
      .windows()
      .filter((p) => !p.isClosed() && p.url().includes('move-scope-page-'))
      .map((p) => p.url());
    expect(openPages, 'entering the target space opened pages that were never moved').toEqual([urls[1]]);
  });
});
