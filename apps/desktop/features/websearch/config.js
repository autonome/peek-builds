const id = 'websearch';

const labels = {
  name: 'Web Search',
  prefs: {
    defaultEngine: 'Default search engine',
    enableSuggestions: 'Enable search suggestions',
    enableAutoDiscovery: 'Auto-discover search engines',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.websearch.prefs.schema.json",
  "title": "Web Search preferences",
  "description": "Peek app Web Search user preferences",
  "type": "object",
  "properties": {
    "defaultEngine": {
      "description": "ID of the default search engine",
      "type": "string",
      "default": "duckduckgo"
    },
    "enableSuggestions": {
      "description": "Enable search suggestions from search engines",
      "type": "boolean",
      "default": true
    },
    "enableAutoDiscovery": {
      "description": "Auto-discover search engines from visited websites via OpenSearch",
      "type": "boolean",
      "default": true
    }
  },
  "required": ["defaultEngine", "enableSuggestions", "enableAutoDiscovery"]
};

const schemas = {
  prefs: prefsSchema,
};

const storageKeys = {
  PREFS: 'prefs',
  ENGINES: 'engines',
};

const defaults = {
  prefs: {
    defaultEngine: 'duckduckgo',
    enableSuggestions: true,
    enableAutoDiscovery: true,
  },
};

/**
 * Built-in search engines.
 * Each engine has: id, name, shortName (keyword for cmd), searchUrl, suggestUrl, iconUrl, isBuiltIn
 */
const builtinEngines = [
  {
    id: 'google',
    name: 'Google',
    shortName: 'google',
    description: 'Search Google',
    searchUrl: 'https://www.google.com/search?q={searchTerms}',
    suggestUrl: 'https://suggestqueries.google.com/complete/search?client=firefox&q={searchTerms}',
    iconUrl: 'https://www.google.com/favicon.ico',
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    shortName: 'ddg',
    description: 'Privacy-focused search',
    searchUrl: 'https://duckduckgo.com/?q={searchTerms}',
    suggestUrl: 'https://duckduckgo.com/ac/?q={searchTerms}&type=list',
    iconUrl: 'https://duckduckgo.com/favicon.ico',
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: 'bing',
    name: 'Bing',
    shortName: 'bing',
    description: 'Search Bing',
    searchUrl: 'https://www.bing.com/search?q={searchTerms}',
    suggestUrl: 'https://api.bing.com/osjson.aspx?query={searchTerms}',
    iconUrl: 'https://www.bing.com/favicon.ico',
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    shortName: 'wiki',
    description: 'Search Wikipedia',
    searchUrl: 'https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}',
    suggestUrl: 'https://en.wikipedia.org/w/api.php?action=opensearch&search={searchTerms}',
    iconUrl: 'https://en.wikipedia.org/favicon.ico',
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: 'kagi',
    name: 'Kagi',
    shortName: 'kagi',
    description: 'Kagi premium search',
    searchUrl: 'https://kagi.com/search?q={searchTerms}',
    suggestUrl: 'https://kagi.com/api/autosuggest?q={searchTerms}',
    iconUrl: 'https://kagi.com/favicon.ico',
    isBuiltIn: true,
    enabled: true,
  }
];

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults,
  builtinEngines
};
