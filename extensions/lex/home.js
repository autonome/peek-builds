/**
 * Lexicon Studio Home — AT Protocol identity and data browser UI
 *
 * All session management, XRPC calls, and OAuth logic are handled directly
 * in this file (via atproto.js imports). No background page needed.
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

import {
  searchActors,
  loginWithOAuth,
  getCollections,
  getAllCollectionCounts,
  getProfile,
  xrpcPost,
  uploadBlob,
  listRecords,
  getRecord,
  deleteRecord,
} from './atproto.js';

const api = window.app;

// ============================================================================
// Session state (previously in background.js)
// ============================================================================

let currentSession = null;
let currentProfile = null;

const STORAGE_KEY = 'session';
const PROFILE_KEY = 'profile';

async function saveSession() {
  if (!api) return;
  try {
    await api.settings.setKey(STORAGE_KEY, currentSession);
    if (currentProfile) {
      await api.settings.setKey(PROFILE_KEY, currentProfile);
    }
  } catch (err) {
    console.warn('[lex] Failed to save session:', err);
  }
}

async function loadSession() {
  if (!api) return;
  try {
    const result = await api.settings.getKey(STORAGE_KEY);
    if (result.success && result.data) {
      currentSession = result.data;
      console.log('[lex] Restored session for', currentSession.handle);
    }
    const profileResult = await api.settings.getKey(PROFILE_KEY);
    if (profileResult.success && profileResult.data) {
      currentProfile = profileResult.data;
    }
  } catch (err) {
    console.warn('[lex] Failed to load session:', err);
  }
}

async function clearSession() {
  currentSession = null;
  currentProfile = null;
  if (api) {
    try {
      await api.settings.setKey(STORAGE_KEY, null);
      await api.settings.setKey(PROFILE_KEY, null);
    } catch (err) {
      console.warn('[lex] Failed to clear session:', err);
    }
  }
}

function onSessionRefresh(refreshedSession) {
  currentSession = refreshedSession;
  saveSession();
}

// ============================================================================
// Lexicon directory (lexidex) cache
// ============================================================================

let lexiconCache = null;
let lexiconCacheLoading = false;

const LEXICON_DIR_KEY = 'lexiconDirectory';
const LEXICON_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function fetchLexiconDirectoryFromNetwork() {
  const homeRes = await fetch('https://lexidex.bsky.dev/');
  if (!homeRes.ok) throw new Error(`Failed to fetch lexidex: ${homeRes.status}`);

  const homeHtml = await homeRes.text();
  const domainRegex = /href="\/domain\/([^"]+)"/g;
  const domains = [];
  let match;
  while ((match = domainRegex.exec(homeHtml)) !== null) {
    domains.push(match[1]);
  }

  if (domains.length === 0) throw new Error('No domains found on lexidex');

  const allLexicons = [];
  const domainFetches = domains.map(async (domain) => {
    try {
      const res = await fetch(`https://lexidex.bsky.dev/domain/${domain}`);
      if (!res.ok) return;
      const html = await res.text();
      const lexRegex = /href="\/lexicon\/([^"]+)"/g;
      let m;
      while ((m = lexRegex.exec(html)) !== null) {
        allLexicons.push({ nsid: m[1], domain });
      }
    } catch (err) {
      console.warn(`[lex] Failed to fetch lexidex domain ${domain}:`, err);
    }
  });

  await Promise.all(domainFetches);

  const EXTRA_LEXICONS = [
    { nsid: 'site.standard.publication', domain: 'standard.site' },
    { nsid: 'site.standard.document', domain: 'standard.site' },
    { nsid: 'site.standard.graph.subscription', domain: 'standard.site' },
  ];
  for (const extra of EXTRA_LEXICONS) {
    if (!allLexicons.some(l => l.nsid === extra.nsid)) {
      allLexicons.push(extra);
    }
  }

  allLexicons.sort((a, b) => a.nsid.localeCompare(b.nsid));

  if (api) {
    try {
      await api.settings.setKey(LEXICON_DIR_KEY, {
        lexicons: allLexicons,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      console.warn('[lex] Failed to persist lexicon directory:', err);
    }
  }

  lexiconCache = allLexicons;
  console.log(`[lex] Loaded ${allLexicons.length} lexicons from ${domains.length} domains`);
  return allLexicons;
}

async function fetchLexiconDirectory() {
  if (lexiconCache) return lexiconCache;
  if (lexiconCacheLoading) return null;

  if (api) {
    try {
      const result = await api.settings.getKey(LEXICON_DIR_KEY);
      if (result.success && result.data && result.data.lexicons) {
        lexiconCache = result.data.lexicons;
        console.log(`[lex] Restored ${lexiconCache.length} lexicons from persisted cache`);

        const age = Date.now() - (result.data.fetchedAt || 0);
        if (age > LEXICON_DIR_MAX_AGE_MS) {
          console.log('[lex] Lexicon directory cache is stale, refreshing in background...');
          fetchLexiconDirectoryFromNetwork().catch(err => {
            console.warn('[lex] Background lexicon directory refresh failed:', err);
          });
        }

        return lexiconCache;
      }
    } catch (err) {
      console.warn('[lex] Failed to load persisted lexicon directory:', err);
    }
  }

  lexiconCacheLoading = true;
  try {
    return await fetchLexiconDirectoryFromNetwork();
  } catch (err) {
    console.error('[lex] Lexicon directory fetch failed:', err);
    throw err;
  } finally {
    lexiconCacheLoading = false;
  }
}

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
  // Records list
  recordsNsid: null,
  recordsList: [],
  recordsCursor: null,
  recordsLoading: false,
  // Record detail
  recordDetailUri: null,
  recordDetailValue: null,
  recordDetailCid: null,
  recordDetailDeleting: false,
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

// Records list DOM refs
let recordsBackBtn, recordsTitleEl, recordsNsidEl, recordsCreateBtn;
let recordsListEl, recordsPaginationEl, recordsLoadMoreBtn;

// Record detail DOM refs
let recordDetailBackBtn, recordDetailTitleEl, recordDetailUriEl;
let recordDetailContentEl, recordDeleteBtn;

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

  // Records list refs
  recordsBackBtn = document.getElementById('records-back');
  recordsTitleEl = document.getElementById('records-title');
  recordsNsidEl = document.getElementById('records-nsid');
  recordsCreateBtn = document.getElementById('records-create-btn');
  recordsListEl = document.getElementById('records-list');
  recordsPaginationEl = document.getElementById('records-pagination');
  recordsLoadMoreBtn = document.getElementById('records-load-more');

  // Record detail refs
  recordDetailBackBtn = document.getElementById('record-detail-back');
  recordDetailTitleEl = document.getElementById('record-detail-title');
  recordDetailUriEl = document.getElementById('record-detail-uri');
  recordDetailContentEl = document.getElementById('record-detail-content');
  recordDeleteBtn = document.getElementById('record-delete-btn');

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

  // Set up create record UI (detail panel)
  setupCreateRecord();

  // Set up create panel (dedicated nav)
  setupCreatePanel();

  // Set up records panels
  setupRecordsPanel();
  setupRecordDetailPanel();

  // Load recent lexicons from storage
  loadRecentLexicons();

  // Listen for open-create from command palette (via background commands)
  api.subscribe('lex:open-create', (msg) => {
    if (!state.authenticated) return;
    if (msg.nsid) {
      switchPanel('create');
      selectPickerLexicon(msg.nsid);
    } else {
      switchPanel('create');
    }
  }, api.scopes.GLOBAL);

  // Load session from storage directly
  await loadSession();

  if (currentSession) {
    // Session exists — show account view
    state.authenticated = true;
    state.handle = currentSession.handle;
    state.did = currentSession.did;
    state.pdsUrl = currentSession.pdsUrl;
    state.profile = currentProfile;
    showAccountView();

    // Refresh profile in background
    try {
      const profile = await getProfile(currentSession.did);
      if (profile) {
        currentProfile = profile;
        state.profile = profile;
        await saveSession();
        renderAccountInfo();
      }
    } catch {
      // Best-effort
    }
  } else {
    showLoginView();
  }

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

  // If in record-detail panel, go back to records list
  if (state.activePanel === 'record-detail') {
    goBackFromRecordDetail();
    return { handled: true };
  }

  // If in records panel, go back to my-lexicons
  if (state.activePanel === 'records') {
    goBackFromRecords();
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
  // Handle input for typeahead search — call searchActors directly
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

    searchTimer = setTimeout(async () => {
      try {
        const results = await searchActors(query);
        state.searchResults = results || [];
        state.searchVisible = state.searchResults.length > 0;
        state.activeIndex = -1;
        renderSearchResults();
      } catch (err) {
        console.warn('[lex] Search failed:', err);
      }
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

  // Logout button — call clearSession directly
  logoutBtn.addEventListener('click', async () => {
    await clearSession();
    state.authenticated = false;
    state.handle = null;
    state.did = null;
    state.pdsUrl = null;
    state.profile = null;
    state.collections = null;
    // Notify background (for command state) and other windows
    api.publish('lex:session-changed', { authenticated: false }, api.scopes.GLOBAL);
    showLoginView();
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

  // Update nav items (don't highlight for create-record -- it's a sub-panel)
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

async function loadExploreLexicons() {
  state.exploreLoading = true;
  state.exploreError = null;
  exploreListEl.innerHTML = '<div class="loading">Loading lexicon directory...</div>';

  try {
    const lexicons = await fetchLexiconDirectory();
    state.exploreLoading = false;
    state.exploreLexicons = lexicons || [];
    renderExploreLexicons();
  } catch (err) {
    state.exploreLoading = false;
    state.exploreError = err.message;
    renderExploreLexicons();
  }
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
// Actions (direct calls instead of pubsub)
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

async function doLogin() {
  if (!state.selectedActor) return;

  state.loading = true;
  state.error = null;
  renderLoginState();

  try {
    currentSession = await loginWithOAuth(state.selectedActor.handle);

    // Fetch profile
    currentProfile = await getProfile(currentSession.did);

    await saveSession();

    state.loading = false;
    state.authenticated = true;
    state.handle = currentSession.handle;
    state.did = currentSession.did;
    state.pdsUrl = currentSession.pdsUrl;
    state.profile = currentProfile;

    // Notify background (for command state) and other windows
    api.publish('lex:session-changed', {
      authenticated: true,
      handle: currentSession.handle,
      did: currentSession.did,
      pdsUrl: currentSession.pdsUrl,
      profile: currentProfile,
    }, api.scopes.GLOBAL);

    showAccountView();
    console.log('[lex] Logged in as', currentSession.handle);
  } catch (err) {
    state.loading = false;
    state.error = err.message;
    renderLoginState();
    console.error('[lex] Login failed:', err);
  }
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

  // Fetch collections directly
  fetchCollections();
}

async function fetchCollections() {
  if (!currentSession) return;

  state.collections = null;
  collectionsListEl.innerHTML = '<div class="loading">Loading collections...</div>';

  try {
    const collections = await getCollections(currentSession, onSessionRefresh);
    const counts = await getAllCollectionCounts(currentSession, collections, onSessionRefresh);
    await saveSession();
    state.collections = counts;
    renderCollections();

    // Notify background to update "new" commands with repo collections
    api.publish('lex:collections-loaded', {
      collections: counts.map(c => c.nsid),
    }, api.scopes.GLOBAL);
  } catch (err) {
    collectionsListEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
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
          <span class="collection-action">View</span>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers to browse records
  collectionsListEl.querySelectorAll('.collection-item.clickable').forEach(el => {
    el.addEventListener('click', () => {
      const nsid = el.dataset.nsid;
      if (nsid) openRecordsList(nsid);
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

  // Reset UI
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
  // If coming back to records, refresh the list
  if (target === 'records' && state.recordsNsid) {
    switchPanel('records');
    // Reload records to show newly created ones
    state.recordsList = [];
    state.recordsCursor = null;
    loadRecordsPage();
  } else {
    switchPanel(target);
  }
}

/**
 * Handle the create record submit action — calls xrpcPost directly.
 */
async function handleCreateSubmit() {
  if (state.createSubmitting || !state.createNsid || !currentSession) return;

  state.createSubmitting = true;
  createSubmitBtn.disabled = true;
  createSubmitBtn.textContent = 'Creating...';
  createSubmitStatus.style.display = 'none';

  try {
    let record;

    if (state.createMode === 'json') {
      record = parseRawJson(createJsonContainer, state.createNsid);
    } else {
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

    // Create record directly via atproto
    const result = await xrpcPost(currentSession, 'com.atproto.repo.createRecord', {
      repo: currentSession.did,
      collection: state.createNsid,
      record,
    }, onSessionRefresh);

    await saveSession();

    // Show success
    state.createSubmitting = false;
    createSubmitBtn.disabled = false;
    createSubmitBtn.textContent = 'Create Record';

    const validationNote = result.validationStatus === 'unknown' ? ' (unvalidated)' : '';
    createSubmitStatus.className = 'submit-status success';
    createSubmitStatus.innerHTML = `
      Record created successfully${validationNote}
      <div class="record-uri">${escapeHtml(result.uri)}</div>
    `;
    createSubmitStatus.style.display = '';

    console.log('[lex] Record created:', result.uri);

    // Refresh collections and add to recent
    fetchCollections();
    if (state.createNsid) addRecentLexicon(state.createNsid);

  } catch (err) {
    state.createSubmitting = false;
    createSubmitBtn.disabled = false;
    createSubmitBtn.textContent = 'Create Record';
    createSubmitStatus.className = 'submit-status error';
    createSubmitStatus.textContent = err.message;
    createSubmitStatus.style.display = '';
    console.error('[lex] Record creation failed:', err);
  }
}

// ============================================================================
// Create Panel (dedicated nav)
// ============================================================================

function setupCreatePanel() {
  // Picker input
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

/**
 * Handle the create panel submit — calls xrpcPost directly.
 */
async function handleCreatePanelSubmit() {
  if (state.cpSubmitting || !state.cpNsid || !currentSession) return;

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

    // Create record directly via atproto
    const result = await xrpcPost(currentSession, 'com.atproto.repo.createRecord', {
      repo: currentSession.did,
      collection: state.cpNsid,
      record,
    }, onSessionRefresh);

    await saveSession();

    // Show success
    state.cpSubmitting = false;
    cpSubmitBtn.disabled = false;
    cpSubmitBtn.textContent = 'Create Record';

    const validationNote = result.validationStatus === 'unknown' ? ' (unvalidated)' : '';
    cpSubmitStatus.className = 'submit-status success';
    cpSubmitStatus.innerHTML = `
      Record created successfully${validationNote}
      <div class="record-uri">${escapeHtml(result.uri)}</div>
    `;
    cpSubmitStatus.style.display = '';

    console.log('[lex] Record created:', result.uri);

    // Refresh collections and add to recent
    fetchCollections();
    if (state.cpNsid) addRecentLexicon(state.cpNsid);

  } catch (err) {
    state.cpSubmitting = false;
    cpSubmitBtn.disabled = false;
    cpSubmitBtn.textContent = 'Create Record';
    cpSubmitStatus.className = 'submit-status error';
    cpSubmitStatus.textContent = err.message;
    cpSubmitStatus.style.display = '';
    console.error('[lex] Record creation failed:', err);
  }
}

// ============================================================================
// Records List Panel
// ============================================================================

function setupRecordsPanel() {
  recordsBackBtn.addEventListener('click', goBackFromRecords);
  recordsCreateBtn.addEventListener('click', () => {
    if (state.recordsNsid) {
      openCreateRecord(state.recordsNsid, 'records');
    }
  });
  recordsLoadMoreBtn.addEventListener('click', loadMoreRecords);
}

/**
 * Open the records list for a collection.
 */
async function openRecordsList(nsid) {
  state.previousPanel = 'my-lexicons';
  state.recordsNsid = nsid;
  state.recordsList = [];
  state.recordsCursor = null;
  state.recordsLoading = true;

  // Update header
  const friendly = nsidToFriendlyName(nsid);
  recordsTitleEl.textContent = friendly;
  recordsNsidEl.textContent = nsid;
  recordsListEl.innerHTML = '<div class="loading">Loading records...</div>';
  recordsPaginationEl.style.display = 'none';

  switchPanel('records');

  await loadRecordsPage();
}

async function loadRecordsPage() {
  if (!currentSession || !state.recordsNsid) return;

  state.recordsLoading = true;

  try {
    const result = await listRecords(
      currentSession,
      state.recordsNsid,
      { limit: 50, cursor: state.recordsCursor },
      onSessionRefresh
    );
    await saveSession();

    state.recordsList = state.recordsList.concat(result.records);
    state.recordsCursor = result.cursor;
    state.recordsLoading = false;

    renderRecordsList();
  } catch (err) {
    state.recordsLoading = false;
    recordsListEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

async function loadMoreRecords() {
  if (state.recordsLoading || !state.recordsCursor) return;
  recordsLoadMoreBtn.disabled = true;
  recordsLoadMoreBtn.textContent = 'Loading...';
  await loadRecordsPage();
  recordsLoadMoreBtn.disabled = false;
  recordsLoadMoreBtn.textContent = 'Load more';
}

function renderRecordsList() {
  if (!state.recordsList || state.recordsList.length === 0) {
    recordsListEl.innerHTML = '<div class="records-empty">No records in this collection</div>';
    recordsPaginationEl.style.display = 'none';
    return;
  }

  recordsListEl.innerHTML = state.recordsList.map(rec => {
    const uri = rec.uri || '';
    const rkey = rkeyFromUri(uri);
    const preview = getRecordPreview(rec.value);
    const dateStr = getRecordDate(rec.value);

    return `
      <div class="record-item" data-uri="${escapeHtml(uri)}" data-rkey="${escapeHtml(rkey)}">
        <div class="record-item-main">
          <span class="record-item-rkey">${escapeHtml(rkey)}</span>
          ${preview ? `<span class="record-item-preview">${escapeHtml(preview)}</span>` : ''}
        </div>
        <div class="record-item-meta">
          ${dateStr ? `<span class="record-item-date">${escapeHtml(dateStr)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Show/hide pagination
  if (state.recordsCursor) {
    recordsPaginationEl.style.display = '';
  } else {
    recordsPaginationEl.style.display = 'none';
  }

  // Click handlers
  recordsListEl.querySelectorAll('.record-item').forEach(el => {
    el.addEventListener('click', () => {
      const uri = el.dataset.uri;
      const rkey = el.dataset.rkey;
      if (uri && rkey) openRecordDetail(uri, rkey);
    });
  });
}

function goBackFromRecords() {
  state.recordsNsid = null;
  state.recordsList = [];
  state.recordsCursor = null;
  switchPanel('my-lexicons');
}

/**
 * Extract the rkey (last segment) from an AT URI.
 * at://did:plc:xxx/app.bsky.feed.post/3abc123 -> 3abc123
 */
function rkeyFromUri(uri) {
  if (!uri) return '';
  const parts = uri.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Generate a preview string for a record value.
 * Looks for common fields: text, title, name, description, displayName, subject.
 */
function getRecordPreview(value) {
  if (!value || typeof value !== 'object') return '';

  // Try common text fields
  for (const key of ['text', 'title', 'name', 'displayName', 'description', 'summary']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      const text = value[key].trim();
      return text.length > 120 ? text.substring(0, 120) + '...' : text;
    }
  }

  // For records with a subject (likes, reposts, etc.)
  if (value.subject) {
    if (typeof value.subject === 'string') return value.subject;
    if (value.subject.uri) return value.subject.uri;
  }

  // For follows
  if (value.subject && typeof value.subject === 'string') {
    return value.subject;
  }

  // $type as fallback context
  if (value.$type) return value.$type;

  return '';
}

/**
 * Format a date from record value (createdAt or indexedAt).
 */
function getRecordDate(value) {
  if (!value || typeof value !== 'object') return '';

  const dateStr = value.createdAt || value.indexedAt;
  if (!dateStr) return '';

  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

// ============================================================================
// Record Detail Panel
// ============================================================================

function setupRecordDetailPanel() {
  recordDetailBackBtn.addEventListener('click', goBackFromRecordDetail);
  recordDeleteBtn.addEventListener('click', handleDeleteRecord);
}

/**
 * Open the detail view for a single record.
 */
async function openRecordDetail(uri, rkey) {
  state.previousPanel = 'records';
  state.recordDetailUri = uri;
  state.recordDetailValue = null;
  state.recordDetailCid = null;
  state.recordDetailDeleting = false;

  recordDetailTitleEl.textContent = rkey;
  recordDetailUriEl.textContent = uri;
  recordDetailContentEl.innerHTML = '<div class="loading">Loading record...</div>';
  recordDeleteBtn.style.display = '';
  recordDeleteBtn.disabled = false;
  recordDeleteBtn.textContent = 'Delete';

  switchPanel('record-detail');

  try {
    const record = await getRecord(
      currentSession,
      state.recordsNsid,
      rkey,
      onSessionRefresh
    );
    await saveSession();

    state.recordDetailValue = record.value;
    state.recordDetailCid = record.cid;

    renderRecordDetail();
  } catch (err) {
    recordDetailContentEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function renderRecordDetail() {
  if (!state.recordDetailValue) {
    recordDetailContentEl.innerHTML = '<div class="records-empty">No record data</div>';
    return;
  }

  const value = state.recordDetailValue;
  let html = '';

  // Metadata section
  html += `
    <div class="record-detail-section">
      <div class="record-detail-section-title">Metadata</div>
      <div class="record-detail-meta">
        <div class="record-meta-row">
          <span class="record-meta-label">URI</span>
          <span class="record-meta-value">${escapeHtml(state.recordDetailUri)}</span>
        </div>
        ${state.recordDetailCid ? `
        <div class="record-meta-row">
          <span class="record-meta-label">CID</span>
          <span class="record-meta-value">${escapeHtml(state.recordDetailCid)}</span>
        </div>
        ` : ''}
        ${value.$type ? `
        <div class="record-meta-row">
          <span class="record-meta-label">Type</span>
          <span class="record-meta-value">${escapeHtml(value.$type)}</span>
        </div>
        ` : ''}
        ${value.createdAt ? `
        <div class="record-meta-row">
          <span class="record-meta-label">Created</span>
          <span class="record-meta-value">${escapeHtml(formatDateTime(value.createdAt))}</span>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  // Fields section - render each field
  html += `
    <div class="record-detail-section">
      <div class="record-detail-section-title">Fields</div>
      ${renderRecordFields(value)}
    </div>
  `;

  // Raw JSON section
  html += `
    <div class="record-detail-section">
      <div class="record-detail-section-title">Raw JSON</div>
      <div class="record-json-view">${escapeHtml(JSON.stringify(value, null, 2))}</div>
    </div>
  `;

  recordDetailContentEl.innerHTML = html;
}

/**
 * Render record fields as a structured view.
 * Skips $type and createdAt (shown in metadata).
 */
function renderRecordFields(value) {
  if (!value || typeof value !== 'object') return '';

  const skipKeys = new Set(['$type', 'createdAt']);
  const entries = Object.entries(value).filter(([k]) => !skipKeys.has(k));

  if (entries.length === 0) {
    return '<div class="records-empty">No fields</div>';
  }

  return entries.map(([key, val]) => {
    return `
      <div class="record-field">
        <span class="record-field-name">${escapeHtml(key)}</span>
        <div class="record-field-value">${renderFieldValue(val, key)}</div>
      </div>
    `;
  }).join('');
}

/**
 * Render a single field value with appropriate formatting.
 */
function renderFieldValue(val, key) {
  if (val === null || val === undefined) {
    return '<span style="color: var(--base04); font-style: italic;">null</span>';
  }

  if (typeof val === 'string') {
    // Check if it's a URL
    if (val.match(/^https?:\/\//)) {
      return `<a href="${escapeHtml(val)}" target="_blank" rel="noopener">${escapeHtml(val)}</a>`;
    }
    // Check if it's an AT URI
    if (val.startsWith('at://')) {
      return `<span style="font-family: var(--theme-font-mono, monospace); font-size: 12px;">${escapeHtml(val)}</span>`;
    }
    // Check if it's a DID
    if (val.startsWith('did:')) {
      return `<span style="font-family: var(--theme-font-mono, monospace); font-size: 12px;">${escapeHtml(val)}</span>`;
    }
    // Check if it's a datetime
    if (val.match(/^\d{4}-\d{2}-\d{2}T/)) {
      return escapeHtml(formatDateTime(val));
    }
    // Regular string
    return escapeHtml(val);
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return `<span style="color: var(--base0E);">${escapeHtml(String(val))}</span>`;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) {
      return '<span style="color: var(--base04); font-style: italic;">[]</span>';
    }
    // Render array items
    return `<div class="record-field-object">${val.map((item, i) => {
      if (typeof item === 'object' && item !== null) {
        return `<div style="margin-bottom: 8px; padding-bottom: 8px; ${i < val.length - 1 ? 'border-bottom: 1px solid var(--base02);' : ''}">${renderRecordFields(item)}</div>`;
      }
      return `<div>${renderFieldValue(item, String(i))}</div>`;
    }).join('')}</div>`;
  }

  if (typeof val === 'object') {
    // Check for blob ref
    if (val.$type === 'blob' || val.ref?.$link || val.cid) {
      const link = val.ref?.$link || val.cid;
      const mimeType = val.mimeType || '';
      if (link && mimeType.startsWith('image/') && currentSession) {
        const blobUrl = `${currentSession.pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(currentSession.did)}&cid=${encodeURIComponent(link)}`;
        return `<img src="${escapeHtml(blobUrl)}" alt="blob" loading="lazy" />`;
      }
      return `<span style="font-family: var(--theme-font-mono, monospace); font-size: 12px;">${escapeHtml(mimeType)} blob: ${escapeHtml(link || 'unknown')}</span>`;
    }

    // Render nested object
    return `<div class="record-field-object">${renderRecordFields(val)}</div>`;
  }

  return escapeHtml(String(val));
}

function goBackFromRecordDetail() {
  switchPanel('records');
}

/**
 * Handle delete record button.
 */
async function handleDeleteRecord() {
  if (state.recordDetailDeleting || !state.recordDetailUri || !state.recordsNsid || !currentSession) return;

  // If the button says "Delete", switch to confirmation mode
  if (recordDeleteBtn.textContent === 'Delete') {
    recordDeleteBtn.textContent = 'Confirm Delete';
    recordDeleteBtn.classList.add('confirming');
    // Auto-reset after 3 seconds
    setTimeout(() => {
      if (recordDeleteBtn.textContent === 'Confirm Delete') {
        recordDeleteBtn.textContent = 'Delete';
        recordDeleteBtn.classList.remove('confirming');
      }
    }, 3000);
    return;
  }

  state.recordDetailDeleting = true;
  recordDeleteBtn.disabled = true;
  recordDeleteBtn.textContent = 'Deleting...';

  try {
    const rkey = rkeyFromUri(state.recordDetailUri);
    await deleteRecord(currentSession, state.recordsNsid, rkey, onSessionRefresh);
    await saveSession();

    // Remove from local list
    state.recordsList = state.recordsList.filter(r => r.uri !== state.recordDetailUri);

    // Go back to records list and refresh
    goBackFromRecordDetail();
    renderRecordsList();

    // Refresh collection counts
    fetchCollections();
  } catch (err) {
    state.recordDetailDeleting = false;
    recordDeleteBtn.disabled = false;
    recordDeleteBtn.textContent = 'Delete';
    recordDeleteBtn.classList.remove('confirming');
    // Show error in the detail content
    const errorEl = document.createElement('div');
    errorEl.className = 'error';
    errorEl.textContent = `Delete failed: ${err.message}`;
    recordDetailContentEl.prepend(errorEl);
  }
}

/**
 * Format a datetime string.
 */
function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoStr;
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
  api.publish('lex:recent-lexicons-changed', { nsids: state.recentLexicons }, api.scopes.GLOBAL);
}

function removeRecentLexicon(nsid) {
  state.recentLexicons = state.recentLexicons.filter(n => n !== nsid);
  saveRecentLexicons();
  renderRecentLexicons();
  // Notify background to re-register shortcut commands
  api.publish('lex:recent-lexicons-changed', { nsids: state.recentLexicons }, api.scopes.GLOBAL);
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
