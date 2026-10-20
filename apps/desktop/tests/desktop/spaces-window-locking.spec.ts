/**
 * Workspace membership — every content window opened while a workspace is
 * active belongs to that workspace, whatever route opened it, and is swept
 * when the workspace is left (`docs/design/window-rules.md` "Workspace
 * membership"; `specs/spaces-window-locking-regressions.md`).
 *
 * Before the rule, a window belonged to a workspace only when opened with an
 * explicit `spaceMode` (a click inside the space's own item list) or from an
 * opener that had one. A page from the command palette, or the browse-all
 * Spaces page, carried no membership: it stayed on screen across every
 * switch, and the browse-all page was duplicated on every return to the
 * default. Each test here fails against that behaviour.
 *
 * Run with:
 *   yarn test:grep "workspace membership"
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

// `switch space` never creates its target, so entering a space goes through
// `create space` first. Creating a space that already exists is refused, which
// is harmless here: the switch that follows enters it either way.
async function enterSpace(name: string): Promise<any> {
  await runCommand('create space', name);
  return runCommand('switch space', name);
}

async function publishEvent(topic: string, payload: unknown): Promise<void> {
  await bgWindow.evaluate(
    (arg: { topic: string; payload: unknown }) => {
      (window as unknown as { app: any }).app.pubsub.publish(arg.topic, arg.payload);
    },
    { topic, payload },
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

/** A tag's stored color — what a resolver persisted, not what a window shows. */
async function tagColor(tagName: string): Promise<string | null> {
  return bgWindow.evaluate(async (name: string) => {
    const r = await (window as unknown as { app: any }).app.datastore.getOrCreateTag(name);
    return (r?.data?.tag?.color ?? null) as string | null;
  }, tagName);
}

/** Window ids whose mode context puts them in the given space. */
async function windowsInSpace(tagId: string): Promise<number[]> {
  const r = await bgWindow.evaluate(
    async (id: string) => await (window as unknown as { app: any }).app.context.getWindowsInSpace(id),
    tagId,
  );
  return (r?.data ?? []) as number[];
}

/** Ids of every live window the main process knows about. */
async function liveWindowIds(): Promise<number[]> {
  const r = await bgWindow.evaluate(async () => await (window as unknown as { app: any }).app.window.list());
  return ((r?.windows ?? []) as Array<{ id: number }>).map((w) => w.id);
}

/**
 * Open a page the way the command palette does (`renderer/cmd/panel.js
 * openURL`): `role: 'content'`, no `spaceMode`, nothing that names a
 * workspace. Whether it lands in one is the main process's decision.
 */
async function openPageLikeThePalette(url: string): Promise<number> {
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
  expect(r?.success, `palette-style open of ${url} failed: ${JSON.stringify(r)}`).toBe(true);
  return r.id as number;
}

/** The window's mode metadata color, or null when it carries no mode. */
async function windowModeColor(windowId: number): Promise<string | null> {
  const r = await bgWindow.evaluate(
    async (id: number) => await (window as unknown as { app: any }).app.context.get('mode', id),
    windowId,
  );
  return (r?.data?.metadata?.color ?? null) as string | null;
}

/** Browse-all Spaces pages: `home.html` opened without a space in its URL. */
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

test.describe('workspace membership: every window opened in a workspace belongs to it @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('spaces-window-locking'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('a page opened the command palette way belongs to the active workspace and is swept on switch', async () => {
    const alpha = 'lock-alpha';
    const beta = 'lock-beta';
    const alphaId = await spaceTagId(alpha);
    const betaId = await spaceTagId(beta);

    const openResult = await enterSpace(alpha);
    expect(openResult?.success, `switch space "${alpha}" failed: ${openResult?.error}`).toBe(true);
    const borderPage = await app.getWindow('spaces/border.html', 15000);
    await expect(borderPage.locator('#label')).toHaveText(alpha, { timeout: 15000 });

    const pageId = await openPageLikeThePalette('https://example.com/lock-palette-opened-in-alpha');
    await expect
      .poll(async () => (await windowsInSpace(alphaId)).includes(pageId), {
        timeout: 15000,
        message: 'a page opened from the palette while alpha was active does not belong to alpha',
      })
      .toBe(true);

    const switchResult = await runCommand('switch space', beta);
    expect(switchResult?.success, `switch space "${beta}" failed: ${switchResult?.error}`).toBe(true);
    await expect
      .poll(async () => (await liveWindowIds()).includes(pageId), {
        timeout: 15000,
        message: 'the palette-opened page survived the switch away from alpha',
      })
      .toBe(false);
    await expect.poll(async () => (await windowsInSpace(betaId)).length, { timeout: 15000 }).toBeGreaterThan(0);
  });

  test('workspace-panel removal: `close space` closes a palette-opened page along with the workspace', async () => {
    // beta is active from the test above. The corner workspace panel was
    // removed in 59bbe921; keep this assertion under the old gate's grep so
    // the retired UI cannot silently return while its supported command
    // successor still proves the close transition end to end.
    const beta = 'lock-beta';
    const betaId = await spaceTagId(beta);
    const openResult = await enterSpace(beta);
    expect(openResult?.success, `switch space "${beta}" failed: ${openResult?.error}`).toBe(true);
    const borderPage = await app.getWindow('spaces/border.html', 15000);
    await expect(borderPage.locator('#label')).toHaveText(beta, { timeout: 15000 });
    expect(
      app.windows().some((p) => !p.isClosed() && p.url().includes('spaces/panel.html')),
      'the removed workspace panel unexpectedly returned',
    ).toBe(false);

    const pageId = await openPageLikeThePalette('https://example.com/lock-palette-opened-in-beta');
    await expect.poll(async () => (await windowsInSpace(betaId)).includes(pageId), { timeout: 15000 }).toBe(true);

    const closeResult = await runCommand('close space');
    expect(closeResult?.success, `close space failed: ${closeResult?.error}`).toBe(true);
    await expect.poll(() => borderPage.isClosed(), { timeout: 15000, message: 'close space did not close the border' }).toBe(true);
    await expect
      .poll(async () => (await liveWindowIds()).includes(pageId), {
        timeout: 15000,
        message: 'close space returned to the default but left the palette-opened page open',
      })
      .toBe(false);
    await expect.poll(async () => (await windowsInSpace(betaId)).length, { timeout: 15000 }).toBe(0);
  });

  test('a space entered for the first time by clicking its card gets the resolved accent on every window', async () => {
    // A tag that exists but has never been entered through `open`/`switch
    // space`, with the grey placeholder color `resolveVividColor` replaces.
    const gamma = 'lock-gamma';
    const gammaId = await spaceTagId(gamma);
    await bgWindow.evaluate(
      async (arg: { tagId: string; color: string }) => {
        await (window as unknown as { app: any }).app.datastore.updateTagColor(arg.tagId, arg.color);
      },
      { tagId: gammaId, color: '#999' },
    );

    // The default is active (the test above returned to it). Browse all
    // spaces and enter gamma by clicking its card: `features/spaces/home.js
    // activateSpace()` routes the click through `switch space`, the one way a
    // user enters a space from the browse-all page.
    const browsePage = await openBrowseAll();
    const card = browsePage.locator(`peek-card.space-card[data-tag-id="${gammaId}"]`);
    await expect(card).toHaveCount(1, { timeout: 15000 });
    await card.click();

    // Re-fetch the border on each poll attempt rather than hold one page
    // handle: the border (role 'overlay', a TRANSIENT_ROLE) can flicker
    // closed/reopened by focus churn, which would otherwise throw "Target
    // page ... has been closed" instead of retrying.
    let borderAccent = '';
    await expect
      .poll(
        async () => {
          try {
            const page = await app.getWindow('spaces/border.html', 15000);
            if ((await page.locator('#label').textContent()) !== gamma) return '';
            borderAccent = await page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue('--color').trim(),
            );
          } catch {
            borderAccent = '';
          }
          return borderAccent;
        },
        { timeout: 15000, message: 'the border never showed a resolved accent for the entered space' },
      )
      .not.toBe('');
    expect(borderAccent, 'the border shows the grey placeholder instead of a resolved accent').not.toBe('#999');

    // Every window that belongs to gamma carries the border's accent, not the
    // tag's raw grey; nothing about the accent may depend on whether the
    // space had been entered before.
    await expect.poll(async () => (await windowsInSpace(gammaId)).length, { timeout: 15000 }).toBeGreaterThan(0);
    for (const id of await windowsInSpace(gammaId)) {
      await expect
        .poll(() => windowModeColor(id), {
          timeout: 15000,
          message: `window ${id} in gamma carries a different color from the border`,
        })
        .toBe(borderAccent);
    }

    // A window opened by any other route while gamma is active carries the
    // same accent — before the membership rule it carried no workspace at
    // all, so it showed no accent and hid the border whenever it was focused.
    const paletteWindowId = await openPageLikeThePalette('https://example.com/lock-gamma-palette-opened');
    await expect
      .poll(() => windowModeColor(paletteWindowId), {
        timeout: 15000,
        message: 'a page opened from the palette inside gamma does not carry gamma\'s accent',
      })
      .toBe(borderAccent);

    await runCommand('close space');
  });

  test('no duplicate browse-all Spaces window accumulates across repeated switches', async () => {
    const delta = 'lock-delta';
    await spaceTagId(delta);

    // The default is active. A browse-all page open in it is the default's
    // window: leaving the default sweeps it and returning restores it from
    // the default's saved row — the same number of copies as before, never
    // one more. Before the rule the page survived the switch and the restore
    // put a second copy beside it, one more on every round trip.
    if (browseAllPages().length === 0) await openBrowseAll();
    const copies = browseAllPages().length;
    expect(copies).toBeGreaterThan(0);

    for (const round of [1, 2]) {
      const openResult = await enterSpace(delta);
      expect(openResult?.success, `round ${round}: switch space "${delta}" failed: ${openResult?.error}`).toBe(true);
      await expect
        .poll(() => browseAllPages().length, {
          timeout: 15000,
          message: `round ${round}: the default's browse-all page survived entering "${delta}"`,
        })
        .toBe(0);

      const closeResult = await runCommand('close space');
      expect(closeResult?.success, `round ${round}: close space failed: ${closeResult?.error}`).toBe(true);
      await expect
        .poll(() => browseAllPages().length, {
          timeout: 15000,
          message: `round ${round}: returning to the default did not bring the browse-all page back`,
        })
        .toBe(copies);
      // Give a duplicate a moment to appear before declaring the count stable.
      await new Promise((r) => setTimeout(r, 750));
      expect(
        browseAllPages().length,
        `round ${round}: returning to the default duplicated the browse-all page (${copies} before, ${browseAllPages().length} after)`,
      ).toBe(copies);
    }
  });

  test('an editor window opened in a workspace is swept on switch, like any other content window', async () => {
    const epsilon = 'lock-epsilon';
    const zeta = 'lock-zeta';
    const epsilonId = await spaceTagId(epsilon);
    const zetaId = await spaceTagId(zeta);

    const openResult = await enterSpace(epsilon);
    expect(openResult?.success, `switch space "${epsilon}" failed: ${openResult?.error}`).toBe(true);
    const borderPage = await app.getWindow('spaces/border.html', 15000);
    await expect(borderPage.locator('#label')).toHaveText(epsilon, { timeout: 15000 });

    const before = new Set(await liveWindowIds());
    const editorResult = await runCommand('editor');
    expect(editorResult, `"editor" command failed: ${JSON.stringify(editorResult)}`).not.toHaveProperty('error');

    let editorId: number | null = null;
    await expect
      .poll(
        async () => {
          const now = await liveWindowIds();
          editorId = now.find((id) => !before.has(id)) ?? null;
          return editorId !== null;
        },
        { timeout: 15000, message: 'the "editor" command never opened a new window' },
      )
      .toBe(true);

    await expect
      .poll(async () => (await windowsInSpace(epsilonId)).includes(editorId as number), {
        timeout: 15000,
        message: 'an editor window opened while epsilon was active does not belong to epsilon',
      })
      .toBe(true);

    const switchResult = await runCommand('switch space', zeta);
    expect(switchResult?.success, `switch space "${zeta}" failed: ${switchResult?.error}`).toBe(true);
    await expect
      .poll(async () => (await liveWindowIds()).includes(editorId as number), {
        timeout: 15000,
        message: 'the editor window opened in epsilon survived the switch away from it',
      })
      .toBe(false);
    await expect.poll(async () => (await windowsInSpace(zetaId)).length, { timeout: 15000 }).toBeGreaterThan(0);

    await runCommand('close space');
  });

  test('an editor window that loads a real item keeps its workspace membership and is still swept on switch', async () => {
    // `features/editor/home.js` used to call `api.context.setMode('editor',
    // …)` once an editor window attached to a real datastore item (loading
    // one by itemId, or a blank note getting its first content) — clobbering
    // the SAME `mode` context key `closeCurrentWorkspaceWindows()` reads for
    // workspace membership (`'space'`/`'group'`), since it is a raw
    // unconditional overwrite (`tile-preload.cts` `setMode` →
    // `contextStrict.set('mode', …)`). A window's mode is otherwise written
    // once, when the window opens (`ipc.ts`), and no navigation rewrites it,
    // so this overwrite was the one way to lose space/group membership. A
    // window that loaded an item this way kept its
    // window open forever, excluded from every workspace's session save too.
    const theta = 'lock-theta';
    const iota = 'lock-iota';
    const thetaId = await spaceTagId(theta);
    const iotaId = await spaceTagId(iota);

    const itemResult = await bgWindow.evaluate(async () => {
      const api = (window as unknown as { app: any }).app;
      const r = await api.datastore.addItem('text', {
        content: 'mode-clobber probe',
        metadata: JSON.stringify({ title: 'mode-clobber probe' }),
      });
      return { ok: !!r?.success, itemId: r?.data?.id ?? null, error: r?.error };
    });
    expect(itemResult.ok, `seeding the mode-clobber-probe item failed: ${itemResult.error}`).toBe(true);
    const itemId = itemResult.itemId as string;

    const openResult = await enterSpace(theta);
    expect(openResult?.success, `switch space "${theta}" failed: ${openResult?.error}`).toBe(true);
    const borderPage = await app.getWindow('spaces/border.html', 15000);
    await expect(borderPage.locator('#label')).toHaveText(theta, { timeout: 15000 });

    const before = new Set(await liveWindowIds());
    await publishEvent('editor:open', { itemId });
    let editorId: number | null = null;
    await expect
      .poll(
        async () => {
          const now = await liveWindowIds();
          editorId = now.find((id) => !before.has(id)) ?? null;
          return editorId !== null;
        },
        { timeout: 15000, message: 'opening the mode-clobber-probe item never opened a window' },
      )
      .toBe(true);

    // The editor's own item-load path runs asynchronously after the window
    // opens (`item-loaded` phase in its boot trace, observed ~235ms after
    // open in a live run) — wait it out before checking membership, so this
    // doesn't race a poll that returns true before the stomp lands.
    await new Promise((r) => setTimeout(r, 1500));
    await expect
      .poll(async () => (await windowsInSpace(thetaId)).includes(editorId as number), {
        timeout: 15000,
        message: 'an editor window that loaded a real item lost its workspace membership',
      })
      .toBe(true);

    const switchResult = await runCommand('switch space', iota);
    expect(switchResult?.success, `switch space "${iota}" failed: ${switchResult?.error}`).toBe(true);
    await expect
      .poll(async () => (await liveWindowIds()).includes(editorId as number), {
        timeout: 15000,
        message: 'the item-loaded editor window survived the switch away from theta',
      })
      .toBe(false);

    await runCommand('close space');
  });

  // `closeCurrentWorkspaceWindows()` sweeps every live window whose
  // `params.role` is in `WORKSPACE_CONTENT_ROLES`, not the windows
  // `getWindowsInSpace()` reports as carrying this workspace's `mode` tag —
  // the same distinction the mode-clobber test above exercises through a
  // real feature's overwrite. This test corrupts the tag directly and
  // proves the switch still closes the window despite it, which the old
  // tag-membership check could not have done.
  test('a window whose workspace mode tag is corrupted or missing is still swept on switch', async () => {
    const eta = 'lock-eta';
    const kappa = 'lock-kappa';
    const etaId = await spaceTagId(eta);
    const kappaId = await spaceTagId(kappa);

    const openResult = await enterSpace(eta);
    expect(openResult?.success, `switch space "${eta}" failed: ${openResult?.error}`).toBe(true);
    const borderPage = await app.getWindow('spaces/border.html', 15000);
    await expect(borderPage.locator('#label')).toHaveText(eta, { timeout: 15000 });

    const pageId = await openPageLikeThePalette('https://example.com/lock-eta-corrupted-tag');
    await expect
      .poll(async () => (await windowsInSpace(etaId)).includes(pageId), {
        timeout: 15000,
        message: 'a page opened from the palette while eta was active does not belong to eta',
      })
      .toBe(true);

    // Corrupt the window's membership tag directly — the same raw
    // `context.set('mode', …)` overwrite an unrelated feature made in the
    // mode-clobber test above, applied here on purpose rather than as a side
    // effect of loading an item.
    await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      await api.context.set('mode', 'page', {}, id);
    }, pageId);
    const corrupted = await bgWindow.evaluate(async (id: number) => {
      const api = (window as unknown as { app: any }).app;
      return await api.context.get('mode', id);
    }, pageId);
    expect(
      corrupted?.data?.value === 'space' && corrupted?.data?.metadata?.spaceId === etaId,
      'the tag corruption did not take — the window still reads as a member of eta',
    ).toBe(false);

    const switchResult = await runCommand('switch space', kappa);
    expect(switchResult?.success, `switch space "${kappa}" failed: ${switchResult?.error}`).toBe(true);
    await expect
      .poll(async () => (await liveWindowIds()).includes(pageId), {
        timeout: 15000,
        message: 'a window with a corrupted workspace tag survived the switch away from eta',
      })
      .toBe(false);

    await runCommand('close space');
  });

  // The Esc window switcher (`peek://windows/windows.html` `loadWindows()`)
  // calls this SAME `api.window.list({ includeInternal: true })`, and the
  // main-process handler it resolves to (`tile:window:list`,
  // `main/tile-ipc.ts`) applies no space/workspace filtering of its own — it
  // just lists whatever is still alive. Before this file's sweep fix that
  // meant the switcher could show a window from a workspace already left;
  // this proves the sweep is enough on its own — with every content window
  // from the outgoing workspace closed on switch, there is nothing left for
  // the switcher to leak.
  test('the Esc window switcher list never carries a window from a workspace already left', async () => {
    const mu = 'lock-mu';
    const nu = 'lock-nu';
    await spaceTagId(mu);
    await spaceTagId(nu);

    const openResult = await enterSpace(mu);
    expect(openResult?.success, `switch space "${mu}" failed: ${openResult?.error}`).toBe(true);
    const borderPage = await app.getWindow('spaces/border.html', 15000);
    await expect(borderPage.locator('#label')).toHaveText(mu, { timeout: 15000 });

    const muPageId = await openPageLikeThePalette('https://example.com/lock-mu-switcher-page');
    const before = new Set(await liveWindowIds());
    const editorResult = await runCommand('editor');
    expect(editorResult, `"editor" command failed: ${JSON.stringify(editorResult)}`).not.toHaveProperty('error');
    let muEditorId: number | null = null;
    await expect
      .poll(
        async () => {
          const now = await liveWindowIds();
          muEditorId = now.find((id) => !before.has(id)) ?? null;
          return muEditorId !== null;
        },
        { timeout: 15000, message: 'the "editor" command never opened a new window in mu' },
      )
      .toBe(true);
    const muSecondPageId = await openPageLikeThePalette('https://example.com/lock-mu-switcher-second');

    const muWindowIds = [muPageId, muEditorId as number, muSecondPageId];
    for (const id of muWindowIds) {
      await expect.poll(async () => (await liveWindowIds()).includes(id), { timeout: 15000 }).toBe(true);
    }

    const switchResult = await runCommand('switch space', nu);
    expect(switchResult?.success, `switch space "${nu}" failed: ${switchResult?.error}`).toBe(true);
    await expect
      .poll(
        async () => {
          const ids = await liveWindowIds();
          return muWindowIds.some((id) => ids.includes(id));
        },
        { timeout: 15000, message: 'a window opened in mu survived the switch to nu' },
      )
      .toBe(false);

    await openPageLikeThePalette('https://example.com/lock-nu-switcher-page');

    // The exact call `windows.js loadWindows()` makes.
    const switcherList = await bgWindow.evaluate(
      async () => await (window as unknown as { app: any }).app.window.list({ includeInternal: true }),
    );
    expect(switcherList?.success).toBe(true);
    const switcherIds = ((switcherList?.windows ?? []) as Array<{ id: number }>).map((w) => w.id);
    for (const id of muWindowIds) {
      expect(
        switcherIds.includes(id),
        `the Esc switcher's window list still carries window ${id} from "${mu}" after switching to "${nu}"`,
      ).toBe(false);
    }

    await runCommand('close space');
  });

  test('a space resolved by the browse-all list takes its accent from the active theme, like one resolved on entry', async () => {
    // The vivid accent that replaces a grey placeholder is drawn from the
    // ACTIVE theme's palette (`features/spaces/config.js resolveVividColor`),
    // and two separate callers resolve it: the browse-all list
    // (`features/spaces/home.js loadSpaces()`) and the workspace entry path
    // (`features/spaces/background.js openSpace()`). Both then PERSIST what
    // they picked onto the tag, and a persisted color has enough chroma that
    // every later resolution returns it unchanged — so whichever resolved a
    // space first decides its accent permanently.
    //
    // While the browse-all list resolved without the theme it always picked
    // from the built-in palette. Under any other theme, a space the list had
    // rendered kept a built-in-palette accent while a space entered without
    // ever being listed got the theme's own: two non-default spaces, two
    // palettes, which is the inconsistent accent this covers. The accent must
    // not depend on which caller got there first.
    const { resolveVividColor } = await import('../../features/spaces/config.js');

    const themeState = await bgWindow.evaluate(
      async () => await (window as unknown as { app: any }).app.theme.get(),
    );
    const originalTheme: string = themeState?.themeId ?? 'peek';
    // Any theme other than the active one — the built-in pair is peek/basic.
    const otherTheme = originalTheme === 'basic' ? 'peek' : 'basic';

    const omicron = 'lock-omicron';
    try {
      const switched = await bgWindow.evaluate(
        async (id: string) => await (window as unknown as { app: any }).app.theme.setTheme(id),
        otherTheme,
      );
      expect(switched?.success, `switching the theme to "${otherTheme}" failed: ${switched?.error}`).toBe(true);

      // Open the browse-all list BEFORE the tag exists, so its live query is
      // what first sees the space (as `tag:created`/`tag:color-changed`) and
      // the list is deterministically the first resolver.
      if (browseAllPages().length === 0) await openBrowseAll();

      const omicronId = await spaceTagId(omicron);
      // Only a space whose two palettes disagree can tell the two resolvers
      // apart; assert that before relying on it, so a name that happens to
      // hash to the same swatch in both palettes fails loudly instead of
      // passing vacuously.
      const underOtherTheme = resolveVividColor('#999', omicronId, otherTheme);
      const underOriginalTheme = resolveVividColor('#999', omicronId, originalTheme);
      expect(
        underOtherTheme,
        `space "${omicron}" hashes to the same accent under both "${otherTheme}" and "${originalTheme}" — this test cannot tell the resolvers apart; rename the space`,
      ).not.toBe(underOriginalTheme);

      await bgWindow.evaluate(
        async (arg: { tagId: string; color: string }) => {
          await (window as unknown as { app: any }).app.datastore.updateTagColor(arg.tagId, arg.color);
        },
        { tagId: omicronId, color: '#999' },
      );

      // The list resolves the grey placeholder and writes the result back.
      await expect
        .poll(() => tagColor(`space:${omicron}`), {
          timeout: 15000,
          message: 'the browse-all list never resolved the grey placeholder into an accent',
        })
        .toBe(underOtherTheme);

      // Entering the space must agree with what the list already stored, and
      // the border and the space's windows must both show it.
      const openResult = await enterSpace(omicron);
      expect(openResult?.success, `switch space "${omicron}" failed: ${openResult?.error}`).toBe(true);

      let borderAccent = '';
      await expect
        .poll(
          async () => {
            try {
              const page = await app.getWindow('spaces/border.html', 15000);
              if ((await page.locator('#label').textContent()) !== omicron) return '';
              borderAccent = await page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue('--color').trim(),
              );
            } catch {
              borderAccent = '';
            }
            return borderAccent;
          },
          { timeout: 15000, message: `the border never showed an accent for "${omicron}"` },
        )
        .toBe(underOtherTheme);

      const paletteWindowId = await openPageLikeThePalette('https://example.com/lock-omicron-palette-opened');
      await expect
        .poll(() => windowModeColor(paletteWindowId), {
          timeout: 15000,
          message: `a window opened inside "${omicron}" does not carry the accent the active theme resolves`,
        })
        .toBe(underOtherTheme);
      for (const id of await windowsInSpace(omicronId)) {
        expect(
          await windowModeColor(id),
          `window ${id} in "${omicron}" carries an accent from a different palette`,
        ).toBe(underOtherTheme);
      }
    } finally {
      await runCommand('close space');
      await bgWindow.evaluate(
        async (id: string) => await (window as unknown as { app: any }).app.theme.setTheme(id),
        originalTheme,
      );
    }
  });
});
