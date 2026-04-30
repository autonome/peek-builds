import { parseSearchQuery, filterItems, filterTags } from './search.js';

/**
 * Tags Home - Tag visualization and management UI
 *
 * Features:
 * - View all saved items (addresses) filtered by type
 * - Tag-based filtering via clickable tag buttons
 * - Tag editing on items (add/remove tags)
 * - Content search across items (URLs, titles, text) with tag combo filtering
 * - Selected tags pinned to top of sidebar with visual distinction
 * - Inline detail view (no modal/dialog) with proper ESC navigation
 * - Embedded CodeMirror editor for inline text editing
 */

import * as CodeMirror from 'peek://extensions/editor/codemirror.js';
import { StatusLine } from 'peek://extensions/editor/status-line.js';
import {
  createHeaderSlot, createFooterSlot, createFaviconEl, createUrlSpan,
  extractTitle, formatUrl, getItemDisplayInfo
} from 'peek://app/lib/card-helpers.js';
import {
  createAffordanceElements, createActionRulesCache
} from 'peek://app/lib/tag-action-affordances.js';
import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';
const { getCM, Vim } = CodeMirror;

const api = window.app;
const debug = api?.debug;

// Tag action rules cache for rendering affordances on cards
let actionRulesCache = null;

// View states (following groups pattern)
const VIEW_LIST = 'list';
const VIEW_DETAIL = 'detail';

/**
 * Open a URL in a new page window (same webview mechanism as URL items).
 * Routes through peek://page which provides the webview container.
 * @param {string} url - The URL to open
 */
const openItemUrl = async (url) => {
  try {
    await api.window.open(url, {
      role: 'content',
      width: 1024,
      height: 768,
      trackingSource: 'tags',
      trackingSourceId: 'note-url'
    });
    debug && console.log('[tags] Opened URL from note:', url);
  } catch (err) {
    console.error('[tags] Failed to open URL:', err);
  }
};

/**
 * Simple debounce helper - collapses rapid calls into one
 */
const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

// State
let state = {
  currentView: VIEW_LIST,   // 'list' | 'detail'
  activeFilter: 'all',      // 'all' | 'page' | 'text' | 'tagset' | 'image' | 'entity'
  activeTags: [],            // Array of tag objects for filtering (AND logic)
  items: [],                 // All addresses
  tags: [],                  // All tags sorted by frecency
  itemTags: new Map(),       // Map of addressId -> [tags]
  itemEntities: new Map(),   // Map of item URL -> [entity objects]
  selectedIndex: 0,
  searchQuery: '',
  editingItem: null,         // Item being viewed in detail
  tagSortBy: 'frecency',    // 'frecency' | 'name'
  tagSortDirection: 'asc',  // 'asc' | 'desc'
  managePanelOpen: false     // Whether the tag manage panel is visible
};

// Expose state for debugging
window._tagsState = state;

/**
 * Build a Map<tagId, count> by counting how many items in state.itemTags
 * carry each tag. Cheap enough to recompute per-render for typical
 * Peek datasets; callers that batch (renderTagSidebar, renderCards) reuse
 * a single map.
 */
const computeTagCounts = () => {
  const counts = new Map();
  state.itemTags.forEach(itemTags => {
    for (const t of itemTags) {
      counts.set(t.id, (counts.get(t.id) || 0) + 1);
    }
  });
  return counts;
};

// Embedded editor state
let embeddedEditor = null;  // CodeMirror EditorView instance
let embeddedStatusLine = null;  // StatusLine instance for vim status bar
let editorSaveTimer = null;
let editorSaveStatus = 'saved'; // 'saved' | 'saving' | 'unsaved'
const EDITOR_AUTOSAVE_DELAY_MS = 1500;

// Vim mode preference (read from editor extension's settings)
let editorVimMode = false;

// View preferences (persisted)
let viewPrefs = {
  viewMode: 'columns',
  sortBy: 'modified',
  sortDirection: 'desc'
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Date Created' },
  { value: 'modified', label: 'Date Modified' },
  { value: 'type', label: 'Type' }
];

// DOM elements
let searchInput;
let cardsContainer;
let tagList;
let detailView;
let gridToolbar;

/**
 * Initialize the UI
 */
const init = async () => {
  debug && console.log('[tags] Home init');

  // Initialize tag action rules cache for card affordances
  actionRulesCache = createActionRulesCache(api);

  // Cache DOM elements
  searchInput = document.querySelector('.search-input');
  cardsContainer = document.querySelector('.cards');
  tagList = document.querySelector('.tag-list');
  detailView = document.querySelector('.detail-view');
  gridToolbar = document.querySelector('.grid-toolbar');

  // Load view preferences
  await loadViewPrefs();

  // Set up toolbar
  setupToolbar();

  // Load data
  await loadData();

  // Set up event listeners
  setupEventListeners();

  // Initial render
  render();
};

/**
 * Load all data from datastore
 */
const loadData = async () => {
  // Load all items (unified: addresses, texts, tagsets, images)
  const itemsResult = await api.datastore.queryItems({});
  if (itemsResult.success) {
    state.items = itemsResult.data;
  } else {
    console.error('[tags] Failed to load items:', itemsResult.error);
    state.items = [];
  }

  // Load tags for each item
  for (const item of state.items) {
    const tagsResult = await api.datastore.getItemTags(item.id);
    if (tagsResult.success) {
      state.itemTags.set(item.id, tagsResult.data);
    }
  }

  // Load all tags by frecency
  const tagsResult = await api.datastore.getTagsByFrecency();
  if (tagsResult.success) {
    state.tags = tagsResult.data;
    debug && console.log('[tags] Loaded tags:', state.tags.length);
  } else {
    console.error('[tags] Failed to load tags:', tagsResult.error);
    state.tags = [];
  }

  // Load entity data for URL items
  await loadEntityData();

  // Update filter counts
  updateFilterCounts();
};

/**
 * Load just the tags list (for incremental updates)
 */
const loadTags = async () => {
  const tagsResult = await api.datastore.getTagsByFrecency();
  if (tagsResult.success) {
    state.tags = tagsResult.data;
    debug && console.log('[tags] Reloaded tags:', state.tags.length);
  } else {
    console.error('[tags] Failed to reload tags:', tagsResult.error);
  }
};

/**
 * Load entity data: all entities and their observations, then build a
 * mapping of item URL -> entities so we can offer entity filtering.
 */
const loadEntityData = async () => {
  state.itemEntities = new Map();

  try {
    // Load all entity items
    const entitiesResult = await api.datastore.queryItems({ type: 'entity' });
    if (!entitiesResult.success || !entitiesResult.data) return;

    const entities = entitiesResult.data.filter(e => e.deletedAt === 0);
    if (entities.length === 0) return;

    // Parse metadata for each entity
    const entityMap = new Map(); // entityId -> { ...item, _meta }
    for (const e of entities) {
      let meta = {};
      try { meta = JSON.parse(e.metadata || '{}'); } catch {}
      // Skip thumbs-down entities
      if (meta.feedback?.score === -1) continue;
      entityMap.set(e.id, { ...e, _meta: meta });
    }

    // Load observations (item_events) for all entities to build URL -> entity mapping
    const urlEntityMap = new Map(); // url -> Set of entityId
    const eventsResult = await api.datastore.queryItemEvents({ limit: 500, order: 'desc' });
    if (eventsResult.success && eventsResult.data) {
      for (const evt of eventsResult.data) {
        if (entityMap.has(evt.itemId) && evt.content) {
          if (!urlEntityMap.has(evt.content)) {
            urlEntityMap.set(evt.content, new Set());
          }
          urlEntityMap.get(evt.content).add(evt.itemId);
        }
      }
    }

    // Build item -> entities mapping based on item URLs
    for (const item of state.items) {
      const itemUrl = item.content || item.uri || '';
      if (!itemUrl) continue;

      const entityIds = urlEntityMap.get(itemUrl);
      if (!entityIds || entityIds.size === 0) continue;

      const itemEntityList = [];
      for (const eid of entityIds) {
        const entity = entityMap.get(eid);
        if (entity) {
          itemEntityList.push(entity);
        }
      }
      if (itemEntityList.length > 0) {
        state.itemEntities.set(item.id, itemEntityList);
      }
    }

    debug && console.log('[tags] Loaded entity data:', state.itemEntities.size, 'items with entities');
  } catch (err) {
    console.error('[tags] Failed to load entity data:', err);
  }
};

/**
 * Internal ESC handler for tags navigation (following groups pattern).
 * Returns { handled: true } if we navigated internally.
 * Returns { handled: false } if at root (list view) and window should close.
 *
 * Vim mode ESC cascade:
 *   1. ESC in vim insert mode -> exits to vim normal mode (handled here, not by CodeMirror
 *      because the preload intercepts ESC before the DOM keydown event fires)
 *   2. ESC in vim normal mode -> exits detail view back to tags list
 *   3. ESC in tags list -> closes window
 *
 * Without vim mode:
 *   1. ESC in editor -> exits detail view
 *   2. ESC in tags list -> closes window
 */
const handleEscape = () => {
  // If in detail view with embedded editor and vim mode is enabled,
  // check if vim is in insert mode. If so, exit insert mode instead
  // of navigating away. The preload intercepts ESC via before-input-event
  // so CodeMirror's vim extension never sees it — we must handle it here.
  if (state.currentView === VIEW_DETAIL && embeddedEditor && editorVimMode) {
    try {
      const cm = getCM(embeddedEditor);
      if (cm && cm.state && cm.state.vim) {
        const vimState = cm.state.vim;
        if (vimState.insertMode || vimState.visualMode) {
          Vim.handleKey(cm, '<Esc>');
          return { handled: true };
        }
      }
    } catch (e) {
      // vim state unavailable, fall through
    }
  }

  // If in detail view, navigate back to list
  if (state.currentView === VIEW_DETAIL) {
    // If editor has unsaved changes, flush them before leaving
    if (embeddedEditor && editorSaveStatus === 'unsaved') {
      const content = CodeMirror.getContent(embeddedEditor);
      performEditorAutosave(content);
    }
    // Use setTimeout to ensure handler returns before DOM work starts
    setTimeout(() => {
      showList();
    }, 0);
    return { handled: true };
  }

  // If search has content, clear it
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    render();
    return { handled: true };
  }

  // If tag filter is active, clear it
  if (state.activeTags.length > 0) {
    clearTagFilter();
    return { handled: true };
  }

  // If type filter is active, clear it
  if (state.activeFilter !== 'all') {
    state.activeFilter = 'all';
    state.selectedIndex = 0;
    render();
    return { handled: true };
  }

  // Nothing to clear, let window close
  return { handled: false };
};

/**
 * Load persisted view preferences
 */
const loadViewPrefs = async () => {
  try {
    const stored = localStorage.getItem('viewPrefs');
    if (stored) {
      viewPrefs = { ...viewPrefs, ...JSON.parse(stored) };
      debug && console.log('[tags] Loaded viewPrefs:', viewPrefs);
    }
  } catch (err) {
    debug && console.log('[tags] Failed to load viewPrefs:', err);
  }
};

/**
 * Save view preferences
 */
const saveViewPrefs = async () => {
  try {
    localStorage.setItem('viewPrefs', JSON.stringify(viewPrefs));
  } catch (err) {
    debug && console.log('[tags] Failed to save viewPrefs:', err);
  }
};

/**
 * Set up grid toolbar events and state
 */
const setupToolbar = () => {
  if (!gridToolbar) return;

  gridToolbar.sortOptions = SORT_OPTIONS;
  gridToolbar.sortBy = viewPrefs.sortBy;
  gridToolbar.sortDirection = viewPrefs.sortDirection;
  gridToolbar.viewMode = viewPrefs.viewMode;
  cardsContainer.viewMode = viewPrefs.viewMode;

  gridToolbar.addEventListener('sort-change', (e) => {
    viewPrefs.sortBy = e.detail.sortBy;
    viewPrefs.sortDirection = e.detail.sortDirection;
    saveViewPrefs();
    renderCards();
  });

  gridToolbar.addEventListener('view-mode-change', (e) => {
    viewPrefs.viewMode = e.detail.mode;
    cardsContainer.viewMode = e.detail.mode;
    saveViewPrefs();
    renderCards();
  });
};

/**
 * Sort items by current view preferences
 */
const sortItems = (items) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;

  return items.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name': {
        const nameA = (a.title || a.content || '').toLowerCase();
        const nameB = (b.title || b.content || '').toLowerCase();
        return dir * nameA.localeCompare(nameB);
      }
      case 'created': {
        const ca = a.createdAt || 0;
        const cb = b.createdAt || 0;
        return dir * (ca - cb);
      }
      case 'modified': {
        const ma = a.updatedAt || a.createdAt || 0;
        const mb = b.updatedAt || b.createdAt || 0;
        return dir * (ma - mb);
      }
      case 'type': {
        const typeA = (a.type || 'url').toLowerCase();
        const typeB = (b.type || 'url').toLowerCase();
        return dir * typeA.localeCompare(typeB);
      }
      default:
        return 0;
    }
  });
};

/**
 * Set up all event listeners
 */
const setupEventListeners = () => {
  // Debounced full refresh for reactive updates (collapses rapid events like batch imports)
  const debouncedRefresh = debounce(async () => {
    debug && console.log('[tags] debounced refresh triggered');
    await loadData();
    if (state.currentView === VIEW_LIST) {
      render();
    } else if (state.currentView === VIEW_DETAIL && state.editingItem) {
      // Refresh detail view with updated data, but don't re-create the editor
      // if the user is actively editing (the editor manages its own content)
      const updatedItem = state.items.find(i => i.id === state.editingItem.id);
      if (updatedItem) {
        state.editingItem = updatedItem;
        // Only refresh tags and title, not the editor content
        const tags = state.itemTags.get(updatedItem.id) || [];
        renderCurrentTags(tags);
        renderAvailableTags(tags);
        // Update the detail title display
        const { title } = getLocalItemDisplayInfo(updatedItem);
        const titleEl = detailView.querySelector('.detail-title');
        if (titleEl) titleEl.textContent = title;
      } else {
        // Item was deleted, go back to list
        showList();
      }
    }
  }, 150);

  // Subscribe to tag events for reactive updates
  api.pubsub.subscribe('tag:item-added', (msg) => {
    debug && console.log('[tags] tag:item-added event received:', msg);
    // Optimistic local update before debounced full refresh
    const currentTags = state.itemTags.get(msg.itemId) || [];
    if (!currentTags.find(t => t.id === msg.tagId)) {
      currentTags.push({ id: msg.tagId, name: msg.tagName });
      state.itemTags.set(msg.itemId, currentTags);
    }
    debouncedRefresh();
  });

  api.pubsub.subscribe('tag:item-removed', (msg) => {
    debug && console.log('[tags] tag:item-removed event received:', msg);
    // Optimistic local update
    const currentTags = state.itemTags.get(msg.itemId) || [];
    state.itemTags.set(msg.itemId, currentTags.filter(t => t.id !== msg.tagId));
    debouncedRefresh();
  });

  api.pubsub.subscribe('tag:created', (msg) => {
    debug && console.log('[tags] tag:created event received:', msg);
    // Optimistic local update
    if (!state.tags.find(t => t.id === msg.tagId)) {
      state.tags.push({ id: msg.tagId, name: msg.tagName });
    }
    debouncedRefresh();
  });

  api.pubsub.subscribe('tag:renamed', (msg) => {
    debug && console.log('[tags] tag:renamed event received:', msg);
    debouncedRefresh();
  });

  api.pubsub.subscribe('tag:deleted', (msg) => {
    debug && console.log('[tags] tag:deleted event received:', msg);
    debouncedRefresh();
  });

  // Subscribe to item events for reactive updates
  api.pubsub.subscribe('item:created', (msg) => {
    debug && console.log('[tags] item:created event received:', msg);
    debouncedRefresh();
  });

  api.pubsub.subscribe('item:deleted', (msg) => {
    debug && console.log('[tags] item:deleted event received:', msg);
    // Optimistic local update - remove deleted item from state
    state.items = state.items.filter(i => i.id !== msg.itemId);
    state.itemTags.delete(msg.itemId);
    debouncedRefresh();
  });

  api.pubsub.subscribe('item:updated', (msg) => {
    debug && console.log('[tags] item:updated event received:', msg);
    debouncedRefresh();
  });

  // Subscribe to sync events — sync operations bypass per-item events,
  // so we need this to refresh when new data arrives via sync
  api.pubsub.subscribe('sync:pull-completed', (msg) => {
    debug && console.log('[tags] sync:pull-completed event received:', msg);
    debouncedRefresh();
  });

  // Subscribe to entity extraction events to update entity filter bar
  api.pubsub.subscribe('entities:extracted', (msg) => {
    debug && console.log('[tags] entities:extracted event received:', msg);
    debouncedRefresh();
  });

  // Search input
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    render();
  });

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter;
      if (state.activeFilter === filter) {
        // Toggle off - return to 'all'
        state.activeFilter = 'all';
      } else {
        state.activeFilter = filter;
      }
      state.selectedIndex = 0;
      render();
    });
  });

  // Sidebar sort buttons
  document.querySelectorAll('.sidebar-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.sort;
      if (action === 'name') {
        // Toggle between frecency and name sort
        state.tagSortBy = state.tagSortBy === 'name' ? 'frecency' : 'name';
      } else if (action === 'direction') {
        // Toggle sort direction
        state.tagSortDirection = state.tagSortDirection === 'asc' ? 'desc' : 'asc';
      }
      renderTagSidebar();
    });
  });

  // New tag input in detail view
  const newTagInput = document.querySelector('.new-tag-input');
  const addTagBtn = document.querySelector('.add-tag-btn');

  addTagBtn.addEventListener('click', () => addNewTag(newTagInput.value));
  newTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addNewTag(newTagInput.value);
    }
  });

  // Add item button
  document.querySelector('.add-item-btn').addEventListener('click', () => {
    api.pubsub.publish('editor:add', {});
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Register escape handler (following groups pattern - extracted function, not inline)
  if (api.escape) {
    api.escape.onEscape(handleEscape);
  }

  // Listen for editor settings changes to live-reload vim mode on embedded editor
  if (api?.pubsub?.subscribe) {
    api.pubsub.subscribe('editor:settings-changed', async () => {
      debug && console.log('[tags] Editor settings changed, reloading vim mode');
      await loadEditorVimPreference();
      if (embeddedEditor) {
        CodeMirror.setVimMode(embeddedEditor, editorVimMode);
        // Show/hide status line and update container class based on vim mode
        const editorContainer = document.querySelector('.detail-editor-container');
        const statusLineEl = document.querySelector('.detail-editor-status-line');
        if (embeddedStatusLine) {
          if (editorVimMode) {
            embeddedStatusLine.show();
            embeddedStatusLine.updateMode('normal');
            if (statusLineEl) statusLineEl.style.display = '';
            if (editorContainer) editorContainer.classList.add('vim-active');
          } else {
            embeddedStatusLine.hide();
            if (statusLineEl) statusLineEl.style.display = 'none';
            if (editorContainer) editorContainer.classList.remove('vim-active');
          }
        }
        debug && console.log('[tags] Updated embedded editor vimMode:', editorVimMode);
      }
    });
  }
};

/**
 * Handle keyboard navigation
 */
const handleKeydown = (e) => {
  // If in detail view, don't process grid navigation
  // (especially important when embedded editor is focused)
  if (state.currentView === VIEW_DETAIL) {
    return;
  }

  const isSearchFocused = document.activeElement === searchInput;

  // Focus search with / or Cmd+F
  if ((e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) && !isSearchFocused) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Don't intercept when typing in search (except navigation keys)
  if (isSearchFocused && !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) {
    return;
  }

  const cards = getCards();
  if (cards.length === 0) return;

  const cols = getGridColumns(cards);

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      if (state.selectedIndex + cols < cards.length) {
        state.selectedIndex += cols;
        updateSelection();
      }
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      if (state.selectedIndex - cols >= 0) {
        state.selectedIndex -= cols;
        updateSelection();
      }
      break;
    case 'h':
    case 'ArrowLeft':
      if (isSearchFocused) return;
      e.preventDefault();
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelection();
      }
      break;
    case 'l':
    case 'ArrowRight':
      if (isSearchFocused) return;
      e.preventDefault();
      if (state.selectedIndex < cards.length - 1) {
        state.selectedIndex++;
        updateSelection();
      }
      break;
    case 'Enter':
      e.preventDefault();
      activateSelected();
      break;
    case 'x':
      if (isSearchFocused) return;
      e.preventDefault();
      {
        const selected = cards[state.selectedIndex];
        if (selected) {
          const toggleBtn = selected.querySelector('.tag-action-toggle');
          if (toggleBtn) toggleBtn.click();
        }
      }
      break;
    case 'Escape':
      if (isSearchFocused) {
        searchInput.blur();
      }
      break;
  }
};

/**
 * Get all cards in the current view
 */
const getCards = () => Array.from(document.querySelectorAll('.cards peek-card'));

/**
 * Get number of columns in the grid
 */
const getGridColumns = (cards) => {
  if (cards.length < 2) return 1;
  const firstTop = cards[0].getBoundingClientRect().top;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].getBoundingClientRect().top !== firstTop) {
      return i;
    }
  }
  return cards.length;
};

/**
 * Update visual selection on cards
 */
const updateSelection = () => {
  const cards = getCards();
  cards.forEach((card, i) => {
    card.selected = (i === state.selectedIndex);
  });

  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

/**
 * Activate the currently selected card
 */
const activateSelected = () => {
  const cards = getCards();
  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.click();
  }
};

/**
 * Show the list view (card grid), hide detail view
 */
const showList = () => {
  state.currentView = VIEW_LIST;
  state.editingItem = null;

  // Clean up embedded editor before switching views
  destroyEmbeddedEditor();

  cardsContainer.style.display = '';
  detailView.style.display = 'none';

  render();
};

// Expose for testing (Playwright escape doesn't trigger Electron before-input-event)
window.showList = showList;

/**
 * Update filter button counts
 */
const updateFilterCounts = () => {
  // Only count items that have tags (matching what getFilteredItems shows)
  const tagged = state.items.filter(item => {
    const tags = state.itemTags.get(item.id);
    return tags && tags.length > 0;
  });

  const pageCount = tagged.filter(item => !item.type || item.type === 'url' || item.uri).length;
  const textCount = tagged.filter(item => item.type === 'text').length;
  const tagsetCount = tagged.filter(item => item.type === 'tagset').length;
  const imageCount = tagged.filter(item => item.type === 'image').length;
  const entityCount = tagged.filter(item => {
    const ents = state.itemEntities.get(item.id);
    return ents && ents.length > 0;
  }).length;

  document.querySelector('[data-count="page"]').textContent = pageCount;
  document.querySelector('[data-count="text"]').textContent = textCount;
  document.querySelector('[data-count="tagset"]').textContent = tagsetCount;
  document.querySelector('[data-count="image"]').textContent = imageCount;
  document.querySelector('[data-count="entity"]').textContent = entityCount;
};

// parseSearchQuery is imported from ./search.js

/** Delegate to the pure filterItems() from search.js, passing current state. */
const getFilteredItems = () => filterItems({
  items: state.items,
  itemTags: state.itemTags,
  searchQuery: state.searchQuery,
  activeTags: state.activeTags,
  // 'entity' filter is handled separately in renderCards (not a type filter)
  activeFilter: state.activeFilter === 'entity' ? 'all' : state.activeFilter,
});

/** Delegate to the pure filterTags() from search.js, passing current state. */
const getFilteredTags = () => filterTags({
  tags: state.tags,
  searchQuery: state.searchQuery,
  activeTags: state.activeTags,
});

/**
 * Main render function
 */
const render = () => {
  renderFilterButtons();
  renderTagSidebar();
  renderSelectedTagsBar();
  renderCards();
  renderActiveTagIndicator();
  updateSearchPlaceholder();
};

/**
 * Update search placeholder based on whether tags are selected
 */
const updateSearchPlaceholder = () => {
  if (state.activeTags.length > 0) {
    searchInput.placeholder = 'Search within tagged items... (#tag for strict match)';
  } else {
    searchInput.placeholder = 'Search items... (#tag for tag filter, text for content)';
  }
};

/**
 * Render filter button active states
 */
const renderFilterButtons = () => {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const filter = btn.dataset.filter;
    btn.classList.toggle('active', state.activeFilter === filter);
  });
};

/**
 * Render active tag indicator in header.
 * Shows a compact filter count + clear button. The sidebar is the primary
 * location for selected tags (pinned to top with visual distinction).
 */
const renderActiveTagIndicator = () => {
  const indicator = document.querySelector('.active-tag-indicator');

  if (state.activeTags.length > 0) {
    indicator.innerHTML = '';

    const badge = document.createElement('span');
    badge.className = 'active-tag-badge';
    badge.textContent = `${state.activeTags.length} tag${state.activeTags.length > 1 ? 's' : ''} selected`;
    indicator.appendChild(badge);

    const clearAll = document.createElement('peek-button');
    clearAll.variant = 'ghost';
    clearAll.size = 'sm';
    clearAll.className = 'clear-all-tags';
    clearAll.textContent = 'Clear';
    clearAll.title = 'Clear all tag filters';
    clearAll.addEventListener('click', clearTagFilter);
    indicator.appendChild(clearAll);

    indicator.classList.add('visible');
  } else {
    indicator.classList.remove('visible');
    indicator.innerHTML = '';
  }
};

/**
 * Remove a single tag from active filters
 */
const removeActiveTag = (tagId) => {
  state.activeTags = state.activeTags.filter(t => t.id !== tagId);
  state.selectedIndex = 0;
  render();
};

/**
 * Clear all active tag filters
 */
const clearTagFilter = () => {
  state.activeTags = [];
  state.selectedIndex = 0;
  render();
};

/**
 * Render selected tags bar at top of the right pane.
 * Shows active tag filter chips with remove buttons, and a gear icon when a single tag is selected.
 */
const renderSelectedTagsBar = () => {
  const bar = document.querySelector('.selected-tags-bar');
  const panel = document.querySelector('.tag-manage-panel');

  if (state.activeTags.length === 0) {
    bar.classList.remove('visible');
    bar.innerHTML = '';
    panel.classList.remove('visible');
    panel.innerHTML = '';
    state.managePanelOpen = false;
    return;
  }

  bar.innerHTML = '';
  bar.classList.add('visible');

  state.activeTags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'selected-tag-chip';
    chip.innerHTML = `
      ${escapeHtml(tag.name)}
      <button class="remove-selected-tag">&times;</button>
    `;
    chip.querySelector('.remove-selected-tag').addEventListener('click', () => {
      removeActiveTag(tag.id);
    });
    bar.appendChild(chip);
  });

  // Show gear icon when exactly one tag is selected
  if (state.activeTags.length === 1) {
    const gearBtn = document.createElement('button');
    gearBtn.className = 'tag-gear-btn' + (state.managePanelOpen ? ' active' : '');
    gearBtn.title = 'Manage tag';
    gearBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
    gearBtn.addEventListener('click', () => {
      state.managePanelOpen = !state.managePanelOpen;
      gearBtn.classList.toggle('active', state.managePanelOpen);
      renderTagManagePanel();
    });
    bar.appendChild(gearBtn);
  } else {
    panel.classList.remove('visible');
    panel.innerHTML = '';
    state.managePanelOpen = false;
  }

  renderTagManagePanel();
};

/**
 * Render the tag management panel (rename / delete) for a single selected tag.
 */
const renderTagManagePanel = () => {
  const panel = document.querySelector('.tag-manage-panel');

  if (!state.managePanelOpen || state.activeTags.length !== 1) {
    panel.classList.remove('visible');
    panel.innerHTML = '';
    return;
  }

  const tag = state.activeTags[0];
  panel.innerHTML = '';
  panel.classList.add('visible');

  const input = document.createElement('input');
  input.type = 'text';
  input.value = tag.name;
  input.placeholder = 'Tag name';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'tag-manage-save';
  saveBtn.textContent = 'Rename';
  saveBtn.addEventListener('click', () => renameTagAction(tag.id, input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameTagAction(tag.id, input.value);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'tag-manage-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteTagAction(tag.id));

  panel.appendChild(input);
  panel.appendChild(saveBtn);
  panel.appendChild(deleteBtn);
};

/**
 * Rename a tag via IPC, update local state, and re-render.
 */
const renameTagAction = async (tagId, newName) => {
  newName = newName.trim();
  if (!newName) return;

  const result = await api.datastore.renameTag(tagId, newName);
  if (result.success) {
    // Update local state
    const tagInList = state.tags.find(t => t.id === tagId);
    if (tagInList) tagInList.name = newName;

    const activeTag = state.activeTags.find(t => t.id === tagId);
    if (activeTag) activeTag.name = newName;

    // Update itemTags references
    state.itemTags.forEach(tags => {
      const t = tags.find(t => t.id === tagId);
      if (t) t.name = newName;
    });

    render();
    debug && console.log('[tags] Renamed tag', tagId, 'to', newName);
  } else {
    console.error('[tags] Failed to rename tag:', result.error);
  }
};

/**
 * Delete a tag via IPC, update local state, and re-render.
 */
const deleteTagAction = async (tagId) => {
  if (!confirm('Delete this tag? It will be removed from all items.')) return;

  const result = await api.datastore.deleteTag(tagId);
  if (result.success) {
    // Remove from state
    state.tags = state.tags.filter(t => t.id !== tagId);
    state.activeTags = state.activeTags.filter(t => t.id !== tagId);
    state.managePanelOpen = false;

    // Remove from itemTags
    state.itemTags.forEach((tags, itemId) => {
      state.itemTags.set(itemId, tags.filter(t => t.id !== tagId));
    });

    state.selectedIndex = 0;
    render();
    debug && console.log('[tags] Deleted tag', tagId);
  } else {
    console.error('[tags] Failed to delete tag:', result.error);
  }
};

/**
 * Render the tag sidebar.
 * Selected tags are pinned to the top of the list with a visual separator.
 */
const renderTagSidebar = () => {
  let tags = getFilteredTags();

  // Sort tags by current preference
  if (state.tagSortBy === 'name') {
    const dir = state.tagSortDirection === 'asc' ? 1 : -1;
    tags = [...tags].sort((a, b) => dir * a.name.localeCompare(b.name));
  } else {
    // frecency (default) — already sorted by frecency from getTagsByFrecency
    if (state.tagSortDirection === 'desc') {
      tags = [...tags].reverse();
    }
  }

  // Update sort button active states
  document.querySelectorAll('.sidebar-sort-btn').forEach(btn => {
    if (btn.dataset.sort === 'name') {
      btn.classList.toggle('active', state.tagSortBy === 'name');
    }
  });

  if (tags.length === 0) {
    tagList.innerHTML = '<div class="empty-state">No tags yet</div>';
    return;
  }

  tagList.innerHTML = '';

  // Compute per-tag counts once for this render; previously each chip
  // re-iterated state.itemTags, which is O(N²) in the number of tagged items.
  const tagCounts = computeTagCounts();

  const selectedIds = new Set(state.activeTags.map(t => t.id));
  const selectedTags = tags.filter(t => selectedIds.has(t.id));
  const unselectedTags = tags.filter(t => !selectedIds.has(t.id));

  // Helper to build a tag chip
  const buildTagChip = (tag, isSelected) => {
    const count = tagCounts.get(tag.id) || 0;

    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    if (isSelected) {
      chip.classList.add('selected');
    }

    const checkIcon = isSelected
      ? '<svg class="tag-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : '';

    chip.innerHTML = `
      ${checkIcon}
      <span class="tag-name">${escapeHtml(tag.name)}</span>
      <span class="tag-count">${count}</span>
    `;

    chip.addEventListener('click', () => {
      const existingIndex = state.activeTags.findIndex(t => t.id === tag.id);
      if (existingIndex >= 0) {
        state.activeTags = state.activeTags.filter(t => t.id !== tag.id);
      } else {
        state.activeTags = [...state.activeTags, tag];
      }
      state.selectedIndex = 0;
      render();
    });

    return chip;
  };

  // Render selected tags pinned at top
  selectedTags.forEach(tag => {
    tagList.appendChild(buildTagChip(tag, true));
  });

  // Add separator between selected and unselected
  if (selectedTags.length > 0 && unselectedTags.length > 0) {
    const separator = document.createElement('div');
    separator.className = 'tag-separator';
    tagList.appendChild(separator);
  }

  // Render unselected tags
  unselectedTags.forEach(tag => {
    tagList.appendChild(buildTagChip(tag, false));
  });
};

/**
 * Render item cards
 */
const renderCards = () => {
  let items = getFilteredItems();

  // Apply entity filter: show only items that have associated entities
  if (state.activeFilter === 'entity') {
    items = items.filter(item => {
      const ents = state.itemEntities.get(item.id) || [];
      return ents.length > 0;
    });
  }

  if (items.length === 0) {
    const message = state.searchQuery
      ? 'No items match your search.'
      : state.activeTags.length > 0
        ? `No items with all selected tags.`
        : state.activeFilter === 'entity'
          ? 'No items with extracted entities.'
          : 'No tagged items yet. Tag items to see them here.';
    cardsContainer.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  // Apply sorting
  items = sortItems(items);

  cardsContainer.innerHTML = '';

  // Compute the per-tag count map once for this render — re-using it
  // across every card avoids recomputing on each chip.
  const tagCounts = computeTagCounts();
  items.forEach(item => {
    const card = createItemCard(item, tagCounts);
    cardsContainer.appendChild(card);
  });

  state.selectedIndex = Math.min(state.selectedIndex, items.length - 1);
  updateSelection();
};

/**
 * Compute display properties for an item (shared by card and detail view).
 * Delegates to the shared getItemDisplayInfo from card-helpers.js,
 * passing local state tags for this item.
 */
const getLocalItemDisplayInfo = (item) => {
  const tags = state.itemTags.get(item.id) || [];
  return getItemDisplayInfo(item, { tags });
};

/**
 * Create a card element for an item using the shared search-result-card builder.
 */
const createItemCard = (item, tagCounts) => {
  const { tags } = getLocalItemDisplayInfo(item);
  const rules = actionRulesCache ? actionRulesCache.getRules() : [];
  const counts = tagCounts || computeTagCounts();

  // Decorate tag objects with global usage count so search-result-card
  // can render the count next to the chip name.
  const tagsWithCounts = tags.map(t => ({ ...t, itemCount: counts.get(t.id) || 0 }));

  const card = createSearchResultCard(item, {
    tags: tagsWithCounts,
    showOpenButton: true,
    onOpen: (url) => openItemUrl(url),
    onDelete: async (item) => {
      if (!confirm(`Delete "${item.title || item.content || 'this item'}"?`)) return;
      await api.datastore.deleteItem(item.id);
      loadData().then(() => renderCards());
    },
    onTagRemove: async (item, tag) => {
      await api.datastore.untagItem(item.id, tag.id);
      loadData().then(() => renderCards());
    },
    onTagClick: (tag) => {
      const existingIndex = state.activeTags.findIndex(t => t.id === tag.id);
      if (existingIndex >= 0) {
        state.activeTags = state.activeTags.filter(t => t.id !== tag.id);
      } else {
        state.activeTags = [...state.activeTags, tag];
      }
      state.selectedIndex = 0;
      render();
    },
    affordances: rules.length > 0 ? {
      rules,
      api,
      onToggle: () => { loadData().then(() => renderCards()); }
    } : null,
  });

  // Click on card to open inline detail view (card-click, not raw click for tag chips)
  card.addEventListener('click', (e) => {
    // If clicking a tag chip, the onTagClick handler already handles it via stopPropagation
    if (e.target.classList.contains('card-tag')) return;
    // Show inline detail view
    showDetailView(item);
  });

  return card;
};

/**
 * Update the save status indicator in the detail editor
 */
const updateEditorSaveStatus = () => {
  const statusEl = document.querySelector('.detail-save-status');
  if (!statusEl) return;

  statusEl.className = `detail-save-status detail-save-status-${editorSaveStatus}`;
  switch (editorSaveStatus) {
    case 'saved':
      statusEl.textContent = 'Saved';
      break;
    case 'saving':
      statusEl.textContent = 'Saving...';
      break;
    case 'unsaved':
      statusEl.textContent = 'Unsaved';
      break;
  }
};

/**
 * Extract a title from the first line of content.
 * Strips leading markdown heading markers (e.g., "# Title" -> "Title").
 */
const extractTitleFromContent = (content) => {
  if (!content) return '';
  const firstLine = content.split('\n')[0].trim();
  return firstLine.replace(/^#+\s*/, '');
};

/**
 * Perform autosave of the embedded editor content to the datastore
 */
const performEditorAutosave = async (content) => {
  if (!state.editingItem || !api?.datastore?.updateItem) return;

  editorSaveStatus = 'saving';
  updateEditorSaveStatus();

  try {
    // Extract title from first line and save alongside content
    const title = extractTitleFromContent(content);
    const result = await api.datastore.updateItem(state.editingItem.id, { content, title });
    if (result.success) {
      editorSaveStatus = 'saved';
      debug && console.log('[tags] Editor autosaved item:', state.editingItem.id, 'title:', title);

      // Update local item state so list view reflects changes
      state.editingItem.content = content;
      state.editingItem.title = title;
      const idx = state.items.findIndex(i => i.id === state.editingItem.id);
      if (idx >= 0) {
        state.items[idx].content = content;
        state.items[idx].title = title;
      }

      // Update the detail view title display
      const titleEl = document.querySelector('.detail-title');
      if (titleEl) {
        titleEl.textContent = title || content.substring(0, 100) || 'Untitled';
      }

      // Publish change event for other extensions
      if (api?.pubsub?.publish) {
        api.pubsub.publish('editor:changed', { action: 'update', itemId: state.editingItem.id });
      }
    } else {
      console.error('[tags] Editor autosave failed:', result.error);
      editorSaveStatus = 'unsaved';
    }
  } catch (err) {
    console.error('[tags] Editor autosave error:', err);
    editorSaveStatus = 'unsaved';
  }

  updateEditorSaveStatus();
};

/**
 * Schedule an autosave with debouncing for the embedded editor
 */
const scheduleEditorAutosave = (content) => {
  editorSaveStatus = 'unsaved';
  updateEditorSaveStatus();

  if (editorSaveTimer) {
    clearTimeout(editorSaveTimer);
  }

  editorSaveTimer = setTimeout(() => {
    performEditorAutosave(content);
  }, EDITOR_AUTOSAVE_DELAY_MS);
};

/**
 * Load vim mode preference from the editor extension's settings.
 * Uses the cross-extension settings read API (api.settings.getExtKey).
 */
const loadEditorVimPreference = async () => {
  try {
    if (api?.settings?.getExtKey) {
      const result = await api.settings.getExtKey('editor', 'prefs');
      if (result.success && result.data && typeof result.data === 'object') {
        editorVimMode = !!result.data.vimMode;
        debug && console.log('[tags] Loaded editor vimMode preference:', editorVimMode);
      } else {
        debug && console.log('[tags] No editor prefs found, using default vimMode:', editorVimMode);
      }
    }
  } catch (err) {
    debug && console.log('[tags] Failed to load editor vim preference:', err);
  }
};

/**
 * Create the embedded CodeMirror editor for a text item
 */
const createEmbeddedEditor = async (item) => {
  destroyEmbeddedEditor();

  const container = document.querySelector('.detail-editor-container');
  if (!container) return;

  // Clear the container
  container.innerHTML = '';

  // Load vim mode preference from editor extension before creating editor
  await loadEditorVimPreference();

  // Create status line container inside the editor container (overlays bottom)
  const statusLineContainer = document.createElement('div');
  statusLineContainer.className = 'detail-editor-status-line';
  container.appendChild(statusLineContainer);

  // Create status line (vim status bar)
  embeddedStatusLine = new StatusLine({ container: statusLineContainer });
  if (editorVimMode) {
    container.classList.add('vim-active');
  } else {
    embeddedStatusLine.hide();
    statusLineContainer.style.display = 'none';
  }

  embeddedEditor = CodeMirror.createEditor({
    parent: container,
    content: item.content || '',
    vimMode: editorVimMode,
    showLineNumbers: true,
    onChange: (content) => {
      scheduleEditorAutosave(content);
    },
    onSelectionChange: (line, col) => {
      if (embeddedStatusLine) {
        embeddedStatusLine.updatePosition(line, col);
      }
    },
    onVimModeChange: (mode) => {
      if (embeddedStatusLine && editorVimMode) {
        embeddedStatusLine.updateMode(mode);
      }
    },
  });

  editorSaveStatus = 'saved';
  updateEditorSaveStatus();

  // Focus the editor after a short delay to let layout settle
  setTimeout(() => {
    if (embeddedEditor) CodeMirror.focus(embeddedEditor);
  }, 100);
};

/**
 * Destroy the embedded CodeMirror editor instance and clean up
 */
const destroyEmbeddedEditor = () => {
  if (editorSaveTimer) {
    clearTimeout(editorSaveTimer);
    editorSaveTimer = null;
  }

  if (embeddedStatusLine) {
    embeddedStatusLine.destroy();
    embeddedStatusLine = null;
  }

  // Remove the status line container element if it exists
  const statusLineEl = document.querySelector('.detail-editor-status-line');
  if (statusLineEl) {
    statusLineEl.remove();
  }

  if (embeddedEditor) {
    CodeMirror.destroy(embeddedEditor);
    embeddedEditor = null;
  }

  editorSaveStatus = 'saved';
};

/**
 * Show the inline detail view for an item (replaces card grid)
 */
const showDetailView = (item) => {
  state.currentView = VIEW_DETAIL;
  state.editingItem = item;

  const { tags, itemType, itemUrl, title, subtitle, faviconUrl } = getLocalItemDisplayInfo(item);

  // Hide card grid, show detail view
  cardsContainer.style.display = 'none';
  detailView.style.display = '';

  // Set header info
  detailView.querySelector('.detail-favicon').src = faviconUrl;
  const titleEl = detailView.querySelector('.detail-title');
  titleEl.textContent = title;
  detailView.querySelector('.detail-url').textContent = subtitle;

  // Build actions row
  const actionsEl = detailView.querySelector('.detail-actions');
  actionsEl.innerHTML = '';

  if (itemUrl) {
    const openPageBtn = document.createElement('peek-button');
    openPageBtn.variant = 'primary';
    openPageBtn.size = 'sm';
    openPageBtn.innerHTML = `
      <svg slot="prefix" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
        <polyline points="15 3 21 3 21 9"></polyline>
        <line x1="10" y1="14" x2="21" y2="3"></line>
      </svg>
      Open Page
    `;
    openPageBtn.addEventListener('click', () => openItemUrl(itemUrl));
    actionsEl.appendChild(openPageBtn);
  }

  // Show embedded editor for text items
  const editorSection = detailView.querySelector('.detail-editor-section');
  if (itemType === 'text') {
    editorSection.style.display = '';
    createEmbeddedEditor(item);
  } else {
    editorSection.style.display = 'none';
  }

  // Render current tags
  renderCurrentTags(tags);

  // Render available tags
  renderAvailableTags(tags);

  // Clear new tag input
  document.querySelector('.new-tag-input').value = '';
};

/**
 * Render current tags in detail view
 */
const renderCurrentTags = (tags) => {
  const container = document.querySelector('.current-tags');

  if (tags.length === 0) {
    container.innerHTML = '<span class="no-tags">No tags</span>';
    return;
  }

  container.innerHTML = '';

  tags.forEach(tag => {
    const tagEl = document.createElement('span');
    tagEl.className = 'current-tag';
    tagEl.innerHTML = `
      ${escapeHtml(tag.name)}
      <button class="remove-tag" data-tag-id="${tag.id}">&times;</button>
    `;

    tagEl.querySelector('.remove-tag').addEventListener('click', () => removeTag(tag));

    container.appendChild(tagEl);
  });
};

/**
 * Render available tags in detail view
 */
const renderAvailableTags = (currentTags) => {
  const container = document.querySelector('.available-tags');
  const currentTagIds = new Set(currentTags.map(t => t.id));

  container.innerHTML = '';

  state.tags.forEach(tag => {
    const tagEl = document.createElement('span');
    tagEl.className = 'available-tag';
    if (currentTagIds.has(tag.id)) {
      tagEl.classList.add('already-added');
    }
    tagEl.textContent = tag.name;

    if (!currentTagIds.has(tag.id)) {
      tagEl.addEventListener('click', () => addTag(tag));
    }

    container.appendChild(tagEl);
  });

  if (state.tags.length === 0) {
    container.innerHTML = '<span class="no-tags">No tags available</span>';
  }
};

/**
 * Add a tag to the current item
 */
const addTag = async (tag) => {
  if (!state.editingItem) return;

  const result = await api.datastore.tagItem(state.editingItem.id, tag.id);
  if (result.success) {
    // Update local state
    const tags = state.itemTags.get(state.editingItem.id) || [];
    if (!tags.some(t => t.id === tag.id)) {
      tags.push(tag);
      state.itemTags.set(state.editingItem.id, tags);
    }

    // Re-render detail view tags
    renderCurrentTags(tags);
    renderAvailableTags(tags);
  } else {
    console.error('[tags] Failed to add tag:', result.error);
  }
};

/**
 * Remove a tag from the current item
 */
const removeTag = async (tag) => {
  if (!state.editingItem) return;

  const result = await api.datastore.untagItem(state.editingItem.id, tag.id);
  if (result.success) {
    // Update local state
    let tags = state.itemTags.get(state.editingItem.id) || [];
    tags = tags.filter(t => t.id !== tag.id);
    state.itemTags.set(state.editingItem.id, tags);

    // Re-render detail view tags
    renderCurrentTags(tags);
    renderAvailableTags(tags);

    // Re-render sidebar
    renderTagSidebar();
  } else {
    console.error('[tags] Failed to remove tag:', result.error);
  }
};

/**
 * Add a new tag (create if needed) to the current item
 */
const addNewTag = async (tagName) => {
  tagName = tagName.trim();
  if (!tagName || !state.editingItem) return;

  // Get or create tag
  const tagResult = await api.datastore.getOrCreateTag(tagName);
  if (!tagResult.success) {
    console.error('[tags] Failed to create tag:', tagResult.error);
    return;
  }

  const tag = tagResult.data.tag;

  // If it's a new tag, add to our tags list
  if (tagResult.data.created) {
    state.tags.unshift(tag); // Add to beginning (most recent)
  }

  // Add tag to item
  await addTag(tag);

  // Clear input
  document.querySelector('.new-tag-input').value = '';

  // Re-render sidebar to show new tag
  renderTagSidebar();
};

/**
 * Escape HTML special characters
 */
const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
