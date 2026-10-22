/**
 * Web Search Tile
 *
 * Single-tile (resident: true) combining engine state management and UI:
 * - Built-in engines: Google, DuckDuckGo, Bing, Wikipedia, Kagi
 * - OpenSearch discovery from visited pages
 * - Search suggestions with debounce and caching
 * - Per-engine commands (/google, /ddg, /bing, /wiki, /kagi)
 * - A general "web search" command with engine selection
 * - Search UI (engine selector, suggestions, keyboard navigation)
 *
 * Commands are declared in manifest.json.
 * Tile loads as resident (hidden at startup); shows itself when invoked.
 */

import { id, labels, schemas, storageKeys, defaults, builtinEngines } from './config.js';
import { recordSearchRound, tagResultPageInSpace } from './search-rounds.js';

const api = window.app;

// ===== State =====

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs
};

// All engines: built-in + custom/discovered
let engines = [...builtinEngines];

// Suggestion cache: Map<cacheKey, { suggestions, timestamp }>
const suggestionCache = new Map();
const SUGGESTION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SUGGESTION_CACHE_MAX = 500;

// Track in-flight suggestion requests for cancellation
let currentSuggestionAbortController = null;

// ===== Settings =====

/**
 * Load settings from datastore
 */
const loadSettings = async () => {
  const result = await api.settings.get('prefs');
  if (result.success && result.data) {
    return {
      prefs: { ...defaults.prefs, ...(result.data || {}) }
    };
  }
  return { prefs: { ...defaults.prefs } };
};

/**
 * Save settings to datastore
 */
const saveSettings = async (settings) => {
  const result = await api.settings.set('prefs', settings.prefs);
  if (!result.success) {
    console.error('[ext:websearch] Failed to save settings:', result.error);
  }
};

// ===== Engine Registry =====

/**
 * Load custom/discovered engines from settings
 */
const loadEngines = async () => {
  const result = await api.settings.get('engines');
  const customEngines = (result.success && result.data) || [];

  // Merge built-in with custom, custom engines can override built-in ones by ID
  const customIds = new Set(customEngines.map(e => e.id));
  engines = [
    ...builtinEngines.filter(e => !customIds.has(e.id)),
    ...customEngines
  ];

};

/**
 * Save custom engines to settings (only non-builtin ones)
 */
const saveEngines = async () => {
  const customEngines = engines.filter(e => !e.isBuiltIn);
  await api.settings.set('engines', customEngines);
};

/**
 * Get an engine by ID
 */
const getEngine = (engineId) => {
  return engines.find(e => e.id === engineId) || null;
};

/**
 * Get an engine by short name (keyword)
 */
const getEngineByShortName = (shortName) => {
  return engines.find(e => e.shortName === shortName && e.enabled !== false) || null;
};

/**
 * Get the default engine
 */
const getDefaultEngine = () => {
  const defaultId = currentSettings.prefs.defaultEngine;
  return getEngine(defaultId) || engines.find(e => e.enabled !== false) || engines[0];
};

/**
 * Get all enabled engines
 */
const getEnabledEngines = () => {
  return engines.filter(e => e.enabled !== false);
};

/**
 * Add a discovered/custom engine
 */
const addEngine = async (engine) => {
  // Check for duplicate ID
  const existingIndex = engines.findIndex(e => e.id === engine.id);
  if (existingIndex >= 0) {
    // Update existing
    engines[existingIndex] = { ...engines[existingIndex], ...engine };
  } else {
    engines.push(engine);
  }
  await saveEngines();

  // Re-register commands for the new engine
  unregisterEngineCommands();
  registerEngineCommands();
};

/**
 * Remove a custom engine (cannot remove built-in)
 */
const removeEngine = async (engineId) => {
  const engine = getEngine(engineId);
  if (!engine) return false;
  if (engine.isBuiltIn) {
    console.warn('[ext:websearch] Cannot remove built-in engine:', engineId);
    return false;
  }

  engines = engines.filter(e => e.id !== engineId);
  await saveEngines();

  // Re-register commands
  unregisterEngineCommands();
  registerEngineCommands();

  return true;
};

// ===== Search URL Construction =====

/**
 * Build a search URL from a template and query
 */
const buildSearchUrl = (urlTemplate, query) => {
  return urlTemplate.replace('{searchTerms}', encodeURIComponent(query));
};

/**
 * Execute a search: record the round, then open the search results URL in a
 * new window.
 *
 * Every search path lands here, so recording happens once. When the window the
 * search was started from is in a space, the result window opens in that space
 * and its page is tagged into that space once the open has resolved. A
 * recording failure is logged where it happens and never stops the window from
 * opening.
 */
const executeSearch = async (engine, query, extraOpenOptions = {}) => {
  if (!query || !query.trim()) return;

  const url = buildSearchUrl(engine.searchUrl, query.trim());

  const spaceMode = await recordSearchRound(api, {
    query,
    engineId: engine.id,
    url
  });

  try {
    await api.window.open(url, {
      role: 'content',
      width: 1024,
      height: 768,
      trackingSource: 'websearch',
      trackingSourceId: engine.id,
      ...extraOpenOptions,
      ...(spaceMode ? { spaceMode } : {})
    });
    await tagResultPageInSpace(api, { url, spaceMode });
  } catch (err) {
    console.error('[ext:websearch] Failed to open search window:', err);
  }
};

// ===== Search Suggestions =====

/**
 * Fetch suggestions from a search engine's suggest API.
 * Supports OpenSearch JSON format: ["query", ["suggestion1", "suggestion2", ...]]
 */
const fetchSuggestions = async (engine, query, signal) => {
  if (!engine.suggestUrl || !query || !query.trim()) return [];
  if (!currentSettings.prefs.enableSuggestions) return [];

  const url = buildSearchUrl(engine.suggestUrl, query.trim());

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    if (signal) signal.addEventListener('abort', () => controller.abort());

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (signal && signal.aborted) return [];

    if (!res.ok) {
      return [];
    }

    const data = await res.json();

    // OpenSearch suggestion format: ["query", ["suggestion1", "suggestion2"]]
    if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1])) {
      return data[1].slice(0, 8);
    }

    // Google-style: { suggestions: [{ value: "..." }] }
    if (data && Array.isArray(data.suggestions)) {
      return data.suggestions.map(s => s.value || s).slice(0, 8);
    }

    return [];
  } catch (err) {
    if (err.name !== 'AbortError') {
    }
    return [];
  }
};

/**
 * Fetch suggestions with in-memory caching
 */
const fetchSuggestionsWithCache = async (engine, query, signal) => {
  const cacheKey = `${engine.id}:${query.toLowerCase().trim()}`;
  const cached = suggestionCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < SUGGESTION_CACHE_TTL) {
    return cached.suggestions;
  }

  const suggestions = await fetchSuggestions(engine, query, signal);

  suggestionCache.set(cacheKey, {
    suggestions,
    timestamp: Date.now()
  });

  // Evict oldest entries if cache is too large
  if (suggestionCache.size > SUGGESTION_CACHE_MAX) {
    const oldestKey = suggestionCache.keys().next().value;
    suggestionCache.delete(oldestKey);
  }

  return suggestions;
};

/**
 * Clear the suggestion cache
 */
const clearSuggestionCache = () => {
  suggestionCache.clear();
};

// ===== OpenSearch Discovery =====

/**
 * Parse an OpenSearch XML description document
 * Returns an engine object or null if invalid
 */
const parseOpenSearchXml = (xmlText, sourceUrl) => {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');

    // Check for parse errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      return null;
    }

    const ns = 'http://a9.com/-/spec/opensearch/1.1/';

    const shortName = doc.getElementsByTagNameNS(ns, 'ShortName')[0]?.textContent?.trim();
    const description = doc.getElementsByTagNameNS(ns, 'Description')[0]?.textContent?.trim();
    const imageEl = doc.getElementsByTagNameNS(ns, 'Image')[0];
    const iconUrl = imageEl?.textContent?.trim();

    // Find search URL (type="text/html")
    let searchUrl = null;
    let suggestUrl = null;

    const urlElements = doc.getElementsByTagNameNS(ns, 'Url');
    for (const urlEl of urlElements) {
      const type = urlEl.getAttribute('type');
      const template = urlEl.getAttribute('template');
      if (!template) continue;

      if (type === 'text/html' && !searchUrl) {
        searchUrl = template;
      } else if ((type === 'application/x-suggestions+json' || type === 'application/json') && !suggestUrl) {
        suggestUrl = template;
      }
    }

    if (!shortName || !searchUrl) {
      return null;
    }

    // Validate that searchUrl contains {searchTerms}
    if (!searchUrl.includes('{searchTerms}')) {
      return null;
    }

    // Reject javascript: URLs
    if (searchUrl.startsWith('javascript:') || (suggestUrl && suggestUrl.startsWith('javascript:'))) {
      return null;
    }

    // Generate a stable ID from the source URL
    const hostname = new URL(sourceUrl).hostname;
    const engineId = `discovered-${hostname.replace(/\./g, '-')}`;

    // Generate a short keyword from the hostname
    const shortNameKeyword = hostname
      .replace(/^www\./, '')
      .split('.')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12);

    return {
      id: engineId,
      name: shortName,
      shortName: shortNameKeyword,
      description: description || `Search ${shortName}`,
      searchUrl,
      suggestUrl: suggestUrl || null,
      iconUrl: iconUrl || null,
      isBuiltIn: false,
      enabled: true,
      discoveredFrom: sourceUrl,
      discoveredAt: Date.now()
    };
  } catch (err) {
    console.error('[ext:websearch] Failed to parse OpenSearch XML:', err);
    return null;
  }
};

/**
 * Attempt to discover and add a search engine from an OpenSearch URL
 */
const discoverEngine = async (opensearchUrl, pageUrl) => {
  if (!currentSettings.prefs.enableAutoDiscovery) return null;

  try {
    const response = await fetch(opensearchUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/opensearchdescription+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return null;

    const xmlText = await response.text();
    const engine = parseOpenSearchXml(xmlText, pageUrl);

    if (!engine) return null;

    // Check if we already have this engine
    const existing = getEngine(engine.id);
    if (existing) {
      return existing;
    }

    // Auto-add the discovered engine
    await addEngine(engine);

    // Publish discovery event for UI notifications
    api.pubsub.publish('websearch:engine-discovered', {
      engine: { id: engine.id, name: engine.name, searchUrl: engine.searchUrl }
    });

    return engine;
  } catch {
    return null;
  }
};

// ===== Query Extraction =====

/**
 * Extract the search query from a command execution context.
 *
 * The query can arrive in different fields depending on how the command
 * was invoked:
 *   - Inline ("kagi foo"):  ctx.search = "foo", ctx.params = ["foo"]
 *   - Tab param mode:       ctx.search = "foo", ctx.params = ["foo"]
 *   - Direct pubsub:        ctx.search = "foo"
 *
 * We check ctx.search first, then fall back to joining ctx.params,
 * then try extracting from ctx.typed by stripping the command name.
 */
const extractSearchQuery = (ctx) => {
  // 1. Explicit search field (set by buildExecutionContext when text follows command name)
  if (ctx.search && ctx.search.trim()) {
    return ctx.search.trim();
  }

  // 2. Params array (same source as search, but as split tokens)
  if (ctx.params && ctx.params.length > 0) {
    const joined = ctx.params.join(' ').trim();
    if (joined) return joined;
  }

  // 3. Extract from typed text by stripping the command name
  if (ctx.typed && ctx.name) {
    const typed = ctx.typed.trim();
    const nameLower = ctx.name.toLowerCase();
    const typedLower = typed.toLowerCase();
    if (typedLower.startsWith(nameLower + ' ')) {
      const rest = typed.slice(ctx.name.length).trim();
      if (rest) return rest;
    } else if (typedLower.startsWith(nameLower)) {
      const rest = typed.slice(ctx.name.length).trim();
      if (rest) return rest;
    }
  }

  // 4. Fallback: extract from value field (Enter payload passes value=input.value)
  if (ctx.value && ctx.name) {
    const val = ctx.value.trim();
    const nameLower = ctx.name.toLowerCase();
    const valLower = val.toLowerCase();
    if (valLower.startsWith(nameLower + ' ')) {
      const rest = val.slice(ctx.name.length).trim();
      if (rest) return rest;
    }
  }

  // 5. Last resort: if name is unknown AND typed contains a space, take everything
  // after the first space. Skipped when ctx.name is set, because a multi-word
  // command name (e.g. "web search") with no query would otherwise bleed the
  // second word into the query.
  if (!ctx.name && ctx.typed) {
    const spaceIdx = ctx.typed.indexOf(' ');
    if (spaceIdx > 0) {
      const rest = ctx.typed.slice(spaceIdx + 1).trim();
      if (rest) return rest;
    }
  }

  return '';
};

// ===== Command Definitions =====

const staticCommandDefinitions = [
  {
    name: 'web search',
    description: 'Search the web with your default search engine',
    params: [{ name: 'query', type: 'string', required: false, description: 'Search query' }],
    execute: async (ctx) => {
      // A cold cmd-execute wake may deliver this before loadSettings/
      // loadEngines resolve. Wait so the default engine reflects the user's
      // saved preference, not the module-load defaults.
      await initReady;
      const query = extractSearchQuery(ctx);
      if (query) {
        const engine = getDefaultEngine();
        await executeSearch(engine, query);
      } else {
        console.warn('[ext:websearch] No query extracted for web search - showing search window. ctx:', JSON.stringify(ctx));
        await api.window.showSelf();
      }
      return { success: true };
    }
  },
  {
    name: 'open web search',
    description: 'Open the web search window',
    execute: async (ctx) => {
      await api.window.showSelf();
      return { success: true };
    }
  }
];

// Track registered commands for cleanup
let registeredCommands = [];
let engineCommands = [];

/**
 * Register per-engine commands (e.g., /google, /ddg, /bing, /wiki)
 */
const registerEngineCommands = () => {
  const enabledEngines = getEnabledEngines();

  for (const engine of enabledEngines) {
    const cmd = {
      name: engine.shortName,
      description: `Search ${engine.name}`,
      params: [{ name: 'query', type: 'string', required: false, description: 'Search query' }],
      execute: async (ctx) => {
        // A cold cmd-execute wake may deliver this before loadSettings/
        // loadEngines resolve. Wait so the engine list / settings are fully
        // loaded before we build and open the search URL.
        await initReady;
        const query = extractSearchQuery(ctx);
        if (query) {
          await executeSearch(engine, query);
        } else {
          console.warn('[ext:websearch] No query extracted for', engine.shortName, '- showing search window. ctx:', JSON.stringify(ctx));
          await api.window.showSelf();
        }
        return { success: true };
      }
    };
    api.commands.register(cmd);
    engineCommands.push(engine.shortName);
  }

};

/**
 * Unregister engine commands
 */
const unregisterEngineCommands = () => {
  for (const name of engineCommands) {
    api.commands.unregister(name);
  }
  engineCommands = [];
};

/**
 * Register all commands (static + per-engine)
 */
const initCommands = () => {
  // Register static commands
  staticCommandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });

  // Register engine commands
  registerEngineCommands();
};

/**
 * Unregister all commands
 */
const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];

  unregisterEngineCommands();
};

// ===== Event Handlers (background-mode) =====

/**
 * Resolves once settings + engines have finished loading. The discovery
 * handler awaits this so a `page:search-engine-discovered` event that
 * arrives during the wake window (subscription registered before
 * loadSettings/loadEngines complete) doesn't run discoverEngine against
 * an unpopulated `currentSettings` / engine list.
 */
let resolveInitReady;
const initReady = new Promise((resolve) => { resolveInitReady = resolve; });

/**
 * Handle the core `page:search-engine-discovered` event for OpenSearch
 * discovery. Core page handling fires this (with {pageUrl, opensearchUrl})
 * only when a page advertises an OpenSearch descriptor — it is also the
 * lazyEvent that wakes this tile (declared in manifest.json). The tile
 * boots HIDDEN on this event; discovery never shows the search UI.
 */
const handleSearchEngineDiscovered = async (msg) => {
  if (!msg || !msg.pageUrl || !msg.opensearchUrl) return;

  // Only discover from http/https pages
  if (!msg.pageUrl.startsWith('http://') && !msg.pageUrl.startsWith('https://')) return;

  // The wake event may arrive before loadSettings/loadEngines finish.
  await initReady;

  if (!currentSettings.prefs.enableAutoDiscovery) return;

  await discoverEngine(msg.opensearchUrl, msg.pageUrl);
};

// ===== Tile Lifecycle (engine init — runs before DOM) =====

const uninit = () => {
  uninitCommands();

  // Cancel any in-flight suggestion request
  if (currentSuggestionAbortController) {
    currentSuggestionAbortController.abort();
    currentSuggestionAbortController = null;
  }
};

// ===== UI State =====

let uiState = {
  query: '',
  suggestions: [],
  engines: [],
  selectedIndex: -1,
  currentEngine: null,
  defaultEngineId: 'duckduckgo',
  mode: 'engines', // 'engines' | 'suggestions'
};

// Expose state for testing
window._websearchState = uiState;

// ===== UI Utilities =====

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

// ===== UI: Engine list sync from in-process state =====

/**
 * Populate UI state from the in-process engines array.
 * Replaces the old cross-window websearch:engines-list pubsub round-trip.
 */
const syncEnginesToUi = () => {
  const defaultEngineId = currentSettings.prefs.defaultEngine;
  uiState.engines = engines.map(e => ({
    id: e.id,
    name: e.name,
    shortName: e.shortName,
    description: e.description,
    searchUrl: e.searchUrl,
    suggestUrl: e.suggestUrl,
    iconUrl: e.iconUrl,
    isBuiltIn: e.isBuiltIn,
    enabled: e.enabled !== false,
    isDefault: e.id === defaultEngineId
  }));
  uiState.defaultEngineId = defaultEngineId;

  // Set default engine if none selected
  if (!uiState.currentEngine) {
    uiState.currentEngine = uiState.engines.find(e => e.id === uiState.defaultEngineId) || uiState.engines[0];
  }
};

// ===== UI: Suggestion handling =====

/**
 * Request suggestions directly (no cross-window round-trip)
 */
const requestSuggestions = debounce(async (query) => {
  if (!query || !query.trim()) {
    uiState.suggestions = [];
    uiState.mode = 'engines';
    render();
    return;
  }

  const engineId = uiState.currentEngine?.id || uiState.defaultEngineId;
  const engine = getEngine(engineId) || getDefaultEngine();

  // Cancel previous in-flight request
  if (currentSuggestionAbortController) {
    currentSuggestionAbortController.abort();
  }
  currentSuggestionAbortController = new AbortController();

  const suggestions = await fetchSuggestionsWithCache(
    engine,
    query,
    currentSuggestionAbortController.signal
  );

  uiState.suggestions = suggestions;
  uiState.mode = 'suggestions';
  uiState.selectedIndex = suggestions.length > 0 ? 0 : -1;
  render();
}, 300);

// ===== UI: Search from UI =====

/**
 * Execute search from the search window UI.
 *
 * Goes through executeSearch() so the box, the suggestions and Enter record a
 * round the same way the commands do; the only difference is the `key`, which
 * collapses a repeat of the same result URL onto one window.
 */
const executeSearchFromUi = (query) => {
  if (!query || !query.trim()) return;

  const engine = uiState.currentEngine
    || uiState.engines.find(e => e.id === uiState.defaultEngineId)
    || uiState.engines[0];
  if (!engine) return;

  const url = buildSearchUrl(engine.searchUrl, query.trim());

  executeSearch(engine, query, { key: url }).catch(err => {
    console.error('[ext:websearch] Failed to run search from the search window:', err);
  });
};

/**
 * Set the current engine
 */
const setCurrentEngine = (engine) => {
  uiState.currentEngine = engine;
  updateEngineIndicator();
};

// ===== UI: Rendering =====

/**
 * Update the engine indicator display
 */
const updateEngineIndicator = () => {
  const engine = uiState.currentEngine || uiState.engines.find(e => e.id === uiState.defaultEngineId) || uiState.engines[0];
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
  if (searchInput) searchInput.placeholder = `Search ${engine.name}...`;
};

/**
 * Render the current view
 */
const render = () => {
  if (uiState.mode === 'suggestions' && uiState.suggestions.length > 0) {
    renderSuggestions();
  } else if (uiState.query && uiState.query.trim()) {
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

  if (uiState.suggestions.length === 0) {
    if (uiState.query && uiState.query.trim()) {
      // Show "Press Enter to search" hint
      const hint = document.createElement('div');
      hint.className = 'suggestion-item selected';
      hint.innerHTML = `
        <div class="suggestion-icon">${searchIconSvg}</div>
        <div class="suggestion-text">Search for "${escapeHtml(uiState.query)}"</div>
      `;
      hint.addEventListener('click', () => {
        executeSearchFromUi(uiState.query);
      });
      container.appendChild(hint);
      uiState.selectedIndex = 0;
    }
    return;
  }

  uiState.suggestions.forEach((suggestion, index) => {
    const el = document.createElement('div');
    el.className = 'suggestion-item';
    if (index === uiState.selectedIndex) {
      el.classList.add('selected');
    }
    el.dataset.index = index;

    el.innerHTML = `
      <div class="suggestion-icon">${searchIconSvg}</div>
      <div class="suggestion-text">${escapeHtml(suggestion)}</div>
    `;

    el.addEventListener('click', () => {
      uiState.selectedIndex = index;
      updateSelection();
      executeSearchFromUi(suggestion);
    });

    container.appendChild(el);
  });

  // Add attribution
  const engine = uiState.currentEngine || uiState.engines.find(e => e.id === uiState.defaultEngineId);
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

  if (uiState.engines.length === 0) {
    emptyState.style.display = '';
    return;
  }

  const header = document.createElement('div');
  header.className = 'engine-list-header';
  header.textContent = 'Search Engines';
  container.appendChild(header);

  uiState.engines.forEach((engine, index) => {
    const el = document.createElement('div');
    el.className = 'engine-item';
    if (index === uiState.selectedIndex) {
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
    el.classList.toggle('selected', i === uiState.selectedIndex);
  });

  // Update engines
  const engineEls = document.querySelectorAll('.engine-item');
  engineEls.forEach((el, i) => {
    el.classList.toggle('selected', i === uiState.selectedIndex);
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
  if (uiState.query) {
    uiState.query = '';
    searchInput.value = '';
    uiState.suggestions = [];
    uiState.selectedIndex = -1;
    uiState.mode = 'engines';
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
  if (uiState.mode === 'suggestions' || (uiState.query && uiState.query.trim())) {
    return uiState.suggestions.length > 0 ? uiState.suggestions : (uiState.query ? ['__search__'] : []);
  }
  return uiState.engines;
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
      if (items.length > 0 && uiState.selectedIndex < items.length - 1) {
        uiState.selectedIndex++;
        updateSelection();
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      if (uiState.selectedIndex > 0) {
        uiState.selectedIndex--;
        updateSelection();
      }
      break;

    case 'Enter':
      e.preventDefault();
      if (uiState.mode === 'suggestions' || (uiState.query && uiState.query.trim())) {
        // If a suggestion is selected, search for it
        if (uiState.selectedIndex >= 0 && uiState.selectedIndex < uiState.suggestions.length) {
          executeSearchFromUi(uiState.suggestions[uiState.selectedIndex]);
        } else {
          // Search for the raw query
          executeSearchFromUi(uiState.query);
        }
      } else if (uiState.mode === 'engines' && uiState.selectedIndex >= 0 && uiState.selectedIndex < uiState.engines.length) {
        // Select engine
        setCurrentEngine(uiState.engines[uiState.selectedIndex]);
        searchInput.focus();
      }
      break;

    case 'Tab':
      // Autocomplete first suggestion
      if (uiState.suggestions.length > 0 && uiState.query) {
        e.preventDefault();
        const suggestion = uiState.suggestions[0];
        uiState.query = suggestion;
        searchInput.value = suggestion;
        uiState.selectedIndex = 0;
        updateSelection();
      }
      break;
  }
};

// ===== UI Initialization =====

const initUi = () => {
  // Register escape handler
  api.escape.onEscape(handleEscape);

  // Subscribe to engine-discovered events to refresh UI
  api.pubsub.subscribe('websearch:engine-discovered', () => {
    syncEnginesToUi();
    updateEngineIndicator();
    render();
  });

  // Subscribe to settings changes to refresh UI
  api.pubsub.subscribe('websearch:settings-changed', () => {
    syncEnginesToUi();
    updateEngineIndicator();
    render();
  });

  // Set up search input
  const searchInput = document.getElementById('search-input');

  // Auto-focus search input
  setTimeout(() => {
    searchInput.focus();
  }, 100);

  // Handle input for suggestions
  searchInput.addEventListener('input', (e) => {
    uiState.query = e.target.value;
    uiState.selectedIndex = -1;

    if (!uiState.query || !uiState.query.trim()) {
      uiState.suggestions = [];
      uiState.mode = 'engines';
      render();
      return;
    }

    uiState.mode = 'suggestions';
    requestSuggestions(uiState.query);
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Engine indicator click cycles engines
  const engineIndicator = document.getElementById('engine-indicator');
  engineIndicator.addEventListener('click', () => {
    if (uiState.engines.length === 0) return;

    const currentIndex = uiState.engines.findIndex(e => e.id === (uiState.currentEngine?.id || uiState.defaultEngineId));
    const nextIndex = (currentIndex + 1) % uiState.engines.length;
    setCurrentEngine(uiState.engines[nextIndex]);
  });

  // Re-focus search input on window focus
  window.addEventListener('focus', () => {
    searchInput.focus();
  });

  // Populate engine UI from in-process state (no round-trip needed)
  syncEnginesToUi();
  updateEngineIndicator();
  render();
};

// ===== Top-level init (runs as module in home.html) =====

(async () => {
  const extId = id;
  console.log(`[ext:${extId}] home.js loaded`);

  // Initialize tile — validates capability token with main process
  console.log(`[ext:${extId}] initializing tile`);
  await api.initialize();

  // Subscribe to the core semantic search-engine-discovery event
  // SYNCHRONOUSLY, before the async settings/engine loads below. This is
  // also this tile's lazyEvent (manifest.json): when a page-load event
  // WAKES this lazy tile, the load-on-dispatch hook delivers the deferred
  // publish as soon as the tile signals ready (which the preload defers
  // to a setTimeout(0) macrotask). If we subscribed only after awaiting
  // loadSettings/loadEngines, that ready macrotask could fire — and the
  // deferred message be delivered — before the subscription existed,
  // dropping the very event that woke us. Subscribing here, in the same
  // synchronous turn that api.initialize() resolved on, guarantees the
  // handler is registered before ready. The handler awaits initReady so
  // settings/engines are loaded by the time discovery actually runs.
  api.pubsub.subscribe('page:search-engine-discovered', handleSearchEngineDiscovered);

  // Register command handlers SYNCHRONOUSLY too, in the same turn, BEFORE the
  // async settings/engine loads below. Same lazy-wake hazard as the discovery
  // subscribe: a cold `cmd:execute:<websearch-cmd>` that WAKES this tile is
  // deferred by the load-on-dispatch hook until the tile signals ready, and
  // ready fires on a setTimeout(0) macrotask that can run before the awaits
  // below resolve. If command registration happened only after those awaits,
  // the deferred command would be delivered with no handler registered and
  // hang (first cold command dropped). Registering here guarantees the
  // handlers exist before ready. The engine commands registered now cover the
  // built-in engines (seeded at module load); they're refreshed once
  // loadEngines() resolves so custom/discovered engines get their keywords.
  // Each command handler body awaits initReady before reading
  // settings/engines, so the first cold command still uses fully-loaded state.
  initCommands();

  // Load settings and engines
  currentSettings = await loadSettings();
  await loadEngines();

  // Refresh engine commands now that custom/discovered engines are loaded
  // (the early initCommands() above only saw the built-in engines). Mirrors
  // the same dance addEngine/removeEngine/settings-update already use.
  unregisterEngineCommands();
  registerEngineCommands();

  // Settings + engines are loaded; release any discovery events / cold
  // commands that arrived during the wake window above.
  resolveInitReady();

  // Listen for settings updates from Settings UI
  api.pubsub.subscribe('websearch:settings-update', async (msg) => {

    try {
      if (msg.data) {
        currentSettings = {
          prefs: { ...currentSettings.prefs, ...(msg.data.prefs || {}) }
        };
      } else if (msg.key === 'prefs' && msg.path) {
        const field = msg.path.split('.')[1];
        if (field) {
          currentSettings.prefs = { ...currentSettings.prefs, [field]: msg.value };
        }
      }

      await saveSettings(currentSettings);

      // Clear suggestion cache if suggestions were toggled off
      if (!currentSettings.prefs.enableSuggestions) {
        clearSuggestionCache();
      }

      uninit();
      await loadEngines();
      initCommands();

      api.pubsub.publish('websearch:settings-changed', currentSettings);
    } catch (err) {
      console.error('[ext:websearch] settings-update error:', err);
    }
  });

  // Register shutdown handler
  api.onShutdown(() => {
    console.log(`[ext:${extId}] received shutdown`);
    uninit();
  });

  // Initialize UI once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUi);
  } else {
    initUi();
  }
})();

export {
  builtinEngines,
  getEngine,
  getDefaultEngine,
  getEnabledEngines,
  buildSearchUrl,
  parseOpenSearchXml,
};
