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
const { getCM, Vim } = CodeMirror;

const api = window.app;
const debug = api?.debug;

// View states (following groups pattern)
const VIEW_LIST = 'list';
const VIEW_DETAIL = 'detail';

/**
 * Extract the first URL from a text string.
 * @param {string} text - The text to search for URLs
 * @returns {string|null} The first URL found, or null
 */
const extractUrl = (text) => {
  if (!text) return null;
  const trimmed = text.trim();
  // Check if the entire content is a URL (with protocol)
  if (/^https?:\/\//i.test(trimmed)) {
    try { new URL(trimmed); return trimmed; } catch (e) { /* fall through */ }
  }
  // Check if it looks like a bare domain
  if (/^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/\S*)?$/.test(trimmed)) {
    try { new URL('https://' + trimmed); return 'https://' + trimmed; } catch (e) { /* not valid */ }
  }
  // Search for a URL embedded in the text
  const match = trimmed.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (match) { try { new URL(match[0]); return match[0]; } catch (e) { /* not valid */ } }
  return null;
};

/**
 * Open a URL in a new page window (same webview mechanism as URL items).
 * Routes through peek://page which provides the webview container.
 * @param {string} url - The URL to open
 */
const openItemUrl = async (url) => {
  try {
    await api.window.open(url, {
      role: 'content',
      width: 800,
      height: 600,
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
  activeFilter: 'all',      // 'all' | 'page' | 'text' | 'tagset' | 'image'
  activeTags: [],            // Array of tag objects for filtering (AND logic)
  items: [],                 // All addresses
  tags: [],                  // All tags sorted by frecency
  itemTags: new Map(),       // Map of addressId -> [tags]
  selectedIndex: 0,
  searchQuery: '',
  editingItem: null          // Item being viewed in detail
};

// Expose state for debugging
window._tagsState = state;

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
  console.log('[tags] Loading items...');
  const itemsResult = await api.datastore.queryItems({});
  console.log('[tags] queryItems result:', itemsResult.success, 'count:', itemsResult.data?.length);
  if (itemsResult.success) {
    state.items = itemsResult.data;
    console.log('[tags] Loaded items:', state.items.length);
    // Log first few items for debugging
    state.items.slice(0, 3).forEach((item, i) => {
      console.log(`[tags] Item ${i}:`, item.id, item.type, item.content?.substring(0, 50));
    });
  } else {
    console.error('[tags] Failed to load items:', itemsResult.error);
    state.items = [];
  }

  // Load tags for each item
  console.log('[tags] Loading tags for', state.items.length, 'items...');
  for (const item of state.items) {
    const tagsResult = await api.datastore.getItemTags(item.id);
    if (tagsResult.success) {
      state.itemTags.set(item.id, tagsResult.data);
      if (tagsResult.data.length > 0) {
        console.log('[tags] Item', item.id, 'has tags:', tagsResult.data.map(t => t.name).join(', '));
      }
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
  console.log('[tags:esc] handleEscape called, view:', state.currentView, 'searchQuery:', state.searchQuery);

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
          console.log('[tags:esc] Vim in insert/visual mode, sending <Esc> to vim');
          Vim.handleKey(cm, '<Esc>');
          return { handled: true };
        }
        // In normal mode, fall through to exit detail view
        console.log('[tags:esc] Vim in normal mode, will exit detail view');
      }
    } catch (e) {
      console.log('[tags:esc] Could not check vim state:', e);
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
    console.log('[tags:esc] VIEW_DETAIL -> navigating to list, returning handled: true');
    return { handled: true };
  }

  // If search has content, clear it
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    render();
    console.log('[tags:esc] Cleared search, returning handled: true');
    return { handled: true };
  }

  // If tag filter is active, clear it
  if (state.activeTags.length > 0) {
    clearTagFilter();
    console.log('[tags:esc] Cleared tag filter, returning handled: true');
    return { handled: true };
  }

  // If type filter is active, clear it
  if (state.activeFilter !== 'all') {
    state.activeFilter = 'all';
    state.selectedIndex = 0;
    render();
    console.log('[tags:esc] Cleared type filter, returning handled: true');
    return { handled: true };
  }

  // Nothing to clear, let window close
  console.log('[tags:esc] At root (VIEW_LIST), returning handled: false');
  return { handled: false };
};

/**
 * Load persisted view preferences
 */
const loadViewPrefs = async () => {
  try {
    if (api?.settings?.getKey) {
      const result = await api.settings.getKey('viewPrefs');
      if (result.success && result.data) {
        viewPrefs = { ...viewPrefs, ...result.data };
        debug && console.log('[tags] Loaded viewPrefs:', viewPrefs);
      }
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
    if (api?.settings?.setKey) {
      await api.settings.setKey('viewPrefs', viewPrefs);
    }
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
        const { title } = getItemDisplayInfo(updatedItem);
        const titleEl = detailView.querySelector('.detail-title');
        if (titleEl) titleEl.textContent = title;
      } else {
        // Item was deleted, go back to list
        showList();
      }
    }
  }, 150);

  // Subscribe to tag events for reactive updates
  api.subscribe('tag:item-added', (msg) => {
    debug && console.log('[tags] tag:item-added event received:', msg);
    // Optimistic local update before debounced full refresh
    const currentTags = state.itemTags.get(msg.itemId) || [];
    if (!currentTags.find(t => t.id === msg.tagId)) {
      currentTags.push({ id: msg.tagId, name: msg.tagName });
      state.itemTags.set(msg.itemId, currentTags);
    }
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('tag:item-removed', (msg) => {
    debug && console.log('[tags] tag:item-removed event received:', msg);
    // Optimistic local update
    const currentTags = state.itemTags.get(msg.itemId) || [];
    state.itemTags.set(msg.itemId, currentTags.filter(t => t.id !== msg.tagId));
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('tag:created', (msg) => {
    debug && console.log('[tags] tag:created event received:', msg);
    // Optimistic local update
    if (!state.tags.find(t => t.id === msg.tagId)) {
      state.tags.push({ id: msg.tagId, name: msg.tagName });
    }
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Subscribe to item events for reactive updates
  api.subscribe('item:created', (msg) => {
    debug && console.log('[tags] item:created event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('item:deleted', (msg) => {
    debug && console.log('[tags] item:deleted event received:', msg);
    // Optimistic local update - remove deleted item from state
    state.items = state.items.filter(i => i.id !== msg.itemId);
    state.itemTags.delete(msg.itemId);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('item:updated', (msg) => {
    debug && console.log('[tags] item:updated event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

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
    api.publish('editor:add', {}, api.scopes.GLOBAL);
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Register escape handler (following groups pattern - extracted function, not inline)
  if (api.escape) {
    api.escape.onEscape(handleEscape);
  }

  // Listen for editor settings changes to live-reload vim mode on embedded editor
  if (api?.subscribe) {
    api.subscribe('editor:settings-changed', async () => {
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
    }, api.scopes.GLOBAL);
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
  const pageCount = state.items.filter(item => !item.type || item.type === 'url' || item.uri).length;
  const textCount = state.items.filter(item => item.type === 'text').length;
  const tagsetCount = state.items.filter(item => item.type === 'tagset').length;
  const imageCount = state.items.filter(item => item.type === 'image').length;

  document.querySelector('[data-count="page"]').textContent = pageCount;
  document.querySelector('[data-count="text"]').textContent = textCount;
  document.querySelector('[data-count="tagset"]').textContent = tagsetCount;
  document.querySelector('[data-count="image"]').textContent = imageCount;
};

/**
 * Filter items based on current state.
 *
 * Search behaviour:
 *   - Search query filters items by content, title, URL, domain, AND tag names.
 *   - When tags are selected, items must have ALL selected tags (AND logic)
 *     AND match the search query against content/title/URL/tags.
 */
const getFilteredItems = () => {
  let items = [...state.items];

  // Filter by type
  if (state.activeFilter !== 'all') {
    items = items.filter(item => {
      const itemType = item.type || (item.uri ? 'url' : null);
      if (state.activeFilter === 'page') {
        return itemType === 'url' || !itemType;
      }
      return itemType === state.activeFilter;
    });
  }

  // Filter by active tags (AND logic - item must have ALL selected tags)
  if (state.activeTags.length > 0) {
    items = items.filter(item => {
      const tags = state.itemTags.get(item.id) || [];
      const tagIds = new Set(tags.map(t => t.id));
      return state.activeTags.every(activeTag => tagIds.has(activeTag.id));
    });
  }

  // Filter by search query - searches content, title, URL, domain, and tag names
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase().trim();
    if (q.length > 0) {
      items = items.filter(item => {
        // Search item content fields
        const content = (item.content || '').toLowerCase();
        const title = (item.title || '').toLowerCase();
        const uri = (item.uri || '').toLowerCase();
        const domain = (item.domain || '').toLowerCase();

        if (content.includes(q) || title.includes(q) || uri.includes(q) || domain.includes(q)) {
          return true;
        }

        // Also search tag names on the item
        const tags = state.itemTags.get(item.id) || [];
        return tags.some(t => t.name.toLowerCase().includes(q));
      });
    }
  }

  return items;
};

/**
 * Filter tags based on search query.
 * When tags are selected, don't filter the tag list by search (search applies to items instead).
 * Selected tags are always included regardless of search filter.
 */
const getFilteredTags = () => {
  if (!state.searchQuery || state.activeTags.length > 0) return state.tags;
  const q = state.searchQuery.toLowerCase();
  const selectedIds = new Set(state.activeTags.map(t => t.id));
  return state.tags.filter(tag =>
    selectedIds.has(tag.id) || tag.name.toLowerCase().includes(q)
  );
};

/**
 * Main render function
 */
const render = () => {
  renderFilterButtons();
  renderTagSidebar();
  renderCards();
  renderActiveTagIndicator();
  updateSearchPlaceholder();
};

/**
 * Update search placeholder based on whether tags are selected
 */
const updateSearchPlaceholder = () => {
  if (state.activeTags.length > 0) {
    searchInput.placeholder = 'Search within tagged items...';
  } else {
    searchInput.placeholder = 'Search content, titles, and tags...';
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
 * Render the tag sidebar.
 * Selected tags are pinned to the top of the list with a visual separator.
 */
const renderTagSidebar = () => {
  const tags = getFilteredTags();

  if (tags.length === 0) {
    tagList.innerHTML = '<div class="empty-state">No tags yet</div>';
    return;
  }

  tagList.innerHTML = '';

  const selectedIds = new Set(state.activeTags.map(t => t.id));
  const selectedTags = tags.filter(t => selectedIds.has(t.id));
  const unselectedTags = tags.filter(t => !selectedIds.has(t.id));

  // Helper to build a tag chip
  const buildTagChip = (tag, isSelected) => {
    // Count items with this tag
    let count = 0;
    state.itemTags.forEach(itemTags => {
      if (itemTags.some(t => t.id === tag.id)) count++;
    });

    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    if (isSelected) {
      chip.classList.add('selected');
    }

    const checkIcon = isSelected
      ? '<svg class="tag-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
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

  if (items.length === 0) {
    const message = state.searchQuery
      ? 'No items match your search.'
      : state.activeTags.length > 0
        ? `No items with all selected tags.`
        : 'No saved items yet.';
    cardsContainer.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  // Apply sorting
  items = sortItems(items);

  cardsContainer.innerHTML = '';

  items.forEach(item => {
    const card = createItemCard(item);
    cardsContainer.appendChild(card);
  });

  state.selectedIndex = Math.min(state.selectedIndex, items.length - 1);
  updateSelection();
};

/**
 * Compute display properties for an item (shared by card and detail view)
 */
const getItemDisplayInfo = (item) => {
  const tags = state.itemTags.get(item.id) || [];
  const isAddress = !!item.uri;
  const itemType = item.type || 'url';
  const noteUrl = (itemType === 'text') ? extractUrl(item.content) : null;

  let title, subtitle, faviconUrl;

  if (isAddress) {
    title = item.title || item.uri;
    subtitle = item.uri;
    faviconUrl = item.favicon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
  } else {
    if (itemType === 'url') {
      title = item.content;
      subtitle = item.content;
      faviconUrl = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
    } else if (itemType === 'text') {
      title = item.title || (item.content || '').substring(0, 100) + ((item.content || '').length > 100 ? '...' : '');
      if (noteUrl) {
        subtitle = noteUrl;
        faviconUrl = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔗</text></svg>';
      } else {
        subtitle = 'Text';
        faviconUrl = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📝</text></svg>';
      }
    } else if (itemType === 'tagset') {
      title = 'Tag Set';
      subtitle = tags.length > 0 ? tags.map(t => t.name).join(', ') : 'Empty tagset';
      faviconUrl = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏷️</text></svg>';
    } else if (itemType === 'image') {
      title = item.content || 'Image';
      subtitle = 'Image';
      faviconUrl = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🖼️</text></svg>';
    }
  }

  const itemUrl = isAddress ? item.uri : (itemType === 'url') ? item.content : noteUrl;

  return { tags, isAddress, itemType, noteUrl, title, subtitle, faviconUrl, itemUrl };
};

/**
 * Create a card element for an item
 */
const createItemCard = (item) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.dataset.itemId = item.id;

  const { tags, itemUrl, title, subtitle, faviconUrl } = getItemDisplayInfo(item);

  // Build the open button for items with URLs (both url type and notes with URLs)
  const openBtnHtml = itemUrl
    ? `<button class="card-open-btn" data-url="${escapeHtml(itemUrl)}" title="Open page">` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>` +
      `<polyline points="15 3 21 3 21 9"></polyline>` +
      `<line x1="10" y1="14" x2="21" y2="3"></line>` +
      `</svg></button>`
    : '';

  card.innerHTML = `
    <div class="card-header">
      <img class="card-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌐</text></svg>'">
      <div class="card-content">
        <div class="card-title">${escapeHtml(title)}</div>
        <div class="card-url">${escapeHtml(subtitle)}</div>
      </div>
      ${openBtnHtml}
    </div>
    <div class="card-tags">
      ${tags.map(tag => `<span class="card-tag" data-tag-id="${tag.id}">${escapeHtml(tag.name)}</span>`).join('')}
    </div>
  `;

  // Click handler for the open button - opens the URL as a web page
  const openBtn = card.querySelector('.card-open-btn');
  if (openBtn) {
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = openBtn.dataset.url;
      if (url) openItemUrl(url);
    });
  }

  // Click on card to open inline detail view
  card.addEventListener('click', (e) => {
    // If clicking a tag, add it to filter (toggle behavior)
    if (e.target.classList.contains('card-tag')) {
      const tagId = parseInt(e.target.dataset.tagId, 10);
      const tag = state.tags.find(t => t.id === tagId);
      if (tag) {
        const existingIndex = state.activeTags.findIndex(t => t.id === tagId);
        if (existingIndex >= 0) {
          state.activeTags = state.activeTags.filter(t => t.id !== tagId);
        } else {
          state.activeTags = [...state.activeTags, tag];
        }
        state.selectedIndex = 0;
        render();
      }
      return;
    }

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
      if (api?.publish) {
        api.publish('editor:changed', { action: 'update', itemId: state.editingItem.id }, api.scopes.GLOBAL);
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

  const { tags, itemType, itemUrl, title, subtitle, faviconUrl } = getItemDisplayInfo(item);

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
