import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady, waitForAppReady } from '../helpers/window-utils';

/**
 * Plain Enter in the cmd palette on a URL that is ALREADY open in a live content
 * window opens a NEW window: the panel's open request passes `reuseByUrl: false`
 * so main's same-URL reuse (which other callers keep) is skipped. Switching to
 * the open window is the explicit switch action only (see
 * cmd-switch-to-page.spec.ts). This asserts the user-observable outcome — the
 * content-window count grows — for a typed `example.com` whose registry entry
 * is the normalized `https://example.com/`.
 */
test.describe('Cmd URL window reuse @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-url-window-reuse'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // Resolve the cmd panel page for one cycle from the live window list: a
  // `cmd/panel.html` page that is NOT closed and is NOT `exclude` (the panel a
  // previous cycle drove, which may still be tearing down). `app.getWindow`
  // returns the first URL match without checking `isClosed()`, so on the second
  // cycle it can hand back the dying first panel — the page then closes under
  // `fill`/`keyboard.press` ("Target page, context or browser has been closed").
  // Liveness and distinctness are proven here before the page is driven.
  const livePanelPage = async (exclude?: Page): Promise<Page> => {
    const pick = () =>
      app
        .windows()
        .find(p => p.url().includes('cmd/panel.html') && !p.isClosed() && p !== exclude);
    await expect
      .poll(() => pick() !== undefined, {
        timeout: 10000,
        message: 'a live cmd/panel.html page distinct from the previous cycle\'s',
      })
      .toBe(true);
    const panel = pick()!;
    expect(panel.isClosed()).toBe(false);
    return panel;
  };

  // Open the cmd panel, type `text`, press Enter. Synchronizes on the panel's
  // FSM leaving TYPING (it transitions to EXECUTING/CLOSING/IDLE once the URL
  // open IPC has been dispatched) — deterministic, no fixed sleep. Because the
  // reuse-vs-create decision happens synchronously inside the awaited
  // window-open IPC, the window-list state is final by the time this resolves.
  // Returns the panel page it drove, so the caller can wait for that exact page
  // to close before opening the next one.
  const openViaCmd = async (text: string, excludePanel?: Page): Promise<Page> => {
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true,
        width: 600,
        height: 50,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        center: true,
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await livePanelPage(excludePanel);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await cmdWindow.fill('input', text);
    // Keydown only, not `press`. The panel executes on Enter keydown
    // (renderer/cmd/panel.js commandInput 'keydown'); opening the URL moves
    // focus to the content window, and that focus change dismisses the panel
    // (the `[wm]` transient sweep logs `effect-close effect=DismissWindow` for
    // the panel) within a few ms. `press` = keydown + keyup, so the keyup
    // could be dispatched to an already-closed page ("Target page, context or
    // browser has been closed"). Nothing in the panel listens for Enter keyup.
    await cmdWindow.keyboard.down('Enter');
    // Wait for the panel to leave TYPING — the Enter has been handled and the
    // URL-open dispatched. Tolerate the panel already having closed (terminal).
    try {
      await cmdWindow.waitForFunction(
        () => {
          const s = (window as any)._cmdState;
          return s && s.currentState && s.currentState !== 'TYPING';
        },
        undefined,
        { timeout: 10000 }
      );
    } catch {
      // Panel window torn down during the wait — that's a terminal post-execute
      // state, which is exactly what we were waiting for.
    }
    return cmdWindow;
  };

  // Snapshot of live content windows referencing example.com, fetched via the
  // window-list IPC. Returns ids + which are focused.
  const exampleWindows = async (): Promise<{ ids: number[]; focusedIds: number[] }> => {
    return await bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list();
      const matches = (list.windows || []).filter((w: any) =>
        w.url && (w.url.includes('example.com') || w.url.includes('example%2Ecom'))
      );
      return {
        ids: matches.map((w: any) => w.id),
        focusedIds: matches.filter((w: any) => w.focused).map((w: any) => w.id),
      };
    });
  };

  test('plain Enter on an already-open URL opens a new window; the open one is not reused', async () => {
    await waitForExtensionsReady(bgWindow, 15000);
    await waitForAppReady(bgWindow);

    // Subscribe to window:opened on the bg renderer and accumulate the count of
    // FRESH example.com window creations into a renderer-side counter. The
    // reuse path does NOT publish window:opened (it never creates a window), so
    // this counter is the deterministic signal that distinguishes
    // "reused existing" (counter stays 1) from "spawned duplicate" (counter 2).
    await bgWindow.evaluate(() => {
      const api = (window as any).app;
      (window as any).__exampleOpenedCount = 0;
      api.subscribe('window:opened', (msg: any) => {
        const u = msg?.url || '';
        if (u.includes('example.com') || u.includes(encodeURIComponent('example.com'))) {
          (window as any).__exampleOpenedCount++;
        }
      });
    });

    // First open. Typing `example.com` (no trailing slash) means getValidURL
    // yields `https://example.com`, while the registry stores the normalized
    // `https://example.com/`. Exact-string matching used to miss this on
    // re-open and spawn a duplicate; the normalized match must not.
    const firstPanel = await openViaCmd('example.com');

    // Deterministic: wait for the first (and only) creation event.
    await bgWindow.waitForFunction(
      () => (window as any).__exampleOpenedCount === 1,
      undefined,
      { timeout: 10000 }
    );

    const afterFirst = await exampleWindows();
    expect(afterFirst.ids.length).toBe(1);
    const firstId = afterFirst.ids[0];
    expect(firstId).toBeGreaterThan(0);

    // Second open of the SAME target via the cmd path. Reuse must raise the
    // existing window WITHOUT publishing a new window:opened event. openViaCmd
    // resolves only after the URL-open IPC has been dispatched and resolved, so
    // the window-list state below is final (the reuse decision is synchronous
    // inside that IPC).
    //
    // First wait for the first panel to be gone. Pressing Enter starts its
    // teardown but does not finish it, and until it finishes the window list
    // still carries that page. `close` on the page object is the deterministic
    // teardown signal — the panel is destroyed after executing, not reused.
    if (!firstPanel.isClosed()) {
      await firstPanel.waitForEvent('close');
    }
    expect(firstPanel.isClosed()).toBe(true);

    // The second cycle must drive a different, live panel page.
    const secondPanel = await openViaCmd('example.com', firstPanel);
    expect(secondPanel).not.toBe(firstPanel);

    // Plain Enter opens a NEW window even though the page is open: the creation
    // counter reaches 2. Switching to the open window is the explicit switch
    // action only (button, row marker, Cmd+Enter).
    await bgWindow.waitForFunction(
      () => (window as any).__exampleOpenedCount === 2,
      undefined,
      { timeout: 10000 }
    );

    const afterSecond = await exampleWindows();
    expect(afterSecond.ids.length).toBe(2);
    expect(afterSecond.ids).toContain(firstId);

    // Clean up.
    for (const id of afterSecond.ids) {
      await bgWindow.evaluate(async (winId: number) => {
        await (window as any).app.window.close(winId);
      }, id);
    }
  });
});
