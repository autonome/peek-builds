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
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;

// How the core opens the command palette (same options
// cmd-enter-runs-suggestion.spec.ts uses).
const PANEL_OPEN_OPTS = {
  modal: true,
  width: 600,
  height: 50,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  center: true,
};

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

    // The browse page above belonged to the default workspace, so activating
    // a space from it swept it along with the rest of the default
    // (docs/design/window-rules.md "Workspace membership"). Open a fresh one
    // — it belongs to the space that is active now and is swept in turn.
    if (browsePage.isClosed()) {
      await app.evaluateMain!((_e: unknown) => {
        (globalThis as any).__peek_test.publishCmdExecute('open spaces');
      });
      await expect
        .poll(
          () =>
            app
              .windows()
              .filter((p) => !p.isClosed() && p.url().includes('spaces/home.html') && !p.url().includes('spaceId='))
              .length,
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);
      browsePage = app
        .windows()
        .filter((p) => !p.isClosed() && p.url().includes('spaces/home.html') && !p.url().includes('spaceId='))[0];
      await browsePage.waitForLoadState('domcontentloaded');
    } else {
      // Back to the spaces list (the click above browsed into the item list).
      await browsePage.evaluate(() => (window as unknown as { showSpaces: () => Promise<void> }).showSpaces());
    }
    const card = browsePage.locator(`peek-card.space-card[data-tag-id="${tagId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15000 });

    // Select the card the way the keyboard path does: `grid-nav.js
    // updateSelection` sets `state.selectedIndex` AND focuses that card, so
    // Enter lands on the card itself. One Enter must mean one activation —
    // the focused card handles it (`peek-card` emits `card-click`) and the
    // document-level grid handler must not activate the selection a second
    // time (a double `switch space` raced two opens of the same space).
    // (Playwright's own `locator.focus()` does not reach the card's inner
    // focusable element behind its shadow root — focus the card the way the
    // page does, through the element's own `focus()`.)
    const index = await browsePage.evaluate(async (id: string) => {
      const cards = Array.from(document.querySelectorAll('peek-card.space-card'));
      const i = cards.findIndex((c) => (c as HTMLElement).dataset.tagId === id);
      (window as unknown as { _spacesState: { selectedIndex: number } })._spacesState.selectedIndex = i;
      await (cards[i] as HTMLElement & { focus: () => Promise<void> }).focus();
      return i;
    }, tagId);
    expect(index).toBeGreaterThanOrEqual(0);
    const focusedTag = await browsePage.evaluate(() => {
      const host = document.activeElement as HTMLElement | null;
      return host?.dataset?.tagId ?? `${host?.tagName ?? 'none'}`;
    });
    expect(focusedTag, 'focusing the card did not move keyboard focus onto it').toBe(tagId);
    await browsePage.keyboard.press('Enter');

    const panelPage = await app.getWindow('spaces/panel.html', 15000);
    await expect(panelPage.locator('#panel-name'), 'Enter never activated the selected space').toHaveText(name, {
      timeout: 15000,
    });
    await expect.poll(async () => (await windowsInSpace(tagId)).length, { timeout: 15000 }).toBeGreaterThan(0);
    // Exactly one activation: a space with no saved session opens one empty
    // group on entry, so a second window here means Enter switched twice.
    await new Promise((r) => setTimeout(r, 750));
    expect(
      (await windowsInSpace(tagId)).length,
      'one Enter activated the space more than once (two concurrent switches, two empty groups)',
    ).toBe(1);
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

  test('`switch space` typed into the command palette works twice in a row', async () => {
    // The path the report came from: the palette, not a bare publish. The
    // palette stays in an "executing" state until the command's result
    // arrives on its result topic and keeps its window alive (hidden)
    // between invocations, so a second run exercises state the bare-publish
    // test above never touches.
    const one = 'ui-palette-one';
    const two = 'ui-palette-two';
    const oneId = await spaceTagId(one);
    const twoId = await spaceTagId(two);

    const runFromPalette = async (name: string) => {
      const openResult = await bgWindow.evaluate(async (opts) => {
        return await (window as unknown as { app: any }).app.window.open('peek://cmd/panel.html', opts);
      }, PANEL_OPEN_OPTS);
      expect(openResult?.success, `palette open failed: ${JSON.stringify(openResult)}`).toBe(true);
      const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
      await cmdWindow.waitForSelector('input', { timeout: 5000 });
      await waitForPanelCommandsLoaded(cmdWindow, 10000);
      await cmdWindow.waitForFunction(
        () => !!(window as any)._cmdState?.commands?.['switch space'],
        undefined,
        { timeout: 10000 },
      );
      await cmdWindow.fill('input', `switch space ${name}`);
      await cmdWindow.waitForFunction(
        () => {
          const s = (window as any)._cmdState;
          return s?.matches?.[s.matchIndex] === 'switch space';
        },
        undefined,
        { timeout: 10000 },
      );
      await cmdWindow.keyboard.press('Enter');
    };

    await runFromPalette(one);
    await expect
      .poll(async () => (await windowsInSpace(oneId)).length, {
        timeout: 15000,
        message: `palette run 1: no window entered space "${one}"`,
      })
      .toBeGreaterThan(0);
    const panelPage = await app.getWindow('spaces/panel.html', 15000);
    await expect(panelPage.locator('#panel-name')).toHaveText(one, { timeout: 15000 });

    // The screen border must settle to ONE window. The pre-fix defect was a
    // self-sustaining loop — a new border every ~100 ms, each dismissing the
    // previous — that also dismissed the palette on its next open; a border
    // count that keeps changing across a short window is that loop.
    const borderCount = () =>
      app.windows().filter((p) => !p.isClosed() && p.url().includes('spaces/border.html')).length;
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(borderCount());
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(
      samples.every((n) => n <= 1),
      `more than one screen border was open at once (samples over 1.5 s: ${samples.join(',')})`,
    ).toBe(true);

    await runFromPalette(two);
    await expect
      .poll(async () => (await windowsInSpace(twoId)).length, {
        timeout: 15000,
        message: `palette run 2: no window entered space "${two}" — the second palette invocation did nothing`,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await windowsInSpace(oneId)).length, { timeout: 15000 })
      .toBe(0);
    await expect(panelPage.locator('#panel-name')).toHaveText(two, { timeout: 15000 });

    await runCommand('close space');
  });
});
