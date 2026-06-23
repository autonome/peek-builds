import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * The modal self-close-on-blur handler (apps/desktop/main/ipc.ts, gated on
 * `windowSelfClosesOnBlur(options)`) is what `modal:true` ACTUALLY does in this
 * codebase: it wires `win.on('blur', …close)` so the window DESTROYS itself when
 * it loses focus. That transient-class behavior is what broke Lex OAuth login —
 * the auth window was opened `modal:true` and died the instant the user switched
 * to a password manager / 2FA app mid-login (peek 5b4fefdc). The fix opens such
 * windows with a persistent role (`utility`) instead, which must NOT self-close.
 *
 * Why this lives in desktop-serial and toggles E2E_TEST:
 * The handler is deliberately suppressed under E2E_TEST (`&& process.env.E2E_TEST
 * !== 'true'`) because parallel workers flicker focus and would close modal
 * cmd-panels mid-test — which is exactly the env this harness runs in. So to
 * exercise the PRODUCTION handler each test clears `process.env.E2E_TEST` in the
 * main process, lets the handler attach, then restores it in a finally. Serial
 * project (workers=1) so that global toggle can't race another worker's windows.
 *
 * Blur is driven synthetically via `__peek_test.fireWindowBlur` (win.emit('blur')):
 * headless Electron / macOS NSPanels don't emit reliable native blur on a window-
 * or app-switch (same reason the focus-driven autoclose path exists).
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

  /** Set or clear process.env.E2E_TEST in the MAIN process. */
  async function setE2ETest(on: boolean): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    await app.evaluateMain<boolean, boolean>((_ctx, value) => {
      if (value) process.env.E2E_TEST = 'true';
      else delete process.env.E2E_TEST;
      return true;
    }, on);
  }

  /** Open an invisible (show:false) about:blank window; returns its id. */
  async function openWindow(options: Record<string, unknown>): Promise<number> {
    const r = await bgWindow.evaluate(async (opts) => {
      return await (window as any).app.window.open('about:blank', opts);
    }, { width: 400, height: 300, show: false, ...options });
    if (!r.success) throw new Error(`window.open failed: ${JSON.stringify(r)}`);
    return r.id as number;
  }

  async function fireBlur(id: number): Promise<void> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    await app.evaluateMain<boolean, number>(
      (_ctx, wid) => (globalThis as any).__peek_test.fireWindowBlur(wid),
      id,
    );
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

  test('modal:true window destroys itself on blur', async () => {
    await setE2ETest(false); // let the production handler attach
    try {
      const id = await openWindow({ modal: true, type: 'panel', key: 'modal-blur-closes' });
      // The handler attaches ~100ms after open (setTimeout in ipc.ts). Fire blur
      // on a bounded poll until the window is gone — deterministic, no fixed-sleep
      // gamble on the exact attach moment.
      const deadline = Date.now() + 4000;
      let gone = false;
      while (Date.now() < deadline) {
        await fireBlur(id);
        if (!(await isPresent(id))) { gone = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(gone).toBe(true);
    } finally {
      await setE2ETest(true);
    }
  });

  test("role:'utility' window survives blur (the OAuth-window fix)", async () => {
    await setE2ETest(false); // handler logic fully active — utility must still be exempt
    try {
      const id = await openWindow({ role: 'utility', key: 'utility-blur-survives' });
      // Blur repeatedly across (and well past) the modal handler's ~100ms attach
      // window: a utility window must NEVER receive the self-close handler.
      for (let i = 0; i < 6; i++) {
        await fireBlur(id);
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(await isPresent(id)).toBe(true);
      await closeWindow(id);
    } finally {
      await setE2ETest(true);
    }
  });
});
