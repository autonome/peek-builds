/**
 * Websearch Engine Discovery (lazy wake on a core semantic event)
 *
 * The `websearch` feature was converted from a RESIDENT background tile
 * (it used to subscribe `page:loaded` at boot) to a LAZY tile (peek epic
 * d8e7efa5 / peek task 921b54b3). Its renderer no longer exists at boot.
 *
 * Core page handling (apps/desktop/renderer/page/page.js) now fires a NEW
 * semantic event `page:search-engine-discovered` {pageUrl, opensearchUrl}
 * whenever a loaded page advertises an OpenSearch descriptor — the same
 * lightweight DOM detection it already did for `page:loaded`. The websearch
 * tile declares `lazyEvents: ["page:search-engine-discovered"]`, so that
 * publish flows through the load-on-dispatch hook, boots the websearch tile
 * HIDDEN, waits for it to reach READY, and then delivers the event to the
 * tile's freshly-subscribed handler.
 *
 * The 600x500 search-box UI lives in the SAME tile but is only shown when a
 * command handler calls `api.window.showSelf()` — discovery NEVER calls that.
 * launchTile creates every tile window with `show: false`, so waking the tile
 * on a page event leaves the search box hidden (no flash). This spec proves
 * that invariant in assertion (c).
 *
 * NOTE: the discovery RESULT (engine recorded + `websearch:engine-discovered`
 * published) is intentionally NOT asserted — the discovery fetch is a renderer
 * `fetch` of the localhost OSD endpoint from the tile's peek:// origin, which
 * is CORS-blocked (real engines don't send Access-Control-Allow-Origin for
 * peek://), so the fetch fails with "Failed to fetch" and no engine is
 * recorded. That is a deferred bug, tracked as peek task 8217dc0e. This spec
 * proves the lazy-WAKE path only: a page advertising OpenSearch wakes the
 * lazy websearch tile to READY, hidden.
 *
 * Determinism (feedback_no_sleep_in_tests_or_code): the cold-wake is
 * synchronized on a REAL FSM transition — `__peek_test.waitForTileState(
 * 'websearch','ready')` resolves on the System-owned `tile:state-changed`
 * observer topic. No timers/sleeps; the deadline is a failure-deadline only.
 *
 * Run with:
 *   yarn test:grep "Websearch Engine Discovery"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

const OSD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>DiscoTest</ShortName>
  <Description>Disco Test Search</Description>
  <Url type="text/html" template="http://example.test/search?q={searchTerms}"/>
</OpenSearchDescription>`;

/** True iff any live BrowserWindow's URL contains the given substring. */
const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/**
 * Is there a VISIBLE BrowserWindow whose URL contains the given substring?
 * Used to prove the websearch search-box UI never becomes visible during
 * discovery (it boots hidden via launchTile's `show: false`).
 */
const visibleWindowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.isVisible() && w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/**
 * Resolve when the `websearch` tile transitions INTO `ready`, observed on the
 * real `tile:state-changed` FSM-mirror topic. Set this up BEFORE opening the
 * page so the cold-boot transition can't be missed.
 */
const waitWebsearchReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('websearch', 'ready', 15000);
  }) as any);

test.describe('Websearch Engine Discovery @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('websearch-engine-discovery'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/osd.xml') {
          res.writeHead(200, { 'Content-Type': 'application/opensearchdescription+xml' });
          res.end(OSD_XML);
          return;
        }
        // The HTML page advertises the OpenSearch descriptor via <link rel=search>.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>Disco Page</title>` +
          `<link rel="search" type="application/opensearchdescription+xml" title="DiscoTest" href="/osd.xml">` +
          `</head><body><h1>discovery page</h1></body></html>`
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

  test('a page advertising OpenSearch wakes lazy websearch to READY, hidden', async () => {
    // ── (a) no websearch window at boot ──────────────────────────────────
    expect(await windowUrlExists('peek://websearch/')).toBe(false);

    // Arm the FSM observer BEFORE opening the page so the cold-boot READY
    // transition can't race ahead of us. The 15s deadline is a failure
    // deadline, not a settle-wait.
    const readyPromise = waitWebsearchReady();

    // ── (b) open the page → core page.js fires page:search-engine-discovered ─
    // which is websearch's lazyEvent → the lazy tile boots hidden and is
    // driven to READY.
    const pageUrl = `http://127.0.0.1:${serverPort}/disco`;
    const openResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, pageUrl);
    expect(openResult.success).toBe(true);

    // Synchronize on the real LOADING → READY transition of the websearch tile.
    const transition = (await readyPromise) as { tileId: string; to: string };
    expect(transition.tileId).toBe('websearch');
    expect(transition.to).toBe('ready');

    // ── (c) the search-box UI must NOT have become visible during wake ────
    // The tile booted hidden (launchTile `show: false`); only a command
    // handler calls showSelf(). Confirm the websearch home window — if it
    // exists at all — is not visible.
    expect(await visibleWindowUrlExists('peek://websearch/home.html')).toBe(false);
  });
});
