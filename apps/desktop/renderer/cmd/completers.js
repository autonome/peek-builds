/**
 * Completers - built-in parameter completion providers for cmd palette
 *
 * Each completer returns [{title, subtitle, value}] where:
 * - title: display text (e.g., "todo")
 * - subtitle: secondary info (e.g., "used 12x")
 * - value: text to insert into input
 */

import { matchTier, NO_MATCH } from './enum-match.js';
import { findTagByName, filterTaggedItems, toItemSuggestion } from './item-suggestions.js';

const api = window.app;

// ===== Tag Completer =====
// Fetches tags by frecency with a short TTL cache

let tagCache = null;
let tagCacheTime = 0;
const TAG_CACHE_TTL = 5000; // 5 seconds

/**
 * Get all tags, using a short-lived cache to avoid DB thrashing
 */
async function fetchTags() {
  const now = Date.now();
  if (tagCache && (now - tagCacheTime) < TAG_CACHE_TTL) {
    return tagCache;
  }

  const result = await api.datastore.getTagsByFrecency();
  if (result.success && result.data) {
    tagCache = result.data;
    tagCacheTime = now;
    return tagCache;
  }

  return tagCache || [];
}

/**
 * Tag completer - suggests tags sorted by frecency
 * @param {string} partial - Current partial token being typed
 * @param {Set<string>} exclude - Tags already used (for multiple: true)
 * @param {Object} paramDef - The param definition {type, multiple, prefix}
 * @returns {Promise<Array<{title, subtitle, value}>>}
 */
export async function completeTag(partial, exclude, paramDef) {
  const tags = await fetchTags();
  const prefix = paramDef.prefix || '';
  const lowerPartial = (partial || '').toLowerCase();

  // Strip prefix from partial for matching (user may type "#to" for tag "todo")
  const matchText = lowerPartial.startsWith(prefix.toLowerCase())
    ? lowerPartial.slice(prefix.length)
    : lowerPartial;

  return tags
    .filter(tag => {
      // Exclude already-used tags
      if (exclude.has(tag.name.toLowerCase())) return false;
      // Filter by partial match
      if (matchText && !tag.name.toLowerCase().startsWith(matchText)) return false;
      return true;
    })
    .slice(0, 20)
    .map(tag => ({
      title: prefix + tag.name,
      subtitle: `used ${tag.frequency || 0}x`,
      value: prefix + tag.name
    }));
}

/**
 * Enum completer - filters a static values array
 * @param {string} partial - Current partial token being typed
 * @param {Set<string>} exclude - Values already used
 * @param {Object} paramDef - The param definition {type, values, prefix}
 * @returns {Array<{title, subtitle, value}>}
 */
export function completeEnum(partial, exclude, paramDef) {
  const prefix = paramDef.prefix || '';
  const lowerPartial = (partial || '').toLowerCase();
  const options = paramDef.options || [];
  const values = paramDef.values || [];

  const matchText = lowerPartial.startsWith(prefix.toLowerCase())
    ? lowerPartial.slice(prefix.length)
    : lowerPartial;

  // Support both rich options [{value, title, subtitle}] and plain string values
  const candidates = (options.length > 0 ? options : values).map(opt => {
    if (typeof opt === 'string') {
      return { val: opt, name: opt, suggestion: { title: prefix + opt, subtitle: '', value: prefix + opt } };
    }
    return {
      val: opt.value,
      name: opt.title,
      suggestion: {
        title: prefix + (opt.title || opt.value),
        subtitle: opt.subtitle || '',
        value: prefix + opt.value
      }
    };
  });

  // Match against value and title; best tier first, provider order within a tier (stable sort)
  return candidates
    .filter(c => !exclude.has(c.val.toLowerCase()))
    .map(c => ({ c, tier: matchTier(matchText, c.val, c.name) }))
    .filter(({ tier }) => tier !== NO_MATCH)
    .sort((a, b) => a.tier - b.tier)
    .map(({ c }) => c.suggestion);
}

/**
 * Item completer - searches notes/items with search-as-you-type
 *
 * With `tag` set, the suggestions come from the items carrying that tag instead of from a
 * datastore query, and `itemType` narrows them only when the definition sets it.
 *
 * @param {string} partial - Current search text
 * @param {Set<string>} exclude - Not used for items
 * @param {Object} paramDef - The param definition {type, itemType, tag}
 * @returns {Promise<Array<{title, subtitle, value, _item}>>}
 */
export async function completeItem(partial, exclude, paramDef) {
  const searchText = (partial || '').trim();

  if (paramDef.tag) {
    const tags = await fetchTags();
    const tag = findTagByName(tags, paramDef.tag);
    if (!tag) return [];

    const result = await api.datastore.getItemsByTag(tag.id);
    if (!result.success || !result.data) return [];

    const filterOpts = { search: searchText, limit: 20 };
    if (paramDef.itemType) {
      filterOpts.itemType = paramDef.itemType;
    }

    return filterTaggedItems(result.data, filterOpts).map(toItemSuggestion);
  }

  const queryOpts = {
    type: paramDef.itemType || 'text',
    limit: 20,
    sortBy: 'updated'
  };

  if (searchText) {
    queryOpts.search = searchText;
  }

  const result = await api.datastore.queryItems(queryOpts);
  if (!result.success || !result.data) return [];

  return result.data.map(toItemSuggestion);
}

/**
 * Get suggestions for a param definition
 * @param {Object} paramDef - {type, multiple, prefix, values, itemType, tag}
 * @param {string} partial - Current partial token
 * @param {Set<string>} exclude - Already-used values
 * @returns {Promise<Array<{title, subtitle, value}>>}
 */
export async function getSuggestions(paramDef, partial, exclude) {
  switch (paramDef.type) {
    case 'tag':
      return completeTag(partial, exclude, paramDef);
    case 'enum':
      return completeEnum(partial, exclude, paramDef);
    case 'item':
      return completeItem(partial, exclude, paramDef);
    default:
      return [];
  }
}

/**
 * Invalidate the tag cache (call when panel is re-shown)
 */
export function invalidateCache() {
  tagCache = null;
  tagCacheTime = 0;
}
