/**
 * Cmd State Machine Integration Tests
 *
 * Tests the state machine integration in the actual cmd panel UI.
 * Uses the shared app fixture pattern from smoke.spec.ts.
 *
 * Run with: yarn test:electron:bg (or yarn test:electron for foreground)
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForCommandResults, waitForResultsWithContent, waitForExtensionsReady, waitForPanelCommandsLoaded, sleep } from '../helpers/window-utils';

// Shared app instance
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

/**
 * Helper: Open cmd panel and return the cmd window page
 */
async function openCmdPanel(): Promise<{ cmdWindow: Page; windowId: number | null }> {
  const openResult = await sharedBgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://cmd/panel.html', {
      modal: true,
      width: 600,
      height: 50,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      center: true,
      keepLive: true,
    });
  });
  expect(openResult.success).toBe(true);

  const cmdWindow = await sharedApp.getWindow('cmd/panel.html', 5000);
  expect(cmdWindow).toBeTruthy();

  await cmdWindow.waitForSelector('input', { timeout: 5000 });
  await waitForPanelCommandsLoaded(cmdWindow, 10000);

  return { cmdWindow, windowId: openResult.id || null };
}

/**
 * Helper: Close cmd panel
 */
async function closeCmdPanel(windowId: number | null) {
  try {
    if (windowId) {
      await sharedBgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, windowId);
    }
  } catch {
    // Panel may have already closed via shutdown()
  }
}

/**
 * Helper: Get current state machine state from cmd window
 */
async function getState(cmdWindow: Page): Promise<string> {
  return await cmdWindow.evaluate(() => (window as any)._cmdState.currentState);
}

/**
 * Helper: Wait for a specific state machine state.
 *
 * If the caller expects CLOSING, tolerate the panel actually closing — the
 * CLOSING transition triggers window.close(), and waitForFunction can race
 * with the close and throw "Target page, context or browser has been closed".
 * That's the success case for CLOSING.
 */
async function waitForState(cmdWindow: Page, expectedState: string, timeout = 5000) {
  try {
    await cmdWindow.waitForFunction(
      (state: string) => (window as any)._cmdState.currentState === state,
      expectedState,
      { timeout }
    );
  } catch (err) {
    // Panel closed during the wait. For CLOSING (and other terminal states
    // where the window teardown is the expected behavior), accept that as
    // having reached the state. For non-terminal states, rethrow — a closed
    // panel while expecting TYPING/IDLE/PARAM_MODE is a real failure.
    const msg = err instanceof Error ? err.message : String(err);
    const isPageClosed = msg.includes('Target page') || msg.includes('context or browser has been closed');
    if (isPageClosed && expectedState === 'CLOSING') return;
    throw err;
  }
}

// ============================================================================
// State Transition Tests
// ============================================================================

test.describe('Cmd State Machine @desktop', () => {

  test('IDLE -> TYPING on character input', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Should start in IDLE
      const initialState = await getState(cmdWindow);
      expect(initialState).toBe('IDLE');

      // Type a character
      await cmdWindow.fill('input', 's');
      await waitForState(cmdWindow, 'TYPING');

      const stateAfterTyping = await getState(cmdWindow);
      expect(stateAfterTyping).toBe('TYPING');
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('TYPING -> RESULTS_OPEN on ArrowDown', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type to get matches
      await cmdWindow.fill('input', 'settings');
      await waitForState(cmdWindow, 'TYPING');

      // Wait for commands to match
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.matches && (window as any)._cmdState.matches.length > 0,
        undefined,
        { timeout: 10000 }
      );

      // ArrowDown to open results
      await cmdWindow.keyboard.press('ArrowDown');
      await waitForState(cmdWindow, 'RESULTS_OPEN');

      // Results should be visible
      const resultsVisible = await cmdWindow.$eval('#results', (el: any) => el.classList.contains('visible'));
      expect(resultsVisible).toBe(true);
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('TYPING -> PARAM_MODE when typing command with params + space', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type "edit " to commit to edit command and enter param mode
      await cmdWindow.fill('input', 'edit ');

      // Wait for param mode
      await cmdWindow.waitForFunction(
        () => {
          const state = (window as any)._cmdState;
          return state && state.paramMode === true && state.paramCommand === 'edit';
        },
        undefined,
        { timeout: 10000 }
      );

      const currentState = await getState(cmdWindow);
      expect(currentState).toBe('PARAM_MODE');
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('TYPING -> EXECUTING on Enter with committed command', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type a command and show results to commit
      await cmdWindow.fill('input', 'settings');
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.matches && (window as any)._cmdState.matches.length > 0,
        undefined,
        { timeout: 10000 }
      );
      await cmdWindow.keyboard.press('ArrowDown');
      await waitForState(cmdWindow, 'RESULTS_OPEN');

      // Press Enter to execute
      await cmdWindow.keyboard.press('Enter');

      // Should transition through EXECUTING to CLOSING
      // (settings command completes quickly)
      await cmdWindow.waitForFunction(
        () => {
          const state = (window as any)._cmdState.currentState;
          return state === 'EXECUTING' || state === 'CLOSING';
        },
        undefined,
        { timeout: 10000 }
      );
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('Escape layering: param mode -> clear text -> close', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Enter param mode
      await cmdWindow.fill('input', 'edit ');
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.paramMode === true,
        undefined,
        { timeout: 10000 }
      );

      // Escape 1: exit param mode -> TYPING
      await cmdWindow.keyboard.press('Escape');
      await waitForState(cmdWindow, 'TYPING');

      // Verify param mode exited
      const paramMode = await cmdWindow.evaluate(() => (window as any)._cmdState.paramMode);
      expect(paramMode).toBe(false);

      // Escape 2: clear text -> IDLE
      await cmdWindow.keyboard.press('Escape');
      await waitForState(cmdWindow, 'IDLE');

      // Verify input cleared
      const inputValue = await cmdWindow.$eval('input', (el: any) => el.value);
      expect(inputValue).toBe('');

      // Escape 3: close panel -> CLOSING
      await cmdWindow.keyboard.press('Escape');
      await waitForState(cmdWindow, 'CLOSING');
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('double Enter is blocked by executing guard', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type a command
      await cmdWindow.fill('input', 'settings');
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.matches && (window as any)._cmdState.matches.length > 0,
        undefined,
        { timeout: 10000 }
      );

      // Show results and press Enter twice quickly
      await cmdWindow.keyboard.press('ArrowDown');
      await waitForState(cmdWindow, 'RESULTS_OPEN');

      // First Enter triggers execution
      await cmdWindow.keyboard.press('Enter');
      // Second Enter should be blocked
      await cmdWindow.keyboard.press('Enter');

      // The second Enter should not cause issues — we should still be in
      // EXECUTING or have transitioned to CLOSING normally
      await cmdWindow.waitForFunction(
        () => {
          const state = (window as any)._cmdState.currentState;
          return state === 'EXECUTING' || state === 'CLOSING' || state === 'IDLE';
        },
        undefined,
        { timeout: 10000 }
      );
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('panel re-show resets state', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type something to get into TYPING state
      await cmdWindow.fill('input', 'test');
      await waitForState(cmdWindow, 'TYPING');

      // Close and reopen panel (simulates hide/show cycle)
      await cmdWindow.evaluate(() => window.close());
      await sleep(200);

      // Reopen
      const reopenResult = await sharedBgWindow.evaluate(async () => {
        return await (window as any).app.window.open('peek://cmd/panel.html', {
          modal: true,
          width: 600,
          height: 50,
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          center: true,
          keepLive: true,
        });
      });

      const cmdWindow2 = await sharedApp.getWindow('cmd/panel.html', 5000);
      await cmdWindow2.waitForSelector('input', { timeout: 5000 });

      // Should be reset to IDLE
      await waitForState(cmdWindow2, 'IDLE');

      // Input should be empty
      const inputValue = await cmdWindow2.$eval('input', (el: any) => el.value);
      expect(inputValue).toBe('');

      await closeCmdPanel(reopenResult.id);
    } finally {
      // Original panel already closed
    }
  });

  test('backward-compatible _cmdState proxy works', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Test boolean accessors
      const proxyResult = await cmdWindow.evaluate(() => {
        const s = (window as any)._cmdState;
        return {
          paramMode: s.paramMode,
          outputSelectionMode: s.outputSelectionMode,
          chainMode: s.chainMode,
          executing: s.executing,
          currentState: s.currentState,
        };
      });

      expect(proxyResult.paramMode).toBe(false);
      expect(proxyResult.outputSelectionMode).toBe(false);
      expect(proxyResult.chainMode).toBe(false);
      expect(proxyResult.executing).toBe(false);
      expect(proxyResult.currentState).toBe('IDLE');
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('basic command execution: type -> ArrowDown -> Enter -> panel closes', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type a command
      await cmdWindow.fill('input', 'settings');
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.matches && (window as any)._cmdState.matches.length > 0,
        undefined,
        { timeout: 10000 }
      );

      // ArrowDown to show results
      await cmdWindow.keyboard.press('ArrowDown');
      await waitForState(cmdWindow, 'RESULTS_OPEN');

      // Enter to execute
      await cmdWindow.keyboard.press('Enter');

      // Should end up in CLOSING or already closed
      await cmdWindow.waitForFunction(
        () => {
          const state = (window as any)._cmdState.currentState;
          return state === 'CLOSING' || state === 'EXECUTING';
        },
        undefined,
        { timeout: 10000 }
      );
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('Tab completion enters param mode for commands with params', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type partial command name
      await cmdWindow.fill('input', 'edi');
      await cmdWindow.waitForFunction(
        () => {
          const state = (window as any)._cmdState;
          return state.matches && state.matches.length > 0 && state.matches.some((m: string) => m === 'edit');
        },
        undefined,
        { timeout: 10000 }
      );

      // Tab to complete — should enter param mode since edit has params
      await cmdWindow.keyboard.press('Tab');

      // Wait for param mode to be entered
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.paramMode === true,
        undefined,
        { timeout: 5000 }
      );

      const state = await getState(cmdWindow);
      expect(state).toBe('PARAM_MODE');

      // Input should be "edit " (completed with space)
      const inputValue = await cmdWindow.$eval('input', (el: any) => el.value);
      expect(inputValue).toMatch(/^edit\s/i);
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('URL opening: type URL -> Enter -> panel closes', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type a URL
      await cmdWindow.fill('input', 'https://example.com');
      await waitForState(cmdWindow, 'TYPING');

      // Enter should detect URL and close
      await cmdWindow.keyboard.press('Enter');

      // Should transition to CLOSING (waitForState tolerates the panel
      // actually closing during the CLOSING transition).
      await waitForState(cmdWindow, 'CLOSING');
    } finally {
      await closeCmdPanel(windowId);
    }
  });

  test('click on result item executes via dispatch (no duplicate logic)', async () => {
    const { cmdWindow, windowId } = await openCmdPanel();

    try {
      // Type to get matches
      await cmdWindow.fill('input', 'settings');
      await cmdWindow.waitForFunction(
        () => (window as any)._cmdState.matches && (window as any)._cmdState.matches.length > 0,
        undefined,
        { timeout: 10000 }
      );

      // Show results
      await cmdWindow.keyboard.press('ArrowDown');
      await waitForState(cmdWindow, 'RESULTS_OPEN');

      // Click first result
      await cmdWindow.click('.command-item');

      // Should transition through EXECUTING
      await cmdWindow.waitForFunction(
        () => {
          const state = (window as any)._cmdState.currentState;
          return state === 'EXECUTING' || state === 'CLOSING';
        },
        undefined,
        { timeout: 10000 }
      );
    } finally {
      await closeCmdPanel(windowId);
    }
  });
});
