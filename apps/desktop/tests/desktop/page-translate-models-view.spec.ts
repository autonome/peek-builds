/**
 * The translation models view (`features/translate/models.html`), opened through its
 * `manage translation models` command in the packaged app.
 *
 * The test profile starts with no translations folder. The app is launched with
 * `PEEK_TRANSLATE_SERVER` (`main/page-translate/model-download.ts remoteSettingsServerFromEnv`)
 * pointing at a local stand-in for Mozilla's Remote Settings server, so nothing leaves the
 * machine. That server offers the es→en and en→de models and the engine wasm, serving the files
 * already downloaded into `.tmp/real-download/` (overridden by `PEEK_TRANSLATE_REAL_DIR`); the
 * model files are zstd-compressed here and their records rewritten with the compressed hash and
 * size, as Mozilla serves them. The spec skips when those files are absent.
 *
 * Path covered: the command opens the view; the view lists nothing on the device and both
 * catalogue directions as downloadable; Download asks first, naming the bytes and the engine;
 * Cancel closes the prompt and fetches nothing; Download in the prompt fetches the engine and the
 * model, and the direction moves to "On this device" with its size; Delete removes its folder and
 * moves it back to the downloadable list.
 */

import { test, expect, DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady } from '../helpers/window-utils';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const REAL_DIR =
  process.env.PEEK_TRANSLATE_REAL_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp/real-download');
const DIRECTIONS = ['es-en', 'en-de'];
const NEEDED = [...DIRECTIONS.map((d) => `models/${d}`), 'engine/bergamot-translator', 'engine/records.json', 'records.json'];
const HAVE_FILES = NEEDED.every((p) => fs.existsSync(path.join(REAL_DIR, p)));

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let base: string;
/** Every path the stand-in server was asked for. */
const requests: string[] = [];
/** Attachment location → bytes served. */
const attachments = new Map<string, Buffer>();
let modelRecords: any[] = [];
let engineRecords: unknown[] = [];

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readData(file: string): any[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')).data;
}

/** The records of `DIRECTIONS` whose files are on disk, rewritten to be served compressed from here. */
function prepareCatalogue(): void {
  const records = readData(path.join(REAL_DIR, 'records.json')).filter((r) => {
    const dir = `${r.sourceLanguage}-${r.targetLanguage}`;
    if (!DIRECTIONS.includes(dir)) return false;
    return fs.existsSync(path.join(REAL_DIR, 'models', dir, r.architecture, r.version, r.fileType));
  });
  modelRecords = records.map((r) => {
    const dir = `${r.sourceLanguage}-${r.targetLanguage}`;
    const raw = fs.readFileSync(path.join(REAL_DIR, 'models', dir, r.architecture, r.version, r.fileType));
    const compressed = zlib.zstdCompressSync(raw);
    const location = `models/${dir}/${r.fileType}.zst`;
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
  if (url === '/v1/') {
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

function attachmentRequests(): string[] {
  return requests.filter((u) => u.startsWith('/att/'));
}

/** The labels of the rows in one section of the view, in order. */
function rowLabels(view: Page, section: 'installed' | 'available'): Promise<string[]> {
  return view.evaluate(
    (s) => Array.from(document.querySelectorAll(`.${s}-rows .row-label`)).map((e) => e.textContent ?? ''),
    section,
  );
}

function rowDetail(view: Page, section: 'installed' | 'available', from: string): Promise<string> {
  return view.evaluate(
    ([s, f]) => {
      const button = document.querySelector(`.${s}-rows peek-button[data-from="${f}"]`);
      return button?.closest('.row')?.querySelector('.row-detail')?.textContent ?? '';
    },
    [section, from] as const,
  );
}

function promptOpen(view: Page): Promise<boolean> {
  return view.evaluate(() => (document.querySelector('.download-prompt') as any)?.open === true);
}

test.describe('Translation models view @desktop', () => {
  test.skip(!HAVE_FILES, `engine and es-en/en-de models not found in ${REAL_DIR}`);

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
    const profile = `test-smoke-page-translate-models-view-${Date.now()}`;
    app = await launchDesktopApp(profile, { env: { PEEK_TRANSLATE_SERVER: `${base}/v1` } });
    bgWindow = await app.getBackgroundWindow();
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('lists, asks with the size, cancels, downloads and deletes', async () => {
    expect(modelRecords.length).toBeGreaterThan(0);
    expect(engineRecords.length).toBeGreaterThan(0);
    const userData = (await app.evaluateMain!(((e: any) => e.app.getPath('userData')) as any)) as string;
    const esEnDir = path.join(userData, 'translations', 'models', 'es-en');
    expect(fs.existsSync(path.join(userData, 'translations', 'models'))).toBe(false);

    // ── the command opens the view, which lists the catalogue ──────────────
    await publishSystemTopic('cmd:execute:manage translation models', {});
    const view = await app.getWindow('translate/models.html', 15000);
    await view.waitForLoadState('domcontentloaded');
    await expect.poll(() => rowLabels(view, 'available'), { timeout: 15000 }).toEqual(['English → German', 'Spanish → English']);
    expect(await rowLabels(view, 'installed')).toEqual([]);
    expect(await view.evaluate(() => document.querySelector('.installed-rows .empty')?.textContent ?? '')).toContain(
      'No translation models are on this device yet.',
    );
    expect(await view.evaluate(() => (document.querySelector('.status') as HTMLElement).hidden)).toBe(true);
    expect(attachmentRequests()).toEqual([]);

    // ── Download asks first, naming the bytes and the engine ───────────────
    await view.locator('.available-rows peek-button[data-action="download"][data-from="es"]').click();
    await expect.poll(() => promptOpen(view), { timeout: 15000 }).toBe(true);
    const prompt = await view.evaluate(() => document.querySelector('.prompt-text')?.textContent ?? '');
    console.log(`[models-view-spec] prompt ${prompt}`);
    expect(prompt).toContain('Download the Spanish → English translation model and the translation engine from Mozilla?');
    expect(prompt).toMatch(/This fetches \d+\.\d MB \(\d+\.\d MB of it is the engine, fetched once\)/);
    expect(attachmentRequests()).toEqual([]);

    // ── Cancel closes the prompt and fetches nothing ───────────────────────
    await view.locator('.prompt-cancel').click();
    await expect.poll(() => promptOpen(view), { timeout: 5000 }).toBe(false);
    await expect.poll(() => rowDetail(view, 'available', 'es'), { timeout: 5000 }).toBe('');
    expect(attachmentRequests()).toEqual([]);
    expect(fs.existsSync(esEnDir)).toBe(false);

    // ── Download in the prompt fetches the engine and the model ────────────
    await view.locator('.available-rows peek-button[data-action="download"][data-from="es"]').click();
    await expect.poll(() => promptOpen(view), { timeout: 15000 }).toBe(true);
    const t0 = Date.now();
    await view.locator('.prompt-accept').click();
    await expect.poll(() => rowLabels(view, 'installed'), { timeout: 60000 }).toEqual(['Spanish → English']);
    console.log(`[models-view-spec] download ${Date.now() - t0} ms, fetched ${JSON.stringify(attachmentRequests())}`);
    const esEnRecords = modelRecords.filter((r) => r.sourceLanguage === 'es').length;
    expect(attachmentRequests().length).toBe(esEnRecords + 1);
    expect(fs.existsSync(esEnDir)).toBe(true);
    await expect.poll(() => rowDetail(view, 'installed', 'es'), { timeout: 5000 }).toMatch(/^\d+\.\d MB$/);
    expect(await rowLabels(view, 'available')).toEqual(['English → German']);
    expect(await view.evaluate(() => document.querySelector('.total')?.textContent ?? '')).toMatch(/^\d+\.\d MB$/);

    // ── Delete removes the folder and offers the direction again ───────────
    await view.locator('.installed-rows peek-button[data-action="delete"][data-from="es"]').click();
    await expect.poll(() => rowLabels(view, 'installed'), { timeout: 15000 }).toEqual([]);
    expect(fs.existsSync(esEnDir)).toBe(false);
    expect(await rowLabels(view, 'available')).toEqual(['English → German', 'Spanish → English']);
    expect(attachmentRequests().length).toBe(esEnRecords + 1);
  });
});
