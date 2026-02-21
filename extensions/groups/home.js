/**
 * Groups - Tag-based grouping of addresses
 *
 * Groups are implemented using tags:
 * - Each "group" is a tag
 * - Addresses in a group are addresses tagged with that tag
 * - Creating a new group creates a new tag
 * - Viewing a group shows all addresses with that tag
 */

const api = window.app;
const debug = api.debug;

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

/**
 * Check if a URL is a navigable web URL (http/https only)
 * Excludes peek:// and other internal URLs
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

// View states
const VIEW_GROUPS = 'groups';
const VIEW_ADDRESSES = 'addresses';

// Special pseudo-tag for untagged addresses
const UNTAGGED_GROUP = {
  id: '__untagged__',
  name: 'Untagged',
  color: '#666666',
  frequency: 0,
  isSpecial: true
};

// View preferences (persisted)
let viewPrefs = {
  viewMode: 'columns',
  sortBy: 'name',
  sortDirection: 'asc'
};

const SORT_OPTIONS_GROUPS = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Count' },
  { value: 'recent', label: 'Recent' }
];

const SORT_OPTIONS_ADDRESSES = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Visits' },
  { value: 'recent', label: 'Recent' }
];

let state = {
  view: VIEW_GROUPS,
  tags: [],
  currentTag: null,
  addresses: [],
  untaggedCount: 0,
  selectedIndex: 0,
  searchQuery: '',
  showAllTags: false
};

// Expose state for debugging in tests
window._groupsState = state;

/**
 * Parse tag metadata JSON safely
 */
const parseTagMetadata = (tag) => {
  if (!tag.metadata) return {};
  if (typeof tag.metadata === 'object') return tag.metadata;
  try {
    return JSON.parse(tag.metadata);
  } catch {
    return {};
  }
};

/**
 * Check if a tag is promoted to a group (has isGroup: true in metadata)
 */
const isGroupTag = (tag) => {
  const meta = parseTagMetadata(tag);
  return meta.isGroup === true;
};

/**
 * Promote a tag to a group by setting isGroup: true in its metadata
 */
const promoteTagToGroup = async (tag) => {
  const meta = parseTagMetadata(tag);
  meta.isGroup = true;
  const metadataStr = JSON.stringify(meta);
  try {
    await api.datastore.setRow('tags', tag.id, {
      ...tag,
      metadata: metadataStr
    });
    tag.metadata = metadataStr;
    debug && console.log('[groups] Promoted tag to group:', tag.name);
    return true;
  } catch (err) {
    console.error('[groups] Failed to promote tag to group:', err);
    return false;
  }
};

/**
 * Internal ESC handler for groups navigation
 * Returns { handled: true } if we navigated internally
 * Returns { handled: false } if at root (groups list) and window should close
 */
const handleEscape = () => {
  console.log('[groups:esc] handleEscape called, view:', state.view, 'searchQuery:', state.searchQuery);

  // If search has content, clear it first
  const searchInput = document.querySelector('peek-input.search-input');
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    renderCurrentView();
    console.log('[groups:esc] Cleared search, returning handled: true');
    return { handled: true };
  }

  if (state.view === VIEW_ADDRESSES) {
    // Navigate back to groups list
    // Use setTimeout to ensure handler returns before async work starts
    setTimeout(() => {
      showGroups().catch(err => {
        console.error('[groups] Error navigating back to groups:', err);
      });
    }, 0);
    console.log('[groups:esc] VIEW_ADDRESSES -> navigating to groups, returning handled: true');
    return { handled: true };
  }
  // At root (groups list) - let window close
  console.log('[groups:esc] At root (VIEW_GROUPS), returning handled: false');
  return { handled: false };
};

/**
 * Get all cards in the current view
 */
const getCards = () => {
  return Array.from(document.querySelectorAll('.cards peek-card'));
};

/**
 * Update visual selection on cards
 */
const updateSelection = () => {
  const cards = getCards();
  cards.forEach((card, i) => {
    card.selected = (i === state.selectedIndex);
  });

  // Focus and scroll selected card into view
  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.focus();
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
 * Get number of columns in the grid based on card positions
 */
const getGridColumns = (cards) => {
  if (cards.length < 2) return 1;
  const firstTop = cards[0].getBoundingClientRect().top;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].getBoundingClientRect().top !== firstTop) {
      return i;
    }
  }
  return cards.length; // All on one row
};

/**
 * Handle keyboard navigation (vim-style hjkl for grid movement)
 */
const handleKeydown = (e) => {
  const searchInput = document.querySelector('peek-input.search-input');
  // Check if search input or its internal input is focused
  const isSearchFocused = document.activeElement === searchInput ||
    (searchInput && searchInput.shadowRoot?.activeElement);

  // Check if the create-group input is focused — if so, let all keys through
  const newGroupInput = document.querySelector('peek-input.new-group-input');
  const isNewGroupFocused = document.activeElement === newGroupInput ||
    (newGroupInput && newGroupInput.shadowRoot?.activeElement);
  if (isNewGroupFocused) return;

  // Focus search with / or Cmd+F
  if ((e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) && !isSearchFocused) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Don't intercept when typing in search (except arrow keys and enter)
  if (isSearchFocused && !['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
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
      if (isSearchFocused) return; // Let cursor move in search
      e.preventDefault();
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelection();
      }
      break;
    case 'l':
    case 'ArrowRight':
      if (isSearchFocused) return; // Let cursor move in search
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
  }
};

/**
 * Load persisted view preferences
 */
const loadViewPrefs = async () => {
  try {
    const stored = localStorage.getItem('viewPrefs');
    if (stored) {
      viewPrefs = { ...viewPrefs, ...JSON.parse(stored) };
      debug && console.log('[groups] Loaded viewPrefs:', viewPrefs);
    }
  } catch (err) {
    debug && console.log('[groups] Failed to load viewPrefs:', err);
  }
};

/**
 * Save view preferences
 */
const saveViewPrefs = async () => {
  try {
    localStorage.setItem('viewPrefs', JSON.stringify(viewPrefs));
  } catch (err) {
    debug && console.log('[groups] Failed to save viewPrefs:', err);
  }
};

/**
 * Set up grid toolbar events and state
 */
const setupToolbar = () => {
  const toolbar = document.querySelector('.grid-toolbar');
  const container = document.querySelector('.cards');
  if (!toolbar) return;

  toolbar.sortOptions = SORT_OPTIONS_GROUPS;
  toolbar.sortBy = viewPrefs.sortBy;
  toolbar.sortDirection = viewPrefs.sortDirection;
  toolbar.viewMode = viewPrefs.viewMode;
  container.viewMode = viewPrefs.viewMode;

  toolbar.addEventListener('sort-change', (e) => {
    viewPrefs.sortBy = e.detail.sortBy;
    viewPrefs.sortDirection = e.detail.sortDirection;
    saveViewPrefs();
    renderCurrentView();
  });

  toolbar.addEventListener('view-mode-change', (e) => {
    viewPrefs.viewMode = e.detail.mode;
    container.viewMode = e.detail.mode;
    saveViewPrefs();
    renderCurrentView();
  });
};

/**
 * Update toolbar sort options based on current view
 */
const updateToolbarSortOptions = () => {
  const toolbar = document.querySelector('.grid-toolbar');
  if (!toolbar) return;
  toolbar.sortOptions = state.view === VIEW_GROUPS ? SORT_OPTIONS_GROUPS : SORT_OPTIONS_ADDRESSES;
};

/**
 * Sort groups by current view preferences
 */
const sortGroups = (groups) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return groups.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name':
        return dir * (a.name || '').localeCompare(b.name || '');
      case 'count': {
        const ca = a.isSpecial ? (a.frequency || 0) : (a.addressCount || 0);
        const cb = b.isSpecial ? (b.frequency || 0) : (b.addressCount || 0);
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
 * Sort addresses by current view preferences
 */
const sortAddresses = (addresses) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return addresses.sort((a, b) => {
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
 * Set up create group UI (button, form, submit/cancel)
 */
const setupCreateGroup = () => {
  const createBtn = document.querySelector('.create-group-btn');
  const form = document.querySelector('.create-group-form');
  const newGroupInput = document.querySelector('.new-group-input');
  const cancelBtn = document.querySelector('.create-group-cancel');
  const submitBtn = document.querySelector('.create-group-submit');

  if (!createBtn || !form) return;

  const showForm = () => {
    form.style.display = '';
    newGroupInput.value = '';
    setTimeout(() => newGroupInput.focus(), 50);
  };

  const hideForm = () => {
    form.style.display = 'none';
    newGroupInput.value = '';
  };

  const submitGroup = async () => {
    const name = (newGroupInput.value || '').trim();
    if (!name) return;

    try {
      const result = await api.datastore.getOrCreateTag(name);
      if (result.success) {
        debug && console.log('[groups] Created new group (tag):', name, result.data);
        // Mark the tag as a group
        const tag = result.data.tag;
        await promoteTagToGroup(tag);
        hideForm();
        // Refresh groups list
        await loadTags();
        renderGroups();
      } else {
        console.error('[groups] Failed to create group:', result.error);
      }
    } catch (err) {
      console.error('[groups] Error creating group:', err);
    }
  };

  createBtn.addEventListener('click', showForm);
  cancelBtn.addEventListener('click', hideForm);
  submitBtn.addEventListener('click', submitGroup);
  newGroupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitGroup();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideForm();
    }
  });
};

const init = async () => {
  debug && console.log('Groups init');

  // Register escape handler for internal navigation
  // Backend handles parent centering, child tracking, and focus restoration
  api.escape.onEscape(handleEscape);

  // Load view preferences and set up toolbar
  await loadViewPrefs();
  setupToolbar();

  // Load tags from datastore
  await loadTags();

  // Set up search input
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderCurrentView();
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Re-assert group mode when window regains focus (e.g., after child page closes)
  window.addEventListener('focus', async () => {
    if (state.view === VIEW_ADDRESSES && state.currentTag && api.context) {
      await api.context.setMode('group', {
        metadata: {
          groupId: state.currentTag.id,
          groupName: state.currentTag.name,
          color: state.currentTag.color
        }
      });
      debug && console.log('[groups] Re-asserted group mode on focus:', state.currentTag.name);
    }
  });

  // Debounced refresh for reactive updates (collapses rapid events like batch imports)
  const debouncedRefresh = debounce(async () => {
    debug && console.log('[groups] debounced refresh triggered');
    await loadTags();
    if (state.view === VIEW_GROUPS) {
      renderGroups();
    } else if (state.view === VIEW_ADDRESSES && state.currentTag) {
      // Reload addresses for the current tag — loadTags only refreshes tag metadata,
      // not the items list shown in the addresses view
      await loadAddressesForTag(state.currentTag.id);
      renderAddresses();
    }
  }, 150);

  // Subscribe to tag events for reactive updates
  api.subscribe('tag:item-added', (msg) => {
    debug && console.log('[groups] tag:item-added event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('tag:item-removed', (msg) => {
    debug && console.log('[groups] tag:item-removed event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('tag:created', (msg) => {
    debug && console.log('[groups] tag:created event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Subscribe to item events for reactive updates
  api.subscribe('item:created', (msg) => {
    debug && console.log('[groups] item:created event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('item:deleted', (msg) => {
    debug && console.log('[groups] item:deleted event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Subscribe to sync events — sync operations bypass per-item events,
  // so we need this to refresh when new data arrives via sync
  api.subscribe('sync:pull-completed', (msg) => {
    debug && console.log('[groups] sync:pull-completed event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Subscribe to pin change events for reactive updates
  api.subscribe('group:pin-changed', (msg) => {
    debug && console.log('[groups] group:pin-changed event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Set up create group UI
  setupCreateGroup();

  // Show groups view
  showGroups();
};

/**
 * Render the current view (used after search filtering)
 */
const renderCurrentView = () => {
  if (state.view === VIEW_GROUPS) {
    renderGroups();
  } else {
    renderAddresses();
  }
};

/**
 * Load all tags sorted by frecency, and count untagged addresses
 */
const loadTags = async () => {
  const result = await api.datastore.getTagsByFrecency();
  if (result.success) {
    state.tags = result.data;
    debug && console.log('Loaded tags:', state.tags.length);

    // Fetch URL item count for each tag (only http/https URLs)
    for (const tag of state.tags) {
      const itemsResult = await api.datastore.getItemsByTag(tag.id);
      if (itemsResult.success) {
        tag.addressCount = itemsResult.data.filter(item =>
          item.type === 'url' && isWebUrl(item.content)
        ).length;
      } else {
        tag.addressCount = 0;
      }
    }
  } else {
    console.error('Failed to load tags:', result.error);
    state.tags = [];
  }

  // Get count of untagged URL items (only http/https URLs)
  // Query all items and filter out those with tags
  const allItemsResult = await api.datastore.queryItems({});
  if (allItemsResult.success) {
    const untaggedItems = [];
    for (const item of allItemsResult.data) {
      // Only include http/https URL items
      if (item.type !== 'url' || !isWebUrl(item.content)) continue;
      const tagsResult = await api.datastore.getItemTags(item.id);
      if (tagsResult.success && tagsResult.data.length === 0) {
        untaggedItems.push(item);
      }
    }
    state.untaggedCount = untaggedItems.length;
    debug && console.log('Untagged URL items:', state.untaggedCount);
  } else {
    state.untaggedCount = 0;
  }
};

/**
 * Normalize a URL for deduplication comparison
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

/**
 * Deduplicate items by URL content, keeping the most recently updated one
 */
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
 * Load URL items for a specific tag (only http/https URLs)
 */
const loadAddressesForTag = async (tagId) => {
  const result = await api.datastore.getItemsByTag(tagId);
  if (result.success) {
    // Only include http/https URL items, deduplicated by URL
    const urlItems = result.data.filter(item =>
      item.type === 'url' && isWebUrl(item.content)
    );
    let addresses = deduplicateByUrl(urlItems);

    // Load pinned items for this group and annotate
    try {
      const pinsResult = await api.settings.getExtKey('groups', `pins:${tagId}`);
      if (pinsResult.success && Array.isArray(pinsResult.data)) {
        const pinnedSet = new Set(pinsResult.data);
        addresses = addresses.map(addr => ({
          ...addr,
          _pinned: pinnedSet.has(addr.id)
        }));
        // Sort pinned items first
        addresses.sort((a, b) => (b._pinned ? 1 : 0) - (a._pinned ? 1 : 0));
      }
    } catch (err) {
      debug && console.log('[groups] Failed to load pins for tag:', err);
    }

    state.addresses = addresses;
    debug && console.log('Loaded URL items for tag:', state.addresses.length);
  } else {
    console.error('Failed to load addresses:', result.error);
    state.addresses = [];
  }
};

/**
 * Filter groups by search query
 */
const filterGroups = (groups) => {
  if (!state.searchQuery) return groups;
  const q = state.searchQuery.toLowerCase();
  return groups.filter(tag => tag.name.toLowerCase().includes(q));
};

/**
 * Filter addresses by search query (title or URL)
 * Handles both Address (uri) and Item (content) objects
 */
const filterAddresses = (addresses) => {
  if (!state.searchQuery) return addresses;
  const q = state.searchQuery.toLowerCase();
  return addresses.filter(addr => {
    const url = addr.uri || addr.content || '';
    return (addr.title || '').toLowerCase().includes(q) ||
      url.toLowerCase().includes(q);
  });
};

/**
 * Show the groups (tags) view
 */
const showGroups = async () => {
  state.view = VIEW_GROUPS;
  state.currentTag = null;
  state.searchQuery = '';

  // Reset mode context to 'default' when returning to groups list
  if (api.context) {
    try {
      await api.context.setMode('default', {});
      debug && console.log('[groups] Reset to default mode');
    } catch (err) {
      console.error('[groups] Failed to reset mode:', err);
    }
  }

  // Refresh tags
  await loadTags();

  // Update search placeholder
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.value = '';
  searchInput.placeholder = 'Search groups...';

  renderGroups();
};

// Expose for testing (Playwright escape doesn't trigger Electron before-input-event)
window.showGroups = showGroups;

/**
 * Render groups cards (separate from showGroups for filtering)
 */
const renderGroups = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';
  updateToolbarSortOptions();

  // Separate promoted groups from regular tags
  const promotedGroups = state.tags.filter(tag => isGroupTag(tag));
  const unpromotedTags = state.tags.filter(tag => !isGroupTag(tag));

  // Build list of groups to show
  let groupsToShow = [];
  if (state.untaggedCount > 0) {
    groupsToShow.push({ ...UNTAGGED_GROUP, frequency: state.untaggedCount });
  }
  groupsToShow = groupsToShow.concat(promotedGroups);

  // Apply search filter
  let filteredGroups = filterGroups(groupsToShow);

  // Apply sorting
  filteredGroups = sortGroups(filteredGroups);

  if (filteredGroups.length === 0 && !state.showAllTags) {
    const message = state.searchQuery
      ? 'No groups match your search.'
      : 'No groups yet. Create a group or promote tags below.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
  } else {
    filteredGroups.forEach(tag => {
      const card = createGroupCard(tag);
      container.appendChild(card);
    });
  }

  // "All Tags" toggle section — show unpromoted tags so users can promote them
  const hasUnpromotedTags = unpromotedTags.length > 0;
  if (hasUnpromotedTags) {
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'all-tags-toggle';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'all-tags-btn';
    toggleBtn.textContent = state.showAllTags
      ? `Hide tags (${unpromotedTags.length})`
      : `Show all tags (${unpromotedTags.length})`;
    toggleBtn.addEventListener('click', () => {
      state.showAllTags = !state.showAllTags;
      renderGroups();
    });
    toggleContainer.appendChild(toggleBtn);
    container.appendChild(toggleContainer);

    if (state.showAllTags) {
      let filteredTags = filterGroups(unpromotedTags);
      filteredTags = sortGroups(filteredTags);
      filteredTags.forEach(tag => {
        const card = createGroupCard(tag, { showPromote: true });
        container.appendChild(card);
      });
    }
  }

  // Reset selection
  state.selectedIndex = 0;
  updateSelection();
};

/**
 * Show addresses in a group (tag)
 */
const showAddresses = async (tag) => {
  state.view = VIEW_ADDRESSES;
  state.currentTag = tag;
  state.searchQuery = '';

  // Set mode context to 'group' so cmd bar shows correct mode
  if (api.context) {
    try {
      await api.context.setMode('group', {
        metadata: {
          groupId: tag.id,
          groupName: tag.name,
          color: tag.color
        }
      });
      debug && console.log('[groups] Set group mode:', tag.name);
    } catch (err) {
      console.error('[groups] Failed to set group mode:', err);
    }
  }

  // Load URL items - handle special untagged group (only http/https URLs)
  if (tag.isSpecial && tag.id === '__untagged__') {
    const allItemsResult = await api.datastore.queryItems({});
    if (allItemsResult.success) {
      const untaggedItems = [];
      for (const item of allItemsResult.data) {
        // Only include http/https URL items
        if (item.type !== 'url' || !isWebUrl(item.content)) continue;
        const tagsResult = await api.datastore.getItemTags(item.id);
        if (tagsResult.success && tagsResult.data.length === 0) {
          untaggedItems.push(item);
        }
      }
      state.addresses = untaggedItems;
    } else {
      state.addresses = [];
    }
  } else {
    await loadAddressesForTag(tag.id);
  }

  // Update search placeholder with group name
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.value = '';
  searchInput.placeholder = `Search in ${tag.name}...`;

  renderAddresses();
};

/**
 * Render address cards (separate from showAddresses for filtering)
 */
const renderAddresses = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';
  updateToolbarSortOptions();

  // Apply search filter
  let filteredAddresses = filterAddresses(state.addresses);

  if (filteredAddresses.length === 0) {
    const message = state.searchQuery
      ? 'No pages match your search.'
      : 'No pages in this group yet.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  // Apply sorting
  filteredAddresses = sortAddresses(filteredAddresses);

  filteredAddresses.forEach(address => {
    const card = createAddressCard(address);
    container.appendChild(card);
  });

  // Reset selection
  state.selectedIndex = 0;
  updateSelection();
};

/**
 * Create a card element for a group (tag)
 * @param {object} tag - Tag object
 * @param {object} [options] - Options
 * @param {boolean} [options.showPromote] - Show "Add to Groups" button for unpromoted tags
 */
const createGroupCard = (tag, options = {}) => {
  const card = document.createElement('peek-card');
  card.className = 'group-card';
  card.interactive = true;
  card.elevated = true;
  if (tag.isSpecial) {
    card.classList.add('special-group');
  }
  if (options.showPromote) {
    card.classList.add('unpromoted-tag');
  }
  card.dataset.tagId = tag.id;

  // Header slot: color dot + name
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  const colorDot = document.createElement('div');
  colorDot.className = 'color-dot';
  colorDot.style.backgroundColor = tag.color || '#999';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = tag.name;
  title.style.margin = '0';
  title.style.flex = '1';
  title.style.minWidth = '0';

  header.appendChild(colorDot);
  header.appendChild(title);

  // Add "promote to group" button for unpromoted tags
  if (options.showPromote) {
    const promoteBtn = document.createElement('button');
    promoteBtn.className = 'promote-btn';
    promoteBtn.title = 'Add to Groups';
    promoteBtn.textContent = '+';
    promoteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await promoteTagToGroup(tag);
      await loadTags();
      renderGroups();
    });
    header.appendChild(promoteBtn);
  }

  card.appendChild(header);

  // Footer slot: count
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  const count = tag.isSpecial ? (tag.frequency || 0) : (tag.addressCount || 0);
  footer.textContent = `${count} ${count === 1 ? 'page' : 'pages'}`;
  card.appendChild(footer);

  // Click to view addresses in this group
  card.addEventListener('card-click', () => showAddresses(tag));

  return card;
};

/**
 * Create a card element for an address
 * Handles both Address (uri) and Item (content) objects
 */
const createAddressCard = (address) => {
  const card = document.createElement('peek-card');
  card.className = 'address-card';
  card.interactive = true;
  card.elevated = true;
  card.dataset.addressId = address.id;

  // Get URL from either uri (Address) or content (Item)
  const addressUrl = address.uri || address.content;

  // Get title - Items store title in metadata, Addresses have it directly
  let displayTitle = address.title;
  if (!displayTitle && address.metadata) {
    try {
      const meta = typeof address.metadata === 'string' ? JSON.parse(address.metadata) : address.metadata;
      displayTitle = meta.title;
    } catch (e) {
      // Ignore parse errors
    }
  }
  displayTitle = displayTitle || addressUrl;

  // Header slot: favicon + title (matching group card structure)
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  const favicon = document.createElement('img');
  favicon.className = 'card-favicon';
  favicon.src = address.favicon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
  favicon.onerror = () => {
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
  };

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = displayTitle;
  title.style.margin = '0';
  title.style.flex = '1';
  title.style.minWidth = '0';

  header.appendChild(favicon);
  header.appendChild(title);

  // Show pin indicator if item is pinned in this group
  if (address._pinned) {
    const pinBadge = document.createElement('span');
    pinBadge.className = 'pin-badge';
    pinBadge.textContent = 'pinned';
    pinBadge.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(255,180,60,0.3);color:rgba(255,200,100,0.9);flex-shrink:0;';
    header.appendChild(pinBadge);
  }

  card.appendChild(header);

  // Footer slot: URL + visit count
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  footer.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

  // Show URL (unless title already IS the URL)
  if (addressUrl && displayTitle !== addressUrl) {
    const urlSpan = document.createElement('span');
    urlSpan.className = 'card-url';
    try {
      const u = new URL(addressUrl);
      urlSpan.textContent = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch {
      urlSpan.textContent = addressUrl;
    }
    urlSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;opacity:0.7;';
    footer.appendChild(urlSpan);
  }

  const visitCount = address.visitCount || 0;
  const visitSpan = document.createElement('span');
  visitSpan.textContent = `${visitCount} ${visitCount === 1 ? 'visit' : 'visits'}`;
  visitSpan.style.flexShrink = '0';
  footer.appendChild(visitSpan);

  card.appendChild(footer);

  // Click to open address - backend handles centering and parent tracking
  let isOpening = false;
  card.addEventListener('card-click', async () => {
    if (isOpening) return;
    isOpening = true;
    try {
      debug && console.log('Opening address:', addressUrl);
      const openOptions = {
        role: 'content',
        key: addressUrl,
        width: 800,
        height: 600
      };
      if (state.currentTag && state.currentTag.id !== '__untagged__') {
        openOptions.groupMode = {
          groupId: state.currentTag.id,
          groupName: state.currentTag.name,
          color: state.currentTag.color
        };
      }
      const result = await api.window.open(addressUrl, openOptions);
      debug && console.log('Window opened:', result);
    } finally {
      setTimeout(() => { isOpening = false; }, 500);
    }
  });

  return card;
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
