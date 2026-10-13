/**
 * Turns a language pair into the `EngineResources` a Bergamot translate message carries: the
 * engine wasm path and each direction's model files, all already on disk.
 *
 * A page translation never downloads. Consent to a download is given in the models manager
 * (`model-topics.ts`), whose prompt names the bytes; a translation whose engine or models are
 * not on disk fails with `models-needed` instead. Files on disk are checked by size first
 * (`estimateDownload`, `EngineProvider.estimate`), then handed to the providers' `ensure`, which
 * verifies their hashes and fetches nothing because they are present.
 *
 * A pair's answer is kept for the session, because hashing ~37 MB of model files for every
 * batch of segments would cost more than the translation. Before a kept answer is reused, every
 * path in it is checked to still exist, so deleting a direction in the models manager makes the
 * next request resolve again (and fail with `models-needed`).
 *
 * Failures are `EngineHostError`s whose message is the code, because the page session reports
 * an engine failure's message as its error and the tile maps codes to text.
 */

import * as fs from 'node:fs';

import { EngineHostError } from './engine-host.js';
import type { EngineProvider } from './engine-files.js';
import { engineStepsFromReady, type EngineResources } from './engine-protocol.js';
import { estimateDownload } from './model-inventory.js';
import type { ModelProvider } from './model-provider.js';

/** The engine or a model the pair needs is not on disk; the models manager downloads it. */
export const MODELS_NEEDED = 'models-needed';
/** No model, direct or through English, translates this pair. */
export const UNSUPPORTED_PAIR = 'unsupported-pair';
/** The engine catalogue holds no engine this build can run. */
export const NO_ENGINE = 'no-engine';

export interface ResourceResolverOptions {
  models: () => Promise<ModelProvider>;
  engine: () => Promise<EngineProvider>;
  /** Defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

export interface ResourceResolver {
  /** The resources translating `from` into `to` needs, or a rejection with one of the codes above. */
  resolve(from: string, to: string, signal?: AbortSignal): Promise<EngineResources>;
  /** Drops every kept answer. */
  forget(): void;
}

function fail(code: string): never {
  throw new EngineHostError(code, code);
}

function paths(resources: EngineResources): string[] {
  return [resources.wasmPath, ...resources.steps.flatMap((s) => Object.values(s.files).filter((p): p is string => typeof p === 'string'))];
}

export function createResourceResolver(opts: ResourceResolverOptions): ResourceResolver {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const kept = new Map<string, EngineResources>();

  async function resolveNow(from: string, to: string, signal?: AbortSignal): Promise<EngineResources> {
    const [models, engine] = await Promise.all([opts.models(), opts.engine()]);
    const plan = await models.plan(from, to, { signal });
    if (!plan.ok) fail(UNSUPPORTED_PAIR);
    const engineState = await engine.estimate({ signal });
    if (!engineState.ok) fail(NO_ENGINE);
    const estimate = await estimateDownload(models.root, plan);
    if (!estimate.ok || estimate.downloadBytes > 0 || engineState.downloadBytes > 0) fail(MODELS_NEEDED);
    const ensuredEngine = await engine.ensure({ signal });
    if (!ensuredEngine.ok) fail(NO_ENGINE);
    const ready = await models.ensure(from, to, { signal });
    if (!ready.ok) fail(UNSUPPORTED_PAIR);
    return { wasmPath: ensuredEngine.path, steps: engineStepsFromReady(ready.steps) };
  }

  return {
    async resolve(from, to, signal) {
      const key = `${from}\u0000${to}`;
      const hit = kept.get(key);
      if (hit && paths(hit).every(exists)) return hit;
      kept.delete(key);
      const resources = await resolveNow(from, to, signal);
      kept.set(key, resources);
      return resources;
    },
    forget() {
      kept.clear();
    },
  };
}
