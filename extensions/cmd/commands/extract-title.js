/**
 * Extract a display title from an item's metadata or content.
 *
 * Pure function — no external dependencies.
 * Shared by item-query.js, urls.js, notes.js, and unit tests.
 *
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
