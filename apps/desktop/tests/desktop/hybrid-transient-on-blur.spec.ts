import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

// Regression (peek item 8e5c3174), found dogfooding 2026-06-09 right after the
// hybrid page-host menu/shortcut fix (b1dd4e7c) restored the peek/slide hotkeys.
//
// Peeks and slides open with `{ role: 'quick-view', modal: true, pageHost: true }`.
// Under the hybrid page-host default (2026-06-08) `pageHost: true` routes them to
// the hybrid BaseWindow branch — so they are now BaseWindows, NOT BrowserWindows.
//
// The IZUI transient-on-blur autoclose (a window gaining focus closes its
// transient palette/quick-view siblings) lived ENTIRELY on `BrowserWindow`:
//   - the focuser-driven loop ran only in `win.on('focus')` (BrowserWindow), and
//   - it enumerated only `getAllLiveWindows()` (BrowserWindow.getAllWindows).
// So a hybrid quick-view was invisible to the loop as a CANDIDATE, and a hybrid
// window gaining focus never RAN the loop. Net effect: open a peek/slide, click
// another window — the peek/slide stayed open. This is the failing repro.
//
// Test mechanics mirror transient-on-blur.spec.ts: HEADLESS Electron and
// Playwright don't deliver reliable native panel focus, so focus is driven
// synthetically through `__peek_test.fireWindowFocus`, which emits the window's
// 'focus' event directly and runs the production autoclose handler.
test.describe('Hybrid transient on blur auto-hide @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  // A non-transient visible workspace BrowserWindow that (a) keeps `maybeHideApp`
  // from hiding the whole app when a transient auto-closes, and (b) acts as the
  // focuser whose `fireWindowFocus` drives the autoclose loop.
  let anchorId: number | null = null;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-transient-on-blur'));

    const anchorResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('about:blank', {
        role: 'workspace',
        width: 800,
        height: 600,
        key: 'hybrid-transient-on-blur-anchor',
        // show:false + focusable:false keep the anchor out of the WM focus race;
        // the test is the sole focus driver (see transient-on-blur.spec.ts).
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

  // Sweep any leaked hybrid quick-view test windows between tests so a failure
  // mid-flight doesn't bleed into the next test's autoclose iteration.
  test.afterEach(async () => {
    if (!bgWindow) return;
    // A test that fires an app resign leaves the app inactive. The next test's
    // opens would then be made while another app is focused and a Peek window
    // holds key, which makes every window opened to show transient
    // (`izui-roles.ts windowIsTransient`), so Peek is brought back first.
    try {
      await app.evaluateMain?.(() => (globalThis as any).__peek_test.fireAppBecomeActive());
    } catch { /* app may be gone */ }
    try {
      await bgWindow.evaluate(async (keepId: number) => {
        const r = await (window as any).app.window.list({ includeInternal: true, includeHidden: true });
        if (!r?.success) return;
        for (const w of r.windows) {
          if (w.id === keepId) continue;
          if (w.params?.role !== 'quick-view') continue;
          try { await (window as any).app.window.close(w.id); } catch { /* maybe gone */ }
        }
      }, anchorId ?? -1);
    } catch { /* test may have torn things down */ }
  });

  /**
   * Open a real hybrid quick-view (peek/slide shape: role quick-view + modal +
   * pageHost). `pageHost: true` forces the hybrid BaseWindow branch under the
   * hybrid default. Returns the hybrid window id. Uses a data: URL for network-free,
   * deterministic content (the hybrid branch awaits the content load).
   */
  async function openHybridQuickView(key: string): Promise<number> {
    const result = await bgWindow.evaluate(async (key: string) => {
      return await (window as any).app.window.open(
        'data:text/html,<title>QuickView</title>peek',
        {
          role: 'quick-view',
          modal: true,
          pageHost: true,
          type: 'panel',
          width: 400,
          height: 300,
          key: `hybrid-transient-on-blur-${key}`,
        },
      );
    }, key);
    if (!result.success) {
      throw new Error(`hybrid quick-view open failed for key=${key}: ${JSON.stringify(result)}`);
    }
    return result.id as number;
  }

  /** Synchronously dispatch the window's 'focus' event (runs the autoclose loop). */
  async function fireFocus(windowId: number): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const fired = await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.fireWindowFocus(wid),
      windowId,
    );
    if (!fired) throw new Error(`fireWindowFocus returned false for id=${windowId}`);
  }

  /**
   * Ground truth for "is this hybrid BaseWindow still alive": the hybrid
   * registry, via `__peek_test.isHybridWindowForTest`. We deliberately do NOT
   * use `app.window.list().visible` here — `getWindowPresentation` for a hybrid
   * window can transiently return null (dropping it from the list) even while the
   * BaseWindow is fully alive, which makes a list-based "is it gone?" check pass
   * falsely. The registry entry is removed only on a real close.
   */
  async function hybridAlive(windowId: number): Promise<boolean> {
    return app.evaluateMain!((_e, id) => {
      const pt = (globalThis as any).__peek_test;
      return !!(pt?.isHybridWindowForTest && pt.isHybridWindowForTest(id));
    }, windowId);
  }

  test('a focused workspace window closes a hybrid quick-view sibling', async () => {
    const qv = await openHybridQuickView('qv-vs-workspace');
    // Precondition: the hybrid quick-view BaseWindow is alive in the registry.
    expect(await hybridAlive(qv)).toBe(true);

    // Focus the workspace anchor — the production transient-on-blur autoclose
    // must dismiss the transient hybrid quick-view sibling.
    await fireFocus(anchorId!);

    // Poll the registry (not the window list) until the hybrid BaseWindow is
    // actually destroyed.
    await expect.poll(() => hybridAlive(qv), { timeout: 4000 }).toBe(false);
  });

  test('opening (focusing) a second hybrid quick-view closes the first', async () => {
    // Two hybrid quick-views (the peek/slide "open B over A" scenario). This
    // drives the autoclose through the HYBRID focus path (onHybridHostFocus),
    // not the BrowserWindow one — the second half of the regression: a hybrid
    // window gaining focus must also run the transient-sibling autoclose.
    const a = await openHybridQuickView('qv-a');
    expect(await hybridAlive(a)).toBe(true);

    // Opening B activates it, and that activation IS the hybrid focus — it
    // reports as a machine-caused focus, which is deliberately not suppressed,
    // so the transient-sibling autoclose runs on the open itself. A is
    // dismissed here, before any separate focus event is fired.
    const b = await openHybridQuickView('qv-b');
    await expect.poll(() => hybridAlive(a), { timeout: 4000 }).toBe(false);
    expect(await hybridAlive(b)).toBe(true);
  });

  /** Emit the app-level did-resign-active (Cmd+Tab to another app). */
  async function fireAppResign(): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    await app.evaluateMain(() => (globalThis as any).__peek_test.fireAppResignActive());
  }

  /** Emit the app-level did-become-active (Peek returns to foreground). */
  async function fireAppBecome(): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    await app.evaluateMain(() => (globalThis as any).__peek_test.fireAppBecomeActive());
  }

  /**
   * Open a hybrid web page (NON-transient: role 'workspace'). `pageHost: true`
   * with no modal routes to the hybrid branch; inferIzuiRole yields 'workspace'
   * for a non-modal non-webpage URL. Used to prove app-blur dismissal is scoped
   * to transient surfaces only.
   */
  async function openHybridPage(key: string): Promise<number> {
    const result = await bgWindow.evaluate(async (key: string) => {
      return await (window as any).app.window.open(
        'data:text/html,<title>Page</title>page',
        { pageHost: true, width: 800, height: 600, key: `hybrid-transient-on-blur-${key}` },
      );
    }, key);
    if (!result.success) {
      throw new Error(`hybrid page open failed for key=${key}: ${JSON.stringify(result)}`);
    }
    return result.id as number;
  }

  test('switching to another app dismisses an open hybrid quick-view', async () => {
    const qv = await openHybridQuickView('qv-app-switch');
    expect(await hybridAlive(qv)).toBe(true);

    // Cmd+Tab to another app — the transient peek/slide must dismiss even though
    // no OTHER Peek window gained focus (the focuser-driven path can't fire).
    await fireAppResign();
    await expect.poll(() => hybridAlive(qv), { timeout: 4000 }).toBe(false);
  });

  test('switching apps does NOT close a non-transient hybrid web page', async () => {
    const page = await openHybridPage('page-survives-app-switch');
    expect(await hybridAlive(page)).toBe(true);

    await fireAppResign();
    // Wait past the deferred-close settle window (electron-window-backend.ts
    // APP_RESIGN_SETTLE_MS),
    // then assert the non-transient page survived the close pass.
    await new Promise((r) => setTimeout(r, 800));
    expect(await hybridAlive(page)).toBe(true);

    await bgWindow.evaluate(async (wid: number) => {
      try { await (window as any).app.window.close(wid); } catch { /* ignore */ }
    }, page);
  });

  test('the startup resign→become activation dance does NOT dismiss a fresh slide', async () => {
    // Reproduces the user-reported "slide hotkey does nothing the first time
    // after startup" bug: macOS fires a brief did-resign-active → did-become-
    // active dance during boot window restoration. A slide opened right then
    // must survive — the resign must NOT close it because a become immediately
    // follows. (Without the deferred-with-cancel guard, the resign edge closed
    // the slide instantly.)
    const qv = await openHybridQuickView('qv-startup-dance');
    expect(await hybridAlive(qv)).toBe(true);

    await fireAppResign();   // resign edge of the dance
    await fireAppBecome();    // become edge cancels the pending close

    // Wait well past the settle window; the slide must still be alive.
    await new Promise((r) => setTimeout(r, 800));
    expect(await hybridAlive(qv)).toBe(true);

    await bgWindow.evaluate(async (wid: number) => {
      try { await (window as any).app.window.close(wid); } catch { /* ignore */ }
    }, qv);
  });
});
