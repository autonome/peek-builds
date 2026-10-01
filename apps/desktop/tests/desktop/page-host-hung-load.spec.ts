/**
 * Page host stays usable while its content never answers.
 *
 * A server that accepts the connection and never responds leaves the content
 * navigation pending with no timeout. The page host (window, chrome, the
 * caller's open() call) must not depend on that navigation finishing: the user
 * can still navigate elsewhere, and the open call still reports the window it
 * created.
 *
 * The open IPC (`ipc.ts` hybrid page-host branch) awaits
 * `view.webContents.loadURL(url)` before it registers the window's workspace
 * mode, publishes `window:opened`, and returns the window id. Each test opens a
 * page against a server that never replies, WITHOUT awaiting the open, then
 * checks what the user and the caller can still do.
 *
 * Run with:
 *   yarn test:grep "Page host hung load"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';
import net from 'net';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;
const sockets = new Set<net.Socket>();

test.describe('Page host hung load @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-hung-load'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        // `/hang` accepts the request and never answers it.
        if (req.url && req.url.startsWith('/hang')) return;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
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

  const hybridBridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  // Opens the hanging page without awaiting the open call; returns the new
  // host's window id.
  const openHanging = async (label: string): Promise<{ id: number; url: string }> => {
    const url = `http://127.0.0.1:${serverPort}/hang/${label}`;
    const before = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return (b.hybridIds ? b.hybridIds() : []) as number[];
    });
    await bgWindow.evaluate((u: string) => {
      const w = window as any;
      w.__hungOpen = { settled: false, result: null as unknown };
      w.app.window.open(u, { width: 800, height: 600 }).then((r: unknown) => {
        w.__hungOpen.settled = true;
        w.__hungOpen.result = r;
      });
    }, url);
    const id = (await app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl(arg.url, arg.before, 8000) as Promise<number | null>;
    }) as any, { url, before })) as number | null;
    expect(id, 'a hybrid page-host should be registered for the hanging URL').not.toBeNull();
    return { id: id as number, url };
  };

  test('navigating to another address works while the first load hangs', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('navigate');
    const target = `http://127.0.0.1:${serverPort}/ok/after-hang`;

    await app.evaluateMain!(((_e: unknown, arg: { id: number; url: string }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic('page:navigate', { windowId: arg.id, url: arg.url });
    }) as any, { id, url: target });

    await expect
      .poll(
        async () =>
          app.evaluateMain!(((_e: unknown, i: number) => {
            const b = (globalThis as any).__peekHybridOverlayTest;
            return b.contentUrl(i);
          }) as any, id),
        { timeout: 5000 },
      )
      .toContain('/ok/after-hang');

    await bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id);
  });

  test('the open call reports the created window while the load hangs', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('open-result');

    await expect
      .poll(
        async () =>
          bgWindow.evaluate(() => (window as any).__hungOpen as { settled: boolean; result: any }),
        { timeout: 5000 },
      )
      .toMatchObject({ settled: true, result: { success: true, id } });

    await bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id);
  });

  test('closing the window works while the load hangs', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('close');

    const closed = await Promise.race([
      bgWindow.evaluate(async (i: number) => {
        await (window as any).app.window.close(i);
        return true;
      }, id),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    expect(closed, 'window.close resolves within 5s').toBe(true);

    await expect
      .poll(
        async () =>
          app.evaluateMain!(((_e: unknown, i: number) => {
            const b = (globalThis as any).__peekHybridOverlayTest;
            return b.hostVisibility(i);
          }) as any, id),
        { timeout: 5000 },
      )
      .toBeFalsy();
  });
});
