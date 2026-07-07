/**
 * Overlay maximize-state sync across a window SWITCH (peek 12821baf).
 *
 * The singleton chrome overlay is the source of truth for a hybrid window's
 * maximize TOGGLE, but the registry (main) is the source of truth for the
 * persisted maximized flag + pre-maximize bounds. On every active-window
 * handoff main ships the registry's `maximized`/`preMaxBounds` and the overlay
 * RECONCILES its own state to the newly-active window — instead of blindly
 * resetting `maximized=false; preMaxBounds=null`.
 *
 * The bug: the `page-overlay:active` handler UNCONDITIONALLY cleared the
 * overlay's maximize state. So a maximized window that lost + regained active
 * (window switching A → B → A) had its overlay `maximized` clobbered to false —
 * the overlay forgot it was maximized. The next maximize gesture then re-sent
 * `page:maximize` (a no-op — already at the work area) instead of the intended
 * `page:unmaximize`, so the window could never be un-maximized after a switch.
 *
 * Two synthetic, focus-free assertions (fake headless BaseWindow hosts, driven
 * through the E2E bridge — no real OS focus is ever taken):
 *   1. DIRECT: after A→B→A the overlay's own `maximized` flag is still true.
 *   2. BEHAVIORAL: the follow-up maximize gesture un-maximizes A back to its
 *      pre-maximize bounds (the "final double-click un-maximizes" case the
 *      d8ce0ddf gesture spec deliberately could NOT assert while this bug stood).
 *
 * Both are the SAME deterministic pubsub hand-off the production content
 * double-click drives (`page:request-toggle-maximize` → `toggleMaximize()` →
 * `page:maximize`/`page:unmaximize`) — no timer, no visibilitychange.
 *
 *   yarn test:grep "Overlay maximize-state sync"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady, type Rect } from '../helpers/hybrid-page';

test.describe('Overlay maximize-state sync @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-maximize-state-sync'));
    void bgWindow;
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  const makeHost = (bounds: Rect) =>
    app.evaluateMain!((_e, b) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.makeFakeHybridWindow(b) as number;
    }, bounds) as Promise<number>;

  const setActive = (id: number | null) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.setActive(wid) as boolean;
    }, id);

  const hostBounds = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.hostBounds(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const workArea = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.hostWorkArea(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const toggleMaximize = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      br.requestToggleMaximize(wid);
    }, id);

  const overlayMaximized = () =>
    app.evaluateMain!(async () => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      const s = await br.overlayMaximizeState();
      return s ? s.maximized === true : null;
    }) as Promise<boolean | null>;

  test('overlay keeps its maximized flag when a maximized window is switched away and back', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const a = await makeHost({ x: 120, y: 140, width: 720, height: 520 });
    const b = await makeHost({ x: 900, y: 160, width: 500, height: 640 });

    // Frame A and let the overlay renderer load (it owns the maximize toggle).
    await setActive(a);
    await waitOverlayReady(app);

    const wa = await workArea(a);
    const before = await hostBounds(a);
    expect(wa).not.toBeNull();
    expect(before).not.toBeNull();
    // Meaningful signal: the fresh window is not already at the work area.
    expect(before).not.toEqual(wa);

    // Maximize A via the REAL gesture topic → overlay maximized=true, host snaps
    // to the work area.
    await toggleMaximize(a);
    await expect.poll(() => hostBounds(a)).toEqual(wa);
    expect(await overlayMaximized()).toBe(true);

    // The window SWITCH: activate B, then re-activate A. Re-activating A fires a
    // fresh page-overlay:active handoff for A — the moment the old code clobbered
    // the overlay's maximize state.
    await setActive(b);
    await setActive(a);
    await waitOverlayReady(app);

    // DIRECT assertion: the overlay's maximized flag SURVIVED the switch. Pre-fix
    // this is false (the unconditional reset forgot A was maximized).
    await expect.poll(() => overlayMaximized()).toBe(true);
  });

  test('after a switch the maximize gesture still un-maximizes back to pre-max bounds', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const a = await makeHost({ x: 130, y: 150, width: 700, height: 500 });
    const b = await makeHost({ x: 920, y: 170, width: 480, height: 600 });

    await setActive(a);
    await waitOverlayReady(app);

    const wa = await workArea(a);
    const before = await hostBounds(a);
    expect(before).not.toEqual(wa);

    // Maximize A.
    await toggleMaximize(a);
    await expect.poll(() => hostBounds(a)).toEqual(wa);

    // Switch away and back — the re-activation used to clobber overlay.maximized.
    await setActive(b);
    await setActive(a);
    await waitOverlayReady(app);

    // Now toggle again. If the overlay reconciled (maximized still true) it sends
    // page:unmaximize → A restores to `before`. Pre-fix (maximized clobbered to
    // false) it sends page:maximize → A stays at the work area and this poll for
    // the original bounds times out and FAILS.
    await toggleMaximize(a);
    await expect.poll(() => hostBounds(a)).toEqual(before);
  });
});
