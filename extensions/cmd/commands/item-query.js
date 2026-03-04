/**
 * Shared query helper for type-specific item nouns
 *
 * Queries the datastore for items of a given type, with optional text filtering.
 * Used by urls.js and notes.js to avoid duplicating query logic.
 */
import api from 'peek://app/api.js';

/**
 * Extract a display title from an item's metadata or content
 * @param {Object} item - Datastore item
 * @returns {string}
 */
export function extractTitle(item) {
  if (item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      if (meta.title) return meta.title;
      if (meta.name) return meta.name;
    } catch (e) {}
  }
  return item.content || 'Untitled';
}

/**
 * Query items by type with optional search filtering
 *
 * @param {string} type - Item type ('url', 'text', etc.) or '' for all
 * @param {Object} [opts]
 * @param {string} [opts.search] - Text to match against content and metadata title
 * @param {number} [opts.limit=50] - Max items to return
 * @returns {Promise<Array>} Matching items
 */
export async function queryItemsByType(type, { search = '', limit = 50 } = {}) {
  const query = {};
  if (type) query.type = type;

  const result = await api.datastore.queryItems(query);
  if (!result.success) return [];

  let items = result.data;

  if (search) {
    const lower = search.toLowerCase();
    items = items.filter(item => {
      const content = (item.content || '').toLowerCase();
      const title = extractTitle(item).toLowerCase();
      return content.includes(lower) || title.includes(lower);
    });
  }

  return items.slice(0, limit);
}
