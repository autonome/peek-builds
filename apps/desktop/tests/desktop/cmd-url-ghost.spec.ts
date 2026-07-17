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
  // Option A defaults the inline completion to HOST granularity (app.fastmail.com,
  // not the full tracking path). So the ghost first shows the host, and Tab
  // expands host -> host+/firstSegment -> host+fullPath.
  const SEED_HOST = 'ziggurat-test.example.com'; // host-granularity completion
  const SEED_HOST_URL = 'https://ziggurat-test.example.com'; // what Enter opens (clean origin)
  const SEED_PATH1 = 'ziggurat-test.example.com/visited'; // host + first path segment (Tab #1)
  const GHOST_REMAINDER = SEED_HOST.substring(TYPE_PREFIX.length); // urat-test.example.com

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
  const TITLED_HOST = 'fastlike.example.com'; // host-granularity completion
  const TITLED_REMAINDER = TITLED_HOST.substring(TITLED_PREFIX.length); // like.example.com

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
    // .cmd-inline-selection span (the highlighted host-completion remainder)
    // once updateCommandUI runs after the query.
    await cmdWindow.waitForFunction(
      (args: { prefix: string; remainder: string }) => {
        const commandText = document.getElementById('command-text');
        if (!commandText) return false;
        const typedSpan = commandText.querySelector('span.typed');
        if (!typedSpan) return false;
        const spans = Array.from(commandText.querySelectorAll('span'));
        // The ghost suffix now carries the selected-style class.
        const ghostSpan = spans.find(s => s.className === 'cmd-inline-selection' && s.textContent);
        if (!ghostSpan) return false;
        return (
          (typedSpan.textContent || '').toLowerCase() === args.prefix.toLowerCase() &&
          (ghostSpan.textContent || '').toLowerCase() === args.remainder.toLowerCase()
        );
      },
      { prefix: TYPE_PREFIX, remainder: GHOST_REMAINDER },
      { timeout: 5000 }
    );

    // Sanity: combined command-text should form the host-level completion
    // (the default granularity), not the full stored path.
    const fullText = await cmdWindow.evaluate(() => {
      const el = document.getElementById('command-text');
      return el ? el.textContent : '';
    });
    expect(fullText?.toLowerCase()).toContain(SEED_HOST.toLowerCase());

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
        const ghostSpan = spans.find(s => s.className === 'cmd-inline-selection' && s.textContent);
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

  test('pressing Tab expands the ghost through granularity stop-points', async () => {
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

    // On resolve the ghost shows the HOST completion, filled + suffix selected.
    await cmdWindow.waitForFunction(
      (host: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        return !!input && input.value === host;
      },
      SEED_HOST,
      { timeout: 5000 }
    );

    // Tab #1 expands host -> host + first path segment.
    await cmdWindow.keyboard.press('Tab');
    await cmdWindow.waitForFunction(
      (path1: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        return !!input && input.value === path1;
      },
      SEED_PATH1,
      { timeout: 5000 }
    );

    // Tab #2 expands to the full path (== the stored matchable here; no query).
    await cmdWindow.keyboard.press('Tab');
    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        return !!input && input.value === matchable;
      },
      SEED_MATCHABLE,
      { timeout: 5000 }
    );

    // The suffix stays natively selected (anchored at the typed length), and
    // state.typed is never overwritten — it remains the user's real typed text,
    // so a single Backspace still rejects the whole completion.
    const post = await cmdWindow.evaluate((prefix: string) => {
      const input = document.getElementById('command-input') as HTMLInputElement | null;
      const s = (window as any)._cmdState;
      return {
        selStart: input?.selectionStart,
        selEnd: input?.selectionEnd,
        valueLen: input?.value.length,
        typed: s ? s.typed : null,
        prefixLen: prefix.length,
      };
    }, TYPE_PREFIX);
    expect(post.selStart).toBe(post.prefixLen);
    expect(post.selEnd).toBe(post.valueLen);
    expect(post.typed).toBe(TYPE_PREFIX);

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
  test('pressing Enter on ghost suggestion opens the host-level URL', async () => {
    // Under Option A the ghost defaults to HOST granularity, so Enter opens the
    // clean origin (https://ziggurat-test.example.com) — NOT the full stored
    // /visited/page tracking path. Like SEED_URL, the host is an unresolvable
    // *.example.com subdomain (verified: no A record). Formerly skipped: the
    // hybrid open path in apps/desktop/main/ipc.ts did
    // `await view.webContents.loadURL(url)` BEFORE publishing `window:opened`,
    // so the ERR_NAME_NOT_RESOLVED rejection threw into the outer catch and the
    // open returned { success:false } having published NO `window:opened` and
    // created NO window. Fixed by commit 5d8453cd: the initial loadURL await
    // (ipc.ts, around line 2805) is now wrapped in its own `.catch()`, so a
    // rejected first navigation no longer fails the open — the window is still
    // constructed, registered, and `window:opened` still publishes;
    // wireHybridContentEvents turns the resulting did-fail-load into the
    // load-error overlay.
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

    // Subscribe in bgWindow to detect the new window opening (host-level URL)
    await bgWindow.evaluate((hostUrl: string) => {
      (window as any).__ghostUrlWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes(hostUrl) || msg.url.includes(encodeURIComponent(hostUrl)))) {
          (window as any).__ghostUrlWindowOpened = msg;
        }
      });
    }, SEED_HOST_URL);

    // Press Enter — should open the host-level URL via openUrlGhost action
    await cmdWindow.keyboard.press('Enter');

    // Wait for the window:opened event for the host URL
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
      w.url && (w.url.includes(SEED_HOST_URL) || w.url.includes(encodeURIComponent(SEED_HOST_URL)))
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

  // The keyboard-selected row must scroll into view when the selection moves
  // below the #results fold — i.e. arrowing out of the command rows down into
  // the Visited url lane. Pre-fix (peek dbaa172d) updateResultsUI never scrolled
  // the selection, so a Visited row selected below the 300px fold stayed
  // off-screen ("ArrowDown won't go into Visited"). We spy on scrollIntoView
  // (deterministic; independent of exact overflow geometry) and assert the
  // selected url row was scrolled into view.
  test('selecting a Visited row scrolls it into view', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return s && s.commands && s.commands['datastore'];
      },
      undefined,
      { timeout: 10000 }
    );

    await cmdWindow.fill('input', COMBINED_PREFIX);

    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) >= 1 && (s.urlMatches?.length || 0) >= 1;
      },
      undefined,
      { timeout: 8000 }
    );

    // Patch scrollIntoView to record the className of each scrolled element,
    // then clear the log so we only observe the arrowing below.
    await cmdWindow.evaluate(() => {
      const w = window as any;
      if (!w.__origScrollIntoView) {
        w.__origScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (arg) {
          (window as any).__scrolledClasses.push(this.className);
          return (window as any).__origScrollIntoView.call(this, arg);
        };
      }
      w.__scrolledClasses = [];
    });

    const cmdCount = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      return s.matches?.length || 0;
    });

    // First ArrowDown opens the results (selecting row 0); overshoot well past
    // the command rows so the selection lands on (and clamps within) the url lane.
    for (let i = 0; i < cmdCount + 8; i++) {
      await cmdWindow.keyboard.press('ArrowDown');
    }

    // Selection has crossed into the url lane.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && s.matchIndex >= (s.matches?.length || 0);
      },
      undefined,
      { timeout: 5000 }
    );

    const scrolledUrlRow = await cmdWindow.evaluate(() =>
      ((window as any).__scrolledClasses as string[]).some((c) => c.includes('url-result-item'))
    );
    expect(scrolledUrlRow).toBe(true);

    // Restore the original so the patch doesn't leak into later tests.
    await cmdWindow.evaluate(() => {
      const w = window as any;
      if (w.__origScrollIntoView) {
        Element.prototype.scrollIntoView = w.__origScrollIntoView;
        w.__origScrollIntoView = null;
      }
    });

    await closePanel(panelId);
  });

  // Runs LAST: pressing Enter closes the panel into CLOSING (keepLive reuse race),
  // matching the ordering discipline of the ghost describe block above.
  test('ArrowDown to a Visited row then Enter opens that row url', async () => {
    // Same reason as the ghost "pressing Enter … opens the seeded URL" test
    // above: this waits for a `window:opened` event for an unresolvable
    // *.example.com host (quxfoo/quxbar.example.com). Formerly skipped because
    // the hybrid open path awaited `view.webContents.loadURL(url)` before
    // publishing `window:opened` (apps/desktop/main/ipc.ts), so the DNS
    // failure (ERR_NAME_NOT_RESOLVED) threw into the catch and no window / no
    // event was produced. Fixed by commit 5d8453cd — see the comment on the
    // sibling test above for the current ipc.ts behavior.
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

// Standalone describe (its own app/panel) to keep this substring/neverOpenUnshown
// case isolated from the ghost + lane describes above.
test.describe('cmd URL history substring match @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // Bug 879c0316: the user's real fastmail URL is a SUBDOMAINED deep link, so the
  // typed text "fast" is a SUBSTRING of the matchable ("app.fastmail.com/...") but
  // NOT a prefix. The suggestion still RESOLVES (it feeds the Visited lane), but
  // Option A's neverOpenUnshown rule means a substring that was never rendered
  // inline is NOT opened by a bare Enter — the user reaches it via the Visited
  // lane (ArrowDown → Enter), not by a hidden Enter shortcut. That footgun (typing
  // "fast" and silently opening app.fastmail.com) is exactly what Option A removes.
  const SUBSTRING_URL = 'https://app.fastmail.com/mail/Inbox';
  const SUBSTRING_QUERY = 'fast';

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

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-substring'));

    const navResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.datastore.trackNavigation(u, {
        source: 'window',
        windowType: 'main',
      });
    }, SUBSTRING_URL);
    expect(navResult.success).toBe(true);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('typing "fast" (substring, non-prefix) is NOT opened by a bare Enter', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', SUBSTRING_QUERY);

    // No command matches "fast"; the subdomained fastmail url arrives as a url match.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) === 0 && (s.urlMatches?.length || 0) >= 1;
      },
      undefined,
      { timeout: 8000 }
    );

    // The suggestion still resolves (it feeds the Visited lane) and is the
    // substring match — NOT a prefix of the typed text.
    const ghost = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      return s && s.urlGhostSuggestion
        ? { url: s.urlGhostSuggestion.url, matchable: s.urlGhostSuggestion.matchable }
        : null;
    });
    expect(ghost).toBeTruthy();
    expect(ghost!.url).toBe(SUBSTRING_URL);
    expect(ghost!.matchable.toLowerCase().startsWith(SUBSTRING_QUERY)).toBe(false);

    // neverOpenUnshown: nothing is rendered inline (no selected-suffix span) and
    // the input still holds exactly the typed text — no completion was filled.
    const shownState = await cmdWindow.evaluate(() => {
      const input = document.getElementById('command-input') as HTMLInputElement | null;
      const commandText = document.getElementById('command-text');
      return {
        value: input?.value,
        hasInlineSpan: !!commandText?.querySelector('.cmd-inline-selection'),
      };
    });
    expect(shownState.value).toBe(SUBSTRING_QUERY);
    expect(shownState.hasInlineSpan).toBe(false);

    // Pin this test's premise, which was previously implicit: exactly ONE url
    // matches "%fast%" in this describe's fresh profile, so the combined total is
    // 1 — below the >1 auto-open threshold — and the list is CLOSED. Enter being a
    // no-op depends on that: no row is visible, so no row is selected. If a future
    // change auto-opened the list here, row 0 WOULD be selected and Enter would
    // (correctly, by that new rule) open it — silently invalidating this test
    // rather than failing it. Assert the closed list so that change breaks loudly.
    const listOpen = await cmdWindow.$eval('#results', (el: HTMLElement) =>
      el.classList.contains('visible'));
    expect(listOpen).toBe(false);

    // Subscribe to window:opened for the substring url before pressing Enter.
    await bgWindow.evaluate((url: string) => {
      (window as any).__substringUrlWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes(url) || msg.url.includes(encodeURIComponent(url)))) {
          (window as any).__substringUrlWindowOpened = msg;
        }
      });
    }, SUBSTRING_URL);

    // Enter — with no ArrowDown — is a no-op: the completion was never shown, so
    // it must NOT be opened. Bounded wait to give any (wrong) open a chance to fire.
    await cmdWindow.keyboard.press('Enter');
    await cmdWindow.waitForTimeout(1000);

    const openedFlag = await bgWindow.evaluate(() => (window as any).__substringUrlWindowOpened);
    expect(openedFlag).toBeNull();

    const afterList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const openedWindow = afterList.windows?.find((w: { url?: string }) =>
      w.url && (w.url.includes(SUBSTRING_URL) || w.url.includes(encodeURIComponent(SUBSTRING_URL)))
    );
    expect(openedWindow).toBeFalsy();

    if (panelId) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          await (window as any).app.window.close(id);
        }, panelId);
      } catch { /* may already be closed */ }
    }
  });
});

// Standalone describe (its own app/panel): the auto-open half of the substring
// case. Sibling of "cmd URL history substring match" above — same non-prefix
// query shape, but TWO seeded urls instead of one, which pushes the combined
// total over the >1 auto-open threshold and flips the expected outcome.
test.describe('cmd URL history substring match, auto-opened lane @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // The reported bug: two visited urls contain "grib" as a SUBSTRING (not a
  // prefix), so the Visited lane auto-opens with 2 rows and row 0 renders
  // highlighted — yet Enter was a silent no-op. Cause: the list's visibility was
  // decided by a rule inside updateResultsUI, while Enter was decided by the FSM,
  // which was still in TYPING with no guard matching. The user saw a selected row
  // and pressing Enter did nothing. Both now derive from the FSM (resultsListOpen
  // / selectedRow), so the highlight and Enter cannot disagree.
  //
  // Non-prefix matters: a prefix query would render the inline ghost and Enter
  // would take the hasUrlGhost branch instead, never reaching the selected-row
  // branch this test covers.
  const AUTO_URL_A = 'https://app.gribmail.example.com/mail/Inbox';
  const AUTO_URL_B = 'https://mail.gribly.example.com/inbox';
  const AUTO_QUERY = 'grib';

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

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-substring-autoopen'));

    for (const url of [AUTO_URL_A, AUTO_URL_B]) {
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

  test('an auto-opened, visibly-selected Visited row opens on a bare Enter', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', AUTO_QUERY);

    // No command matches "grib"; both seeded urls arrive as url matches.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) === 0 && (s.urlMatches?.length || 0) >= 2;
      },
      undefined,
      { timeout: 8000 }
    );

    // The query is a substring of both matchables, never a prefix — so no
    // completion is shown inline and the hasUrlGhost Enter branch cannot fire.
    const inlineShown = await cmdWindow.evaluate(() => {
      const input = document.getElementById('command-input') as HTMLInputElement | null;
      const commandText = document.getElementById('command-text');
      return {
        value: input?.value,
        hasInlineSpan: !!commandText?.querySelector('.cmd-inline-selection'),
      };
    });
    expect(inlineShown.value).toBe(AUTO_QUERY);
    expect(inlineShown.hasInlineSpan).toBe(false);

    // 2 combined results > 1 ⇒ the list auto-opens while still in TYPING.
    await cmdWindow.waitForFunction(
      () => document.querySelectorAll('.url-result-item').length >= 2,
      undefined,
      { timeout: 5000 }
    );
    const listOpen = await cmdWindow.$eval('#results', (el: HTMLElement) =>
      el.classList.contains('visible'));
    expect(listOpen).toBe(true);

    // Row 0 is visibly selected with no ArrowDown — the FSM auto-selects the
    // lone url lane's first row.
    const rowZeroSelected = await cmdWindow.evaluate(() => {
      const rows = document.querySelectorAll('.url-result-item');
      return rows.length > 0 && rows[0].classList.contains('selected');
    });
    expect(rowZeroSelected).toBe(true);

    // The url of the selected row (row 0), resolved from state rather than
    // hardcoded, so frecency ordering can't make this flaky.
    const expectedUrl = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      const item = s.urlMatches?.[0];
      return item ? item.content : null;
    });
    expect(expectedUrl).toBeTruthy();

    await bgWindow.evaluate((url: string) => {
      (window as any).__autoOpenUrlWindowOpened = null;
      (window as any).app.subscribe('window:opened', (msg: any) => {
        if (msg?.url && (msg.url.includes(url) || msg.url.includes(encodeURIComponent(url)))) {
          (window as any).__autoOpenUrlWindowOpened = msg;
        }
      });
    }, expectedUrl);

    // The regression: Enter with NO ArrowDown. Was a silent no-op.
    await cmdWindow.keyboard.press('Enter');

    await bgWindow.waitForFunction(
      () => (window as any).__autoOpenUrlWindowOpened !== null,
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

    if (panelId) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          await (window as any).app.window.close(id);
        }, panelId);
      } catch { /* may already be closed */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Option A (Camp 1 — selected-text ghost) acceptance. Peek item 626e9b26.
//
// The reported bug: once a URL ghost is showing, there is NO one-gesture way to
// reach the BARE text you typed — Enter always takes the ghost. Option A adopts
// the Spotlight/browser model: the completion is filled INTO the input with the
// auto-added suffix rendered as SELECTED text, so the reflexive reject is
// Backspace / type-over — which leaves only what you typed, and a later Enter
// then opens that.
//
// These assertions are STRUCTURAL (no hardcoded completion string) so they are
// robust to the target.granularity knob (domain vs full): they only require that
// (a) a completion is filled into the input beyond the typed prefix, and (b) the
// suffix beyond the prefix is the current selection.
//
// Failing-first (pre-Option-A): the completion lives in a dimmed #command-text
// overlay span; `input.value` stays the typed prefix, nothing is selected, and
// Backspace deletes a real typed char instead of rejecting the suggestion. Both
// tests fail today.
test.describe('cmd URL ghost Camp-1 selected-text reject @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // Prefix "zigs" matches no registered command (so state.matches.length === 0,
  // the ghost precondition). The matchable extends the typed prefix, so any
  // granularity's completion still starts with what was typed.
  const SEED_URL = 'https://www.zigselect-test.example.com/visited/page';
  const SEED_MATCHABLE = 'zigselect-test.example.com/visited/page';
  const TYPE_PREFIX = 'zigs';

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

  // Wait until the URL ghost suggestion is populated in panel state (this happens
  // both before AND after the Option A change, so it is a safe barrier).
  async function waitForGhost(cmdWindow: Page): Promise<void> {
    await cmdWindow.waitForFunction(
      (matchable: string) => {
        const s = (window as any)._cmdState;
        return !!s && !!s.urlGhostSuggestion && s.urlGhostSuggestion.matchable === matchable;
      },
      SEED_MATCHABLE,
      { timeout: 8000 }
    );
  }

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-ghost-reject'));
    const navResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.datastore.trackNavigation(u, {
        source: 'window',
        windowType: 'main',
      });
    }, SEED_URL);
    expect(navResult.success).toBe(true);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('URL ghost completion is filled into the input with the suffix selected', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', TYPE_PREFIX);
    await waitForGhost(cmdWindow);

    // The completion must be filled INTO the input, with the part beyond the
    // typed prefix selected. (timeout kept short so failing-first is quick.)
    await cmdWindow.waitForFunction(
      (prefix: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        if (!input) return false;
        const v = input.value;
        return (
          v.length > prefix.length &&
          v.toLowerCase().startsWith(prefix.toLowerCase()) &&
          input.selectionStart === prefix.length &&
          input.selectionEnd === v.length
        );
      },
      TYPE_PREFIX,
      { timeout: 3000 }
    );

    await closePanel(panelId);
  });

  test('Backspace rejects the selected completion, leaving the bare typed text', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', TYPE_PREFIX);
    await waitForGhost(cmdWindow);

    // Wait for the completion to actually be selected in the field before
    // rejecting (pre-fix this never happens → this test fails here).
    await cmdWindow.waitForFunction(
      (prefix: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        return !!input && input.value.length > prefix.length && input.selectionStart === prefix.length;
      },
      TYPE_PREFIX,
      { timeout: 3000 }
    );

    // Backspace deletes the selected suffix → only the typed prefix remains, and
    // the ghost suggestion is cleared (so a following Enter targets the typed text).
    await cmdWindow.keyboard.press('Backspace');

    await cmdWindow.waitForFunction(
      (prefix: string) => {
        const input = document.getElementById('command-input') as HTMLInputElement | null;
        const s = (window as any)._cmdState;
        return !!input && input.value === prefix && !!s && !s.urlGhostSuggestion;
      },
      TYPE_PREFIX,
      { timeout: 3000 }
    );

    await closePanel(panelId);
  });
});
