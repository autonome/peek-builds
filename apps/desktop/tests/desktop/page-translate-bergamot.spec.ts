/**
 * On-device page translation with the real Bergamot engine inside the packaged app's
 * `utilityProcess`.
 *
 * Needs the engine wasm and the es→en and en→de models already downloaded into a translations
 * folder (`<root>/engine/…`, `<root>/models/…`, `records.json`), by default the worktree's
 * `.tmp/real-download/`, overridden by `PEEK_TRANSLATE_REAL_DIR`; the spec skips when they are
 * absent, so it never downloads models itself. The folder is copied into the test profile's
 * `<userData>/translations` before the first request. Main may still read the catalogue from
 * Mozilla's server on first use (it falls back to the copied `records.json` offline).
 *
 * Path covered: `translate page es→en` runs Bergamot on the page text and writes English back;
 * `translate page` into German replaces it by pivoting es→en→de, which keeps two directions
 * loaded; the engine process's memory is logged after each (`app.getAppMetrics()`).
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { setActive, waitOverlayReady } from '../helpers/hybrid-page';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const REAL_DIR =
  process.env.PEEK_TRANSLATE_REAL_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp/real-download');
const NEEDED = ['models/es-en', 'models/en-de', 'engine/bergamot-translator', 'records.json'];
const HAVE_FILES = NEEDED.every((p) => fs.existsSync(path.join(REAL_DIR, p)));

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

const PAGE_PATH = '/translate-bergamot-page';
const PAGE_HTML =
  '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Página</title></head>' +
  '<body><h1 id="heading">El tiempo está agradable hoy, así que vamos a dar un paseo por el parque.</h1>' +
  '<p id="para">Lee la <a href="/docs">documentación</a> antes de <b>instalar</b> la aplicación.</p>' +
  '<img id="pic" alt="Un perro negro duerme en el sofá." src="data:,">' +
  '</body></html>';

interface PageText {
  heading: string;
  para: string;
  paraHtml: string;
  alt: string;
}

async function readPage(page: Page): Promise<PageText> {
  return page.evaluate(() => ({
    heading: document.getElementById('heading')?.textContent ?? '',
    para: document.getElementById('para')?.textContent ?? '',
    paraHtml: document.getElementById('para')?.innerHTML ?? '',
    alt: document.getElementById('pic')?.getAttribute('alt') ?? '',
  }));
}

function publishSystemTopic(topic: string, msg: unknown): Promise<void> {
  return app.evaluateMain!(((_e: unknown, arg: { topic: string; msg: unknown }) => {
    (globalThis as any).__peek_test.publishSystemTopic(arg.topic, arg.msg);
  }) as any, { topic, msg });
}

/** Working-set and peak memory of the translation engine process, in MB. */
async function engineMemory(): Promise<Array<{ name: string; workingSetMB: number; peakMB: number }>> {
  const metrics = (await app.evaluateMain!(((e: any) => e.app.getAppMetrics()) as any)) as any[];
  return metrics
    .filter((m) => m.type === 'Utility' && /translation/i.test(`${m.serviceName ?? ''} ${m.name ?? ''}`))
    .map((m) => ({
      name: `${m.serviceName ?? m.name}`,
      workingSetMB: Math.round(m.memory.workingSetSize / 1024),
      peakMB: Math.round(m.memory.peakWorkingSetSize / 1024),
    }));
}

test.describe('Page translation with the Bergamot engine @desktop', () => {
  test.skip(!HAVE_FILES, `engine and es-en/en-de models not found in ${REAL_DIR}`);

  test.beforeAll(async () => {
    const profile = `test-smoke-page-translate-bergamot-${Date.now()}`;
    app = await launchDesktopApp(profile);
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);

    const userData = (await app.evaluateMain!(((e: any) => e.app.getPath('userData')) as any)) as string;
    fs.cpSync(REAL_DIR, path.join(userData, 'translations'), { recursive: true });

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

  test('translates a Spanish page into English, then into German by pivoting', async () => {
    const url = `http://127.0.0.1:${serverPort}${PAGE_PATH}`;
    const opened = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(opened.success).toBe(true);
    const windowId = opened.id as number;
    const page = await app.getWindow(PAGE_PATH.slice(1), 15000);
    await page.waitForLoadState('domcontentloaded');
    const original = await readPage(page);
    expect(await setActive(app, { id: windowId, contentWcId: null })).toBe(true);
    await waitOverlayReady(app);

    const t0 = Date.now();
    await publishSystemTopic('cmd:execute:translate page', { search: 'en' });
    await expect.poll(async () => (await readPage(page)).heading, { timeout: 30000 }).toMatch(/weather/i);
    const english = await readPage(page);
    const englishMs = Date.now() - t0;
    expect(english.paraHtml).toMatch(/<a href="\/docs">[^<]+<\/a>/);
    expect(english.alt).not.toBe(original.alt);
    const oneDirection = await engineMemory();
    console.log(`[bergamot-spec] es→en ${englishMs} ms ${JSON.stringify(english)} memory ${JSON.stringify(oneDirection)}`);
    expect(oneDirection.length).toBe(1);

    const t1 = Date.now();
    await publishSystemTopic('cmd:execute:translate page', { search: 'de' });
    await expect.poll(async () => (await readPage(page)).heading, { timeout: 30000 }).toMatch(/Wetter/);
    const german = await readPage(page);
    const germanMs = Date.now() - t1;
    const twoDirections = await engineMemory();
    console.log(`[bergamot-spec] es→de ${germanMs} ms ${JSON.stringify(german)} memory ${JSON.stringify(twoDirections)}`);

    await publishSystemTopic('cmd:execute:show original', {});
    await expect.poll(() => readPage(page), { timeout: 10000 }).toEqual(original);
  });
});
