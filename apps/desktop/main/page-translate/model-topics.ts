/**
 * The pubsub face of the translation models manager, free of Electron so it runs under plain
 * Node. `translate-main.ts` supplies the real pubsub and model provider.
 *
 * Requests and their answers (each answer is a broadcast; the manager view is its one reader):
 * - `translate:models:list {catalogue?}` → `translate:models:listed {installed, available, error}`.
 *   `installed` is every direction on disk with its size. `available` is every direction the
 *   catalogue offers, or null unless `catalogue: true` was asked (reading the catalogue may
 *   contact the server, so a plain list stays local).
 * - `translate:models:estimate {from, to}` → `translate:models:estimated {from, to, ...estimate}`:
 *   the bytes a download would fetch and occupy, for the consent prompt.
 * - `translate:models:download {from, to}` → `translate:models:progress {from, to, phase,
 *   error}` with phase `downloading`, then `done` or `failed`, then a fresh `listed`. A download
 *   request is the consent: the view publishes it only after the user accepted the prompt that
 *   names the size, so main does not ask again.
 * - `translate:models:delete {from, to}` → a fresh `listed`. Deletes one direction's folder.
 */

import { deleteInstalledDirection, estimateDownload, listInstalledDirections } from './model-inventory.js';
import type { ModelProvider } from './model-provider.js';
import { candidatesForPair } from './model-store.js';
import type { TopicPorts } from './translate-topics.js';

export const MODELS_LIST_TOPIC = 'translate:models:list';
export const MODELS_LISTED_TOPIC = 'translate:models:listed';
export const MODELS_ESTIMATE_TOPIC = 'translate:models:estimate';
export const MODELS_ESTIMATED_TOPIC = 'translate:models:estimated';
export const MODELS_DOWNLOAD_TOPIC = 'translate:models:download';
export const MODELS_PROGRESS_TOPIC = 'translate:models:progress';
export const MODELS_DELETE_TOPIC = 'translate:models:delete';

export interface Direction {
  sourceLanguage: string;
  targetLanguage: string;
}

function languageOf(msg: unknown, key: 'from' | 'to'): string | null {
  const v = (msg as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v) ? v : null;
}

function pairOf(msg: unknown): { from: string; to: string } | null {
  const from = languageOf(msg, 'from');
  const to = languageOf(msg, 'to');
  return from && to && from !== to ? { from, to } : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every direction the catalogue has a usable model for, sorted. */
export async function availableDirections(provider: ModelProvider): Promise<Direction[]> {
  const records = await provider.records();
  const seen = new Map<string, Direction>();
  for (const r of records) {
    const key = `${r.sourceLanguage}\u0000${r.targetLanguage}`;
    if (!seen.has(key)) seen.set(key, { sourceLanguage: r.sourceLanguage, targetLanguage: r.targetLanguage });
  }
  return [...seen.values()]
    .filter((d) => candidatesForPair(d.sourceLanguage, d.targetLanguage, records).length > 0)
    .sort((a, b) => a.sourceLanguage.localeCompare(b.sourceLanguage) || a.targetLanguage.localeCompare(b.targetLanguage));
}

/**
 * Subscribes the manager's request topics. `models` yields the provider (built lazily in main).
 * Returns a function that unsubscribes them, and `idle()` for tests: settles once every
 * request handled so far has answered.
 */
export function installModelTopics(models: () => Promise<ModelProvider>, ports: TopicPorts): { dispose(): void; idle(): Promise<void> } {
  const pending = new Set<Promise<void>>();
  function track(work: Promise<void>): void {
    const p = work.catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  }

  async function publishList(catalogue: boolean): Promise<void> {
    let installed: Awaited<ReturnType<typeof listInstalledDirections>> = [];
    let available: Direction[] | null = null;
    let error: string | null = null;
    try {
      const provider = await models();
      installed = await listInstalledDirections(provider.root);
      if (catalogue) available = await availableDirections(provider);
    } catch (err) {
      error = errorText(err);
    }
    ports.publish(MODELS_LISTED_TOPIC, { installed, available, error });
  }

  ports.subscribe(MODELS_LIST_TOPIC, (msg) => {
    track(publishList((msg as { catalogue?: unknown } | null)?.catalogue === true));
  });

  ports.subscribe(MODELS_ESTIMATE_TOPIC, (msg) => {
    const pair = pairOf(msg);
    if (!pair) return;
    track(
      (async () => {
        try {
          const provider = await models();
          const estimate = await estimateDownload(provider.root, await provider.plan(pair.from, pair.to));
          ports.publish(MODELS_ESTIMATED_TOPIC, { ...pair, ...estimate });
        } catch (err) {
          ports.publish(MODELS_ESTIMATED_TOPIC, { ...pair, ok: false, reason: 'error', error: errorText(err) });
        }
      })(),
    );
  });

  ports.subscribe(MODELS_DOWNLOAD_TOPIC, (msg) => {
    const pair = pairOf(msg);
    if (!pair) return;
    track(
      (async () => {
        ports.publish(MODELS_PROGRESS_TOPIC, { ...pair, phase: 'downloading', error: null });
        try {
          const result = await (await models()).ensure(pair.from, pair.to);
          ports.publish(MODELS_PROGRESS_TOPIC, result.ok ? { ...pair, phase: 'done', error: null } : { ...pair, phase: 'failed', error: result.reason });
        } catch (err) {
          ports.publish(MODELS_PROGRESS_TOPIC, { ...pair, phase: 'failed', error: errorText(err) });
        }
        await publishList(false);
      })(),
    );
  });

  ports.subscribe(MODELS_DELETE_TOPIC, (msg) => {
    const pair = pairOf(msg);
    if (!pair) return;
    track(
      (async () => {
        try {
          await deleteInstalledDirection((await models()).root, pair.from, pair.to);
        } finally {
          await publishList(false);
        }
      })(),
    );
  });

  return {
    dispose() {
      for (const topic of [MODELS_LIST_TOPIC, MODELS_ESTIMATE_TOPIC, MODELS_DOWNLOAD_TOPIC, MODELS_DELETE_TOPIC]) ports.unsubscribe(topic);
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
