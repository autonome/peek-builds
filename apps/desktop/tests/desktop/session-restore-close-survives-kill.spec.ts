/**
 * Session restore — close-survives-kill drift detection
 *
 * Standing regression test for bug class first fixed in 94668630
 * (debounced 500ms session-save in main.ts on window 'closed') and
 * refined in b09f240c. The bug: explicit user-close of a window can be
 * silently undone by a force-kill or crash that happens after the close
 * fires but before the next autosave tick / before-quit save. Without
 * the debounced close-save, the on-disk snapshot would still contain
 * the closed window, and on next launch the user would see it
 * reappear — violating their explicit close-intent.
 *
 * The fix coalesces bulk closes into a single trailing-edge save ~500ms
 * after the last close. This test verifies the snapshot reflects the
 * close by flushing the pending debounced save synchronously (via the
 * __peek_test.flushPendingCloseSave hook, which clears the in-flight
 * timer and runs the save body directly) so the test never has to wait
 * a wall-clock 500ms (per feedback_no_sleep_in_tests_or_code).
 *
 * Run with:
 *   yarn test:grep "Session Restore Close Survives Kill"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Session Restore Close Survives Kill @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-close-survives-kill'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
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

  async function resetState() {
    await bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return;
      for (const w of list.windows || []) {
        if (typeof w.url === 'string' && (w.url.startsWith('peek://app/page/') || w.url.includes('close-survives'))) {
          await (window as any).app.window.close(w.id);
        }
      }
    });
    await bgWindow.waitForFunction(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      return !(list.windows || []).some((w: any) =>
        typeof w.url === 'string' && (w.url.startsWith('peek://app/page/') || w.url.includes('close-survives')));
    });
  }

  async function openPage(url: string): Promise<number> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const slug = new URL(url).pathname.slice(1);
    await app.getWindow(slug, 15000);
    return result.id as number;
  }

  /** Close a window and wait deterministically for the registry pop. */
  async function closeAndAwait(windowId: number) {
    await bgWindow.evaluate((id: number) => {
      (window as any).__closeAwait = new Promise<void>((resolve) => {
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
    await bgWindow.evaluate(() => (window as any).__closeAwait);
  }

  const forceSave = () =>
    app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

  const flushCloseSave = () =>
    app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.flushPendingCloseSave();
    }) as any);

  const forceRestore = () =>
    app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as Promise<{ restored: number; failed: number; total: number }>;

  test.beforeEach(async () => {
    await resetState();
  });

  // Tests ----------------------------------------------------------------

  test('closed window does NOT reappear after force-kill simulated by close→flush→restore', async () => {
    const urlA = `http://127.0.0.1:${serverPort}/close-survives-a`;
    const urlB = `http://127.0.0.1:${serverPort}/close-survives-b`;
    const urlC = `http://127.0.0.1:${serverPort}/close-survives-c`;

    await openPage(urlA);
    const idB = await openPage(urlB);
    await openPage(urlC);

    // Baseline snapshot with A, B, C all present.
    await forceSave();

    // Close B — this enqueues the debounced close-save timer.
    await closeAndAwait(idB);

    // Flush the pending debounced save synchronously instead of waiting
    // 500ms wall-clock. The save body writes the current visible-window
    // set (which no longer contains B) to the on-disk snapshot.
    await flushCloseSave();

    // Close A and C too so restore has work to do. (No need to flush
    // again — restore reads the snapshot already written by flush.)
    await resetState();

    // Restore from the post-flush snapshot.
    const restored = await forceRestore();

    // Verify A and C came back, B did NOT.
    const listRestoredUrls = () => bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return [] as string[];
      return (list.windows || [])
        .map((w: any) => w.url as string)
        .filter((u: string) => typeof u === 'string' && u.includes('close-survives'));
    });

    // Restore opens windows one after another, so the last one can still be
    // loading when forceRestore returns; wait for both to be listed.
    await expect.poll(async () => {
      const urls = await listRestoredUrls();
      return ['close-survives-a', 'close-survives-c'].every((s) => urls.some((u) => u.includes(s)));
    }, { timeout: 10000 }).toBe(true);
    const restoredUrls = await listRestoredUrls();

    expect(restoredUrls.some((u: string) => u.includes('close-survives-a')),
      `closed-survives test: window A must restore`).toBe(true);
    expect(restoredUrls.some((u: string) => u.includes('close-survives-c')),
      `closed-survives test: window C must restore`).toBe(true);
    expect(restoredUrls.some((u: string) => u.includes('close-survives-b')),
      `closed-survives REGRESSION: window B was explicitly closed; flushed snapshot must NOT contain it`)
      .toBe(false);

    // Sanity: restored count consistent with the visible-window list.
    expect(restored.restored).toBeGreaterThanOrEqual(2);
  });
});
