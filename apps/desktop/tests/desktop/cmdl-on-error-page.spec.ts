/**
 * Cmd+L on a page-host showing a domain error overlay.
 *
 * User-reported bug:
 *   1. Open https://openstreetmaps.org (typo — domain doesn't resolve)
 *   2. Page-host loads, the load-error overlay renders
 *   3. Press Cmd+L
 *   Expected: address bar (navbar) opens, window stays the same size
 *   Actual:   address bar does NOT open, window MAXIMIZES
 *
 * Ported to the hybrid page-host (Stage B load-error overlay port, commit
 * 49b29723): the load-error card now renders in the SHARED overlay renderer
 * (`renderer/page/overlay.js`, `.load-error-overlay`), not inside the
 * content page's own DOM — the content window is a bare, main-owned
 * WebContentsView with no chrome of its own. This test opens a REAL hybrid
 * content window on an unresolvable URL, activates it (focus-free, via the
 * same `setActive` idiom every hybrid spec uses), waits for the overlay to
 * paint the load-error card, sends Cmd+L straight to the content
 * WebContents (the real before-input-event path), and asserts (a) bounds
 * unchanged, (b) navbar visible.
 *
 * The original canvas-era assertions about navbar/overlay z-index stacking
 * and the overlay not stretching to the full window no longer apply: navbar
 * and load-error card are painted in the SAME shared overlay document now
 * (not layered across the content page's own DOM and a floating chrome
 * window), so that particular stacking bug class can't recur the same way.
 *
 * Run with:
 *   yarn test:grep "Cmd\+L on error page"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { setActive, overlayChromeState, waitOverlayReady, getHybridContentWcId } from '../helpers/hybrid-page';

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

/** Open a REAL (non-fake) hybrid content window on `url` via the production window-open path. */
async function openHybridWindow(bgWindow: Page, url: string): Promise<number> {
  const result = await bgWindow.evaluate(async (targetUrl: string) => {
    return await (window as any).app.window.open(targetUrl, { width: 800, height: 600 });
  }, url);
  expect(result.success).toBe(true);
  return result.id as number;
}

/** Read `windowId`'s live entry (bounds, maximized, …) from the production window list. */
async function findEntry(bgWindow: Page, id: number): Promise<any> {
  return bgWindow.evaluate(async (targetId: number) => {
    const r = await (window as any).app.window.list({ includeInternal: false });
    if (!r?.success) return null;
    return (r.windows || []).find((w: any) => w.id === targetId) ?? null;
  }, id);
}

/**
 * Whether the shared overlay renderer currently has a `.load-error-overlay`
 * card painted. Direct BrowserWindow lookup + executeJavaScript — the same
 * technique `overlayChromeState()` itself uses internally — since the
 * load-error card isn't (yet) one of the fields the existing test-bridge
 * `overlayChromeState()` accessor exposes.
 */
async function overlayHasLoadErrorCard(app: DesktopApp): Promise<boolean> {
  return app.evaluateMain!(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find((w: Electron.BrowserWindow) => {
      try { return w.webContents.getURL().includes('page/overlay.html'); } catch { return false; }
    });
    if (!overlay) return false;
    return overlay.webContents.executeJavaScript("!!document.querySelector('.load-error-overlay')");
  });
}

test.describe('Cmd+L on error page @desktop', () => {
  test('Cmd+L on a page-host with a load-error overlay shows navbar without maximizing', async () => {
    const badUrl = 'http://nonexistent-cmdl-bug-xyz.invalid/';
    const windowId = await openHybridWindow(sharedBgWindow, badUrl);

    try {
      // Make this the active hybrid window so the shared overlay frames it
      // (focus-free synthetic activation — every hybrid spec drives windows
      // this way instead of real OS focus).
      const activated = await setActive(sharedApp, { id: windowId, contentWcId: null });
      expect(activated).toBe(true);
      await waitOverlayReady(sharedApp);

      // Wait for the load-error card to render (main records the
      // did-fail-load as per-host load-error state and live-publishes it to
      // the overlay for the active window — Stage B, commit 49b29723).
      await expect.poll(() => overlayHasLoadErrorCard(sharedApp), { timeout: 15000 }).toBe(true);

      // Confirm navbar is not visible yet (post-loading auto-hide).
      const beforeState = await overlayChromeState(sharedApp);
      expect(beforeState?.navbarVisible).toBe(false);

      const before = await findEntry(sharedBgWindow, windowId);
      expect(before?.maximized).toBe(false);
      const boundsBefore = before.bounds;

      // Synthesize Cmd+L (Ctrl+L on non-darwin) into the CONTENT
      // WebContents — this exercises the real before-input-event chain
      // (`wireHybridContentEvents` in ipc.ts → publish page:show-navbar →
      // overlay.js subscriber → show()). Playwright's keyboard.press
      // dispatches DOM events which do NOT trigger Electron's input
      // pipeline; sendInputEvent on the real content WC does.
      const contentWcId = await getHybridContentWcId(sharedApp, windowId);
      expect(contentWcId, 'content webContents must be resolvable for a live hybrid window').not.toBeNull();

      const modKey = process.platform === 'darwin' ? 'meta' : 'control';
      const sendResult = (await sharedApp.evaluateMain!(({ webContents }, args: { wcId: number; mod: string }) => {
        const wc = webContents.fromId(args.wcId);
        if (!wc) return { error: 'content webContents not found' };
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'l', modifiers: [args.mod] } as any);
        wc.sendInputEvent({ type: 'char', keyCode: 'l', modifiers: [args.mod] } as any);
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'l', modifiers: [args.mod] } as any);
        return { ok: true };
      }, { wcId: contentWcId as number, mod: modKey })) as any;
      expect(sendResult.error, JSON.stringify(sendResult)).toBeUndefined();

      // Navbar reveals...
      await expect
        .poll(async () => (await overlayChromeState(sharedApp))?.navbarVisible, { timeout: 5000 })
        .toBe(true);

      // ...and the host must NOT resize/maximize.
      const after = await findEntry(sharedBgWindow, windowId);
      expect(after?.maximized, 'Cmd+L on an error page must not maximize the window').toBe(false);
      expect(after?.bounds, 'Cmd+L on an error page must not change window bounds').toEqual(boundsBefore);
    } finally {
      await sharedBgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, windowId);
    }
  });
});
