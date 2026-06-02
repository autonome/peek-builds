import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Windows feature enumeration of hybrid page-host windows.
 *
 * Bug: "No pages show up in the windows feature." Hybrid page-hosts are
 * BaseWindows, which `BrowserWindow.getAllWindows()` / the window-registry do
 * NOT enumerate, so the windows feature (which builds its list from
 * `tile:window:list` → `getAllWindowRefs()` + `getWindowPresentation`) never
 * saw them. The fix appends hybrid windows from the hybrid registry, presented
 * through the SAME `getWindowPresentation` path as a canvas page, so a hybrid
 * entry is indistinguishable from a canvas page in the feature.
 *
 * `windowsFeatureHybridEntries()` (E2E bridge) replicates the EXACT hybrid loop
 * the `tile:window:list` handler runs, returning the same `{ id, url, title,
 * visible, focused, favicon, … }` entries the windows-feature renderer receives.
 *
 * Focus-free: real (headless, never-shown) BaseWindow hosts, registered as
 * hybrid windows; the suite skips itself when the hybrid bridge is absent
 * (PEEK_PAGEHOST_HYBRID off).
 */
test.describe('Windows feature: hybrid page-host enumeration @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-windows-feature'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('both hybrid windows appear in the windows-feature list with correct url/title', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Two real (headless) hybrid windows with distinct content, so url()/title()
    // differ between them.
    const ids = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const a = b.makeFakeHybridWindow({ x: 100, y: 100, width: 600, height: 400 });
      const bb = b.makeFakeHybridWindow({ x: 700, y: 100, width: 600, height: 400 });
      await b.loadFakeContent(a, 'data:text/html,<title>Alpha Page</title>alpha-body');
      await b.loadFakeContent(bb, 'data:text/html,<title>Beta Page</title>beta-body');
      return { a, bb };
    });

    // Query the windows-feature enumeration (the exact loop tile:window:list runs).
    const entries = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.windowsFeatureHybridEntries();
    });

    const byId = new Map<number, any>(entries.map((e: any) => [e.id, e]));

    // BOTH hybrid windows appear.
    expect(byId.has(ids.a)).toBe(true);
    expect(byId.has(ids.bb)).toBe(true);

    // Correct, distinct url + title for each — and the canvas-page entry shape
    // (id/url/title/visible/focused/favicon/thumbnail all present).
    const a = byId.get(ids.a);
    const bb = byId.get(ids.bb);

    expect(a.title).toBe('Alpha Page');
    expect(a.url).toContain('alpha-body');
    expect(typeof a.visible).toBe('boolean');
    expect(typeof a.focused).toBe('boolean');
    expect(typeof a.favicon).toBe('string');
    expect(typeof a.thumbnail).toBe('string');

    expect(bb.title).toBe('Beta Page');
    expect(bb.url).toContain('beta-body');
    expect(a.url).not.toBe(bb.url);
  });

  test('focusing a hybrid entry routes to its host BaseWindow (focus action)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // The windows feature focuses a selected window by id (setOverlayFocusTarget
    // → main routes getLiveWindow OR, for a hybrid, getHybridWindow().baseWin).
    // Drive the registry-level focus the feature ultimately triggers and assert
    // the host BaseWindow becomes focused.
    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const w = b.makeFakeHybridWindow({ x: 120, y: 140, width: 600, height: 400 });
      await b.loadFakeContent(w, 'data:text/html,<title>Focus Me</title>x');
      // focusHost drives the BaseWindow focus the feature's focus path
      // (hybrid.baseWin.focus()) performs; the host's isFocused() then reports
      // true, which the windows-feature entry surfaces as focused:true.
      b.focusHost(w);
      const entry = b
        .windowsFeatureHybridEntries()
        .find((e: any) => e.id === w);
      return { id: w, entry, active: b.activeId() };
    });

    // The focused hybrid window surfaces focused:true in its windows-feature
    // entry (the presenter reads baseWin.isFocused()).
    expect(result.entry).toBeTruthy();
    expect(result.entry.focused).toBe(true);
    // The registry's active-window tracking also picks it up (the same signal
    // the overlay uses), proving the focus routed to the hybrid window.
    expect(result.active).toBe(result.id);
  });

  test('additive: list is empty of hybrids until any are registered (flag-off shape)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    // Close every hybrid window registered by the prior tests, then assert the
    // windows-feature hybrid loop yields ZERO entries — i.e. the addition is
    // purely additive: with no hybrid windows (the flag-off steady state) the
    // canvas-only list is unchanged.
    const remaining = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      for (const id of b.hybridIds()) b.destroyFakeHybridWindow(id);
      // Give 'closed' cleanup a tick to drain the registry.
      await new Promise((r) => setTimeout(r, 50));
      return b.windowsFeatureHybridEntries().length;
    });

    expect(remaining).toBe(0);
  });
});
