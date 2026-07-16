/**
 * Triple-click fullscreen round-trip — end-to-end over a REAL hybrid page-host
 * (peek d8ce0ddf). Split out of tests/desktop/hybrid-content-window-gesture.spec.ts.
 *
 * WHY THIS LIVES IN A SEPARATE, EXCLUDED SUITE: this test drives detent-3 of
 * the content-area multi-click gesture, which calls `baseWin.setFullScreen()`
 * — REAL native macOS fullscreen. Native fullscreen allocates its own Space
 * and animates the display; the app's headless test mode works by
 * `setOpacity(0)`, which hides the window but cannot suppress a window-
 * manager-level Space transition. So even "headless", this spec visibly
 * disrupts whoever is sitting at the machine (two Space transitions per run).
 * It is therefore excluded from the normal `desktop` project / the agent-
 * facing `yarn test:desktop:electron` run. Run it deliberately, before a push:
 *
 *   yarn test:desktop:disruptive
 *
 * The other 6 tests in the original file only drive detent-2 (maximize via
 * setBounds), which is NOT disruptive, and stay in tests/desktop/.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { hybridBridgePresent } from '../helpers/hybrid-page';
import { setupGestureHost, type GestureHost } from '../helpers/gesture-host';

// Dispatch ONE click at the center of `sel` with an explicit native multi-click
// `detail` (2 = double → maximize, 3 = triple → fullscreen), real clientX/clientY.
// The fullscreen-desync spec drives detent-2 and detent-3 as SEPARATE sequenced
// clicks (not one JS task) so the maximize round-trip lands between them — the same
// ~150ms inter-click gap a real triple-click has (live trace, peek d8ce0ddf). Firing
// both in one task is unrealistically fast: the overlay round-trip wouldn't finish
// before detent-3's setFullScreen, corrupting preMaxBounds in a way real hardware
// never produces.
function dispatchClickAtCenterSrc(sel: string, detail: number, clearSelection: boolean): string {
  return `(function () {
    ${clearSelection ? 'try { window.getSelection().removeAllRanges(); } catch (_) {}' : ''}
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { fired: false };
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    el.dispatchEvent(new MouseEvent('click', {
      detail: ${detail}, bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y,
    }));
    return { fired: true };
  })()`;
}

test.describe('Hybrid content window gesture — fullscreen @desktop-disruptive', () => {
  let app: DesktopApp;
  let openGestureWindow: GestureHost['openGestureWindow'];
  let runInContent: GestureHost['runInContent'];
  let hostBoundsOf: GestureHost['hostBoundsOf'];
  let workAreaOf: GestureHost['workAreaOf'];
  let fullscreenStateOf: GestureHost['fullscreenStateOf'];
  let teardown: GestureHost['teardown'];

  test.beforeAll(async () => {
    ({ app, openGestureWindow, runInContent, hostBoundsOf, workAreaOf, fullscreenStateOf, teardown } =
      await setupGestureHost('hybrid-content-window-gesture-fullscreen'));
  });

  test.afterAll(async () => {
    await teardown();
  });

  test('triple-click fullscreen round-trip restores the pre-gesture bounds (not stuck maximized)', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    // The d8ce0ddf follow-up. Reported steps: from a normal-sized window, a
    // triple-click maximizes (detent-2) then goes fullscreen (detent-3); a SECOND
    // triple-click must return the window to where it was — its normal bounds — NOT
    // leave it maximized ("triple-click there should go back to where i was, not to
    // maximized"). A triple-click is a TOGGLE, so the incidental detent-2 maximize
    // is undone on the way out: the exit detent-2 is suppressed while fullscreen
    // (the !isFullScreen() gate keeps maximized+preMaxBounds intact), then the host's
    // leave-full-screen handler un-maximizes back to preMaxBounds once macOS has
    // SETTLED the exit — so the restore setBounds isn't dropped (macOS won't resize a
    // fullscreen window). Deterministic, event-driven, no timer.
    const { id, wcId } = await openGestureWindow();
    const workArea = await workAreaOf(id);
    const normal = await hostBoundsOf(id);
    expect(workArea).not.toBeNull();
    expect(normal).not.toBeNull();
    // The fresh window is a normal, non-maximized size — so "back to normal" below
    // is a meaningful signal, not vacuously true.
    expect(normal).not.toEqual(workArea);

    // ENTER, as a real triple-click does it: detent-2 maximizes; the maximize round-
    // trip lands (the real inter-click gap); THEN detent-3 goes fullscreen.
    await runInContent(wcId, dispatchClickAtCenterSrc('#dead', 2, true)); // detent-2 → maximize
    await expect.poll(() => hostBoundsOf(id)).toEqual(workArea);
    // preMaxBounds captured the REAL normal bounds (round-trip finished pre-fullscreen).
    {
      const s = await fullscreenStateOf(id);
      expect(s!.maximized).toBe(true);
      expect(s!.preMaxBounds).toEqual(normal);
    }
    await runInContent(wcId, dispatchClickAtCenterSrc('#dead', 3, true)); // detent-3 → fullscreen
    // Wait for the native macOS fullscreen animation to SETTLE. We poll
    // `nativeFullScreen` (flips on the enter-full-screen event, ~600ms later), NOT
    // `isFullScreen()` (flips synchronously the instant setFullScreen is called) —
    // acting mid-animation, as an isFullScreen()-poll would, corrupts the OS
    // transition and is nothing a real user (seconds between clicks) ever does.
    await expect.poll(() => fullscreenStateOf(id).then((s) => s?.nativeFullScreen ?? null)).toBe(true);

    // EXIT, triple-click again: detent-2 arrives while STILL fullscreen (the gate
    // suppresses the maximize-toggle here), then detent-3 leaves fullscreen. The
    // window stays continuously active throughout (single-session repro), so we do
    // NOT re-activate — re-firing page-overlay:active would clobber the overlay's
    // own maximized flag (a separate divergence bug) and mask this one.
    await runInContent(wcId, dispatchClickAtCenterSrc('#dead', 2, true)); // detent-2 → suppressed (fullscreen)
    await runInContent(wcId, dispatchClickAtCenterSrc('#dead', 3, true)); // detent-3 → leave fullscreen
    await expect.poll(() => fullscreenStateOf(id).then((s) => s?.nativeFullScreen ?? null)).toBe(false);

    // THE regression assertion. Leaving fullscreen fires the host's leave-full-screen
    // handler, which un-maximizes back to the pre-gesture bounds (page:unmaximize,
    // main-side — it doesn't depend on the overlay being active/focused, so it's
    // observable even under the macOS-headless focus artifact). That reconcile is
    // async (a pubsub round-trip after the settled exit), so we POLL: the window ends
    // at its NORMAL bounds, not maximized, with preMaxBounds cleared. Pre-fix the exit
    // left it stuck at the work area (maximized=true, bounds==workArea) — exactly the
    // reported "goes to maximized, not back to where I was" — so this block fails
    // pre-fix.
    await expect.poll(() => hostBoundsOf(id)).toEqual(normal);
    {
      const s = await fullscreenStateOf(id);
      expect(s!.isFullScreen).toBe(false);
      expect(s!.maximized).toBe(false);
      expect(s!.preMaxBounds).toBeNull();
    }
  });
});
