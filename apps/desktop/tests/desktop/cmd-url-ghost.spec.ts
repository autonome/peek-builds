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

    // Get baseline window count
    const beforeList = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.list();
    });
    const beforeCount = beforeList.windows?.length ?? 0;

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
