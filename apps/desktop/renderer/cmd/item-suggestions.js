/**
 * Item suggestion helpers - pure functions shared by the cmd palette's item completer.
 *
 * No window/DOM access, so this module can be imported directly by node unit tests.
 */

/**
 * Find a tag by name, ignoring case.
 * @param {Array<{id: string, name: string}>} tags
 * @param {string} name
 * @returns {{id: string, name: string}|undefined}
 */
export function findTagByName(tags, name) {
  if (!Array.isArray(tags) || !name) return undefined;
  const lowerName = name.toLowerCase();
  return tags.find(tag => tag && typeof tag.name === 'string' && tag.name.toLowerCase() === lowerName);
}

/**
 * Narrow the rows a tag lookup returned down to the ones a suggestion list should show.
 * @param {Array<Object>} items - Rows as returned by getItemsByTag()
 * @param {Object} [opts]
 * @param {string} [opts.search] - Case-insensitive substring matched against title and content
 * @param {string} [opts.itemType] - When given, only items of this type are kept
 * @param {number} [opts.limit=20] - Maximum number of rows returned
 * @returns {Array<Object>}
 */
export function filterTaggedItems(items, { search, itemType, limit = 20 } = {}) {
  if (!Array.isArray(items)) return [];

  const searchText = (search || '').trim().toLowerCase();

  return items
    .filter(item => {
      if (!item) return false;
      if (itemType && item.type !== itemType) return false;
      if (!searchText) return true;
      const title = (item.title || '').toLowerCase();
      const content = (item.content || '').toLowerCase();
      return title.includes(searchText) || content.includes(searchText);
    })
    .sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, limit);
}

/**
 * Map an item row to a cmd panel suggestion.
 * @param {Object} item
 * @returns {{title: string, subtitle: string, value: string, _item: Object}}
 */
export function toItemSuggestion(item) {
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
}
