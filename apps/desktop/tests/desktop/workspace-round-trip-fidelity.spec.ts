/**
 * Workspace switch round-trip fidelity (requirement 7,
 * specs/workspace-session-snapshot.md): open a page, navigate twice, switch
 * away, switch back — what a workspace switch keeps must be the SAME thing
 * quit/relaunch keeps today, because entering/leaving a workspace and
 * booting/quitting the app now drive the exact same `saveSessionSnapshot` /
 * `restoreSessionSnapshot` pipeline, just keyed differently
 * (`main/session.ts`, `main/session-projection.ts serializeSession`).
 *
 * WHAT THIS DOES NOT ASSERT, AND WHY. The spec that produced this file also
 * named back/forward navigation history and scroll position as things a
 * switch must keep. Neither survives ANY existing restore path today —
 * verified, not assumed:
 *   - `WindowDescriptor` (session-projection.ts) never serializes a
 *     navigation-history entry list; a restored window reopens at its single
 *     saved `url` with a fresh, empty history (`canGoBack()` is false right
 *     after any restore, quit/relaunch included).
 *   - `scrollX`/`scrollY` are captured into a window's `params` bag only for
 *     the closed-window undo-stack (`main.ts`, `session.ts`'s `before-quit`
 *     push) and are never read back to actually scroll a reopened page —
 *     `ipc.ts`'s window-open handler has no code path that consumes them for
 *     ordinary open or session restore.
 * So "the same as quit/relaunch keeps them today" is satisfied by testing
 * what quit/relaunch ACTUALLY keeps: the current URL after navigating (not a
 * back-button stack), bounds, and relative stacking order. Implementing real
 * navigation-history/scroll persistence would be new session-snapshot
 * functionality, not wiring a workspace switch onto the existing pipeline —
 * out of scope here. See handoff.md's Decisions.
 *
 * Run with:
 *   yarn test:grep "workspace round-trip fidelity"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

interface SessionSnapshotRow {
  version?: number;
  workspaceKey?: string;
  windows?: { url?: string; bounds?: { x: number; y: number; width: number; height: number }; zOrder?: number; stackIndex?: number }[];
}

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

test.describe('workspace round-trip fidelity @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('workspace-round-trip-fidelity'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
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

  async function snapshotRow(key: string): Promise<SessionSnapshotRow | null> {
    const read = await bgWindow.evaluate(
      async (k: string) => await (window as unknown as { app: any }).app.settings.getExtKey('session', k),
      `snapshot:${key}`,
    );
    if (!read?.success || !read.data) return null;
    return typeof read.data === 'string' ? JSON.parse(read.data) : read.data;
  }

  test('a page host survives switching away and back: current URL after navigating twice, bounds, and stacking order', async () => {
    const spaceName = 'fidelity-spec-space';
    const spaceId = await bgWindow.evaluate(async (name: string) => {
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(`space:${name}`);
      return (r?.data?.tag?.id ?? null) as string | null;
    }, spaceName);
    expect(spaceId, 'could not mint the space tag that keys the workspace snapshot').toBeTruthy();

    const opened = await runCommand('open space', spaceName);
    expect(opened?.success, `open space "${spaceName}" failed: ${opened?.error}`).toBe(true);

    // A distinctive bounds for the first window, so restore's bounds fidelity
    // is checked against something other than a default size.
    const bounds1 = { x: 40, y: 60, width: 640, height: 480 };
    const url1a = `http://127.0.0.1:${serverPort}/fidelity-a`;
    const opened1 = await bgWindow.evaluate(
      async (arg: { url: string; bounds: typeof bounds1 }) =>
        await (window as unknown as { app: any }).app.window.open(arg.url, { ...arg.bounds }),
      { url: url1a, bounds: bounds1 },
    );
    expect(opened1?.success).toBe(true);
    await bgWindow.evaluate(
      async (arg: { id: number; spaceId: string; spaceName: string }) =>
        await (window as unknown as { app: any }).app.context.setMode('space', {
          windowId: arg.id,
          metadata: { spaceId: arg.spaceId, spaceName: arg.spaceName },
        }),
      { id: opened1.id as number, spaceId: spaceId as string, spaceName },
    );

    const page1 = await app.getWindow('fidelity-a', 15000);

    // Navigate twice — the page's CURRENT state after multiple navigations,
    // not a back-button stack (see the file header), is what must survive.
    const url1b = `http://127.0.0.1:${serverPort}/fidelity-b`;
    await page1.goto(url1b);
    await page1.waitForLoadState('domcontentloaded');
    const url1c = `http://127.0.0.1:${serverPort}/fidelity-c`;
    await page1.goto(url1c);
    await page1.waitForLoadState('domcontentloaded');

    // A second window in the same workspace, opened and left alone, to check
    // relative stacking order survives — window1 focused last must still
    // record a higher `stackIndex` than window2 after the round trip.
    const url2 = `http://127.0.0.1:${serverPort}/fidelity-other`;
    const opened2 = await bgWindow.evaluate(
      async (u: string) => await (window as unknown as { app: any }).app.window.open(u, { width: 400, height: 300 }),
      url2,
    );
    expect(opened2?.success).toBe(true);
    await bgWindow.evaluate(
      async (arg: { id: number; spaceId: string; spaceName: string }) =>
        await (window as unknown as { app: any }).app.context.setMode('space', {
          windowId: arg.id,
          metadata: { spaceId: arg.spaceId, spaceName: arg.spaceName },
        }),
      { id: opened2.id as number, spaceId: spaceId as string, spaceName },
    );
    await app.getWindow('fidelity-other', 15000);

    // window2 was opened LAST — real OS focus/raise is not observable in this
    // headless environment (apps/desktop/CLAUDE.md), so stacking order here
    // is driven by open order (a fresh window is raised to the top of the
    // kernel's order at creation) rather than an explicit focus() call.

    // Switch away — saves this workspace under its own key and closes both
    // windows (docs/design/window-rules.md "Persistent windows").
    const other = await runCommand('open space', 'fidelity-spec-elsewhere');
    expect(other?.success, `open space "elsewhere" failed: ${other?.error}`).toBe(true);

    const savedOnLeave = await snapshotRow(spaceId as string);
    expect(savedOnLeave?.windows?.length, 'the workspace snapshot has no windows after leaving').toBeGreaterThanOrEqual(2);
    const savedW1 = savedOnLeave!.windows!.find((w) => w.url === url1c);
    const savedW2 = savedOnLeave!.windows!.find((w) => w.url === url2);
    expect(savedW1, 'the navigated window is missing from its own workspace snapshot').toBeTruthy();
    expect(savedW2, 'the second window is missing from its own workspace snapshot').toBeTruthy();
    expect(
      (savedW2!.stackIndex ?? savedW2!.zOrder ?? 0) > (savedW1!.stackIndex ?? savedW1!.zOrder ?? 0),
      'the more-recently-opened window is not recorded above the other one in the saved stacking order',
    ).toBe(true);
    expect(savedW1!.bounds).toEqual(expect.objectContaining(bounds1));

    // Both windows must actually be gone — restore is unfalsifiable otherwise.
    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && (p.url().includes('/fidelity-c') || p.url().includes('/fidelity-other'))).length, {
        timeout: 15000,
        message: 'leaving the workspace did not close its windows',
      })
      .toBe(0);

    // Switch back.
    const back = await runCommand('open space', spaceName);
    expect(back?.success, `switching back to "${spaceName}" failed: ${back?.error}`).toBe(true);

    // Current URL: must reopen at the SECOND navigation target, not the
    // original open URL — proves the live-navigated state was captured, not
    // just the window's original address.
    const restoredPage1 = await app.getWindow('fidelity-c', 15000);
    expect(restoredPage1.url()).toBe(url1c);

    const restoredPage2 = await app.getWindow('fidelity-other', 15000);
    expect(restoredPage2.url()).toBe(url2);

    // Bounds fidelity on the live, restored window. `window.app` is only
    // injected into `peek://` tile documents, not arbitrary web content
    // (`tile-preload.cts`), so resolve the restored window by its live URL
    // through the background window's own listing rather than evaluating
    // inside the content page itself.
    const liveWindows = await bgWindow.evaluate(async () => await (window as unknown as { app: any }).app.window.list());
    const liveW1 = liveWindows?.windows?.find((w: { url: string }) => w.url === url1c);
    expect(liveW1, 'the restored window is missing from window.list()').toBeTruthy();
    expect(liveW1?.bounds, 'restored window bounds are missing from window.list()').toEqual(
      expect.objectContaining({ width: bounds1.width, height: bounds1.height }),
    );

    // Round-trip the stacking order once more: leave again (forcing a fresh
    // save of the RESTORED instances, with no further interaction) and
    // confirm the relative order restore reconstructed — window2 still above
    // window1 — matches what was saved before the switch.
    const leaveAgain = await runCommand('open space', 'fidelity-spec-elsewhere-2');
    expect(leaveAgain?.success).toBe(true);

    const savedAfterRoundTrip = await snapshotRow(spaceId as string);
    const rtW1 = savedAfterRoundTrip!.windows!.find((w) => w.url === url1c);
    const rtW2 = savedAfterRoundTrip!.windows!.find((w) => w.url === url2);
    expect(rtW1, 'the round-tripped navigated window is missing from the re-saved snapshot').toBeTruthy();
    expect(rtW2, 'the round-tripped second window is missing from the re-saved snapshot').toBeTruthy();
    expect(
      (rtW2!.stackIndex ?? rtW2!.zOrder ?? 0) > (rtW1!.stackIndex ?? rtW1!.zOrder ?? 0),
      'stacking order did not survive a full save → close → restore → save round trip',
    ).toBe(true);

    // Cleanup — return to the default workspace, closing everything the
    // fidelity spaces opened.
    await runCommand('close space');
  });
});
