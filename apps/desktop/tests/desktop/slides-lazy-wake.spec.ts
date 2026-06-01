/**
 * Slides Lazy Wake
 *
 * The `slides` feature was converted from a resident background tile to a
 * LAZY tile (peek epic d8e7efa5 / peek task 921b54b3, STEP 4 — the final
 * conversion; after it there are NO resident feature bg tiles left). Its
 * background renderer no longer exists at boot, so it can no longer register
 * its own per-edge global hotkeys. Instead:
 *
 *   - At boot, the generic main-side feature-shortcut-registrar
 *     (apps/desktop/main/feature-shortcut-registrar.ts) registers the slides
 *     manifest's STATIC DEFAULT wake-shortcut — `Option+Up` → publishes
 *     `cli:slide-open` with `{ args: ['Up'] }` on the System address. (User
 *     customizations, once declared via `api.shortcuts.declareWakeShortcuts`,
 *     are persisted and take precedence; a fresh profile uses the manifest
 *     default — only the `Up` slide is enabled by default.)
 *   - That publish flows through the load-on-dispatch hook (slides declares
 *     `cli:slide-open` in `lazyEvents`), which boots the slides tile, waits
 *     for READY, then lets the publish reach the renderer's freshly-
 *     subscribed `cli:slide-open` handler — which opens the matching slide.
 *
 * It also pins the IDENTITY contract that makes the lazy conversion safe: the
 * in-renderer `slideWindows` Map is NOT load-bearing across a wake/unload
 * cycle. Window identity is owned by main's `(source, key)` dedup
 * (findWindowByKey, main.ts) where slides' key is `address:edge`. So
 * reopening a CLOSED key yields a NEW window (no stale Map reuse), while
 * reopening a STILL-OPEN key reuses the live window.
 *
 * Determinism (feedback_no_sleep_in_tests_or_code): the cold-wake is
 * synchronized on a REAL FSM transition — `__peek_test.waitForTileState`
 * awaits the slides tile reaching `ready`. The close/reopen regression polls
 * the live main-process window set until the closed window is absent. No
 * timers/sleeps; `app.getWindow` timeouts are failure-deadlines.
 *
 * Run with:
 *   yarn test:grep "Slides Lazy Wake"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

/** True iff any live BrowserWindow's URL contains the given substring. */
const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/** True iff a BrowserWindow with the given id is still live (not destroyed). */
const windowIdLive = (id: number): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), wid: number) => {
    const { BrowserWindow } = electron;
    const w = BrowserWindow.fromId(wid);
    return !!(w && !w.isDestroyed());
  }) as any, id) as Promise<boolean>;

/** Resolve once the BrowserWindow with the given id is gone (destroyed). */
const waitWindowIdGone = (id: number): Promise<void> =>
  app.evaluateMain!(((electron: typeof import('electron'), wid: number) => {
    const { BrowserWindow } = electron;
    return new Promise<void>((resolve) => {
      const check = () => {
        const w = BrowserWindow.fromId(wid);
        if (!w || w.isDestroyed()) { resolve(); return; }
        setImmediate(check);
      };
      check();
    });
  }) as any, id) as Promise<void>;

/**
 * The source-address that owns a registered global accelerator (or undefined).
 * Reads shortcuts.ts's internal map, populated even under headless.
 */
const globalShortcutSource = (accelerator: string): Promise<string | undefined> =>
  app.evaluateMain!(((_e: unknown, acc: string) => {
    return (globalThis as any).__peek_test.getGlobalShortcutSource(acc) as unknown;
  }) as any, accelerator) as Promise<string | undefined>;

/**
 * Publish `cli:slide-open` with `{ args: [edge] }` on the System address —
 * the exact output of the registrar's wake-hotkey callback for slides.
 * NOT an OS keypress.
 */
const fireSlideOpen = (edge: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, e: string) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [e] });
  }) as any, edge);

/**
 * Resolve when the `slides` tile transitions INTO `ready`, observed on the
 * real `tile:state-changed` FSM-mirror topic. Set up BEFORE firing.
 */
const waitSlidesReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('slides', 'ready', 15000);
  }) as any);

/**
 * Open a slide-style window directly via the window-open pipeline, mirroring
 * what features/slides/background.js passes for the given edge (key =
 * address:edge — the slides identity contract). Returns the window id.
 * `show:false` to avoid natural WM focus churn (see slides.spec.ts).
 */
const openSlideForEdge = (edge: string, address: string): Promise<number> =>
  bgWindow.evaluate(async (args: { edge: string; addr: string }) => {
    const result = await (window as any).app.window.open(args.addr, {
      role: 'quick-view',
      address: args.addr,
      modal: true,
      type: 'panel',
      width: 600,
      height: 400,
      key: `${args.addr}:${args.edge}`,
      screenEdge: args.edge,
      show: false,
    });
    if (!result.success) throw new Error(`slide open failed: ${JSON.stringify(result)}`);
    return result.id as number;
  }, { edge, addr: address });

const closeWindowId = (id: number): Promise<void> =>
  bgWindow.evaluate(async (wid: number) => {
    await (window as any).app.window.close(wid);
  }, id);

test.describe('Slides Lazy Wake @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-lazy-wake'));

    // Stand up a trivial local http server so test (d) has a LOADABLE,
    // distinct slide address (an unresolvable DNS host makes app.window.open
    // return success:false). Mirrors boot-window-inventory.spec.ts.
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // Gate on core/cmd readiness so the load-on-dispatch hook is wired
    // before we probe.
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  // ── (a) slides tile is NOT resident at boot ────────────────────────────
  test('slides tile has no resident window at boot', async () => {
    expect(await windowUrlExists('peek://slides/')).toBe(false);
    expect(await windowUrlExists('peek://slides/background.html')).toBe(false);
  });

  // ── (b) the manifest's static default wake hotkey is registered cold,
  //        WITHOUT the renderer running ───────────────────────────────────
  test('the default Option+Up wake hotkey is registered at boot without the renderer', async () => {
    // Sanity: slides renderer is NOT loaded at the moment we check.
    expect(await windowUrlExists('peek://slides/')).toBe(false);

    // The registrar owns the manifest default `Option+Up` as an OS global
    // accelerator (fresh profile → manifest defaults), tracked under the
    // registrar's `peek://slides/lazy-shortcut` source.
    const source = await globalShortcutSource('Option+Up');
    expect(source).toBe('peek://slides/lazy-shortcut');

    // Still cold — registering the hotkey must not have woken the tile.
    expect(await windowUrlExists('peek://slides/')).toBe(false);
  });

  // ── (c) cold wake: the hotkey publish boots the tile (FSM → ready) and
  //        opens the slide window ───────────────────────────────────────
  test('cli:slide-open {args:["Up"]} wakes the lazy tile and opens the slide window', async () => {
    // Precondition: still cold.
    expect(await windowUrlExists('peek://slides/')).toBe(false);

    // Arm the FSM observer BEFORE firing so the cold-boot READY transition
    // can't race ahead. This is the deterministic synchronization point.
    const readyPromise = waitSlidesReady();

    // Drive the registrar's exact callback output for the default hotkey.
    await fireSlideOpen('Up');

    // Synchronize on the real LOADING → READY transition of the slides tile.
    const transitionPayload = (await readyPromise) as { tileId: string; to: string };
    expect(transitionPayload.tileId).toBe('slides');
    expect(transitionPayload.to).toBe('ready');

    // The woken renderer's cli:slide-open handler opens the slide for edge Up.
    // The default 'Up' item's address is http://localhost/, so the page-host
    // window's URL carries `localhost`. getWindow's timeout is a failure-
    // deadline, not a settle-wait.
    const slideWindow = await app.getWindow('localhost', 15000);
    expect(slideWindow).toBeTruthy();
  });

  // ── (d) Map-removal regression: identity is MAIN-owned across a wake
  //        cycle. close → gone → reopen yields a NEW id; reopen while still
  //        open reuses the live window. ────────────────────────────────────
  test('main owns window identity: closed key reopens fresh, open key reuses', async () => {
    // slides is awake now (from the previous test). Drive the window-open
    // pipeline with the slides identity contract (key = address:edge) — same
    // params slides emit. Using a distinct address so this test owns its key.
    const addr = `http://127.0.0.1:${serverPort}/slide-identity`;

    // Open edge=Up.
    const first = await openSlideForEdge('Up', addr);
    expect(await windowIdLive(first)).toBe(true);

    // Reopen the SAME edge while still open → main dedup reuses the live id.
    const reuse = await openSlideForEdge('Up', addr);
    expect(reuse).toBe(first);

    // Close it (core close), then confirm it's gone from the live window set.
    await closeWindowId(first);
    await waitWindowIdGone(first);
    expect(await windowIdLive(first)).toBe(false);

    // Reopen the SAME edge after close → main treats the closed key as gone,
    // so a NEW window id is allocated (no stale Map reuse from the renderer).
    const reopened = await openSlideForEdge('Up', addr);
    expect(reopened).not.toBe(first);
    expect(await windowIdLive(reopened)).toBe(true);

    await closeWindowId(reopened);
  });
});
