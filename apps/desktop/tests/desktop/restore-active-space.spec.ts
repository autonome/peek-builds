/**
 * The workspace that is active when Peek quits is the one active after it
 * relaunches.
 *
 * A quit while a named workspace is active saves THAT workspace's row
 * (`snapshot:<tagId>`, `main/session.ts saveSessionSnapshot` "Active
 * workspace"). Boot restores the default workspace's row and starts with the
 * default active, so the named workspace's windows stay closed and the next
 * ambient save writes the default's row.
 *
 * A relaunch is simulated in one process: save while the named workspace is
 * active, close its windows, put the main process's active workspace back to
 * the default (what a fresh process starts with), then run the boot restore
 * through `__peek_test.forceColdStartRestoreSession` — startup skips restore
 * in test profiles.
 *
 * Run with:
 *   yarn test:grep "restore active space"
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;

async function runCommand(name: string, search = '', bg: Page = bgWindow): Promise<any> {
  return bg.evaluate(
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

// `switch space` never creates its target, so entering a space goes through
// `create space` first. Creating a space that already exists is refused, which
// is harmless here: the switch that follows enters it either way.
async function enterSpace(name: string, bg: Page = bgWindow): Promise<any> {
  await runCommand('create space', name, bg);
  return runCommand('switch space', name, bg);
}

function spaceHomeWindows(spaceId: string, inApp: DesktopApp = app): Page[] {
  return inApp
    .windows()
    .filter((p) => !p.isClosed() && p.url().includes('spaces/home.html') && p.url().includes(encodeURIComponent(spaceId)));
}

test.describe('restore active space across a relaunch @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('restore-active-space'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a cold-start restore reopens the workspace that was active at quit and leaves it active', async () => {
    const spaceName = 'restore-active-space-spec';
    const opened = await enterSpace(spaceName);
    expect(opened?.success, `switch space "${spaceName}" failed: ${opened?.error}`).toBe(true);
    const spaceId = opened.spaceId as string;
    expect(spaceId).toBeTruthy();
    await expect.poll(() => spaceHomeWindows(spaceId).length, { timeout: 15000 }).toBe(1);

    // The quit-time save: an ambient save writes the active workspace's row.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    // The relaunch: nothing is open and the main process starts on the default.
    for (const page of spaceHomeWindows(spaceId)) {
      const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
      await bgWindow.evaluate(
        async (id: number) => (window as unknown as { app: any }).app.window.close(id),
        info.id as number,
      );
    }
    await expect
      .poll(() => spaceHomeWindows(spaceId).length, {
        timeout: 15000,
        message: 'the workspace window never closed; the restore below would be unfalsifiable',
      })
      .toBe(0);
    const reset = await bgWindow.evaluate(
      async () => await (window as unknown as { app: any }).app.session.setActiveWorkspace('default'),
    );
    expect(reset?.success).toBe(true);

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceColdStartRestoreSession()) as any);

    await expect
      .poll(() => spaceHomeWindows(spaceId).length, {
        timeout: 15000,
        message: 'the workspace active at quit did not reopen its windows on relaunch',
      })
      .toBe(1);
    const activeKey = await app.evaluateMain!(
      (() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any,
    );
    expect(activeKey, 'the workspace active at quit is not the active workspace after relaunch').toBe(spaceId);
  });

  test('a workspace deleted since the quit is not reopened; the default stays active', async () => {
    const spaceName = 'restore-active-space-deleted';
    const opened = await enterSpace(spaceName);
    expect(opened?.success, `switch space "${spaceName}" failed: ${opened?.error}`).toBe(true);
    const spaceId = opened.spaceId as string;
    await expect.poll(() => spaceHomeWindows(spaceId).length, { timeout: 15000 }).toBe(1);

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    for (const page of spaceHomeWindows(spaceId)) {
      const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
      await bgWindow.evaluate(
        async (id: number) => (window as unknown as { app: any }).app.window.close(id),
        info.id as number,
      );
    }
    await expect.poll(() => spaceHomeWindows(spaceId).length, { timeout: 15000 }).toBe(0);
    const reset = await bgWindow.evaluate(
      async () => await (window as unknown as { app: any }).app.session.setActiveWorkspace('default'),
    );
    expect(reset?.success).toBe(true);

    const deleted = await bgWindow.evaluate(
      async (id: string) => await (window as unknown as { app: any }).app.datastore.deleteTag(id),
      spaceId,
    );
    expect(deleted?.success, `deleting the space tag failed: ${deleted?.error}`).toBe(true);

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceColdStartRestoreSession()) as any);

    expect(spaceHomeWindows(spaceId).length, 'a deleted workspace reopened its windows').toBe(0);
    const activeKey = await app.evaluateMain!(
      (() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any,
    );
    expect(activeKey, 'a deleted workspace became active after relaunch').toBe('default');
  });
});

/**
 * A real relaunch, two processes on one profile. The spaces feature is lazy,
 * so after a relaunch it wakes fresh; it must wake into the restored
 * workspace rather than the default, or the next switch saves the restored
 * workspace's windows into the default's row.
 *
 * The profile is `tmp-`, not `test-`: boot restore is skipped for test
 * profiles (`config.ts isTestProfile`), and a `tmp-` profile is still
 * ephemeral. The fixture reuses one temp dir per profile string within a run,
 * so the second launch reads what the first saved.
 */
test.describe('restore active space across a real relaunch @desktop', () => {
  const PROFILE = 'tmp-restore-active-space-relaunch';

  test('after a relaunch into a workspace, switching away saves its windows to its own row, not the default', async () => {
    const restoredName = 'relaunch-restored';
    const otherName = 'relaunch-other';

    // ---- Launch 1: enter a workspace, then quit while it is active ----
    let first: DesktopApp | null = await launchDesktopApp(PROFILE);
    let spaceId: string;
    try {
      const bg1 = await first.getBackgroundWindow();
      await waitForExtensionsReady(bg1);
      const opened = await enterSpace(restoredName, bg1);
      expect(opened?.success, `switch space "${restoredName}" failed: ${opened?.error}`).toBe(true);
      spaceId = opened.spaceId as string;
      await expect.poll(() => spaceHomeWindows(spaceId, first!).length, { timeout: 15000 }).toBe(1);
      await first.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);
    } finally {
      await first.close();
      first = null;
    }

    // ---- Launch 2: boot restore reopens the workspace ----
    const second = await launchDesktopApp(PROFILE);
    try {
      const bg2 = await second.getBackgroundWindow();
      await waitForExtensionsReady(bg2);
      await expect
        .poll(() => spaceHomeWindows(spaceId, second).length, {
          timeout: 20000,
          message: 'boot did not reopen the workspace active at quit',
        })
        .toBe(1);
      await expect
        .poll(
          () => second.evaluateMain!((() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any),
          { timeout: 10000 },
        )
        .toBe(spaceId);

      const switched = await enterSpace(otherName, bg2);
      expect(switched?.success, `switch space "${otherName}" failed: ${switched?.error}`).toBe(true);
      await expect.poll(() => spaceHomeWindows(spaceId, second).length, { timeout: 15000 }).toBe(0);

      const readRow = (key: string) =>
        second.evaluateMain!(
          ((_e: unknown, k: string) => (globalThis as any).__peek_test.getWorkspaceSnapshotUrlsForTest(k)) as any,
          key,
        ) as Promise<string[] | null>;
      const holdsRestoredHome = (urls: string[] | null) =>
        (urls ?? []).some((u) => u.includes('spaces/home.html') && u.includes(encodeURIComponent(spaceId)));

      expect(
        holdsRestoredHome(await readRow('default')),
        "the switch saved the restored workspace's window into the default workspace's row",
      ).toBe(false);
      expect(
        holdsRestoredHome(await readRow(spaceId)),
        "the restored workspace's own row lost its window on the switch",
      ).toBe(true);
      const activeKey = await second.evaluateMain!(
        (() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any,
      );
      expect(activeKey).toBe(switched.spaceId);
    } finally {
      await second.close();
    }
  });
});
