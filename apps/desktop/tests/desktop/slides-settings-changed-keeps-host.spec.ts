/**
 * Regression guard (peek 42fff0a5): toggling a slide's keepLive checkbox must
 * NOT tear down an already-open slide's hybrid page-host.
 *
 * The Features-Manager `save()` (features-manager/manage.js) writes the feature's
 * `prefs` + `items` rows to `feature_settings` and then publishes the GLOBAL
 * `slides:settings-changed` (empty payload). The slides background subscribes to
 * that topic and runs `reinit()` — `uninit()` (drop LOCAL fallback shortcuts +
 * clear the in-renderer window cache; it deliberately does NOT close open
 * windows) → `loadSettings()` → `initItems()` (re-`declareWakeShortcuts`). None
 * of that closes/recreates/reloads an open slide's page-host: window identity is
 * owned by main's window registry, untouched by reinit. This test pins that
 * invariant so a future change that reacts to settings-changed by tearing down a
 * live host is caught.
 *
 * Focus-free / network-light: opens the slide through the REAL slides wake path
 * (`cli:slide-open`), captures the resulting hybrid host's window id + content
 * WebContents id, fires the exact save() write, and asserts the host survives
 * with the SAME content wc (no reload / re-nav / recreate).
 *
 * Run with:
 *   yarn test:grep "settings-changed keeps an open slide hybrid page-host"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

// The slide under test. Its ONLY change across the settings write is keepLive
// false → true (exactly what the checkbox does).
const SLIDE_EDGE = 'Right';
const PREFIX = 'Option+';

// Deterministic-barrier lever (see the settle wait below). The settings write
// ALSO enables a SECOND slide on a different edge — a change a real combined
// save could make. reinit()'s `declareWakeShortcuts` then registers that edge's
// global wake accelerator, which was NOT registered before: an edge-triggered,
// observable downstream effect of reinit that we synchronize the negative
// assertion on. It does NOT open a window (reinit never executes an item).
const BARRIER_EDGE = 'Left';
const BARRIER_ACCEL = `${PREFIX}${BARRIER_EDGE}`; // 'Option+Left'

test.describe('Slides settings-changed keeps an open slide hybrid page-host @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-settings-changed-keeps-host'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
            `<body><h1>${req.url}</h1></body></html>`,
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  const bridgePresent = async (): Promise<boolean> =>
    app.evaluateMain!(
      () =>
        Boolean((globalThis as any).__peekHybridOverlayTest) &&
        Boolean((globalThis as any).__peek_test),
    ) as Promise<boolean>;

  /**
   * Write the slides `feature_settings` rows exactly as manage.js save() does:
   * a `slides:prefs` row and a `slides:items` row (values JSON-stringified, the
   * settings layer parses on read). Returns both setRow results.
   */
  const writeSlideSettings = (
    items: unknown[],
    prefs: Record<string, unknown>,
  ): Promise<{ r1: { success: boolean }; r2: { success: boolean } }> =>
    bgWindow.evaluate(
      async ({ items, prefs }: { items: unknown[]; prefs: Record<string, unknown> }) => {
        const api = (window as any).app;
        const now = Date.now();
        const r1 = await api.datastore.setRow('feature_settings', 'slides:items', {
          featureId: 'slides',
          key: 'items',
          value: JSON.stringify(items),
          updatedAt: now,
        });
        const r2 = await api.datastore.setRow('feature_settings', 'slides:prefs', {
          featureId: 'slides',
          key: 'prefs',
          value: JSON.stringify(prefs),
          updatedAt: now,
        });
        return { r1, r2 };
      },
      { items, prefs },
    ) as Promise<{ r1: { success: boolean }; r2: { success: boolean } }>;

  const slide = (edge: string, address: string, keepLive: boolean) => ({
    screenEdge: edge,
    title: `${edge} slide`,
    address,
    persistState: false,
    keepLive,
    allowSound: false,
    height: 400,
    width: 600,
    enabled: true,
  });

  test('firing slides:settings-changed (keepLive flip) does NOT close/recreate an open slide hybrid host', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid overlay / test bridge in this configuration');

    const address = `http://127.0.0.1:${serverPort}/keeplive-guard`;

    // 1. Seed ONE enabled slide (keepLive:false), default prefix — slides is a
    //    lazy tile; this write does not wake it.
    const seed = await writeSlideSettings(
      [slide(SLIDE_EDGE, address, /* keepLive */ false)],
      { shortcutKeyPrefix: PREFIX },
    );
    expect(seed.r1.success).toBe(true);
    expect(seed.r2.success).toBe(true);

    // 2. Open it through the REAL slides wake path (the global-hotkey callback's
    //    output). Cold-wake delivers this to the tile via the load-on-dispatch
    //    hook; the fixed settings-race guard (settingsLoaded) makes the first
    //    press open reliably.
    await app.evaluateMain!(
      ((_e: unknown, edge: string) => {
        (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [edge] });
      }) as any,
      SLIDE_EDGE,
    );

    // Deterministic wait for the hybrid page-host (matched by requested address),
    // not a timer — returns its window id or null on the failure deadline.
    const windowId = (await app.evaluateMain!(
      ((_e: unknown, u: string) =>
        (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(u, [], 15000)) as any,
      address,
    )) as number | null;
    expect(windowId, 'the slide must open as a registered hybrid page-host').not.toBeNull();

    // Hybrid-only outcome — skip cleanly if this config didn't produce a hybrid
    // page-host (same guard the hybrid-close-leak / overlay specs use).
    const isHybrid = (await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any,
      windowId,
    )) as boolean;
    test.skip(!isHybrid, 'slide did not open as a hybrid page-host in this config');

    // Capture the content WebContents id + prove it's alive BEFORE the change.
    const contentWcBefore = (await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.getHybridContentWcIdForTest(id)) as any,
      windowId,
    )) as number | null;
    expect(contentWcBefore, 'a live hybrid host must expose its content wc id').not.toBeNull();

    const aliveBefore = (await app.evaluateMain!(
      ((_e: unknown, wc: number) =>
        (globalThis as any).__peek_test.isWebContentsAliveForTest(wc)) as any,
      contentWcBefore,
    )) as boolean;
    expect(aliveBefore, 'content wc must be alive before the settings change').toBe(true);

    // Barrier precondition: the second edge's wake accelerator is NOT yet
    // registered (only the opened slide's SLIDE_EDGE was declared at wake). This
    // makes the settle wait below a true undefined→defined edge, not a
    // pre-satisfied condition.
    const barrierBefore = (await app.evaluateMain!(
      ((_e: unknown, a: string) =>
        (globalThis as any).__peek_test.getGlobalShortcutSource(a)) as any,
      BARRIER_ACCEL,
    )) as string | undefined;
    expect(
      barrierBefore,
      `barrier accelerator ${BARRIER_ACCEL} must be unregistered before the settings change`,
    ).toBeFalsy();

    // 3. Fire the settings write manage.js save() performs: rewrite the items row
    //    (SLIDE_EDGE keepLive flipped true — the checkbox — plus the BARRIER_EDGE
    //    slide enabled) and the prefs row, then publish the GLOBAL, empty-payload
    //    slides:settings-changed. This is exactly what the Features-Manager emits.
    const barrierAddress = `http://127.0.0.1:${serverPort}/barrier`;
    const write = await writeSlideSettings(
      [slide(SLIDE_EDGE, address, /* keepLive */ true), slide(BARRIER_EDGE, barrierAddress, false)],
      { shortcutKeyPrefix: PREFIX },
    );
    expect(write.r1.success).toBe(true);
    expect(write.r2.success).toBe(true);

    await app.evaluateMain!(
      ((_e: unknown) => {
        (globalThis as any).__peek_test.publishSystemTopic('slides:settings-changed', {});
      }) as any,
    );

    // DETERMINISTIC SETTLE BARRIER (fsm-pilled — load-bearing for this NEGATIVE
    // assertion). We must not assert "the host survived" until the
    // settings-changed handler has actually processed, or the test is a
    // false-green. We do NOT sleep: we wait on a real edge-triggered downstream
    // effect of reinit() — its `declareWakeShortcuts` round-tripping through main
    // and REGISTERING the BARRIER_EDGE global wake accelerator (unregistered
    // before this write, per the precondition above). That registration happens
    // in initItems(), which runs strictly AFTER uninit() — so once it's
    // observable, any window teardown reinit was going to do has already
    // happened (it does none). expect.poll here is a bounded condition-wait with
    // a failure deadline (the sanctioned pattern, same as waitHybridForUrl /
    // getWindow(timeout)), NOT an arbitrary settle timer.
    await expect
      .poll(
        async () =>
          (await app.evaluateMain!(
            ((_e: unknown, a: string) =>
              (globalThis as any).__peek_test.getGlobalShortcutSource(a)) as any,
            BARRIER_ACCEL,
          )) as string | undefined,
        {
          timeout: 15000,
          message: 'reinit() never re-declared the slides wake accelerator after settings-changed',
        },
      )
      .toBeTruthy();

    // 4. The open slide's hybrid host SURVIVED settings-changed.
    const existsAfter = (await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peekHybridOverlayTest.hybridWindowExists(id)) as any,
      windowId,
    )) as boolean;
    expect(
      existsAfter,
      'settings-changed (keepLive flip) must NOT close/destroy the open slide host',
    ).toBe(true);

    // The content WebContents was NOT recreated (same id → no reload / re-nav).
    const contentWcAfter = (await app.evaluateMain!(
      ((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.getHybridContentWcIdForTest(id)) as any,
      windowId,
    )) as number | null;
    expect(
      contentWcAfter,
      'the content webContents must NOT be recreated (same wc id → no reload/re-navigate)',
    ).toBe(contentWcBefore);

    // ...and the original content renderer is still alive.
    const aliveAfter = (await app.evaluateMain!(
      ((_e: unknown, wc: number) =>
        (globalThis as any).__peek_test.isWebContentsAliveForTest(wc)) as any,
      contentWcBefore,
    )) as boolean;
    expect(aliveAfter, 'the original content renderer must still be alive').toBe(true);
  });
});
