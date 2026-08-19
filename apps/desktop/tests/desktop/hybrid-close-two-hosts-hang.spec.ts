/**
 * Regression: closing a peek with ESC while two hybrid page-host windows are
 * open underneath wedges the main process at 100% CPU (macOS, no diagnostic
 * env vars needed — confirmed twice by `sample`: the whole main thread sits in
 * ONE synchronous JS call, from `node::Environment::RunTimers`, doing endless
 * `NSWindow` order-out).
 *
 * Mechanism (`window-kernel-executor.ts` `pump`, `window-kernel.ts` `react`):
 * closing the peek changes which base-layer page-host `topmostBaseLayerPageHost`
 * names, so `react` emits BOTH `AttachOverlayTo(overlay, nextTarget)` and
 * `HideWindow(overlay)` off the same transition. The attach path's
 * `overlayFollowPatch` sees `!overlay.visible && appActive` and writes
 * `visible: true` -> `ShowWindow`; the queued hide echo then writes
 * `visible: false` -> `HideWindow`. Each re-arms the other. `pump`'s `pumping`
 * latch stops recursion but not refill — the queue never empties, so this is
 * ONE unbroken synchronous call that never returns control to the OS. It
 * terminates only when `nextTarget` is null, which needs NO base-layer page
 * host to survive — hence two page hosts (so one survives the peek's close)
 * reproduce it and one does not.
 *
 * SAFETY: driving the real close for real would wedge this runner exactly like
 * it wedges the app — `showWindow`/`hideWindow` echo synchronously back into
 * the executor's `dispatch` regardless of headless, so nothing short-circuits
 * it naturally. Before triggering the close, this spec installs a test-only
 * circuit breaker (`capKernelBackendEchoForTest`, `hybrid-overlay.ts`) that
 * caps the LIVE backend's `showWindow`/`hideWindow`/`attachOverlayTo` calls —
 * every call past the cap returns before touching the OS and before the
 * synchronous echo that feeds the ping-pong, so the drive is real (same
 * kernel, same backend, same close path) but bounded. The assertion reads the
 * real kernel timeline (`window-kernel-executor.ts` `timelineForTests`,
 * bounded at 400 entries, gated on `E2E_TEST`) rather than depending on the
 * process staying responsive — it fails fast on a runaway transition count,
 * never on a wall-clock timeout.
 *
 * Do NOT raise the cap or remove the breaker to "get a truer repro" — that is
 * exactly the unbounded loop this file exists to avoid triggering for real.
 *
 * Headless grants no real OS focus, so opening the peek never moves the old
 * machine's `front` (what `decideEscape` targets) onto it by itself — the
 * spec drives the real native 'focus' event on its host BaseWindow
 * (`focusHybridWindowForTest`) before closing, same as other hybrid-focus
 * specs under macOS-headless.
 *
 * Run with:
 *   yarn test:grep "Hybrid two-host peek-close overlay runaway"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

// Per-backend-method call budget for the circuit breaker. Generous enough
// that a real runaway blows well past SANE_TRANSITION_BOUND before the cap
// bites, small enough that draining it is instant.
const BACKEND_CALL_CAP = 25;

// A normal peek close over two surviving page hosts is a handful of kernel
// transitions (the close itself, at most one legitimate overlay retarget, at
// most one settle show/hide). A runaway blows past this immediately.
const SANE_TRANSITION_BOUND = 12;

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Hybrid two-host peek-close overlay runaway @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-close-two-hosts-hang'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><title>host</title><body>host</body>');
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

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('closing a peek over two surviving page hosts stays within a sane transition bound', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');
    // Belt-and-suspenders per the module header: if the circuit breaker
    // somehow fails to contain the runaway, fail on a short timeout rather
    // than hang the runner.
    test.setTimeout(30_000);

    // ── Stage: two REAL hybrid page-host windows on http:// URLs. `data:`/
    // `peek://` never gate the `content` role (`izui-roles.ts inferIzuiRole`
    // requires `isWebPage`), so both must be real http.
    const openHost = (path: string) =>
      bgWindow.evaluate(async (url: string) => {
        return (window as any).app.window.open(url, { width: 600, height: 400 });
      }, `http://127.0.0.1:${serverPort}/${path}`);

    const openA = await openHost('a');
    expect(openA.success).toBe(true);
    const openB = await openHost('b');
    expect(openB.success).toBe(true);

    const hostIds = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hybridIds() as number[];
    });
    expect(hostIds.length).toBeGreaterThanOrEqual(2);

    // ── Stage: a real peek, opened through the peeks feature (same pattern as
    // peeks-lazy-wake.spec.ts). Slot 0 defaults to https://example.com/
    // (features/peeks/config.js).
    const readyPromise = app.evaluateMain!(() => {
      return (globalThis as any).__peek_test.waitForTileState('peeks', 'ready', 15000);
    });
    await app.evaluateMain!(() => {
      (globalThis as any).__peek_test.publishSystemTopic('cli:peek-open', { args: ['0'] });
    });
    await readyPromise;
    const peekWindow = await app.getWindow('example.com', 15000);
    expect(peekWindow).toBeTruthy();

    const peekId = await app.evaluateMain!(
      ((_e: unknown, before: number[]) => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return b.waitHybridForUrl('https://example.com/', before, 8000) as Promise<number | null>;
      }) as any,
      hostIds,
    );
    expect(peekId, 'the peek should register as a hybrid window').not.toBeNull();

    // Headless grants no real OS focus, so the old machine's `front` (what
    // `decideEscape` targets — landedId is first-responder noise, see
    // window-state.ts decideEscape) never moved to the peek on open. Drive the
    // REAL native 'focus' event on its host BaseWindow (same technique
    // session-restore-page-host.spec.ts uses via `focusHybridWindowForTest`) so
    // the genuine focus-tracker wiring resolves `front` to the peek — without
    // touching the two page hosts underneath (unlike the bridge's `setActive`,
    // which drains/hides every base-layer page host as a side effect).
    const focused = await app.evaluateMain!(
      ((_e: unknown, id: number) => (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as any,
      peekId,
    );
    expect(focused).toBe(true);

    // Mark the timeline so the post-close read counts only transitions the
    // close itself produced.
    await app.evaluateMain!(() => {
      (globalThis as any).__peekHybridOverlayTest.markKernelTimeline('before-esc-close');
    });

    // ── Install the circuit breaker, THEN drive the close through the real
    // ESC policy path (same technique as hybrid-escape-close.spec.ts —
    // headless has no OS keypress to inject).
    await app.evaluateMain!((_e: unknown, cap: number) => {
      (globalThis as any).__peekHybridOverlayTest.capKernelBackendEchoForTest(cap);
    }, BACKEND_CALL_CAP);

    await app.evaluateMain!(
      ((_e: unknown, id: number) => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        return b.runHybridEscape(id) as Promise<number | null>;
      }) as any,
      peekId,
    );

    const timeline = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.kernelTimeline() as string[];
    });
    const markerIndex = timeline.findIndex((line: string) => line.includes('before-esc-close'));
    expect(markerIndex, 'the before-close marker should still be on the timeline').toBeGreaterThanOrEqual(0);
    const transitionsAfterClose = timeline.length - markerIndex - 1;

    // CORE assertion: pre-fix, the AttachOverlayTo/ShowWindow/HideWindow
    // ping-pong runs until the circuit breaker's cap silences the echo, so
    // this count sits near BACKEND_CALL_CAP — far past a sane close. Post-fix
    // a normal close stays in single digits.
    expect(transitionsAfterClose).toBeLessThan(SANE_TRANSITION_BOUND);
  });
});
