/**
 * Hybrid page-host: the ESC-defers-to-a-focused-editable guard (peek 51798bae;
 * consolidates duplicate cb8d92d6) is switched OFF (DEFER_ESCAPE_TO_EDITABLE =
 * false): ESC acts the same whether or not a focused field holds text. The
 * description below is of the mechanism the switch controls.
 *
 * The universal content preload (runtime-external-preload.cjs) reports focus
 * transitions via `page:editable-focus`; the hybrid content-WC before-input-event
 * (wireHybridContentEvents, ipc.ts) reads that cached boolean and, when an
 * editable is focused, DEFERS ESC to the page — it does NOT preventDefault and
 * does NOT route to policy — so the field blurs natively instead of the switcher
 * opening. This is the missing guard on top of the base ESC→switcher wiring
 * proven by hybrid-page-escape-switcher.spec.ts.
 *
 * Focus-free: real OS first-responder / real DOM focus inside the WebContentsView
 * is unobservable in macOS-headless, AND the data: URLs used here get no preload
 * (non-http(s)), so the real focusin/focusout signal never fires. We seed the
 * SAME cache the IPC feeds via the test bridge's `setContentEditableFocus`, then
 * drive the REAL before-input-event via `dispatchContentKey` and assert on
 * whether ESC was stolen (preventDefault) + whether the switcher appears.
 *
 * The strong deterministic signal is `prevented`: editable-focused ESC returns
 * prevented=false (NOT stolen → falls through to the page); the switcher-window
 * observation is the secondary UX guard.
 *
 *   yarn test:grep "Hybrid page-host ESC editable guard"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Hybrid page-host ESC editable guard @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-escape-editable'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // Deferring ESC to a focused field holding text is switched off
  // (DEFER_ESCAPE_TO_EDITABLE in hybrid-editable-escape.ts): the field's text
  // made peeks and slides impossible to dismiss by keyboard. ESC with text in a
  // focused field is stolen and routed to policy like any other ESC.
  test('ESC with text in a focused editable is not deferred (stolen, opens the switcher)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    // Active session — the state where a content-page ESC routes to the switcher.
    const sessionState = await bgWindow.evaluate(async () => (window as any).app.izui.getState());
    expect(sessionState).toBe('active');

    const setup = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Edit</title><input>', {
        role: 'content',
      });
      b.setActive(id);
      // Simulate the content preload reporting an editable holding text is focused.
      const seeded = b.setContentEditableFocus(id, true, { empty: false });
      const existedBefore = b.hybridWindowExists(id);
      // Drive the REAL content-WC before-input-event with a no-modifier ESC.
      const prevented = b.dispatchContentKey(id, 'Escape', { meta: false, control: false });
      return { id, seeded, existedBefore, prevented };
    });
    expect(setup.seeded).toBe(true);
    expect(setup.existedBefore).toBe(true);
    // ESC was stolen by the content-WC handler, as with no field focused.
    expect(setup.prevented).toBe(true);

    const switcher = await app.getWindow('windows/windows.html', 8000);
    expect(switcher).toBeTruthy();

    // ...and the page window survives.
    const survived = await app.evaluateMain!(((_e: unknown, wid: number) =>
      (globalThis as any).__peekHybridOverlayTest.hybridWindowExists(wid)) as any, setup.id);
    expect(survived).toBe(true);
  });

  // A peek/slide (role 'quick-view', modal, pageHost — as openNewSlide builds
  // it) with a focused textarea holding text must still close on ESC.
  test('ESC closes a quick-view host whose focused textarea holds text', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Slide</title><textarea>hello</textarea>', {
        role: 'quick-view',
        modal: true,
        pageHost: true,
      });
      b.setActive(id);
      b.setContentEditableFocus(id, true, { empty: false });
      const existedBefore = b.hybridWindowExists(id);
      const prevented = b.dispatchContentKey(id, 'Escape', { meta: false, control: false });
      const gone = await b.waitHybridGone(id);
      return { existedBefore, prevented, gone };
    });
    expect(result.existedBefore).toBe(true);
    expect(result.prevented).toBe(true);
    expect(result.gone).toBe(true);
  });

  // Editable focused but EMPTY: there is nothing for ESC to clear, so it behaves
  // as if no field had focus — stolen (preventDefault) and routed to the switcher.
  test('ESC with an empty editable focused opens the switcher', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const setup = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Empty</title><input>', {
        role: 'content',
      });
      b.setActive(id);
      b.setContentEditableFocus(id, true, { empty: true });
      const prevented = b.dispatchContentKey(id, 'Escape', { meta: false, control: false });
      return { id, prevented };
    });
    expect(setup.prevented).toBe(true);

    const switcher = await app.getWindow('windows/windows.html', 8000);
    expect(switcher).toBeTruthy();
  });

  // Regression guard for the base path: with NOTHING editable focused, ESC is
  // still stolen (preventDefault) and routed through policy to the switcher —
  // proving the guard didn't break the normal content-ESC behaviour.
  test('ESC with no editable focused still opens the switcher (base path intact)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const setup = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Plain</title>x', {
        role: 'content',
      });
      b.setActive(id);
      b.setContentEditableFocus(id, false);
      const prevented = b.dispatchContentKey(id, 'Escape', { meta: false, control: false });
      return { id, prevented };
    });
    // ESC intercepted (stolen) by the content-WC handler as before.
    expect(setup.prevented).toBe(true);

    const switcher = await app.getWindow('windows/windows.html', 8000);
    expect(switcher).toBeTruthy();

    const survived = await app.evaluateMain!(((_e: unknown, wid: number) =>
      (globalThis as any).__peekHybridOverlayTest.hybridWindowExists(wid)) as any, setup.id);
    expect(survived).toBe(true);
  });
});
