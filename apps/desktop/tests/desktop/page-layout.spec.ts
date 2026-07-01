/**
 * Page Host Layout Tests
 *
 * Canvas-DOM pixel-math regression tests (1-5) were deleted at Stage B
 * (canvas page-host removal) — the measured DOM elements (page.js's navbar/
 * webview/panels/resize-handles) no longer exist.
 *
 * The Maximize suite (formerly 6-14) has been ported test-by-test to the
 * hybrid page-host, which has REAL maximize tracking (registry-backed, driven
 * by `page:maximize`/`page:unmaximize` intents — see
 * `hybrid-page-host-registry.ts`'s maximize state and
 * `tests/desktop/session-restore-page-host.spec.ts` /
 * `tests/desktop/reopen-closed-window.spec.ts` for the established idiom:
 * `publishOverlayTopic(app, 'page:maximize'/'page:unmaximize', {windowId})`
 * to drive it, and `app.window.list()`'s `.maximized`/`.bounds`/
 * `.preMaxBounds` fields to read it back).
 *
 * Tests that measured the canvas content page's own DOM (webview position
 * within the page, navbar z-index vs. the webview, side-panel clamp geometry,
 * resize-handle reachability, drag-out-of-maximize, border-radius CSS) have
 * no hybrid equivalent — the hybrid content window IS the native window (no
 * DOM position to measure), and the shared chrome overlay's fine-grained
 * panel/drag geometry isn't exposed by the current test bridge. Those were
 * deleted; see the per-test comments below and the task's final report for
 * which are believed-obsolete vs. flagged as a possible coverage gap.
 *
 * Run with:
 *   BACKEND=electron yarn test:electron
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { setActive, sendShowNavbar, overlayChromeState, waitOverlayReady, publishOverlayTopic } from '../helpers/hybrid-page';

// Shared app instance
let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.afterAll(async () => {
  await closeSharedApp();
});

// ============================================================================
// Helpers
// ============================================================================

/** Open a REAL (non-fake) hybrid content window via the production window-open path. */
async function openHybridWindow(
  bgWindow: Page,
  url: string,
  options: { width?: number; height?: number } = {},
): Promise<number> {
  const result = await bgWindow.evaluate(
    async ({ targetUrl, opts }: { targetUrl: string; opts: { width?: number; height?: number } }) => {
      return await (window as any).app.window.open(targetUrl, {
        width: opts.width || 800,
        height: opts.height || 600,
        ...opts,
      });
    },
    { targetUrl: url, opts: options },
  );
  expect(result.success).toBe(true);
  return result.id as number;
}

/** Read `id`'s live entry (bounds, maximized, preMaxBounds, …) from the production window list. */
async function findEntry(bgWindow: Page, id: number): Promise<any> {
  return bgWindow.evaluate(async (targetId: number) => {
    const r = await (window as any).app.window.list({ includeInternal: false });
    if (!r?.success) return null;
    return (r.windows || []).find((w: any) => w.id === targetId) ?? null;
  }, id);
}

async function closeWindow(bgWindow: Page, windowId: number): Promise<void> {
  await bgWindow.evaluate(async (id: number) => {
    return await (window as any).app.window.close(id);
  }, windowId);
}

/**
 * Dispatch a real DOM dblclick on the shared overlay's navbar element (direct
 * BrowserWindow lookup + executeJavaScript, the same technique
 * `overlayChromeState()` uses internally — the overlay IS a real, focusable
 * BrowserWindow). The overlay's navbar wires this to `toggleMaximize()`
 * (`renderer/page/overlay.js`), which publishes `page:maximize` for the
 * active window — this proves the double-click gesture itself, not just the
 * underlying pubsub intent.
 */
async function dblClickOverlayNavbar(app: DesktopApp): Promise<void> {
  await app.evaluateMain!(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find((w: Electron.BrowserWindow) => {
      try { return w.webContents.getURL().includes('page/overlay.html'); } catch { return false; }
    });
    if (!overlay) throw new Error('overlay window not found');
    return overlay.webContents.executeJavaScript(
      "(function(){ var nb = document.getElementById('navbar'); if (!nb) return false; nb.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()",
    );
  });
}

// ============================================================================
// Maximize Tests: verify maximize/restore functionality on the hybrid
// page-host (ported from the canvas-DOM suite; see file header).
// ============================================================================

test.describe('Page Layout Maximize @desktop', () => {

  test('maximize command fills work area', async () => {
    const windowId = await openHybridWindow(sharedBgWindow, 'https://example.com');

    const before = await findEntry(sharedBgWindow, windowId);
    expect(before?.maximized).toBe(false);

    await publishOverlayTopic(sharedApp, 'page:maximize', { windowId });

    const after = await findEntry(sharedBgWindow, windowId);
    expect(after?.maximized).toBe(true);

    const workArea = await sharedApp.evaluateMain!(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(after?.bounds).toEqual(workArea);

    await closeWindow(sharedBgWindow, windowId);
  });

  test('maximize toggle restores original size', async () => {
    const windowId = await openHybridWindow(sharedBgWindow, 'https://example.com');

    const before = await findEntry(sharedBgWindow, windowId);
    const originalBounds = before.bounds;

    await publishOverlayTopic(sharedApp, 'page:maximize', { windowId });
    const maximized = await findEntry(sharedBgWindow, windowId);
    expect(maximized?.maximized).toBe(true);
    expect(maximized?.bounds).not.toEqual(originalBounds);

    await publishOverlayTopic(sharedApp, 'page:unmaximize', { windowId });
    const restored = await findEntry(sharedBgWindow, windowId);
    expect(restored?.maximized).toBe(false);
    expect(restored?.bounds).toEqual(originalBounds);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Formerly "webview fills window when maximized" (left=0, top=0 of the
  // canvas page's #content DOM element) — DELETED. The hybrid content window
  // IS the native window; there's no DOM child position to measure, so the
  // assertion is architecturally tautological on hybrid.

  test('navbar can be revealed while the host is maximized', async () => {
    // Ported reduced form of the former "navbar floats over webview when
    // maximized" test. The z-index-vs-webview and webview-top=0 assertions
    // don't translate — chrome and content are now separate native windows,
    // not DOM-stacked layers within one page — but the core behavior (the
    // overlay chrome stays revealable/usable while its host is maximized)
    // is still meaningful and is asserted here via the existing hybrid
    // overlay test idioms.
    const windowId = await openHybridWindow(sharedBgWindow, 'https://example.com');

    const activated = await setActive(sharedApp, { id: windowId, contentWcId: null });
    expect(activated).toBe(true);
    await waitOverlayReady(sharedApp);

    await publishOverlayTopic(sharedApp, 'page:maximize', { windowId });
    const maximized = await findEntry(sharedBgWindow, windowId);
    expect(maximized?.maximized).toBe(true);

    await sendShowNavbar(sharedApp, { id: windowId, contentWcId: null });
    await expect
      .poll(async () => (await overlayChromeState(sharedApp))?.navbarVisible, { timeout: 5000 })
      .toBe(true);

    await closeWindow(sharedBgWindow, windowId);
  });

  // Formerly "panels clamped to screen edges when maximized" — DELETED. The
  // side panels (tags/notes/entities/page-info) do exist in the hybrid
  // shared overlay (`overlay.js`'s `stackRight()`), but the test-only
  // `overlayPanelState()` bridge only exposes `{hasData, text}` per panel,
  // not bounding-rect geometry — extending it would mean editing a
  // main-process file (`hybrid-overlay.ts`), which is out of scope for this
  // pass. FLAGGED AS A POSSIBLE COVERAGE GAP, not confirmed broken: whether
  // hybrid panels stay clamped to the screen edge in a maximized host is
  // untested.

  // Formerly "resize handles stay reachable when maximized" — DELETED. No
  // resize-handle DOM concept exists in the hybrid overlay chrome (native
  // window edges/corners are the resize affordance instead); no hybrid
  // equivalent to port.

  // Formerly "drag out of maximized state restores original size" —
  // DELETED. Hybrid host windows ARE draggable (see the hold-to-drag
  // machinery referenced in recent hybrid commits), but no existing test
  // bridge affordance simulates a window-chrome drag gesture deterministically
  // headless, and building one is out of scope here (would mean either new
  // main-process test-bridge surface or relying on unobservable real OS drag
  // — see the hybrid focus/input LESSON in apps/desktop/CLAUDE.md). FLAGGED AS
  // A POSSIBLE COVERAGE GAP: whether dragging a maximized hybrid host restores
  // its original (pre-maximize) size is untested here.

  // Formerly "webview border-radius removed when maximized" — DELETED. Pure
  // canvas CSS on the content page's own DOM element; no hybrid equivalent
  // (the content window is a native BaseWindow, not a styled DOM node).

  test('double-click navbar triggers maximize', async () => {
    const windowId = await openHybridWindow(sharedBgWindow, 'https://example.com');

    const activated = await setActive(sharedApp, { id: windowId, contentWcId: null });
    expect(activated).toBe(true);
    await waitOverlayReady(sharedApp);

    await sendShowNavbar(sharedApp, { id: windowId, contentWcId: null });
    await expect
      .poll(async () => (await overlayChromeState(sharedApp))?.navbarVisible, { timeout: 5000 })
      .toBe(true);

    await dblClickOverlayNavbar(sharedApp);

    await expect
      .poll(async () => (await findEntry(sharedBgWindow, windowId))?.maximized, { timeout: 5000 })
      .toBe(true);

    await closeWindow(sharedBgWindow, windowId);
  });
});
