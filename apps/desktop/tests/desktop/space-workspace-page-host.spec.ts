/**
 * Space workspaces — a page host in space mode must reach the persisted row.
 *
 * Behavioral cover for the `saveSpaceWorkspaces` hybrid blind spot (fix
 * `cd55a4e4`, §5 step 11 task 9). `saveSpaceWorkspaces` is a SECOND save path,
 * separate from the session snapshot: it writes one `workspace:<spaceId>` row
 * into `feature_settings` under featureId `space-workspaces`, and
 * `features/spaces/background.js openSpace` reopens a space from it. Its
 * liveness guard used to be `BrowserWindow.fromId`-backed, so it dropped every
 * hybrid page-host — a `BaseWindow` — before any decision was made. Since the
 * canvas removal every web page window IS a hybrid page-host, so a saved space
 * workspace held only internal tiles and the user's pages were gone.
 *
 * WHY AN E2E AND NOT (ONLY) A UNIT. `main/session-projection.test.ts` already
 * unit-covers `serializeSpaceWorkspaces` — including the hybrid case — but that
 * test hands the projection a row with `destroyed: false` already resolved. The
 * defect was never IN the pure projection; it was in the read phase feeding it
 * (`session.ts buildSessionSaveWindows`, which resolves a hybrid host through
 * the hybrid registry instead of `getLiveWindow`) and in `saveSpaceWorkspaces`
 * calling it at all. Re-introducing the pre-fix `getLiveWindow`-only liveness
 * guard at that call site leaves every one of the 62 unit tests green and fails
 * this spec. So: read → project → WRITE, end to end, against the real row.
 *
 * DOES NOT SKIP ITSELF. The hybrid suite carries ~134 conditional
 * `test.skip(!(await hybridBridgePresent(app)), …)` calls; if the bridge fails
 * to install, those blocks evaporate and the run still reports green. This spec
 * uses no bridge, and it ASSERTS that the window it opened is a hybrid
 * page-host rather than skipping when it isn't — if page hosts ever stop being
 * BaseWindows, this must fail loudly, because that is precisely the condition
 * the regression needs.
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

interface SpaceWorkspaceRow {
  version?: number;
  spaceId?: string;
  spaceName?: string;
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

  test('a page host opened in space mode is present in the persisted workspace:<tagId> row', async () => {
    // A space's id is a TAG id (features/spaces `openSpace` does
    // `getOrCreateTag` then keys the row on `tag.id`), so mint a real one
    // rather than a synthetic string — the row key under test is literally
    // `workspace:<tagId>`.
    const spaceId = await bgWindow.evaluate(async () => {
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(
        'space-workspace-page-host-spec',
      );
      return (r?.data?.tag?.id ?? null) as string | null;
    });
    expect(spaceId, 'could not mint the space tag that keys the workspace row').toBeTruthy();

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

    // The save path under test. `saveSessionSnapshot` ends by calling
    // `saveSpaceWorkspaces()` (session.ts, "Also save per-space workspace
    // snapshots"), so the existing `forceSaveSession` bridge drives BOTH save
    // paths — no new main-process surface needed for this spec.
    //
    // Deliberately NOT driven through `api.session.saveSpaceWorkspaces()`, the
    // entry point features/spaces + features/groups use. That method used to be
    // missing entirely — `main/tile-preload.cts` assigned `api.session` TWICE
    // and the later trustedBuiltin-only `{save, restoreInteractive,
    // reopenLastClosed}` object clobbered the capability-gated
    // `{saveSpaceWorkspaces}` one. That clobber is fixed (the namespace is now
    // one assignment, gated per method) and the next test asserts the surface;
    // this test keeps driving the main-process save directly, because that is
    // the path the failing-first evidence for the hybrid blind spot covered.
    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as any);

    // Now inspect what was actually PERSISTED: the `workspace:<tagId>` row in
    // `feature_settings` under featureId `space-workspaces`, read back through
    // the foreign-settings surface — the same row, same key, that
    // `openSpace` restores a space from.
    const read = await bgWindow.evaluate(
      async (key: string) =>
        await (window as unknown as { app: any }).app.settings.getExtKey('space-workspaces', key),
      `workspace:${spaceId}`,
    );
    expect(read?.success).toBe(true);

    const rowValue = read.data;
    const row: SpaceWorkspaceRow | null =
      typeof rowValue === 'string' ? JSON.parse(rowValue) : (rowValue ?? null);

    expect(
      row,
      `no workspace:${spaceId} row was written at all — every window in the ` +
        'space was dropped before the write phase (the pre-cd55a4e4 symptom ' +
        'when the space holds only page hosts)',
    ).toBeTruthy();

    const savedUrls = (row!.windows ?? []).map((w) => w.url);
    expect(
      savedUrls,
      'the page host is missing from its own space workspace — saveSpaceWorkspaces ' +
        'dropped a hybrid page-host (BaseWindow) from the persisted row',
    ).toContain(url);

    // The row is a usable restore source, not just a non-empty array.
    const entry = row!.windows!.find((w) => w.url === url)!;
    expect(row!.version).toBe(1);
    expect(row!.spaceId).toBe(spaceId);
    expect(row!.spaceName).toBe('Page Host Space');
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

  test('api.session exposes saveSpaceWorkspaces alongside the trustedBuiltin methods', async () => {
    // `main/tile-preload.cts` assigned `api.session` twice; the second
    // assignment (trustedBuiltin `save` / `restoreInteractive` /
    // `reopenLastClosed`) replaced the first (capability-gated
    // `saveSpaceWorkspaces`) wholesale, so `saveSpaceWorkspaces` existed on no
    // tile at all. Every caller guards with `api.session?.saveSpaceWorkspaces`,
    // so `features/spaces/background.js closeSpace` and `features/groups/home.js`
    // silently no-op'd instead of throwing — the reason this defect survived.
    // The namespace is now assigned once with per-method gating; assert all four
    // are present so a future re-assignment fails here rather than going quiet.
    const shape = await bgWindow.evaluate(() => {
      const session = (window as unknown as { app: any }).app?.session;
      return {
        present: !!session,
        saveSpaceWorkspaces: typeof session?.saveSpaceWorkspaces,
        save: typeof session?.save,
        restoreInteractive: typeof session?.restoreInteractive,
        reopenLastClosed: typeof session?.reopenLastClosed,
      };
    });

    expect(shape.present, 'api.session is missing from window.app entirely').toBe(true);
    expect(
      shape.saveSpaceWorkspaces,
      'api.session.saveSpaceWorkspaces is missing — api.session was assigned ' +
        'twice again and the trustedBuiltin object clobbered the capability-gated one',
    ).toBe('function');
    expect(
      shape.save,
      'api.session.save is missing — the trustedBuiltin session methods were dropped',
    ).toBe('function');
    expect(shape.restoreInteractive).toBe('function');
    expect(shape.reopenLastClosed).toBe('function');
  });
});
