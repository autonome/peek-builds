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

let state = {
  view: VIEW_GROUPS,
  tags: [],
  currentTag: null,
  addresses: [],
  untaggedCount: 0,
  selectedIndex: 0,
  searchQuery: ''
};

// Expose state for debugging in tests
window._groupsState = state;

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

const init = async () => {
  debug && console.log('Groups init');

  // Register escape handler for internal navigation
  // Backend handles parent centering, child tracking, and focus restoration
  api.escape.onEscape(handleEscape);

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
    if (state.view === VIEW_GROUPS) renderGroups();
    else if (state.view === VIEW_ADDRESSES) renderAddresses();
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
    state.addresses = deduplicateByUrl(urlItems);
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

  // Build list of all groups (untagged first if it has items)
  let allGroups = [];
  if (state.untaggedCount > 0) {
    allGroups.push({ ...UNTAGGED_GROUP, frequency: state.untaggedCount });
  }

  // Add non-empty tags
  const nonEmptyTags = state.tags.filter(tag => tag.addressCount > 0);
  allGroups = allGroups.concat(nonEmptyTags);

  // Apply search filter
  const filteredGroups = filterGroups(allGroups);

  if (filteredGroups.length === 0) {
    const message = state.searchQuery
      ? 'No groups match your search.'
      : 'No groups yet. Tag some pages to create groups.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  filteredGroups.forEach(tag => {
    const card = createGroupCard(tag);
    container.appendChild(card);
  });

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

  // Apply search filter
  const filteredAddresses = filterAddresses(state.addresses);

  if (filteredAddresses.length === 0) {
    const message = state.searchQuery
      ? 'No pages match your search.'
      : 'No pages in this group yet.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

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
 */
const createGroupCard = (tag) => {
  const card = document.createElement('peek-card');
  card.className = 'group-card';
  card.interactive = true;
  card.elevated = true;
  if (tag.isSpecial) {
    card.classList.add('special-group');
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

  header.appendChild(colorDot);
  header.appendChild(title);
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
  card.appendChild(header);

  // Footer slot: visit count (matching group card structure)
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  const visitCount = address.visitCount || 0;
  footer.textContent = `${visitCount} ${visitCount === 1 ? 'visit' : 'visits'}`;
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
