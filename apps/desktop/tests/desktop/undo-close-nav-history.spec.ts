/**
 * Undo-close restores a page-host's back/forward trail.
 *
 * `reopen-closed-window.spec.ts` covers the leaf URL coming back; this covers
 * the trail behind it. The outcome under test is the user-visible one: after
 * Cmd+Shift+T, Back is alive and walks the same pages the window had, and a
 * window that was sitting part-way back reopens on that page with Forward
 * still reaching the pages in front of it.
 *
 * Driven the way the chrome drives it — `page:navigate`, `page:go-back` and
 * `page:go-forward` published on the overlay's system address — so the test
 * exercises the real navigation routes rather than poking the webContents.
 * The trail itself is read from the content webContents' own
 * `navigationHistory`, which is the only place that can say whether the
 * entries really came back or the window merely landed on the right URL.
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

interface Trail {
  url: string;
  index: number;
  entries: string[];
  canGoBack: boolean;
  canGoForward: boolean;
}

test.describe('Undo-close nav history @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('undo-close-nav-history'));

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
    return result.id;
  }

  /**
   * Close a window and wait for the teardown to settle, so the next
   * `evaluateMain` is not racing a CDP context being torn down. Same two
   * terminal states and same "execution context was destroyed means
   * in-progress" reading as `reopen-closed-window.spec.ts`.
   */
  async function closeWindowById(windowId: number): Promise<void> {
    await bgWindow.evaluate(async (id: number) => {
      return await (window as any).app.window.close(id);
    }, windowId);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      let state: string;
      try {
        state = await app.evaluateMain!(({ BrowserWindow }, id: number) => {
          const w = BrowserWindow.fromId(id);
          if (!w || w.isDestroyed()) return 'destroyed';
          if (!w.isVisible()) return 'hidden';
          return 'open';
        }, windowId) as string;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Execution context was destroyed')) {
          await sleep(25);
          continue;
        }
        throw err;
      }
      if (state === 'destroyed' || state === 'hidden') return;
      await sleep(25);
    }
    throw new Error(`closeWindowById timeout — window ${windowId} never settled (still open after 3s)`);
  }

  async function getStackCount(): Promise<number> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    try {
      return (await app.evaluateMain(() => (globalThis as any).__peek_test.getClosedWindowCount())) as number;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Execution context was destroyed')) throw err;
      await sleep(50);
      return (await app.evaluateMain(() => (globalThis as any).__peek_test.getClosedWindowCount())) as number;
    }
  }

  async function waitForStackCount(expected: number, timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = await getStackCount();
    while (last !== expected && Date.now() < deadline) {
      await sleep(50);
      last = await getStackCount();
    }
    return last;
  }

  async function reopenLastClosed(): Promise<{ success: boolean; url?: string; error?: string }> {
    return (await app.evaluateMain!(() => {
      return (globalThis as any).__peek_test.reopenLastClosedWindow();
    })) as any;
  }

  /** The id of the open window whose address contains `urlSubstr`. */
  async function waitForWindowId(urlSubstr: string, timeoutMs = 8000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = await bgWindow.evaluate(async (u: string) => {
        const r = await (window as any).app.window.list({ includeInternal: false });
        if (!r?.success) return null;
        const w = (r.windows || []).find((win: any) => win.url?.includes(u));
        return w?.id ?? null;
      }, urlSubstr);
      if (typeof id === 'number') return id;
      await sleep(100);
    }
    throw new Error(`no open window whose address contains ${urlSubstr} after ${timeoutMs}ms`);
  }

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
    timeoutMs = 10000,
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

  const goForward = (windowId: number): Promise<void> =>
    publishOverlayTopic(app, 'page:go-forward', { windowId });

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

  // Tests ----------------------------------------------------------------

  test('nav history: undo-close brings the whole trail back, and Back walks it', async () => {
    const id = await openAndWalk(['/nav-hist-a', '/nav-hist-b', '/nav-hist-c']);

    const before = await trailOf(id);
    expect(before!.entries.map(pathOf)).toEqual(['/nav-hist-a', '/nav-hist-b', '/nav-hist-c']);
    expect(before!.index).toBe(2);

    const stackBefore = await getStackCount();
    await closeWindowById(id);
    expect(await waitForStackCount(stackBefore + 1)).toBe(stackBefore + 1);

    const result = await reopenLastClosed();
    expect(result.success).toBe(true);
    expect(result.url).toContain('/nav-hist-c');

    // OUTCOME: the reopened window is on C with both earlier pages behind it,
    // not a lone entry with a dead Back button.
    const reopenedId = await waitForWindowId('/nav-hist-c');
    const after = await waitForTrail(
      reopenedId,
      (t) => t.entries.length === 3 && t.url.includes('/nav-hist-c'),
      'the restored three-entry trail on C',
    );
    expect(after.entries.map(pathOf)).toEqual(['/nav-hist-a', '/nav-hist-b', '/nav-hist-c']);
    expect(after.index).toBe(2);
    expect(after.canGoBack, 'Back must be live in the reopened window').toBe(true);
    expect(after.canGoForward).toBe(false);

    await goBack(reopenedId);
    await waitForPage(reopenedId, '/nav-hist-b');
    await goBack(reopenedId);
    const atFront = await waitForPage(reopenedId, '/nav-hist-a');
    expect(atFront.canGoBack, 'the first page of the trail has nothing behind it').toBe(false);

    await goForward(reopenedId);
    await waitForPage(reopenedId, '/nav-hist-b');

    await closeWindowById(reopenedId);
  });

  test('nav history: a window closed part-way back reopens on that page, Forward intact', async () => {
    const id = await openAndWalk(['/nav-back-a', '/nav-back-b', '/nav-back-c']);

    // Walk back to B, then close from there. The reopened window must come back
    // on B — not on C, which is where the window was last opened.
    await goBack(id);
    const beforeClose = await waitForPage(id, '/nav-back-b');
    expect(beforeClose.index).toBe(1);
    expect(beforeClose.canGoForward).toBe(true);

    const stackBefore = await getStackCount();
    await closeWindowById(id);
    expect(await waitForStackCount(stackBefore + 1)).toBe(stackBefore + 1);

    const result = await reopenLastClosed();
    expect(result.success).toBe(true);
    expect(result.url).toContain('/nav-back-b');

    const reopenedId = await waitForWindowId('/nav-back-b');
    const after = await waitForTrail(
      reopenedId,
      (t) => t.entries.length === 3 && t.url.includes('/nav-back-b'),
      'the restored three-entry trail on B',
    );
    expect(after.entries.map(pathOf)).toEqual(['/nav-back-a', '/nav-back-b', '/nav-back-c']);
    expect(after.index, 'reopened at the position the window was closed at').toBe(1);
    expect(after.canGoBack).toBe(true);
    expect(after.canGoForward, 'C must still be reachable by Forward').toBe(true);

    await goForward(reopenedId);
    await waitForPage(reopenedId, '/nav-back-c');
    await goBack(reopenedId);
    await waitForPage(reopenedId, '/nav-back-b');

    await closeWindowById(reopenedId);
  });
});
