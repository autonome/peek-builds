/**
 * Windows - Full-screen window switcher
 *
 * Shows all open windows as cards in a transparent overlay.
 * Uses vim-style navigation (hjkl) and enter to focus window.
 */

const api = window.app;
const debug = api.debug;

// View preferences (persisted)
let viewPrefs = {
  viewMode: 'columns',
  sortBy: 'title',
  sortDirection: 'asc'
};

const SORT_OPTIONS = [
  { value: 'title', label: 'Title' },
  { value: 'url', label: 'URL' }
];

let state = {
  windows: [],
  selectedIndex: 0,
  searchQuery: ''
};

// Handle ESC - close the windows view
api.escape.onEscape(() => {
  // If search has content, clear it first
  const searchInput = document.querySelector('peek-input.search-input');
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    renderWindows();
    return { handled: true };
  }
  // Let window close - backend handles restoring hidden windows (overlay mode)
  return { handled: false };
});

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

  // Scroll selected card into view
  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

/**
 * Close windows view (backend handles restoring hidden windows via overlay mode)
 */
const closeWindowsView = () => {
  window.close();
};

/**
 * Activate the currently selected card (focus window and close windows view)
 */
const activateSelected = async () => {
  const filteredWindows = filterWindows(state.windows);
  const selectedWindow = filteredWindows[state.selectedIndex];

  if (selectedWindow) {
    debug && console.log('[windows] Focusing window:', selectedWindow.id, selectedWindow.title);

    // Tell the overlay which window to focus after it closes and restores hidden windows
    // (calling focus() directly doesn't work because the target window is hidden by the overlay)
    await api.window.setOverlayFocusTarget(selectedWindow.id);

    // Close windows view — the overlay close handler will restore hidden windows
    // and then focus the target window
    closeWindowsView();
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

/**
 * Load all visible windows
 */
const loadWindows = async () => {
  // Include internal peek:// windows so we can show them
  const result = await api.window.list({ includeInternal: true });

  if (result.success) {
    // Filter out windows we don't want to show:
    // - The windows view itself
    // - Background pages (extension background scripts)
    // - Extension host window
    // - Settings window (internal UI)
    state.windows = result.windows.filter(w => {
      const url = w.url || '';
      // Skip windows view
      if (url.includes('windows.html')) return false;
      // Skip background pages
      if (url.includes('background.html')) return false;
      // Skip extension host
      if (url.includes('extension-host.html')) return false;
      // Include everything else (content windows and peek:// UI pages)
      return true;
    });
    debug && console.log('[windows] Loaded windows:', state.windows.length);
  } else {
    console.error('[windows] Failed to load windows:', result.error);
    state.windows = [];
  }
};

/**
 * Filter windows by search query (title or URL)
 */
const filterWindows = (windows) => {
  if (!state.searchQuery) return windows;
  const q = state.searchQuery.toLowerCase();
  return windows.filter(w =>
    (w.title || '').toLowerCase().includes(q) ||
    (w.url || '').toLowerCase().includes(q)
  );
};

/**
 * Render window cards
 */
const renderWindows = () => {
  const container = document.querySelector('peek-grid.cards');
  container.innerHTML = '';

  let filteredWindows = filterWindows(state.windows);

  if (filteredWindows.length === 0) {
    const message = state.searchQuery
      ? 'No windows match your search.'
      : 'No windows open.';
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = message;
    container.appendChild(emptyState);
    return;
  }

  // Apply sorting
  filteredWindows = sortWindows(filteredWindows);

  filteredWindows.forEach(win => {
    const card = createWindowCard(win);
    container.appendChild(card);
  });

  // Reset selection if out of bounds
  if (state.selectedIndex >= filteredWindows.length) {
    state.selectedIndex = Math.max(0, filteredWindows.length - 1);
  }
  updateSelection();
};

/**
 * Create a card element for a window
 */
const createWindowCard = (win) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;
  card.dataset.windowId = win.id;

  // Header with optional favicon and title
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  header.style.minWidth = '0';

  // Try to get favicon from URL (only for external URLs)
  if (win.url && !win.url.startsWith('peek://')) {
    try {
      const url = new URL(win.url);
      const favicon = document.createElement('img');
      favicon.className = 'card-favicon';
      favicon.src = `${url.origin}/favicon.ico`;
      favicon.onerror = () => favicon.remove();
      header.appendChild(favicon);
    } catch (e) {
      // No favicon
    }
  }

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = win.title || 'Untitled';
  header.appendChild(title);

  card.appendChild(header);

  // URL in body
  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = win.url || '';
  card.appendChild(url);

  // Click to focus window and close windows view
  card.addEventListener('card-click', async () => {
    debug && console.log('[windows] Clicking window:', win.id, win.title);
    await api.window.setOverlayFocusTarget(win.id);
    closeWindowsView();
  });

  return card;
};

/**
 * Load persisted view preferences
 */
const loadViewPrefs = async () => {
  try {
    const stored = localStorage.getItem('viewPrefs');
    if (stored) {
      viewPrefs = { ...viewPrefs, ...JSON.parse(stored) };
      debug && console.log('[windows] Loaded viewPrefs:', viewPrefs);
    }
  } catch (err) {
    debug && console.log('[windows] Failed to load viewPrefs:', err);
  }
};

/**
 * Save view preferences
 */
const saveViewPrefs = async () => {
  try {
    localStorage.setItem('viewPrefs', JSON.stringify(viewPrefs));
  } catch (err) {
    debug && console.log('[windows] Failed to save viewPrefs:', err);
  }
};

/**
 * Sort windows by current view preferences
 */
const sortWindows = (windows) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return windows.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'title': {
        const ta = (a.title || '').toLowerCase();
        const tb = (b.title || '').toLowerCase();
        return dir * ta.localeCompare(tb);
      }
      case 'url': {
        const ua = (a.url || '').toLowerCase();
        const ub = (b.url || '').toLowerCase();
        return dir * ua.localeCompare(ub);
      }
      default:
        return 0;
    }
  });
};

/**
 * Set up grid toolbar events and state
 */
const setupToolbar = () => {
  const toolbar = document.querySelector('.grid-toolbar');
  const container = document.querySelector('peek-grid.cards');
  if (!toolbar) return;

  toolbar.sortOptions = SORT_OPTIONS;
  toolbar.sortBy = viewPrefs.sortBy;
  toolbar.sortDirection = viewPrefs.sortDirection;
  toolbar.viewMode = viewPrefs.viewMode;
  container.viewMode = viewPrefs.viewMode;

  toolbar.addEventListener('sort-change', (e) => {
    viewPrefs.sortBy = e.detail.sortBy;
    viewPrefs.sortDirection = e.detail.sortDirection;
    saveViewPrefs();
    renderWindows();
  });

  toolbar.addEventListener('view-mode-change', (e) => {
    viewPrefs.viewMode = e.detail.mode;
    container.viewMode = e.detail.mode;
    saveViewPrefs();
    renderWindows();
  });
};

const init = async () => {
  debug && console.log('[windows] init');

  // Load view preferences and set up toolbar
  await loadViewPrefs();
  setupToolbar();

  // Load windows
  await loadWindows();

  // Set up search input
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    state.selectedIndex = 0;
    renderWindows();
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Render windows
  renderWindows();
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
