import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

/**
 * Switcher selection raises the picked window — the real end-to-end path.
 *
 * Selecting a card in the Windows switcher (`features/windows/windows.js`
 * `createWindowCard`'s `card-click` handler) calls
 * `api.window.setOverlayFocusTarget(win.id)`, then closes the switcher
 * window. That IPC arms the kernel's own selection latch
 * (`window-kernel.ts State.pendingSelectionFocus`) with both windows
 * resolved to `WindowId`s while they are still alive, and the kernel's
 * `WindowClosed` rule spends it when the switcher goes, raising the picked
 * window. `hybrid-windows-feature.spec.ts` drives the test bridge's
 * `focusHost` directly and never exercises this chain, so the legacy-engine
 * deletion (`f189496b`) left the raise block empty with no test noticing —
 * selecting a window in the switcher silently did nothing until `3de858f8`
 * restored it. This spec is the only end-to-end cover for the chain, which
 * is why it outlived the move of the decision into the kernel.
 *
 * The target is a real `http://` content window: `izui-roles.ts
 * inferIzuiRole` only ever assigns `content`/`child-content` when
 * `ctx.isWebPage` is true, and a real content window is a hybrid
 * BaseWindow — invisible to Playwright as a `Page` (see the constraint
 * documented in `izui-escape.spec.ts`'s palette-opener regression test).
 * So the raise is observed the way this suite observes any hybrid-host
 * state change it cannot see through a `Page`: the kernel's own transition
 * record (`window-kernel-executor.ts timelineForTests`, reachable here via
 * `__peek_test.kernelTimelineForTest`). `RaiseWindow`'s `decide` manufactures
 * its `OsFocusGained` event synchronously, with no real OS confirmation
 * involved — a headless-safe read of the SAME decision a real raise makes,
 * not a stand-in for one.
 *
 * The switcher window itself (`peek://windows/windows.html`) is an ordinary
 * tile `BrowserWindow` (Tile Architecture — not a hybrid page-host), so it
 * IS a Playwright `Page`, and the switcher-selection UI (the card click) is
 * driven for real.
 *
 *   yarn test:grep "Switcher selection raises"
 */
test.describe('Switcher selection raises the picked window @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('switcher-select-raise'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Switcher Target</title></head><body>target</body></html>');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('selecting a card in the switcher raises that window via kernelRaiseWindow', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    // A real content window (http://) — a hybrid BaseWindow, the same kind
    // the switcher lists and the same kind the fix restores focus to.
    const targetUrl = `http://127.0.0.1:${serverPort}/`;
    const targetResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 400, height: 300 });
    }, targetUrl);
    expect(targetResult.success).toBe(true);
    const targetId: number = targetResult.id;

    // The kernel's own WindowId for the target — the id the timeline
    // records transitions against (`window-kernel-executor.ts` keys
    // everything on this, not the Electron window id).
    const targetWmId = await app.evaluateMain!(((_e: unknown, id: number) => {
      return (globalThis as any).__peekHybridOverlayTest.machineWindowIdFor(id);
    }) as any, targetId);
    expect(targetWmId, 'target never registered with the window-state machine').toBeTruthy();

    // Open the real switcher the way the global hotkey does — publish
    // cmd:execute:windows (the exact pattern windows-lazy-wake.spec.ts uses).
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('windows');
    });
    const switcherWindow = await app.getWindow('windows/windows.html', 15000);
    expect(switcherWindow).toBeTruthy();
    await switcherWindow.waitForLoadState('domcontentloaded');

    // Wait for the target's card to render — proves the switcher's own
    // `api.window.list` enumeration saw the real content window, not a
    // fixture stand-in.
    const cardSelector = `peek-card[data-window-id="${targetId}"]`;
    await switcherWindow.waitForSelector(cardSelector, { timeout: 10000 });

    // Baseline: everything the kernel has recorded up to (but not
    // including) the selection. The target's own fresh-open already grabbed
    // key once — only entries AFTER this index count as evidence of the
    // switcher's raise.
    const baselineLen = (await app.evaluateMain!((_e: unknown) => {
      return (globalThis as any).__peek_test.kernelTimelineForTest().length;
    })) as number;

    // The real selection path: click the card (`card-click` →
    // `api.window.setOverlayFocusTarget(win.id)` → `window.close()`), the
    // exact chain `features/windows/windows.js createWindowCard` wires up.
    await switcherWindow.click(cardSelector);

    // Wait for the switcher window to actually close — the async
    // `setOverlayFocusTarget` IPC round-trip must land before `window.close()`
    // runs, because it is what arms the latch, and the kernel's `WindowClosed`
    // rule (the code under test) can only spend one that is already armed.
    await expect.poll(() => switcherWindow.isClosed(), { timeout: 5000 }).toBe(true);

    // The kernel's own transition record: a fresh `OsFocusGained` for the
    // target, landing the key on it — the same decision `RaiseWindow`
    // (`kernelRaiseWindow`, called from the `closed` handler) makes
    // synchronously, headless or not.
    await expect.poll(async () => {
      const timeline = (await app.evaluateMain!((_e: unknown) => {
        return (globalThis as any).__peek_test.kernelTimelineForTest();
      })) as string[];
      const fresh = timeline.slice(baselineLen);
      const pattern = new RegExp(`OsFocusGained\\(${targetWmId}\\) key=(?:\\S*->)?${targetWmId}\\b`);
      return fresh.some((line) => pattern.test(line));
    }, { timeout: 5000 }).toBe(true);
  });
});
