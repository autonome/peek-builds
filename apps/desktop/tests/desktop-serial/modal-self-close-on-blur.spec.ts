import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * The transient-dismissal law (`docs/design/window-manager.md` § "0. The
 * governing rule set") is what makes `modal:true` matter in this codebase: a
 * modal/panel window is a transient-autoclose candidate
 * (`window-kernel.ts isTransientAutocloseCandidate`, via
 * `WindowRecord.selfClosesOnBlur`), and the kernel dismisses it the moment
 * some other window genuinely takes key (`OsFocusGained` →
 * `selectTransientAutoclose`, run from `react`). That is what broke Lex OAuth
 * login — the auth window was opened `modal:true` and died the instant the
 * user switched to a password manager / 2FA app mid-login (peek 5b4fefdc).
 * The fix opens such windows with a persistent role (`utility`) instead,
 * which the law excludes from candidacy entirely (such a window is not
 * transient, and it never sets `selfClosesOnBlur`).
 *
 * The dismissal trigger is "another holder takes attention," not "loses
 * focus, any reason" — a bare blur with nothing gaining focus produces no
 * `OsFocusGained` and dismisses nothing (`window-kernel.ts evolve`'s
 * `OsFocusLost` arm only clears `key`; the focus-report sweep in `react`
 * diffs `State.lastAttention`, which only `OsFocusGained` writes). So these
 * tests drive the trigger the kernel actually acts on: open a second window
 * and hand it focus — the closest in-harness match to the real OAuth-window
 * gesture (the user clicking over to a password manager / 2FA app).
 * `__peek_test.showWindow` (`entry.ts`) makes a window visible without
 * focusing it — headless Electron / macOS NSPanels don't fire reliable
 * native show/focus — and `__peek_test.fireWindowFocus` drives the kernel's
 * `win.on('focus')` listener (`electron-window-backend.ts`) deterministically.
 *
 * Serial project (workers=1): both tests fire focus events against the same
 * process-global kernel, and a parallel worker's window opens would be
 * arbitrary extra `OsFocusGained` noise for `selectTransientAutoclose` to
 * chew on.
 */
test.describe('Modal self-close-on-blur (the OAuth-window trap — peek 5b4fefdc) @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('modal-self-close-on-blur'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /** Open an invisible (show:false) about:blank window; returns its id. */
  async function openWindow(options: Record<string, unknown>): Promise<number> {
    const r = await bgWindow.evaluate(async (opts) => {
      return await (window as any).app.window.open('about:blank', opts);
    }, { width: 400, height: 300, show: false, ...options });
    if (!r.success) throw new Error(`window.open failed: ${JSON.stringify(r)}`);
    return r.id as number;
  }

  /** Make a window visible WITHOUT focusing it (`entry.ts __peek_test.showWindow`). */
  async function showWindow(id: number): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const shown = await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.showWindow(wid),
      id,
    );
    if (!shown) throw new Error(`__peek_test.showWindow returned false for id=${id}`);
  }

  /** Drive the kernel's real `win.on('focus')` listener for the given window. */
  async function fireFocus(id: number): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    const fired = await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.fireWindowFocus(wid),
      id,
    );
    if (!fired) throw new Error(`__peek_test.fireWindowFocus returned false for id=${id}`);
  }

  async function isPresent(id: number): Promise<boolean> {
    return await bgWindow.evaluate(async (wid: number) => {
      const r = await (window as any).app.window.list({ includeInternal: true });
      if (!r.success) return false;
      return r.windows.some((w: any) => w.id === wid);
    }, id);
  }

  async function closeWindow(id: number): Promise<void> {
    try {
      await bgWindow.evaluate(async (wid: number) => {
        await (window as any).app.window.close(wid);
      }, id);
    } catch { /* may already be gone */ }
  }

  test('modal:true window is dismissed when another window takes focus', async () => {
    const modalId = await openWindow({ modal: true, type: 'panel', key: 'modal-focus-sweep' });
    await showWindow(modalId);
    const focuserId = await openWindow({ key: 'modal-focus-sweep-other' });
    await showWindow(focuserId);

    // The OAuth-window gesture: attention moves to a different window, and
    // the kernel's transient-dismissal sweep runs off that `OsFocusGained`.
    await fireFocus(focuserId);

    await expect.poll(() => isPresent(modalId)).toBe(false);
    await closeWindow(focuserId);
  });

  test("role:'utility' window survives the same trigger (the OAuth-window fix)", async () => {
    const utilityId = await openWindow({ role: 'utility', key: 'utility-focus-survives' });
    await showWindow(utilityId);
    const focuserId = await openWindow({ key: 'utility-focus-survives-other' });
    await showWindow(focuserId);

    // Same trigger as above, proving the law discriminates by candidacy
    // (the utility window is neither transient nor selfClosesOnBlur), not
    // "dismiss everything that isn't the newly-focused window."
    await fireFocus(focuserId);

    expect(await isPresent(utilityId)).toBe(true);
    await closeWindow(utilityId);
    await closeWindow(focuserId);
  });
});
