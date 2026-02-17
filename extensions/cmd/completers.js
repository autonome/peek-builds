/**
 * Completers - built-in parameter completion providers for cmd palette
 *
 * Each completer returns [{title, subtitle, value}] where:
 * - title: display text (e.g., "todo")
 * - subtitle: secondary info (e.g., "used 12x")
 * - value: text to insert into input
 */

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
  const values = paramDef.values || [];

  const matchText = lowerPartial.startsWith(prefix.toLowerCase())
    ? lowerPartial.slice(prefix.length)
    : lowerPartial;

  return values
    .filter(val => {
      if (exclude.has(val.toLowerCase())) return false;
      if (matchText && !val.toLowerCase().startsWith(matchText)) return false;
      return true;
    })
    .map(val => ({
      title: prefix + val,
      subtitle: '',
      value: prefix + val
    }));
}

/**
 * Item completer - searches notes/items with search-as-you-type
 * @param {string} partial - Current search text
 * @param {Set<string>} exclude - Not used for items
 * @param {Object} paramDef - The param definition {type, itemType}
 * @returns {Promise<Array<{title, subtitle, value, _item}>>}
 */
export async function completeItem(partial, exclude, paramDef) {
  const queryOpts = {
    type: paramDef.itemType || 'text',
    limit: 20,
    sortBy: 'updated'
  };

  const searchText = (partial || '').trim();
  if (searchText) {
    queryOpts.search = searchText;
  }

  const result = await api.datastore.queryItems(queryOpts);
  if (!result.success || !result.data) return [];

  return result.data.map(item => {
    const content = item.content || '';
    const firstLine = content.split('\n')[0].replace(/^#+ /, '').trim() || 'Untitled';
    const title = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;
    const date = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '';

    return {
      title,
      subtitle: date,
      value: item.id,
      _item: item
    };
  });
}

/**
 * Get suggestions for a param definition
 * @param {Object} paramDef - {type, multiple, prefix, values}
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
