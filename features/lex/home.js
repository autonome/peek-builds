/**
 * Lexicon Studio Home — AT Protocol identity and data browser UI
 *
 * Orchestrator: loads a template pack and wires up events between templates.
 * Manages state (auth, current panel, selected lexicon) and handles IPC/pubsub.
 * All rendering is delegated to the active template pack.
 */

import {
  nsidToFriendlyName,
} from './lexicon-ui.js';

import { getDefaultPack, listTemplatePackMetadata } from './templates/index.js';
import { escapeHtml, rkeyFromUri } from './templates/raw/utils.js';

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
  getLatestCommit,
} from './atproto.js';

const api = window.app;

// ============================================================================
// Template pack
// ============================================================================

const pack = getDefaultPack();
const appTemplate = new pack.AppTemplate();
const listTemplate = new pack.ListTemplate();
const lexiconTemplate = new pack.LexiconTemplate();
const formTemplate = new pack.FormTemplate();

// ============================================================================
// "new" command system
// ============================================================================

let registeredNewCommands = [];
let knownCollectionNsids = [];
let knownRecentNsids = [];

function nsidDomainLabel(nsid) {
  const parts = nsid.split('.');
  return parts.length >= 2 ? parts[1] : parts[0];
}

function rebuildNewCommands() {
  // Unregister old commands
  for (const name of registeredNewCommands) {
    try { api.commands.unregister(name); } catch {}
  }
  registeredNewCommands = [];

  const allNsids = [...new Set([...knownRecentNsids, ...knownCollectionNsids])];
  if (allNsids.length === 0) return;

  const nameToNsids = new Map();
  for (const nsid of allNsids) {
    const friendly = nsidToFriendlyName(nsid);
    if (!nameToNsids.has(friendly)) nameToNsids.set(friendly, []);
    nameToNsids.get(friendly).push(nsid);
  }

  for (const nsid of allNsids) {
    const friendly = nsidToFriendlyName(nsid);
    const siblings = nameToNsids.get(friendly);
    const displayName = siblings.length > 1 ? `${friendly} (${nsidDomainLabel(nsid)})` : friendly;
    const cmdName = `new ${displayName} — ${nsid}`;

    api.commands.register({
      name: cmdName,
      description: `Create ${nsid} record`,
      execute: () => {
        if (!currentSession) {
          openLexWindow();
          return { success: false, message: 'Not logged in. Opening login...' };
        }
        return {
          success: true,
          output: {
            data: { nsid },
            mimeType: 'application/x-lexicon-form',
            title: displayName,
            interactive: 'peek://lex/chain-form.html',
          },
        };
      },
    });
    registeredNewCommands.push(cmdName);
  }
}

function openLexWindow() {
  api.window.open('peek://lex/home.html', {
    role: 'workspace',
    key: 'lex-home',
    width: 860,
    height: 620,
    title: 'Lexicon Studio',
    webPreferences: { webSecurity: false },
  });
}

function openLexWindowWithLexicon(nsid) {
  openLexWindow();
  // If already loaded, handle directly; otherwise delay for window load
  if (state.authenticated && nsid) {
    switchPanel('create');
    selectPickerLexicon(nsid);
  }
}

function registerCommands() {
  api.commands.register({
    name: 'lexicon studio',
    description: 'Open AT Protocol identity panel',
    execute: () => {
      openLexWindow();
      return { success: true };
    },
  });

  api.commands.register({
    name: 'new',
    description: 'Create a new AT Protocol record',
    execute: async (ctx) => {
      if (!currentSession) {
        openLexWindow();
        return { success: false, message: 'Not logged in. Opening login...' };
      }
      if (ctx.search && ctx.search.includes('.')) {
        const nsid = ctx.search.trim();
        const friendlyName = nsidToFriendlyName(nsid);
        return {
          success: true,
          output: {
            data: { nsid },
            mimeType: 'application/x-lexicon-form',
            title: friendlyName,
            interactive: 'peek://lex/chain-form.html',
          },
        };
      }
      openLexWindowWithLexicon('');
      return { success: true };
    },
  });

  // Load recent nsids and build "new {Name}" commands
  knownRecentNsids = [...(state.recentLexicons || [])];
  rebuildNewCommands();
}

function onCollectionsChanged(nsids) {
  knownCollectionNsids = nsids;
  rebuildNewCommands();
}

function onRecentLexiconsChanged() {
  knownRecentNsids = [...(state.recentLexicons || [])];
  rebuildNewCommands();
  // Also publish for chain-form.js (runs in separate modal window)
  api.publish('lex:recent-lexicons-changed', { nsids: state.recentLexicons }, api.scopes.GLOBAL);
}

// Listen for recent lexicon changes from chain-form.js
api.subscribe('lex:recent-lexicons-changed', (msg) => {
  if (Array.isArray(msg.nsids)) {
    for (const nsid of msg.nsids) {
      if (!state.recentLexicons.includes(nsid)) {
        // Add new ones at front (most recent)
        state.recentLexicons.unshift(nsid);
      }
    }
    if (state.recentLexicons.length > MAX_RECENT_LEXICONS) {
      state.recentLexicons = state.recentLexicons.slice(0, MAX_RECENT_LEXICONS);
    }
    saveRecentLexicons();
    renderRecentLexicons();
    knownRecentNsids = [...state.recentLexicons];
    rebuildNewCommands();
  }
}, api.scopes.GLOBAL);

// ============================================================================
// Session state
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
  lexiconTemplate.setSession(currentSession);
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
// Record Cache (localStorage-based)
// ============================================================================

const CACHE_PREFIX = 'lex:records:';
const REPO_REV_KEY = 'lex:repoRev';
const SYNC_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let syncIntervalId = null;
let lastSyncTime = 0;

/**
 * Get cached records for a collection from localStorage.
 * @param {string} collection
 * @returns {{records: Array, cursor: string|null, lastSync: number}|null}
 */
function getCachedRecords(collection) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + collection);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write records for a collection to localStorage cache.
 * @param {string} collection
 * @param {Array} records
 * @param {string|null} cursor
 */
function setCachedRecords(collection, records, cursor) {
  try {
    localStorage.setItem(CACHE_PREFIX + collection, JSON.stringify({
      records,
      cursor,
      lastSync: Date.now(),
    }));
  } catch (err) {
    console.warn('[lex] Failed to write record cache:', err);
  }
}

/**
 * Remove cached records for a collection.
 * @param {string} collection
 */
function clearCachedRecords(collection) {
  try {
    localStorage.removeItem(CACHE_PREFIX + collection);
  } catch {}
}

/**
 * Get the stored repo rev (commit CID).
 * @returns {string|null}
 */
function getStoredRepoRev() {
  try {
    return localStorage.getItem(REPO_REV_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Store the repo rev (commit CID).
 * @param {string} rev
 */
function setStoredRepoRev(rev) {
  try {
    localStorage.setItem(REPO_REV_KEY, rev);
  } catch {}
}

/**
 * Check if the repo has changed by comparing commit revs.
 * @param {Object} session
 * @returns {Promise<{changed: boolean, rev: string|null}>}
 */
async function checkForChanges(session) {
  try {
    const result = await getLatestCommit(session, onSessionRefresh);
    const currentRev = result.rev;
    const storedRev = getStoredRepoRev();

    if (!storedRev || storedRev !== currentRev) {
      setStoredRepoRev(currentRev);
      return { changed: true, rev: currentRev };
    }
    return { changed: false, rev: currentRev };
  } catch (err) {
    console.warn('[lex] Failed to check repo rev:', err);
    return { changed: false, rev: null };
  }
}

/**
 * Fully re-fetch a collection's records and update the cache.
 * Fetches all pages up to a reasonable limit.
 * @param {Object} session
 * @param {string} collection
 * @returns {Promise<{records: Array, cursor: string|null}>}
 */
async function syncCollection(session, collection) {
  let allRecords = [];
  let cursor = null;

  // Fetch up to 500 records (5 pages of 100)
  for (let i = 0; i < 5; i++) {
    const result = await listRecords(session, collection, { limit: 100, cursor }, onSessionRefresh);
    allRecords = allRecords.concat(result.records);
    cursor = result.cursor;
    if (!cursor) break;
  }

  setCachedRecords(collection, allRecords, cursor);
  return { records: allRecords, cursor };
}

/**
 * Check repo rev and re-sync stale collections.
 * Called on the periodic poll interval.
 */
async function syncPoll() {
  if (!currentSession) return;

  const { changed } = await checkForChanges(currentSession);
  lastSyncTime = Date.now();
  updateSyncIndicator();

  if (!changed) {
    console.log('[lex] Repo unchanged, skipping sync');
    return;
  }

  console.log('[lex] Repo changed, re-syncing current collection');

  // If we're viewing a records list, refresh it
  if (state.activePanel === 'records' && state.recordsNsid) {
    await refreshCurrentRecordsList();
  }
}

/**
 * Start the periodic sync poll.
 */
function startSyncPoll() {
  if (syncIntervalId) return;
  syncIntervalId = setInterval(syncPoll, SYNC_POLL_INTERVAL_MS);
  console.log('[lex] Started sync poll (every 5 min)');
}

/**
 * Stop the periodic sync poll.
 */
function stopSyncPoll() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

/**
 * Update the "last synced" indicator in the records panel.
 */
function updateSyncIndicator() {
  const el = document.getElementById('records-sync-status');
  appTemplate.updateSyncIndicator(el, lastSyncTime);
}

/**
 * Refresh the currently viewed records list from the PDS (background fetch).
 */
async function refreshCurrentRecordsList() {
  if (!currentSession || !state.recordsNsid) return;

  try {
    const { records, cursor } = await syncCollection(currentSession, state.recordsNsid);
    await saveSession();

    state.recordsList = records;
    state.recordsCursor = cursor;
    state.recordsLoading = false;

    renderRecordsList();
    lastSyncTime = Date.now();
    updateSyncIndicator();
  } catch (err) {
    console.warn('[lex] Background records refresh failed:', err);
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

// Templates DOM ref
let templatesListEl;

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

  // Templates ref
  templatesListEl = document.getElementById('templates-list');

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

  // Wire up template events
  wireTemplateEvents();

  // Load recent lexicons from storage
  loadRecentLexicons();

  // Listen for open-create from command palette
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

  // Register commands (after session loaded so auth checks work)
  registerCommands();

  if (currentSession) {
    // Session exists — show account view
    state.authenticated = true;
    state.handle = currentSession.handle;
    state.did = currentSession.did;
    state.pdsUrl = currentSession.pdsUrl;
    state.profile = currentProfile;
    lexiconTemplate.setSession(currentSession);
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

  // Start sync poll if authenticated
  if (currentSession) {
    startSyncPoll();
  }

  // Update "last synced" text every 30s
  setInterval(updateSyncIndicator, 30000);
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
    stopSyncPoll();
    state.authenticated = false;
    state.handle = null;
    state.did = null;
    state.pdsUrl = null;
    state.profile = null;
    state.collections = null;
    // Clear localStorage cache
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(CACHE_PREFIX) || key === REPO_REV_KEY)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch {}
    // Session cleared — no commands to update (they check currentSession at execute time)
    showLoginView();
  });
}

// ============================================================================
// Navigation
// ============================================================================

function setupNav() {
  // Nav item clicks — delegate to app template
  appTemplate.setupNav();

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

  appTemplate.switchPanel(panel);

  // Lazy-load explore data on first visit or when create panel needs it
  if ((panel === 'explore' || panel === 'create') && state.exploreLexicons === null && !state.exploreLoading) {
    loadExploreLexicons();
  }

  // Render templates list when switching to templates panel
  if (panel === 'templates') {
    renderTemplatePacks();
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
  listTemplate.renderExploreLexicons(exploreListEl, {
    loading: state.exploreLoading,
    error: state.exploreError,
    lexicons: state.exploreLexicons,
    filter: state.exploreFilter,
  });
}

// ============================================================================
// Templates panel
// ============================================================================

function renderTemplatePacks() {
  if (!templatesListEl) return;

  const packs = listTemplatePackMetadata();
  const defaultPack = getDefaultPack();
  const defaultName = (defaultPack.metadata && defaultPack.metadata.name) || 'raw';

  if (packs.length === 0) {
    templatesListEl.innerHTML = '<div class="collections-empty">No template packs installed</div>';
    return;
  }

  templatesListEl.innerHTML = packs.map(pack => {
    const isActive = pack.name === defaultName;
    const description = pack.description || 'No description';
    const version = pack.version ? `v${pack.version}` : '';

    return `
      <div class="collection-item template-pack-item" title="${escapeHtml(pack.name)}">
        <div class="collection-info">
          <span class="collection-friendly">${escapeHtml(pack.name)}${isActive ? ' <span class="template-active-badge">active</span>' : ''}</span>
          <span class="collection-nsid">${escapeHtml(description)}</span>
        </div>
        <div class="collection-right">
          ${version ? `<span class="collection-count">${escapeHtml(version)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
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

  appTemplate.clearActorSelection({ handleInput, selectedAccountEl, loginError });
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

    // Update template session
    lexiconTemplate.setSession(currentSession);

    // Session restored — commands check currentSession at execute time

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
  appTemplate.showLoginView({ loginView, accountView, handleInput, selectedAccountEl, loginError, loginLoading });
  state.selectedActor = null;
  state.loading = false;
  state.error = null;
}

function showAccountView() {
  appTemplate.showAccountView({ loginView, accountView });

  renderAccountInfo();

  // Fetch collections directly
  fetchCollections();

  // Start periodic sync
  startSyncPoll();
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

    // Seed recent lexicons from existing collections on first visit
    if (state.recentLexicons.length === 0 && counts.length > 0) {
      state.recentLexicons = counts
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, MAX_RECENT_LEXICONS)
        .map(c => c.nsid);
      saveRecentLexicons();
      renderRecentLexicons();
    }

    // Update "new" commands with repo collections
    onCollectionsChanged(counts.map(c => c.nsid));
  } catch (err) {
    collectionsListEl.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

function renderSearchResults() {
  appTemplate.renderSearchResults(searchResultsEl, {
    visible: state.searchVisible,
    results: state.searchResults,
    activeIndex: state.activeIndex,
  });
}

function renderSelectedAccount() {
  if (!state.selectedActor) return;
  appTemplate.renderSelectedAccount(selectedAccountEl, handleInput, state.selectedActor);
}

function renderLoginState() {
  appTemplate.renderLoginState(
    { loginLoading, loginError },
    { loading: state.loading, error: state.error },
  );
}

function renderAccountInfo() {
  appTemplate.renderAccountInfo(accountInfo, {
    profile: state.profile,
    handle: state.handle,
    did: state.did,
  });
}

function renderCollections() {
  listTemplate.renderCollections(collectionsListEl, {
    collections: state.collections,
    filter: state.myLexiconsFilter,
  });
}

// ============================================================================
// Create Record
// ============================================================================

function setupCreateRecord() {
  formTemplate.setupCreateRecord(
    { createRecordBackBtn, modeFormBtn, modeJsonBtn, createFormContainer, createJsonContainer, createSubmitBtn },
    state,
  );
}

/**
 * Open the create record panel for a given NSID.
 */
async function openCreateRecord(nsid, fromPanel) {
  state.previousPanel = fromPanel;

  // Switch to create-record panel
  switchPanel('create-record');

  // Delegate form loading to the template
  await formTemplate.openCreateRecord(
    {
      createRecordNsidEl, createFormContainer, createJsonContainer,
      createSchemaLoading, createSchemaError, createSubmitArea,
      createSubmitStatus, modeFormBtn, modeJsonBtn,
    },
    state,
    nsid,
  );
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
    const record = await formTemplate.collectCreateRecordData(
      { createFormContainer, createJsonContainer },
      state,
    );

    formTemplate.validateRequired(state, record);

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

    // Invalidate cache for this collection and update repo rev
    if (state.createNsid) clearCachedRecords(state.createNsid);
    checkForChanges(currentSession).catch(() => {});

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
      listTemplate.updatePickerActiveItem(items, state.pickerActiveIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.pickerActiveIndex = Math.max(state.pickerActiveIndex - 1, 0);
      listTemplate.updatePickerActiveItem(items, state.pickerActiveIndex);
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

  // Mode toggle and submit — delegate to form template
  formTemplate.setupCreatePanel(
    { cpModeFormBtn, cpModeJsonBtn, cpFormContainer, cpJsonContainer, cpSubmitBtn },
    state,
  );
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
  const visible = listTemplate.renderPickerResults(pickerResults, {
    items,
    filter: state.pickerFilter,
    loading: state.exploreLoading,
  });
  state.pickerVisible = visible;
  if (items.length === 0) {
    state.pickerActiveIndex = -1;
  } else {
    state.pickerActiveIndex = -1;
  }
}

async function selectPickerLexicon(nsid) {
  // Close picker
  state.pickerVisible = false;
  pickerResults.classList.remove('visible');
  pickerResults.innerHTML = '';

  // Delegate form loading to the template
  await formTemplate.selectPickerLexicon(
    {
      pickerInput, pickerResults, pickerSelected,
      cpFormContainer, cpJsonContainer, cpSchemaLoading, cpSchemaError, cpEmpty,
      cpModeToggle, cpModeFormBtn, cpModeJsonBtn, cpFooter, cpSubmitStatus,
    },
    state,
    nsid,
  );
}

function clearPickerSelection() {
  formTemplate.clearPickerSelection(
    {
      pickerInput, pickerSelected,
      cpFormContainer, cpJsonContainer, cpSchemaLoading, cpSchemaError, cpEmpty,
      cpModeToggle, cpFooter, cpSubmitStatus,
    },
    state,
  );
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
    const record = await formTemplate.collectCreatePanelData(
      { cpFormContainer, cpJsonContainer },
      state,
    );

    formTemplate.validateCreatePanelRequired(state, record);

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

    // Invalidate cache for this collection and update repo rev
    if (state.cpNsid) clearCachedRecords(state.cpNsid);
    checkForChanges(currentSession).catch(() => {});

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

  // Manual refresh button
  const refreshBtn = document.getElementById('records-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      if (!currentSession || !state.recordsNsid) return;
      refreshBtn.disabled = true;
      refreshBtn.classList.add('spinning');
      const syncEl = document.getElementById('records-sync-status');
      if (syncEl) syncEl.textContent = 'refreshing...';
      try {
        await refreshCurrentRecordsList();
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('spinning');
      }
    });
  }
}

/**
 * Open the records list for a collection.
 * Shows cached records instantly, then fetches fresh data in background.
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
  recordsPaginationEl.style.display = 'none';

  switchPanel('records');

  // Check cache first for instant display
  const cached = getCachedRecords(nsid);
  if (cached && cached.records && cached.records.length > 0) {
    state.recordsList = cached.records;
    state.recordsCursor = cached.cursor;
    state.recordsLoading = false;
    lastSyncTime = cached.lastSync || 0;
    renderRecordsList();
    updateSyncIndicator();

    // Show subtle refreshing indicator
    const syncEl = document.getElementById('records-sync-status');
    if (syncEl) syncEl.textContent = 'refreshing...';

    // Fetch fresh data in background
    refreshCurrentRecordsList().catch(err => {
      console.warn('[lex] Background refresh failed:', err);
      // Keep showing cached data
      if (syncEl) updateSyncIndicator();
    });
  } else {
    // No cache — show loading and fetch
    recordsListEl.innerHTML = '<div class="loading">Loading records...</div>';
    await loadRecordsPage();
    // Cache the result
    if (state.recordsList.length > 0) {
      setCachedRecords(nsid, state.recordsList, state.recordsCursor);
      lastSyncTime = Date.now();
      updateSyncIndicator();
    }
  }
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

    // Update cache with current full list
    setCachedRecords(state.recordsNsid, state.recordsList, state.recordsCursor);
    lastSyncTime = Date.now();
    updateSyncIndicator();
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
  listTemplate.renderRecordsList(recordsListEl, {
    records: state.recordsList,
    cursor: state.recordsCursor,
    paginationEl: recordsPaginationEl,
  });
}

function goBackFromRecords() {
  state.recordsNsid = null;
  state.recordsList = [];
  state.recordsCursor = null;
  switchPanel('my-lexicons');
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
  recordDetailContentEl.innerHTML = lexiconTemplate.renderContent({
    uri: state.recordDetailUri,
    cid: state.recordDetailCid,
    value: state.recordDetailValue,
  });
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

    // Remove from local list and update cache
    state.recordsList = state.recordsList.filter(r => r.uri !== state.recordDetailUri);
    if (state.recordsNsid) {
      setCachedRecords(state.recordsNsid, state.recordsList, state.recordsCursor);
    }

    // Update repo rev
    checkForChanges(currentSession).catch(() => {});

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

// ============================================================================
// Recent Lexicons (persisted sidebar shortcuts)
// ============================================================================

const RECENT_LEXICONS_KEY = 'recentLexicons';
const MAX_RECENT_LEXICONS = 20;

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

/**
 * Add or promote a lexicon to the front of the recent list (most recent first).
 * Called when a record is successfully published/created in a lexicon.
 */
function addRecentLexicon(nsid) {
  // Remove if already present (we will re-add at front)
  state.recentLexicons = state.recentLexicons.filter(n => n !== nsid);
  // Add to front (most recent first)
  state.recentLexicons.unshift(nsid);
  // Cap the list
  if (state.recentLexicons.length > MAX_RECENT_LEXICONS) {
    state.recentLexicons = state.recentLexicons.slice(0, MAX_RECENT_LEXICONS);
  }
  saveRecentLexicons();
  renderRecentLexicons();
  onRecentLexiconsChanged();
}

function removeRecentLexicon(nsid) {
  state.recentLexicons = state.recentLexicons.filter(n => n !== nsid);
  saveRecentLexicons();
  renderRecentLexicons();
  onRecentLexiconsChanged();
}

function renderRecentLexicons() {
  if (!recentLexiconsEl) return;
  listTemplate.renderRecentLexicons(recentLexiconsEl, {
    recentLexicons: state.recentLexicons,
  });
}

// ============================================================================
// Template event wiring
// ============================================================================

function wireTemplateEvents() {
  // App template events
  appTemplate.on('actor-selected', ({ actor }) => selectActor(actor));
  appTemplate.on('actor-cleared', () => clearActorSelection());
  appTemplate.on('panel-switch', ({ panel }) => switchPanel(panel));

  // List template events
  listTemplate.on('collection-click', ({ nsid }) => openRecordsList(nsid));
  listTemplate.on('explore-click', ({ nsid }) => openCreateRecord(nsid, 'explore'));
  listTemplate.on('record-click', ({ uri, rkey }) => openRecordDetail(uri, rkey));
  listTemplate.on('recent-click', ({ nsid }) => {
    switchPanel('create');
    selectPickerLexicon(nsid);
  });
  listTemplate.on('recent-remove', ({ nsid }) => removeRecentLexicon(nsid));
  listTemplate.on('picker-select', ({ nsid }) => selectPickerLexicon(nsid));

  // Form template events
  formTemplate.on('back', () => goBackFromCreate());
  formTemplate.on('submit-create-record', () => handleCreateSubmit());
  formTemplate.on('submit-create-panel', () => handleCreatePanelSubmit());
  formTemplate.on('picker-clear', () => clearPickerSelection());

  // Lexicon template — session is set separately when auth state changes
}

// ============================================================================
// Bootstrap
// ============================================================================

document.addEventListener('DOMContentLoaded', init);
