import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  waitForExtensionsReady,
  waitForPanelCommandsLoaded,
  waitForCmdNotExecuting,
} from '../helpers/window-utils';
import http from 'http';

// ============================================================================
// Noun commands of a lazy feature are listed before the feature wakes (@desktop)
//
// The groups feature is lazy: its tile boots on first use. Its noun
// (`features/groups/home.js initCommands registerNoun`) generates the
// commands `new group`, `list groups`, `open group`, which exist only once the
// tile runs. The manifest's `nouns` declaration lets main announce them at
// boot (`main/tile-lazy.ts registerLazyTile`), so the panel lists them while
// the tile is still asleep, and running one wakes the tile and delivers it.
//
//   yarn test:grep "Lazy noun commands in the cmd panel"
// ============================================================================

const PANEL_OPEN_OPTS = {
  modal: true,
  width: 600,
  height: 50,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  center: true,
};

test.describe('Lazy noun commands in the cmd panel @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let base: string;
  let pageId: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-lazy-noun'));
    await waitForExtensionsReady(bgWindow, 15000);
    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>grouped</title></head><body>page</body></html>');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (pageId != null) {
      try {
        await bgWindow.evaluate(async (id: number) => await (window as any).app.window.close(id), pageId);
      } catch { /* app may be gone */ }
    }
    if (server) server.close();
    if (app) await app.close();
  });

  async function openPanel(): Promise<{ cmdWindow: Page; panelId: number }> {
    const openResult = await bgWindow.evaluate(async (opts) => {
      return await (window as any).app.window.open('peek://cmd/panel.html', opts);
    }, PANEL_OPEN_OPTS);
    expect(openResult.success).toBe(true);
    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);
    // `close group` is a manifest command of the same lazy feature: once it is
    // listed, the feature's boot-time announcements have reached the panel.
    await cmdWindow.waitForFunction(
      () => !!(window as any)._cmdState?.commands?.['close group'],
      undefined,
      { timeout: 10000 },
    );
    return { cmdWindow, panelId: openResult.id };
  }

  async function closePanel(panelId: number) {
    try {
      await bgWindow.evaluate(async (id: number) => await (window as any).app.window.close(id), panelId);
    } catch { /* the panel may have closed itself after running a command */ }
  }

  test('typing "new group" lists the command while the groups feature is asleep', async () => {
    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', 'new group');

    await expect
      .poll(
        () => cmdWindow.evaluate(() => (window as any)._cmdState?.matches || []),
        { timeout: 5000 },
      )
      .toContain('new group');
    const selected = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      return s?.matches?.[s.matchIndex];
    });
    expect(selected).toBe('new group');

    await closePanel(panelId);
  });

  test('running "new group <name>" from the panel saves the open window into the group', async () => {
    const opened = await bgWindow.evaluate(
      async (u: string) => await (window as any).app.window.open(u, { width: 500, height: 400 }),
      `${base}/grouped`,
    );
    expect(opened.success).toBe(true);
    pageId = opened.id;

    // "new group" saves the windows `api.window.list` reports, which leaves out
    // a window that is not on screen yet. Run the command once the page shows.
    await expect
      .poll(
        () => bgWindow.evaluate(async (id: number) => {
          const r = await (window as any).app.window.list({});
          return (r.windows || []).some((w: { id: number }) => w.id === id);
        }, pageId),
        { timeout: 10000 },
      )
      .toBe(true);

    const groupName = `lazy-noun-${Date.now()}`;
    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', `new group ${groupName}`);
    await cmdWindow.keyboard.press('Enter');
    expect(await waitForCmdNotExecuting(cmdWindow, 20000)).not.toBe('TIMEOUT');
    await closePanel(panelId);

    const urlsInGroup = async () => bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;
      const tags = await api.datastore.getTagsByFrecency();
      const tag = (tags.data || []).find((t: { name: string }) => t.name === name);
      if (!tag) return [];
      const items = await api.datastore.getItemsByTag(tag.id);
      return (items.data || []).map((i: { content?: string }) => i.content || '');
    }, groupName);
    await expect.poll(urlsInGroup, { timeout: 10000 }).toContain(`${base}/grouped`);
  });
});
