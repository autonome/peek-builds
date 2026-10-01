/**
 * A page host whose load fails or hangs shows an error message in the content
 * area (not a blank window): a plain-language reason, the address that failed,
 * and a retry control. Covers a server that never answers, a closed port, a
 * name that cannot be resolved, and a string that is not an address at all.
 *
 * The hung-load timeout is shortened through PEEK_PAGE_LOAD_TIMEOUT_MS.
 *
 * Run with:
 *   yarn test:grep "Page host load error"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';
import net from 'net';

process.env.PEEK_PAGE_LOAD_TIMEOUT_MS = '1500';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;
const sockets = new Set<net.Socket>();

const ERROR_PAGE = 'peek://app/page-error/index.html';

test.describe('Page host load error @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-load-error'));
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/hang')) return;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><title>${req.url}</title><body>${req.url}</body>`);
      });
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      server.listen(0, '127.0.0.1', () => {
        serverPort = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    for (const s of sockets) s.destroy();
    if (server) server.close();
    if (app) await app.close();
  });

  const bridge = <T>(fn: string, ...args: unknown[]) =>
    app.evaluateMain!(((_e: unknown, a: { fn: string; args: unknown[] }) =>
      (globalThis as any).__peekHybridOverlayTest[a.fn](...a.args)) as any, { fn, args }) as Promise<T>;

  const openHost = async (url: string, extra: Record<string, unknown> = {}): Promise<number> => {
    const before = await bridge<number[]>('hybridIds');
    await bgWindow.evaluate(
      ({ u, x }: { u: string; x: Record<string, unknown> }) => {
        (window as any).app.window.open(u, { width: 800, height: 600, ...x });
      },
      { u: url, x: extra },
    );
    const id = await bridge<number | null>('waitHybridForUrl', url, before, 8000);
    expect(id, `a page host should exist for ${url}`).not.toBeNull();
    return id as number;
  };

  const closeWindow = (id: number) => bgWindow.evaluate((i: number) => (window as any).app.window.close(i), id);

  const contentText = (id: number) =>
    bridge<string | undefined>('evalInHybridContent', id, 'document.body ? document.body.innerText : ""');

  // The content area shows the error page with this reason and failed address.
  const expectErrorShown = async (id: number, reason: RegExp, failedAddress: string) => {
    await expect
      .poll(() => bridge<string>('contentUrl', id), { timeout: 10000, message: 'content should show the error page' })
      .toContain(ERROR_PAGE);
    await expect
      .poll(async () => (await contentText(id)) ?? '', { timeout: 5000 })
      .toMatch(reason);
    const text = (await contentText(id)) ?? '';
    expect(text).toContain(failedAddress);
    expect(text).toMatch(/retry/i);
  };

  test('a server that never answers shows the error after the load timeout', async () => {
    const url = `http://127.0.0.1:${serverPort}/hang/error`;
    const id = await openHost(url);
    await expectErrorShown(id, /not answering/i, url);
    await closeWindow(id);
  });

  test('a closed port shows connection refused', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${port}/refused`;
    const id = await openHost(url);
    await expectErrorShown(id, /refused/i, url);
    await closeWindow(id);
  });

  test('an unresolvable name shows address not found', async () => {
    const url = 'http://no-such-host.invalid/page';
    const id = await openHost(url);
    await expectErrorShown(id, /no server was found|not found/i, url);
    await closeWindow(id);
  });

  test('a string that is not an address shows not a valid address', async () => {
    const garbage = 'asdl;fkadlflk;asd;lfdlk;jadf';
    const id = await openHost(`http://127.0.0.1:${serverPort}/ok/start`);
    await expect.poll(() => bridge<string>('contentUrl', id), { timeout: 5000 }).toContain('/ok/start');
    await bridge<boolean>('publishTopic', 'page:navigate', { windowId: id, url: garbage });
    await expectErrorShown(id, /not a valid address/i, garbage);
    await closeWindow(id);
  });

  test('back from the error page returns to the previous page', async () => {
    const id = await openHost(`http://127.0.0.1:${serverPort}/ok/first`);
    await expect.poll(() => bridge<string>('contentUrl', id), { timeout: 5000 }).toContain('/ok/first');
    const url = 'http://no-such-host.invalid/back';
    await bridge<boolean>('publishTopic', 'page:navigate', { windowId: id, url });
    await expectErrorShown(id, /not found/i, url);
    await bridge<boolean>('publishTopic', 'page:go-back', { windowId: id });
    await expect.poll(() => bridge<string>('contentUrl', id), { timeout: 5000 }).toContain('/ok/first');
    await closeWindow(id);
  });

  test('reload on the error page retries the failed address', async () => {
    const id = await openHost(`http://127.0.0.1:${serverPort}/ok/start`);
    await expect.poll(() => bridge<string>('contentUrl', id), { timeout: 5000 }).toContain('/ok/start');
    // Fails now (nothing listening), then a server appears at the same port.
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${port}/ok/retry`;
    await bridge<boolean>('publishTopic', 'page:navigate', { windowId: id, url });
    await expectErrorShown(id, /refused/i, url);
    const revived = http.createServer((_q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/html' });
      r.end('<!DOCTYPE html><title>back</title><body>revived</body>');
    });
    await new Promise<void>((resolve) => revived.listen(port, '127.0.0.1', resolve));
    try {
      await bridge<boolean>('publishTopic', 'page:reload', { windowId: id });
      await expect.poll(() => bridge<string>('contentUrl', id), { timeout: 8000 }).toBe(url);
      await expect.poll(async () => (await contentText(id)) ?? '', { timeout: 5000 }).toContain('revived');
    } finally {
      revived.close();
    }
    await closeWindow(id);
  });
});
