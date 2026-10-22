/**
 * Time on page, end to end: `item_visits.duration` holds the milliseconds a
 * page was in front of the user, not the milliseconds its window was open.
 *
 * Two real page windows over a local server. The first is held in front for
 * about 1.5 s, then the second is opened and held in front for about 1 s. The
 * first page's duration must cover its own time and exclude the time it spent
 * behind the second window.
 *
 * Headless grants no real OS focus, so the windows are brought to the front
 * through `__peek_test.focusHybridWindowForTest`, which emits the host's real
 * focus event — the same event the window system sends on a click.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';
import { Page } from '@playwright/test';
import http from 'http';

const FIRST_PAGE_MS = 1500;
const SECOND_PAGE_MS = 1000;
/** Long enough for the focus to settle out of the show that preceded it. */
const SETTLE_MS = 400;

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open a real page window and return its id. */
async function openPage(url: string): Promise<number> {
  const result = await bgWindow.evaluate(
    async (u: string) => await (window as any).app.window.open(u, { width: 520, height: 400 }),
    url,
  );
  expect(result.success).toBe(true);
  return result.id as number;
}

/** Bring a page window to the front and confirm the machine agrees. */
async function bringToFront(windowId: number): Promise<void> {
  await wait(SETTLE_MS);
  const focused = await app.evaluateMain!(
    ((_e: unknown, id: number) => (globalThis as any).__peek_test.focusHybridWindowForTest(id)) as any,
    windowId,
  );
  expect(focused).toBe(true);
  await expect
    .poll(
      async () =>
        await app.evaluateMain!(
          ((_e: unknown, id: number) => {
            const test = (globalThis as any).__peek_test;
            const bridge = (globalThis as any).__peekHybridOverlayTest;
            const state = test.kernelStateForTest();
            return state.appActive && state.key !== null && state.key === bridge.machineWindowIdFor(id);
          }) as any,
          windowId,
        ),
      { timeout: 5000, message: `window ${windowId} never became the window in front` },
    )
    .toBe(true);
}

/** The visit rows for a URL, newest first. */
async function visitsFor(url: string): Promise<Array<{ id: string; duration: number }>> {
  return await bgWindow.evaluate(async (u: string) => {
    const api = (window as any).app.datastore;
    const item = await api.findUrlItem(u);
    const itemId = item?.data?.id;
    if (!itemId) return [];
    const visits = await api.getItemVisits(itemId);
    return (visits?.data ?? []).map((v: any) => ({ id: v.id, duration: v.duration }));
  }, url);
}

async function closePage(windowId: number): Promise<void> {
  await bgWindow.evaluate(
    async (id: number) => await (window as any).app.window.close(id),
    windowId,
  );
}

test.describe('Time on page @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('visit-dwell'));
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>dwell ${req.url}</title></head><body>dwell</body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        serverPort = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('counts the time a page was in front and not the time behind another window', async () => {
    const firstUrl = `http://127.0.0.1:${serverPort}/first`;
    const secondUrl = `http://127.0.0.1:${serverPort}/second`;

    const first = await openPage(firstUrl);
    await bringToFront(first);
    await wait(FIRST_PAGE_MS);

    const second = await openPage(secondUrl);
    await bringToFront(second);
    await wait(SECOND_PAGE_MS);

    await closePage(first);
    await closePage(second);

    await expect
      .poll(async () => (await visitsFor(firstUrl))[0]?.duration ?? 0, {
        timeout: 10_000,
        message: 'the first page never got a duration',
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await visitsFor(secondUrl))[0]?.duration ?? 0, {
        timeout: 10_000,
        message: 'the second page never got a duration',
      })
      .toBeGreaterThan(0);

    const firstDuration = (await visitsFor(firstUrl))[0].duration;
    const secondDuration = (await visitsFor(secondUrl))[0].duration;

    // The first page's own time, with slack for the focus settle, and well
    // short of its whole open life (which includes the second page's second).
    expect(firstDuration).toBeGreaterThanOrEqual(1000);
    expect(firstDuration).toBeLessThanOrEqual(2500);
    expect(secondDuration).toBeGreaterThanOrEqual(500);
    expect(secondDuration).toBeLessThanOrEqual(2000);
  });
});
