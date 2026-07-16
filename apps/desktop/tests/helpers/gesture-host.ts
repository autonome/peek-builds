/**
 * Shared scaffolding for the hybrid content-window gesture specs — the REAL
 * http page-host fixture and the per-window helper closures both
 * tests/desktop/hybrid-content-window-gesture.spec.ts and
 * tests/desktop-disruptive/hybrid-content-window-gesture-fullscreen.spec.ts
 * drive their gestures through. Split out so the fullscreen spec (which
 * drives native macOS fullscreen and must stay out of the normal runs) can
 * reuse the fixture and the coordinate-fidelity plumbing without duplicating
 * it.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from './test-app';
import { getHybridContentWcId, waitOverlayReady, type Rect } from './hybrid-page';
import http from 'http';

export type FsState = {
  isFullScreen: boolean;
  nativeFullScreen: boolean;
  maximized: boolean;
  preMaxBounds: Rect | null;
};

export type GestureHost = {
  app: DesktopApp;
  bgWindow: Page;
  openGestureWindow: () => Promise<{ id: number; wcId: number }>;
  runInContent: (wcId: number, src: string) => Promise<any>;
  hostBoundsOf: (id: number) => Promise<Rect | null>;
  workAreaOf: (id: number) => Promise<Rect | null>;
  fullscreenStateOf: (id: number) => Promise<FsState | null>;
  teardown: () => Promise<void>;
};

// Launch a per-describe app plus a local http server for the gesture fixture
// page, then wire up the window-open / dispatch / bounds-reading closures
// each test drives. Mirrors createPerDescribeApp's per-describe lifecycle:
// call from beforeAll, call the returned teardown() from afterAll.
export async function setupGestureHost(profileName: string): Promise<GestureHost> {
  const { app, bgWindow } = await createPerDescribeApp(profileName);

  // Local http server so the content WC gets the REAL universal preload (the
  // gesture listener only loads on http(s) — data: URLs get no preload). The
  // tall empty #dead div gives a genuine dead-space region well ABOVE the
  // paragraph, so a click in it falls OUTSIDE a selection made over #para.
  let server!: http.Server;
  let port = 0;
  await new Promise<void>((resolve) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!DOCTYPE html><html><head><title>Gesture</title></head>` +
          `<body style="margin:0;height:100vh">` +
          `<div id="dead" style="width:100%;height:240px"></div>` +
          `<p id="para" style="margin:0">hello selectable words here</p>` +
          `<input id="inp" value="x">` +
          `<button id="btn">Press</button>` +
          `</body></html>`,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });

  // Open a REAL hybrid page-host on the local server, make it the active window
  // (so the singleton chrome overlay — the single source of truth for maximize —
  // frames it), and resolve its content WC id for MAIN-world dispatch. Each call
  // uses a UNIQUE path so the hybrid find-by-url dedup never collapses a later
  // open onto an earlier (already-maximized) window.
  let seq = 0;
  async function openGestureWindow(): Promise<{ id: number; wcId: number }> {
    const token = `g-${++seq}`;
    const openResult = await bgWindow.evaluate(async (targetUrl: string) => {
      return await (window as any).app.window.open(targetUrl, { width: 720, height: 520 });
    }, `http://127.0.0.1:${port}/${token}`);
    expect(openResult.success).toBe(true);
    const id = openResult.id as number;

    const pageWindow = await app.getWindow(token, 15000);
    expect(pageWindow).toBeTruthy();
    await pageWindow.waitForLoadState('domcontentloaded');

    const wcId = await getHybridContentWcId(app, id);
    expect(wcId, 'a live hybrid must expose its content wc id').not.toBeNull();

    // Frame the overlay over this window (focus-free) and wait for its renderer,
    // which owns the maximize toggle the gesture routes through.
    await app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.setActive(wid);
    }, id);
    await waitOverlayReady(app);

    return { id, wcId: wcId as number };
  }

  const runInContent = (wcId: number, src: string) =>
    app.evaluateMain!(
      (async ({ webContents }: any, arg: { wcId: number; src: string }) => {
        const wc = webContents.fromId(arg.wcId);
        if (!wc || wc.isDestroyed()) return null;
        return wc.executeJavaScript(arg.src);
      }) as any,
      { wcId, src },
    );

  const hostBoundsOf = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostBounds(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const workAreaOf = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostWorkArea(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const fullscreenStateOf = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.hostFullscreenState(wid);
    }, id) as Promise<FsState | null>;

  const teardown = async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (app) await app.close();
  };

  return { app, bgWindow, openGestureWindow, runInContent, hostBoundsOf, workAreaOf, fullscreenStateOf, teardown };
}
