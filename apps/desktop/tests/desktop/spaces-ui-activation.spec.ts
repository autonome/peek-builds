/**
 * Spaces UI activation — the paths a user actually takes to enter a
 * workspace, beyond the bare `open space` command the other workspace specs
 * drive (specs/spaces-workspace-switch-regressions.md).
 *
 * 1. `open spaces` (the browse-all command) shows the default workspace on
 *    first open. That command is a declarative `window` action, which the
 *    lazy-dispatch hook (`main/tile-lazy.ts handleCommandDispatch`) turns into
 *    a `window:reopen-request` and never delivers as `cmd:execute:*`, so it
 *    cannot wake the feature's lazy background tile — the one that creates the
 *    `space:default` tag (`background.js bootstrapDefaultSpace()`). The Spaces
 *    UI asks for it instead (`home.js` publishes a `lazyEvents` wake topic).
 * 2. Clicking, or pressing Enter on, a space card activates that space — the
 *    same effect as `switch space <name>` — not just a browse of its items.
 * 3. `switch space <name>` keeps working on the second and third invocation.
 *
 * Run with:
 *   yarn test:grep "spaces ui activation"
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

/** Window ids whose mode context puts them in the given space. */
async function windowsInSpace(tagId: string): Promise<number[]> {
  const r = await bgWindow.evaluate(
    async (id: string) => await (window as unknown as { app: any }).app.context.getWindowsInSpace(id),
    tagId,
  );
  return (r?.data ?? []) as number[];
}

test.describe('spaces ui activation @desktop', () => {
  let browsePage: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('spaces-ui-activation'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('the default workspace is listed on the first `open spaces`, before any switch', async () => {
    // Nothing has woken the spaces background tile yet in this fresh
    // profile: no `space:default` tag exists until it runs. Drive the
    // browse-all command the way the palette does.
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('open spaces');
    });
    browsePage = await app.getWindow('spaces/home.html', 15000);
    await browsePage.waitForLoadState('domcontentloaded');

    await expect(
      browsePage.locator('peek-card.space-card .card-title', { hasText: /^default$/ }),
      'the Spaces UI opened without the default workspace — the background tile that creates it was never woken',
    ).toHaveCount(1, { timeout: 15000 });
  });

  test('clicking a space card activates that space, not just its item list', async () => {
    const name = 'ui-click-space';
    const tagId = await spaceTagId(name);
    const card = browsePage.locator(`peek-card.space-card[data-tag-id="${tagId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15000 });

    await card.click();

    // Activation is observable two ways: the workspace panel names the space,
    // and a window now carries that space's mode.
    const panelPage = await app.getWindow('spaces/panel.html', 15000);
    await expect(panelPage.locator('#panel-name'), 'the panel never named the clicked space').toHaveText(name, {
      timeout: 15000,
    });
    await expect.poll(async () => (await windowsInSpace(tagId)).length, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test('pressing Enter on a selected space card activates that space too', async () => {
    const name = 'ui-enter-space';
    const tagId = await spaceTagId(name);

    // Back to the spaces list (the click above browsed into the item list).
    await browsePage.evaluate(() => (window as unknown as { showSpaces: () => Promise<void> }).showSpaces());
    const card = browsePage.locator(`peek-card.space-card[data-tag-id="${tagId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15000 });

    // Select the card the way the keyboard path does (`grid-nav.js
    // updateSelection` reads `state.selectedIndex`), then press Enter.
    const index = await browsePage.evaluate((id: string) => {
      const cards = Array.from(document.querySelectorAll('peek-card.space-card'));
      const i = cards.findIndex((c) => (c as HTMLElement).dataset.tagId === id);
      (window as unknown as { _spacesState: { selectedIndex: number } })._spacesState.selectedIndex = i;
      return i;
    }, tagId);
    expect(index).toBeGreaterThanOrEqual(0);
    await browsePage.locator('body').press('Enter');

    const panelPage = await app.getWindow('spaces/panel.html', 15000);
    await expect(panelPage.locator('#panel-name'), 'Enter never activated the selected space').toHaveText(name, {
      timeout: 15000,
    });
    await expect.poll(async () => (await windowsInSpace(tagId)).length, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test('`switch space` works on the second and third invocation, not just the first', async () => {
    const alpha = 'ui-switch-alpha';
    const beta = 'ui-switch-beta';
    const alphaId = await spaceTagId(alpha);
    const betaId = await spaceTagId(beta);

    const switchTo = async (name: string, tagId: string, previousId: string | null, nth: string) => {
      const result = await runCommand('switch space', name);
      expect(result?.success, `${nth} switch space "${name}" failed: ${result?.error}`).toBe(true);
      await expect
        .poll(async () => (await windowsInSpace(tagId)).length, {
          timeout: 15000,
          message: `${nth} switch: no window entered space "${name}"`,
        })
        .toBeGreaterThan(0);
      if (previousId) {
        await expect
          .poll(async () => (await windowsInSpace(previousId)).length, {
            timeout: 15000,
            message: `${nth} switch: the previous space's windows were not closed`,
          })
          .toBe(0);
      }
      const panelPage = await app.getWindow('spaces/panel.html', 15000);
      await expect(panelPage.locator('#panel-name')).toHaveText(name, { timeout: 15000 });
    };

    await switchTo(alpha, alphaId, null, 'first');
    await switchTo(beta, betaId, alphaId, 'second');
    await switchTo(alpha, alphaId, betaId, 'third');

    await runCommand('close space');
  });
});
