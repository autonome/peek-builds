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
import { waitOverlayReady } from '../helpers/hybrid-page';
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
  const openHanging = async (
    label: string,
    opts: { path?: string; key?: string } = {},
  ): Promise<{ id: number; url: string }> => {
    const url = `http://127.0.0.1:${serverPort}/${opts.path ?? 'hang'}/${label}`;
    const before = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return (b.hybridIds ? b.hybridIds() : []) as number[];
    });
    await bgWindow.evaluate(
      ({ u, key }: { u: string; key?: string }) => {
        const w = window as any;
        w.__hungOpen = { settled: false, result: null as unknown };
        w.app.window.open(u, { width: 800, height: 600, ...(key ? { key } : {}) }).then((r: unknown) => {
          w.__hungOpen.settled = true;
          w.__hungOpen.result = r;
        });
      },
      { u: url, key: opts.key },
    );
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

  const publish = async (topic: string, msg: Record<string, unknown>) =>
    app.evaluateMain!(((_e: unknown, arg: { topic: string; msg: Record<string, unknown> }) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.publishTopic(arg.topic, arg.msg);
    }) as any, { topic, msg });

  const contentUrl = async (id: number) =>
    app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.contentUrl(i)) as any, id) as Promise<string>;

  const contentLoading = async (id: number) =>
    app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.contentLoading(i)) as any, id) as Promise<boolean>;

  const closeWindow = async (id: number) =>
    bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id);

  test('stop cancels the hung load', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('stop');
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(true);

    await publish('page:stop', { windowId: id });

    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(false);
    await closeWindow(id);
  });

  test('reload while the load hangs leaves the window usable', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('reload');
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(true);

    await publish('page:reload', { windowId: id });
    // Still loading (the server never answers) and still responsive: stop works,
    // then navigation to another address works.
    expect(await contentLoading(id)).toBe(true);
    await publish('page:stop', { windowId: id });
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(false);

    await publish('page:navigate', { windowId: id, url: `http://127.0.0.1:${serverPort}/ok/after-reload` });
    await expect.poll(() => contentUrl(id), { timeout: 5000 }).toContain('/ok/after-reload');
    await closeWindow(id);
  });

  test('back while the load hangs returns to the previous page', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('first', { path: 'ok' });
    // Let the first page commit so it is a history entry, not a superseded load.
    await expect.poll(() => contentUrl(id), { timeout: 5000 }).toContain('/ok/first');
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(false);
    await publish('page:navigate', { windowId: id, url: `http://127.0.0.1:${serverPort}/ok/second` });
    await expect.poll(() => contentUrl(id), { timeout: 5000 }).toContain('/ok/second');
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(false);

    await publish('page:navigate', { windowId: id, url: `http://127.0.0.1:${serverPort}/hang/back` });
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(true);

    await publish('page:go-back', { windowId: id });

    await expect.poll(() => contentUrl(id), { timeout: 5000 }).toContain('/ok/first');
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(false);
    await closeWindow(id);
  });

  // The chrome overlay frames a host only once the host is orderable. A page
  // that never paints reports no first frame, so the host's own failed or
  // timed-out load must make it orderable. Asserts the overlay is attached to
  // the host (not just that the load state is right), and that its renderer is up.
  const expectChromeAttached = async (id: number) => {
    await app.evaluateMain!(((_e: unknown, i: number) =>
      (globalThis as any).__peekHybridOverlayTest.setActive(i)) as any, id);
    await expect
      .poll(
        async () =>
          app.evaluateMain!(() => (globalThis as any).__peekHybridOverlayTest.activeId() as number | null),
        { timeout: 8000, message: 'the chrome overlay should attach to the host whose content never painted' },
      )
      .toBe(id);
    await waitOverlayReady(app);
  };

  test('chrome overlay attaches to a host whose server never answers', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const { id } = await openHanging('chrome-hung');
    await expect.poll(() => contentLoading(id), { timeout: 5000 }).toBe(true);
    await expectChromeAttached(id);
    await closeWindow(id);
  });

  test('chrome overlay attaches to a host whose connection is refused', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    // A port that was just free and is now closed.
    const closedPort = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${closedPort}/refused`;
    const before = await app.evaluateMain!(
      () => (globalThis as any).__peekHybridOverlayTest.hybridIds() as number[],
    );
    await bgWindow.evaluate((u: string) => {
      (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    const id = (await app.evaluateMain!(((_e: unknown, arg: { url: string; before: number[] }) =>
      (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(arg.url, arg.before, 8000)) as any, {
      url,
      before,
    })) as number | null;
    expect(id, 'a hybrid page-host should be registered for the refused URL').not.toBeNull();
    await expectChromeAttached(id as number);
    await closeWindow(id as number);
  });

  test('a second open with the same key reuses the window while the first load hangs', async () => {
    test.skip(!(await hybridBridgePresent()), 'no overlay bridge in this configuration');
    const key = 'hung-load-same-key';
    const { id, url } = await openHanging('same-key', { key });
    const countBefore = await app.evaluateMain!(
      () => (globalThis as any).__peekHybridOverlayTest.hybridCount() as number,
    );

    // The first open settles once its bounded wait on the load ends; the key is
    // then no longer pending and the second open must find the first window.
    await expect
      .poll(async () => bgWindow.evaluate(() => (window as any).__hungOpen.settled as boolean), {
        timeout: 8000,
      })
      .toBe(true);

    const second = await bgWindow.evaluate(
      ({ u, k }: { u: string; k: string }) =>
        (window as any).app.window.open(u, { width: 800, height: 600, key: k }) as Promise<any>,
      { u: url, k: key },
    );
    expect(second).toMatchObject({ success: true, id, reused: true });

    const countAfter = await app.evaluateMain!(
      () => (globalThis as any).__peekHybridOverlayTest.hybridCount() as number,
    );
    expect(countAfter, 'no duplicate window').toBe(countBefore);
    await closeWindow(id);
  });
});
