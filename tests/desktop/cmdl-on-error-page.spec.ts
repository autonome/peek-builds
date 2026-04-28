/**
 * Cmd+L on a page-host showing a domain error overlay.
 *
 * User-reported bug:
 *   1. Open https://openstreetmaps.org (typo — domain doesn't resolve)
 *   2. Page-host loads, webview shows DNS error → load-error-overlay renders
 *   3. Press Cmd+L
 *   Expected: address bar (navbar) opens, window stays the same size
 *   Actual:   address bar does NOT open, window MAXIMIZES
 *
 * This test pins the symptom: open page-host on an unresolvable URL, wait
 * for error overlay, capture initial bounds, press Cmd+L on the page-host,
 * assert (a) bounds unchanged, (b) navbar visible.
 *
 * Run with:
 *   yarn test:grep "Cmd\+L on error page"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';

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

async function openCanvasPage(
  bgWindow: Page,
  url: string,
): Promise<{ pageWindow: Page; windowId: number }> {
  const result = await bgWindow.evaluate(async (targetUrl: string) => {
    return await (window as any).app.window.open(targetUrl, {
      width: 800,
      height: 600,
    });
  }, url);
  expect(result.success).toBe(true);
  const pageWindow = await sharedApp.getWindow('page/index.html', 15000);
  expect(pageWindow).toBeTruthy();
  return { pageWindow, windowId: result.id };
}

test.describe('Cmd+L on error page @desktop', () => {
  test('Cmd+L on a page-host with a load-error overlay shows navbar without maximizing', async () => {
    const badUrl = 'http://nonexistent-cmdl-bug-xyz.invalid/';
    const { pageWindow, windowId } = await openCanvasPage(sharedBgWindow, badUrl);

    try {
      // Wait for the error overlay — same state the user reports.
      await pageWindow.waitForFunction(
        () => !!document.querySelector('.load-error-overlay'),
        undefined,
        { timeout: 15000 },
      );

      // Confirm navbar exists and is currently NOT visible (post-loading auto-hide).
      await pageWindow.waitForFunction(
        () => {
          const navbar = document.getElementById('navbar');
          return navbar && !navbar.classList.contains('visible');
        },
        undefined,
        { timeout: 10000 },
      );

      const beforeMaximized = await pageWindow.evaluate(
        () => document.body.classList.contains('maximized'),
      );
      expect(beforeMaximized).toBe(false);

      // Bring the page-host to front so Cmd+L is delivered to its webContents.
      await pageWindow.bringToFront();

      // Synthesize Cmd+L into the page-host webContents via Electron's
      // sendInputEvent — this exercises the full before-input-event chain
      // (host + guest handlers in ipc.ts → publish page:show-navbar →
      // page.js subscriber → show()), and the main.ts before-input-event
      // fallback. Playwright's keyboard.press dispatches DOM events which
      // do NOT trigger Electron's input pipeline.
      const sendResult = await sharedApp.evaluateMain!((electron: any) => {
        const { BrowserWindow, webContents } = electron;
        const wins = BrowserWindow.getAllWindows();
        const host = wins.find((w: Electron.BrowserWindow) =>
          w.webContents.getURL().includes('app/page/index.html'),
        );
        if (!host) return { error: 'no page-host window found' };
        const targets: Electron.WebContents[] = [host.webContents];
        const all = webContents.getAllWebContents();
        for (const wc of all) {
          if ((wc as any).hostWebContents?.id === host.webContents.id) {
            targets.push(wc);
          }
        }
        for (const wc of targets) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'l', modifiers: ['meta'] } as any);
          wc.sendInputEvent({ type: 'char', keyCode: 'l', modifiers: ['meta'] } as any);
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'l', modifiers: ['meta'] } as any);
        }
        return { ok: true, targetCount: targets.length, hostId: host.id };
      }) as any;
      expect(sendResult.error, JSON.stringify(sendResult)).toBeUndefined();

      // Give the renderer time to react. We wait for *either* navbar visible
      // OR maximized class — both are observable state changes — then assert.
      await pageWindow.waitForFunction(
        () => {
          const navbar = document.getElementById('navbar');
          const maxed = document.body.classList.contains('maximized');
          return (navbar && navbar.classList.contains('visible')) || maxed;
        },
        undefined,
        { timeout: 5000 },
      ).catch(() => { /* swallow — assertions below report the actual state */ });

      const afterMaximized = await pageWindow.evaluate(
        () => document.body.classList.contains('maximized'),
      );
      const navbarVisible = await pageWindow.evaluate(() => {
        const navbar = document.getElementById('navbar');
        return !!(navbar && navbar.classList.contains('visible'));
      });
      // Stacking check — the navbar must sit ABOVE the load-error overlay so
      // the user can see and click the URL field. Pre-fix the overlay was at
      // z-index:9998 vs navbar:100 — the navbar got `.visible` in the DOM but
      // was hidden behind the overlay, so the user reported "address bar
      // didn't open". The dark overlay also stretched to fit show()'s
      // panel-overhang window expansion, which the user perceived as
      // "window maximizes".
      const stacking = await pageWindow.evaluate(() => {
        const navbar = document.getElementById('navbar');
        const overlay = document.querySelector('.load-error-overlay');
        const z = (el: Element | null) => el ? parseInt(getComputedStyle(el).zIndex || '0', 10) : NaN;
        return { navbarZ: z(navbar), overlayZ: z(overlay) };
      });

      // The user-perceived "content area" must stay anchored to the
      // webview/center-column even when show() expands the window for
      // side-panel overhang. Specifically: the load-error overlay must NOT
      // stretch to fill the wider window — it must stay sized to the
      // center-column it lives inside. Pre-fix, the overlay was
      // `position: fixed` anchored to the viewport and grew with the window
      // (1236px), making the user perceive their "content area" as having
      // ballooned to the screen edges on a mere Cmd+L.
      const sizes = await pageWindow.evaluate(() => {
        const wv = document.getElementById('content') as HTMLElement;
        const ov = document.querySelector('.load-error-overlay') as HTMLElement;
        const cc = document.getElementById('center-column') as HTMLElement | null;
        const r = (el: HTMLElement | null) => el ? {
          rectWidth: Math.round(el.getBoundingClientRect().width),
          rectLeft: Math.round(el.getBoundingClientRect().left),
        } : null;
        return {
          webview: r(wv),
          overlay: r(ov),
          centerColumn: r(cc),
          documentWidth: document.documentElement.clientWidth,
        };
      });
      // Webview width unchanged.
      expect(sizes.webview!.rectWidth).toBe(800);
      // Overlay sized to its container (center-column), NOT to the window.
      expect(sizes.overlay!.rectWidth).toBe(sizes.centerColumn!.rectWidth);
      expect(sizes.overlay!.rectWidth).toBeLessThan(sizes.documentWidth);

      expect(afterMaximized).toBe(false);
      expect(navbarVisible).toBe(true);
      expect(stacking.navbarZ).toBeGreaterThan(stacking.overlayZ);
    } finally {
      await sharedBgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, windowId);
    }
  });
});
