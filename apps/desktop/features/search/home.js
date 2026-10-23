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
  createViewPrefs,
  getCards,
  toggleSelectedCheckbox
} from 'peek://app/lib/grid-nav.js';
import { getItemDisplayInfo } from 'peek://app/lib/card-helpers.js';
import { createActionRulesCache } from 'peek://app/lib/tag-action-affordances.js';
import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';
import { createVisibilityGate } from 'peek://app/lib/visibility-gate.js';

const api = window.app;

// Tag action rules cache for rendering affordances on result cards
let actionRulesCache = null;

// ── State ──────────────────────────────────────────────────────────────

let state = {
  query: '',
  parsedTags: [],    // tag name strings (without #)
  parsedText: '',    // free-text portion
  results: [],
  itemTags: new Map(),  // Map of itemId -> [tags]
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

/**
 * Set the window title to reflect the current search query.
 * Empty query → "Search"; non-empty → "Search: <query>" (truncated at 60 chars).
 * Electron's BrowserWindow.getTitle() reads document.title, so the Windows
 * switcher card label updates automatically.
 */
const setSearchTitle = (query) => {
  const q = (query || '').trim();
  if (!q) {
    document.title = 'Search';
    return;
  }
  const MAX = 60;
  const truncated = q.length > MAX ? q.slice(0, MAX - 1) + '…' : q;
  document.title = `Search: ${truncated}`;
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

  // Pre-load tags for all result items
  state.itemTags.clear();
  for (const item of items) {
    const tagsResult = await api.datastore.getItemTags(item.id);
    if (tagsResult.success) {
      state.itemTags.set(item.id, tagsResult.data);
    }
  }

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
  setSearchTitle(state.query);

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
  const tags = state.itemTags.get(item.id) || [];
  const rules = actionRulesCache ? actionRulesCache.getRules() : [];
  const { itemUrl, itemType } = getItemDisplayInfo(item, { tags });

  const card = createSearchResultCard(item, {
    className: 'result-card',
    tags,
    visitCount: item.visitCount,
    showOpenButton: itemUrl && isWebUrl(itemUrl),
    onOpen: (url) => {
      api.window.open(url, {
        role: 'content',
        key: url,
        width: 1024,
        height: 768
      });
    },
    onDelete: async (item) => {
      if (!confirm(`Delete "${item.title || item.content || 'this item'}"?`)) return;
      await api.datastore.deleteItem(item.id);
      api.pubsub.publish('item:deleted', { id: item.id });
      state.results = state.results.filter(r => r.id !== item.id);
      state.itemTags.delete(item.id);
      render();
    },
    onTagRemove: async (item, tag) => {
      try {
        await api.datastore.untagItem(item.id, tag.id);
        api.pubsub.publish('tag:item-removed', { itemId: item.id, tagId: tag.id });
        // Update local tag cache and re-render
        const currentTags = state.itemTags.get(item.id) || [];
        state.itemTags.set(item.id, currentTags.filter(t => t.id !== tag.id));
        render();
      } catch (err) {
        console.error('[search] Failed to remove tag:', err);
      }
    },
    affordances: rules.length > 0 ? {
      rules,
      api,
      onToggle: async () => {
        // Re-run the full search so an item that no longer matches the
        // query (e.g. user flipped #todo to #done while searching #todo)
        // disappears immediately. We don't rely on the tag:item-added /
        // tag:item-removed pubsub bounce because (a) it's debounced 150ms
        // and (b) we don't want a stale row sitting in results between
        // the click and the pubsub round-trip.
        await runSearch();
        render();
      }
    } : null,
    onClick: async (item) => {
      if (itemUrl && isWebUrl(itemUrl)) {
        await api.window.open(itemUrl, {
          role: 'content',
          key: itemUrl,
          width: 1024,
          height: 768
        });
      } else if (itemType === 'text') {
        api.pubsub.publish('editor:open', { itemId: item.id });
      }
    }
  });

  return card;
};

// ── Keyboard navigation ────────────────────────────────────────────────

const updateSelection = () => _updateSelection(state);

/**
 * Delete the currently selected search result item.
 * Matches the onDelete callback used by card delete buttons.
 */
const deleteSelectedItem = async () => {
  const cards = getCards();
  const selected = cards[state.selectedIndex];
  if (!selected) return;

  const itemId = selected.dataset.itemId;
  const item = state.results.find(r => r.id === itemId);
  if (!item) return;

  if (!confirm(`Delete "${item.title || item.content || 'this item'}"?`)) return;

  await api.datastore.deleteItem(item.id);
  api.pubsub.publish('item:deleted', { id: item.id });
  state.results = state.results.filter(r => r.id !== item.id);
  state.itemTags.delete(item.id);
  render();
};

const _baseKeydownHandler = createKeydownHandler(state, {
  onEscape: () => window.close()
});

/**
 * Extended keydown handler: delegates to shared grid-nav handler,
 * plus adds Delete key for deleting items.
 */
const handleKeydown = (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelectedItem();
    return;
  }
  _baseKeydownHandler(e);
};

// ── Toolbar ────────────────────────────────────────────────────────────

const setupToolbar = () => {
  _setupToolbar({
    viewPrefs,
    sortOptions: SORT_OPTIONS,
    onSave: saveViewPrefs,
    onRender: render
  });
};

// ── See-through ────────────────────────────────────────────────────────

/**
 * Read this window's see-through state from main and draw it.
 *
 * The look is entirely see-through.css plus the `body.see-through` block in
 * home.css, both gated on a class on `<body>`; the state itself lives in main
 * as a window param, which is why it survives a restart. Reading it here is
 * also what applies a switch that was already on when the session was saved,
 * before any announcement arrives.
 */
const applySeeThrough = async () => {
  try {
    const result = await api?.window?.getSeeThrough?.();
    const on = result?.success === true && result.data?.seeThrough === true;
    document.body.classList.toggle('see-through', on);
  } catch (error) {
    console.log('[ext:search] see-through state unavailable:', error);
  }
};

/**
 * Follow the see-through switch. `window:see-through` is a broadcast, so
 * rather than matching the window id in the message the view simply re-reads
 * its own state — one answer, and no second idea of which window this is.
 */
const setupSeeThrough = () => {
  api?.pubsub?.subscribe('window:see-through', () => { applySeeThrough(); });
  applySeeThrough();
};

// ── Init ───────────────────────────────────────────────────────────────

const init = async () => {

  // Initialize tag action rules cache for card affordances
  actionRulesCache = createActionRulesCache(api);

  // Re-render when affordance rules change. The cache refreshes itself
  // on `rules:changed`; subscribing AFTER createActionRulesCache means
  // the cache's listener runs first, so getRules() is current when
  // render reads it.
  api.pubsub.subscribe('rules:changed', () => {
    if (state.results.length > 0) render();
  });

  // Parse query from URL
  const params = new URLSearchParams(window.location.search);
  state.query = params.get('q') || '';

  // Set up toolbar and preferences
  loadViewPrefs();
  setupToolbar();

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Register escape handler — defer to backend escPolicy (workspace role = never close)
  if (api.escape) {
    api.escape.onEscape(() => {
      return { handled: false };
    });
  }

  // Run search and render
  await runSearch();
  render();

  // The view is drawn; a spec can wait for this rather than for a card count.
  document.body.dataset.ready = 'true';
};

// ── Debounce helper ─────────────────────────────────────────────────

const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

// ── Reactive subscriptions ──────────────────────────────────────────

// Visibility-gated: pubsub-driven refreshes are deferred when the tile is
// hidden, then drained on the first visibilitychange to visible.
const searchRefreshWork = async () => {
  if (!state.query) return; // Nothing to refresh if no active search
  await runSearch();
  render();
};
const { gated: gatedSearchRefresh } = createVisibilityGate(searchRefreshWork);
const debouncedRefresh = debounce(gatedSearchRefresh, 150);

api.pubsub.subscribe('sync:pull-completed', () => {
  debouncedRefresh();
});

api.pubsub.subscribe('item:created', () => {
  debouncedRefresh();
});

api.pubsub.subscribe('item:deleted', () => {
  debouncedRefresh();
});

api.pubsub.subscribe('tag:item-added', () => {
  debouncedRefresh();
});

api.pubsub.subscribe('tag:item-removed', () => {
  debouncedRefresh();
});

// Here with the other module-level subscriptions, so a switch flipped while
// the view is still loading is not missed: this runs on module evaluation,
// ahead of `init()` and of the first await in it.
setupSeeThrough();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
