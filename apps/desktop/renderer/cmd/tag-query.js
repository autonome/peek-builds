/**
 * Tag query helpers: parsing `#tag` arguments and combining the items they match.
 *
 * Leaf module with no `window` access, so it can be imported by the cmd panel,
 * the edit command, the editor background and the editor window alike.
 */

/**
 * Parse command arguments as a tag query.
 * @param {string} rawArgs
 * @returns {string[]|null} Tag names in order of first appearance (case-insensitive
 *   de-duplication), or null when any token is not a `#name` token.
 */
export function parseTagQuery(rawArgs) {
  if (typeof rawArgs !== 'string') return null;
  const tokens = rawArgs.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const names = [];
  const seen = new Set();
  for (const token of tokens) {
    if (!token.startsWith('#') || token.length < 2) return null;
    const name = token.slice(1);
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    names.push(name);
  }
  return names;
}

/**
 * Canonical key for a tag set: sorted, lower-cased, de-duplicated, comma-joined.
 * @param {string[]} tags
 * @returns {string}
 */
export function queryKey(tags) {
  const lowered = (tags || []).map(t => String(t).toLowerCase());
  return [...new Set(lowered)].sort().join(',');
}

/**
 * Window key for the editor window showing a tag query.
 * @param {string[]} tags
 * @returns {string}
 */
export function queryWindowKey(tags) {
  return `editor-query-${queryKey(tags)}`;
}

/**
 * Items present in every list, matched by `id`, in the order of the first list.
 * @param {Array<Array<{id: string}>>} itemLists
 * @returns {Array<Object>}
 */
export function intersectItems(itemLists) {
  if (!Array.isArray(itemLists) || itemLists.length === 0) return [];
  const [first, ...rest] = itemLists;
  const restIds = rest.map(list => new Set((list || []).map(item => item && item.id)));
  const seen = new Set();
  const out = [];
  for (const item of first || []) {
    if (!item || seen.has(item.id)) continue;
    if (restIds.every(ids => ids.has(item.id))) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}
