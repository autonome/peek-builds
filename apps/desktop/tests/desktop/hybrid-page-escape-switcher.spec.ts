/**
 * Hybrid page-host: ESC on a content page opens the Windows switcher (canvas parity).
 *
 * Ports the intent of the deleted canvas spec page-host-escape-switcher.spec.ts
 * (removed with the canvas page-host, commit fa9f8ff3) to the hybrid page-host.
 * On a real (non-quick-view) content page, ESC must NOT close the window — it
 * opens the Windows switcher (peek://windows/windows.html) while the page
 * survives. Canvas asserted this via <webview>-guest input injection + a
 * two-ESC navbar dance; hybrid has no in-page navbar (the chrome lives in the
 * overlay renderer), so a single ESC on the content WC falls straight through
 * askWebContentsToHandleEscape's renderer-ask timeout to the policy chain:
 *   content-WC before-input-event (wireHybridContentEvents, ipc.ts)
 *   -> handleHybridEscape (windows.ts)
 *   -> handleEscapeForWindowId -> escPolicy('active','content')='nothing'
 *   -> escUnhandledPolicy('active','content')='open-switcher'
 *   -> publish('peek://system/','cmd:execute:windows') -> lazy windows wake.
 *
 * ONE source of truth: escPolicy/escUnhandledPolicy in izui-state.ts (moved
 * there by the escPolicy single-source fix, c2fa0a16). The pure decision for
 * both content AND child-content is unit-tested in izui-state.test.ts; this
 * spec proves the WIRED hybrid runtime reaches the switcher (test 1) and that
 * a child-content page is NOT closed on ESC (test 2 - the exact regression the
 * canvas fix addressed).
 *
 * Focus-free: real OS first-responder is unobservable in macOS-headless, so we
 * drive the content WC via the hybrid test bridge and observe the switcher
 * WINDOW appearing - same approach as hybrid-escape-close / hello-world-escape-switcher.
 *
 *   yarn test:grep "Hybrid page-host ESC opens switcher"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Hybrid page-host ESC opens switcher @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-escape-switcher'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // A real content page (not a quick-view peek/slide) that receives ESC at its
  // content WC must open the switcher, NOT close. Drives the REAL
  // before-input-event wiring via dispatchContentKey (proving ESC is
  // intercepted + preventDefault'd there) and observes the switcher window.
  test('ESC on a hybrid content page opens the switcher and keeps the page (real before-input path)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    // Headless default session is 'active' (appFocused defaults true) - the
    // state in which escUnhandledPolicy routes content ESC to the switcher.
    const sessionState = await bgWindow.evaluate(async () => (window as any).app.izui.getState());
    expect(sessionState).toBe('active');

    // Sanity: switcher not open yet.
    const switcherBefore = await app.getWindow('windows/windows.html', 1000).catch(() => null);
    expect(switcherBefore).toBeFalsy();

    const setup = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Content</title>x', {
        role: 'content',
      });
      b.setActive(id);
      const existedBefore = b.hybridWindowExists(id);
      // Drive the REAL content-WC before-input-event with a no-modifier ESC.
      const prevented = b.dispatchContentKey(id, 'Escape', { meta: false, control: false });
      return { id, existedBefore, prevented };
    });
    expect(setup.existedBefore).toBe(true);
    // ESC intercepted by the hybrid content-WC handler (not leaked to the page DOM).
    expect(setup.prevented).toBe(true);

    // The switcher overlay should appear. getWindow's timeout is a failure
    // deadline: if the page closed / no switcher, this throws.
    const switcher = await app.getWindow('windows/windows.html', 8000);
    expect(switcher).toBeTruthy();

    // ...and the content page window survives (ESC opened the switcher, did not close it).
    const survived = await app.evaluateMain!(((_e: unknown, wid: number) =>
      (globalThis as any).__peekHybridOverlayTest.hybridWindowExists(wid)) as any, setup.id);
    expect(survived).toBe(true);
  });

  // child-content parity: a page opened from a real content parent gets role
  // 'child-content'. The canvas regression CLOSED child-content on ESC while
  // OS-focused; parity requires it to survive (escUnhandledPolicy maps it to
  // 'open-switcher', same as content - unit-tested). Driven through the policy
  // entry point (runHybridEscape) so the no-close decision is asserted
  // deterministically. Switcher-open wiring is proven in test 1 above; here we
  // guard the no-close half for the child-content role.
  test('ESC on a hybrid child-content page does NOT close it (policy path)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Child</title>x', {
        role: 'child-content',
      });
      b.setActive(id);
      const existedBefore = b.hybridWindowExists(id);
      const ranOn = await b.runHybridEscape(id);
      const existsAfter = b.hybridWindowExists(id);
      return { id, existedBefore, ranOn, existsAfter };
    });

    expect(result.existedBefore).toBe(true);
    expect(result.ranOn).toBe(result.id);
    // child-content is NOT force-closed by ESC in an active session - it routes
    // to the switcher instead (canvas parity; regression fixed).
    expect(result.existsAfter).toBe(true);
  });
});
