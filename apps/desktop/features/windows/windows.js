/**
 * Windows - Full-screen window switcher
 *
 * Shows all open windows as cards in a transparent overlay.
 * Uses vim-style navigation (hjkl) and enter to focus window.
 */

const api = window.app;

// View preferences (persisted). 'fit' is the new default — Exposé-style
// no-overlap layout that resizes cards to fit the visible viewport
// regardless of count.
let viewPrefs = {
  viewMode: 'fit',
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
      // Include everything else (content windows and peek:// UI pages)
      return true;
    });
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
 * Hostname for a URL string — `null` when the input isn't parseable
 * (peek://, chrome://, file://) or empty.
 */
const hostnameOf = (urlStr) => {
  if (!urlStr) return null;
  try { return new URL(urlStr).hostname || null; } catch { return null; }
};

/**
 * Render the card's main visual block. With a stored screenshot we
 * load it; on failure (file gone, race) we fall back to the same
 * placeholder we'd use without one — so every card slot is the same
 * shape regardless of capture state. The placeholder is a flat
 * theme-coloured block with a single hostname-initial letter — no
 * per-domain colouring (felt too noisy in practice).
 */
const createThumbnail = (win) => {
  const placeholder = () => {
    const div = document.createElement('div');
    div.className = 'card-thumbnail card-thumbnail-placeholder';
    const host = hostnameOf(win.url);
    const letter = document.createElement('span');
    letter.className = 'card-thumbnail-letter';
    letter.textContent = host ? host.replace(/^www\./, '')[0].toUpperCase() : '·';
    div.appendChild(letter);
    return div;
  };

  if (!win.thumbnail) return placeholder();

  const img = document.createElement('img');
  img.className = 'card-thumbnail';
  img.src = `peek://thumbnail/${win.thumbnail}.jpg`;
  img.alt = '';
  img.onerror = () => img.replaceWith(placeholder());
  return img;
};

/**
 * Create a card element for a window
 */
const createWindowCard = (win) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;
  card.dataset.windowId = win.id;
  if (win.visible === false) {
    card.dataset.hidden = 'true';
  }

  // Header with optional favicon and title
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  header.style.minWidth = '0';

  // Favicon comes from the window presentation (api.window.list resolves
  // the right source — stored value, then Google s2). Renderer just drops
  // the URL into <img src>; no fallback chain here.
  if (win.favicon) {
    const favicon = document.createElement('img');
    favicon.className = 'card-favicon';
    favicon.src = win.favicon;
    favicon.onerror = () => favicon.remove();
    header.appendChild(favicon);
  }

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = win.title || 'Untitled';
  header.appendChild(title);

  if (win.visible === false) {
    const badge = document.createElement('span');
    badge.className = 'card-hidden-badge';
    badge.textContent = 'Hidden';
    header.appendChild(badge);
  }

  card.appendChild(header);

  // Always render a thumbnail-sized region so every card has the same
  // overall height in `columns` view (otherwise cards without a stored
  // screenshot are tiny and the row's intrinsic height jumps to match
  // whichever neighbour does have one — uneven rhythm). When a real
  // screenshot exists we render it; otherwise a placeholder block keyed
  // off the URL's hostname provides visual identity.
  const thumb = createThumbnail(win);
  card.appendChild(thumb);

  // URL in body
  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = win.url || '';
  card.appendChild(url);

  // Click to focus window and close windows view; un-hide first if hidden
  card.addEventListener('card-click', async () => {
    if (win.visible === false && api?.window?.show) {
      await api.window.show(win.id);
    }
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
    }
  } catch {
  }
};

/**
 * Save view preferences
 */
const saveViewPrefs = async () => {
  try {
    localStorage.setItem('viewPrefs', JSON.stringify(viewPrefs));
  } catch {
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

  // Load view preferences and set up toolbar
  await loadViewPrefs();
  setupToolbar();

  // Load windows
  await loadWindows();

  // Query the pre-overlay focus target so we can highlight the window
  // that was focused before the overlay opened (instead of defaulting to index 0)
  const preOverlayFocusTarget = await api.izui.getPreOverlayFocusTarget();
  if (preOverlayFocusTarget != null) {
    // Match the same filter+sort order as renderWindows() so index is correct
    const sortedWindows = sortWindows(filterWindows(state.windows));
    const targetIndex = sortedWindows.findIndex(w => w.id === preOverlayFocusTarget);
    if (targetIndex !== -1) {
      state.selectedIndex = targetIndex;
    }
  }

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

  // Dismiss the overlay if any new window opens (cmd+n, cmd palette,
  // a tile-spawned window, etc.). Without this, the new window appears
  // *behind* the overlay because we're alwaysOnTop. Filter out our own
  // creation event so we don't immediately self-close on launch.
  let ownWindowId = null;
  try {
    const info = await api.window.getInfo();
    ownWindowId = info?.id ?? null;
  } catch {
    // No window.getInfo grant — best-effort; an extra "self" close is
    // recoverable by re-invoking the windows command.
  }
  api.pubsub.subscribe('window:opened', (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    if (msg.id === ownWindowId) return;
    closeWindowsView();
  });
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
