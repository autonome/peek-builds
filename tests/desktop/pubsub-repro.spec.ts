/**
 * Pubsub Repro Diagnostic Test
 *
 * Minimal reproduction of the websearch two-tile GLOBAL-scope pubsub
 * round-trip pattern. If this passes but websearch fails, the bug is
 * websearch-specific. If this fails, the bug is architectural to any
 * feature with bg + window tiles talking via pubsub.
 *
 *   bg (peek://ext/pubsub-repro/background.html)
 *      subscribe GLOBAL  reproduce:request     -> publish GLOBAL reproduce:response
 *   home (peek://pubsub-repro/home.html)
 *      subscribe GLOBAL  reproduce:response    -> window._reproResponse
 *      publish   GLOBAL  reproduce:request
 */

import { test, expect, DesktopApp, getSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);
});

test.describe('Pubsub Repro @desktop', () => {

  // Cross-tile GLOBAL pubsub round-trip: home-entry publishes, bg-entry
  // subscribes + responds, home-entry receives the response. Previously
  // broken: v2 tile window-entries opened via api.window.open() weren't
  // registered with the tile broadcaster, so inbound pubsub messages were
  // silently dropped. Fixed by registering such windows with
  // registerTrustedBuiltinWindow() in the window-open IPC handler.
  test('bg responds to home via GLOBAL pubsub round-trip', async () => {
    // Force-load the pubsub-repro extension by invoking its command.
    // Mirrors the websearch pattern at websearch.spec.ts:91-126.
    const extensionLoaded = await sharedBgWindow.evaluate(async () => {
      const api = (window as any).app;
      api.publish('cmd:execute:pubsub repro', {}, api.scopes.GLOBAL);
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const result = await api.extensions.list();
        if (result.success && result.data) {
          if (result.data.some(
            (e: { id: string; status: string }) => e.id === 'pubsub-repro' && e.status === 'running'
          )) return true;
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    });
    expect(extensionLoaded).toBe(true);

    // Open home window
    const result = await sharedBgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://pubsub-repro/home.html', {
        width: 400,
        height: 300,
      });
    });
    expect(result.success).toBe(true);

    const homeWindow = await sharedApp.getWindow('pubsub-repro/home.html', 5000);
    expect(homeWindow).toBeTruthy();
    await homeWindow.waitForLoadState('domcontentloaded');

    try {
      const response = await homeWindow.evaluate(async () => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const r = (window as any)._reproResponse;
          if (r) return r;
          await new Promise(r => setTimeout(r, 100));
        }
        return (window as any)._reproResponse;
      });

      expect(response).toBeTruthy();
      expect(response.ok).toBe(true);
      expect(response.payload).toEqual([1, 2, 3]);
    } finally {
      try {
        await sharedBgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, result.id);
      } catch {
        // window may already be closed
      }
    }
  });
});
