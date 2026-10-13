/**
 * The translation engine's wasm binary, made present on disk.
 *
 * The engine is Firefox's build of Bergamot, published in Mozilla's Remote Settings
 * collection `translations-wasm` as records named `bergamot-translator`. Only the wasm comes
 * from there; its Emscripten glue is part of Firefox's source tree, not of the collection, and
 * the glue's API changes with the record's major version (v3 is bergamot v0.6.0, whose
 * `TranslationModel` takes the language pair first). So the engine accepts only records of
 * `SUPPORTED_ENGINE_MAJOR_VERSION` and takes the newest of those.
 *
 * Cache: `<root>/engine/records.json` (the last records fetched, for offline use) and
 * `<root>/engine/bergamot-translator/<version>/bergamot-translator.wasm`. The record list is
 * fetched once per session, as for the models (`model-provider.ts`); when the server cannot be
 * reached the cached list is used, so an engine already on disk keeps working offline.
 *
 * `fetch` and `root` are injected, as for `model-provider.ts`; the server base stays in
 * `model-download.ts DEFAULT_REMOTE_SETTINGS_SERVER`.
 */

import * as path from 'node:path';

import {
  downloadEngineFile,
  fetchEngineRecords,
  readEngineRecordsCache,
  writeEngineRecordsCache,
  type FetchLike,
} from './model-download.js';
import { DEFAULT_CATALOGUE_ENV, parseModelVersion, compareModelVersions, recordApplies, type CatalogueEnv, type ModelRecordAttachment } from './model-store.js';

export const ENGINE_RECORD_NAME = 'bergamot-translator';
/** The `translations-wasm` major version whose API the engine's glue speaks. */
export const SUPPORTED_ENGINE_MAJOR_VERSION = 3;
/** File name of the cached wasm; fixed here rather than taken from the network. */
export const ENGINE_WASM_FILE = 'bergamot-translator.wasm';

/** One record of `translations-wasm`, as served (unknown extra fields are ignored). */
export interface EngineRecord {
  id: string;
  name: string;
  version: string;
  release?: string;
  filter_expression?: string;
  attachment: ModelRecordAttachment;
  last_modified?: number;
}

/** The newest `bergamot-translator` record of the supported major version that applies here, or null. */
export function resolveEngineRecord(
  records: readonly EngineRecord[],
  env: CatalogueEnv = DEFAULT_CATALOGUE_ENV,
  major = SUPPORTED_ENGINE_MAJOR_VERSION,
): EngineRecord | null {
  let best: EngineRecord | null = null;
  for (const r of records) {
    if (r?.name !== ENGINE_RECORD_NAME || typeof r.version !== 'string' || !r.attachment) continue;
    const v = parseModelVersion(r.version);
    if (!v || v.major !== major) continue;
    if (!recordApplies(r, env)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const order = compareModelVersions(r.version, best.version);
    if (order > 0 || (order === 0 && (r.last_modified ?? 0) > (best.last_modified ?? 0))) best = r;
  }
  return best;
}

/** `<root>/engine/bergamot-translator/<version>/bergamot-translator.wasm`; the version comes from the network, so it is checked. */
export function engineCachePath(root: string, record: Pick<EngineRecord, 'version'>): string {
  if (!parseModelVersion(record.version)) throw new Error(`unsafe engine version: ${record.version}`);
  return path.join(root, 'engine', ENGINE_RECORD_NAME, record.version, ENGINE_WASM_FILE);
}

export interface EngineFile {
  path: string;
  record: EngineRecord;
  /** False when a valid file was already in the cache and nothing was fetched. */
  downloaded: boolean;
}

export type EnsureEngineResult = ({ ok: true } & EngineFile) | { ok: false; reason: 'no-engine' };

export interface EngineProviderOptions {
  fetch: FetchLike;
  /** Translations cache root, `<userData>/translations`. */
  root: string;
  /** Remote Settings base; defaults to `model-download.ts DEFAULT_REMOTE_SETTINGS_SERVER`. */
  server?: string;
  env?: CatalogueEnv;
}

export interface EngineProvider {
  /** The `translations-wasm` records: memory, else the server (cached to disk), else the disk cache. */
  records(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<EngineRecord[]>;
  /** Resolve and download the engine wasm; concurrent calls share one download. */
  ensure(options?: { signal?: AbortSignal }): Promise<EnsureEngineResult>;
}

export function createEngineProvider(options: EngineProviderOptions): EngineProvider {
  let cached: EngineRecord[] | null = null;
  let loading: Promise<EngineRecord[]> | null = null;
  let inflight: Promise<EnsureEngineResult> | null = null;

  async function load(signal?: AbortSignal): Promise<EngineRecord[]> {
    try {
      const fresh = await fetchEngineRecords({ fetch: options.fetch, server: options.server, signal });
      await writeEngineRecordsCache(options.root, fresh);
      return fresh;
    } catch (err) {
      if (signal?.aborted) throw err;
      const fallback = await readEngineRecordsCache(options.root);
      if (fallback) return fallback;
      throw err;
    }
  }

  async function records(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<EngineRecord[]> {
    if (cached && !opts.refresh) return cached;
    if (!loading) {
      loading = load(opts.signal).finally(() => {
        loading = null;
      });
    }
    cached = await loading;
    return cached;
  }

  async function ensureNow(signal?: AbortSignal): Promise<EnsureEngineResult> {
    const record = resolveEngineRecord(await records({ signal }), options.env);
    if (!record) return { ok: false, reason: 'no-engine' };
    const target = engineCachePath(options.root, record);
    const { downloaded } = await downloadEngineFile(record, target, { fetch: options.fetch, server: options.server, root: options.root, signal });
    return { ok: true, path: target, record, downloaded };
  }

  function ensure(opts: { signal?: AbortSignal } = {}): Promise<EnsureEngineResult> {
    if (!inflight) {
      inflight = ensureNow(opts.signal).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return { records, ensure };
}
