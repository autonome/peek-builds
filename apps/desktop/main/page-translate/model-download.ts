/**
 * Downloading translation model files into the on-disk cache.
 *
 * Records and attachments come from Mozilla's Remote Settings servers. The only address
 * written down is the server base, `DEFAULT_REMOTE_SETTINGS_SERVER`; the attachment host is
 * read from the server root's `capabilities.attachments.base_url`, as Firefox does. A mirror
 * that serves the same API replaces both by passing its own `server`.
 *
 * Every attachment is checked against the record's `attachment.hash`/`size` before it is
 * decompressed (zstd), and the decompressed bytes against `decompressedHash`/`decompressedSize`
 * before they are written. Writes go to `<file>.tmp` and are renamed into place, so an
 * interrupted download or a bad hash never leaves a file at the final path.
 *
 * `fetch` is injected: main passes Electron's `net.fetch`, tests pass a fake.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

import { cachePath, verifyAttachment, verifyDecompressed, type ModelRecord, type PairPlan } from './model-store.js';

/** Mozilla's Remote Settings server. Override with `DownloadOptions.server` for a mirror. */
export const DEFAULT_REMOTE_SETTINGS_SERVER = 'https://firefox.settings.services.mozilla.com/v1';
export const MODELS_COLLECTION = 'translations-models-v2';
const BUCKET = 'main';

/** The part of the Fetch API used here; `net.fetch` and global `fetch` both satisfy it. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

export interface ServerOptions {
  fetch: FetchLike;
  /** Remote Settings base, ending in `/v1`. Defaults to `DEFAULT_REMOTE_SETTINGS_SERVER`. */
  server?: string;
  signal?: AbortSignal;
}

export interface DownloadOptions extends ServerOptions {
  /** Translations cache root, `<userData>/translations`. */
  root: string;
  /** Attachment base URL; read from the server root when absent. */
  attachmentBase?: string;
}

export type ModelDownloadErrorCode =
  | 'http'
  | 'bad-response'
  | 'unsafe-location'
  | 'attachment-mismatch'
  | 'decompress-failed'
  | 'decompressed-mismatch';

export class ModelDownloadError extends Error {
  constructor(
    readonly code: ModelDownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

const zstdDecompress = promisify(zlib.zstdDecompress);

function serverBase(options: ServerOptions): string {
  return (options.server ?? DEFAULT_REMOTE_SETTINGS_SERVER).replace(/\/+$/, '');
}

async function getOk(options: ServerOptions, url: string): Promise<FetchResponseLike> {
  const res = await options.fetch(url, { signal: options.signal });
  if (!res.ok) throw new ModelDownloadError('http', `HTTP ${res.status} for ${url}`);
  return res;
}

/** The attachment host the server names in `capabilities.attachments.base_url`. */
export async function fetchAttachmentBase(options: ServerOptions): Promise<string> {
  const url = `${serverBase(options)}/`;
  const body = (await (await getOk(options, url)).json()) as { capabilities?: { attachments?: { base_url?: unknown } } };
  const base = body?.capabilities?.attachments?.base_url;
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) {
    throw new ModelDownloadError('bad-response', `no attachments base_url at ${url}`);
  }
  return base.endsWith('/') ? base : `${base}/`;
}

/** Every record of the models collection, as served. */
export async function fetchModelRecords(options: ServerOptions): Promise<ModelRecord[]> {
  const url = `${serverBase(options)}/buckets/${BUCKET}/collections/${MODELS_COLLECTION}/records`;
  const body = (await (await getOk(options, url)).json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new ModelDownloadError('bad-response', `no data array at ${url}`);
  return body.data as ModelRecord[];
}

/**
 * The attachment URL for a record. `location` comes from the network, so it must be a plain
 * relative path that stays under the attachment base.
 */
export function attachmentUrl(attachmentBase: string, record: Pick<ModelRecord, 'attachment'>): string {
  const location = record.attachment?.location;
  if (
    typeof location !== 'string' ||
    location === '' ||
    location.startsWith('/') ||
    location.includes('\\') ||
    location.split('/').some((seg) => seg === '..' || seg === '.') ||
    /^[a-z][a-z0-9+.-]*:/i.test(location)
  ) {
    throw new ModelDownloadError('unsafe-location', `unsafe attachment location: ${String(location)}`);
  }
  const url = new URL(location, attachmentBase);
  if (!url.href.startsWith(attachmentBase)) {
    throw new ModelDownloadError('unsafe-location', `attachment location leaves the base: ${location}`);
  }
  return url.href;
}

async function readIfValid(file: string, record: ModelRecord): Promise<boolean> {
  try {
    const data = await fs.promises.readFile(file);
    return verifyDecompressed(data, record);
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, data: Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

export interface DownloadResult {
  path: string;
  /** False when a valid file was already in the cache and nothing was fetched. */
  downloaded: boolean;
}

/**
 * Make one model file present and valid in the cache: reuse it when the cached bytes match the
 * record, otherwise fetch, verify, decompress, verify again, and write it in place.
 */
export async function downloadModelFile(record: ModelRecord, options: DownloadOptions): Promise<DownloadResult> {
  return downloadOne(record, options, lazyAttachmentBase(options));
}

function lazyAttachmentBase(options: DownloadOptions): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => (pending ??= options.attachmentBase !== undefined ? Promise.resolve(options.attachmentBase) : fetchAttachmentBase(options));
}

async function downloadOne(record: ModelRecord, options: DownloadOptions, getBase: () => Promise<string>): Promise<DownloadResult> {
  const target = cachePath(options.root, record);
  if (await readIfValid(target, record)) return { path: target, downloaded: false };

  const base = await getBase();
  const url = attachmentUrl(base, record);
  const compressed = new Uint8Array(await (await getOk(options, url)).arrayBuffer());
  if (!verifyAttachment(compressed, record)) {
    throw new ModelDownloadError('attachment-mismatch', `downloaded ${record.attachment.filename} does not match its record`);
  }
  let data: Uint8Array;
  try {
    data = await zstdDecompress(compressed);
  } catch (err) {
    throw new ModelDownloadError('decompress-failed', `zstd decompress of ${record.attachment.filename} failed: ${(err as Error).message}`);
  }
  if (!verifyDecompressed(data, record)) {
    throw new ModelDownloadError('decompressed-mismatch', `decompressed ${record.attachment.filename} does not match its record`);
  }
  await writeAtomic(target, data);
  return { path: target, downloaded: true };
}

/** Every file of one model, one after another; the attachment base is fetched at most once. */
export async function downloadPair(plan: PairPlan, options: DownloadOptions): Promise<Partial<Record<keyof PairPlan['files'], string>>> {
  const getBase = lazyAttachmentBase(options);
  const out: Partial<Record<keyof PairPlan['files'], string>> = {};
  for (const [type, record] of Object.entries(plan.files) as Array<[keyof PairPlan['files'], ModelRecord]>) {
    if (!record) continue;
    out[type] = (await downloadOne(record, options, getBase)).path;
  }
  return out;
}

/** `<root>/records.json`: the last catalogue fetched, for offline use. */
export function recordsCachePath(root: string): string {
  return path.join(root, 'records.json');
}

export async function writeRecordsCache(root: string, records: readonly ModelRecord[]): Promise<void> {
  await writeAtomic(recordsCachePath(root), Buffer.from(JSON.stringify({ data: records })));
}

/** The cached catalogue, or null when absent or unreadable. */
export async function readRecordsCache(root: string): Promise<ModelRecord[] | null> {
  try {
    const body = JSON.parse(await fs.promises.readFile(recordsCachePath(root), 'utf8')) as { data?: unknown };
    return Array.isArray(body?.data) ? (body.data as ModelRecord[]) : null;
  } catch {
    return null;
  }
}
