/**
 * Pagestream - Vertical, chat-like navigational interface for web history
 *
 * Displays a vertical stream of page cards from visit history.
 * Newest at bottom (chat-like), keyboard navigable, with URL input.
 */

const api = window.app;
const debug = api.debug;

/**
 * Simple debounce helper
 */
const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

/**
 * Format a timestamp as relative time ("2m ago", "1h ago", "yesterday")
 */
const formatRelativeTime = (timestamp) => {
  if (!timestamp) return '';
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

/**
 * Extract domain from a URL
 */
const extractDomain = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * Check if a string is a navigable web URL
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

/**
 * Attempt to parse a string as a valid URL, adding https:// if needed
 */
const getValidURL = (input) => {
  if (!input) return null;
  let url = input.trim();

  // Already a valid URL
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
  } catch {
    // Not a valid URL yet
  }

  // Try adding https://
  if (!url.includes('://')) {
    try {
      const withScheme = 'https://' + url;
      new URL(withScheme);
      return withScheme;
    } catch {
      return null;
    }
  }

  return null;
};

// ===== State =====

let state = {
  visits: [],        // Array of { visit, item } objects
  items: new Map(),  // itemId -> item data
  selectedIndex: -1,
  searchQuery: '',
  filterTagId: null,
  filterTagName: null,
  isLoading: true,
  wasAtBottom: true, // Track if user was scrolled to bottom
  browsing: false,       // Whether we're in inline browse mode
  browseUrl: null,       // URL currently being browsed inline
  browseCardIndex: -1,   // Index of the card being browsed
  browseOriginalContent: null // Saved original card innerHTML
};

// Expose state for debugging in tests
window._pagestreamState = state;

// ===== Data Loading =====

/**
 * Load recent visits and their associated items
 */
const loadVisits = async () => {
  state.isLoading = true;

  try {
    // Get recent item visits
    const visitsResult = await api.datastore.queryItemVisits({ limit: 100 });
    if (!visitsResult.success) {
      console.error('[pagestream] Failed to load visits:', visitsResult.error);
      state.visits = [];
      return;
    }

    const visits = visitsResult.data || [];

    // Get all URL items for lookup
    const itemsResult = await api.datastore.queryItems({ type: 'url' });
    if (itemsResult.success && itemsResult.data) {
      state.items.clear();
      for (const item of itemsResult.data) {
        state.items.set(item.id, item);
      }
    }

    // Build visit+item pairs, filtering to only web URLs
    state.visits = visits
      .map(visit => {
        const item = state.items.get(visit.itemId);
        if (!item || !isWebUrl(item.content)) return null;
        return { visit, item };
      })
      .filter(Boolean)
      // Reverse so oldest is at top, newest at bottom (chat-like)
      .reverse();

    debug && console.log('[pagestream] Loaded', state.visits.length, 'visits');
  } catch (err) {
    console.error('[pagestream] Error loading visits:', err);
    state.visits = [];
  } finally {
    state.isLoading = false;
  }
};

/**
 * Load tags for a specific item
 */
const loadItemTags = async (itemId) => {
  try {
    const result = await api.datastore.getItemTags(itemId);
    if (result.success) return result.data || [];
  } catch {
    // Ignore
  }
  return [];
};

// ===== Rendering =====

/**
 * Get filtered visits based on search query and tag filter
 */
const getFilteredVisits = () => {
  let filtered = state.visits;

  // Deduplicate consecutive entries with the same URL
  filtered = filtered.filter(({ item }, i, arr) => {
    if (i === 0) return true;
    return item.content !== arr[i - 1].item.content;
  });

  // Text search filter
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(({ item }) => {
      const title = item.title || '';
      const url = item.content || '';
      const domain = item.domain || extractDomain(url);
      return title.toLowerCase().includes(q) ||
        url.toLowerCase().includes(q) ||
        domain.toLowerCase().includes(q);
    });
  }

  return filtered;
};

/**
 * Get all card elements in the stream
 */
const getCards = () => {
  return Array.from(document.querySelectorAll('#stream peek-card'));
};

/**
 * Update visual selection on cards
 */
const updateSelection = () => {
  const cards = getCards();
  cards.forEach((card, i) => {
    const isActive = (i === state.selectedIndex);
    // Do not set selected/elevated - those trigger blue border in peek-card shadow DOM
    card.selected = false;
    card.elevated = false;
    if (isActive) {
      card.classList.add('active-card');
    } else {
      card.classList.remove('active-card');
    }
  });

  // Scroll selected card into view
  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

/**
 * Render the stream of cards
 */
const render = () => {
  const container = document.getElementById('stream');
  const emptyState = document.getElementById('empty-state');
  const filtered = getFilteredVisits();

  // Clear existing cards (but not the empty state element)
  const existingCards = container.querySelectorAll('peek-card');
  existingCards.forEach(card => card.remove());

  if (state.isLoading) {
    emptyState.textContent = 'Loading history...';
    emptyState.style.display = 'flex';
    return;
  }

  if (filtered.length === 0) {
    if (state.searchQuery) {
      emptyState.textContent = 'No pages match your search.';
    } else {
      emptyState.textContent = 'No browsing history yet. Open a page to start your stream.';
    }
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  // Render cards (oldest first, newest at bottom)
  filtered.forEach(({ visit, item }, index) => {
    const card = createVisitCard(visit, item, index);
    container.appendChild(card);
  });

  // Set selection to newest (bottom) if no selection
  if (state.selectedIndex < 0 || state.selectedIndex >= filtered.length) {
    state.selectedIndex = filtered.length - 1;
  }
  updateSelection();

  // Scroll to bottom if we were already there
  if (state.wasAtBottom) {
    scrollToBottom();
  }
};

/**
 * Scroll the stream to the bottom
 */
const scrollToBottom = () => {
  const container = document.getElementById('stream');
  container.scrollTop = container.scrollHeight;
};

/**
 * Check if the stream is scrolled to the bottom
 */
const isAtBottom = () => {
  const container = document.getElementById('stream');
  const threshold = 50;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
};

/**
 * Create a card element for a visit
 */
const createVisitCard = (visit, item, index) => {
  const card = document.createElement('peek-card');
  card.className = 'visit-card';
  card.interactive = true;
  card.dataset.visitId = visit.id;
  card.dataset.itemId = item.id;
  card.dataset.index = index;

  const url = item.content;

  // Parse title from metadata or item fields
  let displayTitle = item.title;
  if (!displayTitle && item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      displayTitle = meta.title;
    } catch {
      // Ignore parse errors
    }
  }
  displayTitle = displayTitle || extractDomain(url);

  const domain = item.domain || extractDomain(url);

  // Header slot: favicon + title
  const header = document.createElement('div');
  header.slot = 'header';
  header.className = 'card-header';

  const favicon = document.createElement('img');
  favicon.className = 'card-favicon';
  favicon.src = item.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  favicon.onerror = () => {
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">.</text></svg>';
  };

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = displayTitle;

  header.appendChild(favicon);
  header.appendChild(title);
  card.appendChild(header);

  // Body: URL
  const body = document.createElement('div');
  body.className = 'card-url';
  body.textContent = url;
  card.appendChild(body);

  // Footer slot: time + domain badge
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-footer';

  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatRelativeTime(visit.timestamp);

  const domainBadge = document.createElement('span');
  domainBadge.className = 'card-domain';
  domainBadge.textContent = domain;

  footer.appendChild(time);
  footer.appendChild(domainBadge);
  card.appendChild(footer);

  // Load and render tags asynchronously
  loadItemTags(item.id).then(tags => {
    if (tags.length > 0) {
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'card-tags';
      tagsContainer.slot = 'footer';
      tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = tag.name;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          filterByTag(tag.id, tag.name);
        });
        tagsContainer.appendChild(chip);
      });
      // Insert tags before footer
      card.appendChild(tagsContainer);
    }
  });

  // Click to open the URL inline
  card.addEventListener('card-click', () => {
    state.selectedIndex = index;
    updateSelection();
    openInline(url);
  });

  return card;
};

// ===== Inline Browsing =====

/**
 * Open a URL inline by expanding the active card and loading an iframe.
 * Extension windows don't support <webview> tags, so we use iframes.
 */
const openInline = (url) => {
  if (state.browsing) return;

  const cards = getCards();
  const card = cards[state.selectedIndex];
  if (!card) return;

  debug && console.log('[pagestream] Opening inline:', url);

  state.browsing = true;
  state.browseUrl = url;
  state.browseCardIndex = state.selectedIndex;
  // Save original card content so we can restore on close
  state.browseOriginalContent = card.innerHTML;

  // Clear card content and insert iframe
  card.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.className = 'browse-iframe';
  iframe.src = url;
  iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups';
  card.appendChild(iframe);

  // Add expanded class to trigger CSS transition
  card.classList.add('card-expanded');

  // Show backdrop
  const backdrop = document.getElementById('browse-backdrop');
  backdrop.classList.add('active');

  // Update navbar to show the current URL
  const navbarEl = document.getElementById('navbar');
  if (navbarEl && navbarEl.setUrl) {
    navbarEl.setUrl(url);
  }
};

/**
 * Close browse mode: remove iframe, animate card back down, restore content
 */
const closeBrowse = () => {
  if (!state.browsing) return;

  const cards = getCards();
  const card = cards[state.browseCardIndex];

  if (card) {
    // Remove expanded class (triggers reverse CSS transition)
    card.classList.remove('card-expanded');

    // Restore original card content
    if (state.browseOriginalContent) {
      card.innerHTML = state.browseOriginalContent;
    }
  }

  // Hide backdrop
  const backdrop = document.getElementById('browse-backdrop');
  backdrop.classList.remove('active');

  // Clear navbar URL
  const navbarEl = document.getElementById('navbar');
  if (navbarEl && navbarEl.setUrl) {
    navbarEl.setUrl('');
  }

  state.browsing = false;
  state.browseUrl = null;
  state.browseCardIndex = -1;
  state.browseOriginalContent = null;

  // Re-apply selection styling
  updateSelection();
};

// ===== Filtering =====

/**
 * Filter stream by tag
 */
const filterByTag = async (tagId, tagName) => {
  state.filterTagId = tagId;
  state.filterTagName = tagName;

  // Get items with this tag
  const result = await api.datastore.getItemsByTag(tagId);
  if (result.success && result.data) {
    const taggedItemIds = new Set(result.data.map(item => item.id));

    // Filter visits to those with tagged items
    const allVisits = state.visits;
    state.visits = allVisits.filter(({ item }) => taggedItemIds.has(item.id));
  }

  // Show filter bar
  const filterBar = document.querySelector('.filter-bar');
  if (filterBar) {
    filterBar.classList.add('active');
    const filterTag = filterBar.querySelector('.filter-tag');
    if (filterTag) filterTag.textContent = tagName;
  }

  render();
};

/**
 * Clear tag filter
 */
const clearTagFilter = async () => {
  state.filterTagId = null;
  state.filterTagName = null;

  // Reload all visits
  await loadVisits();

  // Hide filter bar
  const filterBar = document.querySelector('.filter-bar');
  if (filterBar) {
    filterBar.classList.remove('active');
  }

  render();
};

// ===== Keyboard Navigation =====

/**
 * Internal ESC handler for pagestream navigation
 * Returns { handled: true } if we handled it, { handled: false } to close window
 */
const handleEscape = () => {
  debug && console.log('[pagestream:esc] handleEscape called, browsing:', state.browsing, 'search:', state.searchQuery, 'filter:', state.filterTagId);

  // Close inline browse overlay first
  if (state.browsing) {
    closeBrowse();
    return { handled: true };
  }

  // Clear tag filter first
  if (state.filterTagId) {
    clearTagFilter();
    return { handled: true };
  }

  // Clear search next
  const searchInput = document.querySelector('peek-input.search-input');
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    render();
    return { handled: true };
  }

  // Nothing to clear - let window close
  return { handled: false };
};

/**
 * Handle keyboard navigation
 */
const handleKeydown = (e) => {
  // Don't handle card navigation while in browse mode
  if (state.browsing) return;

  const searchInput = document.querySelector('peek-input.search-input');
  const navbarEl = document.getElementById('navbar');

  // Check if an input is focused
  const isSearchFocused = document.activeElement === searchInput ||
    (searchInput && searchInput.shadowRoot?.activeElement);
  const isUrlFocused = document.activeElement === navbarEl ||
    (navbarEl && navbarEl.shadowRoot?.activeElement);
  const isInputFocused = isSearchFocused || isUrlFocused;

  // Cmd+L or / to focus navbar URL input (when not in an input)
  if ((e.key === 'l' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !isInputFocused)) {
    e.preventDefault();
    navbarEl.focusUrl();
    scrollToBottom();
    // Also select the last card (most recent)
    const cards = getCards();
    if (cards.length > 0) {
      state.selectedIndex = cards.length - 1;
      updateSelection();
    }
    return;
  }

  // Cmd+F to focus search
  if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Don't intercept when typing in inputs (except navigation keys)
  if (isInputFocused && !['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
    return;
  }

  // Enter in navbar URL is handled by the peek-navbar component's navigate event.
  // Skip keyboard navigation when navbar URL input is focused.
  if (e.key === 'Enter' && isUrlFocused) {
    return;
  }

  const cards = getCards();
  if (cards.length === 0) return;

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      if (state.selectedIndex < cards.length - 1) {
        state.selectedIndex++;
        updateSelection();
      }
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelection();
      }
      break;
    case 'Enter':
      if (!isInputFocused) {
        e.preventDefault();
        // Open the active card's URL inline
        const filtered = getFilteredVisits();
        const entry = filtered[state.selectedIndex];
        if (entry) {
          openInline(entry.item.content);
        }
      }
      break;
    case 'g':
      if (!isInputFocused) {
        e.preventDefault();
        state.selectedIndex = 0;
        updateSelection();
      }
      break;
    case 'G':
      if (!isInputFocused) {
        e.preventDefault();
        state.selectedIndex = cards.length - 1;
        updateSelection();
      }
      break;
    case 'Home':
      e.preventDefault();
      state.selectedIndex = 0;
      updateSelection();
      break;
    case 'End':
      e.preventDefault();
      state.selectedIndex = cards.length - 1;
      updateSelection();
      break;
  }
};

// ===== Initialization =====

const init = async () => {
  debug && console.log('[pagestream] init');

  // Register escape handler
  api.escape.onEscape(handleEscape);

  // Set up navbar component for URL navigation
  const navbarEl = document.getElementById('navbar');
  navbarEl.addEventListener('navigate', (e) => {
    const url = e.detail?.url;
    if (url) {
      debug && console.log('[pagestream] Navigating to:', url);
      openInline(url);
    }
  });

  // Set up search input
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    render();
  });

  // Track scroll position
  const streamContainer = document.getElementById('stream');
  streamContainer.addEventListener('scroll', () => {
    state.wasAtBottom = isAtBottom();
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Load initial data
  await loadVisits();
  render();

  // Scroll to bottom (newest) on initial load - use rAF to ensure layout is complete
  requestAnimationFrame(() => {
    scrollToBottom();
  });

  // Focus stays on the card stream (not the navbar) so the most recent entry is active

  // Debounced refresh for reactive updates
  const debouncedRefresh = debounce(async () => {
    debug && console.log('[pagestream] debounced refresh triggered');
    state.wasAtBottom = isAtBottom();
    await loadVisits();
    render();
  }, 150);

  // Subscribe to events for live updates
  api.subscribe('item:created', (msg) => {
    debug && console.log('[pagestream] item:created event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('item:deleted', (msg) => {
    debug && console.log('[pagestream] item:deleted event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('tag:item-added', (msg) => {
    debug && console.log('[pagestream] tag:item-added event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  api.subscribe('tag:item-removed', (msg) => {
    debug && console.log('[pagestream] tag:item-removed event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Subscribe to sync events — sync operations bypass per-item events,
  // so we need this to refresh when new data arrives via sync
  api.subscribe('sync:pull-completed', (msg) => {
    debug && console.log('[pagestream] sync:pull-completed event received:', msg);
    debouncedRefresh();
  }, api.scopes.GLOBAL);

  // Periodically update relative timestamps
  setInterval(() => {
    const timeElements = document.querySelectorAll('.card-time');
    const filtered = getFilteredVisits();
    timeElements.forEach((el, i) => {
      if (filtered[i]) {
        el.textContent = formatRelativeTime(filtered[i].visit.timestamp);
      }
    });
  }, 30000); // Update every 30 seconds
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
