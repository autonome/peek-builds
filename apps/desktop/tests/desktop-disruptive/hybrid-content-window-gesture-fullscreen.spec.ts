/**
 * Command-driven fullscreen round-trip over a REAL hybrid page-host (peek 7fffa286).
 *
 * Fullscreen is NO LONGER a content gesture (triple-click was removed). It is
 * single-owned by main: the `fullscreen` command → `tile:window:fullscreen` IPC →
 * `setHybridHostFullScreen`, which drives `baseWin.setFullScreen()` and gates on the
 * SETTLED native fullscreen state (the `enter-`/`leave-full-screen` events), never
 * `isFullScreen()` (which flips synchronously mid-animation). This spec drives that
 * owner directly through the overlay test bridge's `driveHostFullscreen(id, desired)`
 * — the exact code the command runs — without fabricating a token/grant.
 *
 * WHY THIS LIVES IN A SEPARATE, EXCLUDED SUITE: it drives REAL native macOS
 * fullscreen. Native fullscreen allocates its own Space and animates the display;
 * the app's headless test mode works by `setOpacity(0)`, which hides the window but
 * cannot suppress a window-manager-level Space transition. So even "headless", this
 * spec visibly disrupts whoever is at the machine (Space transitions per run). It is
 * therefore excluded from the normal `desktop` project / `yarn test:desktop:electron`.
 * Run it deliberately, before a push:
 *
 *   yarn test:desktop:disruptive
 *
 * The double-click → maximize gesture (NOT disruptive: setBounds, no Space change)
 * stays in tests/desktop/hybrid-content-window-gesture.spec.ts.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { hybridBridgePresent } from '../helpers/hybrid-page';
import { setupGestureHost, type GestureHost } from '../helpers/gesture-host';

test.describe('Hybrid page-host fullscreen — command owner @desktop-disruptive', () => {
  let app: DesktopApp;
  let openGestureWindow: GestureHost['openGestureWindow'];
  let fullscreenStateOf: GestureHost['fullscreenStateOf'];
  let teardown: GestureHost['teardown'];

  // Drive the single fullscreen owner (setHybridHostFullScreen) through the overlay
  // test bridge — the exact transition the `fullscreen` command runs. Resolves once
  // the native transition settles (or the owner's bounded timeout fires).
  const driveFullscreen = (id: number, desired: boolean) =>
    app.evaluateMain!((_e, arg: { id: number; desired: boolean }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.driveHostFullscreen(arg.id, arg.desired);
    }, { id, desired });

  test.beforeAll(async () => {
    ({ app, openGestureWindow, fullscreenStateOf, teardown } =
      await setupGestureHost('hybrid-content-window-gesture-fullscreen'));
  });

  test.afterAll(async () => {
    await teardown();
  });

  test('command owner enters and leaves native fullscreen, settling on the native events', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id } = await openGestureWindow();

    // Fresh window is not fullscreen.
    {
      const s = await fullscreenStateOf(id);
      expect(s!.nativeFullScreen).toBe(false);
    }

    // ENTER via the owner. It awaits the `enter-full-screen` event, so once
    // driveFullscreen resolves the SETTLED nativeFullScreen flag is already true.
    // (Poll anyway — the flag is driven by the same event the owner awaits.)
    await driveFullscreen(id, true);
    await expect
      .poll(() => fullscreenStateOf(id).then((s) => s?.nativeFullScreen ?? null))
      .toBe(true);

    // Idempotent: entering again while already fullscreen is an immediate no-op
    // (the owner short-circuits on the settled state — it never calls setFullScreen
    // again, so no spurious transition).
    await driveFullscreen(id, true);
    expect((await fullscreenStateOf(id))!.nativeFullScreen).toBe(true);

    // LEAVE via the owner — gates on the `leave-full-screen` event, no orphan Space.
    await driveFullscreen(id, false);
    await expect
      .poll(() => fullscreenStateOf(id).then((s) => s?.nativeFullScreen ?? null))
      .toBe(false);
  });

  test('closing a fullscreen host exits fullscreen first (no stranded black Space)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const { id } = await openGestureWindow();

    // Enter fullscreen through the owner and let it settle.
    await driveFullscreen(id, true);
    await expect
      .poll(() => fullscreenStateOf(id).then((s) => s?.nativeFullScreen ?? null))
      .toBe(true);

    // Close through the SAME production route (closeOrHideWindow, via the bridge's
    // closeOrHideHybrid). Its hybrid branch awaits setHybridHostFullScreen(id, false)
    // BEFORE the terminal close, so macOS leaves fullscreen instead of stranding a
    // black Space around a destroyed host. Awaitable now that closeOrHideWindow is
    // async.
    await app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.closeOrHideHybrid(wid);
    }, id);

    // The host is gone (closed, not left in a fullscreen Space). fullscreenStateOf
    // returns null once the registry entry is dropped.
    await expect.poll(() => fullscreenStateOf(id)).toBeNull();
  });
});
