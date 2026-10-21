/**
 * Download capture — hands a download started in a feature's automated page
 * to that feature as bytes, instead of saving it to the Downloads folder.
 *
 * A feature arms capture for a page window it drives (`automation.downloads`,
 * see page-automation.ts). While armed, every download that window starts is
 * claimed here from the session's `will-download` handler
 * (session-partition.ts): Chromium writes it to a private temp file, and on
 * completion the bytes are read, the temp file is deleted, and the result is
 * queued for the feature, which collects it with `nextDownload`. Nothing is
 * left on disk; where the bytes are kept afterwards is the feature's choice
 * (its own IndexedDB, typically).
 *
 * Electron gives a download no in-memory sink: `DownloadItem.setSavePath` is
 * the only way to receive it, so the temp file is unavoidable. It lives in a
 * per-process directory under the OS temp dir, readable only by the user, for
 * as long as the download is in flight.
 *
 * No Electron import: the download item is typed by the slice used, so this
 * runs under the plain-node unit-test host.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { sanitizeDownloadFilename } from './download-filename.js';

/** The slice of an Electron `DownloadItem` capture uses. */
export interface DownloadItemLike {
  getFilename(): string;
  getMimeType(): string;
  getURL(): string;
  getTotalBytes(): number;
  setSavePath(savePath: string): void;
  cancel(): void;
  once(event: 'done', listener: (event: unknown, state: string) => void): unknown;
}

export interface CapturedDownload {
  name: string;
  mimeType: string;
  url: string;
  size: number;
  bytes: Uint8Array;
}

export type CaptureOutcome =
  | { ok: true; download: CapturedDownload }
  | { ok: false; error: string; name?: string };

/** Downloads larger than this are cancelled rather than handed over IPC. */
export const DEFAULT_MAX_CAPTURE_BYTES = 100 * 1024 * 1024;

interface Waiter {
  resolve: (outcome: CaptureOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Armed {
  queue: CaptureOutcome[];
  waiters: Waiter[];
}

export class DownloadCapture {
  private readonly armed = new Map<number, Armed>();
  private readonly tempDir: () => string;
  private readonly maxBytes: number;

  constructor(opts: { tempDir: () => string; maxBytes?: number }) {
    this.tempDir = opts.tempDir;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  }

  /** Start capturing downloads from the webContents with this id. Idempotent. */
  arm(webContentsId: number): void {
    if (!this.armed.has(webContentsId)) this.armed.set(webContentsId, { queue: [], waiters: [] });
  }

  /**
   * Stop capturing for this webContents. Queued results are dropped and
   * pending waiters resolve with an error. Downloads already claimed still
   * finish and clean up their temp files; their results are discarded.
   */
  disarm(webContentsId: number): void {
    const state = this.armed.get(webContentsId);
    if (!state) return;
    this.armed.delete(webContentsId);
    for (const w of state.waiters) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, error: 'download capture stopped' });
    }
  }

  isArmed(webContentsId: number): boolean {
    return this.armed.has(webContentsId);
  }

  /**
   * Called from `will-download`. Returns false when the originating
   * webContents is not armed, leaving the download to the normal handler.
   * Returns true after taking the download over.
   */
  claim(webContentsId: number, item: DownloadItemLike): boolean {
    const state = this.armed.get(webContentsId);
    if (!state) return false;

    const name = sanitizeDownloadFilename(item.getFilename());
    const mimeType = item.getMimeType() || 'application/octet-stream';
    const url = item.getURL();

    const dir = this.tempDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const savePath = path.join(dir, `${crypto.randomUUID()}-${name}`);
    item.setSavePath(savePath);

    const total = item.getTotalBytes();
    if (total > this.maxBytes) {
      item.cancel();
      this.deliver(webContentsId, { ok: false, name, error: `download is ${total} bytes, over the ${this.maxBytes}-byte capture limit` });
      return true;
    }

    item.once('done', (_event, doneState) => {
      void this.finish(webContentsId, savePath, doneState, { name, mimeType, url });
    });
    return true;
  }

  /**
   * Resolve with the next captured download for this webContents — one
   * already queued, or the next to complete — or an error after `timeoutMs`.
   */
  next(webContentsId: number, timeoutMs: number): Promise<CaptureOutcome> {
    const state = this.armed.get(webContentsId);
    if (!state) return Promise.resolve({ ok: false, error: 'download capture is not on for this window' });
    const queued = state.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<CaptureOutcome>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const idx = state.waiters.indexOf(waiter);
          if (idx >= 0) state.waiters.splice(idx, 1);
          resolve({ ok: false, error: `no download completed within ${timeoutMs} ms` });
        }, timeoutMs),
      };
      state.waiters.push(waiter);
    });
  }

  private async finish(
    webContentsId: number,
    savePath: string,
    doneState: string,
    meta: { name: string; mimeType: string; url: string },
  ): Promise<void> {
    let outcome: CaptureOutcome;
    try {
      if (doneState !== 'completed') {
        outcome = { ok: false, name: meta.name, error: `download ${doneState}` };
      } else {
        const buf = await fs.promises.readFile(savePath);
        outcome = buf.byteLength > this.maxBytes
          ? { ok: false, name: meta.name, error: `download is ${buf.byteLength} bytes, over the ${this.maxBytes}-byte capture limit` }
          : { ok: true, download: { ...meta, size: buf.byteLength, bytes: new Uint8Array(buf) } };
      }
    } catch (err) {
      outcome = { ok: false, name: meta.name, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await fs.promises.rm(savePath, { force: true }).catch(() => {});
    }
    this.deliver(webContentsId, outcome);
  }

  private deliver(webContentsId: number, outcome: CaptureOutcome): void {
    const state = this.armed.get(webContentsId);
    if (!state) return;
    const waiter = state.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(outcome);
    } else {
      state.queue.push(outcome);
    }
  }
}

/** The app's one capture registry; temp files go under the OS temp dir. */
export const downloadCapture = new DownloadCapture({
  tempDir: () => path.join(os.tmpdir(), `peek-download-capture-${process.pid}`),
});
