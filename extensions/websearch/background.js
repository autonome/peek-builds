/**
 * Web Search Extension Background Script
 *
 * Provides web search from the command palette:
 * - Built-in engines: Google, DuckDuckGo, Bing, Wikipedia
 * - OpenSearch discovery from visited pages
 * - Search suggestions with debounce and caching
 * - Per-engine commands (/google, /ddg, /bing, /wiki)
 * - A general "web search" command with engine selection
 *
 * Runs in isolated extension process (peek://ext/websearch/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults, builtinEngines } from './config.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:websearch] background', labels.name);

// Extension content is served from peek://ext/websearch/
const address = 'peek://ext/websearch/home.html';

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

// Track the search window ID
let searchWindowId = null;

// ===== Settings =====

/**
 * Load settings from datastore
 */
const loadSettings = async () => {
  const result = await api.settings.get();
  if (result.success && result.data) {
    return {
      prefs: { ...defaults.prefs, ...(result.data.prefs || {}) }
    };
  }
  return { prefs: { ...defaults.prefs } };
};

/**
 * Save settings to datastore
 */
const saveSettings = async (settings) => {
  const result = await api.settings.set(settings);
  if (!result.success) {
    console.error('[ext:websearch] Failed to save settings:', result.error);
  }
};

// ===== Engine Registry =====

/**
 * Load custom/discovered engines from settings
 */
const loadEngines = async () => {
  const result = await api.settings.get();
  const customEngines = (result.success && result.data && result.data.engines) || [];

  // Merge built-in with custom, custom engines can override built-in ones by ID
  const customIds = new Set(customEngines.map(e => e.id));
  engines = [
    ...builtinEngines.filter(e => !customIds.has(e.id)),
    ...customEngines
  ];

  debug && console.log('[ext:websearch] Loaded engines:', engines.map(e => e.id));
};

/**
 * Save custom engines to settings (only non-builtin ones)
 */
const saveEngines = async () => {
  const customEngines = engines.filter(e => !e.isBuiltIn);
  const result = await api.settings.get();
  const currentData = (result.success && result.data) || {};
  await api.settings.set({ ...currentData, engines: customEngines });
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

  debug && console.log('[ext:websearch] Added engine:', engine.id, engine.name);
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
 * Execute a search: open the search results URL in a new window
 */
const executeSearch = async (engine, query) => {
  if (!query || !query.trim()) return;

  const url = buildSearchUrl(engine.searchUrl, query.trim());
  debug && console.log('[ext:websearch] Searching:', engine.name, query, '->', url);

  try {
    await api.window.open(url, {
      role: 'content',
      key: url,
      width: 1024,
      height: 768,
      trackingSource: 'websearch',
      trackingSourceId: engine.id
    });
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
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal,
    });

    if (!response.ok) return [];

    const data = await response.json();

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
      debug && console.log('[ext:websearch] Suggestion fetch failed:', err.message);
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
      debug && console.log('[ext:websearch] OpenSearch XML parse error');
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
      debug && console.log('[ext:websearch] OpenSearch XML missing required fields (ShortName, Url)');
      return null;
    }

    // Validate that searchUrl contains {searchTerms}
    if (!searchUrl.includes('{searchTerms}')) {
      debug && console.log('[ext:websearch] OpenSearch search URL missing {searchTerms} placeholder');
      return null;
    }

    // Reject javascript: URLs
    if (searchUrl.startsWith('javascript:') || (suggestUrl && suggestUrl.startsWith('javascript:'))) {
      debug && console.log('[ext:websearch] Rejecting javascript: URL in OpenSearch');
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
      debug && console.log('[ext:websearch] Engine already registered:', engine.id);
      return existing;
    }

    // Auto-add the discovered engine
    await addEngine(engine);

    // Publish discovery event for UI notifications
    api.publish('websearch:engine-discovered', {
      engine: { id: engine.id, name: engine.name, searchUrl: engine.searchUrl }
    }, api.scopes.GLOBAL);

    console.log('[ext:websearch] Discovered search engine:', engine.name, 'from', pageUrl);
    return engine;
  } catch (err) {
    debug && console.log('[ext:websearch] OpenSearch discovery failed:', err.message);
    return null;
  }
};

// ===== Search Window =====

let isOpeningSearch = false;
const openSearchWindow = async () => {
  if (isOpeningSearch) return;
  isOpeningSearch = true;
  try {
    const params = {
      role: 'workspace',
      key: address,
      height: 500,
      width: 600,
      trackingSource: 'cmd',
      trackingSourceId: 'websearch'
    };

    const window = await api.window.open(address, params);
    debug && console.log('[ext:websearch] Search window opened:', window);
    searchWindowId = window?.id || null;
  } catch (error) {
    console.error('[ext:websearch] Failed to open search window:', error);
  } finally {
    isOpeningSearch = false;
  }
};

// ===== Command Definitions =====

const staticCommandDefinitions = [
  {
    name: 'web search',
    description: 'Search the web with your default search engine',
    execute: async (ctx) => {
      const query = ctx.search || '';
      if (query.trim()) {
        const engine = getDefaultEngine();
        await executeSearch(engine, query);
      } else {
        openSearchWindow();
      }
    }
  },
  {
    name: 'open web search',
    description: 'Open the web search window',
    execute: async (ctx) => {
      openSearchWindow();
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
      execute: async (ctx) => {
        const query = ctx.search || '';
        if (query.trim()) {
          await executeSearch(engine, query);
        } else {
          openSearchWindow();
        }
      }
    };
    api.commands.register(cmd);
    engineCommands.push(engine.shortName);
  }

  debug && console.log('[ext:websearch] Registered engine commands:', engineCommands);
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

  console.log('[ext:websearch] Registered commands:', [...registeredCommands, ...engineCommands]);
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

  console.log('[ext:websearch] Unregistered commands');
};

// ===== Event Handlers =====

/**
 * Handle page navigation events for OpenSearch discovery
 */
const handlePageLoaded = async (msg) => {
  if (!currentSettings.prefs.enableAutoDiscovery) return;
  if (!msg || !msg.url) return;

  // Only discover from http/https pages
  if (!msg.url.startsWith('http://') && !msg.url.startsWith('https://')) return;

  // Check if the page has an OpenSearch link
  if (msg.opensearchUrl) {
    await discoverEngine(msg.opensearchUrl, msg.url);
  }
};

/**
 * Handle suggestion requests from the search UI or command bar
 */
const handleSuggestionRequest = async (msg) => {
  if (!msg || !msg.query) return;

  const engineId = msg.engineId || currentSettings.prefs.defaultEngine;
  const engine = getEngine(engineId) || getDefaultEngine();

  // Cancel previous in-flight request
  if (currentSuggestionAbortController) {
    currentSuggestionAbortController.abort();
  }
  currentSuggestionAbortController = new AbortController();

  const suggestions = await fetchSuggestionsWithCache(
    engine,
    msg.query,
    currentSuggestionAbortController.signal
  );

  // Publish suggestions response
  api.publish('websearch:suggestions', {
    query: msg.query,
    engineId: engine.id,
    engineName: engine.name,
    suggestions
  }, api.scopes.GLOBAL);
};

/**
 * Handle engine management requests
 */
const handleEngineRequest = async (msg) => {
  if (!msg || !msg.action) return;

  switch (msg.action) {
    case 'list':
      api.publish('websearch:engines-list', {
        engines: engines.map(e => ({
          id: e.id,
          name: e.name,
          shortName: e.shortName,
          description: e.description,
          searchUrl: e.searchUrl,
          suggestUrl: e.suggestUrl,
          iconUrl: e.iconUrl,
          isBuiltIn: e.isBuiltIn,
          enabled: e.enabled !== false,
          isDefault: e.id === currentSettings.prefs.defaultEngine
        })),
        defaultEngineId: currentSettings.prefs.defaultEngine
      }, api.scopes.GLOBAL);
      break;

    case 'add':
      if (msg.engine) {
        await addEngine(msg.engine);
      }
      break;

    case 'remove':
      if (msg.engineId) {
        await removeEngine(msg.engineId);
      }
      break;

    case 'set-default':
      if (msg.engineId && getEngine(msg.engineId)) {
        currentSettings.prefs.defaultEngine = msg.engineId;
        await saveSettings(currentSettings);
        api.publish('websearch:settings-changed', currentSettings, api.scopes.GLOBAL);
      }
      break;

    case 'toggle':
      if (msg.engineId) {
        const engine = getEngine(msg.engineId);
        if (engine) {
          engine.enabled = msg.enabled !== undefined ? msg.enabled : !(engine.enabled !== false);
          await saveEngines();
          // Re-register commands with updated enabled state
          unregisterEngineCommands();
          registerEngineCommands();
        }
      }
      break;
  }
};

// ===== Lifecycle =====

const init = async () => {
  console.log('[ext:websearch] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  // Load custom engines from datastore
  await loadEngines();

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Listen for page load events for OpenSearch discovery
  api.subscribe('page:loaded', handlePageLoaded, api.scopes.GLOBAL);

  // Listen for suggestion requests
  api.subscribe('websearch:request-suggestions', handleSuggestionRequest, api.scopes.GLOBAL);

  // Listen for engine management requests
  api.subscribe('websearch:engine-request', handleEngineRequest, api.scopes.GLOBAL);

  // Listen for window close events
  api.subscribe('window:closed', async (msg) => {
    const closedWindowId = msg?.id;
    if (closedWindowId === searchWindowId) {
      debug && console.log('[ext:websearch] Search window closed');
      searchWindowId = null;
    }
  }, api.scopes.GLOBAL);

  // Listen for settings changes to hot-reload
  api.subscribe('websearch:settings-changed', async () => {
    console.log('[ext:websearch] settings changed, reinitializing');
    uninit();
    currentSettings = await loadSettings();
    await loadEngines();
    initCommands();
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  api.subscribe('websearch:settings-update', async (msg) => {
    console.log('[ext:websearch] settings-update received:', msg);

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

      api.publish('websearch:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      console.error('[ext:websearch] settings-update error:', err);
    }
  }, api.scopes.GLOBAL);
};

const uninit = () => {
  console.log('[ext:websearch] uninit');
  uninitCommands();

  // Cancel any in-flight suggestion request
  if (currentSuggestionAbortController) {
    currentSuggestionAbortController.abort();
    currentSuggestionAbortController = null;
  }
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys,
  // Expose for testing
  builtinEngines,
  getEngine,
  getDefaultEngine,
  getEnabledEngines,
  buildSearchUrl,
  parseOpenSearchXml,
};
