import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Regression cluster R4 / R5 / R7 (hybrid page-host dead-focus), 2026-06-08.
 *
 * When the hybrid page-host became the DEFAULT web-page renderer, a freshly
 * opened hybrid window was shown via `baseWin.showInactive()` ONLY — it never
 * activated the app or made the content WebContentsView the macOS first
 * responder. Symptoms:
 *
 *   R4  cmd+L no-ops with an NSBeep — a key equivalent reached AppKit with no
 *       first responder (the content view never became one on show).
 *   R5  gesture over the content top border doesn't reveal the overlay — the
 *       content window never gained focus, so the registry's active-hybrid id
 *       stayed null and the overlay never retargeted/revealed.
 *   R7  cmd+tab to Peek shows windows but Peek isn't frontmost in the menubar —
 *       `showInactive()` never activates the app, so it can be raised without
 *       becoming the active app that owns the menubar / key window.
 *
 * The canvas path it replaced used `win.show()` (constructor show:true →
 * activates the app + makes the window key) + `win.focus()`. The hybrid path
 * must reproduce that: in a NON-headless run it must take the ACTIVATING show
 * branch (`baseWin.show()` + content-WC focus), and the resulting content-WC
 * focus must drive the registry's active id so the overlay reveals.
 *
 * Headless test runs MUST keep the focus-free branch (showInactive + opacity 0)
 * so an agent/CI run never steals the user's focus (peek task 2b55f3af —
 * activation policy is 'accessory' under headless; never reintroduce focus
 * theft from tests). So we assert the INTENT the show path recorded, focus-free,
 * via the test bridge — we do NOT rely on real OS focus (unobservable headless).
 */
test.describe('Hybrid page-host show/activate (R4/R5/R7) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-show-activate'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // R4/R7: the hybrid show DECISION is a pure function of headless-ness. For the
  // REAL (non-headless) app it must ACTIVATE (show() → app frontmost + key window,
  // R7) AND focus the content WebContentsView (first responder so cmd+L key
  // equivalents have a target — R4, no NSBeep). Under headless it must stay
  // INACTIVE (showInactive, no focus) so an agent/CI run never steals focus
  // (peek task 2b55f3af). We assert BOTH branches deterministically via the pure
  // decision — focus-free, independent of the run's actual headless mode.
  test('show DECISION: non-headless activates+focuses content; headless stays inactive', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const { real, headless } = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return {
        real: b.hybridShowIntent(false), // the REAL (non-headless) app
        headless: b.hybridShowIntent(true), // an agent/CI run
      };
    });

    // Real app: activate (frontmost + key — R7) and content-WC first responder
    // (R4 — cmd+L has a target, no NSBeep).
    expect(real).toBeTruthy();
    expect(real.activated).toBe(true);
    expect(real.contentFocused).toBe(true);
    expect(real.showInactive).toBe(false);

    // Headless: focus-free (never activate, never focus) — no focus theft.
    expect(headless).toBeTruthy();
    expect(headless.activated).toBe(false);
    expect(headless.contentFocused).toBe(false);
    expect(headless.showInactive).toBe(true);
  });

  // 524f7aba: quick-view surfaces (peeks/slides) opened via global hotkey must
  // NOT steal the frontmost app's OS focus. They open on a `type:'panel'` NSPanel
  // host (createHybridHostBaseWindow threads the caller's `type:'panel'`), which
  // can be key — take input — WITHOUT activating the app. So the quick-view show
  // DECISION is: do NOT activate (frontmost app keeps OS focus) but STILL focus
  // the content WC (the peek takes ESC / address-bar keystrokes). Distinct from a
  // real web tab (activates) and from a session-restore open (inactive AND
  // focus-free). Pure decision → assertable focus-free in either run mode.
  test('quick-view (non-activating) DECISION: no app activation but content still focused', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const { quickView, quickViewHeadless, restoreWins } = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return {
        // Non-headless quick-view peek/slide: non-activating, content focused.
        quickView: b.hybridShowIntent(false, { nonActivating: true }),
        // Headless still fully focus-free (never focus/activate from a test run).
        quickViewHeadless: b.hybridShowIntent(true, { nonActivating: true }),
        // `inactive` (restore) must WIN over `nonActivating`: a restored peek is
        // focus-free until the restore loop picks the one to re-raise.
        restoreWins: b.hybridShowIntent(false, { inactive: true, nonActivating: true }),
      };
    });

    // Quick-view: app NOT activated (no OS focus theft) but content IS the first
    // responder (peek takes key input).
    expect(quickView).toBeTruthy();
    expect(quickView.activated, 'quick-view must not activate the app').toBe(false);
    expect(quickView.contentFocused, 'quick-view content must be first responder').toBe(true);
    expect(quickView.showInactive).toBe(true);

    // Headless quick-view: focus-free (never focus).
    expect(quickViewHeadless.activated).toBe(false);
    expect(quickViewHeadless.contentFocused).toBe(false);
    expect(quickViewHeadless.showInactive).toBe(true);

    // inactive wins over nonActivating.
    expect(restoreWins.activated).toBe(false);
    expect(restoreWins.contentFocused, 'restore stays focus-free even for a panel host').toBe(false);
    expect(restoreWins.showInactive).toBe(true);
  });

  // The applied show path matches the decision for THIS run (headless here): it
  // must take the inactive, focus-free branch — never activate, never focus.
  test('applied show path is focus-free under headless', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const probe = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 140, y: 160, width: 700, height: 500 });
      await b.loadFakeContent(id, 'data:text/html,<title>Show Me</title>body');
      const intent = b.showHybridHost(id); // drives the real ipc.ts show seam
      return { id, intent, headless: b.isHeadlessRun() };
    });

    expect(probe.headless).toBe(true);
    expect(probe.intent).toBeTruthy();
    expect(probe.intent.activated).toBe(false);
    expect(probe.intent.contentFocused).toBe(false);
    expect(probe.intent.showInactive).toBe(true);
  });

  // R5: focusing the content WebContentsView (what the activating show path does)
  // must drive the registry's active-hybrid id, which is what makes the shared
  // overlay retarget + reveal over the content. If the content WC focus is never
  // delivered to the registry, active stays null and the overlay never reveals.
  test('content-WC focus drives active-hybrid id → overlay can reveal (R5)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 200, y: 200, width: 600, height: 400 });
      await b.loadFakeContent(id, 'data:text/html,<title>Reveal</title>x');
      // Simulate ONLY the content WebContentsView gaining focus (the belt-and-
      // suspenders signal the show path's contentWC.focus() produces) — NOT the
      // host BaseWindow focus. This is the exact event a fresh non-headless show
      // delivers; the registry must treat it as activating.
      b.focusContentWC(id);
      const activeAfterContentFocus = b.activeId();
      // The overlay (driven off active id) frames + shows over the content.
      b.setActive(id);
      const overlay = b.overlayState();
      return { id, activeAfterContentFocus, overlayVisible: overlay ? overlay.visible : null };
    });

    // The content-WC focus alone makes this window the active hybrid window.
    expect(result.activeAfterContentFocus).toBe(result.id);
    // And the overlay reveals over it.
    expect(result.overlayVisible).toBe(true);
  });

  // R6 (peek item 88797f2d): the overlay chrome (address bar + widgets) must hide
  // when Peek is NOT the active app — it's chrome for the active page, so when the
  // user switches to another app it should not linger on screen. The app-active
  // gate already drops the overlay's floating level + click-through on resign, but
  // it left the overlay VISIBLE. On resign it must hide; on become-active (with an
  // active hybrid window) it re-frames + shows.
  test('overlay hides when the app resigns active, re-shows on become-active (R6)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const visibleWhileActive = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 160, y: 160, width: 700, height: 460 });
      await b.loadFakeContent(id, 'data:text/html,<title>R6</title>x');
      b.setActive(id);
      const st = b.overlayState();
      return st ? st.visible : null;
    });
    // Baseline: overlay is shown while the app is active with an active page.
    expect(visibleWhileActive).toBe(true);

    // App resigns active → overlay must HIDE (not just go click-through).
    const afterResign = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const ok = b.simAppResignActive();
      const st = b.overlayState();
      return { ok, appActive: b.appActiveState(), visible: st ? st.visible : null };
    });
    expect(afterResign.ok).toBe(true);
    expect(afterResign.appActive).toBe(false);
    expect(afterResign.visible).toBe(false);

    // App becomes active again (active hybrid window still set) → overlay re-shows.
    const afterBecome = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const ok = b.simAppBecomeActive();
      const st = b.overlayState();
      return { ok, appActive: b.appActiveState(), visible: st ? st.visible : null };
    });
    expect(afterBecome.ok).toBe(true);
    expect(afterBecome.appActive).toBe(true);
    expect(afterBecome.visible).toBe(true);
  });
});
