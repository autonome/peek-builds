/**
 * Split note text into its body and the hashtags that end it.
 *
 * Only a run of `#tag` words at the very end is taken; tags earlier in the text stay in the body.
 * Text made only of tags yields an empty body (callers treat that as a tagset, not a note).
 *
 * @param {string} text
 * @returns {{ body: string, tags: string[] }} body without trailing whitespace; tag names without '#', in order, deduplicated
 */
export const splitTrailingTags = (text) => {
  const input = text || '';
  let body = input.replace(/\s+$/, '');
  const tags = [];
  for (;;) {
    const m = body.match(/(?:^|\s)#([^\s#]+)$/);
    if (!m) break;
    tags.unshift(m[1]);
    body = body.slice(0, m.index).replace(/\s+$/, '');
  }
  return { body, tags: [...new Set(tags)] };
};

/**
 * Check if input is a tagset (hashtag syntax like "#foo #bar").
 * Returns the parsed tag names if it is a tagset, or null otherwise.
 */
export const parseTagset = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Split on whitespace and check that every token starts with #
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return null;
  const allHashtags = tokens.every(t => /^#[^\s#]+$/.test(t));
  if (!allHashtags) return null;
  // Strip the # prefix from each tag name
  return tokens.map(t => t.slice(1));
};

/**
 * Detect item type from input
 */
export const detectType = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url';
  if (parseTagset(trimmed)) return 'tagset';
  return 'text';
};
