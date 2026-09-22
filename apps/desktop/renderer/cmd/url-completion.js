/**
 * Pure URL-completion helpers for the cmd inline ghost.
 *
 * Leaf module — NO electron / peek:// / DOM imports — so a node:test unit spec
 * can import it directly (see tests/unit/url-completion.test.js), mirroring the
 * user-agent.ts precedent (peek 64258a54). panel.js imports these; keep it
 * import-free so both sides can use it.
 */

/**
 * Strip https://, http://, and a single leading www. so we can prefix-match
 * against the user's typed text (which won't include the scheme).
 * E.g. https://www.marktplaats.nl/foo -> marktplaats.nl/foo
 */
export function urlMatchable(url) {
  if (!url) return '';
  let s = url;
  if (s.startsWith('https://')) s = s.slice('https://'.length);
  else if (s.startsWith('http://')) s = s.slice('http://'.length);
  if (s.startsWith('www.')) s = s.slice('www.'.length);
  return s;
}

/**
 * Ordered inline-completion stop-points. Tab expands host -> path1 -> path ->
 * full; the ghost first shows at the smallest stop-point that extends the typed
 * text (default: host).
 */
export const URL_GRANULARITY_ORDER = ['host', 'path1', 'path', 'full'];

/**
 * The matchable-form completion for a stored URL at one granularity. Scheme and
 * a leading www. are stripped (like urlMatchable); query/fragment are dropped
 * except at 'full'.
 *
 * The host is NEVER shortened to a registrable domain — there is no public
 * suffix list in this codebase, and last-2-labels breaks on co.uk / github.io.
 * So 'host' is the full hostname (all labels), which is unambiguous and still a
 * clean bare origin (kills the tracking path+query, the reported pain).
 *
 *   host  -> app.fastmail.com
 *   path1 -> app.fastmail.com/mail
 *   path  -> app.fastmail.com/mail/Inbox        (query/fragment stripped)
 *   full  -> app.fastmail.com/mail/Inbox?x=1#y  (everything, matchable-form)
 */
export function urlCompletionAtGranularity(storedUrl, granularity) {
  if (!storedUrl) return '';
  let parsed;
  try {
    parsed = new URL(storedUrl);
  } catch {
    // Not parseable — fall back to the whole matchable form.
    return urlMatchable(storedUrl);
  }

  let host = parsed.host; // hostname[:port]
  if (host.startsWith('www.')) host = host.slice('www.'.length);

  if (granularity === 'host') return host;

  const path = parsed.pathname || '';
  const segments = path.split('/').filter(Boolean);

  if (granularity === 'path1') {
    return segments.length ? host + '/' + segments[0] : host;
  }
  if (granularity === 'path') {
    return path && path !== '/' ? host + path : host;
  }
  // 'full' — scheme + leading www stripped, path + query + fragment kept.
  return urlMatchable(storedUrl);
}

/**
 * `completion` when it is a forward prefix-completion of `anchor`, else null.
 * Leading or trailing whitespace on `anchor` disqualifies it: whitespace at
 * either end means the user has moved past extending a URL (a trailing space
 * ends the word; a leading space isn't a URL start), and the overlay's
 * highlighted-suffix offset must equal the native input's fill offset — an
 * anchor trimmed in one place and not the other is exactly how the two drift.
 * `anchor` is used verbatim here and is NEVER trimmed.
 */
export function inlineCompletionFor(completion, anchor) {
  if (!anchor) return null;
  if (anchor !== anchor.trim()) return null;
  if (!completion || completion.length <= anchor.length) return null;
  if (!completion.toLowerCase().startsWith(anchor.toLowerCase())) return null;
  return completion;
}
