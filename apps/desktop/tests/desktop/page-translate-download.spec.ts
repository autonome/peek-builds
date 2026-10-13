/**
 * Asking, from the page, for the models a translation lacks, then downloading them and
 * translating with the real Bergamot engine inside the packaged app.
 *
 * The test profile starts with no translations folder. The app is launched with
 * `PEEK_TRANSLATE_SERVER` (`main/page-translate/model-download.ts remoteSettingsServerFromEnv`)
 * pointing at a local stand-in for Mozilla's Remote Settings server, so nothing leaves the
 * machine. That server offers the es→en model and the engine wasm, serving the files already
 * downloaded into `.tmp/real-download/` (overridden by `PEEK_TRANSLATE_REAL_DIR`); the model
 * files are zstd-compressed here and their records rewritten with the compressed hash and size,
 * as Mozilla serves them. The spec skips when those files are absent.
 *
 * Path covered: `translate page` into English stops with `models-needed`; the translate tile
 * asks main for the size and shows a prompt in its page widget naming the bytes and the engine,
 * with Download / Not now; Not now closes the prompt and fetches nothing; asking again and
 * choosing Download fetches the engine and the model from the local server, and the page is
 * then translated without another click.
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import { setActive, waitOverlayReady, widgetHostState } from '../helpers/hybrid-page';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const REAL_DIR =
  process.env.PEEK_TRANSLATE_REAL_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp/real-download');
const NEEDED = ['models/es-en', 'engine/bergamot-translator', 'engine/records.json', 'records.json'];
const HAVE_FILES = NEEDED.every((p) => fs.existsSync(path.join(REAL_DIR, p)));

const WIDGET_KEY = 'translate:status';
const PAGE_PATH = '/translate-download-page';
const PAGE_HTML =
  '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Página</title></head>' +
  '<body><h1 id="heading">El tiempo está agradable hoy, así que vamos a dar un paseo por el parque.</h1>' +
  '</body></html>';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let base: string;
/** Every path the stand-in server was asked for. */
const requests: string[] = [];
/** Attachment location → bytes served. */
const attachments = new Map<string, Buffer>();
let modelRecords: unknown[] = [];
let engineRecords: unknown[] = [];

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readData(file: string): any[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')).data;
}

/** The es→en records whose files are on disk, rewritten to be served compressed from here. */
function prepareCatalogue(): void {
  const records = readData(path.join(REAL_DIR, 'records.json')).filter((r) => {
    if (r.sourceLanguage !== 'es' || r.targetLanguage !== 'en') return false;
    return fs.existsSync(path.join(REAL_DIR, 'models', 'es-en', r.architecture, r.version, r.fileType));
  });
  modelRecords = records.map((r) => {
    const raw = fs.readFileSync(path.join(REAL_DIR, 'models', 'es-en', r.architecture, r.version, r.fileType));
    const compressed = zlib.zstdCompressSync(raw);
    const location = `models/es-en/${r.fileType}.zst`;
    attachments.set(location, compressed);
    return { ...r, attachment: { ...r.attachment, location, hash: sha256(compressed), size: compressed.length } };
  });
  const engine = readData(path.join(REAL_DIR, 'engine', 'records.json')).filter((r) =>
    fs.existsSync(path.join(REAL_DIR, 'engine', 'bergamot-translator', r.version, 'bergamot-translator.wasm')),
  );
  engineRecords = engine.map((r) => {
    const location = `engine/${r.version}.wasm`;
    attachments.set(location, fs.readFileSync(path.join(REAL_DIR, 'engine', 'bergamot-translator', r.version, 'bergamot-translator.wasm')));
    return { ...r, attachment: { ...r.attachment, location } };
  });
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  requests.push(url);
  if (url === PAGE_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  } else if (url === '/v1/') {
    json(res, { capabilities: { attachments: { base_url: `${base}/att/` } } });
  } else if (url === '/v1/buckets/main/collections/translations-models-v2/records') {
    json(res, { data: modelRecords });
  } else if (url === '/v1/buckets/main/collections/translations-wasm/records') {
    json(res, { data: engineRecords });
  } else if (url.startsWith('/att/') && attachments.has(url.slice('/att/'.length))) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(attachments.get(url.slice('/att/'.length)));
  } else {
    res.writeHead(404);
    res.end();
  }
}

function publishSystemTopic(topic: string, msg: unknown): Promise<void> {
  return app.evaluateMain!(((_e: unknown, arg: { topic: string; msg: unknown }) => {
    (globalThis as any).__peek_test.publishSystemTopic(arg.topic, arg.msg);
  }) as any, { topic, msg });
}

/** Clicks the live widget card's `<peek-button>` for `action`, inside its shadow root. */
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

function attachmentRequests(): string[] {
  return requests.filter((u) => u.startsWith('/att/'));
}

test.describe('Downloading translation models from the page @desktop', () => {
  test.skip(!HAVE_FILES, `engine and es-en models not found in ${REAL_DIR}`);

  test.beforeAll(async () => {
    prepareCatalogue();
    await new Promise<void>((resolve) => {
      server = http.createServer(handle);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
    const profile = `test-smoke-page-translate-download-${Date.now()}`;
    app = await launchDesktopApp(profile, { env: { PEEK_TRANSLATE_SERVER: `${base}/v1` } });
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('asks with the size, fetches nothing on Not now, and downloads then translates on Download', async () => {
    expect(modelRecords.length).toBeGreaterThan(0);
    expect(engineRecords.length).toBeGreaterThan(0);
    const userData = (await app.evaluateMain!(((e: any) => e.app.getPath('userData')) as any)) as string;
    expect(fs.existsSync(path.join(userData, 'translations', 'models'))).toBe(false);

    const opened = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, `${base}${PAGE_PATH}`);
    expect(opened.success).toBe(true);
    const windowId = opened.id as number;
    const page = await app.getWindow(PAGE_PATH.slice(1), 15000);
    await page.waitForLoadState('domcontentloaded');
    const original = await page.evaluate(() => document.getElementById('heading')?.textContent ?? '');
    expect(await setActive(app, { id: windowId, contentWcId: null })).toBe(true);
    await waitOverlayReady(app);

    // ── the translation lacks its models: the widget asks, naming the size ─
    await publishSystemTopic('cmd:execute:translate page', { search: 'en' });
    await expect.poll(widgetBody, { timeout: 15000 }).toContain('data-widget-action="download-models"');
    const prompt = (await widgetBody()) ?? '';
    console.log(`[download-spec] prompt ${prompt}`);
    expect(prompt).toContain('Spanish → English translation model and the translation engine');
    expect(prompt).toMatch(/This fetches \d+\.\d MB \(\d+\.\d MB of it is the engine, fetched once\)/);
    expect(prompt).toContain('data-widget-action="decline-download"');
    expect(attachmentRequests()).toEqual([]);

    // ── Not now closes the prompt and fetches nothing ──────────────────────
    expect(await clickWidgetButton('decline-download')).toBe('clicked');
    await expect.poll(widgetBody, { timeout: 10000 }).toBeNull();
    expect(attachmentRequests()).toEqual([]);

    // ── asked again, Download fetches the engine and model, then translates ─
    await publishSystemTopic('cmd:execute:translate page', { search: 'en' });
    await expect.poll(widgetBody, { timeout: 15000 }).toContain('data-widget-action="download-models"');
    const t0 = Date.now();
    expect(await clickWidgetButton('download-models')).toBe('clicked');
    await expect
      .poll(() => page.evaluate(() => document.getElementById('heading')?.textContent ?? ''), { timeout: 60000 })
      .toMatch(/weather/i);
    console.log(`[download-spec] download and translation ${Date.now() - t0} ms, fetched ${JSON.stringify(attachmentRequests())}`);
    expect(attachmentRequests().length).toBe(modelRecords.length + 1);
    expect(fs.existsSync(path.join(userData, 'translations', 'models', 'es-en'))).toBe(true);
    await expect.poll(widgetBody, { timeout: 10000 }).toContain('data-widget-action="show-original"');

    await publishSystemTopic('cmd:execute:show original', {});
    await expect
      .poll(() => page.evaluate(() => document.getElementById('heading')?.textContent ?? ''), { timeout: 10000 })
      .toBe(original);
  });
});
