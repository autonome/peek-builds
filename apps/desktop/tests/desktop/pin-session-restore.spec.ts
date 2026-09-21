/**
 * Pin mechanism — pin state survives session save/restore, both scopes.
 *
 * A workspace-scoped pin is a field on the window's entry within its own
 * workspace's saved session (`main/session.ts saveSpaceWorkspaces` /
 * `serializeSpaceWorkspaces`'s `pinned` field); a cross-workspace pin is in
 * session state that is not scoped to one workspace
 * (`saveGlobalPinnedWindows` / `restoreGlobalPinnedWindows`, featureId
 * `window-pins`), restored regardless of which workspace is active. See
 * docs/design/window-rules.md "Persistent windows: workspace-pinned and
 * global HUD", "Workspace interaction".
 *
 * Drives the SAME `forceSaveSession()` bridge the existing
 * space-workspace-page-host.spec.ts uses (it calls saveSpaceWorkspaces() and,
 * after this change, saveGlobalPinnedWindows() too — no new save-side test
 * surface needed) plus a dedicated `forceRestoreGlobalPins()` /
 * `getGlobalPinsForTest()` bridge for the boot-only global-pin restore path.
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

async function openAndPin(spaceName: string, scope: 'to this workspace' | 'across workspaces'): Promise<number> {
  const opened = await runCommand('open space', spaceName);
  expect(opened?.success, `open space "${spaceName}" failed: ${opened?.error}`).toBe(true);
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

  test('a workspace-scoped pin is written into that workspace\'s saved row', async () => {
    const spaceName = 'pin-restore-spec-workspace';
    await openAndPin(spaceName, 'to this workspace');

    // Resolve the same tag id the row is keyed on, mirroring
    // space-workspace-page-host.spec.ts.
    const spaceId = await bgWindow.evaluate(async (name: string) => {
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(`space:${name}`);
      return (r?.data?.tag?.id ?? null) as string | null;
    }, spaceName);
    expect(spaceId).toBeTruthy();

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    const read = await bgWindow.evaluate(
      async (key: string) =>
        await (window as unknown as { app: any }).app.settings.getExtKey('space-workspaces', key),
      `workspace:${spaceId}`,
    );
    expect(read?.success).toBe(true);
    const row = typeof read.data === 'string' ? JSON.parse(read.data) : read.data;
    expect(row?.windows?.length, 'the saved workspace row has no windows').toBeGreaterThan(0);
    expect(
      row.windows.every((w: { pinned?: boolean }) => w.pinned === true),
      'the pinned window is not recorded as pinned in its own workspace\'s saved row',
    ).toBe(true);
  });

  test('a cross-workspace pin is written into the not-workspace-scoped pin list', async () => {
    const windowId = await openAndPin('pin-restore-spec-global', 'across workspaces');

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    const entries = (await app.evaluateMain!(
      (() => (globalThis as any).__peek_test.getGlobalPinsForTest()) as any,
    )) as { url: string }[];
    expect(Array.isArray(entries), 'the global pin list did not persist').toBe(true);
    expect(entries.length, 'no globally-pinned windows were saved').toBeGreaterThan(0);

    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      windowId,
    );
  });

  test('restoring the global pin list reopens a globally-pinned window, pinned', async () => {
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

    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceRestoreGlobalPins()) as any);

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
      'the window restored from the global pin list is not recorded as pinned',
    ).toBe('global');
    await expect(page.locator('.pin-badge')).toHaveAttribute('data-scope', 'global');
  });
});
