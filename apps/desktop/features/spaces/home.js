/**
 * Spaces Home - Shows space tags (space: prefixed) and their items
 *
 * Spaces are implemented using tags with a "space:" prefix:
 * - Each "space" is a tag named "space:Name"
 * - Items in a space are items tagged with that tag
 * - Creating a new space creates a new "space:" prefixed tag
 * - Viewing a space shows all items with that tag
 * - Opening items from a space sets space mode context
 */

import {
  updateSelection as _updateSelection, activateSelected as _activateSelected,
  createKeydownHandler,
  setupToolbar as _setupToolbar,
  createViewPrefs
} from 'peek://app/lib/grid-nav.js';
import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';
import { liveQuery } from 'peek://app/lib/live-query.js';
import { createGhostCard } from 'peek://app/lib/ghost-card.js';
import { attachPinBadge } from 'peek://app/lib/pin-badge.js';
import {
  resolveVividColor, countSpaceWindows, liveSpaceWindowIds, formatWindowCount, initialSelectedIndex, urlsFromDrop,
  deleteSpaceConfirmText, deleteSpaceNameFromQuery, SPACES_CHROME_URL_PREFIXES
} from './config.js';

const api = window.app;

const SPACE_PREFIX = 'space:';

// ===== Active Theme (for the vivid-color fallback palette) =====
//
// `resolveVividColor` draws its fallback from the active theme's palette, so
// every caller has to pass the same theme or two callers produce two different
// accents for one space. This page is not a display-only caller: `loadSpaces()`
// PERSISTS what it resolves onto the tag, and a persisted color has enough
// chroma that every later resolution keeps it. So whichever of this page and
// `background.js resolveSpaceBorderColor()` resolves a space first decides that
// space's accent permanently — resolving against the wrong palette here made the
// accent depend on whether the browse-all list had rendered the space before it
// was entered, which is the entry-order dependence the accent is supposed to be
// free of.
let activeThemeId = 'peek';

/**
 * Read the active theme before the first `loadSpaces()`, awaited rather than
 * fire-and-forget. `background.js` can read it in the background because it
 * only ever recomputes a border color; here a color resolved from the wrong
 * palette is written to the tag and outlives the correction.
 */
const loadActiveThemeId = async () => {
  try {
    const info = await api.theme.getInfo();
    if (info?.themeId) activeThemeId = info.themeId;
  } catch {
    // Keep the built-in default palette.
  }
};

/**
 * Check if a URL is a navigable web URL (http/https only)
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

/**
 * Get the display name of a space tag (strip "space:" prefix)
 */
const getSpaceDisplayName = (tag) => {
  if (tag.name && tag.name.startsWith(SPACE_PREFIX)) {
    return tag.name.substring(SPACE_PREFIX.length);
  }
  return tag.name;
};

// View states
const VIEW_SPACES = 'spaces';
const VIEW_ITEMS = 'items';

// View preferences (persisted)
const { prefs: viewPrefs, load: loadViewPrefs, save: saveViewPrefs } = createViewPrefs('spacesViewPrefs', {
  viewMode: 'columns',
  sortBy: 'name',
  sortDirection: 'asc'
});

const SORT_OPTIONS_SPACES = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Count' },
  { value: 'recent', label: 'Recent' }
];

const SORT_OPTIONS_ITEMS = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Visits' },
  { value: 'recent', label: 'Recent' }
];

let state = {
  view: VIEW_SPACES,
  spaces: [],
  currentSpace: null,
  items: [],
  selectedIndex: 0,
  searchQuery: '',
  lastViewedSpaceId: null
};

// Expose state for debugging
window._spacesState = state;

/**
 * Sort spaces by current view preferences
 */
const sortSpaces = (spaces) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return spaces.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name':
        return dir * getSpaceDisplayName(a).localeCompare(getSpaceDisplayName(b));
      case 'count': {
        const ca = a.windowCount || 0;
        const cb = b.windowCount || 0;
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

/**
 * Sort items by current view preferences
 */
const sortItems = (items) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return items.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name': {
        const na = (a.title || a.uri || a.content || '').toLowerCase();
        const nb = (b.title || b.uri || b.content || '').toLowerCase();
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

/**
 * Internal ESC handler
 */
const handleEscape = () => {
  const searchInput = document.querySelector('peek-input.search-input');
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    renderCurrentView();
    return { handled: true };
  }

  if (state.view === VIEW_ITEMS) {
    setTimeout(() => {
      showSpaces().catch(err => {
        console.error('[spaces] Error navigating back:', err);
      });
    }, 0);
    return { handled: true };
  }
  return { handled: false };
};

/**
 * Wrappers around shared grid-nav functions
 */
const updateSelection = () => _updateSelection(state);
const activateSelected = () => _activateSelected(state);

const handleKeydown = createKeydownHandler(state, {
  shouldIgnore: (e) => {
    const newSpaceInput = document.querySelector('peek-input.new-space-input');
    const isNewSpaceFocused = document.activeElement === newSpaceInput ||
      (newSpaceInput && newSpaceInput.shadowRoot?.activeElement);
    if (isNewSpaceFocused) return true;

    const searchInput = document.querySelector('peek-input.search-input');
    const isSearchFocused = document.activeElement === searchInput ||
      (searchInput && searchInput.shadowRoot?.activeElement);

    if ((e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) && !isSearchFocused) {
      e.preventDefault();
      searchInput.focus();
      return true;
    }
    return false;
  },
  isInputFocused: () => {
    const searchInput = document.querySelector('peek-input.search-input');
    return document.activeElement === searchInput ||
      !!(searchInput && searchInput.shadowRoot?.activeElement);
  }
});

const setupToolbar = () => {
  _setupToolbar({
    viewPrefs,
    sortOptions: SORT_OPTIONS_SPACES,
    onSave: saveViewPrefs,
    onRender: renderCurrentView
  });
};

const updateToolbarSortOptions = () => {
  const toolbar = document.querySelector('.grid-toolbar');
  if (!toolbar) return;
  toolbar.sortOptions = state.view === VIEW_SPACES ? SORT_OPTIONS_SPACES : SORT_OPTIONS_ITEMS;
};

let activeSpaceId = null;

/**
 * The workspace this window belongs to: its own `mode` context's space id,
 * else the space that has windows open (only the active workspace does).
 */
const resolveActiveSpaceId = async (spaceTags) => {
  try {
    const m = await api.context.getMode();
    const id = m?.success && m.data?.value === 'space' ? m.data.metadata?.spaceId : null;
    if (id != null && spaceTags.some(t => String(t.id) === String(id))) return id;
  } catch { /* fall through */ }
  return spaceTags.find(t => t.hasLiveWindows)?.id ?? null;
};

/**
 * Load all space tags (filtered to space: prefix)
 */
const loadSpaces = async () => {
  const result = await api.datastore.getTagsByFrecency();
  if (result.success) {
    // Filter to only space: prefixed tags
    const spaceTags = result.data.filter(tag => tag.name && tag.name.startsWith(SPACE_PREFIX));

    // Count items per space
    for (const tag of spaceTags) {
      const itemsResult = await api.datastore.getItemsByTag(tag.id);
      if (itemsResult.success) {
        tag.itemCount = itemsResult.data.filter(item =>
          item.type === 'url' && isWebUrl(item.content)
        ).length;
      } else {
        tag.itemCount = 0;
      }
    }
    // Count windows per space: live windows plus those still held for another
    // desktop for the active workspace, else the saved snapshot. Spaces chrome
    // never counts. A space with no saved snapshot yet (the default before it
    // is first left) has no count.
    let windowList = [];
    try {
      const r = await api.window.list();
      if (r?.success && Array.isArray(r.windows)) windowList = r.windows;
    } catch { /* leave empty */ }
    const liveByTag = new Map();
    for (const tag of spaceTags) {
      let tagged = [];
      try {
        const r = await api.context.getWindowsInSpace(tag.id);
        if (r?.success && Array.isArray(r.data)) tagged = r.data;
      } catch { /* leave empty */ }
      const live = liveSpaceWindowIds(tagged, windowList);
      liveByTag.set(tag.id, live);
      tag.hasLiveWindows = live.length > 0;
    }
    // Resolved between the passes: its fallback reads `hasLiveWindows`, and the
    // active space's count must skip the snapshot.
    activeSpaceId = await resolveActiveSpaceId(spaceTags);
    for (const tag of spaceTags) {
      const live = liveByTag.get(tag.id);
      const isActive = activeSpaceId != null && String(tag.id) === String(activeSpaceId);
      // The default workspace's snapshot is stored under the key 'default';
      // every other space under its tag id.
      const key = getSpaceDisplayName(tag) === 'default' ? 'default' : tag.id;
      let heldCount = 0;
      try {
        const r = await api.session.getHeldWindowCount(key, SPACES_CHROME_URL_PREFIXES);
        if (r?.success && typeof r.count === 'number') heldCount = r.count;
      } catch { /* none held */ }
      let snapshotCount = null;
      if (!isActive && live.length === 0 && heldCount === 0) {
        try {
          const r = await api.session.getWorkspaceSnapshotWindowCount(key, SPACES_CHROME_URL_PREFIXES);
          if (r?.success && typeof r.count === 'number') snapshotCount = r.count;
        } catch { /* no snapshot */ }
      }
      tag.windowCount = countSpaceWindows(live, snapshotCount, getSpaceDisplayName(tag) === 'default', heldCount, isActive);
    }
    // Resolve vivid colors for spaces with default/grey color
    for (const tag of spaceTags) {
      const vivid = resolveVividColor(tag.color, tag.id, activeThemeId);
      if (vivid !== tag.color) {
        tag.color = vivid;
        api.datastore.updateTagColor(tag.id, vivid);
      }
    }

    state.spaces = spaceTags;
  } else {
    console.error('[spaces] Failed to load spaces:', result.error);
    state.spaces = [];
  }
};

/**
 * Normalize URL for dedup
 */
const normalizeUrlForCompare = (url) => {
  try {
    const u = new URL(url);
    let normalized = u.protocol + '//' + u.hostname.toLowerCase();
    if (u.port && u.port !== '80' && u.port !== '443') normalized += ':' + u.port;
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    normalized += path + u.search + u.hash;
    return normalized;
  } catch {
    return url;
  }
};

const deduplicateByUrl = (items) => {
  const seen = new Map();
  for (const item of items) {
    const normalized = normalizeUrlForCompare(item.content);
    const existing = seen.get(normalized);
    if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
      seen.set(normalized, item);
    }
  }
  return Array.from(seen.values());
};

/**
 * Load items for a specific space tag
 */
const loadItemsForSpace = async (tagId) => {
  const result = await api.datastore.getItemsByTag(tagId);
  if (result.success) {
    const urlItems = result.data.filter(item =>
      item.type === 'url' && isWebUrl(item.content)
    );
    state.items = deduplicateByUrl(urlItems);
  } else {
    console.error('[spaces] Failed to load items:', result.error);
    state.items = [];
  }
};

const filterSpaces = (spaces) => {
  if (!state.searchQuery) return spaces;
  const q = state.searchQuery.toLowerCase();
  return spaces.filter(tag => getSpaceDisplayName(tag).toLowerCase().includes(q));
};

const filterItems = (items) => {
  if (!state.searchQuery) return items;
  const q = state.searchQuery.toLowerCase();
  return items.filter(item => {
    const url = item.uri || item.content || '';
    return (item.title || '').toLowerCase().includes(q) ||
      url.toLowerCase().includes(q);
  });
};

/**
 * Create inline sort controls
 */
const addInlineSortControls = (container) => {
  if (!container) return;
  const existing = container.querySelector('.inline-sort-controls');
  if (existing) existing.remove();

  const controls = document.createElement('div');
  controls.className = 'inline-sort-controls';

  const sortWrapper = document.createElement('div');
  sortWrapper.className = 'inline-sort-wrapper';

  const select = document.createElement('select');
  select.className = 'inline-sort-select';
  SORT_OPTIONS_ITEMS.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === viewPrefs.sortBy) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener('change', () => {
    viewPrefs.sortBy = select.value;
    saveViewPrefs();
    renderCurrentView();
  });
  sortWrapper.appendChild(select);

  const arrow = document.createElement('svg');
  arrow.className = 'inline-sort-arrow';
  arrow.setAttribute('width', '10');
  arrow.setAttribute('height', '10');
  arrow.setAttribute('viewBox', '0 0 10 10');
  arrow.setAttribute('fill', 'none');
  arrow.innerHTML = '<path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  sortWrapper.appendChild(arrow);

  controls.appendChild(sortWrapper);

  const dirBtn = document.createElement('button');
  dirBtn.className = 'inline-sort-dir-btn';
  dirBtn.title = viewPrefs.sortDirection === 'asc' ? 'Ascending' : 'Descending';
  const updateDirIcon = () => {
    dirBtn.title = viewPrefs.sortDirection === 'asc' ? 'Ascending' : 'Descending';
    dirBtn.innerHTML = viewPrefs.sortDirection === 'asc'
      ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11V3M7 3L4 6M7 3L10 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3V11M7 11L4 8M7 11L10 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  };
  updateDirIcon();
  dirBtn.addEventListener('click', () => {
    viewPrefs.sortDirection = viewPrefs.sortDirection === 'asc' ? 'desc' : 'asc';
    saveViewPrefs();
    updateDirIcon();
    renderCurrentView();
  });
  controls.appendChild(dirBtn);

  container.appendChild(controls);
};

/**
 * Set up create space UI
 */
let openCreateSpaceForm = () => {};

const setupCreateSpace = () => {
  const createBtn = document.querySelector('.create-space-btn');
  const form = document.querySelector('.create-space-form');
  const newSpaceInput = document.querySelector('.new-space-input');
  const cancelBtn = document.querySelector('.create-space-cancel');
  const submitBtn = document.querySelector('.create-space-submit');

  if (!createBtn || !form) return;

  const showForm = () => {
    form.style.display = '';
    newSpaceInput.value = '';
    setTimeout(() => newSpaceInput.focus(), 50);
  };

  const hideForm = () => {
    form.style.display = 'none';
    newSpaceInput.value = '';
  };

  const submitSpace = async () => {
    const name = (newSpaceInput.value || '').trim();
    if (!name) return;

    // Prepend space: prefix if not already present
    const tagName = name.startsWith(SPACE_PREFIX) ? name : SPACE_PREFIX + name;

    try {
      const result = await api.datastore.getOrCreateTag(tagName);
      if (result.success) {
        hideForm();
        await loadSpaces();
        renderSpaces();
      } else {
        console.error('[spaces] Failed to create space:', result.error);
      }
    } catch (err) {
      console.error('[spaces] Error creating space:', err);
    }
  };

  openCreateSpaceForm = showForm;
  createBtn.addEventListener('click', showForm);
  cancelBtn.addEventListener('click', hideForm);
  submitBtn.addEventListener('click', submitSpace);
  newSpaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSpace();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideForm();
    }
  });
};

const renderCurrentView = () => {
  if (state.view === VIEW_SPACES) {
    renderSpaces();
  } else {
    renderItems();
  }
};

/**
 * Show the spaces list view
 */
const showSpaces = async () => {
  if (state.currentSpace) {
    state.lastViewedSpaceId = state.currentSpace.id;
  }
  state.view = VIEW_SPACES;
  state.currentSpace = null;
  state.searchQuery = '';

  await loadSpaces();

  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.value = '';
  searchInput.placeholder = 'Search spaces...';

  const createBtn = document.querySelector('.create-space-btn');
  if (createBtn) createBtn.style.display = '';

  const toolbar = document.querySelector('peek-grid-toolbar.grid-toolbar');
  if (toolbar) toolbar.style.display = '';

  const inlineSort = document.querySelector('.inline-sort-controls');
  if (inlineSort) inlineSort.remove();

  renderSpaces();
};

window.showSpaces = showSpaces;

/**
 * Render space cards
 */
const renderSpaces = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';
  updateToolbarSortOptions();

  renderSpaceHeader();

  let filteredSpaces = filterSpaces([...state.spaces]);
  filteredSpaces = sortSpaces(filteredSpaces);

  if (filteredSpaces.length === 0) {
    const message = state.searchQuery
      ? 'No spaces match your search.'
      : 'No spaces yet. Create one with the + button above.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
  } else {
    filteredSpaces.forEach(space => {
      const card = createSpaceCard(space);
      container.appendChild(card);
    });
  }

  // The "+" card opens the same name form as the header "+" button.
  container.appendChild(createGhostCard({
    title: 'New space',
    onClick: () => openCreateSpaceForm()
  }));

  if (state.lastViewedSpaceId) {
    const cards = Array.from(container.querySelectorAll('peek-card'));
    const targetIndex = cards.findIndex(card => card.dataset.tagId === String(state.lastViewedSpaceId));
    state.selectedIndex = targetIndex >= 0 ? targetIndex : 0;
    state.lastViewedSpaceId = null;
  } else {
    state.selectedIndex = initialSelectedIndex(
      Array.from(container.querySelectorAll('peek-card')).map(card => card.dataset.tagId),
      activeSpaceId
    );
  }
  updateSelection();
};

/**
 * Show items in a space
 */
const showItems = async (space) => {
  state.view = VIEW_ITEMS;
  state.currentSpace = space;
  state.searchQuery = '';

  await loadItemsForSpace(space.id);

  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.value = '';
  searchInput.placeholder = `Search in ${getSpaceDisplayName(space)}...`;

  const createBtn = document.querySelector('.create-space-btn');
  const createForm = document.querySelector('.create-space-form');
  if (createBtn) createBtn.style.display = 'none';
  if (createForm) createForm.style.display = 'none';

  const toolbar = document.querySelector('peek-grid-toolbar.grid-toolbar');
  if (toolbar) toolbar.style.display = 'none';

  const searchRow = document.querySelector('.search-row');
  addInlineSortControls(searchRow);

  renderItems();
};

/**
 * Render the space detail header
 */
const renderSpaceHeader = () => {
  const header = document.querySelector('body > .space-detail-header');
  if (!header) return;

  const space = state.currentSpace;
  if (!space) {
    header.style.display = 'none';
    header.innerHTML = '';
    return;
  }

  header.style.display = '';
  header.innerHTML = '';

  const nameEl = document.createElement('span');
  nameEl.className = 'space-header-name';
  nameEl.textContent = getSpaceDisplayName(space);
  nameEl.title = 'Double-click to rename';
  nameEl.addEventListener('dblclick', () => startRenameSpace(header, space));
  header.appendChild(nameEl);

  // Rename button + color dot
  const renameBtn = document.createElement('button');
  renameBtn.className = 'space-rename-btn';
  renameBtn.title = 'Rename space';
  renameBtn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
    '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>' +
    '</svg>';
  renameBtn.addEventListener('click', () => startRenameSpace(header, space));
  header.appendChild(renameBtn);

  const colorDot = document.createElement('div');
  colorDot.className = 'space-header-color-dot';
  colorDot.style.backgroundColor = space.color || '#999';
  colorDot.title = 'Change space color';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'space-header-color-input';
  colorInput.value = space.color || '#999999';
  colorInput.addEventListener('input', (e) => {
    colorDot.style.backgroundColor = e.target.value;
  });
  colorInput.addEventListener('change', async (e) => {
    const newColor = e.target.value;
    space.color = newColor;
    await api.datastore.updateTagColor(space.id, newColor);
  });

  colorDot.addEventListener('click', () => colorInput.click());
  colorDot.appendChild(colorInput);
  header.appendChild(colorDot);

  // Spacer
  const spacer = document.createElement('div');
  spacer.className = 'space-header-spacer';
  header.appendChild(spacer);

  // View mode buttons
  const viewModes = document.createElement('div');
  viewModes.className = 'space-header-view-modes';

  const modes = [
    { mode: 'columns', title: 'Grid view', svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>' },
    { mode: 'list', title: 'List view', svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="11" x2="13" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' },
  ];

  modes.forEach(({ mode, title, svg }) => {
    const btn = document.createElement('button');
    btn.className = 'shvm-btn' + (viewPrefs.viewMode === mode ? ' active' : '');
    btn.title = title;
    btn.innerHTML = svg;
    btn.addEventListener('click', () => {
      viewPrefs.viewMode = mode;
      saveViewPrefs();
      const grid = document.querySelector('peek-grid.cards');
      if (grid) grid.setAttribute('view-mode', mode);
      renderSpaceHeader();
      renderCurrentView();
    });
    viewModes.appendChild(btn);
  });

  header.appendChild(viewModes);
};

/**
 * Start inline rename of a space
 */
const startRenameSpace = (headerEl, space) => {
  const nameEl = headerEl.querySelector('.space-header-name');
  const renameBtn = headerEl.querySelector('.space-rename-btn');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.className = 'space-rename-input';
  input.type = 'text';
  input.value = getSpaceDisplayName(space);

  const finishRename = async (commit) => {
    const newDisplayName = input.value.trim();
    if (commit && newDisplayName && newDisplayName !== getSpaceDisplayName(space)) {
      const newTagName = SPACE_PREFIX + newDisplayName;
      try {
        const result = await api.datastore.renameTag(space.id, newTagName);
        if (result.success) {
          space.name = newTagName;
          const searchInput = document.querySelector('peek-input.search-input');
          searchInput.placeholder = `Search in ${newDisplayName}...`;
        } else {
          console.error('[spaces] Failed to rename space:', result.error);
        }
      } catch (err) {
        console.error('[spaces] Error renaming space:', err);
      }
    }
    nameEl.textContent = getSpaceDisplayName(space);
    nameEl.style.display = '';
    input.remove();
    if (renameBtn) renameBtn.style.display = '';
  };

  nameEl.style.display = 'none';
  if (renameBtn) renameBtn.style.display = 'none';
  headerEl.insertBefore(input, nameEl.nextSibling);
  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishRename(false);
    }
  });
  input.addEventListener('blur', () => finishRename(true));
};

/**
 * Render item cards
 */
const renderItems = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';
  updateToolbarSortOptions();

  renderSpaceHeader();

  let filteredItems = filterItems(state.items);

  if (filteredItems.length === 0) {
    const message = state.searchQuery
      ? 'No pages match your search.'
      : 'No pages in this space yet.';
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.textContent = message;
    container.appendChild(emptyEl);
    return;
  }

  filteredItems = sortItems(filteredItems);

  filteredItems.forEach(item => {
    const card = createItemCard(item);
    container.appendChild(card);
  });

  state.selectedIndex = 0;
  updateSelection();
};

/**
 * Create a card for a space
 */
const createSpaceCard = (space) => {
  const card = document.createElement('peek-card');
  card.className = 'space-card';
  card.interactive = true;
  card.dataset.tagId = space.id;

  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  const colorDot = document.createElement('div');
  colorDot.className = 'color-dot';
  colorDot.style.backgroundColor = space.color || '#999';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = getSpaceDisplayName(space);
  title.style.margin = '0';
  title.style.flex = '1';
  title.style.minWidth = '0';

  header.appendChild(colorDot);
  header.appendChild(title);

  // The default space cannot be deleted, so its card has no delete control.
  if (getSpaceDisplayName(space) !== 'default') {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'card-delete-btn space-delete-btn';
    deleteBtn.title = `Delete space ${getSpaceDisplayName(space)}`;
    deleteBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="18" y1="6" x2="6" y2="18"></line>' +
      '<line x1="6" y1="6" x2="18" y2="18"></line>' +
      '</svg>';
    deleteBtn.addEventListener('click', (e) => {
      // Not a card click: that would switch to the space.
      e.stopPropagation();
      confirmDeleteSpace(getSpaceDisplayName(space), space.windowCount);
    });
    header.appendChild(deleteBtn);
  }

  card.appendChild(header);

  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  footer.textContent = formatWindowCount(space.windowCount);
  card.appendChild(footer);

  card.addEventListener('card-click', () => activateSpace(space));

  return card;
};

/**
 * Click or Enter on a space card: switch to that workspace.
 * Activation goes through the same `switch space` command the palette
 * uses — one path into `background.js openSpace()`, not a parallel one.
 * `grid-nav.js activateSelected()` implements Enter as a `.click()` on the
 * selected card, so both gestures land here. The in-window item view
 * (`showItems`) is no longer reachable from here: it rendered empty for a
 * non-empty space.
 */
const activateSpace = (space) => {
  api.pubsub.publish('cmd:execute:switch space', {
    search: getSpaceDisplayName(space),
    params: [getSpaceDisplayName(space)],
  });
};

/**
 * Ask before deleting a space, then send the deletion through the same
 * `delete space` command the palette uses (`background.js deleteSpace()`),
 * marked as answered so the background does not ask again. The list
 * re-renders from the `tag:deleted` the deletion produces.
 */
const confirmDeleteSpace = (spaceName, windowCount) => {
  if (!confirm(deleteSpaceConfirmText(spaceName, windowCount))) return false;
  api.pubsub.publish('cmd:execute:delete space', {
    search: spaceName,
    params: [spaceName],
    confirmed: true,
  });
  return true;
};

/**
 * `delete space <name>` from the command panel opens this page with the
 * space's name in the address (`deleteSpacePromptUrl`), since only a page can
 * ask the question. Asked once, after the spaces have loaded so the window
 * count is known.
 */
const askDeleteFromAddress = () => {
  const name = deleteSpaceNameFromQuery(window.location.search);
  if (!name) return;
  const lower = name.toLowerCase();
  const space = state.spaces.find((s) => getSpaceDisplayName(s).trim().toLowerCase() === lower);
  confirmDeleteSpace(space ? getSpaceDisplayName(space) : name, space ? space.windowCount : null);
};

/**
 * Create a card for an item in a space
 */
/**
 * The `spaceMode` a window opened from the browsed space's item list is born
 * with. Its color is the space's resolved accent — the same
 * `resolveVividColor` fallback `background.js openSpace()` persists — not
 * the tag's raw stored color: a space whose tag is still grey (never entered
 * through `switch space`) would otherwise put grey windows next to a
 * vivid border, and the accent would depend on which happened first. The
 * active theme is passed for the same reason `loadSpaces()` passes it (see the
 * Active Theme note at the top of this file) — the two resolvers have to agree
 * on the palette, not just on the space.
 */
const spaceModeFor = (space) => {
  if (!space) return undefined;
  return {
    spaceId: space.id,
    spaceName: getSpaceDisplayName(space),
    color: resolveVividColor(space.color, space.id, activeThemeId),
  };
};

/**
 * Open a page as a member of `space`. The workspace on screen takes the page
 * as a normal window. Any other space has no windows open, so the page is
 * opened hidden, written into that space's saved windows (the same steps as
 * `background.js moveToSpace()` for an inactive target) and closed again; it
 * reappears when the space is next entered.
 */
const openUrlInSpace = async (space, url) => {
  const inactive = String(space.id) !== String(activeSpaceId);
  const result = await api.window.open(url, {
    role: 'content',
    key: url,
    width: 1024,
    height: 768,
    spaceMode: spaceModeFor(space),
    ...(inactive ? { show: false } : {})
  });
  if (!result?.success || !inactive || result.id == null) return result;

  // The default workspace's snapshot is stored under the key 'default'.
  const snapshotKey = getSpaceDisplayName(space) === 'default' ? 'default' : space.id;
  const added = await api.session.addWindowToWorkspaceSnapshot(snapshotKey, result.id);
  // A window already open on this address was reused rather than created: it
  // belongs to the space on screen, so it is saved into the other space too
  // but left open.
  if (!result.reused) await api.window.close(result.id);
  if (!added?.success) {
    console.error('[spaces] Failed to add dropped page to space:', added?.error);
    return { success: false, error: added?.error };
  }
  return result;
};

const DROP_TYPES = ['text/uri-list', 'text/x-moz-url', 'text/plain'];
const DROP_HIGHLIGHT_CLASS = 'drop-target';

const dragCarriesUrls = (e) => {
  const types = Array.from(e.dataTransfer?.types || []);
  return DROP_TYPES.some((t) => types.includes(t));
};

/**
 * The space a drop lands in: the card under the cursor, else the space whose
 * pages are being viewed. `element` is the highlighted node (or null).
 */
const dropTargetFor = (e) => {
  const card = e.target?.closest?.('.space-card');
  if (card) {
    const space = state.spaces.find((s) => String(s.id) === card.dataset.tagId);
    if (space) return { space, element: card };
  }
  if (state.view === VIEW_ITEMS && state.currentSpace) {
    return { space: state.currentSpace, element: document.querySelector('.cards') };
  }
  return { space: null, element: null };
};

const clearDropHighlight = () => {
  document.querySelectorAll(`.${DROP_HIGHLIGHT_CLASS}`).forEach((el) => el.classList.remove(DROP_HIGHLIGHT_CLASS));
};

const setupUrlDrop = () => {
  document.addEventListener('dragover', (e) => {
    if (!dragCarriesUrls(e)) return;
    const { space, element } = dropTargetFor(e);
    clearDropHighlight();
    if (!space) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    element.classList.add(DROP_HIGHLIGHT_CLASS);
  });

  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) clearDropHighlight();
  });

  document.addEventListener('drop', async (e) => {
    clearDropHighlight();
    if (!dragCarriesUrls(e)) return;
    const { space } = dropTargetFor(e);
    if (!space) return;
    e.preventDefault();
    const urls = urlsFromDrop({
      uriList: e.dataTransfer.getData('text/uri-list'),
      mozUrl: e.dataTransfer.getData('text/x-moz-url'),
      plain: e.dataTransfer.getData('text/plain')
    });
    for (const url of urls) {
      try {
        await openUrlInSpace(space, url);
      } catch (err) {
        console.error('[spaces] Failed to open dropped page:', url, err);
      }
    }
    if (urls.length > 0) api.pubsub.publish('spaces:membership-changed', { spaceId: space.id });
  });
};

const createItemCard = (item) => {
  const itemUrl = item.uri || item.content;

  const card = createSearchResultCard(item, {
    className: 'address-card',
    visitCount: item.visitCount,
    showOpenButton: isWebUrl(itemUrl),
    onOpen: (url) => {
      // Open with space mode context
      api.window.open(url, {
        role: 'content',
        key: url,
        width: 1024,
        height: 768,
        spaceMode: spaceModeFor(state.currentSpace)
      });
    },
    onDelete: async (deleteItem) => {
      if (!confirm(`Delete "${deleteItem.title || deleteItem.content || 'this item'}"?`)) return;
      try {
        await api.datastore.deleteItem(deleteItem.id);
        api.pubsub.publish('item:deleted', { id: deleteItem.id });
        if (state.currentSpace) { await loadItemsForSpace(state.currentSpace.id); renderItems(); }
      } catch (err) {
        console.error('[spaces] Failed to delete item:', err);
      }
    },
    onClick: async () => {
      // Open with space mode context so the window enters space mode
      const openOptions = {
        role: 'content',
        key: itemUrl,
        width: 1024,
        height: 768,
        spaceMode: spaceModeFor(state.currentSpace)
      };
      await api.window.open(itemUrl, openOptions);
    }
  });

  card.dataset.itemId = item.id;

  // Add remove-from-space button
  if (state.currentSpace) {
    const header = card.querySelector('[slot="header"]');
    if (header) {
      let btnGroup = header.querySelector('.card-btn-group');
      if (!btnGroup) {
        btnGroup = document.createElement('span');
        btnGroup.className = 'card-btn-group';
        header.appendChild(btnGroup);
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'card-remove-space-btn';
      removeBtn.title = `Remove from ${getSpaceDisplayName(state.currentSpace)}`;
      removeBtn.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<line x1="18" y1="6" x2="6" y2="18"></line>' +
        '<line x1="6" y1="6" x2="18" y2="18"></line>' +
        '</svg>';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api.datastore.untagItem(item.id, state.currentSpace.id);
          api.pubsub.publish('tag:item-removed', { itemId: item.id, tagId: state.currentSpace.id });
          if (state.currentSpace) { await loadItemsForSpace(state.currentSpace.id); renderItems(); }
        } catch (err) {
          console.error('[spaces] Failed to remove item from space:', err);
        }
      });
      const deleteBtn = btnGroup.querySelector('.card-delete-btn');
      if (deleteBtn) {
        btnGroup.insertBefore(removeBtn, deleteBtn);
      } else {
        btnGroup.appendChild(removeBtn);
      }
    }
  }

  return card;
};

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
    console.log('[ext:spaces] see-through state unavailable:', error);
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

const init = async () => {

  if (api.escape) api.escape.onEscape(handleEscape);

  // Pinned windows draw their own badge — see the pin-badge module header.
  // A window is only badged once IT is pinned (via the "pin to this
  // workspace" / "pin across workspaces" palette commands), so this is a
  // no-op most of the time.
  attachPinBadge(api);

  loadViewPrefs();
  setupToolbar();

  // A later theme switch has to reach the accent resolvers below, or a space
  // first listed after the switch would still be resolved against the palette
  // this page started with.
  api.theme.onChange?.((info) => {
    if (info?.kind === 'theme' && info.themeId) activeThemeId = info.themeId;
  });

  // Awaited before the first resolve: loadSpaces() persists what it resolves.
  await loadActiveThemeId();
  await loadSpaces();

  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderCurrentView();
  });

  document.addEventListener('keydown', handleKeydown);

  // One reload at a time: events that land while one is running (a space
  // restore opens many windows) collapse into a single rerun after it.
  let refreshing = false;
  let refreshAgain = false;
  async function refreshSpaces() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        await loadSpaces();
        if (state.view === VIEW_SPACES) {
          renderSpaces();
        } else if (state.view === VIEW_ITEMS && state.currentSpace) {
          await loadItemsForSpace(state.currentSpace.id);
          renderItems();
        }
      } while (refreshAgain);
    } finally {
      refreshing = false;
    }
  }

  liveQuery({
    api,
    topics: [
      'tag:item-added',
      'tag:item-removed',
      'tag:created',
      'tag:deleted',
      'tag:renamed',
      'tag:color-changed',
      'item:created',
      'item:deleted',
      'item:updated',
      'sync:pull-completed',
      'spaces:membership-changed',
      // The window count on each card follows the open windows.
      'window:opened',
      'window:closed',
    ],
    runImmediately: false,
    onUpdate: refreshSpaces,
  });

  setupCreateSpace();
  setupUrlDrop();

  // Make sure the default workspace exists before the list renders for the
  // first time. The tag is created by the feature's lazy background tile
  // (`background.js bootstrapDefaultSpace()`), and this page is opened by a
  // declarative `window` command that cannot wake it (see the
  // `spaces:ensure-default` subscriber in background.js). Published after
  // the live query above is subscribed: the datastore announces the new tag
  // as `tag:created`, which re-renders the list through that query.
  api.pubsub.publish('spaces:ensure-default', {});

  await showSpaces();

  // The view is drawn; a spec can wait for this rather than for a card count.
  document.body.dataset.ready = 'true';

  askDeleteFromAddress();
};

// home.js loads via a dynamic `import()` awaited after `window.app.initialize()`
// (see home.html's bottom script) — slow enough, under load, that
// DOMContentLoaded can already have fired by the time this module's top
// level runs. A plain `addEventListener('DOMContentLoaded', init)` then
// never calls `init` at all: the event already happened, and this listener
// missed it (silently — no error, just a home page that never populates).
// On module evaluation, ahead of `init()` and of its first await, so a switch
// flipped while the view is still loading is not missed. `<body>` already
// exists: this module is imported from a script at the end of the body.
setupSeeThrough();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
