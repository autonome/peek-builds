/**
 * Space workspaces — a page host in space mode must reach its saved snapshot.
 *
 * A workspace is a named session snapshot: leaving one saves the current
 * windows through `main/session.ts saveSessionSnapshot()` under the
 * workspace's own key (`main/session-projection.ts serializeSession`,
 * featureId `session`, row `snapshot:<workspaceKey>`), and entering one
 * restores it through the SAME `restoreSessionSnapshot()` the app's own
 * boot/quit restore uses. There is no second, space-specific save path or
 * `space-workspaces` table.
 *
 * WHY AN E2E AND NOT (ONLY) A UNIT. `main/session-projection.test.ts` already
 * unit-covers `serializeSession`'s hybrid handling, but that test hands the
 * projection a row with `destroyed: false` already resolved. The historical
 * defect this spec guards (fix `cd55a4e4`) was never IN the pure projection;
 * it was in the read phase feeding it (`session.ts buildSessionSaveWindows`,
 * which resolves a hybrid host through the hybrid registry instead of
 * `getLiveWindow`). So: read → project → WRITE, end to end, against the real
 * row.
 *
 * DOES NOT SKIP ITSELF. The hybrid suite carries ~134 conditional
 * `test.skip(!(await hybridBridgePresent(app)), …)` calls; if the bridge fails
 * to install, those blocks evaporate and the run still reports green. This
 * spec uses no bridge, and it ASSERTS that the window it opened is a hybrid
 * page-host rather than skipping when it isn't — if page hosts ever stop
 * being BaseWindows, this must fail loudly, because that is precisely the
 * condition the regression needs.
 *
 * Network-free: content is served by a local loopback server.
 * Focus-free: hybrid hosts are headless (opacity 0, never shown).
 *
 * Run with:
 *   yarn test:grep "space workspaces"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

interface SessionSnapshotRow {
  version?: number;
  workspaceKey?: string;
  windows?: { url?: string; bounds?: unknown; zOrder?: number; focused?: boolean }[];
}

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('space workspaces persist page hosts @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('space-workspace-page-host'));

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

  test('a page host opened in space mode is present in its workspace\'s saved snapshot', async () => {
    // A space's id is a TAG id (features/spaces `openSpace` does
    // `getOrCreateTag` then keys the snapshot on `tag.id`), so mint a real
    // one rather than a synthetic string — the row key under test is
    // literally `snapshot:<tagId>`.
    const spaceId = await bgWindow.evaluate(async () => {
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(
        'space-workspace-page-host-spec',
      );
      return (r?.data?.tag?.id ?? null) as string | null;
    });
    expect(spaceId, 'could not mint the space tag that keys the workspace snapshot').toBeTruthy();

    // Open a real page host through the production window-open path.
    const url = `http://127.0.0.1:${serverPort}/space-page`;
    const opened = await bgWindow.evaluate(
      async (u: string) =>
        await (window as unknown as { app: any }).app.window.open(u, { width: 800, height: 600 }),
      url,
    );
    expect(opened?.success).toBe(true);
    const windowId = opened.id as number;

    // The window under test MUST be a hybrid page-host (a BaseWindow) — that is
    // the exact shape the pre-fix `getLiveWindow`-only guard dropped. Asserted,
    // never skipped: a page host that stopped being a BaseWindow would silently
    // retire this regression's cover.
    const isHybrid = await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any,
      windowId,
    );
    expect(
      isHybrid,
      'the opened page host is not a hybrid BaseWindow — this spec covers the ' +
        'BaseWindow-drops-out-of-save regression and is meaningless without one',
    ).toBe(true);

    // Wait for the content to actually load, so the presenter reports the page
    // URL (the value that lands in the row) rather than an empty address.
    await app.getWindow('space-page', 15000);

    // Put the page host in space mode — the same `context.setMode('space', …)`
    // write `features/spaces/background.js openSpace` performs per window.
    const ctx = await bgWindow.evaluate(
      async (arg: { id: number; spaceId: string }) =>
        await (window as unknown as { app: any }).app.context.setMode('space', {
          windowId: arg.id,
          metadata: { spaceId: arg.spaceId, spaceName: 'Page Host Space' },
        }),
      { id: windowId, spaceId: spaceId as string },
    );
    expect(ctx?.success).toBe(true);

    // The save path under test — the same keyed save `closeCurrentWorkspaceWindows()`
    // drives on a real workspace switch.
    const saveResult = await bgWindow.evaluate(
      async (key: string) => await (window as unknown as { app: any }).app.session.saveWorkspaceSnapshot(key),
      spaceId as string,
    );
    expect(saveResult?.success).toBe(true);

    // Now inspect what was actually PERSISTED: the `snapshot:<tagId>` row in
    // `feature_settings` under featureId `session`, read back through the
    // foreign-settings surface — the same row, same key, that `openSpace`
    // restores a space from.
    const read = await bgWindow.evaluate(
      async (key: string) =>
        await (window as unknown as { app: any }).app.settings.getExtKey('session', key),
      `snapshot:${spaceId}`,
    );
    expect(read?.success).toBe(true);

    const rowValue = read.data;
    const row: SessionSnapshotRow | null =
      typeof rowValue === 'string' ? JSON.parse(rowValue) : (rowValue ?? null);

    expect(
      row,
      `no snapshot:${spaceId} row was written at all — every window in the ` +
        'space was dropped before the write phase (the pre-cd55a4e4 symptom ' +
        'when the space holds only page hosts)',
    ).toBeTruthy();

    const savedUrls = (row!.windows ?? []).map((w) => w.url);
    expect(
      savedUrls,
      'the page host is missing from its own workspace snapshot — the save ' +
        'dropped a hybrid page-host (BaseWindow) from the persisted row',
    ).toContain(url);

    // The row is a usable restore source, not just a non-empty array.
    const entry = row!.windows!.find((w) => w.url === url)!;
    expect(row!.version).toBe(1);
    expect(row!.workspaceKey).toBe(spaceId);
    expect(typeof entry.zOrder).toBe('number');
    expect(entry.bounds).toEqual(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      }),
    );
  });

  test('openSpace reopens the saved windows instead of falling back to the spaces home UI', async () => {
    // The RESTORE half, end to end, through the entry point a user actually
    // hits: the `open space <name>` command handled by
    // `features/spaces/background.js openSpace`, which now restores through
    // the same `restoreSessionSnapshot()` the app's own boot restore uses.
    const spaceName = 'space-restore-spec';
    const spaceId = await bgWindow.evaluate(async (name: string) => {
      // `openSpace` machine-tags the space itself (`toSpaceTagName` →
      // `space:<name>`), so mint the tag under exactly that name — the command
      // below must resolve to THIS tag, and therefore to this row key.
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(
        `space:${name}`,
      );
      return (r?.data?.tag?.id ?? null) as string | null;
    }, spaceName);
    expect(spaceId, 'could not mint the space tag that keys the workspace snapshot').toBeTruthy();

    const url = `http://127.0.0.1:${serverPort}/restore-page`;
    const opened = await bgWindow.evaluate(
      async (u: string) =>
        await (window as unknown as { app: any }).app.window.open(u, { width: 700, height: 500 }),
      url,
    );
    expect(opened?.success).toBe(true);
    const windowId = opened.id as number;

    const isHybrid = await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any,
      windowId,
    );
    expect(
      isHybrid,
      'the opened page host is not a hybrid BaseWindow — this spec restores a ' +
        'page host and is meaningless without one',
    ).toBe(true);

    await app.getWindow('restore-page', 15000);

    const ctx = await bgWindow.evaluate(
      async (arg: { id: number; spaceId: string; spaceName: string }) =>
        await (window as unknown as { app: any }).app.context.setMode('space', {
          windowId: arg.id,
          metadata: { spaceId: arg.spaceId, spaceName: arg.spaceName },
        }),
      { id: windowId, spaceId: spaceId as string, spaceName },
    );
    expect(ctx?.success).toBe(true);

    const saveResult = await bgWindow.evaluate(
      async (key: string) => await (window as unknown as { app: any }).app.session.saveWorkspaceSnapshot(key),
      spaceId as string,
    );
    expect(saveResult?.success).toBe(true);

    // Precondition, asserted: the row this test restores FROM actually exists.
    // Without it a green restore assertion would prove nothing.
    const saved = await bgWindow.evaluate(
      async (key: string) =>
        await (window as unknown as { app: any }).app.settings.getExtKey('session', key),
      `snapshot:${spaceId}`,
    );
    const savedRow: SessionSnapshotRow | null =
      typeof saved?.data === 'string' ? JSON.parse(saved.data) : (saved?.data ?? null);
    expect(
      (savedRow?.windows ?? []).map((w) => w.url),
      `the snapshot:${spaceId} row does not hold the page host — the save half ` +
        'broke, so the restore half cannot be under test here',
    ).toContain(url);

    // Close the page host so a window at this URL after `open space` can only
    // be one that RESTORE reopened.
    await bgWindow.evaluate(
      async (id: number) => await (window as unknown as { app: any }).app.window.close(id),
      windowId,
    );
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('/restore-page')).length, {
        timeout: 10000,
        message: 'the page host never went away after close — restore would be unfalsifiable',
      })
      .toBe(0);

    // Drive the real command the same way the cmd panel does.
    const result = (await bgWindow.evaluate(async (name: string) => {
      const api = (window as unknown as { app: any }).app;
      return await new Promise((resolve) => {
        const resultTopic = 'cmd:execute:open space:result';
        api.subscribe(resultTopic, (r: unknown) => resolve(r));
        api.publish('cmd:execute:open space', {
          search: name,
          params: [],
          expectResult: true,
          resultTopic,
        });
        setTimeout(() => resolve({ error: 'timeout waiting for open space' }), 25000);
      });
    }, spaceName)) as { success?: boolean; spaceId?: string; error?: string };

    expect(result?.error, 'the `open space` command never came back').toBeUndefined();
    expect(result?.success).toBe(true);
    expect(
      result?.spaceId,
      'the command resolved a different space tag than the one the row is keyed on',
    ).toBe(spaceId);

    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('/restore-page')).length, {
        timeout: 20000,
        message:
          'openSpace did not reopen the saved page host — restoreWorkspaceSnapshot ' +
          'never found a snapshot at this workspace\'s key',
      })
      .toBeGreaterThan(0);

    // And it must NOT have taken the `if (!restored)` branch.
    expect(
      app.windows().map((p) => p.url()).filter((u) => u.includes('spaces/home.html')),
      'openSpace opened the spaces home UI — the no-saved-state fallback fired ' +
        'even though a workspace snapshot exists for this space',
    ).toEqual([]);
  });

  test('api.session exposes saveWorkspaceSnapshot and restoreWorkspaceSnapshot alongside the trustedBuiltin methods', async () => {
    // `main/tile-preload.cts` assigns `api.session` exactly once, with
    // per-method gating (a prior bug reassigned it a second time and the
    // trustedBuiltin object clobbered the capability-gated one — every
    // caller guards with `api.session?.<method>`, so the clobber was
    // silent). Assert all four surfaces are present so a future
    // re-assignment fails here rather than going quiet.
    const shape = await bgWindow.evaluate(() => {
      const session = (window as unknown as { app: any }).app?.session;
      return {
        present: !!session,
        saveWorkspaceSnapshot: typeof session?.saveWorkspaceSnapshot,
        restoreWorkspaceSnapshot: typeof session?.restoreWorkspaceSnapshot,
        save: typeof session?.save,
        restoreInteractive: typeof session?.restoreInteractive,
        reopenLastClosed: typeof session?.reopenLastClosed,
      };
    });

    expect(shape.present, 'api.session is missing from window.app entirely').toBe(true);
    expect(
      shape.saveWorkspaceSnapshot,
      'api.session.saveWorkspaceSnapshot is missing — api.session was assigned ' +
        'twice again and the trustedBuiltin object clobbered the capability-gated one',
    ).toBe('function');
    expect(shape.restoreWorkspaceSnapshot).toBe('function');
    expect(
      shape.save,
      'api.session.save is missing — the trustedBuiltin session methods were dropped',
    ).toBe('function');
    expect(shape.restoreInteractive).toBe('function');
    expect(shape.reopenLastClosed).toBe('function');
  });
});
