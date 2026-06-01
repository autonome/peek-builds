/**
 * Windows Lazy Wake
 *
 * The `windows` feature was converted from a resident background tile to a
 * LAZY tile (peek epic d8e7efa5 / peek task 921b54b3). Its background
 * renderer no longer exists at boot, so it can no longer register its own
 * global hotkey. Instead the generic main-side feature-shortcut-registrar
 * (apps/desktop/main/feature-shortcut-registrar.ts) reads the manifest
 * `shortcuts[]` and registers `CommandOrControl+Shift+W` with a callback
 * that publishes `cmd:execute:windows` on the System address. That publish
 * flows through the load-on-dispatch hook, which boots the windows tile,
 * waits for it to reach READY, and then lets the publish reach the tile's
 * freshly-subscribed `cmd:execute:windows` handler — which opens the
 * switcher overlay.
 *
 * This spec proves the end-to-end lazy-wake path WITHOUT injecting OS keys
 * (macOS-headless has no virtual display, so a real global accelerator
 * can't be exercised deterministically). We drive the exact output of the
 * registrar's callback — `publish(systemAddress, 'cmd:execute:windows',
 * {})` — via the `__peek_test.publishCmdExecute` hook, which is literally
 * what the hotkey would do.
 *
 * Determinism (feedback_no_sleep_in_tests_or_code): the cold-wake is
 * synchronized on a REAL FSM transition — we subscribe to the System-owned
 * `tile:state-changed` observer topic (published by tile-lifecycle on every
 * transition; payload `{ tileId, entryId, from, to, trigger, ts }`) and
 * await the windows tile reaching `ready`. No timers/sleeps; `app.getWindow`
 * timeouts are failure-deadlines, matching existing specs.
 *
 * Run with:
 *   yarn test:grep "Windows Lazy Wake"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;

/** True iff any live BrowserWindow's URL contains the given substring. */
const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/**
 * Publish `cmd:execute:windows` on the System address — the exact output
 * of the registrar's global-hotkey callback. NOT an OS keypress.
 */
const fireWindowsHotkey = (): Promise<void> =>
  app.evaluateMain!(((_e: unknown) => {
    (globalThis as any).__peek_test.publishCmdExecute('windows');
  }) as any);

/**
 * Resolve when the `windows` tile transitions INTO `ready`, observed on the
 * real `tile:state-changed` FSM-mirror topic. Set this up BEFORE firing the
 * hotkey so the cold-boot transition can't be missed.
 */
const waitWindowsReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('windows', 'ready', 15000);
  }) as any);

test.describe('Windows Lazy Wake @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('windows-lazy-wake'));
    // Gate on core/cmd readiness so the cmd registry has announced commands
    // and the load-on-dispatch hook is wired before we probe.
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // ── (a) windows tile is NOT resident at boot ───────────────────────────
  test('windows tile has no resident window at boot', async () => {
    expect(await windowUrlExists('peek://windows/background.html')).toBe(false);
    expect(await windowUrlExists('peek://windows/windows.html')).toBe(false);
  });

  // ── (b) windows commands are LISTED cold (cmd:register-batch announced
  //        them without the tile being loaded) ─────────────────────────────
  test('windows commands are listed while the tile is unloaded', async () => {
    // Sanity: still no windows window exists at the moment we query commands.
    expect(await windowUrlExists('peek://windows/')).toBe(false);

    const commands = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      return await new Promise<Array<{ name: string }>>((resolve) => {
        const unsub = api.subscribe('cmd:query-commands-response', (msg: any) => {
          unsub?.();
          resolve(msg.commands || []);
        });
        api.publish('cmd:query-commands', {});
        // Failure-deadline only (not a settle-wait): if the registry never
        // answers, resolve empty so the assertions below fail loudly.
        setTimeout(() => { unsub?.(); resolve([]); }, 5000);
      });
    });

    const names = commands.map((c) => c.name);
    expect(names).toContain('windows');
    expect(names).toContain('center window');

    // The tile must STILL be unloaded — listing commands must not have woken it.
    expect(await windowUrlExists('peek://windows/')).toBe(false);
  });

  // ── (c) cold wake: the hotkey publish boots the tile (FSM → ready) and
  //        opens the switcher overlay ──────────────────────────────────────
  test('cmd:execute:windows wakes the lazy tile and opens the switcher overlay', async () => {
    // Precondition: still cold.
    expect(await windowUrlExists('peek://windows/windows.html')).toBe(false);

    // Arm the FSM observer BEFORE firing so the cold-boot READY transition
    // can't race ahead of us. This is the deterministic synchronization point.
    const readyPromise = waitWindowsReady();

    // Drive the registrar's exact callback output.
    await fireWindowsHotkey();

    // Synchronize on the real LOADING → READY transition of the windows tile.
    const transitionPayload = (await readyPromise) as { tileId: string; to: string };
    expect(transitionPayload.tileId).toBe('windows');
    expect(transitionPayload.to).toBe('ready');

    // The woken renderer's cmd:execute:windows handler opens the overlay.
    // app.getWindow's timeout here is a failure-deadline, not a settle-wait.
    const overlay = await app.getWindow('windows/windows.html', 15000);
    expect(overlay).toBeTruthy();
  });

  // ── (d) idempotent re-wake: firing again still yields the switcher ───────
  test('a second cmd:execute:windows still resolves to the switcher (already-warm)', async () => {
    // The tile is warm now; the overlay may have been dismissed/closed by the
    // time we re-fire. Fire again — same registrar output.
    await fireWindowsHotkey();

    // Synchronize on the switcher overlay being present (committed window
    // state). On an already-warm tile there is no fresh LOADING→READY
    // transition, so we wait on the window's presence, not on the FSM.
    const overlay = await app.getWindow('windows/windows.html', 15000);
    expect(overlay).toBeTruthy();
    expect(await windowUrlExists('peek://windows/windows.html')).toBe(true);
  });
});
