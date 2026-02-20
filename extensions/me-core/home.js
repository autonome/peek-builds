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
 * - me:create-record / me:create-record:response — create a record
 */

import {
  resolveLexicon,
  getRecordSchema,
  isRecordType,
  generateForm,
  collectFormData,
  createRawJsonEditor,
  parseRawJson,
  nsidToFriendlyName,
} from './lexicon-ui.js';

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
  activePanel: 'my-lexicons', // 'my-lexicons' | 'explore' | 'create-record'
  previousPanel: null,
  // My lexicons filter
  myLexiconsFilter: '',
  // Explore lexicons
  exploreLexicons: null, // null = not loaded, [] = loaded
  exploreFilter: '',
  exploreLoading: false,
  exploreError: null,
  // Create record (detail panel)
  createNsid: null,
  createLexicon: null,
  createSchema: null,
  createMode: 'form', // 'form' | 'json'
  createSubmitting: false,
  // Recent lexicons (persisted)
  recentLexicons: [], // array of NSIDs
  // Create panel (dedicated nav)
  cpNsid: null,
  cpLexicon: null,
  cpSchema: null,
  cpMode: 'form',
  cpSubmitting: false,
  pickerFilter: '',
  pickerVisible: false,
  pickerActiveIndex: -1,
};

// DOM refs
let handleInput, searchResultsEl, selectedAccountEl;
let loginError, loginLoading;
let loginView, accountView, accountInfo, collectionsListEl, logoutBtn;
let exploreListEl, lexiconSearchEl, myLexiconsSearchEl;
// Create record DOM refs (detail panel from My Lexicons / Explore)
let createFormContainer, createJsonContainer, createSchemaLoading, createSchemaError;
let createSubmitArea, createSubmitBtn, createSubmitStatus, createRecordNsidEl;
let modeFormBtn, modeJsonBtn, createRecordBackBtn;

// Recent lexicons DOM ref
let recentLexiconsEl;

// Create panel DOM refs (dedicated nav panel)
let pickerInput, pickerResults, pickerSelected;
let cpFormContainer, cpJsonContainer, cpSchemaLoading, cpSchemaError, cpEmpty;
let cpModeToggle, cpModeFormBtn, cpModeJsonBtn;
let cpFooter, cpSubmitBtn, cpSubmitStatus;

// Debounce timer for search
let searchTimer = null;

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
  myLexiconsSearchEl = document.getElementById('my-lexicons-search');

  // Create record refs
  createFormContainer = document.getElementById('create-form-container');
  createJsonContainer = document.getElementById('create-json-container');
  createSchemaLoading = document.getElementById('create-schema-loading');
  createSchemaError = document.getElementById('create-schema-error');
  createSubmitArea = document.getElementById('create-submit-area');
  createSubmitBtn = document.getElementById('create-submit-btn');
  createSubmitStatus = document.getElementById('create-submit-status');
  createRecordNsidEl = document.getElementById('create-record-nsid');
  modeFormBtn = document.getElementById('mode-form');
  modeJsonBtn = document.getElementById('mode-json');
  createRecordBackBtn = document.getElementById('create-record-back');

  // Recent lexicons ref
  recentLexiconsEl = document.getElementById('recent-lexicons');

  // Create panel (dedicated nav) refs
  pickerInput = document.getElementById('lexicon-picker-input');
  pickerResults = document.getElementById('lexicon-picker-results');
  pickerSelected = document.getElementById('lexicon-picker-selected');
  cpFormContainer = document.getElementById('create-panel-form-container');
  cpJsonContainer = document.getElementById('create-panel-json-container');
  cpSchemaLoading = document.getElementById('create-panel-schema-loading');
  cpSchemaError = document.getElementById('create-panel-schema-error');
  cpEmpty = document.getElementById('create-panel-empty');
  cpModeToggle = document.getElementById('create-panel-mode-toggle');
  cpModeFormBtn = document.getElementById('create-panel-mode-form');
  cpModeJsonBtn = document.getElementById('create-panel-mode-json');
  cpFooter = document.getElementById('create-panel-footer');
  cpSubmitBtn = document.getElementById('create-panel-submit-btn');
  cpSubmitStatus = document.getElementById('create-panel-submit-status');

  // Set up event listeners
  setupEventListeners();

  // Set up nav listeners
  setupNav();

  // Set up PubSub listeners
  setupPubSub();

  // Set up create record UI (detail panel)
  setupCreateRecord();

  // Set up create panel (dedicated nav)
  setupCreatePanel();

  // Load recent lexicons from storage
  loadRecentLexicons();

  // Listen for recent lexicons changes from background (e.g. chain-form submissions)
  api.subscribe('me:recent-lexicons-changed', (msg) => {
    if (Array.isArray(msg.nsids)) {
      state.recentLexicons = msg.nsids;
      renderRecentLexicons();
    }
  }, api.scopes.GLOBAL);

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
  // If picker dropdown is visible, close it
  if (state.pickerVisible) {
    state.pickerVisible = false;
    pickerResults.classList.remove('visible');
    pickerResults.innerHTML = '';
    return { handled: true };
  }

  // If in create-record panel, go back
  if (state.activePanel === 'create-record') {
    goBackFromCreate();
    return { handled: true };
  }

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

  // My Lexicons filter
  if (myLexiconsSearchEl) {
    myLexiconsSearchEl.addEventListener('input', () => {
      state.myLexiconsFilter = (myLexiconsSearchEl.value || '').trim().toLowerCase();
      renderCollections();
    });
  }

  // Explore search filter
  if (lexiconSearchEl) {
    lexiconSearchEl.addEventListener('input', () => {
      state.exploreFilter = (lexiconSearchEl.value || '').trim().toLowerCase();
      renderExploreLexicons();
    });
  }
}

function switchPanel(panel) {
  state.activePanel = panel;

  // Update nav items (don't highlight for create-record — it's a sub-panel)
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

  // Lazy-load explore data on first visit or when create panel needs it
  if ((panel === 'explore' || panel === 'create') && state.exploreLexicons === null && !state.exploreLoading) {
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
    exploreListEl.innerHTML = `<div class="error">${escapeHtml(state.exploreError)}</div>`;
    return;
  }

  if (!state.exploreLexicons || state.exploreLexicons.length === 0) {
    exploreListEl.innerHTML = '<div class="collections-empty">No lexicons found</div>';
    return;
  }

  // Filter
  const filter = state.exploreFilter;
  const filtered = filter
    ? state.exploreLexicons.filter(lex => lex.nsid.toLowerCase().includes(filter))
    : state.exploreLexicons;

  if (filtered.length === 0) {
    exploreListEl.innerHTML = `<div class="collections-empty">No lexicons matching "${escapeHtml(filter)}"</div>`;
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
    const items = lexicons.map(lex => {
      const friendly = nsidToFriendlyName(lex.nsid);
      return `
        <div class="collection-item clickable" data-nsid="${escapeHtml(lex.nsid)}" title="${escapeHtml(lex.nsid)}">
          <div class="collection-info">
            <span class="collection-friendly">${escapeHtml(friendly)}</span>
            <span class="collection-nsid">${escapeHtml(lex.nsid)}</span>
          </div>
          <span class="collection-action">Create</span>
        </div>
      `;
    }).join('');

    return `
      <div class="domain-group-label">${escapeHtml(domain)}</div>
      ${items}
    `;
  }).join('');

  exploreListEl.innerHTML = statsHtml + groupsHtml;

  // Attach click handlers for "Create" action
  exploreListEl.querySelectorAll('.collection-item.clickable').forEach(el => {
    el.addEventListener('click', () => {
      const nsid = el.dataset.nsid;
      if (nsid) openCreateRecord(nsid, 'explore');
    });
  });
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

  // Open create panel with a specific lexicon (from command palette)
  api.subscribe('me:open-create', (msg) => {
    if (!state.authenticated) return;
    if (msg.nsid) {
      switchPanel('create');
      selectPickerLexicon(msg.nsid);
    } else {
      switchPanel('create');
    }
  }, api.scopes.GLOBAL);

  // Create record response — handles both detail panel and dedicated create panel
  api.subscribe('me:create-record:response', (msg) => {
    // Determine which panel is active and update accordingly
    const isCreatePanel = state.activePanel === 'create';

    if (isCreatePanel) {
      state.cpSubmitting = false;
      cpSubmitBtn.disabled = false;
      cpSubmitBtn.textContent = 'Create Record';

      if (msg.error) {
        cpSubmitStatus.className = 'submit-status error';
        cpSubmitStatus.textContent = msg.error;
        cpSubmitStatus.style.display = '';
      } else {
        cpSubmitStatus.className = 'submit-status success';
        const validationNote = msg.validationStatus === 'unknown' ? ' (unvalidated)' : '';
        cpSubmitStatus.innerHTML = `
          Record created successfully${validationNote}
          <div class="record-uri">${escapeHtml(msg.uri)}</div>
        `;
        cpSubmitStatus.style.display = '';
        api.publish('me:get-collections', {}, api.scopes.GLOBAL);
        if (state.cpNsid) addRecentLexicon(state.cpNsid);
      }
    } else {
      state.createSubmitting = false;
      createSubmitBtn.disabled = false;
      createSubmitBtn.textContent = 'Create Record';

      if (msg.error) {
        createSubmitStatus.className = 'submit-status error';
        createSubmitStatus.textContent = msg.error;
        createSubmitStatus.style.display = '';
      } else {
        createSubmitStatus.className = 'submit-status success';
        const validationNote = msg.validationStatus === 'unknown' ? ' (unvalidated)' : '';
        createSubmitStatus.innerHTML = `
          Record created successfully${validationNote}
          <div class="record-uri">${escapeHtml(msg.uri)}</div>
        `;
        createSubmitStatus.style.display = '';
        api.publish('me:get-collections', {}, api.scopes.GLOBAL);
        if (state.createNsid) addRecentLexicon(state.createNsid);
      }
    }
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

  const filter = state.myLexiconsFilter;
  const filtered = filter
    ? state.collections.filter(col => col.nsid.toLowerCase().includes(filter))
    : state.collections;

  if (filtered.length === 0) {
    collectionsListEl.innerHTML = `<div class="collections-empty">No lexicons matching "${escapeHtml(filter)}"</div>`;
    return;
  }

  collectionsListEl.innerHTML = filtered.map(col => {
    const countLabel = col.hasMore ? `${col.count}+` : String(col.count);
    const friendly = nsidToFriendlyName(col.nsid);
    return `
      <div class="collection-item clickable" data-nsid="${escapeHtml(col.nsid)}" title="${escapeHtml(col.nsid)}">
        <div class="collection-info">
          <span class="collection-friendly">${escapeHtml(friendly)}</span>
          <span class="collection-nsid">${escapeHtml(col.nsid)}</span>
        </div>
        <div class="collection-right">
          <span class="collection-count">${countLabel}</span>
          <span class="collection-action">Create</span>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers for "Create" action
  collectionsListEl.querySelectorAll('.collection-item.clickable').forEach(el => {
    el.addEventListener('click', () => {
      const nsid = el.dataset.nsid;
      if (nsid) openCreateRecord(nsid, 'my-lexicons');
    });
  });
}

// ============================================================================
// Create Record
// ============================================================================

function setupCreateRecord() {
  // Back button
  createRecordBackBtn.addEventListener('click', goBackFromCreate);

  // Mode toggle
  modeFormBtn.addEventListener('click', () => {
    state.createMode = 'form';
    modeFormBtn.classList.add('active');
    modeJsonBtn.classList.remove('active');
    createFormContainer.style.display = '';
    createJsonContainer.style.display = 'none';
  });

  modeJsonBtn.addEventListener('click', () => {
    state.createMode = 'json';
    modeJsonBtn.classList.add('active');
    modeFormBtn.classList.remove('active');
    createFormContainer.style.display = 'none';
    createJsonContainer.style.display = '';
    // Lazy-init the JSON editor
    if (createJsonContainer.children.length === 0 && state.createNsid) {
      const editor = createRawJsonEditor(state.createNsid);
      createJsonContainer.appendChild(editor);
    }
  });

  // Submit button
  createSubmitBtn.addEventListener('click', handleCreateSubmit);
}

/**
 * Open the create record panel for a given NSID.
 */
async function openCreateRecord(nsid, fromPanel) {
  state.previousPanel = fromPanel;
  state.createNsid = nsid;
  state.createLexicon = null;
  state.createSchema = null;
  state.createMode = 'form';
  state.createSubmitting = false;

  // Reset UI — show friendly name as title, NSID as subtitle
  const friendly = nsidToFriendlyName(nsid);
  createRecordNsidEl.innerHTML = `
    <span class="create-record-friendly">${escapeHtml(friendly)}</span>
    <span class="create-record-nsid-sub">${escapeHtml(nsid)}</span>
  `;
  createFormContainer.innerHTML = '';
  createJsonContainer.innerHTML = '';
  createSchemaLoading.style.display = '';
  createSchemaError.style.display = 'none';
  createSubmitArea.style.display = 'none';
  createSubmitStatus.style.display = 'none';
  modeFormBtn.classList.add('active');
  modeJsonBtn.classList.remove('active');
  createFormContainer.style.display = '';
  createJsonContainer.style.display = 'none';

  // Switch to create-record panel
  switchPanel('create-record');

  // Fetch the lexicon schema
  try {
    const lexicon = await resolveLexicon(nsid);
    createSchemaLoading.style.display = 'none';

    if (!lexicon) {
      // Could not resolve — show JSON editor only
      createSchemaError.textContent = 'Could not resolve lexicon schema. Use Raw JSON mode to create a record.';
      createSchemaError.style.display = '';
      modeJsonBtn.click();
      createSubmitArea.style.display = '';
      return;
    }

    state.createLexicon = lexicon;
    const schema = getRecordSchema(lexicon);

    if (!schema) {
      createSchemaError.textContent = 'This lexicon does not define a record type. It may be a query or procedure.';
      createSchemaError.style.display = '';
      // Still allow JSON mode
      modeJsonBtn.click();
      createSubmitArea.style.display = '';
      return;
    }

    state.createSchema = schema;

    // Generate the form
    const form = await generateForm(nsid, schema, lexicon, {
      autoFillCreatedAt: true,
    });
    createFormContainer.appendChild(form);

    // Show submit area
    createSubmitArea.style.display = '';

  } catch (err) {
    createSchemaLoading.style.display = 'none';
    createSchemaError.textContent = `Failed to load schema: ${err.message}`;
    createSchemaError.style.display = '';
    // Allow JSON fallback
    createSubmitArea.style.display = '';
  }
}

function goBackFromCreate() {
  const target = state.previousPanel || 'my-lexicons';
  state.createNsid = null;
  state.createLexicon = null;
  state.createSchema = null;
  switchPanel(target);
}

/**
 * Handle the create record submit action.
 */
async function handleCreateSubmit() {
  if (state.createSubmitting || !state.createNsid) return;

  state.createSubmitting = true;
  createSubmitBtn.disabled = true;
  createSubmitBtn.textContent = 'Creating...';
  createSubmitStatus.style.display = 'none';

  try {
    let record;

    if (state.createMode === 'json') {
      // Parse from JSON editor
      record = parseRawJson(createJsonContainer, state.createNsid);
    } else {
      // Collect from generated form
      const form = createFormContainer.querySelector('.lexicon-form');
      if (!form) {
        throw new Error('No form found. Switch to Raw JSON mode.');
      }
      record = await collectFormData(form, state.createSchema, state.createLexicon, state.createNsid);
    }

    // Validate required fields
    if (state.createSchema && state.createMode === 'form') {
      const required = state.createSchema.required || [];
      const missing = required.filter(f => {
        const val = record[f];
        return val === undefined || val === null || val === '';
      });
      if (missing.length > 0) {
        throw new Error(`Required fields missing: ${missing.join(', ')}`);
      }
    }

    // Send to background for creation
    api.publish('me:create-record', {
      collection: state.createNsid,
      record,
    }, api.scopes.GLOBAL);

  } catch (err) {
    state.createSubmitting = false;
    createSubmitBtn.disabled = false;
    createSubmitBtn.textContent = 'Create Record';
    createSubmitStatus.className = 'submit-status error';
    createSubmitStatus.textContent = err.message;
    createSubmitStatus.style.display = '';
  }
}

// ============================================================================
// Create Panel (dedicated nav)
// ============================================================================

function setupCreatePanel() {
  // Picker input — filter as you type
  pickerInput.addEventListener('input', () => {
    state.pickerFilter = pickerInput.value.trim().toLowerCase();
    renderPickerResults();
  });

  pickerInput.addEventListener('focus', () => {
    if (pickerInput.value.trim().length > 0 || getPickerItems().length > 0) {
      renderPickerResults();
    }
  });

  // Keyboard nav in picker
  pickerInput.addEventListener('keydown', (e) => {
    if (!state.pickerVisible) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        renderPickerResults();
      }
      return;
    }

    const items = pickerResults.querySelectorAll('.picker-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.pickerActiveIndex = Math.min(state.pickerActiveIndex + 1, items.length - 1);
      updatePickerActiveItem(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.pickerActiveIndex = Math.max(state.pickerActiveIndex - 1, 0);
      updatePickerActiveItem(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.pickerActiveIndex >= 0 && state.pickerActiveIndex < items.length) {
        const nsid = items[state.pickerActiveIndex].dataset.nsid;
        if (nsid) selectPickerLexicon(nsid);
      }
    } else if (e.key === 'Escape') {
      state.pickerVisible = false;
      pickerResults.classList.remove('visible');
    }
  });

  // Close picker on blur (delayed for click)
  pickerInput.addEventListener('blur', () => {
    setTimeout(() => {
      state.pickerVisible = false;
      pickerResults.classList.remove('visible');
    }, 200);
  });

  // Mode toggle
  cpModeFormBtn.addEventListener('click', () => {
    state.cpMode = 'form';
    cpModeFormBtn.classList.add('active');
    cpModeJsonBtn.classList.remove('active');
    cpFormContainer.style.display = '';
    cpJsonContainer.style.display = 'none';
  });

  cpModeJsonBtn.addEventListener('click', () => {
    state.cpMode = 'json';
    cpModeJsonBtn.classList.add('active');
    cpModeFormBtn.classList.remove('active');
    cpFormContainer.style.display = 'none';
    cpJsonContainer.style.display = '';
    if (cpJsonContainer.children.length === 0 && state.cpNsid) {
      const editor = createRawJsonEditor(state.cpNsid);
      cpJsonContainer.appendChild(editor);
    }
  });

  // Submit
  cpSubmitBtn.addEventListener('click', handleCreatePanelSubmit);
}

/**
 * Build the combined list of lexicons for the picker.
 * User's collections first (with badge), then explore directory.
 */
function getPickerItems() {
  const filter = state.pickerFilter;
  const results = [];
  const seen = new Set();

  // User's own collections first
  if (state.collections && state.collections.length > 0) {
    const userItems = state.collections
      .filter(col => !filter || col.nsid.toLowerCase().includes(filter))
      .map(col => ({ nsid: col.nsid, inRepo: true }));
    for (const item of userItems) {
      results.push(item);
      seen.add(item.nsid);
    }
  }

  // Explore lexicons
  if (state.exploreLexicons && state.exploreLexicons.length > 0) {
    const exploreItems = state.exploreLexicons
      .filter(lex => !filter || lex.nsid.toLowerCase().includes(filter))
      .filter(lex => !seen.has(lex.nsid))
      .map(lex => ({ nsid: lex.nsid, inRepo: false }));
    results.push(...exploreItems);
  }

  return results;
}

function renderPickerResults() {
  const items = getPickerItems();

  if (items.length === 0 && !state.pickerFilter) {
    // Nothing loaded yet
    if (state.exploreLoading) {
      pickerResults.innerHTML = '<div class="loading" style="padding: 12px 14px;">Loading lexicons...</div>';
      pickerResults.classList.add('visible');
      state.pickerVisible = true;
    } else {
      pickerResults.classList.remove('visible');
      state.pickerVisible = false;
    }
    return;
  }

  if (items.length === 0) {
    pickerResults.innerHTML = `<div style="padding: 12px 14px; color: var(--base04); font-size: 13px;">No lexicons matching "${escapeHtml(state.pickerFilter)}"</div>`;
    pickerResults.classList.add('visible');
    state.pickerVisible = true;
    state.pickerActiveIndex = -1;
    return;
  }

  // Separate into groups
  const inRepo = items.filter(i => i.inRepo);
  const other = items.filter(i => !i.inRepo);

  let html = '';

  if (inRepo.length > 0) {
    html += '<div class="picker-group-label">In your repo</div>';
    html += inRepo.map(item => {
      const friendly = nsidToFriendlyName(item.nsid);
      return `
        <div class="picker-item" data-nsid="${escapeHtml(item.nsid)}" title="${escapeHtml(item.nsid)}">
          <div class="picker-item-info">
            <span class="picker-item-friendly">${escapeHtml(friendly)}</span>
            <span class="picker-item-nsid">${escapeHtml(item.nsid)}</span>
          </div>
          <span class="picker-item-badge">yours</span>
        </div>
      `;
    }).join('');
  }

  if (other.length > 0) {
    // Limit to 50 results to avoid a huge list
    const shown = other.slice(0, 50);
    html += '<div class="picker-group-label">All lexicons</div>';
    html += shown.map(item => {
      const friendly = nsidToFriendlyName(item.nsid);
      return `
        <div class="picker-item" data-nsid="${escapeHtml(item.nsid)}" title="${escapeHtml(item.nsid)}">
          <div class="picker-item-info">
            <span class="picker-item-friendly">${escapeHtml(friendly)}</span>
            <span class="picker-item-nsid">${escapeHtml(item.nsid)}</span>
          </div>
        </div>
      `;
    }).join('');
    if (other.length > 50) {
      html += `<div style="padding: 8px 14px; color: var(--base04); font-size: 12px;">${other.length - 50} more — type to filter</div>`;
    }
  }

  pickerResults.innerHTML = html;
  pickerResults.classList.add('visible');
  state.pickerVisible = true;
  state.pickerActiveIndex = -1;

  // Click handlers
  pickerResults.querySelectorAll('.picker-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const nsid = el.dataset.nsid;
      if (nsid) selectPickerLexicon(nsid);
    });
  });
}

function updatePickerActiveItem(items) {
  items.forEach((el, i) => {
    el.classList.toggle('active', i === state.pickerActiveIndex);
  });
  // Scroll active into view
  if (state.pickerActiveIndex >= 0 && items[state.pickerActiveIndex]) {
    items[state.pickerActiveIndex].scrollIntoView({ block: 'nearest' });
  }
}

async function selectPickerLexicon(nsid) {
  // Close picker
  state.pickerVisible = false;
  pickerResults.classList.remove('visible');
  pickerResults.innerHTML = '';

  // Show selected
  state.cpNsid = nsid;
  state.cpLexicon = null;
  state.cpSchema = null;
  state.cpMode = 'form';
  state.cpSubmitting = false;

  pickerInput.style.display = 'none';
  pickerSelected.style.display = 'flex';
  const pickerFriendly = nsidToFriendlyName(nsid);
  pickerSelected.innerHTML = `
    <div class="picker-selected-info">
      <span class="picker-selected-friendly">${escapeHtml(pickerFriendly)}</span>
      <span class="picker-selected-nsid">${escapeHtml(nsid)}</span>
    </div>
    <button class="picker-selected-clear" title="Change lexicon">&times;</button>
  `;
  pickerSelected.querySelector('.picker-selected-clear').addEventListener('click', clearPickerSelection);

  // Reset form area
  cpFormContainer.innerHTML = '';
  cpJsonContainer.innerHTML = '';
  cpSchemaLoading.style.display = '';
  cpSchemaError.style.display = 'none';
  cpEmpty.style.display = 'none';
  cpModeToggle.style.display = 'none';
  cpFooter.style.display = 'none';
  cpSubmitStatus.style.display = 'none';
  cpModeFormBtn.classList.add('active');
  cpModeJsonBtn.classList.remove('active');
  cpFormContainer.style.display = '';
  cpJsonContainer.style.display = 'none';

  // Fetch schema and generate form
  try {
    const lexicon = await resolveLexicon(nsid);
    cpSchemaLoading.style.display = 'none';

    if (!lexicon) {
      cpSchemaError.textContent = 'Could not resolve lexicon schema. Use Raw JSON mode.';
      cpSchemaError.style.display = '';
      cpModeToggle.style.display = '';
      cpModeJsonBtn.click();
      cpFooter.style.display = '';
      return;
    }

    state.cpLexicon = lexicon;
    const schema = getRecordSchema(lexicon);

    if (!schema) {
      cpSchemaError.textContent = 'This lexicon does not define a record type. It may be a query or procedure.';
      cpSchemaError.style.display = '';
      cpModeToggle.style.display = '';
      cpModeJsonBtn.click();
      cpFooter.style.display = '';
      return;
    }

    state.cpSchema = schema;

    const form = await generateForm(nsid, schema, lexicon, {
      autoFillCreatedAt: true,
    });
    cpFormContainer.appendChild(form);

    cpModeToggle.style.display = '';
    cpFooter.style.display = '';
  } catch (err) {
    cpSchemaLoading.style.display = 'none';
    cpSchemaError.textContent = `Failed to load schema: ${err.message}`;
    cpSchemaError.style.display = '';
    cpModeToggle.style.display = '';
    cpFooter.style.display = '';
  }
}

function clearPickerSelection() {
  state.cpNsid = null;
  state.cpLexicon = null;
  state.cpSchema = null;

  pickerInput.style.display = '';
  pickerInput.value = '';
  pickerSelected.style.display = 'none';

  cpFormContainer.innerHTML = '';
  cpJsonContainer.innerHTML = '';
  cpSchemaLoading.style.display = 'none';
  cpSchemaError.style.display = 'none';
  cpEmpty.style.display = '';
  cpModeToggle.style.display = 'none';
  cpFooter.style.display = 'none';
  cpSubmitStatus.style.display = 'none';

  state.pickerFilter = '';
  pickerInput.focus();
}

async function handleCreatePanelSubmit() {
  if (state.cpSubmitting || !state.cpNsid) return;

  state.cpSubmitting = true;
  cpSubmitBtn.disabled = true;
  cpSubmitBtn.textContent = 'Creating...';
  cpSubmitStatus.style.display = 'none';

  try {
    let record;

    if (state.cpMode === 'json') {
      record = parseRawJson(cpJsonContainer, state.cpNsid);
    } else {
      const form = cpFormContainer.querySelector('.lexicon-form');
      if (!form) throw new Error('No form found. Switch to Raw JSON mode.');
      record = await collectFormData(form, state.cpSchema, state.cpLexicon, state.cpNsid);
    }

    // Validate required fields
    if (state.cpSchema && state.cpMode === 'form') {
      const required = state.cpSchema.required || [];
      const missing = required.filter(f => {
        const val = record[f];
        return val === undefined || val === null || val === '';
      });
      if (missing.length > 0) {
        throw new Error(`Required fields missing: ${missing.join(', ')}`);
      }
    }

    api.publish('me:create-record', {
      collection: state.cpNsid,
      record,
    }, api.scopes.GLOBAL);
  } catch (err) {
    state.cpSubmitting = false;
    cpSubmitBtn.disabled = false;
    cpSubmitBtn.textContent = 'Create Record';
    cpSubmitStatus.className = 'submit-status error';
    cpSubmitStatus.textContent = err.message;
    cpSubmitStatus.style.display = '';
  }
}

// ============================================================================
// Recent Lexicons (persisted sidebar shortcuts)
// ============================================================================

const RECENT_LEXICONS_KEY = 'recentLexicons';

async function loadRecentLexicons() {
  try {
    const result = await api.settings.getKey(RECENT_LEXICONS_KEY);
    if (result.success && Array.isArray(result.data)) {
      state.recentLexicons = result.data;
    }
  } catch {}
  renderRecentLexicons();
}

async function saveRecentLexicons() {
  try {
    await api.settings.setKey(RECENT_LEXICONS_KEY, state.recentLexicons);
  } catch {}
}

function addRecentLexicon(nsid) {
  if (state.recentLexicons.includes(nsid)) return;
  state.recentLexicons.push(nsid);
  state.recentLexicons.sort();
  saveRecentLexicons();
  renderRecentLexicons();
  // Notify background to re-register shortcut commands
  api.publish('me:recent-lexicons-changed', { nsids: state.recentLexicons }, api.scopes.GLOBAL);
}

function removeRecentLexicon(nsid) {
  state.recentLexicons = state.recentLexicons.filter(n => n !== nsid);
  saveRecentLexicons();
  renderRecentLexicons();
  // Notify background to re-register shortcut commands
  api.publish('me:recent-lexicons-changed', { nsids: state.recentLexicons }, api.scopes.GLOBAL);
}

function renderRecentLexicons() {
  if (!recentLexiconsEl) return;
  if (state.recentLexicons.length === 0) {
    recentLexiconsEl.innerHTML = '';
    return;
  }

  recentLexiconsEl.innerHTML = `
    <div class="recent-label">Recent</div>
    ${state.recentLexicons.map(nsid => {
      const friendly = nsidToFriendlyName(nsid);
      return `
        <div class="recent-item" data-nsid="${escapeHtml(nsid)}" title="${escapeHtml(nsid)}">
          <span class="recent-item-name">${escapeHtml(friendly)}</span>
          <button class="recent-item-remove" data-nsid="${escapeHtml(nsid)}" title="Remove">&times;</button>
        </div>
      `;
    }).join('')}
  `;

  // Click to open create panel with that lexicon
  recentLexiconsEl.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('recent-item-remove')) return;
      const nsid = el.dataset.nsid;
      switchPanel('create');
      selectPickerLexicon(nsid);
    });
  });

  // Remove button
  recentLexiconsEl.querySelectorAll('.recent-item-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentLexicon(btn.dataset.nsid);
    });
  });
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
