/**
 * Deleting a space moves its windows to the default space.
 *
 * `features/spaces/background.js deleteSpace()` merges the deleted space's
 * saved window row into the default's, then deletes the space's tag. When the
 * deleted space is the active one, its windows are saved and closed first and
 * the default space is entered, so they reopen there. The default space
 * itself cannot be deleted.
 *
 * Deletion is driven the way a person does it: the delete button on a space
 * card in the spaces page, with the page's `confirm()` answered yes (stubbed —
 * a real one is a native dialog). The page then sends `delete space` with
 * `confirmed: true`.
 *
 * Run with:
 *   yarn test:grep "spaces delete"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

let app: DesktopApp;
let bgWindow: Page;

async function runCommand(name: string, search = '', extra: Record<string, unknown> = {}): Promise<any> {
  return bgWindow.evaluate(
    async (arg: { name: string; search: string; extra: Record<string, unknown> }) => {
      const api = (window as unknown as { app: any }).app;
      return await new Promise((resolve) => {
        const resultTopic = `cmd:execute:${arg.name}:result:${Date.now()}:${Math.random()}`;
        api.subscribe(resultTopic, (r: unknown) => resolve(r));
        api.publish(`cmd:execute:${arg.name}`, {
          search: arg.search,
          params: arg.search ? [arg.search] : [],
          expectResult: true,
          resultTopic,
          ...arg.extra,
        });
        setTimeout(() => resolve({ error: `timeout waiting for ${arg.name}` }), 20000);
      });
    },
    { name, search, extra },
  );
}

// `switch space` never creates its target, so entering a space goes through
// `create space` first.
async function enterSpace(name: string): Promise<any> {
  await runCommand('create space', name);
  return runCommand('switch space', name);
}

async function spaceTagNames(): Promise<string[]> {
  const r = await bgWindow.evaluate(
    async () => await (window as unknown as { app: any }).app.datastore.getTagsByFrecency(),
  );
  return ((r?.data ?? []) as { name?: string }[]).map((t) => String(t?.name ?? ''));
}

function readRow(key: string): Promise<string[] | null> {
  return app.evaluateMain!(
    ((_e: unknown, k: string) => (globalThis as any).__peek_test.getWorkspaceSnapshotUrlsForTest(k)) as any,
    key,
  ) as Promise<string[] | null>;
}

// The saved-window count in the delete confirmation skips the spaces
// feature's own pages, so a space needs a real page for there to be a window
// to move. Opened the way the command palette does.
async function openPage(url: string): Promise<void> {
  const r = await bgWindow.evaluate(
    async (u: string) =>
      await (window as unknown as { app: any }).app.window.open(u, {
        role: 'content',
        width: 800,
        height: 600,
        trackingSource: 'cmd',
        trackingSourceId: 'url-direct',
      }),
    url,
  );
  expect(r?.success, `opening ${url} failed: ${JSON.stringify(r)}`).toBe(true);
}

function holdsUrl(urls: string[] | null, fragment: string): boolean {
  return (urls ?? []).some((u) => u.includes(fragment));
}

function holdsSpaceHome(urls: string[] | null, spaceId: string): boolean {
  return (urls ?? []).some((u) => u.includes('spaces/home.html') && u.includes(encodeURIComponent(spaceId)));
}

function spaceHomeWindows(spaceId: string): Page[] {
  return app
    .windows()
    .filter((p) => !p.isClosed() && p.url().includes('spaces/home.html') && p.url().includes(encodeURIComponent(spaceId)));
}

/**
 * Click the delete button on a space's card in `page`, answering the
 * confirmation yes. Returns the question the page asked.
 */
async function deleteFromCard(page: Page, tagId: string): Promise<string | null> {
  const button = page.locator(`peek-card.space-card[data-tag-id="${tagId}"] .space-delete-btn`);
  await expect(button, 'the space card has no delete button').toHaveCount(1, { timeout: 15000 });
  await page.evaluate(() => {
    (window as any).__lastConfirm = null;
    (window as any).confirm = (msg: string) => {
      (window as any).__lastConfirm = msg;
      return true;
    };
  });
  await button.click();
  return (await page.evaluate(() => (window as any).__lastConfirm)) as string | null;
}

test.describe('spaces delete @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('spaces-delete'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('deleting a space that is not active moves its saved windows to the default space and removes it', async () => {
    const doomed = 'delete-spec-inactive';
    const entered = await enterSpace(doomed);
    expect(entered?.success, `switch space "${doomed}" failed: ${entered?.error}`).toBe(true);
    const doomedId = entered.spaceId as string;
    await expect.poll(() => spaceHomeWindows(doomedId).length, { timeout: 15000 }).toBe(1);
    const realPage = 'https://example.com/delete-spec-inactive-page';
    await openPage(realPage);

    // Leaving for another space saves the doomed space's windows into its row.
    const other = await enterSpace('delete-spec-other');
    expect(other?.success, `switch space failed: ${other?.error}`).toBe(true);
    const otherId = other.spaceId as string;
    await expect.poll(() => spaceHomeWindows(doomedId).length, { timeout: 15000 }).toBe(0);
    expect(holdsSpaceHome(await readRow(doomedId), doomedId), "the space's row never held its window").toBe(true);
    expect(holdsUrl(await readRow(doomedId), realPage), "the space's row never held its real page").toBe(true);
    expect(holdsSpaceHome(await readRow('default'), doomedId)).toBe(false);
    expect(holdsUrl(await readRow('default'), realPage)).toBe(false);

    await expect.poll(() => spaceHomeWindows(otherId).length, { timeout: 15000 }).toBe(1);
    const spacesPage = spaceHomeWindows(otherId)[0];
    const question = await deleteFromCard(spacesPage, doomedId);
    expect(question).toContain(`Delete space "${doomed}"?`);
    // The real page is the one window that moves; the space's own page is
    // spaces chrome and never counts (`SPACES_CHROME_URL_PREFIXES`).
    expect(question).toContain('1 window');
    expect(question).toContain('default space');

    await expect
      .poll(async () => (await spaceTagNames()).includes(`space:${doomed}`), {
        timeout: 15000,
        message: "the deleted space's tag is still there",
      })
      .toBe(false);
    expect(holdsSpaceHome(await readRow('default'), doomedId), "the deleted space's window did not move to the default's row").toBe(true);
    expect(holdsUrl(await readRow('default'), realPage), "the deleted space's real page did not move to the default's row").toBe(true);
    expect(await readRow(doomedId), "the deleted space's own row is still there").toBeNull();

    // A space that was not active: nothing on screen changes.
    const activeKey = await app.evaluateMain!((() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any);
    expect(activeKey).toBe(otherId);
    expect(spaceHomeWindows(otherId).length).toBe(1);
  });

  test('deleting the active space reopens its windows in the default space', async () => {
    const doomed = 'delete-spec-active';
    const entered = await enterSpace(doomed);
    expect(entered?.success, `switch space "${doomed}" failed: ${entered?.error}`).toBe(true);
    const doomedId = entered.spaceId as string;
    await expect.poll(() => spaceHomeWindows(doomedId).length, { timeout: 15000 }).toBe(1);

    // The space's own page lists every space, itself included.
    const question = await deleteFromCard(spaceHomeWindows(doomedId)[0], doomedId);
    expect(question).toContain(`Delete space "${doomed}"?`);

    await expect
      .poll(async () => (await spaceTagNames()).includes(`space:${doomed}`), {
        timeout: 15000,
        message: "the deleted space's tag is still there",
      })
      .toBe(false);
    await expect
      .poll(() => app.evaluateMain!((() => (globalThis as any).__peek_test.getActiveWorkspaceKeyForTest()) as any), {
        timeout: 15000,
        message: 'the default space did not become active',
      })
      .toBe('default');

    // The window reopens from the merged row, now in the default space.
    await expect
      .poll(() => spaceHomeWindows(doomedId).length, {
        timeout: 15000,
        message: "the deleted space's window did not reopen in the default space",
      })
      .toBe(1);
    const info = await spaceHomeWindows(doomedId)[0].evaluate(() =>
      (window as unknown as { app: any }).app.window.getInfo(),
    );
    await expect
      .poll(
        async () => {
          const mode = await bgWindow.evaluate(
            async (id: number) => await (window as unknown as { app: any }).app.context.get('mode', id),
            info.id as number,
          );
          return (mode as { data?: { metadata?: { spaceName?: string } } })?.data?.metadata?.spaceName ?? null;
        },
        { timeout: 15000, message: 'the reopened window is not in the default space' },
      )
      .toBe('default');
    expect(await readRow(doomedId), "the deleted space's own row is still there").toBeNull();
  });

  test('the default space cannot be deleted', async () => {
    const defaultId = (await bgWindow.evaluate(async () => {
      const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag('space:default');
      return r?.data?.tag?.id ?? null;
    })) as string | null;
    expect(defaultId).toBeTruthy();

    const result = await runCommand('delete space', 'default', { confirmed: true });
    expect(result?.success, 'deleting the default space was not refused').toBe(false);
    expect(result?.error).toBeTruthy();
    expect(await spaceTagNames()).toContain('space:default');

    // Its card offers no delete button.
    const page = app.windows().find((p) => !p.isClosed() && p.url().includes('spaces/home.html'));
    expect(page, 'no spaces page is open to check the default card on').toBeTruthy();
    const defaultCard = page!.locator(`peek-card.space-card[data-tag-id="${defaultId}"]`);
    await expect(defaultCard).toHaveCount(1, { timeout: 15000 });
    await expect(defaultCard.locator('.space-delete-btn')).toHaveCount(0);
  });
});
