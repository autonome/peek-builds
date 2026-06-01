/**
 * Regression coverage: the cmd panel shows inline ghost-text completion
 * for visited URLs (frecency-ranked) when there are no command matches.
 *
 * Typing a prefix like "zigg" when "ziggurat-test.example.com/..." has been
 * visited should show a dimmed ghost span with the remainder in
 * #command-text, allow Tab/Enter to accept/open, and NOT show any
 * ".url-result-item" dropdown (the old dead Visited Pages UI is gone).
 *
 * We use a URL prefix ("zigg") that cannot match any registered command
 * name, so state.matches.length === 0 when it's typed — that is the
 * precondition for the ghost to activate.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

/**
 * keepLive panel reuse: the reopen dispatches VISIBILITY_SHOWN (reset → IDLE)
 * via the tile:lifecycle:visible IPC, which lands asynchronously. Wait for the
 * FSM to leave any terminal/closing state before typing, so INPUT isn't
 * absorbed. (Tests are ordered so no test reopens the panel from CLOSING —
 * the only state that does not reliably reset on reuse-show.)
 */
async function waitForPanelReady(cmdWindow: Page): Promise<void> {
  await cmdWindow.waitForFunction(
    () => {
      const st = (window as any)._cmdState?.currentState;
      return !!st && st !== 'CLOSING';
    },
    undefined,
    { timeout: 5000 }
  );
}

test.describe('cmd URL ghost-text completion @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // Use a URL whose matchable starts with a prefix ("zigg") that cannot
  // match any registered command name — required for ghost to activate.
  const SEED_URL = 'https://www.ziggurat-test.example.com/visited/page';
  // matchable form (stripped https:// + www.): ziggurat-test.example.com/visited/page
  const SEED_MATCHABLE = 'ziggurat-test.example.com/visited/page';
  const TYPE_PREFIX = 'zigg';
  const GHOST_REMAINDER = SEED_MATCHABLE.substring(TYPE_PREFIX.length); // urat-test.example.com/visited/page

  // Titled-history regression seed: a URL WITH a title that contains the typed
  // prefix. Distinct prefix/domain from the zigg seed above so the two don't
  // interfere. Previously the in-memory command registry mirrored both the URL
  // and its title as commands; the title command ("Fastlike Site") would match
  // "fast" and suppress the ghost. After decoupling, history is no longer
  // mirrored into the registry, so the ghost still shows.
  const TITLED_URL = 'https://fastlike.example.com/inbox';
  const TITLED_MATCHABLE = 'fastlike.example.com/inbox';
  const TITLED_TITLE = 'Fastlike Site';
  const TITLED_PREFIX = 'fast';
  const TITLED_REMAINDER = TITLED_MATCHABLE.substring(TITLED_PREFIX.length); // like.example.com/inbox

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-ghost'));

    // Seed a visited URL item with a visit so frecency > 0.
    // NOTE: No 'title' field — this prevents the history source from registering a
    // separate title-based command that would match "zigg" and block the ghost.
    // The URL command (https://...) is still registered but gets filtered by ://.
    const navResult = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.datastore.trackNavigation(url, {
        source: 'window',
        windowType: 'main',
      });
    }, SEED_URL);
    expect(navResult.success).toBe(true);

    // Seed a titled URL — trackNavigation forwards options.title to the backend,
    // so the item gets a metadata.title of "Fastlike Site".
    const titledResult = await bgWindow.evaluate(async (args: { url: string; title: string }) => {
      return await (window as any).app.datastore.trackNavigation(args.url, {
        source: 'window',
        windowType: 'main',
        title: args.title,
      });
    }, { url: TITLED_URL, title: TITLED_TITLE });
    expect(titledResult.success).toBe(true);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('typing a URL prefix shows ghost-text remainder in #command-text', async () => {
    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
        role: 'palette',
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    // Type the prefix — should trigger URL ghost after debounce
    await cmdWindow.fill('input', TYPE_PREFIX);

    // Primary check: wait for urlGhostSuggestion to be set in panel state.
    // _cmdState is a Proxy over the module-level `state` plus ghost accessors.
    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const s = (window as any)._cmdState;
        if (!s) return false;
        const ghost = s.urlGhostSuggestion;
        return !!ghost && ghost.matchable === matchable;
      },
      SEED_MATCHABLE,
      { timeout: 8000 }
    );

    // DOM check: #command-text should have a .typed span (the prefix) and a
    // plain span (the ghost remainder) once updateCommandUI runs after the query.
    await cmdWindow.waitForFunction(
      (args: { prefix: string; remainder: string }) => {
        const commandText = document.getElementById('command-text');
        if (!commandText) return false;
        const typedSpan = commandText.querySelector('span.typed');
        if (!typedSpan) return false;
        const spans = Array.from(commandText.querySelectorAll('span'));
        // A ghost span: no class (or empty class), non-empty text
        const ghostSpan = spans.find(s => !s.className && s.textContent);
        if (!ghostSpan) return false;
        return (
          (typedSpan.textContent || '').toLowerCase() === args.prefix.toLowerCase() &&
          (ghostSpan.textContent || '').toLowerCase() === args.remainder.toLowerCase()
        );
      },
      { prefix: TYPE_PREFIX, remainder: GHOST_REMAINDER },
      { timeout: 5000 }
    );

    // Sanity: combined command-text should form the full matchable
    const fullText = await cmdWindow.evaluate(() => {
      const el = document.getElementById('command-text');
      return el ? el.textContent : '';
    });
    expect(fullText?.toLowerCase()).toContain(SEED_MATCHABLE.toLowerCase());

    // Verify no old Visited Pages dropdown items are present
    const urlResultItems = await cmdWindow.evaluate(() => {
      return document.querySelectorAll('.url-result-item').length;
    });
    expect(urlResultItems).toBe(0);

    // Cleanup cmd panel
    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }
  });

  test('titled history URL still shows ghost and is not mirrored into the command registry', async () => {
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
        role: 'palette',
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);
    await waitForPanelReady(cmdWindow);

    // Type the prefix that the seeded title contains — should still trigger the ghost.
    await cmdWindow.fill('input', TITLED_PREFIX);

    // (1) urlGhostSuggestion is set with the seeded URL's matchable.
    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const s = (window as any)._cmdState;
        return !!s && !!s.urlGhostSuggestion && s.urlGhostSuggestion.matchable === matchable;
      },
      TITLED_MATCHABLE,
      { timeout: 8000 }
    );

    // (2) The #command-text ghost remainder renders (plain span, no class, non-empty).
    await cmdWindow.waitForFunction(
      (args: { prefix: string; remainder: string }) => {
        const commandText = document.getElementById('command-text');
        if (!commandText) return false;
        const typedSpan = commandText.querySelector('span.typed');
        if (!typedSpan) return false;
        const spans = Array.from(commandText.querySelectorAll('span'));
        const ghostSpan = spans.find(s => !s.className && s.textContent);
        if (!ghostSpan) return false;
        return (
          (typedSpan.textContent || '').toLowerCase() === args.prefix.toLowerCase() &&
          (ghostSpan.textContent || '').toLowerCase() === args.remainder.toLowerCase()
        );
      },
      { prefix: TITLED_PREFIX, remainder: TITLED_REMAINDER },
      { timeout: 5000 }
    );

    // (3) Structural guarantee: history is no longer mirrored into the in-memory
    // command registry — no command key equals the seeded URL or its title, and
    // no command key contains '://'.
    const registryCheck = await cmdWindow.evaluate(
      (args: { url: string; title: string }) => {
        const s = (window as any)._cmdState;
        const names = Object.keys(s.commands || {});
        return {
          hasUrlKey: names.includes(args.url),
          hasTitleKey: names.includes(args.title),
          hasProtocolKey: names.some((n) => n.includes('://')),
        };
      },
      { url: TITLED_URL, title: TITLED_TITLE }
    );
    expect(registryCheck.hasUrlKey).toBe(false);
    expect(registryCheck.hasTitleKey).toBe(false);
    expect(registryCheck.hasProtocolKey).toBe(false);

    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }
  });

  test('pressing Tab accepts the ghost (ACCEPT_GHOST via the FSM)', async () => {
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
        role: 'palette',
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);
    await waitForPanelReady(cmdWindow);

    // Type prefix and wait for the ghost suggestion to populate.
    await cmdWindow.fill('input', TYPE_PREFIX);
    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const s = (window as any)._cmdState;
        return !!s && !!s.urlGhostSuggestion && s.urlGhostSuggestion.matchable === matchable;
      },
      SEED_MATCHABLE,
      { timeout: 8000 }
    );

    // Press Tab — ACCEPT_GHOST should fill input + state.typed with the full matchable.
    await cmdWindow.keyboard.press('Tab');

    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        const s = (window as any)._cmdState;
        return !!input && input.value === matchable && !!s && s.typed === matchable;
      },
      SEED_MATCHABLE,
      { timeout: 5000 }
    );

    const inputValue = await cmdWindow.evaluate(() => {
      const input = document.getElementById('command-input') as HTMLInputElement | null;
      return input ? input.value : null;
    });
    expect(inputValue).toBe(SEED_MATCHABLE);

    const typedValue = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      return s ? s.typed : null;
    });
    expect(typedValue).toBe(SEED_MATCHABLE);

    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }
  });

  // Runs LAST: pressing Enter shuts the panel down into the CLOSING state, and
  // keepLive reuse-from-CLOSING does not reliably re-dispatch VISIBILITY_SHOWN
  // (a known keepLive-reuse race). Keeping this test last means no later test
  // reopens the panel from CLOSING.
  test('pressing Enter on ghost suggestion opens the seeded URL', async () => {
    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
        role: 'palette',
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);
    await waitForPanelReady(cmdWindow);

    // Type prefix and wait for ghost suggestion to be populated in state
    await cmdWindow.fill('input', TYPE_PREFIX);
    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const s = (window as any)._cmdState;
        return !!s && !!s.urlGhostSuggestion && s.urlGhostSuggestion.matchable === matchable;
      },
      SEED_MATCHABLE,
      { timeout: 8000 }
    );

    // Subscribe in bgWindow to detect the new window opening
    await bgWindow.evaluate((seedUrl: string) => {
      (window as any).__ghostUrlWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes(seedUrl) || msg.url.includes(encodeURIComponent(seedUrl)))) {
          (window as any).__ghostUrlWindowOpened = msg;
        }
      });
    }, SEED_URL);

    // Press Enter — should open the seeded URL via openUrlGhost action
    await cmdWindow.keyboard.press('Enter');

    // Wait for the window:opened event for our URL
    await bgWindow.waitForFunction(
      () => (window as any).__ghostUrlWindowOpened !== null,
      undefined,
      { timeout: 10000 }
    );

    // Confirm the opened window is present in the list
    const afterList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const openedWindow = afterList.windows?.find((w: { url?: string }) =>
      w.url && (w.url.includes(SEED_URL) || w.url.includes(encodeURIComponent(SEED_URL)))
    );
    expect(openedWindow).toBeTruthy();

    // Cleanup opened window
    if (openedWindow?.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openedWindow.id);
      } catch { /* may already be closed */ }
    }

    // Cleanup cmd panel
    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }
  });
});

test.describe('cmd URL history Visited lane @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // Two visited URLs sharing a prefix ("qux") that matches NO registered
  // command. Typing the prefix should populate both the inline ghost AND the
  // navigable Visited lane (>=2 rows).
  const LANE_URL_A = 'https://quxfoo.example.com/alpha';
  const LANE_URL_B = 'https://quxbar.example.com/beta';
  const LANE_PREFIX = 'qux';

  // A URL whose matchable starts with "data" — typing "data" matches the
  // registered `datastore` command AND this url, exercising the combined lane.
  const COMBINED_URL = 'https://data.example.com/dashboard';
  const COMBINED_PREFIX = 'data';

  async function openPanel(): Promise<{ cmdWindow: Page; panelId: number }> {
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
        keepLive: true,
        role: 'palette',
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);
    await waitForPanelReady(cmdWindow);
    return { cmdWindow, panelId: openResult.id };
  }

  async function closePanel(panelId: number) {
    if (!panelId) return;
    try {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, panelId);
    } catch { /* may already be closed */ }
  }

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-lane'));

    for (const url of [LANE_URL_A, LANE_URL_B, COMBINED_URL]) {
      const navResult = await bgWindow.evaluate(async (u: string) => {
        return await (window as any).app.datastore.trackNavigation(u, {
          source: 'window',
          windowType: 'main',
        });
      }, url);
      expect(navResult.success).toBe(true);
    }
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('history lane appears alongside the inline ghost (no command match)', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', LANE_PREFIX);

    // No command matches this prefix; at least one url-history match arrives.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) === 0 && (s.urlMatches?.length || 0) >= 2;
      },
      undefined,
      { timeout: 8000 }
    );

    // Inline ghost is present (single best frecency completion).
    const hasGhost = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      return !!s && !!s.urlGhostSuggestion;
    });
    expect(hasGhost).toBe(true);

    // The Visited lane renders >=2 navigable rows.
    await cmdWindow.waitForFunction(
      () => document.querySelectorAll('.url-result-item').length >= 2,
      undefined,
      { timeout: 5000 }
    );

    const laneCount = await cmdWindow.evaluate(
      () => document.querySelectorAll('.url-result-item').length
    );
    expect(laneCount).toBeGreaterThanOrEqual(2);

    await closePanel(panelId);
  });

  test('combined command + url lanes both render and auto-open', async () => {
    const { cmdWindow, panelId } = await openPanel();

    // Ensure the datastore command is registered so the prefix matches it.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return s && s.commands && s.commands['datastore'];
      },
      undefined,
      { timeout: 10000 }
    );

    await cmdWindow.fill('input', COMBINED_PREFIX);

    // Both lanes populate: >=1 command match AND >=1 url match.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) >= 1 && (s.urlMatches?.length || 0) >= 1;
      },
      undefined,
      { timeout: 8000 }
    );

    // Combined total > 1 → results container auto-opens with both row kinds.
    await cmdWindow.waitForFunction(
      () => {
        const container = document.getElementById('results');
        const cmdRows = container
          ? container.querySelectorAll('.command-item:not(.url-result-item)').length
          : 0;
        const urlRows = container
          ? container.querySelectorAll('.url-result-item').length
          : 0;
        return !!container && container.classList.contains('visible') && cmdRows >= 1 && urlRows >= 1;
      },
      undefined,
      { timeout: 5000 }
    );

    const visible = await cmdWindow.evaluate(() => {
      const container = document.getElementById('results');
      return !!container && container.classList.contains('visible');
    });
    expect(visible).toBe(true);

    await closePanel(panelId);
  });

  // Runs LAST: pressing Enter closes the panel into CLOSING (keepLive reuse race),
  // matching the ordering discipline of the ghost describe block above.
  test('ArrowDown to a Visited row then Enter opens that row url', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', LANE_PREFIX);

    // Wait for command (0) + url (>=2) lanes to settle.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) === 0 && (s.urlMatches?.length || 0) >= 2;
      },
      undefined,
      { timeout: 8000 }
    );

    // ArrowDown opens the dropdown and selects the first (Visited) row, since
    // there are no command rows (matches.length === 0).
    await cmdWindow.keyboard.press('ArrowDown');

    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && s.matchIndex === 0 && (s.urlMatches?.length || 0) >= 1;
      },
      undefined,
      { timeout: 5000 }
    );

    // Resolve the url of the currently-selected Visited row.
    const expectedUrl = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      const i = s.matchIndex - (s.matches?.length || 0);
      const item = s.urlMatches[i];
      return item ? item.content : null;
    });
    expect(expectedUrl).toBeTruthy();

    // Subscribe to window:opened for the selected url before triggering Enter.
    await bgWindow.evaluate((url: string) => {
      (window as any).__laneUrlWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes(url) || msg.url.includes(encodeURIComponent(url)))) {
          (window as any).__laneUrlWindowOpened = msg;
        }
      });
    }, expectedUrl);

    await cmdWindow.keyboard.press('Enter');

    await bgWindow.waitForFunction(
      () => (window as any).__laneUrlWindowOpened !== null,
      undefined,
      { timeout: 10000 }
    );

    const afterList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const openedWindow = afterList.windows?.find((w: { url?: string }) =>
      w.url && (w.url.includes(expectedUrl as string) || w.url.includes(encodeURIComponent(expectedUrl as string)))
    );
    expect(openedWindow).toBeTruthy();

    if (openedWindow?.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          await (window as any).app.window.close(id);
        }, openedWindow.id);
      } catch { /* may already be closed */ }
    }

    await closePanel(panelId);
  });
});
