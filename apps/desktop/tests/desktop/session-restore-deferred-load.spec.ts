/**
 * Session restore — deferred content load for hybrid page-hosts
 *
 * Restoring a large session must not loadURL every tab at once: windows
 * beyond SESSION_EAGER_RESTORE_COUNT restore with `restoreBlank`, which on
 * the hybrid path builds the BaseWindow + WebContentsView + registration +
 * frame state as normal but leaves the content webContents UN-NAVIGATED
 * until the window's first genuine activation (host BaseWindow 'focus').
 * This is the hybrid port of the deleted canvas path's blank-placeholder +
 * navigate-on-focus restore (a measured ~10-20x sustained-GPU win on large
 * sessions).
 *
 * The test saves a session with MORE windows than the eager count, restores,
 * proves the deferred windows have not loaded (live content-wc URL empty)
 * while still presenting their saved URL/title in window listings, then
 * drives the real host-BaseWindow 'focus' event on one deferred window and
 * proves exactly that one loads.
 *
 * Run with:
 *   yarn test:grep "Session Restore Deferred Load"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

// Must exceed SESSION_EAGER_RESTORE_COUNT (5 in session.ts) so the restore
// splits into 5 eager + 2 deferred windows.
const WINDOW_COUNT = 7;
const EAGER_COUNT = 5;

test.describe('Session Restore Deferred Load @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-deferred'));

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

  /**
   * The LIVE committed URL of a hybrid window's content webContents (via the
   * registry's content-wc id), or null if the window/wc is gone. A deferred
   * (never-navigated) wc reports '' — this is the load-state probe, distinct
   * from window.list's presentation URL (which deliberately falls back to
   * the saved URL for deferred windows).
   */
  async function liveContentUrl(windowId: number): Promise<string | null> {
    return app.evaluateMain!((({ webContents }: typeof import('electron'), id: number) => {
      const pt = (globalThis as Record<string, unknown>).__peek_test as {
        getHybridContentWcIdForTest(id: number): number | null;
      };
      const wcId = pt.getHybridContentWcIdForTest(id);
      if (wcId == null) return null;
      const wc = webContents.fromId(wcId);
      return wc && !wc.isDestroyed() ? wc.getURL() : null;
    }) as never, windowId) as Promise<string | null>;
  }

  function isLoadedUrl(u: string | null): boolean {
    return !!u && u !== 'about:blank';
  }

  /** window.list entries whose presentation URL carries our slug prefix. */
  async function listOurWindows(): Promise<Array<{ id: number; url: string; title: string }>> {
    return bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return [];
      return (r.windows || [])
        .filter((w: any) => typeof w.url === 'string' && w.url.includes('/deferred-load-'))
        .map((w: any) => ({ id: w.id, url: w.url, title: w.title }));
    });
  }

  test('restore beyond the eager count defers content loads until first activation', async () => {
    const slugs = Array.from({ length: WINDOW_COUNT }, (_, i) => `deferred-load-${i}`);

    // Open all windows and wait for each to be fully loaded (so the saved
    // snapshot carries real URLs + titles).
    const openedIds: number[] = [];
    for (const slug of slugs) {
      const url = `http://127.0.0.1:${serverPort}/${slug}`;
      const result = await bgWindow.evaluate(async (u: string) => {
        return await (window as any).app.window.open(u, { width: 700, height: 500 });
      }, url);
      expect(result.success).toBe(true);
      openedIds.push(result.id as number);
      await app.getWindow(slug, 15000);
    }

    // Hybrid-only: the deferred-load mechanism lives in the hybrid registry.
    const isHybrid = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as never, openedIds[0]) as boolean;
    test.skip(!isHybrid, 'hybrid flag off — deferred restore is hybrid-only');

    // Save, close everything, restore.
    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as never);

    await bgWindow.evaluate(async (ids: number[]) => {
      for (const id of ids) {
        await (window as any).app.window.close(id);
      }
    }, openedIds);
    await bgWindow.waitForFunction(async (ids: number[]) => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      const live = new Set((list.windows || []).map((w: any) => w.id));
      return ids.every((id) => !live.has(id));
    }, openedIds);

    const restoreResult = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as never) as
      { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThanOrEqual(WINDOW_COUNT);

    // Every restored window — including the deferred ones whose content has
    // never navigated — must present its SAVED url in window.list (the
    // presentation falls back to the deferred URL; no empty-url overwrite).
    const restored = await listOurWindows();
    expect(restored.length, 'all restored windows must be listed with their saved URLs').toBe(WINDOW_COUNT);

    // Wait for the eager fire-and-forget loads to settle: exactly EAGER_COUNT
    // committed content URLs; the remaining windows must stay un-navigated.
    await expect
      .poll(async () => {
        let loaded = 0;
        for (const w of restored) {
          if (isLoadedUrl(await liveContentUrl(w.id))) loaded++;
        }
        return loaded;
      }, { message: 'eager windows must finish loading; deferred must not start' })
      .toBe(EAGER_COUNT);

    // Identify the deferred pair and assert their graceful presentation.
    const deferred: Array<{ id: number; url: string; title: string }> = [];
    for (const w of restored) {
      if (!isLoadedUrl(await liveContentUrl(w.id))) deferred.push(w);
    }
    expect(deferred.length, 'exactly WINDOW_COUNT - EAGER_COUNT windows defer').toBe(WINDOW_COUNT - EAGER_COUNT);
    for (const w of deferred) {
      const slugMatch = w.url.match(/deferred-load-\d+/);
      expect(slugMatch, `deferred window ${w.id} must present its saved URL, got "${w.url}"`).not.toBeNull();
      expect(w.title, `deferred window ${w.id} must present its saved title`).toContain(slugMatch![0]);
    }

    // Activate ONE deferred window by driving the REAL host-BaseWindow
    // 'focus' event (the exact event Electron fires on OS focus — see
    // focusHybridWindowForTest). Its deferred load must start and commit.
    const [activated, untouched] = deferred;
    const activatedSlug = activated.url.match(/deferred-load-\d+/)![0];
    const focused = await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as never, activated.id) as boolean;
    expect(focused, 'focusHybridWindowForTest must find the live hybrid window').toBe(true);

    await expect
      .poll(async () => (await liveContentUrl(activated.id)) ?? '', {
        message: 'first activation must release the deferred load',
      })
      .toContain(activatedSlug);

    // The OTHER deferred window must still be un-navigated: activation
    // releases only the focused window's load, and only once.
    expect(
      isLoadedUrl(await liveContentUrl(untouched.id)),
      'a never-activated deferred window must stay un-navigated',
    ).toBe(false);

    // A second focus on the already-loaded window must be a no-op for the
    // deferred-load path (claim is once-only) — its URL stays committed.
    await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as never, activated.id);
    expect(await liveContentUrl(activated.id)).toContain(activatedSlug);

    // Cleanup.
    await bgWindow.evaluate(async (ids: number[]) => {
      for (const id of ids) {
        await (window as any).app.window.close(id);
      }
    }, restored.map((w) => w.id));
  });
});
