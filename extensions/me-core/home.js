/**
 * Me Home — AT Protocol identity and data browser UI
 *
 * Communicates with background.js via PubSub messages:
 * - me:get-session / me:session-state — get current session
 * - me:search-actors / me:search-actors:response — typeahead search
 * - me:do-login / me:session-changed / me:login-error — login flow
 * - me:do-logout / me:session-changed — logout
 * - me:get-collections / me:collections:response — fetch lexicons
 * - me:search-lexicons / me:search-lexicons:response — explore lexicons
 */

const api = window.app;

// ============================================================================
// State
// ============================================================================

let state = {
  authenticated: false,
  handle: null,
  did: null,
  pdsUrl: null,
  profile: null,
  collections: null, // null = not loaded, [] = empty
  selectedActor: null, // { handle, did, displayName, avatar }
  searchResults: [],
  searchVisible: false,
  activeIndex: -1,
  loading: false,
  error: null,
  // Nav / panels
  activePanel: 'my-lexicons', // 'my-lexicons' | 'explore'
  // Explore lexicons
  exploreLexicons: null, // null = not loaded, [] = loaded
  exploreFilter: '',
  exploreLoading: false,
  exploreError: null,
};

// DOM refs
let handleInput, searchResultsEl, selectedAccountEl;
let loginError, loginLoading;
let loginView, accountView, accountInfo, collectionsListEl, logoutBtn;
let exploreListEl, lexiconSearchEl;

// Debounce timer for search
let searchTimer = null;
let exploreFilterTimer = null;

// ============================================================================
// Init
// ============================================================================

async function init() {
  // Cache DOM refs
  handleInput = document.getElementById('handle-input');
  searchResultsEl = document.getElementById('search-results');
  selectedAccountEl = document.getElementById('selected-account');
  loginError = document.getElementById('login-error');
  loginLoading = document.getElementById('login-loading');
  loginView = document.getElementById('login-view');
  accountView = document.getElementById('account-view');
  accountInfo = document.getElementById('account-info');
  collectionsListEl = document.getElementById('collections-list');
  logoutBtn = document.getElementById('logout-btn');
  exploreListEl = document.getElementById('explore-list');
  lexiconSearchEl = document.getElementById('lexicon-search');

  // Set up event listeners
  setupEventListeners();

  // Set up nav listeners
  setupNav();

  // Set up PubSub listeners
  setupPubSub();

  // Request current session state from background
  api.publish('me:get-session', {}, api.scopes.GLOBAL);

  // Register escape handler
  if (api.escape) {
    api.escape.onEscape(handleEscape);
  }
}

// ============================================================================
// Escape handling
// ============================================================================

function handleEscape() {
  // If search results are visible, close them
  if (state.searchVisible) {
    state.searchVisible = false;
    state.searchResults = [];
    state.activeIndex = -1;
    renderSearchResults();
    return { handled: true };
  }

  // If an actor is selected but not yet logged in, clear selection
  if (state.selectedActor && !state.authenticated) {
    clearActorSelection();
    return { handled: true };
  }

  // Let window close
  return { handled: false };
}

// ============================================================================
// Event listeners
// ============================================================================

function setupEventListeners() {
  // Handle input for typeahead search
  handleInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);

    if (!query || query.length < 2) {
      state.searchResults = [];
      state.searchVisible = false;
      state.activeIndex = -1;
      renderSearchResults();
      return;
    }

    searchTimer = setTimeout(() => {
      api.publish('me:search-actors', { query }, api.scopes.GLOBAL);
    }, 250);
  });

  // Keyboard navigation in search results
  handleInput.addEventListener('keydown', (e) => {
    if (!state.searchVisible) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.activeIndex = Math.min(state.activeIndex + 1, state.searchResults.length - 1);
      renderSearchResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.activeIndex = Math.max(state.activeIndex - 1, 0);
      renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.activeIndex >= 0 && state.activeIndex < state.searchResults.length) {
        selectActor(state.searchResults[state.activeIndex]);
      }
    } else if (e.key === 'Escape') {
      state.searchVisible = false;
      renderSearchResults();
    }
  });

  // Close search results on blur (delayed to allow click)
  handleInput.addEventListener('blur', () => {
    setTimeout(() => {
      state.searchVisible = false;
      renderSearchResults();
    }, 200);
  });

  // Logout button
  logoutBtn.addEventListener('click', () => {
    api.publish('me:do-logout', {}, api.scopes.GLOBAL);
  });
}

// ============================================================================
// Navigation
// ============================================================================

function setupNav() {
  // Nav item clicks
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const panel = item.dataset.panel;
      switchPanel(panel);
    });
  });

  // Explore search input — peek-input fires native input event through shadow DOM
  if (lexiconSearchEl) {
    lexiconSearchEl.addEventListener('input', () => {
      const query = (lexiconSearchEl.value || '').trim().toLowerCase();
      state.exploreFilter = query;
      if (exploreFilterTimer) clearTimeout(exploreFilterTimer);
      exploreFilterTimer = setTimeout(() => {
        renderExploreLexicons();
      }, 100);
    });
  }
}

function switchPanel(panel) {
  state.activePanel = panel;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.panel === panel);
  });

  // Update panels
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });

  const panelEl = document.getElementById(`panel-${panel}`);
  if (panelEl) {
    panelEl.classList.add('active');
    panelEl.style.display = '';
  }

  // Lazy-load explore data on first visit
  if (panel === 'explore' && state.exploreLexicons === null && !state.exploreLoading) {
    loadExploreLexicons();
  }
}

function loadExploreLexicons() {
  state.exploreLoading = true;
  state.exploreError = null;
  exploreListEl.innerHTML = '<div class="loading">Loading lexicon directory...</div>';
  api.publish('me:search-lexicons', {}, api.scopes.GLOBAL);
}

function renderExploreLexicons() {
  if (!exploreListEl) return;

  if (state.exploreLoading) {
    exploreListEl.innerHTML = '<div class="loading">Loading lexicon directory...</div>';
    return;
  }

  if (state.exploreError) {
    exploreListEl.innerHTML = `<div class="explore-error">${escapeHtml(state.exploreError)}</div>`;
    return;
  }

  if (!state.exploreLexicons || state.exploreLexicons.length === 0) {
    exploreListEl.innerHTML = '<div class="explore-empty">No lexicons found</div>';
    return;
  }

  // Filter
  const filter = state.exploreFilter;
  const filtered = filter
    ? state.exploreLexicons.filter(lex => lex.nsid.toLowerCase().includes(filter))
    : state.exploreLexicons;

  if (filtered.length === 0) {
    exploreListEl.innerHTML = `<div class="explore-empty">No lexicons matching "${escapeHtml(filter)}"</div>`;
    return;
  }

  // Group by domain
  const groups = {};
  for (const lex of filtered) {
    const domain = lex.domain || 'unknown';
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(lex);
  }

  const statsHtml = `<div class="explore-stats">${filtered.length} lexicon${filtered.length !== 1 ? 's' : ''}${filter ? ' matched' : ' loaded'}</div>`;

  const groupsHtml = Object.entries(groups).map(([domain, lexicons]) => {
    const items = lexicons.map(lex => `
      <div class="explore-item" title="${escapeHtml(lex.nsid)}">
        <span class="explore-nsid">${escapeHtml(lex.nsid)}</span>
      </div>
    `).join('');

    return `
      <div class="explore-domain-group">
        <div class="explore-domain-label">${escapeHtml(domain)}</div>
        ${items}
      </div>
    `;
  }).join('');

  exploreListEl.innerHTML = statsHtml + groupsHtml;
}

// ============================================================================
// PubSub
// ============================================================================

function setupPubSub() {
  // Session state response (initial load)
  api.subscribe('me:session-state', (msg) => {
    state.authenticated = msg.authenticated;
    if (msg.authenticated) {
      state.handle = msg.handle;
      state.did = msg.did;
      state.pdsUrl = msg.pdsUrl;
      state.profile = msg.profile;
      showAccountView();
    } else {
      showLoginView();
    }
  }, api.scopes.GLOBAL);

  // Session changed (login/logout)
  api.subscribe('me:session-changed', (msg) => {
    state.loading = false;
    state.error = null;

    if (msg.authenticated) {
      state.authenticated = true;
      state.handle = msg.handle;
      state.did = msg.did;
      state.pdsUrl = msg.pdsUrl;
      state.profile = msg.profile;
      showAccountView();
    } else {
      state.authenticated = false;
      state.handle = null;
      state.did = null;
      state.pdsUrl = null;
      state.profile = null;
      state.collections = null;
      showLoginView();
    }
  }, api.scopes.GLOBAL);

  // Login error
  api.subscribe('me:login-error', (msg) => {
    state.loading = false;
    state.error = msg.message;
    renderLoginState();
  }, api.scopes.GLOBAL);

  // Search results
  api.subscribe('me:search-actors:response', (msg) => {
    state.searchResults = msg.results || [];
    state.searchVisible = state.searchResults.length > 0;
    state.activeIndex = -1;
    renderSearchResults();
  }, api.scopes.GLOBAL);

  // Collections response
  api.subscribe('me:collections:response', (msg) => {
    if (msg.error) {
      collectionsListEl.innerHTML = `<div class="error">${escapeHtml(msg.error)}</div>`;
      return;
    }
    state.collections = msg.collections || [];
    renderCollections();
  }, api.scopes.GLOBAL);

  // Explore lexicons response
  api.subscribe('me:search-lexicons:response', (msg) => {
    state.exploreLoading = false;
    if (msg.error) {
      state.exploreError = msg.error;
    } else {
      state.exploreLexicons = msg.lexicons || [];
    }
    renderExploreLexicons();
  }, api.scopes.GLOBAL);
}

// ============================================================================
// Actions
// ============================================================================

function selectActor(actor) {
  state.selectedActor = actor;
  state.searchResults = [];
  state.searchVisible = false;
  state.activeIndex = -1;

  renderSearchResults();
  renderSelectedAccount();

  // Immediately start OAuth login
  doLogin();
}

function clearActorSelection() {
  state.selectedActor = null;
  state.error = null;

  handleInput.value = '';
  handleInput.style.display = '';
  selectedAccountEl.style.display = 'none';
  loginError.style.display = 'none';

  handleInput.focus();
}

function doLogin() {
  if (!state.selectedActor) return;

  state.loading = true;
  state.error = null;
  renderLoginState();

  api.publish('me:do-login', {
    handle: state.selectedActor.handle,
  }, api.scopes.GLOBAL);
}

// ============================================================================
// Render
// ============================================================================

function showLoginView() {
  loginView.style.display = '';
  accountView.style.display = 'none';

  // Reset login form
  handleInput.value = '';
  handleInput.style.display = '';
  selectedAccountEl.style.display = 'none';
  loginError.style.display = 'none';
  loginLoading.style.display = 'none';
  state.selectedActor = null;
  state.loading = false;
  state.error = null;
}

function showAccountView() {
  loginView.style.display = 'none';
  accountView.style.display = '';

  renderAccountInfo();

  // Fetch collections
  state.collections = null;
  collectionsListEl.innerHTML = '<div class="loading">Loading collections...</div>';
  api.publish('me:get-collections', {}, api.scopes.GLOBAL);
}

function renderSearchResults() {
  if (!state.searchVisible || state.searchResults.length === 0) {
    searchResultsEl.classList.remove('visible');
    searchResultsEl.innerHTML = '';
    return;
  }

  searchResultsEl.classList.add('visible');
  searchResultsEl.innerHTML = state.searchResults.map((actor, i) => {
    const initial = ((actor.handle || '?')[0]).toUpperCase();
    const avatarHtml = actor.avatar
      ? `<img class="search-result-avatar" src="${escapeHtml(actor.avatar)}" alt="">`
      : `<span class="search-result-placeholder">${initial}</span>`;

    return `
      <div class="search-result-item ${i === state.activeIndex ? 'active' : ''}" data-index="${i}">
        ${avatarHtml}
        <div class="search-result-info">
          <div class="search-result-name">${escapeHtml(actor.displayName || actor.handle)}</div>
          <div class="search-result-handle">@${escapeHtml(actor.handle)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Click handlers for results
  searchResultsEl.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Prevent blur
      const idx = parseInt(el.dataset.index, 10);
      selectActor(state.searchResults[idx]);
    });
  });
}

function renderSelectedAccount() {
  if (!state.selectedActor) return;

  const actor = state.selectedActor;
  const initial = ((actor.handle || '?')[0]).toUpperCase();
  const avatarHtml = actor.avatar
    ? `<img class="selected-account-avatar" src="${escapeHtml(actor.avatar)}" alt="">`
    : `<span class="selected-account-placeholder">${initial}</span>`;

  selectedAccountEl.innerHTML = `
    ${avatarHtml}
    <div class="selected-account-info">
      <div class="selected-account-name">${escapeHtml(actor.displayName || actor.handle)}</div>
      <div class="selected-account-handle">@${escapeHtml(actor.handle)}</div>
    </div>
    <button class="selected-account-clear" title="Clear selection">&times;</button>
  `;

  selectedAccountEl.querySelector('.selected-account-clear').addEventListener('click', clearActorSelection);

  // Show selected account, hide search input
  handleInput.style.display = 'none';
  selectedAccountEl.style.display = 'flex';
}

function renderLoginState() {
  if (state.loading) {
    loginLoading.style.display = '';
    loginError.style.display = 'none';
  } else {
    loginLoading.style.display = 'none';
  }

  if (state.error) {
    loginError.textContent = state.error;
    loginError.style.display = '';
  } else {
    loginError.style.display = 'none';
  }
}

function renderAccountInfo() {
  const profile = state.profile || {};
  const displayName = profile.displayName || state.handle;
  const initial = ((state.handle || '?')[0]).toUpperCase();

  const avatarHtml = profile.avatar
    ? `<img class="account-avatar" src="${escapeHtml(profile.avatar)}" alt="">`
    : `<span class="account-placeholder">${initial}</span>`;

  accountInfo.innerHTML = `
    ${avatarHtml}
    <div class="account-details">
      <div class="account-name">${escapeHtml(displayName)}</div>
      <div class="account-handle">@${escapeHtml(state.handle)}</div>
      <div class="account-did">${escapeHtml(state.did)}</div>
    </div>
  `;
}

function renderCollections() {
  if (!state.collections || state.collections.length === 0) {
    collectionsListEl.innerHTML = '<div class="collections-empty">No collections found</div>';
    return;
  }

  collectionsListEl.innerHTML = state.collections.map(col => {
    const countLabel = col.hasMore ? `${col.count}+` : String(col.count);
    return `
      <div class="collection-item">
        <span class="collection-nsid">${escapeHtml(col.nsid)}</span>
        <span class="collection-count">${countLabel}</span>
      </div>
    `;
  }).join('');
}

// ============================================================================
// Helpers
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// Bootstrap
// ============================================================================

document.addEventListener('DOMContentLoaded', init);
