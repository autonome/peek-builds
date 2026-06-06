/**
 * Page Host Navbar Tests (hybrid page-host).
 *
 * Migrated off the canvas `<webview>` page host. Under PEEK_PAGEHOST_HYBRID=1
 * the navbar/chrome lives in a SEPARATE overlay window (not the page window's
 * own DOM), so these assertions drive the content/overlay pair through the
 * shared `openHybridPage` helper instead of poking `#navbar` inside the page.
 *
 * Behavior preserved from the canvas version:
 *  - Loading lifecycle: the navbar reflects the content `page:loading` state
 *    (shown-as-loading during load, cleared after), and the chrome is hidden by
 *    default (no auto-shown navbar lingering after load).
 *  - Cmd+L (forwarded as `page:show-navbar`) reveals the navbar AND focuses its
 *    URL field for typing.
 *  - The revealed navbar schedules an auto-hide when the pointer moves off the
 *    chrome (the hover auto-hide path).
 *  - Trigger-zone hover reveals the navbar.
 *
 * Focus-free: hybrid hosts are headless, opacity-0, never-shown BaseWindows;
 * active-window changes are synthetic; chrome reveal is driven through the
 * renderer's own paths via the E2E bridge — never real OS focus. The describe
 * block skips itself when the hybrid bridge is absent (flag off).
 *
 * Run with:
 *   PEEK_PAGEHOST_HYBRID=1 BACKEND=electron yarn test:electron
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  hybridBridgePresent,
  openHybridPage,
  overlayChromeState,
  revealOverlayChrome,
  scheduleChromeHide,
  sendShowNavbar,
  publishLoading,
  closeHybridPage,
} from '../helpers/hybrid-page';

let app: DesktopApp;

test.beforeAll(async () => {
  ({ app } = await createPerDescribeApp('page-navbar'));
});

test.afterAll(async () => {
  if (app) await app.close();
});

// Deterministic, network-free page content for the hybrid content WC.
const PAGE_HTML = 'data:text/html,<title>Example</title><body>hello page-navbar</body>';

test.describe('Page Navbar @desktop', () => {
  test('navbar reflects the content loading lifecycle and stays hidden by default', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const h = await openHybridPage(app, PAGE_HTML);

    // Simulate the content WC's did-start-loading → the overlay navbar shows
    // the loading state for the active window.
    await publishLoading(app, h, true);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.loading)
      .toBe(true);

    // did-stop-loading → loading cleared.
    await publishLoading(app, h, false);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.loading)
      .toBe(false);

    // The chrome is hidden by default after load — no navbar lingers visible
    // (the canvas version asserted the navbar auto-hid after loading; in the
    // hybrid model the navbar is only ever shown on hover / Cmd+L).
    const state = await overlayChromeState(app, h);
    expect(state).not.toBeNull();
    expect(state!.navbarVisible).toBe(false);

    await closeHybridPage(app, h);
  });

  test('Cmd+L reveals the navbar and focuses its URL field', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const h = await openHybridPage(app, PAGE_HTML);

    // Navbar starts hidden.
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    // Cmd+L → publish page:show-navbar for the active window (same path the
    // content WC's before-input-event forward uses).
    await sendShowNavbar(app, h);

    // Navbar becomes visible AND its URL input takes (shadow-DOM) focus so the
    // user can type immediately. focusUrl() is rAF-deferred, so poll BOTH
    // together (visible can flip a frame before the input takes focus).
    await expect
      .poll(async () => {
        const s = await overlayChromeState(app, h);
        return s ? { vis: s.navbarVisible, focused: s.navbarInputFocused } : null;
      })
      .toEqual({ vis: true, focused: true });

    await closeHybridPage(app, h);
  });

  test('revealed navbar schedules auto-hide when the pointer moves off the chrome', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const h = await openHybridPage(app, PAGE_HTML);

    // Reveal the navbar via Cmd+L.
    await sendShowNavbar(app, h);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(true);

    // Moving the pointer off the chrome (into the content area) schedules the
    // auto-hide — the same hover-leave path the canvas mouseleave drove. We
    // assert the hide is SCHEDULED rather than racing the deferred timer.
    const scheduled = await scheduleChromeHide(app, h);
    expect(scheduled).toBe(true);

    await closeHybridPage(app, h);
  });

  test('trigger-zone hover reveals the navbar', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'hybrid flag off — no overlay bridge');

    const h = await openHybridPage(app, PAGE_HTML);

    // Navbar starts hidden.
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    // Trigger-zone hover → navbar reveals (panels-visible).
    const revealed = await revealOverlayChrome(app, h);
    expect(revealed).toBe(true);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(true);

    await closeHybridPage(app, h);
  });
});
