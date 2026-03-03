/**
 * Search View - displays search results filtered by text and tags
 *
 * Query syntax (from URL param `q`):
 *   #tag      — match items tagged with "tag"
 *   text      — match items whose content/title/url contains "text"
 *   #a #b foo — items tagged "a" AND "b" with text matching "foo"
 */

import {
  updateSelection as _updateSelection,
  createKeydownHandler,
  setupToolbar as _setupToolbar,
  createViewPrefs
} from 'peek://app/lib/grid-nav.js';
import {
  createHeaderSlot, createFooterSlot, createFaviconEl, createUrlSpan,
  extractTitle, formatUrl, getItemDisplayInfo
} from 'peek://app/lib/card-helpers.js';
import {
  createAffordanceElements, createActionRulesCache
} from 'peek://app/lib/tag-action-affordances.js';
import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';

const api = window.app;
const debug = api.debug;

// Tag action rules cache for rendering affordances on result cards
let actionRulesCache = null;

// ── State ──────────────────────────────────────────────────────────────

let state = {
  query: '',
  parsedTags: [],    // tag name strings (without #)
  parsedText: '',    // free-text portion
  results: [],
  selectedIndex: 0
};

// View preferences
const { prefs: viewPrefs, load: loadViewPrefs, save: saveViewPrefs } = createViewPrefs('search:viewPrefs', {
  viewMode: 'list',
  sortBy: 'recent',
  sortDirection: 'desc'
});

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Visits' },
  { value: 'recent', label: 'Recent' }
];

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Check if a URL is a navigable web URL (http/https only)
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

/**
 * Parse the search query into tags and text components
 * e.g. "#todo #today frogs" → { tags: ["todo", "today"], text: "frogs" }
 */
const parseQuery = (q) => {
  const tokens = (q || '').split(/\s+/).filter(Boolean);
  const tags = [];
  const textParts = [];

  for (const token of tokens) {
    if (token.startsWith('#') && token.length > 1) {
      tags.push(token.slice(1));
    } else {
      textParts.push(token);
    }
  }

  return {
    tags,
    text: textParts.join(' ')
  };
};

/**
 * Render the search title with colored tokens
 */
const renderTitle = () => {
  const titleEl = document.querySelector('.search-title');
  if (!titleEl) return;

  const parts = [];
  for (const tag of state.parsedTags) {
    parts.push(`<span class="tag-token">#${escapeHtml(tag)}</span>`);
  }
  if (state.parsedText) {
    parts.push(`<span class="text-token">${escapeHtml(state.parsedText)}</span>`);
  }

  titleEl.innerHTML = parts.length > 0
    ? `Search: ${parts.join(' ')}`
    : 'Search';
};

const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

// ── Data fetching ──────────────────────────────────────────────────────

/**
 * Resolve tag names to tag objects using frecency list
 */
const resolveTagNames = async (tagNames) => {
  const result = await api.datastore.getTagsByFrecency();
  if (!result.success) return [];

  const allTags = result.data;
  const resolved = [];

  for (const name of tagNames) {
    const lower = name.toLowerCase();
    const match = allTags.find(t => t.name.toLowerCase() === lower);
    if (match) {
      resolved.push(match);
    }
  }

  return resolved;
};

/**
 * Get items that have ALL specified tags (intersection)
 */
const getItemsByAllTags = async (tags) => {
  if (tags.length === 0) return null; // null = no tag filter

  // Get items for first tag
  const firstResult = await api.datastore.getItemsByTag(tags[0].id);
  if (!firstResult.success) return [];

  let items = firstResult.data;

  // Intersect with items from remaining tags
  for (let i = 1; i < tags.length; i++) {
    const tagResult = await api.datastore.getItemsByTag(tags[i].id);
    if (!tagResult.success) return [];

    const tagItemIds = new Set(tagResult.data.map(item => item.id));
    items = items.filter(item => tagItemIds.has(item.id));
  }

  return items;
};

/**
 * Run the full search: resolve tags, query items, filter by text
 */
const runSearch = async () => {
  const { tags: tagNames, text } = parseQuery(state.query);
  state.parsedTags = tagNames;
  state.parsedText = text;

  let items;

  if (tagNames.length > 0) {
    // Resolve tag names to tag objects
    const resolvedTags = await resolveTagNames(tagNames);

    if (resolvedTags.length < tagNames.length) {
      // Some tags not found — show empty results
      debug && console.log('[search] Some tags not found, showing empty results');
      state.results = [];
      return;
    }

    // Get items matching ALL tags
    items = await getItemsByAllTags(resolvedTags);
    if (!items) items = [];
  } else if (text) {
    // Text-only search — use queryItems with search filter
    const result = await api.datastore.queryItems({ search: text });
    items = result.success ? result.data : [];
  } else {
    // Empty query
    state.results = [];
    return;
  }

  // Apply text filter if both tags and text specified
  if (tagNames.length > 0 && text) {
    const lower = text.toLowerCase();
    items = items.filter(item => {
      const content = (item.content || '').toLowerCase();
      const title = (item.title || '').toLowerCase();
      return content.includes(lower) || title.includes(lower);
    });
  }

  state.results = items;
  debug && console.log('[search] Results:', items.length);
};

// ── Sorting ────────────────────────────────────────────────────────────

const sortResults = (items) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name': {
        const na = (a.title || a.content || '').toLowerCase();
        const nb = (b.title || b.content || '').toLowerCase();
        return dir * na.localeCompare(nb);
      }
      case 'count': {
        const ca = a.visitCount || 0;
        const cb = b.visitCount || 0;
        return dir * (ca - cb);
      }
      case 'recent': {
        const ra = a.updatedAt || a.createdAt || 0;
        const rb = b.updatedAt || b.createdAt || 0;
        return dir * (ra - rb);
      }
      default:
        return 0;
    }
  });
};

// ── Rendering ──────────────────────────────────────────────────────────

const render = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';

  renderTitle();

  if (state.results.length === 0) {
    const message = state.query
      ? 'No items match your search.'
      : 'Enter a search query to find items.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  const sorted = sortResults(state.results);

  sorted.forEach(item => {
    const card = createResultCard(item);
    container.appendChild(card);
  });

  state.selectedIndex = 0;
  updateSelection();
};

/**
 * Create a card element for a search result item.
 * Uses the shared search-result-card builder for consistent rendering.
 */
const createResultCard = (item) => {
  const rules = actionRulesCache ? actionRulesCache.getRules() : [];
  const { itemUrl, itemType } = getItemDisplayInfo(item);

  const card = createSearchResultCard(item, {
    className: 'result-card',
    elevated: true,
    visitCount: item.visitCount,
    affordances: rules.length > 0 ? {
      rules,
      api,
      onToggle: () => { render(); }
    } : null,
    onClick: async (item) => {
      if (itemUrl && isWebUrl(itemUrl)) {
        await api.window.open(itemUrl, {
          role: 'content',
          key: itemUrl,
          width: 800,
          height: 600
        });
      } else if (itemType === 'text') {
        api.publish('editor:open', { itemId: item.id }, api.scopes.GLOBAL);
      }
    }
  });

  // Async: load item tags and render tag chips + affordances
  if (rules.length > 0) {
    api.datastore.getItemTags(item.id).then(tagsResult => {
      if (!tagsResult.success || !tagsResult.data.length) return;
      const tagNames = tagsResult.data.map(t => t.name);
      const el = createAffordanceElements(item.id, tagNames, rules, api, {
        onToggle: () => { render(); }
      });
      if (el) {
        const footer = card.querySelector('[slot="footer"]');
        if (footer) {
          const lastChild = footer.lastElementChild;
          if (lastChild) {
            footer.insertBefore(el, lastChild);
          } else {
            footer.appendChild(el);
          }
        }
      }
    });
  }

  return card;
};

// ── Keyboard navigation ────────────────────────────────────────────────

const updateSelection = () => _updateSelection(state);

const handleKeydown = createKeydownHandler(state, {
  onEscape: () => window.close()
});

// ── Toolbar ────────────────────────────────────────────────────────────

const setupToolbar = () => {
  _setupToolbar({
    viewPrefs,
    sortOptions: SORT_OPTIONS,
    onSave: saveViewPrefs,
    onRender: render
  });
};

// ── Init ───────────────────────────────────────────────────────────────

const init = async () => {
  debug && console.log('[search] init');

  // Initialize tag action rules cache for card affordances
  actionRulesCache = createActionRulesCache(api);

  // Parse query from URL
  const params = new URLSearchParams(window.location.search);
  state.query = params.get('q') || '';

  // Set up toolbar and preferences
  loadViewPrefs();
  setupToolbar();

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Register escape handler
  if (api.escape) {
    api.escape.onEscape(() => {
      window.close();
      return { handled: true };
    });
  }

  // Run search and render
  await runSearch();
  render();
};

document.addEventListener('DOMContentLoaded', init);
