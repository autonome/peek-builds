/**
 * The fetch every translation download goes through: Remote Settings records, the server root's
 * capabilities, and attachments.
 *
 * Mozilla's attachment CDN answers any Chrome user agent with HTTP 406, and Electron's default
 * user agent is a Chrome one, so every request carries an explicit user agent naming Peek. It
 * names Peek rather than imitating Firefox so the requests stay honest about their origin.
 */

import type { FetchLike, FetchResponseLike } from './model-download.js';

/** A fetch that accepts request headers, as `net.fetch` and global `fetch` do. */
export type HeaderFetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponseLike>;

/** `Peek/<version> (on-device translation)`. */
export function translationUserAgent(appVersion: string): string {
  return `Peek/${appVersion} (on-device translation)`;
}

/** Wraps `fetch` so every request sends `User-Agent: userAgent`. */
export function withUserAgent(fetch: HeaderFetchLike, userAgent: string): FetchLike {
  return (url, init) => fetch(url, { ...init, headers: { 'User-Agent': userAgent } });
}
