/**
 * The translate widget follows the page window in front.
 *
 * Every page window shares one chrome, and the translate tile draws one widget in it. The tile
 * keeps each window's view (`features/translate/window-views.js`) and redraws on main's
 * `page-overlay:active` report, so another window coming forward hides a window's offer or
 * status, and bringing that window back shows it again.
 *
 * The app runs the stub engine (`PEEK_TRANSLATE_ENGINE=stub`, upper-cases text) and serves two
 * pages from a local http server: one declaring Spanish, one declaring English (no offer).
 * Window activation is synthetic (`setActive`), so the spec never takes OS focus.
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { setActive, waitOverlayReady, widgetHostState } from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

const SPANISH_PATH = '/translate-front-es';
const ENGLISH_PATH = '/translate-front-en';
const SPANISH_HTML =
  '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Página</title></head>' +
  '<body><h1 id="heading">hola mundo</h1></body></html>';
const ENGLISH_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head>' +
  '<body><h1 id="heading">hello world</h1></body></html>';

const WIDGET_KEY = 'translate:status';

function clickWidgetButton(action: string): Promise<unknown> {
  return app.evaluateMain!(((_e: unknown, arg: { key: string; action: string }) => {
    const b = (globalThis as any).__peekHybridOverlayTest;
    return b.evalInOverlay(`(() => {
      const card = document.querySelector('.widget[data-widget-id="${arg.key}"]:not(.hiding)');
      if (!card) return 'no-widget';
      const host = card.querySelector('peek-button[data-widget-action="${arg.action}"]');
      if (!host) return 'no-button';
      const inner = host.shadowRoot && host.shadowRoot.querySelector('button');
      if (!inner) return 'peek-button-not-upgraded';
      inner.click();
      return 'clicked';
    })()`);
  }) as any, { key: WIDGET_KEY, action });
}

async function widgetBody(): Promise<string | null> {
  const state = await widgetHostState(app);
  return state?.byId[WIDGET_KEY]?.bodyHtml ?? null;
}

async function openPage(path: string): Promise<{ id: number; page: Page }> {
  const opened = await bgWindow.evaluate(async (u: string) => {
    return await (window as any).app.window.open(u, { width: 800, height: 600 });
  }, `http://127.0.0.1:${serverPort}${path}`);
  expect(opened.success).toBe(true);
  const page = await app.getWindow(path.slice(1), 15000);
  await page.waitForLoadState('domcontentloaded');
  return { id: opened.id as number, page };
}

function heading(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('heading')?.textContent ?? '');
}

test.describe('Translate widget follows the window in front @desktop', () => {
  test.beforeAll(async () => {
    const profile = `test-smoke-page-translate-front-${Date.now()}`;
    app = await launchDesktopApp(profile, { env: { PEEK_TRANSLATE_ENGINE: 'stub' } });
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.url === ENGLISH_PATH ? ENGLISH_HTML : SPANISH_HTML);
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

  test('the offer and the status hide with another window in front and come back with theirs', async () => {
    const ready = app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.waitForTileState('translate', 'ready', 15000)) as any);
    const spanish = await openPage(SPANISH_PATH);
    await ready;
    const english = await openPage(ENGLISH_PATH);

    // ── the Spanish page in front shows the offer ──────────────────────────
    expect(await setActive(app, { id: spanish.id, contentWcId: null })).toBe(true);
    await waitOverlayReady(app);
    await spanish.page.reload();
    await expect.poll(widgetBody, { timeout: 10000 }).toContain('Translate from Spanish');

    // ── the English page in front: no offer of its own, so no widget ──────
    expect(await setActive(app, { id: english.id, contentWcId: null })).toBe(true);
    await expect.poll(widgetBody, { timeout: 10000 }).toBeNull();

    // ── the Spanish page back in front: its offer comes back ──────────────
    expect(await setActive(app, { id: spanish.id, contentWcId: null })).toBe(true);
    await expect.poll(widgetBody, { timeout: 10000 }).toContain('Translate from Spanish');

    // ── translate it; its status follows the window the same way ──────────
    expect(await clickWidgetButton('translate')).toBe('clicked');
    await expect.poll(() => heading(spanish.page), { timeout: 15000 }).toBe('HOLA MUNDO');
    await expect.poll(widgetBody, { timeout: 10000 }).toContain('data-widget-action="show-original"');

    expect(await setActive(app, { id: english.id, contentWcId: null })).toBe(true);
    await expect.poll(widgetBody, { timeout: 10000 }).toBeNull();
    expect(await heading(english.page)).toBe('hello world');

    expect(await setActive(app, { id: spanish.id, contentWcId: null })).toBe(true);
    await expect.poll(widgetBody, { timeout: 10000 }).toContain('Translated from Spanish to English.');

    // ── the button acts on the window it came back with ───────────────────
    expect(await clickWidgetButton('show-original')).toBe('clicked');
    await expect.poll(() => heading(spanish.page), { timeout: 10000 }).toBe('hola mundo');
    await expect.poll(widgetBody, { timeout: 10000 }).toBeNull();
  });
});
