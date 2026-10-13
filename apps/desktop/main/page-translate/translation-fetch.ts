/**
 * The fetch every translation download goes through: Remote Settings records, the server root's
 * capabilities, and attachments.
 *
 * Main fetches through its own session, `TRANSLATION_PARTITION` (`translate-main.ts
 * electronTranslationFetch()`), for two reasons:
 *
 * - Mozilla's attachment CDN can answer a Chrome user agent with HTTP 406, and that 406 carries
 *   `cache-control: public, max-age=31536000, immutable`. Chromium stores it, and the user
 *   agent is not part of the cache key, so once the browsing session's disk cache holds a 406
 *   every later `net.fetch` of that attachment gets the cached 406 from disk, whatever
 *   `User-Agent` header it sends. The translation session is in memory only (no `persist:`
 *   prefix), so nothing it receives outlives the run, and every request also asks for
 *   `cache: 'no-store'`, so not even an in-run failure is replayed.
 * - The session's own user agent names Peek, `Peek/<version> (on-device translation)`, rather
 *   than the stock-Chrome user agent every web surface presents, so the CDN sees no Chrome user
 *   agent at all. It names Peek rather than imitating Firefox so the requests stay honest about
 *   their origin.
 *
 * The session also keeps these requests away from browsing cookies, while keeping Chromium's
 * proxy and certificate handling. `model-download.ts` stays transport-agnostic.
 */

import type { FetchLike, FetchResponseLike } from './model-download.js';

/** In-memory partition the translation downloads use; no `persist:` prefix, so no disk cache. */
export const TRANSLATION_PARTITION = 'peek-translations';

/** A fetch that accepts a cache mode, as `session.fetch` and global `fetch` do. */
export type CacheModeFetchLike = (
  url: string,
  init: { signal?: AbortSignal; cache: 'no-store' },
) => Promise<FetchResponseLike>;

/** `Peek/<version> (on-device translation)`. */
export function translationUserAgent(appVersion: string): string {
  return `Peek/${appVersion} (on-device translation)`;
}

/** Wraps `fetch` so no request reads or writes the HTTP cache. */
export function withoutHttpCache(fetch: CacheModeFetchLike): FetchLike {
  return (url, init) => fetch(url, { signal: init?.signal, cache: 'no-store' });
}
