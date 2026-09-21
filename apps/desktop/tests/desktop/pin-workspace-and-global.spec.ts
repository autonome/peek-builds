/**
 * Pin mechanism — workspace-pinned and global HUD windows.
 *
 * Covers `docs/design/window-rules.md` "Persistent windows: workspace-pinned
 * and global HUD", built per handoff.md Next Step 3: the "pin to this
 * workspace" / "pin across workspaces" / "unpin window" palette commands
 * (`features/spaces/background.js`), the two badges with their unpin control
 * (`renderer/lib/pin-badge.js`, wired into `features/spaces/home.js`), and
 * `closeSpace()` leaving a globally-pinned window alone.
 *
 * Pinning or unpinning an already-open window closes it and reopens it with
 * the new `alwaysOnTop` flag (see `reopenWithPinState` in
 * `features/spaces/background.js`) — layer is set at open time only, and no
 * kernel change is part of this design. Every assertion below re-resolves the
 * pinned window by its NEW native id (from the pin/unpin command's result),
 * not by URL alone: the closed-then-reopened window shares its predecessor's
 * URL, so a plain URL match can race a not-yet-closed old window with the
 * same address.
 *
 * Run with:
 *   yarn test:grep "pin mechanism"
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

/** Resolve the Playwright Page for a specific native window id, not just any
 *  window whose URL happens to match — a closed-then-reopened window shares
 *  its predecessor's URL, so URL-only matching can grab a stale Page. */
async function getWindowById(windowId: number, timeout = 15000): Promise<Page> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const p of app.windows()) {
      if (p.isClosed()) continue;
      try {
        const info = await p.evaluate(() => (window as unknown as { app: any }).app?.window?.getInfo?.());
        if (info && !info.error && info.id === windowId) return p;
      } catch {
        // Page navigating/closing — try the next one.
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No window with id ${windowId} found within ${timeout}ms`);
}

async function openBlankWorkspaceHome(spaceName: string): Promise<number> {
  // openSpace() opens the spaces home UI (role: 'workspace') whenever the
  // space has no saved snapshot — an ordinary content window
  // (window-kernel.ts CONTENT_ROLES includes 'workspace') that stands in
  // here for "a window the user might pin", not the future dedicated
  // workspace panel (handoff.md Next Step 4, out of scope for this run).
  const result = await runCommand('open space', spaceName);
  expect(result?.success, `open space "${spaceName}" failed: ${result?.error}`).toBe(true);
  const homePage = await app.getWindow('spaces/home.html', 15000);
  const info = await homePage.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
  expect(info?.error, `window.getInfo() failed: ${info?.error}`).toBeUndefined();
  const windowId = info.id as number;
  // Explicit focus — opening a window doesn't always settle focus before a
  // command reads getFocusedVisibleWindowId() in a headless test.
  await bgWindow.evaluate(
    async (id: number) => {
      await (window as unknown as { app: any }).app.window.focus(id);
    },
    windowId,
  );
  await new Promise((r) => setTimeout(r, 200));
  return windowId;
}

async function getPinContext(windowId: number): Promise<{ value?: string } | null> {
  const entry = await app.evaluateMain!(
    ((_e: unknown, wid: number) =>
      (globalThis as any).__peek_test.getContextEntryForTest('pin', wid)) as any,
    windowId,
  );
  return entry as { value?: string } | null;
}

test.describe('pin mechanism: workspace-pinned and global HUD @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('pin-workspace-and-global'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('"pin to this workspace" pins the active window and draws the workspace badge', async () => {
    const windowId = await openBlankWorkspaceHome('pin-spec-workspace-badge');

    const result = await runCommand('pin to this workspace');
    expect(result?.error, `pin to this workspace failed: ${result?.error}`).toBeUndefined();
    expect(result?.success).toBe(true);
    expect(result?.scope).toBe('workspace');

    const pinnedId = result.windowId as number;
    expect(pinnedId).not.toBe(windowId); // pin closes and reopens the window

    const pinEntry = await getPinContext(pinnedId);
    expect(pinEntry?.value, 'the reopened window is not recorded as workspace-pinned').toBe('workspace');

    const page = await getWindowById(pinnedId);
    await expect(page.locator('.pin-badge')).toHaveAttribute('data-scope', 'workspace');
    await expect(page.locator('.pin-badge-label')).toHaveText(/this workspace/);
    await expect(page.locator('.pin-badge-unpin')).toBeVisible();

    // Clean up via the badge's own unpin control — also covers it end to end.
    await page.locator('.pin-badge-unpin').click();
    await expect(page.locator('.pin-badge')).toHaveCount(0, { timeout: 15000 });
  });

  test('"pin across workspaces" pins the active window and draws the distinct global badge', async () => {
    await openBlankWorkspaceHome('pin-spec-global-badge');

    const result = await runCommand('pin across workspaces');
    expect(result?.error, `pin across workspaces failed: ${result?.error}`).toBeUndefined();
    expect(result?.success).toBe(true);
    expect(result?.scope).toBe('global');

    const pinnedId = result.windowId as number;
    const pinEntry = await getPinContext(pinnedId);
    expect(pinEntry?.value, 'the reopened window is not recorded as globally pinned').toBe('global');

    const page = await getWindowById(pinnedId);
    await expect(page.locator('.pin-badge')).toHaveAttribute('data-scope', 'global');
    await expect(page.locator('.pin-badge-label')).toHaveText(/every workspace/);

    // The two badges are visually distinct, not just the same badge for
    // both scopes — the workspace-scope wording must NOT be present here.
    await expect(page.locator('.pin-badge-label')).not.toHaveText(/this workspace/);

    await runCommand('unpin window');
    await expect(page.locator('.pin-badge')).toHaveCount(0, { timeout: 15000 });
  });

  test('"unpin window" clears pin state via the palette, independent of the badge control', async () => {
    await openBlankWorkspaceHome('pin-spec-palette-unpin');

    const pinResult = await runCommand('pin to this workspace');
    expect(pinResult?.success).toBe(true);

    const unpinResult = await runCommand('unpin window');
    expect(unpinResult?.error, `unpin failed: ${unpinResult?.error}`).toBeUndefined();
    expect(unpinResult?.success).toBe(true);
    expect(unpinResult?.scope).toBeNull();

    const unpinnedId = unpinResult.windowId as number;
    const pinEntry = await getPinContext(unpinnedId);
    expect(pinEntry?.value ?? null, 'the reopened window still reads as pinned after unpin').toBeNull();

    const page = await getWindowById(unpinnedId);
    await expect(page.locator('.pin-badge')).toHaveCount(0);
  });

  test('a workspace-pinned window closes on workspace switch and reopens pinned on re-entry', async () => {
    const spaceName = 'pin-spec-workspace-switch';
    await openBlankWorkspaceHome(spaceName);
    const pinResult = await runCommand('pin to this workspace');
    expect(pinResult?.success).toBe(true);

    // Leaving the workspace sweeps a workspace-pinned window like any other
    // window in it (docs/design/window-rules.md "Workspace interaction").
    const closeResult = await runCommand('close space');
    expect(closeResult?.success).toBe(true);
    await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url().includes('spaces/home.html')).length, {
        timeout: 15000,
        message: 'the workspace-pinned window is still open after closing its workspace',
      })
      .toBe(0);

    // Re-entering the same workspace restores it — pinned, from the saved
    // workspace row (session.ts serializeSpaceWorkspaces `pinned` field).
    const reopenResult = await runCommand('open space', spaceName);
    expect(reopenResult?.success).toBe(true);
    const page = await app.getWindow('spaces/home.html', 15000);
    const info = await page.evaluate(() => (window as unknown as { app: any }).app.window.getInfo());
    const pinEntry = await getPinContext(info.id as number);
    expect(
      pinEntry?.value,
      'the window restored from the saved workspace row is not recorded as pinned',
    ).toBe('workspace');
    await expect(page.locator('.pin-badge')).toHaveAttribute('data-scope', 'workspace');
  });

  test('a cross-workspace pin survives closing the workspace it was pinned from', async () => {
    const spaceName = 'pin-spec-global-survives-switch';
    await openBlankWorkspaceHome(spaceName);
    const pinResult = await runCommand('pin across workspaces');
    expect(pinResult?.success).toBe(true);
    const globalWindowId = pinResult.windowId as number;

    const closeResult = await runCommand('close space');
    expect(closeResult?.success).toBe(true);

    // Unlike the workspace-scoped case, this window must still be open —
    // closeSpace() leaves a global HUD window alone (features/spaces/
    // background.js closeSpace()).
    const stillOpen = await bgWindow.evaluate(
      async (id: number) => {
        const api = (window as unknown as { app: any }).app;
        const r = await api.window.exists(id);
        return r?.exists;
      },
      globalWindowId,
    );
    expect(stillOpen, 'the globally-pinned window was closed by closeSpace()').toBe(true);

    // Clean up.
    await bgWindow.evaluate(
      async (id: number) => (window as unknown as { app: any }).app.window.close(id),
      globalWindowId,
    );
  });
});
