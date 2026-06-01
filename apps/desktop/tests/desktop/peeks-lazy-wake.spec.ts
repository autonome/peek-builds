/**
 * Peeks Lazy Wake
 *
 * The `peeks` feature was converted from a resident background tile to a
 * LAZY tile (peek epic d8e7efa5 / peek task 921b54b3, STEP 3b). Its
 * background renderer no longer exists at boot, so it can no longer register
 * its own global hotkeys. Instead:
 *
 *   - At boot, the generic main-side feature-shortcut-registrar
 *     (apps/desktop/main/feature-shortcut-registrar.ts) registers the peeks
 *     manifest's STATIC DEFAULT wake-shortcut — `Option+0` → publishes
 *     `cli:peek-open` with `{ args: ['0'] }` on the System address. (User
 *     customizations, once declared via `api.shortcuts.declareWakeShortcuts`,
 *     are persisted and take precedence; a fresh profile uses the manifest
 *     default.)
 *   - That publish flows through the load-on-dispatch hook (peeks declares
 *     `cli:peek-open` in `lazyEvents`), which boots the peeks tile, waits for
 *     READY, then lets the publish reach the renderer's freshly-subscribed
 *     `cli:peek-open` handler — which opens the matching peek window.
 *
 * This spec proves the end-to-end lazy-wake path WITHOUT injecting OS keys
 * (macOS-headless has no virtual display, so a real global accelerator can't
 * be exercised deterministically). We drive the exact output of the
 * registrar's callback — `publish(systemAddress, 'cli:peek-open',
 * { args: ['0'] })` — via the `__peek_test.publishSystemTopic` hook, which is
 * literally what the hotkey would do.
 *
 * Determinism (feedback_no_sleep_in_tests_or_code): the cold-wake is
 * synchronized on a REAL FSM transition — `__peek_test.waitForTileState`
 * subscribes to the System-owned `tile:state-changed` observer topic and
 * awaits the peeks tile reaching `ready`. No timers/sleeps; `app.getWindow`
 * timeouts are failure-deadlines, matching existing specs.
 *
 * Run with:
 *   yarn test:grep "Peeks Lazy Wake"
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
 * The source-address that owns a registered global accelerator (or undefined).
 * Reads shortcuts.ts's internal map, which is populated even under headless
 * (where Electron's globalShortcut.register is neutralized).
 */
const globalShortcutSource = (accelerator: string): Promise<string | undefined> =>
  app.evaluateMain!(((_e: unknown, acc: string) => {
    return (globalThis as any).__peek_test.getGlobalShortcutSource(acc) as unknown;
  }) as any, accelerator) as Promise<string | undefined>;

/**
 * Publish `cli:peek-open` with `{ args: [keyNum] }` on the System address —
 * the exact output of the registrar's wakeTopic-style global-hotkey callback
 * for peeks. NOT an OS keypress.
 */
const firePeekOpen = (keyNum: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, k: string) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:peek-open', { args: [k] });
  }) as any, keyNum);

/**
 * Resolve when the `peeks` tile transitions INTO `ready`, observed on the
 * real `tile:state-changed` FSM-mirror topic. Set this up BEFORE firing so
 * the cold-boot transition can't be missed.
 */
const waitPeeksReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('peeks', 'ready', 15000);
  }) as any);

test.describe('Peeks Lazy Wake @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('peeks-lazy-wake'));
    // Gate on core/cmd readiness so the load-on-dispatch hook is wired
    // before we probe.
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // ── (a) peeks tile is NOT resident at boot ─────────────────────────────
  test('peeks tile has no resident window at boot', async () => {
    expect(await windowUrlExists('peek://peeks/')).toBe(false);
    expect(await windowUrlExists('peek://peeks/background.html')).toBe(false);
  });

  // ── (b) the manifest's static default wake hotkey is registered cold,
  //        WITHOUT the renderer running ───────────────────────────────────
  test('the default Option+0 wake hotkey is registered at boot without the renderer', async () => {
    // Sanity: peeks renderer is NOT loaded at the moment we check.
    expect(await windowUrlExists('peek://peeks/')).toBe(false);

    // The registrar owns the manifest default `Option+0` as an OS global
    // accelerator (fresh profile → manifest defaults), tracked under the
    // registrar's `peek://peeks/lazy-shortcut` source.
    const source = await globalShortcutSource('Option+0');
    expect(source).toBe('peek://peeks/lazy-shortcut');

    // Still cold — registering the hotkey must not have woken the tile.
    expect(await windowUrlExists('peek://peeks/')).toBe(false);
  });

  // ── (c) cold wake: the hotkey publish boots the tile (FSM → ready) and
  //        opens the peek window ─────────────────────────────────────────
  test('cli:peek-open {args:["0"]} wakes the lazy tile and opens the peek window', async () => {
    // Precondition: still cold.
    expect(await windowUrlExists('peek://peeks/')).toBe(false);

    // Arm the FSM observer BEFORE firing so the cold-boot READY transition
    // can't race ahead of us. This is the deterministic synchronization point.
    const readyPromise = waitPeeksReady();

    // Drive the registrar's exact callback output for the default hotkey.
    await firePeekOpen('0');

    // Synchronize on the real LOADING → READY transition of the peeks tile.
    const transitionPayload = (await readyPromise) as { tileId: string; to: string };
    expect(transitionPayload.tileId).toBe('peeks');
    expect(transitionPayload.to).toBe('ready');

    // The woken renderer's cli:peek-open handler opens the peek for keyNum 0.
    // Default item 0's address is https://example.com/, so the page-host
    // window's URL carries `example.com`. getWindow's timeout is a
    // failure-deadline, not a settle-wait.
    const peekWindow = await app.getWindow('example.com', 15000);
    expect(peekWindow).toBeTruthy();
  });

  // ── (d) idempotent second wake ──────────────────────────────────────────
  test('a second cli:peek-open {args:["0"]} still resolves to the peek window (already-warm)', async () => {
    // The tile is warm now. Fire again — same registrar output. On an
    // already-warm tile there is no fresh LOADING→READY transition, so we
    // synchronize on the peek window's presence (committed state), not the FSM.
    await firePeekOpen('0');

    const peekWindow = await app.getWindow('example.com', 15000);
    expect(peekWindow).toBeTruthy();
  });
});
