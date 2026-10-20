/**
 * Session save and restore keep a page-host's back/forward trail.
 *
 * `session-restore-page-host.spec.ts` covers the leaf URL and the bounds coming
 * back; this covers the trail behind the leaf. Three outcomes, each one a
 * different way the trail can be lost:
 *
 *   - An eagerly restored window that went A -> B -> C comes back on C with
 *     Back reaching B then A, rather than a lone entry with a dead Back.
 *   - A window beyond the eager count restores UN-NAVIGATED, so its content
 *     webContents reports no entries at all. Saving again must still record its
 *     trail — a live webContents read at save time would replace it with
 *     nothing — and its first activation must replay it rather than load the
 *     leaf URL.
 *   - A descriptor with no trail (every descriptor written before the field
 *     existed, and every window that never navigated) restores at its leaf URL
 *     exactly as it always did.
 *
 * Driven the way the chrome drives it — `page:navigate`, `page:go-back` and
 * `page:go-forward` on the overlay's system address — and the trail is read
 * from the content webContents' own `navigationHistory`, which is the only
 * place that can tell a restored trail apart from a window that merely landed
 * on the right URL.
 *
 * Run with:
 *   yarn test:grep "nav history"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { getHybridContentWcId, publishOverlayTopic } from '../helpers/hybrid-page';
import { sleep } from '../helpers/window-utils';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

/** Must exceed SESSION_EAGER_RESTORE_COUNT (5 in session.ts) so a restore defers some. */
const DEFERRED_WINDOW_COUNT = 7;
const EAGER_COUNT = 5;

interface Trail {
  url: string;
  index: number;
  entries: string[];
  canGoBack: boolean;
  canGoForward: boolean;
}

interface SnapshotWindow {
  url?: string;
  navHistory?: Array<{ url: string; title: string }>;
  navHistoryIndex?: number;
}

test.describe('Session Restore Nav History @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-nav-history'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        const path = req.url || '/';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${path}</title></head>` +
            `<body><h1 id="page">${path}</h1></body></html>`,
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

  // Helpers --------------------------------------------------------------

  const pageUrl = (path: string): string => `http://127.0.0.1:${serverPort}${path}`;

  /** Just the server path of an entry URL, so assertions read as page names. */
  const pathOf = (url: string): string => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };

  async function openWindow(url: string): Promise<number> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 700, height: 500 });
    }, url);
    expect(result.success).toBe(true);
    return result.id as number;
  }

  /**
   * Close every listed window and wait for the list to drain.
   *
   * The eager/deferred split applies to the WHOLE snapshot in recency order, so
   * a leftover window from an earlier test (or the window a fresh profile boots
   * with) would consume an eager slot and move the boundary. Same guard as
   * `session-restore-deferred-load.spec.ts`.
   */
  async function closeAllWindows(): Promise<void> {
    await bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return;
      for (const w of r.windows || []) {
        await (window as any).app.window.close(w.id);
      }
    });
    await bgWindow.waitForFunction(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return false;
      return (r.windows || []).length === 0;
    });
  }

  const saveSession = (): Promise<unknown> =>
    app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as never);

  const restoreSession = (): Promise<{ restored: number; failed: number; total: number }> =>
    app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as never) as Promise<{
      restored: number;
      failed: number;
      total: number;
    }>;

  const lastSnapshot = (): Promise<{ windows: SnapshotWindow[] } | null> =>
    app.evaluateMain!((() => (globalThis as any).__peek_test.getLastSnapshot()) as never) as Promise<{
      windows: SnapshotWindow[];
    } | null>;

  /** The saved descriptor whose URL carries `slug`. */
  async function savedWindow(slug: string): Promise<SnapshotWindow> {
    const snapshot = await lastSnapshot();
    expect(snapshot, 'a snapshot must exist after forceSaveSession').not.toBeNull();
    const found = (snapshot!.windows || []).filter((w) => (w.url || '').includes(slug));
    expect(
      found.length,
      `exactly one saved descriptor must carry ${slug}, got ${found.length} ` +
        `(saved: ${(snapshot!.windows || []).map((w) => w.url).join(', ')})`,
    ).toBe(1);
    return found[0];
  }

  /** window.list entries whose presentation URL carries `slug`. */
  async function listOurWindows(slug: string): Promise<Array<{ id: number; url: string }>> {
    return bgWindow.evaluate(async (s: string) => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return [];
      return (r.windows || [])
        .filter((w: any) => typeof w.url === 'string' && w.url.includes(s))
        .map((w: any) => ({ id: w.id, url: w.url }));
    }, slug);
  }

  /** The id of the open window whose presentation URL carries `urlSubstr`. */
  async function waitForWindowId(urlSubstr: string, timeoutMs = 10000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = await listOurWindows(urlSubstr);
      if (matches.length > 0) return matches[0].id;
      await sleep(100);
    }
    throw new Error(`no open window whose address contains ${urlSubstr} after ${timeoutMs}ms`);
  }

  /**
   * The LIVE committed URL of a hybrid window's content webContents, or null if
   * the window/wc is gone. A deferred (never-navigated) wc reports '' — this is
   * the load-state probe, distinct from window.list's presentation URL, which
   * deliberately falls back to the saved URL for a deferred window.
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

  const isLoadedUrl = (u: string | null): boolean => !!u && u !== 'about:blank';

  /**
   * The live back/forward trail of a page-host's content, read from the content
   * webContents itself. Null while the host has no content webContents yet.
   */
  async function trailOf(windowId: number): Promise<Trail | null> {
    const wcId = await getHybridContentWcId(app, windowId);
    if (wcId == null) return null;
    return (await app.evaluateMain!(({ webContents }, id: number) => {
      const wc = webContents.fromId(id);
      if (!wc || wc.isDestroyed()) return null;
      const h = wc.navigationHistory;
      return {
        url: wc.getURL(),
        index: h.getActiveIndex(),
        entries: h.getAllEntries().map((e) => e.url),
        canGoBack: h.canGoBack(),
        canGoForward: h.canGoForward(),
      };
    }, wcId)) as Trail | null;
  }

  async function waitForTrail(
    windowId: number,
    predicate: (t: Trail) => boolean,
    what: string,
    timeoutMs = 15000,
  ): Promise<Trail> {
    const deadline = Date.now() + timeoutMs;
    let last: Trail | null = null;
    while (Date.now() < deadline) {
      last = await trailOf(windowId);
      if (last && predicate(last)) return last;
      await sleep(75);
    }
    throw new Error(
      `window ${windowId} never reached ${what} (last: ${last ? JSON.stringify(last) : 'no content webContents'})`,
    );
  }

  const waitForPage = (windowId: number, path: string): Promise<Trail> =>
    waitForTrail(windowId, (t) => t.url.includes(path), `page ${path}`);

  const navigate = (windowId: number, url: string): Promise<void> =>
    publishOverlayTopic(app, 'page:navigate', { windowId, url });

  const goBack = (windowId: number): Promise<void> =>
    publishOverlayTopic(app, 'page:go-back', { windowId });

  /** Open a window and walk it forward through `paths` in order. */
  async function openAndWalk(paths: string[]): Promise<number> {
    const id = await openWindow(pageUrl(paths[0]));
    await waitForPage(id, paths[0]);
    for (const path of paths.slice(1)) {
      await navigate(id, pageUrl(path));
      await waitForPage(id, path);
    }
    return id;
  }

  /** The whole suite is about the hybrid page-host's trail. */
  async function skipUnlessHybrid(windowId: number): Promise<void> {
    const isHybrid = (await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.isHybridWindowForTest(id)) as never, windowId)) as boolean;
    test.skip(!isHybrid, 'not a hybrid page-host — the saved trail is hybrid-only');
  }

  // Tests ----------------------------------------------------------------

  test('nav history: an eagerly restored window comes back with its whole trail, and Back walks it', async () => {
    await closeAllWindows();
    const id = await openAndWalk(['/sr-nav-a', '/sr-nav-b', '/sr-nav-c']);
    await skipUnlessHybrid(id);

    const before = await trailOf(id);
    expect(before!.entries.map(pathOf)).toEqual(['/sr-nav-a', '/sr-nav-b', '/sr-nav-c']);
    expect(before!.index).toBe(2);

    await saveSession();

    // The trail must be ON the saved descriptor — a restore cannot replay what
    // the snapshot never recorded.
    const saved = await savedWindow('/sr-nav-c');
    expect(saved.navHistory?.map((e) => pathOf(e.url))).toEqual([
      '/sr-nav-a',
      '/sr-nav-b',
      '/sr-nav-c',
    ]);
    expect(saved.navHistoryIndex).toBe(2);

    await closeAllWindows();
    const result = await restoreSession();
    expect(result.restored).toBeGreaterThanOrEqual(1);

    // OUTCOME: the restored window is on C with both earlier pages behind it,
    // not a lone entry with a dead Back button.
    const restoredId = await waitForWindowId('/sr-nav-c');
    const after = await waitForTrail(
      restoredId,
      (t) => t.entries.length === 3 && t.url.includes('/sr-nav-c'),
      'the restored three-entry trail on C',
    );
    expect(after.entries.map(pathOf)).toEqual(['/sr-nav-a', '/sr-nav-b', '/sr-nav-c']);
    expect(after.index).toBe(2);
    expect(after.canGoBack, 'Back must be live in the restored window').toBe(true);
    expect(after.canGoForward).toBe(false);

    await goBack(restoredId);
    await waitForPage(restoredId, '/sr-nav-b');
    await goBack(restoredId);
    const atFront = await waitForPage(restoredId, '/sr-nav-a');
    expect(atFront.canGoBack, 'the first page of the trail has nothing behind it').toBe(false);

    await closeAllWindows();
  });

  test('nav history: a deferred window saved again keeps its trail, and its first activation replays it', async () => {
    await closeAllWindows();

    // Every window walks one step, so whichever two end up deferred have a
    // trail to lose.
    const slugs = Array.from({ length: DEFERRED_WINDOW_COUNT }, (_, i) => `sr-defer-${i}`);
    for (const slug of slugs) {
      const id = await openAndWalk([`/${slug}-a`, `/${slug}-b`]);
      if (slug === slugs[0]) await skipUnlessHybrid(id);
    }

    await saveSession();
    const snapshot = await lastSnapshot();
    expect(
      (snapshot!.windows || []).length,
      `the snapshot must hold exactly the ${DEFERRED_WINDOW_COUNT} test windows, got: ` +
        `${(snapshot!.windows || []).map((w) => w.url).join(', ')}`,
    ).toBe(DEFERRED_WINDOW_COUNT);

    await closeAllWindows();
    const result = await restoreSession();
    expect(result.restored).toBeGreaterThanOrEqual(DEFERRED_WINDOW_COUNT);

    await expect
      .poll(async () => (await listOurWindows('/sr-defer-')).length, {
        message: 'every restored window must be listed with its saved URL',
      })
      .toBe(DEFERRED_WINDOW_COUNT);
    const restored = await listOurWindows('/sr-defer-');

    // Wait for the eager loads to settle, then take the windows whose content
    // never navigated — which ones they are is the restore's business, not this
    // test's.
    await expect
      .poll(async () => {
        let loaded = 0;
        for (const w of restored) {
          if (isLoadedUrl(await liveContentUrl(w.id))) loaded++;
        }
        return loaded;
      }, { message: 'eager windows must finish loading; deferred must not start' })
      .toBe(EAGER_COUNT);

    const deferred: Array<{ id: number; url: string }> = [];
    for (const w of restored) {
      if (!isLoadedUrl(await liveContentUrl(w.id))) deferred.push(w);
    }
    expect(deferred.length, 'the windows past the eager count defer their load').toBe(
      DEFERRED_WINDOW_COUNT - EAGER_COUNT,
    );

    const target = deferred[0];
    const slug = target.url.match(/sr-defer-\d+/)![0];

    // THE REGRESSION: save again while the window is still un-navigated. Its
    // content webContents reports no entries at all, so a live read here would
    // record no trail and the window would lose its history for good.
    await saveSession();
    const resaved = await savedWindow(`${slug}-b`);
    expect(
      resaved.navHistory?.map((e) => pathOf(e.url)),
      'a second save must keep the trail an un-activated deferred window has never loaded',
    ).toEqual([`/${slug}-a`, `/${slug}-b`]);
    expect(resaved.navHistoryIndex).toBe(1);

    // OUTCOME: first activation replays the trail instead of loading the leaf.
    const focused = (await app.evaluateMain!(((_e: unknown, id: number) =>
      (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as never, target.id)) as boolean;
    expect(focused, 'focusHybridWindowForTest must find the live hybrid window').toBe(true);

    const after = await waitForTrail(
      target.id,
      (t) => t.entries.length === 2 && t.url.includes(`${slug}-b`),
      `the replayed two-entry trail on ${slug}-b`,
    );
    expect(after.entries.map(pathOf)).toEqual([`/${slug}-a`, `/${slug}-b`]);
    expect(after.index).toBe(1);
    expect(after.canGoBack, 'Back must be live after a deferred activation').toBe(true);

    await goBack(target.id);
    await waitForPage(target.id, `${slug}-a`);

    await closeAllWindows();
  });

  test('nav history: a descriptor with no trail restores at its leaf URL', async () => {
    await closeAllWindows();
    const id = await openWindow(pageUrl('/sr-no-trail'));
    await waitForPage(id, '/sr-no-trail');
    await skipUnlessHybrid(id);

    await saveSession();

    // A window on its first page has nothing worth keeping, so the descriptor
    // carries neither key — the same shape every descriptor written before
    // these fields existed has.
    const saved = await savedWindow('/sr-no-trail');
    expect(Object.prototype.hasOwnProperty.call(saved, 'navHistory')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(saved, 'navHistoryIndex')).toBe(false);

    await closeAllWindows();
    const result = await restoreSession();
    expect(result.restored).toBeGreaterThanOrEqual(1);

    const restoredId = await waitForWindowId('/sr-no-trail');
    const after = await waitForTrail(
      restoredId,
      (t) => t.url.includes('/sr-no-trail'),
      'the restored leaf page',
    );
    expect(after.entries.map(pathOf)).toEqual(['/sr-no-trail']);
    expect(after.index).toBe(0);
    expect(after.canGoBack).toBe(false);
    expect(after.canGoForward).toBe(false);

    await closeAllWindows();
  });
});
