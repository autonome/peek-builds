/**
 * Cmd panel repeat-invocation regression guard.
 *
 * The bus-level repro in `cmd-execute-twice.spec.ts` passes 3/3 by
 * publishing `cmd:execute:*` directly. Manual testing (pre pubsub
 * FSM conversion) caught a 3rd-invocation stall the bus test missed:
 * panel UI state (executionTimeout, urlSearchTimer, subscription
 * lifetime) was leaking across repeats. This test drives the panel
 * UI end-to-end so any such leak surfaces as a stall in EXECUTING.
 *
 * Pattern: open panel → type → Enter → panel closes → repeat N times.
 * Success = every iteration leaves EXECUTING before timeout.
 */

import { test, expect, DesktopApp, getSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import {
  waitForExtensionsReady,
  waitForPanelCommandsLoaded,
  waitForCmdNotExecuting,
} from '../helpers/window-utils';

let sharedApp: DesktopApp;
let sharedBg: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBg = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBg);
});

test.afterAll(async () => {
  // Destroy (not hide) the keepLive panel so subsequent tests in the
  // shared app don't see a stale hidden window via getWindow URL match.
  // Native window.close() bypasses the closeOrHideWindow keepLive
  // intercept, ensuring real destruction.
  try {
    const cmdWindow = await sharedApp.getWindow('cmd/panel.html', 1000);
    await cmdWindow.evaluate(() => window.close());
  } catch {
    // Panel already gone
  }
});

async function openCmdPanel(): Promise<{ cmdWindow: Page; windowId: number }> {
  // Use `key` so iter 2+ exercises the keepLive REUSE path (matches the
  // real cmd panel's own open call in app/cmd/background.js). Without
  // key, each iteration creates a fresh window and the test becomes a
  // cold-start drill rather than a repeat-invocation drill.
  const openResult = await sharedBg.evaluate(async () => {
    return await (window as any).app.window.open('peek://cmd/panel.html', {
      key: 'peek://cmd/panel.html',
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
  await cmdWindow.waitForSelector('input', { timeout: 5000 });

  // Wait for the panel to have the `hello world` command registered
  // specifically. `waitForPanelCommandsLoaded` returns as soon as ANY
  // command is in the registry (often the 13 built-ins) — extension
  // commands like `hello world` arrive over the cmd:register-batch /
  // cmd:register pubsub topics and can lag the initial query response.
  await cmdWindow.waitForFunction(
    () => !!(window as any)._cmdState?.commands?.['hello world'],
    undefined,
    { timeout: 10000 }
  );

  // Wait for IDLE — the keepLive reuse path delivers tile:lifecycle:visible
  // which triggers the FSM's VISIBILITY_SHOWN reset. By the time api.window.
  // open resolved above, the IPC has been queued; this just waits for the
  // dispatch to complete.
  await cmdWindow.waitForFunction(
    () => (window as any)._cmdState?.currentState === 'IDLE',
    undefined,
    { timeout: 5000 }
  );

  return { cmdWindow, windowId: openResult.id };
}

test('cmd panel handles 20 sequential open → type → Enter cycles without stalling', async () => {
  for (let i = 1; i <= 20; i++) {
    const { cmdWindow } = await openCmdPanel();

    await cmdWindow.fill('input', 'hello world');
    await cmdWindow.keyboard.press('ArrowDown');
    await cmdWindow.keyboard.press('Enter');

    // Panel should leave EXECUTING. Terminal states (CLOSING → window
    // teardown → waitForCmdNotExecuting returns 'CLOSED') count as
    // success. Stall = stuck in EXECUTING past the timeout.
    const finalState = await waitForCmdNotExecuting(cmdWindow, 10000);
    expect(
      finalState,
      `iteration ${i}: panel must not stall (got ${finalState})`,
    ).not.toBe('TIMEOUT');
    expect(
      finalState,
      `iteration ${i}: panel must leave EXECUTING`,
    ).not.toBe('EXECUTING');
  }
});
