/**
 * Page Host Navbar Tests (hybrid page-host).
 *
 * Migrated off the canvas `<webview>` page host. On the hybrid page-host
 * the navbar/chrome lives in a SEPARATE overlay window (not the page window's
 * own DOM), so these assertions drive the content/overlay pair through the
 * shared `openHybridPage` helper instead of poking `#navbar` inside the page.
 *
 * Behavior preserved from the canvas version:
 *  - Loading lifecycle: the navbar reflects the content `page:loading` state
 *    (shown-as-loading during load, cleared after).
 *  - A page window appearing, or its page navigating, shows the navbar for at
 *    least a 1500 ms dwell or until the load settles, whichever is later; then
 *    it hides (no navbar lingering after load).
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
 *   BACKEND=electron yarn test:electron
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
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

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

    // The chrome hides once the load has settled and the dwell has run — the
    // bar the load showed does not linger.
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    await closeHybridPage(app, h);
  });

  // The dwell (navbar-load-reveal.js LOAD_REVEAL_DWELL_MS) is 1500 ms. A check
  // at 900 ms after the reveal is inside it with margin for bridge round trips.
  const INSIDE_DWELL_MS = 900;

  test('a page whose load finished before its window appeared still shows the navbar for the dwell', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    // openHybridPage loads the content to completion, then makes the window
    // active: the chrome reaches a window whose page is no longer loading.
    const h = await openHybridPage(app, PAGE_HTML);
    expect((await overlayChromeState(app, h))?.navbarVisible).toBe(true);
    await new Promise((r) => setTimeout(r, INSIDE_DWELL_MS));
    expect((await overlayChromeState(app, h))?.navbarVisible).toBe(true);

    // After the dwell it hides.
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    await closeHybridPage(app, h);
  });

  test('a fast navigation in the same window (link click, back) shows the navbar again for the dwell', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    // A cached navigation: the load starts and finishes almost at once.
    await publishLoading(app, h, true);
    await publishLoading(app, h, false);
    expect((await overlayChromeState(app, h))?.navbarVisible).toBe(true);
    await new Promise((r) => setTimeout(r, INSIDE_DWELL_MS));
    expect((await overlayChromeState(app, h))?.navbarVisible).toBe(true);

    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    await closeHybridPage(app, h);
  });

  test('a window reopened on the same page (undo close) shows the navbar', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const first = await openHybridPage(app, PAGE_HTML);
    await expect
      .poll(async () => (await overlayChromeState(app, first))?.navbarVisible)
      .toBe(false);
    await closeHybridPage(app, first);

    const reopened = await openHybridPage(app, PAGE_HTML);
    expect((await overlayChromeState(app, reopened))?.navbarVisible).toBe(true);

    await closeHybridPage(app, reopened);
  });

  test('a loading page shows the navbar, the pointer moving over the page leaves it up, and the load settling hides it', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

    const h = await openHybridPage(app, PAGE_HTML);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    // The active page starts loading → the bar shows.
    await publishLoading(app, h, true);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(true);

    // The pointer moves over the page while it loads (the overlay sees that
    // move, forwarded, outside every chrome region). This used to start the
    // 400 ms hover hide and take the bar down before anyone saw it.
    const hidePending = await scheduleChromeHide(app, h);
    expect(hidePending).toBe(false);
    expect((await overlayChromeState(app, h))?.navbarVisible).toBe(true);

    // The load settles → the bar hides (once the dwell from its reveal has run).
    await publishLoading(app, h, false);
    await expect
      .poll(async () => (await overlayChromeState(app, h))?.navbarVisible)
      .toBe(false);

    await closeHybridPage(app, h);
  });

  test('Cmd+L reveals the navbar and focuses its URL field', async () => {
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

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
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

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
    test.skip(!(await hybridBridgePresent(app)), 'no overlay bridge in this configuration');

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
