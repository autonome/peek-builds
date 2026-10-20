/**
 * URL comparison for "is this the same address?" decisions.
 *
 * Two addresses that differ only in a trailing path slash, a default port, or
 * the order of their query parameters point at the same page, so a lookup that
 * matches an item by URL has to compare normalized forms. Kept pure and free of
 * DOM access so it can be exercised under node.
 */

/**
 * Normalize a URL for equality comparison. A string that does not parse as a
 * URL is returned unchanged, so a caller can compare arbitrary content.
 */
export function normalizeUrlForCompare(u) {
  try {
    const parsed = new URL(u);
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    if (parsed.search) {
      const params = new URLSearchParams(parsed.search);
      const sortedParams = new URLSearchParams([...params.entries()].sort());
      parsed.search = sortedParams.toString();
    }
    return parsed.toString();
  } catch { return u; }
}
