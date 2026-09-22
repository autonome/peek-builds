/**
 * Sibling of slides-address-edit-while-open.spec.ts's "hotkey pressed before
 * settings-changed arrives" case, adapted to peeks.
 *
 * `features/peeks/background.js`'s `cli:peek-open` handler resolved the pressed
 * key against the module-level `currentSettings` cache, which is only refreshed
 * when `reinit()` finishes reloading it after a `peeks:settings-changed` publish.
 * An address edit writes the row and then publishes that topic asynchronously; a
 * hotkey press landing before reinit() finishes used to resolve against the stale
 * pre-edit settings and open the old address. Fixed the same way as slides
 * (`a25929f4`): the handler now calls `loadSettings()` fresh on every press
 * instead of trusting `currentSettings`.
 *
 * A raw `datastore.setRow` write (no publish) makes the race deterministic
 * rather than depending on beating an async reinit() — see seedSlide's identical
 * use in slides-address-edit-while-open.spec.ts.
 *
 * The old window is closed before the second write/press: peeks key their open
 * window on `peek:${keyNum}` (not the address), so an edit while the old window
 * is STILL open hits the unrelated, already-known key-reuse gap noted in
 * `executeItem`'s comments (the existing window is shown, not navigated). Closing
 * it first isolates the staleness bug this spec targets.
 *
 * Run with:
 *   yarn test:grep "hotkey pressed before settings-changed arrives opens the saved address"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

const KEY_NUM = 3;

function startServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
          `<body><h1>${req.url}</h1></body></html>`,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

const bridgePresent = (app: DesktopApp): Promise<boolean> =>
  app.evaluateMain!(
    () =>
      Boolean((globalThis as any).__peekHybridOverlayTest) &&
      Boolean((globalThis as any).__peek_test),
  ) as Promise<boolean>;

/** Publish `cli:peek-open` with `{ args: [keyNum] }` — the hotkey's wake output. */
const firePeekOpen = (app: DesktopApp, keyNum: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, k: string) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:peek-open', { args: [k] });
  }) as any, keyNum);

/** Wait for a NEW hybrid window whose requested address equals `url`, excluding `excludeIds`. */
const waitHybridForUrl = (app: DesktopApp, url: string, excludeIds: number[], timeoutMs = 15000): Promise<number | null> =>
  app.evaluateMain!(((_e: unknown, args: { u: string; ex: number[]; t: number }) =>
    (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(args.u, args.ex, args.t)) as any,
    { u: url, ex: excludeIds, t: timeoutMs },
  ) as Promise<number | null>;

const hybridWindowExists = (app: DesktopApp, id: number): Promise<boolean> =>
  app.evaluateMain!(((_e: unknown, wid: number) =>
    (globalThis as any).__peekHybridOverlayTest.hybridWindowExists(wid)) as any, id) as Promise<boolean>;

const hybridAddresses = (app: DesktopApp): Promise<string[]> =>
  app.evaluateMain!(() =>
    (globalThis as any).__peekHybridOverlayTest.hybridAddresses()) as Promise<string[]>;

const closeWindowId = (bgWindow: Page, id: number): Promise<void> =>
  bgWindow.evaluate(async (wid: number) => {
    await (window as any).app.window.close(wid);
  }, id);

/** Seed the peeks `items` row exactly as manage.js save() writes it, no publish. */
const seedPeek = (bgWindow: Page, address: string): Promise<void> =>
  bgWindow.evaluate(async (addr) => {
    const api = (window as any).app;
    const items = [{
      keyNum: 3, title: 'Peek from race', address: addr,
      persistState: false, keepLive: false, allowSound: false,
      height: 400, width: 600, enabled: true,
    }];
    await api.datastore.setRow('feature_settings', 'peeks:items', {
      featureId: 'peeks', key: 'items', value: JSON.stringify(items), updatedAt: Date.now(),
    });
  }, address);

test.describe('Peeks hotkey reads the saved address, not a stale in-memory copy @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('peeks-address-hotkey-beats-notify'));
    ({ server, port: serverPort } = await startServer());
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('hotkey pressed before settings-changed arrives opens the saved address', async () => {
    test.skip(!(await bridgePresent(app)), 'no hybrid overlay / test bridge in this configuration');

    const oldAddress = `http://127.0.0.1:${serverPort}/beats-notify-old`;
    const newAddress = `http://127.0.0.1:${serverPort}/beats-notify-new`;

    // Wake the tile with the old address so its in-memory settings hold it.
    await seedPeek(bgWindow, oldAddress);
    await firePeekOpen(app, String(KEY_NUM));
    const oldWindowId = await waitHybridForUrl(app, oldAddress, []);
    expect(oldWindowId, 'the old-address peek must open').not.toBeNull();

    await closeWindowId(bgWindow, oldWindowId!);
    await expect.poll(() => hybridWindowExists(app, oldWindowId!), {
      timeout: 10000, message: 'the old window never closed',
    }).toBe(false);

    // Save the new address WITHOUT publishing peeks:settings-changed.
    await seedPeek(bgWindow, newAddress);

    await firePeekOpen(app, String(KEY_NUM));
    const newWindowId = await waitHybridForUrl(app, newAddress, [oldWindowId!], 8000);
    expect(
      newWindowId,
      'the hotkey must open the saved address even before the tile hears settings-changed',
    ).not.toBeNull();
    expect(await hybridAddresses(app)).not.toContain(oldAddress);
  });
});
