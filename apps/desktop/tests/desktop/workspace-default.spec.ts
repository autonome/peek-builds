/**
 * The default workspace — what is open when no other workspace is active.
 *
 * Covers handoff.md's Goal for Next Step 1: the default is a real space (a
 * `space:default` tag plus its own saved window session, the same mechanism
 * every named workspace uses — see `features/spaces/DESIGN.md` "The Default
 * Workspace"), entering a workspace saves and closes whatever is active now
 * (the default included), leaving reopens the default's saved session, and a
 * window pinned across every workspace survives both directions.
 *
 * Run with:
 *   yarn test:grep "default workspace"
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

test.describe('default workspace: enter/exit rules @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('workspace-default'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('the default workspace is a real space:default tag', async () => {
    const tagResult = await bgWindow.evaluate(async () => {
      const api = (window as unknown as { app: any }).app;
      return await api.datastore.getOrCreateTag('space:default');
    });
    expect(tagResult?.success).toBe(true);
    expect(tagResult?.data?.tag?.id).toBeTruthy();
    expect(tagResult?.data?.tag?.name).toBe('space:default');
  });

  test('entering a workspace closes the default\'s windows and opens exactly one empty group', async () => {
    // Put a window into the default workspace directly, the same
    // `context.setMode('space', …)` write `enterWorkspace()` performs per
    // window — mirrors space-workspace-page-host.spec.ts's pattern for
    // getting a window into a specific space without depending on
    // first-launch adoption timing.
    const defaultTagId = (await bgWindow.evaluate(async () => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.datastore.getOrCreateTag('space:default');
      return r?.data?.tag?.id ?? null;
    })) as string | null;
    expect(defaultTagId).toBeTruthy();

    const opened = await bgWindow.evaluate(async () => {
      const api = (window as unknown as { app: any }).app;
      return await api.window.open('peek://spaces/home.html?adopted=1', { width: 400, height: 300 });
    });
    expect(opened?.success).toBe(true);
    const defaultWindowId = opened.id as number;

    const ctx = await bgWindow.evaluate(
      async (arg: { id: number; spaceId: string }) =>
        await (window as unknown as { app: any }).app.context.setMode('space', {
          windowId: arg.id,
          metadata: { spaceId: arg.spaceId, spaceName: 'default' },
        }),
      { id: defaultWindowId, spaceId: defaultTagId as string },
    );
    expect(ctx?.success).toBe(true);

    // Entering a named workspace must save-and-close the default's window
    // above, and open exactly one new (empty) window for the target.
    const openResult = await enterSpace('default-spec-enter');
    expect(openResult?.success, `switch space failed: ${openResult?.error}`).toBe(true);

    const stillOpen = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.window.exists(id);
      return r?.exists;
    }, defaultWindowId);
    expect(stillOpen, 'entering a workspace did not close the default workspace\'s window').toBe(false);

    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('spaces/home.html')).length, {
        timeout: 15000,
        message: 'a new workspace did not open exactly one empty group',
      })
      .toBe(1);
  });

  test('leaving reopens the default workspace\'s saved session', async () => {
    // The previous test's "switch space" saved the default's window into its
    // own workspace row as a side effect of closing it — leaving the
    // workspace opened above must restore that same window from that row.
    const closeResult = await runCommand('close space');
    expect(closeResult?.success, `close space failed: ${closeResult?.error}`).toBe(true);

    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('adopted=1')).length, {
        timeout: 15000,
        message: 'leaving did not reopen the default workspace\'s saved window',
      })
      .toBe(1);
    const page = app.windows().find((p) => !p.isClosed() && p.url().includes('adopted=1'))!;
    const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    expect(info?.error).toBeUndefined();

    const modeEntry = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      return await api.context.get('mode', id);
    }, info.id as number);
    expect(
      (modeEntry as { data?: { metadata?: { spaceName?: string } } })?.data?.metadata?.spaceName,
      'the window restored on leaving is not back in the default workspace',
    ).toBe('default');

    // Leaving again while already in the default is an error — nothing to
    // leave, the same as before a default workspace existed at all.
    const secondClose = await runCommand('close space');
    expect(secondClose?.success).toBe(false);

    // Close the restored window — left open, its URL still matches the next
    // test's `spaces/home.html` lookup, which could then grab this stale
    // window instead of the one it opens itself.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      info.id as number,
    );
  });

  test('a window pinned across every workspace survives both entering and leaving', async () => {
    const openResult = await enterSpace('default-spec-global-pin');
    expect(openResult?.success, `switch space failed: ${openResult?.error}`).toBe(true);
    const homePage = await app.getWindow('spaces/home.html', 15000);
    const homeInfo = await homePage.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    await bgWindow.evaluate(async (id: number) => {
      await (window as unknown as { app: any }).app.window.focus(id);
    }, homeInfo.id as number);
    await new Promise((r) => setTimeout(r, 200));

    const pinResult = await runCommand('pin across workspaces');
    expect(pinResult?.success, `pin across workspaces failed: ${pinResult?.error}`).toBe(true);
    const globalWindowId = pinResult.windowId as number;

    // Entering a different workspace must not sweep the globally-pinned
    // window, even though it goes through the new save-and-close-current
    // step every "switch space" now performs.
    const secondOpen = await enterSpace('default-spec-global-pin-2');
    expect(secondOpen?.success, `switch space failed: ${secondOpen?.error}`).toBe(true);
    let stillOpen = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.window.exists(id);
      return r?.exists;
    }, globalWindowId);
    expect(stillOpen, 'entering a workspace closed a window pinned across every workspace').toBe(true);

    // Leaving to the default must not sweep it either.
    const closeResult = await runCommand('close space');
    expect(closeResult?.success, `close space failed: ${closeResult?.error}`).toBe(true);
    stillOpen = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.window.exists(id);
      return r?.exists;
    }, globalWindowId);
    expect(stillOpen, 'leaving to the default workspace closed a window pinned across every workspace').toBe(true);

    // Clean up.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      globalWindowId,
    );
  });
});
