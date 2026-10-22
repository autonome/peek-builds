/**
 * Unit tests for download capture (download-capture.ts): a download from an
 * armed webContents is claimed, its bytes are handed over with name and MIME
 * type, and its temp file is gone afterwards; an unarmed one is left to the
 * normal Downloads-folder handler. The fake item stands in for Electron's
 * DownloadItem: the test writes the file Chromium would have written to the
 * save path, then emits `done`.
 *
 * Also covers the download ops' gate and plumbing in page-automation.ts.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DownloadCapture, type DownloadItemLike } from './download-capture.js';
import { checkAutomationAllowed, runAutomationOp, tileWindowSource, type AutomationTarget } from './page-automation.js';
import { resolveCapabilities, validateTileManifest, type CapabilityGrant } from './tile-manifest.js';

class FakeItem extends EventEmitter implements DownloadItemLike {
  savePath = '';
  cancelled = false;
  constructor(private readonly name: string, private readonly mime: string, private readonly total = 4) { super(); }
  getFilename() { return this.name; }
  getMimeType() { return this.mime; }
  getURL() { return `https://files.example/${this.name}`; }
  getTotalBytes() { return this.total; }
  setSavePath(p: string) { this.savePath = p; }
  cancel() { this.cancelled = true; }
  /** What Chromium does: write the file, then report the final state. */
  complete(bytes: Uint8Array, state = 'completed') {
    if (state === 'completed') fs.writeFileSync(this.savePath, bytes);
    this.emit('done', {}, state);
  }
}

let tmp: string;
let capture: DownloadCapture;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'download-capture-test-'));
  capture = new DownloadCapture({ tempDir: () => path.join(tmp, 'capture'), maxBytes: 16 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('DownloadCapture', () => {
  it('leaves downloads from an unarmed webContents to the normal handler', () => {
    const item = new FakeItem('statement.csv', 'text/csv');
    assert.strictEqual(capture.claim(7, item), false);
    assert.strictEqual(item.savePath, '');
  });

  it('hands a completed download over as bytes and deletes its temp file', async () => {
    capture.arm(7);
    const item = new FakeItem('statement.csv', 'text/csv');
    assert.strictEqual(capture.claim(7, item), true);
    assert.ok(item.savePath.startsWith(path.join(tmp, 'capture')));

    const pending = capture.next(7, 1000);
    item.complete(new Uint8Array([1, 2, 3, 4]));
    const outcome = await pending;

    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    assert.strictEqual(outcome.download.name, 'statement.csv');
    assert.strictEqual(outcome.download.mimeType, 'text/csv');
    assert.strictEqual(outcome.download.url, 'https://files.example/statement.csv');
    assert.strictEqual(outcome.download.size, 4);
    assert.deepStrictEqual(Array.from(outcome.download.bytes), [1, 2, 3, 4]);
    assert.strictEqual(fs.existsSync(item.savePath), false);
  });

  it('queues a download that completes before anyone waits', async () => {
    capture.arm(7);
    const item = new FakeItem('a.pdf', '');
    capture.claim(7, item);
    item.complete(new Uint8Array([9]));
    // Let the read-and-delete finish.
    await new Promise(r => setTimeout(r, 50));
    const outcome = await capture.next(7, 10);
    assert.ok(outcome.ok);
    assert.strictEqual(outcome.ok && outcome.download.mimeType, 'application/octet-stream');
  });

  it('reports interrupted downloads and times out with nothing pending', async () => {
    capture.arm(7);
    const item = new FakeItem('b.pdf', 'application/pdf');
    capture.claim(7, item);
    const pending = capture.next(7, 1000);
    item.complete(new Uint8Array(), 'interrupted');
    assert.deepStrictEqual(await pending, { ok: false, name: 'b.pdf', error: 'download interrupted' });
    const empty = await capture.next(7, 20);
    assert.strictEqual(empty.ok, false);
  });

  it('cancels a download over the size limit', async () => {
    capture.arm(7);
    const item = new FakeItem('huge.zip', 'application/zip', 1000);
    assert.strictEqual(capture.claim(7, item), true);
    assert.strictEqual(item.cancelled, true);
    const outcome = await capture.next(7, 10);
    assert.strictEqual(outcome.ok, false);
  });

  it('keeps a hostile filename inside the capture directory', () => {
    capture.arm(7);
    const item = new FakeItem('../../escape.csv', 'text/csv');
    capture.claim(7, item);
    assert.strictEqual(path.dirname(item.savePath), path.join(tmp, 'capture'));
  });

  it('disarm resolves pending waiters and stops claiming', async () => {
    capture.arm(7);
    const pending = capture.next(7, 1000);
    capture.disarm(7);
    assert.deepStrictEqual(await pending, { ok: false, error: 'download capture stopped' });
    assert.strictEqual(capture.claim(7, new FakeItem('c.csv', 'text/csv')), false);
  });
});

describe('download ops through page automation', () => {
  const own = tileWindowSource('fixture');
  const grant = (downloads: boolean): CapabilityGrant => resolveCapabilities(
    'fixture',
    { automation: { origins: ['https://bank.example'], ...(downloads ? { downloads: true } : {}) } } as never,
    false,
  ) as CapabilityGrant;

  it('the manifest flag validates and is granted to a non-builtin feature', () => {
    const manifest = (automation: unknown) => ({
      id: 'fixture', name: 'Fixture', manifestVersion: 3,
      tiles: [{ id: 'main', url: 'peek://fixture/main.html' }],
      capabilities: { automation },
    });
    assert.deepStrictEqual(validateTileManifest(manifest({ origins: ['https://bank.example'], downloads: true })), []);
    assert.ok(validateTileManifest(manifest({ origins: ['https://bank.example'], downloads: 'yes' })).length > 0);
    assert.strictEqual(grant(true).capabilities.automation?.downloads, true);
  });

  it('needs automation.downloads, but not an allowed page origin', () => {
    const op = { op: 'captureDownloads', enabled: true } as const;
    const onCdn = { windowSource: own, currentUrl: 'https://cdn.other.example/file' };
    assert.strictEqual(checkAutomationAllowed(grant(false), op, onCdn).ok, false);
    assert.strictEqual(checkAutomationAllowed(grant(true), op, onCdn).ok, true);
    assert.strictEqual(checkAutomationAllowed(grant(true), op, { ...onCdn, windowSource: tileWindowSource('other') }).ok, false);
  });

  it('captureDownloads arms the window and nextDownload returns the bytes', async () => {
    const target: AutomationTarget = {
      getURL: () => 'https://bank.example/statements',
      getTitle: () => 'Statements',
      isDestroyed: () => false,
      loadURL: async () => {},
      executeJavaScript: async () => undefined,
      printToPDF: async () => new Uint8Array(),
    };
    const downloads = {
      setEnabled: (on: boolean) => (on ? capture.arm(3) : capture.disarm(3)),
      next: (ms: number) => capture.next(3, ms),
    };
    assert.strictEqual((await runAutomationOp(target, { op: 'captureDownloads', enabled: true }, downloads)).ok, true);
    const item = new FakeItem('q1.csv', 'text/csv');
    assert.strictEqual(capture.claim(3, item), true);
    const pending = runAutomationOp(target, { op: 'nextDownload', timeoutMs: 1000 }, downloads);
    item.complete(new Uint8Array([7, 7]));
    const r = await pending;
    assert.ok(r.ok);
    assert.deepStrictEqual(r.ok && r.download && Array.from(r.download.bytes), [7, 7]);
  });
});
