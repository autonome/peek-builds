/**
 * Lazy feature live re-enable / disable — no restart (peek task d432d39a).
 *
 * Re-enabling a lazy builtin mid-session used to flip the registry `disabled`
 * flag back WITHOUT replaying the boot-time lazy wiring (load-on-dispatch
 * registration + wake accelerators), so the feature's command-palette entries
 * and global hotkeys stayed dead until the next app restart. Disable was also
 * asymmetric (it unloaded the tile but left the lazy-registry entry + command
 * behind). Both `tile:features:enable` and `tile:features:disable` now route
 * through the SAME shared arm/disarm path boot uses (`loadOrArmFeatureTile` /
 * `disarmLazyTile`).
 *
 * This packaged spec proves the end-to-end no-restart cycle through the REAL
 * IPC handlers (the headless unit test in `main/lazy-feature-rearm.test.ts`
 * can't construct BrowserWindows). It drives `windows` — a lazy builtin with a
 * static command + switcher UI — and asserts on positive, deterministic state
 * (cmd registry membership + real FSM/window transitions), never a sleep or a
 * negative wait:
 *
 *   - disable → the `windows` command DROPS from the cmd registry (disarm
 *     published `cmd:unregister`) and any loaded windows tile/overlay is gone.
 *   - enable  → the command RE-APPEARS (arm re-announced `cmd:register-batch`)
 *     and the wake route works LIVE: publishing `cmd:execute:windows` (the
 *     registrar's exact hotkey output) boots the tile to READY and opens the
 *     switcher overlay — no restart.
 *   - a second disable/enable cycle behaves identically (idempotent).
 *
 * Run with:
 *   yarn test:grep "Lazy feature live re-enable"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;
let manager: Page;

/** True iff any live BrowserWindow's URL contains the given substring. */
const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/** The current set of registered command names (queried from the cmd registry). */
const queryCommandNames = (): Promise<string[]> =>
  bgWindow.evaluate(async () => {
    const api = (window as any).app;
    const commands = await new Promise<Array<{ name: string }>>((resolve) => {
      const unsub = api.subscribe('cmd:query-commands-response', (msg: any) => {
        unsub?.();
        resolve(msg.commands || []);
      });
      api.publish('cmd:query-commands', {});
      // Failure-deadline only (registry never answering ⇒ fail loudly), not a settle-wait.
      setTimeout(() => { unsub?.(); resolve([]); }, 5000);
    });
    return commands.map((c) => c.name);
  });

/** Disable/enable a feature through the REAL tile:features:* IPC, awaiting the result. */
const disableFeature = (id: string): Promise<{ success?: boolean; error?: string }> =>
  manager.evaluate((fid) => (window as any).app.features.disable(fid), id);
const enableFeature = (id: string): Promise<{ success?: boolean; error?: string }> =>
  manager.evaluate((fid) => (window as any).app.features.enable(fid), id);

/** Publish `cmd:execute:windows` — the exact output of the wake-hotkey callback. */
const fireWindowsHotkey = (): Promise<void> =>
  app.evaluateMain!(((_e: unknown) => {
    (globalThis as any).__peek_test.publishCmdExecute('windows');
  }) as any);

/** Resolve when the `windows` tile transitions INTO `ready` (real FSM topic). */
const waitWindowsReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('windows', 'ready', 15000);
  }) as any);

test.describe('Lazy feature live re-enable (no restart) @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('features-toggle-lazy-rearm'));
    await waitForExtensionsReady(bgWindow, 15000);
    // The features-manager tile holds the `features: manage` capability, so we
    // drive enable/disable through it exactly as the real UI does.
    await bgWindow.evaluate(async () => {
      await (window as any).app.window.open('peek://features-manager/manage.html', {
        key: 'features-manage', width: 900, height: 650,
      });
    });
    manager = await app.getWindow('features-manager/manage.html', 15000);
    await manager.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('baseline: windows is lazy, its command is listed, no window is loaded', async () => {
    expect(await windowUrlExists('peek://windows/')).toBe(false);
    expect(await queryCommandNames()).toContain('windows');
  });

  test('disable drops the windows command live (route torn down)', async () => {
    const res = await disableFeature('windows');
    expect(res.success).toBe(true);

    // disarm published cmd:unregister for the tile's commands → no longer listed.
    expect(await queryCommandNames()).not.toContain('windows');
    // No windows tile/overlay lingers.
    expect(await windowUrlExists('peek://windows/')).toBe(false);
  });

  test('re-enable re-arms the command AND the wake route works without restart', async () => {
    const res = await enableFeature('windows');
    expect(res.success).toBe(true);

    // arm re-announced cmd:register-batch → the command is back.
    expect(await queryCommandNames()).toContain('windows');

    // The live wake route works: arm the FSM observer BEFORE firing so the
    // cold-boot READY transition can't be missed, then fire the hotkey output.
    const readyPromise = waitWindowsReady();
    await fireWindowsHotkey();
    const payload = (await readyPromise) as { tileId: string; to: string };
    expect(payload.tileId).toBe('windows');
    expect(payload.to).toBe('ready');

    // The woken renderer opens the switcher overlay — proof of a fully live feature.
    const overlay = await app.getWindow('windows/windows.html', 15000);
    expect(overlay).toBeTruthy();
  });

  test('second disable/enable cycle is clean and idempotent', async () => {
    // Disable again — unloads the now-warm tile + overlay and drops the command.
    const off = await disableFeature('windows');
    expect(off.success).toBe(true);
    expect(await queryCommandNames()).not.toContain('windows');
    expect(await windowUrlExists('peek://windows/windows.html')).toBe(false);

    // Enable again — command back and the wake route works once more.
    const on = await enableFeature('windows');
    expect(on.success).toBe(true);
    expect(await queryCommandNames()).toContain('windows');

    const readyPromise = waitWindowsReady();
    await fireWindowsHotkey();
    const payload = (await readyPromise) as { tileId: string; to: string };
    expect(payload.to).toBe('ready');
    const overlay = await app.getWindow('windows/windows.html', 15000);
    expect(overlay).toBeTruthy();
  });
});

test.describe('Features Manager self-guard: cannot disable/remove itself @desktop', () => {
  // Separate app instance so this describe is independent of the rearm tests.
  let selfGuardApp: DesktopApp;
  let selfGuardManager: Page;

  test.beforeAll(async () => {
    ({ app: selfGuardApp, bgWindow } = await createPerDescribeApp('features-self-guard'));
    await waitForExtensionsReady(bgWindow, 15000);
    await bgWindow.evaluate(async () => {
      await (window as any).app.window.open('peek://features-manager/manage.html', {
        key: 'features-manage', width: 900, height: 650,
      });
    });
    selfGuardManager = await selfGuardApp.getWindow('features-manager/manage.html', 15000);
    await selfGuardManager.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (selfGuardApp) await selfGuardApp.close();
  });

  test('tile:features:disable refuses features-manager with an error result', async () => {
    // Drive through the real IPC handler — same path as the Manage UI's
    // api.features.disable call. Expect a failure shape, not success.
    const res = await selfGuardManager.evaluate(
      (id) => (window as any).app.features.disable(id),
      'features-manager',
    );
    expect(res.success).toBeUndefined();
    expect(res.error).toBeTruthy();
    expect(typeof res.error).toBe('string');
  });

  test('UI: features-manager row toggle button is disabled (no active Disable affordance)', async () => {
    // Wait for the feature list to render.
    await selfGuardManager.waitForFunction(() => {
      return document.querySelectorAll('.feature-card').length > 0;
    }, { timeout: 15000 });

    const toggleState = await selfGuardManager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'features-manager');
      if (!card) return { found: false };
      // The toggle button shows 'Required' and is disabled.
      const btn = Array.from(card.querySelectorAll('peek-button'))
        .find(b => {
          const t = (b.textContent || '').trim();
          return t === 'Disable' || t === 'Enable' || t === 'Required';
        }) as HTMLElement | undefined;
      if (!btn) return { found: true, btnFound: false };
      return {
        found: true,
        btnFound: true,
        text: (btn.textContent || '').trim(),
        disabled: (btn as any).disabled,
      };
    });

    expect(toggleState.found).toBe(true);
    expect(toggleState.btnFound).toBe(true);
    // Must be 'Required' (not 'Disable') and must be disabled.
    expect(toggleState.text).toBe('Required');
    expect(toggleState.disabled).toBe(true);
  });
});
