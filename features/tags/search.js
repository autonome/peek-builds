/**
 * Pure search/filter logic for the tags extension.
 *
 * Extracted from home.js so it can be unit-tested without DOM or module-level state.
 */

/**
 * Parse a search query into #-prefixed tag filters and plain text terms.
 *
 * - `#todo` -> strict tag filter for "todo"
 * - `market` -> text search across all fields (content, title, URL, tags)
 * - `#todo market` -> items with tag "todo" AND "market" in any field
 * - `#todo #reading` -> items with both tags
 *
 * @param {string} query - Raw search input
 * @returns {{ tagFilters: string[], textTerms: string[] }}
 */
export const parseSearchQuery = (query) => {
  const tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
  const tagFilters = [];
  const textTerms = [];

  for (const token of tokens) {
    if (token.startsWith('#') && token.length > 1) {
      // Strip # prefix, normalize to lowercase for matching
      tagFilters.push(token.slice(1).toLowerCase());
    } else {
      textTerms.push(token.toLowerCase());
    }
  }

  return { tagFilters, textTerms };
};

/**
 * Filter items based on search query, active tags, active type filter, and item-tag mapping.
 *
 * Search behaviour:
 *   - #-prefixed terms are strict tag-only matches (exact tag name).
 *   - Non-prefixed terms search across content, title, URL, domain, AND tag names.
 *   - All terms are AND-ed: items must match every tag filter and every text term.
 *   - Sidebar-selected tags (activeTags) are combined with search #tags using AND logic.
 *
 * @param {Object} opts
 * @param {Array} opts.items - All items
 * @param {Map} opts.itemTags - Map of item.id -> array of { id, name } tag objects
 * @param {string} opts.searchQuery - Raw search input
 * @param {Array} opts.activeTags - Tags selected in sidebar (each has .id)
 * @param {string} opts.activeFilter - Type filter: 'all' | 'page' | 'text' | 'tagset' | 'image'
 * @returns {Array} Filtered items
 */
export const filterItems = ({ items, itemTags, searchQuery, activeTags, activeFilter }) => {
  // Only show items that have at least one tag
  let result = items.filter(item => {
    const tags = itemTags.get(item.id);
    return tags && tags.length > 0;
  });

  // Filter by type
  if (activeFilter !== 'all') {
    result = result.filter(item => {
      const itemType = item.type || (item.uri ? 'url' : null);
      if (activeFilter === 'page') {
        return itemType === 'url' || !itemType;
      }
      return itemType === activeFilter;
    });
  }

  // Filter by active tags from sidebar (AND logic - item must have ALL selected tags)
  if (activeTags.length > 0) {
    result = result.filter(item => {
      const tags = itemTags.get(item.id) || [];
      const tagIds = new Set(tags.map(t => t.id));
      return activeTags.every(activeTag => tagIds.has(activeTag.id));
    });
  }

  // Filter by search query - parse into tag filters and text terms
  if (searchQuery) {
    const { tagFilters, textTerms } = parseSearchQuery(searchQuery);

    // Apply strict tag filters: item must have ALL specified tags (exact name match)
    if (tagFilters.length > 0) {
      result = result.filter(item => {
        const tags = itemTags.get(item.id) || [];
        const tagNames = new Set(tags.map(t => t.name.toLowerCase()));
        return tagFilters.every(tf => tagNames.has(tf));
      });
    }

    // Apply text term filters: each term must appear in content, title, URL, domain, or tag names
    if (textTerms.length > 0) {
      result = result.filter(item => {
        const content = (item.content || '').toLowerCase();
        const title = (item.title || '').toLowerCase();
        const uri = (item.uri || '').toLowerCase();
        const domain = (item.domain || '').toLowerCase();
        const tags = itemTags.get(item.id) || [];
        const tagNamesStr = tags.map(t => t.name.toLowerCase()).join(' ');

        return textTerms.every(term =>
          content.includes(term) ||
          title.includes(term) ||
          uri.includes(term) ||
          domain.includes(term) ||
          tagNamesStr.includes(term)
        );
      });
    }
  }

  return result;
};

/**
 * Filter tags for the sidebar based on search query.
 * When tags are selected, don't filter the tag list by search (search applies to items instead).
 * Selected tags are always included regardless of search filter.
 * Handles # prefix: "#todo" filters sidebar tags by "todo".
 *
 * @param {Object} opts
 * @param {Array} opts.tags - All tags (each has .id, .name)
 * @param {string} opts.searchQuery - Raw search input
 * @param {Array} opts.activeTags - Tags selected in sidebar (each has .id)
 * @returns {Array} Filtered tags
 */
export const filterTags = ({ tags, searchQuery, activeTags }) => {
  if (!searchQuery || activeTags.length > 0) return tags;
  const { tagFilters, textTerms } = parseSearchQuery(searchQuery);
  const selectedIds = new Set(activeTags.map(t => t.id));

  // If there are #-prefixed tag filters, filter sidebar to matching tags
  // If there are also text terms, include tags matching those too
  const allTerms = [...tagFilters, ...textTerms];
  if (allTerms.length === 0) return tags;

  return tags.filter(tag =>
    selectedIds.has(tag.id) ||
    allTerms.some(term => tag.name.toLowerCase().includes(term))
  );
};
