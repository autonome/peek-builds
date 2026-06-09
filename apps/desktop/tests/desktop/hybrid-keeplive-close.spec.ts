import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Regression (2026-06-09): the hybrid page-host (BaseWindow) cutover broke
 * `keepLive`.
 *
 * A slide/peek opened with `keepLive: true` (e.g. the left slide playing music)
 * must be HIDDEN — not closed/destroyed — when it loses focus / on app-switch,
 * so it keeps running in the background and can be re-shown by the
 * window-open key/url-reuse path. The canvas-era BrowserWindow close path always
 * did this (`closeOrHideWindow` → `win.hide()` when `params.keepLive === true`).
 *
 * When the hybrid page-host became the DEFAULT (2026-06-08/09), keepLive was
 * honored on the BrowserWindow branch of `closeOrHideWindow` but IGNORED on the
 * hybrid BaseWindow branch — `getLiveWindow(id)` returns null for a BaseWindow,
 * so the close fell to the hybrid branch which ALWAYS `closeHostWindow`'d,
 * destroying the window (and stopping the audio). The app-switch dismissal
 * (`doCloseTransientHybridWindows`) and focus-driven autoclose
 * (`closeTransientSiblingsOnFocus`) both funnel through `closeOrHideWindow`, so
 * both dropped a keepLive music slide on the floor.
 *
 * Focus-free: a macOS-headless run never grants real OS focus, so we drive the
 * SAME `closeOrHideWindow(id)` entry point those dismissal paths call, against a
 * registered fake hybrid host, and assert hide-vs-destroy via the registry
 * (`hybridWindowExists`) + `hostVisibility`. No real app-switch / focus needed.
 */
test.describe('Hybrid page-host keepLive on close path @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-keeplive-close'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // The music-slide case: a hybrid host with keepLive:true must be HIDDEN (its
  // BaseWindow stays alive, just not visible) when run through closeOrHideWindow,
  // so its content WebContentsView keeps running in the background.
  test('keepLive:true hybrid host is HIDDEN (not destroyed) on the close path', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 120, y: 130, width: 640, height: 480 });
      await b.loadFakeContent(id, 'data:text/html,<title>Music Slide</title>x');
      // Register window-manager params the same way the real hybrid open does,
      // marking this the keepLive music-slide.
      b.registerHybridWindowParams(id, {
        address: 'https://music.example/play',
        role: 'quick-view',
        modal: true,
        keepLive: true,
        hybridPageHost: true,
      });
      // Show it (focus-free) so we can prove it was actively HIDDEN, not merely
      // never shown.
      b.showFakeHybridWindowInactive(id);
      const visibleBefore = b.hostVisibility(id)?.visible;
      const existedBefore = b.hybridWindowExists(id);
      // Drive the exact close path app-switch / focus-autoclose funnel a hybrid
      // peek/slide through.
      b.closeOrHideHybrid(id);
      const existsAfter = b.hybridWindowExists(id);
      const visibleAfter = b.hostVisibility(id)?.visible;
      return { id, existedBefore, visibleBefore, existsAfter, visibleAfter };
    });

    expect(result.existedBefore).toBe(true);
    expect(result.visibleBefore).toBe(true);
    // The keepLive host survives the close path (BaseWindow NOT destroyed)...
    expect(result.existsAfter).toBe(true);
    // ...but is hidden (its content keeps running in the background).
    expect(result.visibleAfter).toBe(false);
  });

  // The non-keepLive case must be UNCHANGED: a transient quick-view (no
  // keepLive) is destroyed on the close path so it gets cleanly recreated.
  test('keepLive:false hybrid host is CLOSED (destroyed) on the close path', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const result = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow({ x: 200, y: 210, width: 600, height: 420 });
      await b.loadFakeContent(id, 'data:text/html,<title>Transient</title>x');
      b.registerHybridWindowParams(id, {
        address: 'https://transient.example/view',
        role: 'quick-view',
        modal: true,
        keepLive: false,
        hybridPageHost: true,
      });
      b.showFakeHybridWindowInactive(id);
      const existedBefore = b.hybridWindowExists(id);
      b.closeOrHideHybrid(id);
      const existsAfter = b.hybridWindowExists(id);
      return { id, existedBefore, existsAfter };
    });

    expect(result.existedBefore).toBe(true);
    // No keepLive → the BaseWindow is really gone.
    expect(result.existsAfter).toBe(false);
  });
});
