// Sentence embedder for the grouper's text-similarity signal. The library is loaded
// with a dynamic import only when the signal is on, so --no-embed and the tests
// need neither the install nor the model download.

import os from 'node:os';
import path from 'node:path';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Default model cache: outside the repository, under the user's cache directory. */
export function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'background-grouper', 'models');
}

/**
 * Returns `async (texts: string[]) => Float32Array[]` of normalized sentence embeddings
 * (mean pooled), one per text.
 */
export async function createEmbedder({ cacheDir = defaultCacheDir(), model = MODEL } = {}) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  const extractor = await pipeline('feature-extraction', model);
  return async function embed(texts) {
    const out = [];
    const batch = 32;
    for (let i = 0; i < texts.length; i += batch) {
      const t = await extractor(texts.slice(i, i + batch), { pooling: 'mean', normalize: true });
      const dim = t.dims[t.dims.length - 1];
      for (let r = 0; r < t.dims[0]; r++) out.push(Float32Array.from(t.data.subarray(r * dim, (r + 1) * dim)));
    }
    return out;
  };
}
