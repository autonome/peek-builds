/**
 * A page host restored at launch initializes fully, whatever its page does.
 *
 * Two ways a restored host used to stay without chrome:
 *  - the session snapshot saved the window's current URL, which on a failed load
 *    is the internal error page, so restore reopened the error page instead of
 *    the address that failed;
 *  - a restored page that hangs (or fails) never reports its first frame, and
 *    the restore open path had no main-process outcome to make the host
 *    orderable, so the chrome overlay never attached.
 *
 * Run with:
 *   yarn test:grep "Page host restore hung"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady } from '../helpers/hybrid-page';
import http from 'http';
import net from 'net';

// Long enough that the restored page is still loading while the chrome is checked.
process.env.PEEK_PAGE_LOAD_TIMEOUT_MS = '8000';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;
const sockets = new Set<net.Socket>();

test.describe('Page host restore hung @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-restore-hung'));
    await new Promise<void>((resolve) => {
      server = http.createServer(() => {
        /* accepts the request and never answers it */
      });
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    for (const s of sockets) s.destroy();
    if (server) server.close();
    if (app) await app.close();
  });

  const bridge = async () => app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));
  const hybridIds = () =>
    app.evaluateMain!(() => (globalThis as any).__peekHybridOverlayTest.hybridIds() as number[]);
  const contentUrl = (id: number) =>
    app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.contentUrl(i)) as any, id) as Promise<string>;

  const openUrl = async (url: string): Promise<number> => {
    const before = await hybridIds();
    await bgWindow.evaluate((u: string) => {
      (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    const id = (await app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) =>
      (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(arg.url, arg.before, 8000)) as any, {
      url,
      before,
    })) as number | null;
    expect(id, `a page host should be registered for ${url}`).not.toBeNull();
    return id as number;
  };

  const closeId = (id: number) => bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id);

  const savedUrls = async (): Promise<string[]> => {
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);
    const snap = (await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as any)) as { windows: Array<{ url: string }> } | null;
    return (snap?.windows ?? []).map((w) => w.url);
  };

  const restoreAndExpectChrome = async (url: string, opts: { whileLoading?: boolean } = {}) => {
    const before = await hybridIds();
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceRestoreSession()) as any);
    const id = (await app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) =>
      (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(arg.url, arg.before, 8000)) as any, {
      url,
      before,
    })) as number | null;
    expect(id, 'the restored page host should exist and reload the saved address').not.toBeNull();
    await app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.setActive(i)) as any, id);
    await expect
      .poll(
        async () =>
          app.evaluateMain!(() => (globalThis as any).__peekHybridOverlayTest.activeId() as number | null),
        {
          timeout: opts.whileLoading ? 4000 : 8000,
          message: 'the chrome overlay should attach to the restored host',
        },
      )
      .toBe(id);
    if (opts.whileLoading) {
      expect(await contentUrl(id as number), 'still the hung page, not the error page').not.toContain('page-error');
    }
    await waitOverlayReady(app);
    return id as number;
  };

  test('a restored host whose page hangs becomes orderable and gets the chrome', async () => {
    test.skip(!(await bridge()), 'no overlay bridge in this configuration');
    const url = `http://127.0.0.1:${serverPort}/hang/restored`;
    const id = await openUrl(url);
    // After the load timeout the window shows the error page; it is saved under the hung address.
    await expect.poll(() => contentUrl(id), { timeout: 15000 }).toContain('peek://app/page-error');
    const urls = await savedUrls();
    expect(urls.some((u) => u.includes('/hang/restored')), `saved: ${JSON.stringify(urls)}`).toBe(true);
    await closeId(id);
    const restoredId = await restoreAndExpectChrome(url, { whileLoading: true });
    await closeId(restoredId);
  });

  test('a window showing the load-error page is saved under the failed address', async () => {
    test.skip(!(await bridge()), 'no overlay bridge in this configuration');
    const closedPort = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${closedPort}/refused-restored`;
    const id = await openUrl(url);
    await expect.poll(() => contentUrl(id), { timeout: 8000 }).toContain('peek://app/page-error');

    const urls = await savedUrls();
    expect(urls.some((u) => u.includes('page-error')), 'the internal error page is never saved').toBe(false);
    expect(urls.some((u) => u.includes('/refused-restored')), 'the failed address is saved').toBe(true);

    await closeId(id);
    const restoredId = await restoreAndExpectChrome(url);
    await closeId(restoredId);
  });
});
