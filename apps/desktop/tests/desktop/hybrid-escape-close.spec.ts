import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Regression (Cluster B companion, peek e8081cce), 2026-06-09.
 *
 * Pressing ESC used to close an open peek/slide. After the hybrid page-host
 * became the DEFAULT (2026-06-08) it stopped. Peeks/slides open with
 * `role:'quick-view' + modal + canvas`; under the hybrid default these are
 * `BaseWindow`s. The ESC→close path lived ENTIRELY on the per-`BrowserWindow`
 * `before-input-event` (`addEscHandler` in windows.ts) — never wired for the
 * hybrid BaseWindow. A focused hybrid host makes its content `WebContentsView`
 * the macOS first responder, so ESC arrives at the content WC's
 * `before-input-event` (`wireHybridContentEvents` in ipc.ts), which handled the
 * page accelerators + leftover local shortcuts but DROPPED ESC — exactly the
 * same class as the cmd+W/L/N cluster.
 *
 * The fix routes ESC from the hybrid content WC's `before-input-event` through
 * the SAME policy decision the canvas path uses (`handleHybridEscape` →
 * escPolicy / escUnhandledPolicy → closeOrHideWindow), with the content WC as
 * the renderer asked first. ONE source of truth — no forked policy.
 *
 * Scope: this fixes the CLOSE behaviour that regressed (quick-view peeks/slides).
 * ESC→switcher routing for hybrid content/child-content pages is a separate
 * concern, now covered by hybrid-page-escape-switcher.spec.ts (peek 9cc8b57e) —
 * NOT touched here.
 *
 * Focus-free: a macOS-headless run never grants real OS focus, so we drive the
 * content WC's `before-input-event` (and the policy path) via the test bridge
 * and assert state, not real focus — same approach as hybrid-close-shortcut /
 * hybrid-shortcut-routing.
 *
 *   yarn test:grep "Hybrid page-host ESC close"
 */
test.describe('Hybrid page-host ESC close @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-escape-close'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // Core regression: a focused hybrid quick-view (peek/slide) host that receives
  // ESC at its content WC closes. Drives the REAL before-input-event wiring via
  // dispatchContentKey (proving ESC is intercepted + preventDefault'd there) and
  // awaits the async close deterministically (waitHybridGone).
  test('ESC on a focused hybrid quick-view host closes it (real before-input path)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      // A peek/slide opens role:'quick-view' + modal — register exactly that so
      // the policy classifies it the way the real feature path does.
      const id = await b.makeRoledHybrid('data:text/html,<title>Peek</title>x', {
        role: 'quick-view',
        modal: true,
      });
      b.setActive(id);
      const existedBefore = b.hybridWindowExists(id);
      // Drive the REAL content-WC before-input-event with a no-modifier ESC —
      // the exact event Electron delivers when ESC lands on the first-responder
      // content view. The handler must intercept it (preventDefault) and route
      // to the close policy.
      const prevented = b.dispatchContentKey(id, 'Escape', { meta: false, control: false });
      // The close runs async (renderer-ask timeout → closeOrHideWindow); await it.
      const gone = await b.waitHybridGone(id);
      return { id, existedBefore, prevented, gone };
    });

    expect(result.existedBefore).toBe(true);
    // ESC was intercepted by the hybrid content-WC handler (not leaked to DOM).
    expect(result.prevented).toBe(true);
    // ...and the quick-view BaseWindow is gone — the regression is fixed.
    expect(result.gone).toBe(true);
  });

  // Same close, driven through the policy entry point directly (deterministic,
  // no async-keystroke dance) so the close decision itself is asserted in
  // isolation: handleHybridEscape → escPolicy('…','quick-view')==='close' →
  // closeOrHideWindow closes the hybrid BaseWindow.
  test('handleHybridEscape closes a quick-view hybrid host (policy path)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Slide</title>x', {
        role: 'quick-view',
        modal: true,
      });
      b.setActive(id);
      const existedBefore = b.hybridWindowExists(id);
      const ranOn = await b.runHybridEscape(id);
      const existsAfter = b.hybridWindowExists(id);
      return { id, existedBefore, ranOn, existsAfter };
    });

    expect(result.existedBefore).toBe(true);
    expect(result.ranOn).toBe(result.id);
    expect(result.existsAfter).toBe(false);
  });

  // Guard: escapeMode:'ignore' is a hard override — ESC must NOT close such a
  // hybrid host (preserved identically to the canvas path). This proves the
  // hybrid path reuses the policy gate, not a "hybrid always closes" shortcut.
  test('escapeMode:"ignore" hybrid host is NOT closed by ESC', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = await b.makeRoledHybrid('data:text/html,<title>Ignore</title>x', {
        role: 'quick-view',
        escapeMode: 'ignore',
      });
      b.setActive(id);
      const existedBefore = b.hybridWindowExists(id);
      await b.runHybridEscape(id);
      const existsAfter = b.hybridWindowExists(id);
      return { existedBefore, existsAfter };
    });

    expect(result.existedBefore).toBe(true);
    // Ignore mode means ESC is a no-op — the window survives.
    expect(result.existsAfter).toBe(true);
  });

  // WRONG-WINDOW / first-responder redirect (peek ebb10894) — the LIVE bug the
  // headless escPolicy unit could not catch. Reproduces the exact intermittency:
  // ESC lands on the PREVIOUS hybrid CONTENT host (still first responder for a
  // beat after a peek/slide opens over it) instead of the just-opened quick-view.
  // Pre-fix, handleHybridEscape resolved against the content host → escPolicy
  // 'nothing' → escUnhandledPolicy → the Windows SWITCHER, and the quick-view
  // survived. Post-fix, handleHybridEscape consults the registry's active-hybrid
  // id (the focus source of truth, set on open) and, because the active window
  // is an always-closeable quick-view, redirects the ESC to it → it CLOSES.
  //
  // This asserts the ACTUAL resolution path (which host id + role ESC resolves
  // against, driven by the active-hybrid id), not just escPolicy(state, role) —
  // so it covers the live path a green headless escPolicy spec missed.
  test('ESC on the wrong (content) host closes the ACTIVE quick-view, not the switcher', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      // The PREVIOUS page the user was on — a hybrid CONTENT host. ESC lands here
      // because its content WC is still the macOS first responder for a beat
      // after the peek/slide opens over it.
      const contentId = await b.makeRoledHybrid('data:text/html,<title>Prev page</title>x', {
        role: 'content',
      });
      // The just-opened peek/slide — a quick-view that is the ACTIVE hybrid
      // window (its show() + content focus on open set the registry active id).
      const quickViewId = await b.makeRoledHybrid('data:text/html,<title>Peek</title>y', {
        role: 'quick-view',
        modal: true,
      });
      b.setActive(quickViewId);

      const quickViewExistedBefore = b.hybridWindowExists(quickViewId);
      // Drive ESC against the WRONG host (the content page) — exactly what
      // happens when the content WC, not the quick-view, is first responder.
      await b.runHybridEscape(contentId);

      const quickViewGone = !b.hybridWindowExists(quickViewId);
      const contentSurvives = b.hybridWindowExists(contentId);
      return { quickViewId, contentId, quickViewExistedBefore, quickViewGone, contentSurvives };
    });

    expect(result.quickViewExistedBefore).toBe(true);
    // The redirect closed the active quick-view — the regression is fixed.
    expect(result.quickViewGone).toBe(true);
    // ...and the content page the ESC literally landed on is untouched (it was
    // never the target; no switcher, no spurious close).
    expect(result.contentSurvives).toBe(true);
  });

  // Guard the redirect's boundary: when the ACTIVE hybrid window is itself a
  // content/workspace page (not a closeable transient), ESC must NOT be hijacked
  // toward it — it resolves against the host it landed on, preserving the
  // ESC→switcher routing for real content pages (peek 9cc8b57e /
  // hybrid-page-escape-switcher.spec.ts).
  test('ESC does NOT redirect toward a content active window (no force-close)', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const landedId = await b.makeRoledHybrid('data:text/html,<title>Landed</title>x', {
        role: 'content',
      });
      const activeContentId = await b.makeRoledHybrid('data:text/html,<title>Active page</title>y', {
        role: 'content',
      });
      b.setActive(activeContentId);
      // ESC on the landed content host with a CONTENT (non-closeable) active
      // window: neither must be force-closed by the redirect.
      await b.runHybridEscape(landedId);
      return {
        landedSurvives: b.hybridWindowExists(landedId),
        activeSurvives: b.hybridWindowExists(activeContentId),
      };
    });

    // Neither content page is force-closed — the redirect only fires toward
    // always-closeable transient active windows (quick-view/palette/…).
    expect(result.landedSurvives).toBe(true);
    expect(result.activeSurvives).toBe(true);
  });

  // Canvas-path guard: the close DECISION is shared — escPolicy is the SINGLE
  // source of truth both the canvas BrowserWindow path (addEscHandler →
  // handleEscapeForWindow) and the new hybrid path (handleHybridEscape) consult
  // via the same handleEscapeForWindowId core. So the quick-view → close
  // behaviour proven above for hybrid is byte-for-byte the canvas behaviour; the
  // BrowserWindow runtime ESC-close itself is exercised by slides.spec /
  // peeks.spec. (No forked policy means there is nothing for a
  // canvas-specific assertion here to diverge from.)
});
