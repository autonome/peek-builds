/**
 * Cmd panel cursor-visibility regression guard.
 *
 * The cmd panel uses a transparent <input> overlaid by #command-text
 * (the visible display layer). The native input scrolls horizontally
 * to keep the caret visible when content exceeds the input width;
 * #command-text must mirror that scrollLeft so the user actually sees
 * the typed end. Without the mirror, typing past ~30 characters
 * pushes the caret off-screen.
 *
 * Fix: panel.js syncs commandText.scrollLeft to commandInput.scrollLeft
 * via the input's `scroll` event + a sync call at the end of the UI
 * update functions.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  waitForExtensionsReady,
  waitForPanelCommandsLoaded,
} from '../helpers/window-utils';

test.describe('Cmd Cursor Visibility @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-cursor-visibility'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('command-text scrolls with input when typed content exceeds visible width', async () => {
    await waitForExtensionsReady(bgWindow, 15000);

    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);

    // Type a long string. Panel input is ~600px wide; at 18px font ~30
    // characters fit. 200+ characters guarantees overflow.
    const longText = 'the quick brown fox jumps over the lazy dog '.repeat(8);
    await cmdWindow.fill('input', longText);

    // Force the input to scroll to its end (programmatic .value=… does
    // not trigger native caret-into-view scroll). The scroll event
    // listener then mirrors onto #command-text.
    await cmdWindow.evaluate(() => {
      const input = document.getElementById('command-input') as HTMLInputElement;
      if (input) input.scrollLeft = input.scrollWidth;
    });

    // Wait until input has scrolled AND command-text has caught up.
    await cmdWindow.waitForFunction(
      () => {
        const input = document.getElementById('command-input') as HTMLInputElement;
        const text = document.getElementById('command-text');
        return !!(
          input &&
          text &&
          input.scrollLeft > 0 &&
          text.scrollLeft === input.scrollLeft
        );
      },
      undefined,
      { timeout: 5000 }
    );

    const snap = await cmdWindow.evaluate(() => {
      const input = document.getElementById('command-input') as HTMLInputElement;
      const text = document.getElementById('command-text') as HTMLElement;
      return {
        inputScrollLeft: input.scrollLeft,
        textScrollLeft: text.scrollLeft,
        inputScrollWidth: input.scrollWidth,
        inputClientWidth: input.clientWidth,
      };
    });

    expect(snap.inputScrollLeft).toBeGreaterThan(0);
    expect(snap.textScrollLeft).toBe(snap.inputScrollLeft);
    // The input scrolled enough that the rightmost content is in view —
    // i.e. scrollLeft + clientWidth is at or near scrollWidth (typed
    // end visible at right edge).
    expect(snap.inputScrollLeft + snap.inputClientWidth).toBeGreaterThanOrEqual(
      snap.inputScrollWidth - 4
    );

    if (openResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, openResult.id);
    }
  });
});
