import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

// IZUI policy: a transient window (`izui-roles.ts windowIsTransient`: opened
// with `modal`, or `overlay` taking input) must auto-hide when another
// non-utility window gains focus.
// Driven from main-process `win.on('focus')` in apps/desktop/main/ipc.ts —
// macOS NSPanels don't fire reliable per-window blur on intra-app focus
// shifts, so the focuser closes its transient siblings explicitly.
//
// Exceptions:
//   - 'utility' role focusing (chain popup) MUST NOT close its transient parent
//   - 'overlay' role being-focused-on is skipped (managed by IZUI coordinator)
//
// Test mechanics: HEADLESS Electron creates windows with `show: false`, and
// macOS panel-type windows don't get reliable native focus events under
// Playwright. Both signals are simulated through `__peek_test.showWindow`
// and `__peek_test.fireWindowFocus`, which manipulate the BrowserWindow
// state machine directly. This bypasses the unreliable native path while
// still exercising the production focus-handler code (the for-loop that
// iterates visible transient siblings and calls closeOrHideWindow).

test.describe('Transient on blur auto-hide @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // Anchor: a non-transient visible window that keeps the app on screen when
  // a transient gets auto-closed. (`window-kernel.ts holdsAppOnScreen` excludes
  // some window classes, so without an anchor a test could hide the app on
  // the first autoclose, marking the focuser non-visible.)
  let anchorId: number | null = null;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('transient-on-blur'));

    const anchorResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('about:blank', {
        role: 'workspace',
        width: 800,
        height: 600,
        key: 'transient-on-blur-anchor',
        // `show: false` + `focusable: false` keep the test isolated from
        // window-manager focus events. The original macOS HEADLESS path
        // never received natural focus events because show:false NSPanels
        // don't get them; under Linux/Xvfb a visible focusable window WILL
        // get them, and natural focus → win.on('focus') handler →
        // closeOrHideWindow cascades wreck the synthetic-focus assertions
        // (and even cancel in-flight loadURL with ERR_FAILED). The tests
        // drive focus through __peek_test.fireWindowFocus (which calls
        // `win.emit('focus')` directly — works regardless of focusable),
        // and __peek_test.showWindow uses showInactive, so the only
        // signals the production code sees are the ones the test fired.
        show: false,
        focusable: false,
      });
    });
    if (!anchorResult.success) {
      throw new Error(`anchor window failed: ${JSON.stringify(anchorResult)}`);
    }
    anchorId = anchorResult.id as number;
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.showWindow(wid),
      anchorId,
    );
  });

  test.afterAll(async () => {
    if (anchorId != null && bgWindow) {
      try {
        await bgWindow.evaluate(async (wid: number) => {
          await (window as any).app.window.close(wid);
        }, anchorId);
      } catch { /* ignore */ }
    }
    if (app) await app.close();
  });

  // Tests in this file open palette/quick-view/overlay windows pointed at
  // about:blank. When a test fails mid-flight (Linux WM-driven focus races
  // have made this a real possibility — see 2026-05-08 fix run) those
  // windows leak into the next test, where the focus handler iterates them
  // as transient siblings and produces cascading misbehavior in unrelated
  // assertions. Sweep specifically about:blank test windows (excluding the
  // anchor) after each test. Whitelist by address — anything else (the bg
  // window, system tiles, peek:// hosts) is left alone.
  test.afterEach(async () => {
    if (!bgWindow) return;
    try {
      await bgWindow.evaluate(async (keepId: number) => {
        const r = await (window as any).app.window.list({ includeInternal: true, includeHidden: true });
        if (!r?.success) return;
        for (const w of r.windows) {
          if (w.id === keepId) continue;
          if (w.address !== 'about:blank') continue;
          try { await (window as any).app.window.close(w.id); } catch { /* may already be closed */ }
        }
      }, anchorId ?? -1);
    } catch { /* test may have already torn things down */ }
  });

  /**
   * Open a panel-style window with the given role and force it visible
   * (HEADLESS Electron skips show()). Returns the window id.
   *
   * about:blank is used because modal/panel windows in this codebase await
   * loadURL — a non-resolving https:// URL would surface ERR_NAME_NOT_RESOLVED
   * as a window-open failure before the test could exercise the autoclose.
   */
  async function openVisibleWindow(role: string, key: string): Promise<number> {
    const result = await bgWindow.evaluate(async ({ role, key }: { role: string; key: string }) => {
      return await (window as any).app.window.open('about:blank', {
        role,
        modal: true,
        type: 'panel',
        width: 400,
        height: 300,
        // Distinct key per call so the open path doesn't dedupe against
        // an existing about:blank window.
        key: `transient-on-blur-${key}`,
        // `show: false` defers visibility to __peek_test.showWindow
        // (which uses showInactive — see entry.ts) so opening the window
        // doesn't fire a native WM focus event that would race with the
        // synthetic fireWindowFocus path the test uses to drive
        // assertions. (We don't add `focusable: false` here because modal
        // panels need to remain focusable for the production focus
        // handler to behave realistically when fireWindowFocus emits.)
        show: false,
      });
    }, { role, key });
    if (!result.success) {
      throw new Error(`window.open failed for role=${role} key=${key}: ${JSON.stringify(result)}`);
    }
    const id = result.id as number;
    // Force show — HEADLESS Electron defaults to show:false.
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const shown = await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.showWindow(wid),
      id,
    );
    if (!shown) throw new Error(`__peek_test.showWindow returned false for id=${id}`);
    return id;
  }

  /**
   * Synchronously dispatch the BrowserWindow 'focus' event for the given
   * window. The production autoclose loop runs inside the focus listener,
   * so this is what drives all assertions in the suite.
   */
  async function fireFocus(windowId: number): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const fired = await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.fireWindowFocus(wid),
      windowId,
    );
    if (!fired) throw new Error(`__peek_test.fireWindowFocus returned false for id=${windowId}`);
  }

  /** True if the window is currently in the list AND visible. */
  async function isVisible(windowId: number): Promise<boolean> {
    return await bgWindow.evaluate(async (wid: number) => {
      const result = await (window as any).app.window.list({ includeInternal: true, includeHidden: true });
      if (!result.success) return false;
      const w = result.windows.find((x: any) => x.id === wid);
      return w !== undefined && w.visible === true;
    }, windowId);
  }

  /**
   * Wait until the given window is no longer visible (closed/destroyed or
   * hidden via closeOrHideWindow). Polls the window list deterministically;
   * no fixed sleep.
   */
  async function waitForHidden(windowId: number, timeout = 3000): Promise<void> {
    await bgWindow.waitForFunction(
      async (wid: number) => {
        const result = await (window as any).app.window.list({ includeInternal: true });
        if (!result.success) return false;
        const w = result.windows.find((x: any) => x.id === wid);
        return w === undefined || w.visible !== true;
      },
      windowId,
      { timeout }
    );
  }

  /** Close a window, ignoring already-closed errors. */
  async function closeWindow(windowId: number): Promise<void> {
    try {
      await bgWindow.evaluate(async (wid: number) => {
        await (window as any).app.window.close(wid);
      }, windowId);
    } catch { /* may already be closed */ }
  }

  test('palette closes when another palette opens', async () => {
    const a = await openVisibleWindow('palette', 'palette-a');
    const b = await openVisibleWindow('palette', 'palette-b');
    // Drive the production focus path on b.
    await fireFocus(b);
    await waitForHidden(a);
    expect(await isVisible(b)).toBe(true);
    await closeWindow(b);
  });

  test('palette closes when a quick-view opens', async () => {
    const palette = await openVisibleWindow('palette', 'palette-then-qv');
    const slide = await openVisibleWindow('quick-view', 'qv-after-palette');
    await fireFocus(slide);
    await waitForHidden(palette);
    expect(await isVisible(slide)).toBe(true);
    await closeWindow(slide);
  });

  test('quick-view closes when another quick-view opens', async () => {
    const a = await openVisibleWindow('quick-view', 'qv-a');
    const b = await openVisibleWindow('quick-view', 'qv-b');
    await fireFocus(b);
    await waitForHidden(a);
    expect(await isVisible(b)).toBe(true);
    await closeWindow(b);
  });

  test('utility that declares the palette as its parent survives the utility focusing (chain popup invariant)', async () => {
    const palette = await openVisibleWindow('palette', 'palette-with-child');
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    // Open the utility (chain popup) window FROM the palette's own renderer —
    // exactly how `renderer/cmd/panel.js openChainPopup()` calls
    // `api.window.open(..., { declareParent: true })` — so ipc.ts resolves
    // `ev.sender` to the palette and records it as the utility's machine-level
    // `parentId` (window-kernel.ts). `executeJavaScript` runs in the palette's
    // own main-world context (the same world `contextBridge` exposes
    // `window.app` into), so the open call's sender genuinely is the palette,
    // not this test harness.
    const openResult = await app.evaluateMain<{ success: boolean; id?: number }, number>(
      (electron, openerId) => {
        const win = electron.BrowserWindow.fromId(openerId);
        if (!win) throw new Error(`no BrowserWindow for id=${openerId}`);
        return win.webContents.executeJavaScript(`
          window.app.window.open('about:blank', {
            role: 'utility',
            modal: true,
            type: 'panel',
            width: 400,
            height: 300,
            key: 'transient-on-blur-chain-popup-child',
            show: false,
            declareParent: true,
          })
        `);
      },
      palette,
    );
    if (!openResult.success || !openResult.id) {
      throw new Error(`open failed: ${JSON.stringify(openResult)}`);
    }
    const utility = openResult.id;
    const shown = await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.showWindow(wid),
      utility,
    );
    if (!shown) throw new Error(`__peek_test.showWindow returned false for id=${utility}`);

    // Drive focus to the utility — the production check skips the autoclose
    // loop for the palette ONLY because the utility declares it as its
    // machine-level parent (`focuser.parentId === rec.id` in
    // `selectTransientAutoclose`), not because of the utility's role.
    await fireFocus(utility);
    expect(await isVisible(palette)).toBe(true);
    expect(await isVisible(utility)).toBe(true);
    await closeWindow(utility);
    await closeWindow(palette);
  });

  test('overlay attached to a host survives a palette focusing (ownership, not role)', async () => {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    // Attach the shared chrome overlay singleton to a fake hybrid host through
    // the same E2E bridge the hybrid-overlay suite uses (`hybrid-overlay.ts`
    // `installTestBridge`) — this drives the real `AttachOverlay` command and
    // its `OverlayAttached` event, which sets `overlayFor` on the overlay's
    // kernel record (window-kernel.ts `evolve`).
    const { hostId, overlayId } = await app.evaluateMain<{ hostId: number; overlayId: number }, void>(
      () => {
        const b = (globalThis as any).__peekHybridOverlayTest;
        const hostId = b.makeFakeHybridWindow({ x: 0, y: 0, width: 400, height: 300 });
        b.setActive(hostId);
        return { hostId, overlayId: b.overlayState().id };
      },
    );
    expect(await isVisible(overlayId)).toBe(true);

    const palette = await openVisibleWindow('palette', 'palette-after-overlay');
    // Palette focuses → autoclose loop runs but skips the overlay because its
    // record carries `overlayFor` (attached to the fake host above), not
    // because its role is 'overlay'.
    await fireFocus(palette);
    expect(await isVisible(overlayId)).toBe(true);
    expect(await isVisible(palette)).toBe(true);

    await closeWindow(palette);
    await app.evaluateMain<void, number>((_ctx, id) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
      b.destroyFakeHybridWindow(id);
    }, hostId);
  });
});
