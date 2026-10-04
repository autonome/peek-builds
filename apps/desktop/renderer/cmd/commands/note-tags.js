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
