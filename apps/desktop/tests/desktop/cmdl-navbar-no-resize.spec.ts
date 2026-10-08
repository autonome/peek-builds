/**
 * Cmd+L on a page-host reveals the navbar without touching the window.
 *
 * The invariant: pressing Cmd+L while a page-host is active opens the address
 * bar (navbar) and leaves the host window exactly as the user left it — not
 * maximized, same bounds. The regression this guards against was the opposite
 * pair: the address bar stayed shut AND the window maximized.
 *
 * The window is a REAL hybrid content window opened through the production
 * `app.window.open` path on a local http page, activated focus-free via the
 * `setActive` idiom every hybrid spec uses. Cmd+L goes straight to the content
 * WebContents, which is the real before-input-event chain
 * (`wireHybridContentEvents` in ipc.ts → publish page:show-navbar →
 * overlay.js subscriber → show()); Playwright's `keyboard.press` dispatches DOM
 * events that never reach Electron's input pipeline, so it cannot drive this
 * path.
 *
 * Run with:
 *   yarn test:grep "Cmd\+L on a page-host"
 */

import { test, expect, DesktopApp, getSharedApp, closeSharedApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { setActive, overlayChromeState, waitOverlayReady, getHybridContentWcId } from '../helpers/hybrid-page';
import http from 'http';

let sharedApp: DesktopApp;
let sharedBgWindow: Page;
let server: http.Server;
let serverPort: number;

test.beforeAll(async () => {
  sharedApp = await getSharedApp();
  sharedBgWindow = await sharedApp.getBackgroundWindow();
  await waitForExtensionsReady(sharedBgWindow);

  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
          `<body><h1>${req.url}</h1></body></html>`,
      );
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
  await closeSharedApp();
});

/**
 * Open a REAL (non-fake) hybrid content window on `url` via the production
 * window-open path and wait for its content to load — the same open + readiness
 * pattern session-restore-hybrid-focus.spec.ts uses.
 */
async function openPageHost(url: string): Promise<{ pageWindow: Page; windowId: number }> {
  const result = await sharedBgWindow.evaluate(async (targetUrl: string) => {
    return await (window as any).app.window.open(targetUrl, { width: 800, height: 600 });
  }, url);
  expect(result.success).toBe(true);
  const slug = new URL(url).pathname.slice(1);
  const pageWindow = await sharedApp.getWindow(slug, 15000);
  await pageWindow.waitForLoadState('domcontentloaded');
  return { pageWindow, windowId: result.id as number };
}

/** Read `windowId`'s live entry (bounds, maximized, …) from the production window list. */
async function findEntry(bgWindow: Page, id: number): Promise<any> {
  return bgWindow.evaluate(async (targetId: number) => {
    const r = await (window as any).app.window.list({ includeInternal: false });
    if (!r?.success) return null;
    return (r.windows || []).find((w: any) => w.id === targetId) ?? null;
  }, id);
}

test.describe('Cmd+L on a page-host @desktop', () => {
  test('Cmd+L shows the navbar without maximizing or resizing the window', async () => {
    const url = `http://127.0.0.1:${serverPort}/cmdl-navbar`;
    const { windowId } = await openPageHost(url);

    try {
      // Make this the active hybrid window so the shared overlay frames it
      // (focus-free synthetic activation — every hybrid spec drives windows
      // this way instead of real OS focus).
      const activated = await setActive(sharedApp, { id: windowId, contentWcId: null });
      expect(activated).toBe(true);
      await waitOverlayReady(sharedApp);

      // Precondition: the chrome is hidden. The window appearing shows the bar
      // for the load-reveal dwell (navbar-load-reveal.js), so wait it out.
      await expect
        .poll(async () => (await overlayChromeState(sharedApp))?.navbarVisible)
        .toBe(false);

      const before = await findEntry(sharedBgWindow, windowId);
      expect(before?.maximized).toBe(false);
      const boundsBefore = before.bounds;

      // Synthesize Cmd+L (Ctrl+L on non-darwin) into the CONTENT WebContents —
      // the real before-input-event path (see the header note).
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
      expect(after?.maximized, 'Cmd+L must not maximize the window').toBe(false);
      expect(after?.bounds, 'Cmd+L must not change window bounds').toEqual(boundsBefore);
    } finally {
      await sharedBgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, windowId);
    }
  });
});
