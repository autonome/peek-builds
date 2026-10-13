/**
 * The models a translation needs, made present on disk.
 *
 * `createModelProvider` holds the catalogue for the session and turns a language pair into
 * cached model files: it resolves the plan (`model-store.ts resolvePlan`, pivoting through
 * English when there is no direct model) and downloads every file of every step
 * (`model-download.ts downloadPair`). It never asks the user anything; whoever calls `ensure`
 * has already obtained consent for the download.
 *
 * Catalogue policy: fetched from the server once per session and written to `records.json`;
 * when the server cannot be reached, the last `records.json` is used, so pairs already on disk
 * keep working offline. `records({refresh: true})` fetches again.
 *
 * `fetch` and `root` are injected: main passes Electron's `net.fetch` and
 * `<userData>/translations` (`translate-main.ts`), tests pass a fake and a temp directory.
 */

import {
  downloadPair,
  fetchModelRecords,
  readRecordsCache,
  writeRecordsCache,
  type DownloadOptions,
  type FetchLike,
} from './model-download.js';
import { resolvePlan, type ModelFileType, type ModelRecord, type PairPlan, type ResolveOptions, type TranslationPlan } from './model-store.js';

export interface ModelProviderOptions {
  fetch: FetchLike;
  /** Translations cache root, `<userData>/translations`. */
  root: string;
  /** Remote Settings base; defaults to `model-download.ts DEFAULT_REMOTE_SETTINGS_SERVER`. */
  server?: string;
  resolve?: ResolveOptions;
}

/** One step of a translation with the paths of its files on disk. */
export interface ReadyStep {
  plan: PairPlan;
  files: Partial<Record<ModelFileType, string>>;
}

export type EnsureResult = { ok: true; steps: ReadyStep[] } | Exclude<TranslationPlan, { ok: true }>;

export interface ModelProvider {
  /** The translations cache root the provider downloads into. */
  readonly root: string;
  /** The catalogue: memory, else the server (cached to disk), else the disk cache. */
  records(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<ModelRecord[]>;
  /** Which models translating `from` into `to` needs, without downloading anything. */
  plan(from: string, to: string, options?: { signal?: AbortSignal }): Promise<TranslationPlan>;
  /** Resolve and download every file `from` → `to` needs; concurrent calls for one pair share the work. */
  ensure(from: string, to: string, options?: { signal?: AbortSignal }): Promise<EnsureResult>;
}

export function createModelProvider(options: ModelProviderOptions): ModelProvider {
  let cached: ModelRecord[] | null = null;
  let loading: Promise<ModelRecord[]> | null = null;
  const inflight = new Map<string, Promise<EnsureResult>>();

  async function load(signal?: AbortSignal): Promise<ModelRecord[]> {
    try {
      const fresh = await fetchModelRecords({ fetch: options.fetch, server: options.server, signal });
      await writeRecordsCache(options.root, fresh);
      return fresh;
    } catch (err) {
      if (signal?.aborted) throw err;
      const fallback = await readRecordsCache(options.root);
      if (fallback) return fallback;
      throw err;
    }
  }

  async function records(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelRecord[]> {
    if (cached && !opts.refresh) return cached;
    if (!loading) {
      loading = load(opts.signal).finally(() => {
        loading = null;
      });
    }
    cached = await loading;
    return cached;
  }

  async function plan(from: string, to: string, opts: { signal?: AbortSignal } = {}): Promise<TranslationPlan> {
    return resolvePlan(from, to, await records({ signal: opts.signal }), options.resolve);
  }

  async function ensureNow(from: string, to: string, signal?: AbortSignal): Promise<EnsureResult> {
    const resolved = await plan(from, to, { signal });
    if (!resolved.ok) return resolved;
    const download: DownloadOptions = { fetch: options.fetch, server: options.server, root: options.root, signal };
    const steps: ReadyStep[] = [];
    for (const step of resolved.steps) {
      steps.push({ plan: step, files: await downloadPair(step, download) });
    }
    return { ok: true, steps };
  }

  function ensure(from: string, to: string, opts: { signal?: AbortSignal } = {}): Promise<EnsureResult> {
    const key = `${from}\u0000${to}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = ensureNow(from, to, opts.signal).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  return { root: options.root, records, plan, ensure };
}
