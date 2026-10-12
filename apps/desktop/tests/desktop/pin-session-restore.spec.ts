/**
 * Pin mechanism — pin state survives session save/restore, both scopes.
 *
 * Pin scope is a field of the window's own context row (`pinScope`), carried
 * on the window's descriptor in whichever session snapshot it is saved into
 * (`main/session-projection.ts serializeSession`) — there is no separate
 * persisted pin list for either scope. A workspace-scoped pin rides in that
 * workspace's own saved snapshot (`snapshot:<workspaceKey>`, written by
 * `api.session.saveWorkspaceSnapshot`) and restores with the rest of that
 * workspace's windows. A cross-workspace pin lives in the default workspace's
 * snapshot (the row boot restores): a save of the default workspace records
 * it like any other window, and a save under a NAMED key — which never
 * includes it in that workspace's own row — refreshes the default row's
 * record of it instead (`main/session.ts saveSessionSnapshot`), so it
 * survives a relaunch whichever workspace was active at quit. See
 * docs/design/window-rules.md "Persistent windows: workspace-pinned and global
 * HUD", "Workspace interaction".
 *
 * Run with:
 *   yarn test:grep "pin session restore"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

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

// `switch space` never creates its target, so entering a space goes through
// `create space` first. Creating a space that already exists is refused, which
// is harmless here: the switch that follows enters it either way.
async function enterSpace(name: string): Promise<any> {
  await runCommand('create space', name);
  return runCommand('switch space', name);
}

async function openAndPin(spaceName: string, scope: 'to this workspace' | 'across workspaces'): Promise<number> {
  const opened = await enterSpace(spaceName);
  expect(opened?.success, `switch space "${spaceName}" failed: ${opened?.error}`).toBe(true);
  await app.getWindow('spaces/home.html', 15000);

  const pinResult = await runCommand(`pin ${scope}`);
  expect(pinResult?.error, `pin ${scope} failed: ${pinResult?.error}`).toBeUndefined();
  expect(pinResult?.success).toBe(true);
  return pinResult.windowId as number;
}

test.describe('pin session restore: both scopes @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('pin-session-restore'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a workspace-scoped pin is written into that workspace\'s saved snapshot', async () => {
    const spaceName = 'pin-restore-spec-workspace';
    const windowId = await openAndPin(spaceName, 'to this workspace');

    // Resolve the same tag id the row is keyed on, mirroring
    // space-workspace-page-host.spec.ts.
    const spaceId = await bgWindow.evaluate(async (name: string) => {
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(`space:${name}`);
      return (r?.data?.tag?.id ?? null) as string | null;
    }, spaceName);
    expect(spaceId).toBeTruthy();

    const saveResult = await bgWindow.evaluate(
      async (key: string) => await (window as unknown as { app: any }).app.session.saveWorkspaceSnapshot(key),
      spaceId as string,
    );
    expect(saveResult?.success).toBe(true);

    const read = await bgWindow.evaluate(
      async (key: string) =>
        await (window as unknown as { app: any }).app.settings.getExtKey('session', key),
      `snapshot:${spaceId}`,
    );
    expect(read?.success).toBe(true);
    const row = typeof read.data === 'string' ? JSON.parse(read.data) : read.data;
    expect(row?.windows?.length, 'the saved workspace snapshot has no windows').toBeGreaterThan(0);
    expect(
      row.windows.every((w: { context?: { pinScope?: string } }) => w.context?.pinScope === 'workspace'),
      'the pinned window is not recorded as workspace-pinned in its own workspace\'s saved snapshot',
    ).toBe(true);

    // Left open, this window's url still matches every later test's
    // `spaces/home.html` window-count poll — including the third test's
    // wait for its own globally-pinned window to close, which can then never
    // observe a count of zero.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      windowId,
    );
  });

  test('a cross-workspace pin is recorded in the default workspace\'s snapshot even when saved while a named workspace is active', async () => {
    const windowId = await openAndPin('pin-restore-spec-global', 'across workspaces');

    // `switch space` above made a NAMED workspace the active one, so this
    // ambient save writes THAT workspace's row — and refreshes the default
    // row's record of every cross-workspace pin, which is what the read below
    // checks. Quitting while a named workspace is active must not lose a pin.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    const read = await bgWindow.evaluate(
      async () => await (window as unknown as { app: any }).app.settings.getExtKey('session', 'snapshot'),
    );
    expect(read?.success).toBe(true);
    const row = typeof read.data === 'string' ? JSON.parse(read.data) : read.data;
    const entries = (row?.windows ?? []).filter(
      (w: { context?: { pinScope?: string } }) => w.context?.pinScope === 'global',
    );
    expect(entries.length, 'no globally-pinned windows were saved in the default snapshot').toBeGreaterThan(0);

    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      windowId,
    );
  });

  test('restoring the default snapshot reopens a globally-pinned window, pinned', async () => {
    const windowId = await openAndPin('pin-restore-spec-global-restore', 'across workspaces');
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    // Close it so the only way it can be on screen afterward is restore.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      windowId,
    );
    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('spaces/home.html')).length, {
        timeout: 15000,
        message: 'the globally-pinned window never closed — restore would be unfalsifiable',
      })
      .toBe(0);

    // Restore the default snapshot at cold start — a live in-session restore
    // deliberately skips a globally-pinned descriptor (it is assumed already
    // open, since a workspace switch never closes one); only a cold-start
    // restore reopens it, exactly as boot would.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceColdStartRestoreSession()) as any);

    const page = await app.getWindow('spaces/home.html', 15000);
    const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    expect(info?.error).toBeUndefined();

    const pinEntry = await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.getContextEntryForTest('pin', id)) as any,
      info.id as number,
    );
    expect(
      (pinEntry as { value?: string } | null)?.value,
      'the window restored from the default snapshot is not recorded as pinned',
    ).toBe('global');
    await expect(page.locator('.pin-badge')).toHaveAttribute('data-scope', 'global');
  });
});
