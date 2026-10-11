/**
 * Web addresses dropped on the Spaces page (a tab dragged out of a browser, a
 * link, an address-bar icon) open as pages in the space under the cursor.
 * The active space takes them as ordinary windows; any other space gets them
 * written into its saved windows without leaving anything open.
 *
 * Run with:
 *   yarn test:grep "dropped web addresses"
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
          params: [arg.search],
          expectResult: true,
          resultTopic,
        });
        setTimeout(() => resolve({ error: `timeout waiting for ${arg.name}` }), 20000);
      });
    },
    { name, search },
  );
}

async function spaceTagId(name: string): Promise<string> {
  const id = await bgWindow.evaluate(async (tagName: string) => {
    const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(tagName);
    return (r?.data?.tag?.id ?? null) as string | null;
  }, `space:${name}`);
  expect(id, `could not resolve the tag for space "${name}"`).toBeTruthy();
  return id as string;
}

async function windowsInSpace(tagId: string): Promise<number[]> {
  const r = await bgWindow.evaluate(
    async (id: string) => await (window as unknown as { app: any }).app.context.getWindowsInSpace(id),
    tagId,
  );
  return (r?.data ?? []) as number[];
}

/** Urls of every live window the main process knows about. */
async function liveWindowUrls(): Promise<string[]> {
  const r = await bgWindow.evaluate(async () => await (window as unknown as { app: any }).app.window.list());
  return ((r?.windows ?? []) as Array<{ url?: string }>).map((w) => w.url ?? '');
}

async function savedWindowCount(tagId: string): Promise<number | null> {
  const r = await bgWindow.evaluate(
    async (id: string) =>
      await (window as unknown as { app: any }).app.session.getWorkspaceSnapshotWindowCount(id),
    tagId,
  );
  return typeof r?.count === 'number' ? r.count : null;
}

function browseAllPages(): Page[] {
  return app
    .windows()
    .filter((p) => !p.isClosed() && p.url().includes('spaces/home.html') && !p.url().includes('spaceId='));
}

async function openBrowseAll(): Promise<Page> {
  const before = new Set(browseAllPages());
  await app.evaluateMain!((_e: unknown) => {
    (globalThis as any).__peek_test.publishCmdExecute('open spaces');
  });
  let page: Page | undefined;
  await expect
    .poll(() => {
      page = browseAllPages().find((p) => !before.has(p));
      return !!page;
    }, { timeout: 15000, message: 'the browse-all Spaces page never opened' })
    .toBe(true);
  await page!.waitForLoadState('domcontentloaded');
  return page!;
}

/** Drop a uri-list on the space's card the way a browser drag delivers it. */
async function dropUrlsOnCard(page: Page, tagId: string, urls: string[]): Promise<void> {
  const card = page.locator(`peek-card.space-card[data-tag-id="${tagId}"]`);
  await expect(card).toHaveCount(1, { timeout: 15000 });
  await card.evaluate((el, list) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/uri-list', list.join('\r\n'));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  }, urls);
}

test.describe('dropped web addresses open in the space under the cursor @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('spaces-drop-urls'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a dragover highlights the card, and a drop on the active space opens each address in it', async () => {
    const alpha = 'drop-alpha';
    const alphaId = await spaceTagId(alpha);
    const opened = await runCommand('open space', alpha);
    expect(opened?.success, `open space "${alpha}" failed: ${opened?.error}`).toBe(true);

    const browsePage = await openBrowseAll();
    const card = browsePage.locator(`peek-card.space-card[data-tag-id="${alphaId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15000 });

    const urls = ['https://example.com/drop-one', 'https://example.com/drop-two'];
    const highlighted = await card.evaluate((el) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/uri-list', 'https://example.com/drop-one');
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
      return el.classList.contains('drop-target');
    });
    expect(highlighted, 'a dragged address did not highlight the card').toBe(true);

    await dropUrlsOnCard(browsePage, alphaId, urls);

    await expect
      .poll(async () => {
        const live = await liveWindowUrls();
        return urls.every((u) => live.some((w) => w.startsWith(u)));
      }, { timeout: 20000, message: 'the dropped addresses did not open as windows' })
      .toBe(true);
    await expect
      .poll(async () => (await windowsInSpace(alphaId)).length, { timeout: 15000 })
      .toBeGreaterThanOrEqual(2);
    await expect(card, 'the highlight stayed after the drop').not.toHaveClass(/drop-target/);
  });

  test('a drop on a space that is not active saves the addresses into it and leaves no window open', async () => {
    // alpha is still active from the test above.
    const beta = 'drop-beta';
    const betaId = await spaceTagId(beta);
    const browsePage = await openBrowseAll();

    const urls = ['https://example.com/drop-beta-one', 'https://example.com/drop-beta-two'];
    await dropUrlsOnCard(browsePage, betaId, urls);

    await expect
      .poll(async () => await savedWindowCount(betaId), {
        timeout: 20000,
        message: 'the dropped addresses were not saved into the inactive space',
      })
      .toBe(2);
    const live = await liveWindowUrls();
    expect(live.some((w) => w.includes('drop-beta-')), 'a dropped page stayed open outside its space').toBe(false);
  });
});
