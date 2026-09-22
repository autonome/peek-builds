import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

// ============================================================================
// Shift+Tab cycles the command palette backward (@desktop)
//
// Tab cycles forward through the matches list (state.matchIndex + 1, wrapping);
// Shift+Tab is the mirror — state.matchIndex - 1, wrapping the other way
// (`panel.js shiftTabCycleInResults`, `state-machine.js` SHIFT_TAB transition).
// URL mode (Cmd+L) has its own independent Tab/Shift+Tab handling in the
// keydown handler (`panel.js`, the `if (urlModeActive)` branch) that cycles
// state.matchIndex over urlModeItems directly rather than through the FSM.
// ============================================================================

const PANEL_OPEN_OPTS = {
  modal: true,
  width: 600,
  height: 400,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  center: true,
};

test.describe('Cmd Shift+Tab cycles backward @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // Three distinct visited URLs, seeded for the URL-mode test below.
  const URL_A = 'https://alpha.example.com/one';
  const URL_B = 'https://bravo.example.com/two';
  const URL_C = 'https://charlie.example.com/three';

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-shift-tab-reverse'));

    for (const url of [URL_A, URL_B, URL_C]) {
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

  async function openPanel(): Promise<{ cmdWindow: Page; panelId: number }> {
    const openResult = await bgWindow.evaluate(async (opts) => {
      return await (window as any).app.window.open('peek://cmd/panel.html', opts);
    }, PANEL_OPEN_OPTS);
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);

    return { cmdWindow, panelId: openResult.id };
  }

  async function closePanel(panelId: number) {
    if (!panelId) return;
    try {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, panelId);
    } catch {
      // Panel may have already closed.
    }
  }

  test('Shift+Tab cycles backward in RESULTS_OPEN', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await cmdWindow.fill('input', 'theme');

    // Wait until at least two theme* commands have matched.
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return !!s && (s.matches?.length || 0) >= 2;
      },
      undefined,
      { timeout: 10000 }
    );

    // Pin the premise: every matched command is param-less. This is what makes
    // Tab/Shift+Tab cycle through results rather than diverting into param mode.
    const matchParamCheck = await cmdWindow.evaluate(() => {
      const s = (window as any)._cmdState;
      const matches: string[] = s.matches || [];
      return matches.map((name) => {
        const cmd = s.commands[name];
        return { name, paramCount: (cmd && cmd.params ? cmd.params.length : 0) };
      });
    });
    const withParams = matchParamCheck.filter((m) => m.paramCount > 0);
    expect(
      withParams.length,
      `expected all "theme"-matched commands to be param-less, found params on: ${JSON.stringify(withParams)}`
    ).toBe(0);

    const matchCount = matchParamCheck.length;
    expect(matchCount).toBeGreaterThanOrEqual(2);

    await cmdWindow.keyboard.press('ArrowDown');
    await cmdWindow.waitForFunction(
      () => (window as any)._cmdState?.currentState === 'RESULTS_OPEN',
      undefined,
      { timeout: 5000 }
    );

    await cmdWindow.keyboard.press('Tab');
    await cmdWindow.keyboard.press('Tab');

    const a = await cmdWindow.evaluate(() => (window as any)._cmdState.matchIndex);
    expect(a).toBeGreaterThanOrEqual(1);

    await cmdWindow.keyboard.press('Shift+Tab');
    await cmdWindow.waitForFunction(
      (expected: number) => {
        const s = (window as any)._cmdState;
        return s.matchIndex === expected && s.currentState === 'RESULTS_OPEN';
      },
      a - 1,
      { timeout: 5000 }
    );

    const selectedIndexAfterOneBack = await cmdWindow.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.command-item'));
      return items.findIndex((el) => el.classList.contains('selected'));
    });
    expect(selectedIndexAfterOneBack).toBe(a - 1);

    // Walk Shift+Tab down to matchIndex === 0 (bounded loop, not more than
    // matches.length iterations).
    let current = a - 1;
    for (let i = 0; i < matchCount && current !== 0; i++) {
      await cmdWindow.keyboard.press('Shift+Tab');
      current = await cmdWindow.evaluate(() => (window as any)._cmdState.matchIndex);
    }
    expect(current).toBe(0);

    // One more Shift+Tab wraps around to the last match.
    await cmdWindow.keyboard.press('Shift+Tab');
    await cmdWindow.waitForFunction(
      (expected: number) => (window as any)._cmdState?.matchIndex === expected,
      matchCount - 1,
      { timeout: 5000 }
    );

    const selectedIndexAfterWrap = await cmdWindow.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.command-item'));
      return items.findIndex((el) => el.classList.contains('selected'));
    });
    expect(selectedIndexAfterWrap).toBe(matchCount - 1);

    await closePanel(panelId);
  });

  test('Shift+Tab cycles backward in URL mode', async () => {
    const { cmdWindow, panelId } = await openPanel();

    await bgWindow.evaluate(() => {
      (window as any).app.publish('cmd:url-mode', {});
    });

    await cmdWindow.waitForFunction(
      () => document.querySelectorAll('.url-result-item').length >= 3,
      undefined,
      { timeout: 10000 }
    );

    const n = await cmdWindow.evaluate(() => document.querySelectorAll('.url-result-item').length);
    expect(n).toBeGreaterThanOrEqual(3);

    async function assertMatchIndexAndSelectedRow(expected: number) {
      await cmdWindow.waitForFunction(
        (e: number) => (window as any)._cmdState?.matchIndex === e,
        expected,
        { timeout: 5000 }
      );
      const selectedIndex = await cmdWindow.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.url-result-item'));
        return rows.findIndex((el) => el.classList.contains('selected'));
      });
      expect(selectedIndex).toBe(expected);
    }

    await cmdWindow.keyboard.press('Tab');
    await assertMatchIndexAndSelectedRow(1);

    await cmdWindow.keyboard.press('Tab');
    await assertMatchIndexAndSelectedRow(2);

    await cmdWindow.keyboard.press('Shift+Tab');
    await assertMatchIndexAndSelectedRow(1);

    await cmdWindow.keyboard.press('Shift+Tab');
    await assertMatchIndexAndSelectedRow(0);

    // Wrap-around: one more Shift+Tab from 0 goes to the last row.
    await cmdWindow.keyboard.press('Shift+Tab');
    await assertMatchIndexAndSelectedRow(n - 1);

    await closePanel(panelId);
  });
});
