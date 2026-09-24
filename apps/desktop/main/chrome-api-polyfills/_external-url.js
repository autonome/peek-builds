/**
 * External-URL scheme gate for the chrome API polyfills.
 *
 * Extensions hand arbitrary strings to `chrome.tabs.create`, and the only thing
 * standing between such a string and the OS is this gate. Only http(s) is handed
 * out: a custom scheme such as `peek://` would re-enter the app through the OS
 * protocol handler, outside the tile / capability path, and `file:`,
 * `javascript:` and `data:` have no business reaching the default handler at all.
 *
 * Deliberately electron-free and `shell`-injected, so it can be loaded and tested
 * under plain `node --test`.
 *
 * @module _external-url
 */

/**
 * True only for a string that parses as a URL with an http(s) scheme.
 * `URL` lowercases the protocol, so the scheme match is case-insensitive.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isWebUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Hand a URL to the OS only when it is an http(s) URL.
 *
 * @param {{ openExternal: (url: string) => unknown }} shell
 * @param {unknown} url
 * @returns {boolean} true when the URL was passed to `shell.openExternal`.
 */
export function openExternalIfWebUrl(shell, url) {
  if (!isWebUrl(url)) return false;
  const result = shell.openExternal(url);
  // openExternal is async in electron; the caller gets a synchronous verdict on
  // the scheme, so swallow a rejection here rather than leaving it unhandled.
  if (result && typeof result.catch === 'function') result.catch(() => {});
  return true;
}
