/**
 * Web Search Home UI
 *
 * Provides:
 * - Search input with engine selector
 * - Suggestion list with keyboard navigation
 * - Engine list when no query is entered
 * - Keyboard navigation (arrow keys, Enter to search)
 */

const api = window.app;
const debug = api.debug;

// ===== Utilities =====

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
 * Escape HTML to prevent XSS
 */
const escapeHtml = (str) => {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

// Search magnifying glass icon SVG
const searchIconSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>';

// ===== State =====

let state = {
  query: '',
  suggestions: [],
  engines: [],
  selectedIndex: -1,
  currentEngine: null,
  defaultEngineId: 'duckduckgo',
  mode: 'engines', // 'engines' | 'suggestions'
};

// Expose state for testing
window._websearchState = state;

// ===== Data fetching =====

/**
 * Request engine list from background
 */
const requestEngines = () => {
  api.publish('websearch:engine-request', { action: 'list' }, api.scopes.GLOBAL);
};

/**
 * Request suggestions from background
 */
const requestSuggestions = debounce((query) => {
  if (!query || !query.trim()) {
    state.suggestions = [];
    state.mode = 'engines';
    render();
    return;
  }

  api.publish('websearch:request-suggestions', {
    query: query.trim(),
    engineId: state.currentEngine?.id || state.defaultEngineId
  }, api.scopes.GLOBAL);
}, 300);

/**
 * Execute search with the given query
 */
const executeSearch = (query) => {
  if (!query || !query.trim()) return;

  const engine = state.currentEngine || state.engines.find(e => e.id === state.defaultEngineId) || state.engines[0];
  if (!engine) return;

  const url = engine.searchUrl.replace('{searchTerms}', encodeURIComponent(query.trim()));
  debug && console.log('[websearch:home] Searching:', engine.name, query, '->', url);

  api.window.open(url, {
    role: 'content',
    key: url,
    width: 1024,
    height: 768,
    trackingSource: 'websearch',
    trackingSourceId: engine.id
  });
};

/**
 * Set the current engine
 */
const setCurrentEngine = (engine) => {
  state.currentEngine = engine;
  updateEngineIndicator();
};

// ===== Rendering =====

/**
 * Update the engine indicator display
 */
const updateEngineIndicator = () => {
  const engine = state.currentEngine || state.engines.find(e => e.id === state.defaultEngineId) || state.engines[0];
  if (!engine) return;

  const iconEl = document.getElementById('engine-icon');
  const nameEl = document.getElementById('engine-name');

  if (engine.iconUrl) {
    iconEl.src = engine.iconUrl;
    iconEl.style.display = '';
    iconEl.onerror = () => { iconEl.style.display = 'none'; };
  } else {
    iconEl.style.display = 'none';
  }

  nameEl.textContent = engine.name;

  // Update placeholder
  const searchInput = document.getElementById('search-input');
  searchInput.placeholder = `Search ${engine.name}...`;
};

/**
 * Render the current view
 */
const render = () => {
  if (state.mode === 'suggestions' && state.suggestions.length > 0) {
    renderSuggestions();
  } else if (state.query && state.query.trim()) {
    // Have a query but no suggestions yet — show nothing or a "press Enter" hint
    renderSuggestions();
  } else {
    renderEngines();
  }
};

/**
 * Render suggestion list
 */
const renderSuggestions = () => {
  const container = document.getElementById('suggestions');
  const emptyState = document.getElementById('empty-state');
  const engineList = document.getElementById('engine-list');

  emptyState.style.display = 'none';
  engineList.style.display = 'none';
  container.style.display = '';

  container.innerHTML = '';

  if (state.suggestions.length === 0) {
    if (state.query && state.query.trim()) {
      // Show "Press Enter to search" hint
      const hint = document.createElement('div');
      hint.className = 'suggestion-item selected';
      hint.innerHTML = `
        <div class="suggestion-icon">${searchIconSvg}</div>
        <div class="suggestion-text">Search for "${escapeHtml(state.query)}"</div>
      `;
      hint.addEventListener('click', () => {
        executeSearch(state.query);
      });
      container.appendChild(hint);
      state.selectedIndex = 0;
    }
    return;
  }

  state.suggestions.forEach((suggestion, index) => {
    const el = document.createElement('div');
    el.className = 'suggestion-item';
    if (index === state.selectedIndex) {
      el.classList.add('selected');
    }
    el.dataset.index = index;

    el.innerHTML = `
      <div class="suggestion-icon">${searchIconSvg}</div>
      <div class="suggestion-text">${escapeHtml(suggestion)}</div>
    `;

    el.addEventListener('click', () => {
      state.selectedIndex = index;
      updateSelection();
      executeSearch(suggestion);
    });

    container.appendChild(el);
  });

  // Add attribution
  const engine = state.currentEngine || state.engines.find(e => e.id === state.defaultEngineId);
  if (engine) {
    const attr = document.createElement('div');
    attr.className = 'attribution';
    attr.textContent = `Suggestions from ${engine.name}`;
    container.appendChild(attr);
  }
};

/**
 * Render engine list (when no query)
 */
const renderEngines = () => {
  const container = document.getElementById('engine-list');
  const suggestions = document.getElementById('suggestions');
  const emptyState = document.getElementById('empty-state');

  suggestions.style.display = 'none';
  emptyState.style.display = 'none';
  container.style.display = '';

  container.innerHTML = '';

  if (state.engines.length === 0) {
    emptyState.style.display = '';
    return;
  }

  const header = document.createElement('div');
  header.className = 'engine-list-header';
  header.textContent = 'Search Engines';
  container.appendChild(header);

  state.engines.forEach((engine, index) => {
    const el = document.createElement('div');
    el.className = 'engine-item';
    if (index === state.selectedIndex) {
      el.classList.add('selected');
    }
    el.dataset.index = index;

    const iconHtml = engine.iconUrl
      ? `<img class="engine-item-icon" src="${escapeHtml(engine.iconUrl)}" alt="" onerror="this.style.display='none'">`
      : `<div class="engine-item-icon"></div>`;

    const defaultBadge = engine.isDefault
      ? `<span class="engine-item-default">default</span>`
      : '';

    el.innerHTML = `
      ${iconHtml}
      <span class="engine-item-name">${escapeHtml(engine.name)}</span>
      <span class="engine-item-keyword">/${escapeHtml(engine.shortName)}</span>
      ${defaultBadge}
    `;

    el.addEventListener('click', () => {
      setCurrentEngine(engine);
      const searchInput = document.getElementById('search-input');
      searchInput.focus();
    });

    container.appendChild(el);
  });
};

/**
 * Update visual selection
 */
const updateSelection = () => {
  // Update suggestions
  const suggestionEls = document.querySelectorAll('.suggestion-item');
  suggestionEls.forEach((el, i) => {
    el.classList.toggle('selected', i === state.selectedIndex);
  });

  // Update engines
  const engineEls = document.querySelectorAll('.engine-item');
  engineEls.forEach((el, i) => {
    el.classList.toggle('selected', i === state.selectedIndex);
  });

  // Scroll selected into view
  const selected = document.querySelector('.selected');
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

// ===== Keyboard Navigation =====

/**
 * Handle escape for internal navigation
 */
const handleEscape = () => {
  const searchInput = document.getElementById('search-input');

  // If search has content, clear it
  if (state.query) {
    state.query = '';
    searchInput.value = '';
    state.suggestions = [];
    state.selectedIndex = -1;
    state.mode = 'engines';
    render();
    return { handled: true };
  }

  // Otherwise let the window close
  return { handled: false };
};

/**
 * Get the list of items for current mode
 */
const getCurrentItems = () => {
  if (state.mode === 'suggestions' || (state.query && state.query.trim())) {
    return state.suggestions.length > 0 ? state.suggestions : (state.query ? ['__search__'] : []);
  }
  return state.engines;
};

/**
 * Handle keyboard events
 */
const handleKeydown = (e) => {
  const searchInput = document.getElementById('search-input');
  const isSearchFocused = document.activeElement === searchInput ||
    (searchInput && searchInput.shadowRoot?.activeElement);

  // Don't intercept regular typing in search input (except navigation keys)
  if (isSearchFocused && !['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
    return;
  }

  const items = getCurrentItems();

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (items.length > 0 && state.selectedIndex < items.length - 1) {
        state.selectedIndex++;
        updateSelection();
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelection();
      }
      break;

    case 'Enter':
      e.preventDefault();
      if (state.mode === 'suggestions' || (state.query && state.query.trim())) {
        // If a suggestion is selected, search for it
        if (state.selectedIndex >= 0 && state.selectedIndex < state.suggestions.length) {
          executeSearch(state.suggestions[state.selectedIndex]);
        } else {
          // Search for the raw query
          executeSearch(state.query);
        }
      } else if (state.mode === 'engines' && state.selectedIndex >= 0 && state.selectedIndex < state.engines.length) {
        // Select engine
        setCurrentEngine(state.engines[state.selectedIndex]);
        searchInput.focus();
      }
      break;

    case 'Tab':
      // Autocomplete first suggestion
      if (state.suggestions.length > 0 && state.query) {
        e.preventDefault();
        const suggestion = state.suggestions[0];
        state.query = suggestion;
        searchInput.value = suggestion;
        state.selectedIndex = 0;
        updateSelection();
      }
      break;
  }
};

// ===== Event Subscriptions =====

/**
 * Handle suggestion responses from background
 */
const handleSuggestions = (msg) => {
  if (!msg) return;

  state.suggestions = msg.suggestions || [];
  state.mode = 'suggestions';
  state.selectedIndex = state.suggestions.length > 0 ? 0 : -1;
  render();
};

/**
 * Handle engine list response from background
 */
const handleEnginesList = (msg) => {
  if (!msg) return;

  state.engines = msg.engines || [];
  state.defaultEngineId = msg.defaultEngineId || 'duckduckgo';

  // Set default engine if none selected
  if (!state.currentEngine) {
    state.currentEngine = state.engines.find(e => e.id === state.defaultEngineId) || state.engines[0];
  }

  updateEngineIndicator();
  render();
};

// ===== Initialization =====

const init = async () => {
  debug && console.log('[websearch:home] init');

  // Register escape handler
  api.escape.onEscape(handleEscape);

  // Subscribe to events
  api.subscribe('websearch:suggestions', handleSuggestions, api.scopes.GLOBAL);
  api.subscribe('websearch:engines-list', handleEnginesList, api.scopes.GLOBAL);

  // Set up search input
  const searchInput = document.getElementById('search-input');

  // Auto-focus search input
  setTimeout(() => {
    searchInput.focus();
  }, 100);

  // Handle input for suggestions
  searchInput.addEventListener('input', (e) => {
    state.query = e.target.value;
    state.selectedIndex = -1;

    if (!state.query || !state.query.trim()) {
      state.suggestions = [];
      state.mode = 'engines';
      render();
      return;
    }

    state.mode = 'suggestions';
    requestSuggestions(state.query);
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Engine indicator click cycles engines
  const engineIndicator = document.getElementById('engine-indicator');
  engineIndicator.addEventListener('click', () => {
    if (state.engines.length === 0) return;

    const currentIndex = state.engines.findIndex(e => e.id === (state.currentEngine?.id || state.defaultEngineId));
    const nextIndex = (currentIndex + 1) % state.engines.length;
    setCurrentEngine(state.engines[nextIndex]);
  });

  // Re-focus search input on window focus
  window.addEventListener('focus', () => {
    searchInput.focus();
  });

  // Request engine list from background
  requestEngines();
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
