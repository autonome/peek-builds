/**
 * Hybrid page-host close — no orphaned content renderer / registry leak (A1d)
 *
 * Regression guard for the P0 leak diagnosed during the page-host cutover:
 * in Electron 40 a hybrid page-host (an opaque `BaseWindow` hosting one
 * `WebContentsView`) closed via `baseWin.close()` tears the host down
 * SYNCHRONOUSLY but NEVER emits `'closed'`, and leaves its main-owned content
 * `WebContents` (a live renderer process) ORPHANED — `isDestroyed()` stays
 * false and `'destroyed'` never fires. The A1c fix wired only the lifecycle
 * SIGNALS (reopen-stack / window:removed / snapshot) off the `'close'` event;
 * it did NOT free the orphaned renderer or the registry entry (whose self-clean
 * is on those never-firing events). So every hybrid page close leaked a
 * renderer AND a registry entry.
 *
 * The A1d fix destroys the content webContents and unregisters the entry from
 * the once-guarded `runHybridFinalize` (`'close'` handler) in ipc.ts. This test
 * pins the OUTCOME: after a hybrid page closes, the content wc is destroyed and
 * the registry no longer holds the window.
 *
 * Hybrid-only — skips cleanly if the window is not a live hybrid page-host,
 * the same way the hybrid-overlay / focus-order specs do.
 *
 * Run with:
 *   yarn test:grep "Hybrid Close Leak"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Hybrid Close Leak @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-close-leak'));

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
    if (app) await app.close();
  });

  /** Close `windowId` and resolve once its `window:removed` fires. */
  async function closeAndAwaitRemoved(windowId: number): Promise<void> {
    await bgWindow.evaluate((id: number) => {
      (window as any).__leakRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === id) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
      (window as any).app.window.close(id);
    }, windowId);
    await bgWindow.evaluate(() => (window as any).__leakRemoved);
  }

  test('closing a hybrid page-host destroys the content renderer and clears the registry entry', async () => {
    const slug = 'leak-roundtrip';
    const url = `http://127.0.0.1:${serverPort}/${slug}`;

    // Open the page. Under the hybrid flag this is a BaseWindow page-host.
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const windowId = result.id as number;

    const pageWindow = await app.getWindow(slug, 15000);
    await pageWindow.waitForLoadState('domcontentloaded');

    // Hybrid-only outcome — skip on the canvas path.
    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    test.skip(!isHybrid, 'hybrid flag off — leak is hybrid-path only');

    // Capture the content wc id while the window is still open and registered.
    const contentWcId = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.getHybridContentWcIdForTest(id)) as any, windowId) as number | null;
    expect(contentWcId, 'a live hybrid must expose its content wc id').not.toBeNull();

    // Pre-close sanity: the registry holds the window and the content wc is alive.
    const aliveBefore = await app.evaluateMain!(((_e: unknown, wc: number) =>
      (globalThis as any).__peek_test.isWebContentsAliveForTest(wc)) as any, contentWcId) as boolean;
    expect(aliveBefore, 'content wc must be alive before close').toBe(true);

    // Close it and wait for the close to finalize (window:removed).
    await closeAndAwaitRemoved(windowId);

    // ── The fix's OUTCOME ──────────────────────────────────────────────
    // 1) The registry entry is gone (no leaked HybridWindowEntry).
    const stillRegistered = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
    expect(
      stillRegistered,
      'hybrid registry must drop the entry on close (self-clean is on `closed`/`destroyed`, which never fire on baseWin.close())',
    ).toBe(false);

    // 2) The orphaned content renderer is actually destroyed (no leaked process).
    const aliveAfter = await app.evaluateMain!(((_e: unknown, wc: number) =>
      (globalThis as any).__peek_test.isWebContentsAliveForTest(wc)) as any, contentWcId) as boolean;
    expect(
      aliveAfter,
      'content webContents (a renderer process) must be destroyed on hybrid close — otherwise every page close leaks a renderer',
    ).toBe(false);
  });

  test('closing N hybrid pages leaves zero of their content renderers alive (no accumulation)', async () => {
    const N = 4;
    const opened: Array<{ windowId: number; contentWcId: number }> = [];

    for (let i = 0; i < N; i++) {
      const slug = `leak-multi-${i}`;
      const url = `http://127.0.0.1:${serverPort}/${slug}`;
      const result = await bgWindow.evaluate(async (u: string) => {
        return await (window as any).app.window.open(u, { width: 700, height: 500 });
      }, url);
      expect(result.success).toBe(true);
      const windowId = result.id as number;
      const pageWindow = await app.getWindow(slug, 15000);
      await pageWindow.waitForLoadState('domcontentloaded');

      if (i === 0) {
        const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
          (globalThis as any).__peek_test.isHybridWindowForTest(id)) as any, windowId) as boolean;
        test.skip(!isHybrid, 'hybrid flag off — leak is hybrid-path only');
      }

      const contentWcId = await app.evaluateMain!(((_e: unknown, id: number) =>
        (globalThis as any).__peek_test.getHybridContentWcIdForTest(id)) as any, windowId) as number | null;
      expect(contentWcId).not.toBeNull();
      opened.push({ windowId, contentWcId: contentWcId as number });
    }

    // Close all of them, each awaited to finalization.
    for (const { windowId } of opened) {
      await closeAndAwaitRemoved(windowId);
    }

    // Every captured content renderer must now be gone.
    for (const { contentWcId } of opened) {
      const alive = await app.evaluateMain!(((_e: unknown, wc: number) =>
        (globalThis as any).__peek_test.isWebContentsAliveForTest(wc)) as any, contentWcId) as boolean;
      expect(
        alive,
        `content wc ${contentWcId} must be destroyed after its window closed — N closes must not accumulate N orphaned renderers`,
      ).toBe(false);
    }
  });
});
