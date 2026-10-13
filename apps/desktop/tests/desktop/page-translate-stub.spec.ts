/**
 * On-device page translation, end to end against the stub engine.
 *
 * The app is launched with `PEEK_TRANSLATE_ENGINE=stub`
 * (`main/page-translate/engine-protocol.ts engineModeFromEnv`); main passes its environment
 * to the engine's `utilityProcess`, so the engine forked from inside the packaged build
 * upper-cases text instead of loading Bergamot models. The page comes from a local http
 * server (no internet) and declares Spanish with `<html lang="es">`.
 *
 * Path covered:
 *  - Loading the page makes main publish `page:translatable` (the page declares Spanish, the
 *    app's language is English), which wakes the lazy `translate` tile.
 *  - With the window in front, a load shows the offer widget; its "Translate from Spanish"
 *    `<peek-button>` (clicked inside its shadow root) travels back as `widget:action` and
 *    becomes `translate:page`; main injects the page translator, sends the text to the engine
 *    process and writes the result back into the page.
 *  - The tile then shows its status widget; clicking its "Show original" button puts the
 *    page's own text back.
 *  - `cmd:execute:translate page` reads the page's declared language and translates again,
 *    and the `show original` command restores it.
 *
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

const PAGE_PATH = '/translate-stub-page';
const PAGE_HTML =
  '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Página</title></head>' +
  '<body><h1 id="heading">hola mundo</h1>' +
  '<p id="para">el gato <b>negro</b> duerme</p>' +
  '<img id="pic" alt="un perro" src="data:,">' +
  '</body></html>';

const WIDGET_KEY = 'translate:status';

/** The page's visible text and one translatable attribute, read from the content window. */
interface PageText {
  heading: string;
  para: string;
  alt: string;
}

const ORIGINAL: PageText = { heading: 'hola mundo', para: 'el gato negro duerme', alt: 'un perro' };
const TRANSLATED: PageText = { heading: 'HOLA MUNDO', para: 'EL GATO NEGRO DUERME', alt: 'UN PERRO' };

async function readPage(page: Page): Promise<PageText> {
  return page.evaluate(() => ({
    heading: document.getElementById('heading')?.textContent ?? '',
    para: document.getElementById('para')?.textContent ?? '',
    alt: document.getElementById('pic')?.getAttribute('alt') ?? '',
  }));
}

function publishSystemTopic(topic: string, msg: unknown): Promise<void> {
  return app.evaluateMain!(((_e: unknown, arg: { topic: string; msg: unknown }) => {
    (globalThis as any).__peek_test.publishSystemTopic(arg.topic, arg.msg);
  }) as any, { topic, msg });
}

/**
 * Clicks the button inside the widget's `<peek-button>` for `action`, in the overlay. Every
 * render replaces the widget's card and the old one stays in the DOM for a moment with class
 * `hiding`, so the live card is the one without it.
 */
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

test.describe('Page translation with the stub engine @desktop', () => {
  test.beforeAll(async () => {
    const profile = `test-smoke-page-translate-stub-${Date.now()}`;
    app = await launchDesktopApp(profile, { env: { PEEK_TRANSLATE_ENGINE: 'stub' } });
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
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

  test('offers a translation, translates, then restores from the widget button and from the command', async () => {
    // ── loading a page that declares Spanish wakes the lazy tile ───────────
    // Main publishes page:translatable because the page's language is not the app's (en).
    const ready = app.evaluateMain!(((_e: unknown) =>
      (globalThis as any).__peek_test.waitForTileState('translate', 'ready', 15000)) as any);
    const url = `http://127.0.0.1:${serverPort}${PAGE_PATH}`;
    const opened = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(opened.success).toBe(true);
    const windowId = opened.id as number;
    const page = await app.getWindow(PAGE_PATH.slice(1), 15000);
    await page.waitForLoadState('domcontentloaded');
    expect(await readPage(page)).toEqual(ORIGINAL);
    await ready;

    expect(await setActive(app, { id: windowId, contentWcId: null })).toBe(true);
    await waitOverlayReady(app);

    // ── with the window in front, a load shows the offer ───────────────────
    // The first load may have finished before the window was made active, so load again.
    await page.reload();
    await expect
      .poll(widgetBody, { timeout: 10000 })
      .toContain('data-widget-action="translate" data-widget-value="es en"');
    expect(await widgetBody()).toContain('Translate from Spanish');

    // ── "Translate from Spanish" translates the page ───────────────────────
    expect(await clickWidgetButton('translate')).toBe('clicked');
    await expect.poll(() => readPage(page), { timeout: 15000 }).toEqual(TRANSLATED);

    // ── the widget offers "Show original"; clicking it restores the page ──
    await expect
      .poll(widgetBody, { timeout: 10000 })
      .toContain('data-widget-action="show-original"');
    expect(await clickWidgetButton('show-original')).toBe('clicked');
    await expect.poll(() => readPage(page), { timeout: 10000 }).toEqual(ORIGINAL);
    // Back to the original, the tile closes its widget.
    await expect.poll(widgetBody, { timeout: 10000 }).toBeNull();

    // ── translate through the command, then restore through `show original` ─
    await publishSystemTopic('cmd:execute:translate page', { search: 'en' });
    await expect.poll(() => readPage(page), { timeout: 15000 }).toEqual(TRANSLATED);
    await publishSystemTopic('cmd:execute:show original', {});
    await expect.poll(() => readPage(page), { timeout: 10000 }).toEqual(ORIGINAL);
  });
});
