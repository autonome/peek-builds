# Search Extension for Peek - Research & Design

**Status:** Planning phase
**Last Updated:** 2026-02-10
**Purpose:** Design comprehensive search engine support with browser-level discovery, management, and cmd bar integration

---

## 1. Overview

### Problem Statement

Peek currently lacks a standardized way to perform web searches through the cmd bar. Users need:
- Quick web search access via keyboard (like `/google query` or `/ddg query`)
- Search engine discovery from websites (like browsers do with OpenSearch)
- Management of multiple search engines with preferences
- Search suggestions as they type
- Default search engine fallback for unmatched cmd input

### User Stories

**As a user, I want to:**
1. Type `/google artificial intelligence` in cmd bar and search Google
2. Visit wikipedia.org and have Peek auto-discover "Search Wikipedia" option
3. Manage my installed search engines in Settings
4. See search suggestions as I type in cmd bar
5. Have unrecognized cmd input automatically search using my default engine
6. Switch my default search engine easily
7. Use custom search engines (like internal company search)

### Success Metrics

- Search commands execute in <500ms
- Search suggestions appear in <200ms after typing stops
- OpenSearch discovery works on 95% of sites that provide it
- Zero user confusion about which search engine is active
- Settings UI allows full management without complexity

---

## 2. Browser Research - How Modern Browsers Do It

### Firefox (2026)

**Discovery:**
- Uses `<link rel="search" type="application/opensearchdescription+xml">` in HTML
- Automatically detects OpenSearch XML files
- Shows "Add Search Engine" button in address bar when discovered
- User can also manually add via Settings > Search

**Management:**
- Settings > Search shows all installed engines
- Set default engine with radio buttons
- Remove engines with Remove button
- Search shortcuts: short keywords like "g" for Google, "w" for Wikipedia
- One-click address bar dropdown shows recent searches and suggestions

**Suggestions:**
- Fetches suggestions from search engine's suggestion URL
- Debounces requests (300ms typical)
- Caches results in memory (5 min TTL)
- Shows mix of history, bookmarks, and engine suggestions
- Privacy mode: no suggestions in private windows

**APIs:**
- WebExtension search API: `browser.search.get()`, `browser.search.search()`
- Can programmatically trigger searches
- Cannot modify engine list (security restriction)

### Chrome (2026)

**Discovery:**
- Same OpenSearch auto-discovery as Firefox
- Also uses Web Search manifest key for installed PWAs
- "Manage search engines" in Settings
- Automatic keyword extraction from site search forms

**Management:**
- Settings > Search engine > Manage search engines
- Default engine dropdown
- Three lists: Default, Active (used recently), Inactive
- Keywords: shortcut text like "youtube.com" → "yt"
- Edit button allows customizing URL template and keyword

**Suggestions:**
- Chrome-specific suggest protocol (JSON)
- Aggregates: search suggestions, history, bookmarks, tabs
- Privacy: anonymous requests, no cookies
- Cache: in-memory, per-session

**APIs:**
- `chrome.search.query()` - search with default engine only
- No API to list or manage engines (security)

### Safari (2026)

**Discovery:**
- OpenSearch support (limited)
- Prefers built-in engine list
- Manual addition through profiles or config

**Management:**
- Settings > Search > Search engine dropdown (4 built-in only by default)
- Custom engines via Safari Technology Preview or profiles

**Suggestions:**
- From default engine only
- Minimal UI (no rich previews)

### Key Patterns Across Browsers

| Feature | Firefox | Chrome | Safari |
|---------|---------|--------|--------|
| OpenSearch discovery | ✅ Yes | ✅ Yes | ⚠️ Limited |
| Search suggestions | ✅ Yes | ✅ Yes | ✅ Yes |
| Custom engines | ✅ Easy | ✅ Easy | ⚠️ Complex |
| Keyword shortcuts | ✅ Yes | ✅ Yes | ❌ No |
| Default engine | ✅ User choice | ✅ User choice | ✅ 4 options |
| Privacy mode | ✅ No suggestions | ✅ No suggestions | ✅ No suggestions |

**Takeaways for Peek:**
- OpenSearch XML is the standard for discovery
- Suggestion APIs are engine-specific (no universal protocol)
- Keyword shortcuts are highly valued by power users
- Default fallback is expected UX
- Privacy mode must disable suggestions

---

## 3. OpenSearch Discovery & Installation

### OpenSearch XML Format

**Standard:** [OpenSearch 1.1 Draft 6](https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md)

**Example:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Wikipedia</ShortName>
  <Description>Search Wikipedia, the free encyclopedia</Description>
  <Tags>encyclopedia wiki</Tags>
  <Contact>contact@example.com</Contact>
  <Url type="text/html" template="https://en.wikipedia.org/wiki/Special:Search?search={searchTerms}"/>
  <Url type="application/x-suggestions+json" template="https://en.wikipedia.org/w/api.php?action=opensearch&amp;search={searchTerms}"/>
  <Image height="16" width="16" type="image/x-icon">https://en.wikipedia.org/favicon.ico</Image>
  <InputEncoding>UTF-8</InputEncoding>
  <SearchForm>https://en.wikipedia.org/wiki/Special:Search</SearchForm>
</OpenSearchDescription>
```

**Key Elements:**
- `<ShortName>` - Display name (max 16 chars recommended)
- `<Description>` - User-facing description
- `<Url type="text/html">` - Search URL template with `{searchTerms}` placeholder
- `<Url type="application/x-suggestions+json">` - Suggestion URL (optional)
- `<Image>` - Favicon URL
- `<InputEncoding>` - Character encoding (UTF-8 typical)

**Discovery HTML:**
```html
<link rel="search"
      type="application/opensearchdescription+xml"
      title="Search Wikipedia"
      href="/opensearch.xml">
```

**Browser Detection:**
- BrowserWindow webContents monitors page load
- Parse HTML for `<link rel="search">` tags
- Fetch OpenSearch XML file
- Parse and validate XML
- Prompt user to install or auto-install based on settings

### Implementation in Peek

**Detection Flow:**
1. User visits page (e.g., `https://duckduckgo.com`)
2. `did-finish-load` event fires in webContents
3. Search extension injects content script
4. Content script queries: `document.querySelector('link[rel="search"]')`
5. If found, sends message to background: `search:discovered`
6. Background fetches and parses OpenSearch XML
7. Shows notification or cmd bar indicator: "Install DuckDuckGo search?"
8. User confirms → adds to search engine list

**Storage Schema:**
```javascript
// datastore table: search_engines
{
  id: 'uuid',           // Unique identifier
  name: 'DuckDuckGo',   // Display name
  shortName: 'ddg',     // Keyword for cmd (/ddg query)
  description: 'Privacy-focused search',
  searchUrl: 'https://duckduckgo.com/?q={searchTerms}',
  suggestionUrl: 'https://duckduckgo.com/ac/?q={searchTerms}&type=list',
  iconUrl: 'https://duckduckgo.com/favicon.ico',
  encoding: 'UTF-8',
  isDefault: false,     // Whether this is the default engine
  isBuiltIn: true,      // Pre-installed vs user-added
  enabled: true,        // User can disable without removing
  createdAt: 1234567890,
  updatedAt: 1234567890
}
```

**Built-in Engines (Pre-installed):**
- Google (default)
- DuckDuckGo
- Bing
- Wikipedia
- GitHub
- Stack Overflow

---

## 4. Architecture & Data Flow

### Component Structure

```
features/search/
├── manifest.json              # Extension metadata
├── background.js              # Main extension logic
├── content-discovery.js       # Content script for OpenSearch detection
├── suggestion-provider.js     # Handles suggestion API calls
├── settings-schema.json       # Settings UI schema
├── settings.html              # Management UI
├── settings.js                # Settings UI logic
├── commands/
│   ├── search-engine-cmd.js  # Per-engine cmd registrations (/google, /ddg)
│   └── default-search.js     # Fallback search handler
└── config.js                  # Default engines, schemas
```

### Data Flow: Command Execution

```
User types: /google AI research
         ↓
Cmd panel detects "/google" prefix
         ↓
Looks up command in registry → "search:google"
         ↓
Executes command with params: ["AI", "research"]
         ↓
Search extension constructs URL:
  https://google.com/search?q=AI%20research
         ↓
Opens in new BrowserWindow or current window
```

### Data Flow: Search Suggestions

```
User types: /google artificial int
         ↓
Cmd panel debounces input (200ms)
         ↓
Publishes: cmd:request-suggestions
  { command: "google", query: "artificial int" }
         ↓
Search extension receives request
         ↓
Fetches from Google suggest API:
  https://google.com/complete/search?q=artificial%20int
         ↓
Parses JSON response: ["artificial intelligence", "artificial intelligence jobs", ...]
         ↓
Publishes: cmd:suggestions-response
  { suggestions: [...], command: "google" }
         ↓
Cmd panel displays in dropdown
         ↓
User selects → executes full search
```

### Data Flow: OpenSearch Discovery

```
User visits: https://en.wikipedia.org
         ↓
did-finish-load event fires
         ↓
Search content script executes
         ↓
Finds: <link rel="search" href="/opensearch.xml">
         ↓
Publishes: search:engine-discovered
  { url: "https://en.wikipedia.org/opensearch.xml" }
         ↓
Search background fetches XML
         ↓
Parses OpenSearchDescription
         ↓
Validates schema (ShortName, Url template)
         ↓
Publishes: search:install-prompt
  { engine: { name: "Wikipedia", ... } }
         ↓
Cmd bar shows indicator OR
Notification: "Install Wikipedia search? [Yes] [No]"
         ↓
User confirms → Saves to datastore
         ↓
Registers new cmd: /wikipedia
```

---

## 5. Command Bar Integration

### Per-Engine Commands

Each installed search engine gets its own cmd:

```javascript
// Example: /google query
api.commands.register({
  name: 'google',
  description: 'Search Google',
  execute: async (ctx) => {
    const query = ctx.params.join(' ') || ctx.search;
    const engine = await getEngine('google');
    const url = engine.searchUrl.replace('{searchTerms}', encodeURIComponent(query));

    await api.window.open(url, {
      type: 'normal',
      show: true
    });

    // Close cmd panel
    await api.window.close('peek://ext/cmd/panel.html');
  }
});
```

**Registration Pattern:**
- Background script loops through enabled engines
- Registers one command per engine with shortName as command name
- Updates registry when engines are added/removed/disabled

### Default Search Fallback

If cmd input doesn't match any command:

```javascript
// In cmd panel: handleUnmatchedInput()
async function handleUnmatchedInput(text) {
  // Check if it looks like a URL
  if (isURL(text)) {
    await api.window.open(text);
    return;
  }

  // Otherwise, use default search engine
  const defaultEngine = await getDefaultEngine();
  const url = defaultEngine.searchUrl.replace('{searchTerms}', encodeURIComponent(text));

  await api.window.open(url);
}
```

**When it triggers:**
- User types text that doesn't match any registered command
- User presses Enter without selecting a suggestion
- Smart heuristics: if it contains spaces or is >3 chars, assume search query

### Suggestions in Dropdown

**UI Pattern (following existing cmd panel):**
```
┌─────────────────────────────────────────┐
│ /google artificial intelligence         │ ← Input
├─────────────────────────────────────────┤
│ → artificial intelligence               │ ← Top suggestion (highlighted)
│   artificial intelligence jobs          │
│   artificial intelligence news          │
│   artificial intelligence course        │
│   artificial intelligence companies     │
├─────────────────────────────────────────┤
│ [Powered by Google]                     │ ← Attribution
└─────────────────────────────────────────┘
```

**Implementation:**
- Cmd panel subscribes to `search:suggestions` events
- Search extension debounces API calls (200ms after typing stops)
- Response rendered using peek-list component
- Arrow keys navigate, Enter selects
- Escape dismisses dropdown

**Keyboard Navigation:**
- `↓` / `j` - Next suggestion
- `↑` / `k` - Previous suggestion
- `Enter` - Select highlighted suggestion
- `Escape` - Clear suggestions
- `Tab` - Autocomplete first suggestion (inline)

---

## 6. Search Suggestions

### API Protocols

Search engines use different protocols. We support:

**1. OpenSearch Suggestions (JSON)**
```javascript
// Request
GET https://example.com/suggest?q=test

// Response
[
  "test",                           // Original query
  ["test query", "testing", ...],   // Suggestions
  ["Description 1", "Desc 2", ...], // Descriptions (optional)
  ["https://...", "https://..."]    // URLs (optional)
]
```

**2. Google-style JSON**
```javascript
// Response
{
  "suggestions": [
    { "value": "test query", "data": {...} },
    { "value": "testing", "data": {...} }
  ]
}
```

**Implementation:**
```javascript
// suggestion-provider.js
async function fetchSuggestions(engine, query) {
  if (!engine.suggestionUrl) return [];

  const url = engine.suggestionUrl.replace('{searchTerms}', encodeURIComponent(query));

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'default',
      signal: AbortSignal.timeout(2000) // 2s timeout
    });

    const data = await response.json();

    // Parse format (OpenSearch vs Google-style)
    if (Array.isArray(data) && data.length >= 2) {
      // OpenSearch format: ["query", ["suggestion1", "suggestion2"]]
      return data[1].slice(0, 8); // Max 8 suggestions
    } else if (data.suggestions) {
      // Google-style: { suggestions: [{value: "..."}] }
      return data.suggestions.map(s => s.value).slice(0, 8);
    }

    return [];
  } catch (err) {
    log.error('search:suggestions', 'Fetch failed:', err);
    return [];
  }
}
```

### Caching Strategy

**In-Memory Cache:**
```javascript
const suggestionCache = new Map();

function getCacheKey(engine, query) {
  return `${engine.id}:${query.toLowerCase().trim()}`;
}

async function fetchWithCache(engine, query) {
  const key = getCacheKey(engine, query);
  const cached = suggestionCache.get(key);

  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    // Cache hit, <5 min old
    return cached.suggestions;
  }

  const suggestions = await fetchSuggestions(engine, query);

  suggestionCache.set(key, {
    suggestions,
    timestamp: Date.now()
  });

  // Limit cache size (LRU)
  if (suggestionCache.size > 500) {
    const oldestKey = suggestionCache.keys().next().value;
    suggestionCache.delete(oldestKey);
  }

  return suggestions;
}
```

**Cache Invalidation:**
- Time-based: 5 minute TTL
- Size-based: Max 500 entries (LRU eviction)
- Manual: Clear on settings change (e.g., disable suggestions)

### Privacy Considerations

**Anonymous Requests:**
- No cookies sent with suggestion requests
- Referer header stripped
- User-Agent generic (Peek version only)
- No personal identifiers in query params

**Privacy Mode:**
- If user enables "Do Not Track" → disable all suggestions
- Setting: "Enable search suggestions" (default: on)
- Per-engine toggle: Some engines may have stricter privacy

**Data Retention:**
- Suggestions never written to disk
- Cache cleared on app quit
- No history of suggestion queries kept

**User Control:**
```javascript
// Settings options
{
  enableSuggestions: true,          // Global toggle
  suggestionEngines: {              // Per-engine overrides
    'google': true,
    'duckduckgo': false             // User disabled DDG suggestions
  }
}
```

---

## 7. Management UI (Settings)

### UI Layout

**Settings > Search** (using peek-components):

```html
<peek-card>
  <span slot="header">Default Search Engine</span>
  <peek-select id="defaultEngine">
    <option value="google">Google</option>
    <option value="duckduckgo">DuckDuckGo</option>
    <option value="wikipedia">Wikipedia</option>
  </peek-select>
</peek-card>

<peek-card>
  <span slot="header">Search Suggestions</span>
  <peek-switch id="enableSuggestions" checked>
    Enable search suggestions
  </peek-switch>
</peek-card>

<peek-card>
  <span slot="header">Installed Search Engines</span>

  <peek-list id="engineList">
    <!-- Dynamically populated -->
    <peek-list-item value="google">
      <img slot="prefix" src="favicon" alt="">
      Google
      <span slot="suffix">
        <peek-button size="sm" variant="ghost">Edit</peek-button>
        <peek-button size="sm" variant="danger">Remove</peek-button>
      </span>
    </peek-list-item>
  </peek-list>

  <div slot="footer">
    <peek-button variant="primary" onclick="addCustomEngine()">
      Add Custom Engine
    </peek-button>
  </div>
</peek-card>
```

### Engine List UI

**Columns:**
- Icon (16x16 favicon)
- Name
- Keyword (shortName for cmd)
- Default (radio button)
- Enabled (toggle switch)
- Actions (Edit, Remove buttons)

**Actions:**
- **Set Default** - Radio button, one selected at a time
- **Enable/Disable** - Toggle without removing
- **Edit** - Opens dialog to change keyword, URL template
- **Remove** - Confirmation dialog → deletes from datastore

### Add/Edit Custom Engine Dialog

```html
<peek-dialog id="engineDialog" size="md">
  <span slot="header">Add Custom Search Engine</span>

  <peek-input
    id="engineName"
    placeholder="Search engine name"
    required>
  </peek-input>

  <peek-input
    id="engineKeyword"
    placeholder="Keyword (e.g., 'gh' for GitHub)"
    pattern="[a-z0-9\-]+"
    required>
  </peek-input>

  <peek-input
    id="engineUrl"
    placeholder="https://example.com/search?q={searchTerms}"
    type="url"
    required>
  </peek-input>

  <peek-input
    id="suggestionUrl"
    placeholder="https://example.com/suggest?q={searchTerms} (optional)"
    type="url">
  </peek-input>

  <div slot="footer">
    <peek-button variant="ghost" onclick="engineDialog.close()">
      Cancel
    </peek-button>
    <peek-button variant="primary" onclick="saveEngine()">
      Add Engine
    </peek-button>
  </div>
</peek-dialog>
```

**Validation:**
- Name: Required, 1-50 chars
- Keyword: Required, lowercase alphanumeric + hyphens, unique
- URL: Required, valid URL with `{searchTerms}` placeholder
- Suggestion URL: Optional, valid URL with `{searchTerms}`

### Settings Storage

Use datastore `search_engines` table + extension_settings for prefs:

```javascript
// extension_settings row
{
  extensionId: 'search',
  key: 'preferences',
  value: JSON.stringify({
    defaultEngineId: 'google',
    enableSuggestions: true,
    suggestionEngines: { /* per-engine overrides */ }
  }),
  updatedAt: Date.now()
}
```

---

## 8. Component Usage (Peek Components)

### UI Components Needed

| Component | Usage | Features |
|-----------|-------|----------|
| `peek-card` | Grouping sections in Settings | Header, body, footer slots |
| `peek-select` | Default engine dropdown | Native select with styling |
| `peek-switch` | Enable/disable toggles | Checked state, change events |
| `peek-list` | Installed engines list | Keyboard navigation, selection |
| `peek-input` | Add/edit engine form | Validation, placeholders |
| `peek-button` | Actions (add, remove, edit) | Variants (primary, ghost, danger) |
| `peek-dialog` | Add/edit engine modal | Modal, close-on-escape |
| `peek-dropdown` | Cmd suggestion dropdown | Auto-positioning, keyboard nav |

### Integration Example

```javascript
// settings.js
import 'peek://app/components/index.js';
import { signal, effect } from 'peek://app/components/signals.js';

const engines = signal([]);
const defaultEngineId = signal('google');

// Load engines from datastore
async function loadEngines() {
  const result = await api.datastore.query('search_engines', {
    orderBy: 'name'
  });

  if (result.success) {
    engines.value = result.data;
  }
}

// Reactive UI updates
effect(() => {
  const list = document.getElementById('engineList');
  list.innerHTML = engines.value.map(engine => `
    <peek-list-item value="${engine.id}">
      <img slot="prefix" src="${engine.iconUrl}" width="16" height="16">
      ${engine.name}
      <span slot="suffix">${engine.shortName}</span>
    </peek-list-item>
  `).join('');
});

// Init
loadEngines();
```

---

## 9. Implementation Phases

### Phase 1: Core Infrastructure (2 weeks)

**Goal:** Basic search command system

- [ ] Create `features/search/` directory structure
- [ ] Define datastore schema for `search_engines` table
- [ ] Implement engine storage CRUD (add, remove, update, list)
- [ ] Seed built-in engines (Google, DuckDuckGo, Bing, Wikipedia)
- [ ] Register per-engine commands (`/google`, `/ddg`, etc.)
- [ ] Test basic search command execution

**Deliverables:**
- Extension scaffold with manifest.json
- Datastore schema migration
- Command registration working for built-in engines

### Phase 2: Settings UI (2 weeks)

**Goal:** User can manage engines

- [ ] Build Settings UI using peek-components (card, list, button)
- [ ] Default engine selection (radio buttons)
- [ ] Enable/disable toggle per engine
- [ ] Add custom engine dialog (form with validation)
- [ ] Edit engine (keyword, URL template)
- [ ] Remove engine (with confirmation)
- [ ] Persist changes to datastore

**Deliverables:**
- Functional Settings page at `peek://ext/search/settings.html`
- CRUD operations for engines
- Settings schema JSON for integration

### Phase 3: OpenSearch Discovery (1 week)

**Goal:** Auto-detect search engines from websites

- [ ] Content script to detect `<link rel="search">` tags
- [ ] Fetch and parse OpenSearch XML
- [ ] Validate XML schema (ShortName, Url required)
- [ ] Show install prompt (notification or cmd indicator)
- [ ] User confirms → add to datastore
- [ ] Test on popular sites (Wikipedia, GitHub, Stack Overflow)

**Deliverables:**
- content-discovery.js content script
- XML parser with validation
- Install prompt UI

### Phase 4: Search Suggestions (2 weeks)

**Goal:** Show suggestions as user types

- [ ] Implement suggestion-provider.js (fetch + parse)
- [ ] Support OpenSearch JSON and Google-style formats
- [ ] Debounce requests (200ms)
- [ ] In-memory cache with TTL (5 min)
- [ ] Integrate with cmd panel dropdown
- [ ] Keyboard navigation (arrow keys, Enter)
- [ ] Attribution footer ("Powered by X")

**Deliverables:**
- Suggestion API integration
- Cache implementation
- Cmd panel dropdown with suggestions

### Phase 5: Default Fallback & Polish (1 week)

**Goal:** Unmatched input triggers default search

- [ ] Cmd panel: detect unmatched input
- [ ] Heuristic: check if it's a URL vs search query
- [ ] Use default engine for non-URL input
- [ ] Privacy mode: disable suggestions when enabled
- [ ] Per-engine suggestion toggle
- [ ] Error handling (network failures, timeouts)
- [ ] Logging and telemetry

**Deliverables:**
- Default search fallback working
- Privacy controls functional
- Error states handled gracefully

### Phase 6: Testing & Documentation (1 week)

**Goal:** Production-ready

- [ ] Unit tests for engine CRUD
- [ ] Unit tests for suggestion parsing
- [ ] Integration tests: add engine, search, suggestions
- [ ] E2E tests: OpenSearch discovery flow
- [ ] Performance profiling (suggestion latency)
- [ ] User documentation (help text in Settings)
- [ ] Developer documentation (extension API)

**Deliverables:**
- Test suite with >80% coverage
- Documentation in README or help page

---

## 10. Open Questions & Decisions

### 1. Default Search for Unmatched Input

**Question:** Should the cmd bar automatically fall back to default search for unmatched input?

**Options:**
- A) **Always fallback** - Any unmatched text triggers default search
- B) **Smart detection** - Only fallback if text looks like a query (>3 chars, has spaces)
- C) **Explicit mode** - User must type `/search query` or set a "search mode"

**Recommendation:** Option B (smart detection) with setting to disable.

**Rationale:** Option A can be confusing if user typos a command. Option C requires extra keystrokes. Option B balances convenience and safety.

### 2. OpenSearch Auto-Install

**Question:** Should Peek automatically install discovered search engines, or prompt user?

**Options:**
- A) **Auto-install** - Silent installation on every site with OpenSearch
- B) **Prompt always** - Show notification/dialog for every discovery
- C) **Smart prompt** - Prompt first time per domain, remember user choice

**Recommendation:** Option C (smart prompt) with setting for auto-install.

**Rationale:** Option A creates clutter (too many engines). Option B is annoying for users who visit many sites. Option C learns user preference.

### 3. Suggestion Privacy Default

**Question:** Should search suggestions be enabled by default?

**Options:**
- A) **Enabled by default** - Opt-out in Settings
- B) **Disabled by default** - Opt-in in Settings
- C) **Prompt on first use** - Ask user's preference

**Recommendation:** Option A (enabled) with privacy disclosures.

**Rationale:** Most browsers enable suggestions by default. Users expect this feature. Privacy-conscious users can disable in Settings.

### 4. Per-Engine vs Global Suggestion Toggle

**Question:** Should suggestion toggle be global, or per-engine?

**Options:**
- A) **Global only** - One switch for all engines
- B) **Per-engine only** - Individual toggles
- C) **Both** - Global + per-engine overrides

**Recommendation:** Option C (both).

**Rationale:** Most users want global toggle. Power users may want to disable suggestions for specific engines (e.g., privacy-focused engines).

### 5. Keyword Conflicts

**Question:** What happens if two engines have the same keyword (e.g., both want "g")?

**Options:**
- A) **First wins** - First registered engine keeps keyword, second is rejected
- B) **User resolves** - Prompt user to change keyword during installation
- C) **Suffix collision** - Auto-append number (e.g., "g2")

**Recommendation:** Option B (user resolves).

**Rationale:** Option A silently fails. Option C creates confusing keywords. Option B gives user control.

### 6. Search Result Display

**Question:** Where should search results open?

**Options:**
- A) **New window** - Always open in new BrowserWindow
- B) **Current window** - Replace current page (if one exists)
- C) **User setting** - Configurable in Settings

**Recommendation:** Option C (user setting) with default to new window.

**Rationale:** Different users have different preferences. Option A is safest default (doesn't disrupt current context). Option C provides flexibility.

### 7. Suggestion API Rate Limiting

**Question:** How to handle search engines that rate-limit suggestions?

**Options:**
- A) **Ignore** - Let requests fail, show no suggestions
- B) **Retry** - Exponential backoff, retry after delay
- C) **Fallback** - Disable suggestions for that engine if rate-limited

**Recommendation:** Option C (fallback) with retry after cooldown.

**Rationale:** Option A provides poor UX. Option B can amplify rate-limiting. Option C gracefully degrades, re-enables after 5 minutes.

### 8. Sync Search Engines Across Devices

**Question:** Should custom engines sync via Peek's sync system?

**Options:**
- A) **Yes, sync everything** - Built-in + custom engines
- B) **Custom only** - Only user-added engines sync
- C) **No sync** - Engines are device-local

**Recommendation:** Option B (custom only).

**Rationale:** Built-in engines are already on all devices. Custom engines are user-specific and should sync. Avoids conflicts with default engine preferences.

---

## 11. Security & Privacy

### Security Considerations

**Injection Risks:**
- Search URLs constructed from user input
- Always use `encodeURIComponent()` for query params
- Validate URL templates on installation (must contain `{searchTerms}`)
- Never execute JavaScript in search URLs (no `javascript:` protocol)

**Content Script Permissions:**
- Discovery content script needs access to page HTML
- Runs in isolated context (no access to page JS)
- Only extracts `<link rel="search">` tags
- Fetches OpenSearch XML via background fetch (not from page)

**XML Parsing:**
- Use DOMParser (built-in) to parse OpenSearch XML
- Never use `eval()` or `Function()` on XML content
- Validate schema strictly (whitelist allowed elements)
- Reject XML with external entities (XXE protection)

### Privacy Protections

**Suggestion Requests:**
- Strip referer header
- No cookies sent
- Generic User-Agent (no personal identifiers)
- Timeout: 2 seconds (prevents fingerprinting via timing)

**Data Storage:**
- Suggestions cached in-memory only (never disk)
- Cache cleared on app quit
- No history of search queries stored
- User can disable suggestions globally

**Third-Party Disclosure:**
- Settings UI shows which engines provide suggestions
- Link to engine's privacy policy (if available)
- Warning: "Suggestions are provided by [Engine Name]. Your query is sent to their servers."

---

## 12. Performance Considerations

### Optimization Strategies

**Debouncing:**
- Wait 200ms after user stops typing before requesting suggestions
- Cancel in-flight requests if user types again
- Prevents excessive API calls

**Caching:**
- In-memory LRU cache (500 entries max)
- 5 minute TTL per entry
- Reduces redundant network requests
- Cache hit rate should be >40% for common queries

**Lazy Loading:**
- Suggestion provider only loads when needed (first suggestion request)
- Content discovery script only injected on navigation (not all frames)
- Background script defers engine loading until cmd bar opens

**Network Timeouts:**
- Suggestion requests: 2 second timeout
- OpenSearch XML fetch: 5 second timeout
- Prevent hanging UI on slow networks

### Metrics to Track

- Suggestion API latency (p50, p95, p99)
- Cache hit rate
- Number of engines installed (avg, max)
- Cmd execution time (p50, p95)
- OpenSearch discovery success rate

---

## 13. Alternative Approaches Considered

### Approach 1: Browser-Native Search API

**Idea:** Use browser's built-in search engine list via WebExtension APIs

**Pros:**
- No need to reimplement OpenSearch parsing
- Leverages browser's existing engine list
- Automatic updates for built-in engines

**Cons:**
- Not available in Electron (no chrome.search.get() equivalent)
- Limited customization (can't modify engine list)
- Inconsistent across backends (Tauri, mobile)

**Decision:** Rejected - Not portable across backends

### Approach 2: Third-Party Search API Aggregator

**Idea:** Use service like Algolia or Elasticsearch to aggregate searches

**Pros:**
- Unified API for multiple sources
- Advanced features (faceting, typo tolerance)
- Managed infrastructure (no rate limiting concerns)

**Cons:**
- Cost (per-query pricing)
- Privacy implications (third-party data sharing)
- Vendor lock-in
- Latency (extra hop)

**Decision:** Rejected - Violates privacy principles, not necessary for basic search

### Approach 3: DuckDuckGo !bang Syntax

**Idea:** Use DuckDuckGo's !bang shortcuts (e.g., "!g query" searches Google)

**Pros:**
- Already familiar to power users
- No need to manage engine list (DuckDuckGo handles it)
- Simple implementation (just redirect to DDG)

**Cons:**
- Requires internet connection (DDG redirects)
- Extra network hop (latency)
- No control over engine list or settings
- No suggestions without DDG integration

**Decision:** Considered as fallback option, but full implementation preferred for user control

---

## 14. Future Enhancements (Beyond MVP)

### Post-MVP Ideas

1. **Search History & Suggestions**
   - Track recent searches per engine
   - Show recent queries in dropdown
   - Suggest previously searched terms
   - Privacy: opt-in, clear on logout

2. **Search Scope Modifiers**
   - `/google site:github.com query` - Search within specific site
   - `/google filetype:pdf query` - Filter by file type
   - Parse and apply modifiers to search URL

3. **Multi-Engine Meta-Search**
   - `/search query` - Search multiple engines simultaneously
   - Aggregate results in unified UI
   - User can select which engines to include

4. **AI-Powered Query Refinement**
   - Suggest better search queries based on context
   - "Did you mean...?" for typos
   - Related searches from LLM

5. **Search Templates & Macros**
   - User-defined search shortcuts
   - Example: `/bug <number>` → GitHub issue search
   - Parameterized queries with placeholders

6. **Search Results Preview**
   - Show preview of top result in cmd dropdown
   - Fetch via search engine's API (if available)
   - Quick answer snippets (Wikipedia)

7. **Voice Search Integration**
   - Hotkey to activate voice input
   - Speech-to-text → search query
   - Hands-free search

8. **Contextual Search**
   - Right-click selected text → "Search for [text]"
   - Auto-select search engine based on content type
   - Example: Code snippet → Stack Overflow, term → Wikipedia

9. **Search Analytics Dashboard**
   - Show user's search patterns
   - Most-used engines
   - Query frequency over time
   - Privacy: local-only, no cloud sync

10. **Custom Search Providers via Extensions**
    - API for other extensions to register search providers
    - Example: "Search my notes" extension
    - Unified search across all data sources

---

## 15. Sources & References

### OpenSearch & Standards
- [OpenSearch description format - XML | MDN](https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch)
- [opensearch/opensearch-1-1-draft-6.md at master · dewitt/opensearch](https://github.com/dewitt/opensearch/blob/master/opensearch-1-1-draft-6.md)
- [OpenSearch - IndieWeb](https://indieweb.org/OpenSearch)
- [OpenSearch (specification) - Wikipedia](https://en.wikipedia.org/wiki/OpenSearch_(specification))

### Browser Implementation Patterns
- [How Chrome Detects OpenSearch Description Documents](https://prosperasoft.com/blog/enterprise-search/opensearch/opensearch-chrome-discovery/)
- [Search Engines — Firefox Source Docs documentation](https://firefox-source-docs.mozilla.org/toolkit/search/SearchEngines.html)
- [Integrate your website as a search provider in Microsoft Edge](https://www.ctrl.blog/entry/edge-search-provider.html)

### Browser APIs
- [search - Mozilla | MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search)
- [chrome.search | API | Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/search)
- [Search Service:API - MozillaWiki](https://wiki.mozilla.org/Search_Service:API)

### Privacy & Search APIs
- [Brave Search API | Brave](https://brave.com/search/api/)
- [Browser Privacy Policy | Brave](https://brave.com/privacy/browser/)

### Related Peek Documentation
- `notes/research-ui-componentry.md` - Peek component system
- `notes/extensibility.md` - Extension architecture
- `features/cmd/` - Command palette implementation
- `app/components/README.md` - Component library docs

---

## Critical Files for Implementation

Based on this research, here are the most critical files for implementing the search extension:

1. **`features/search/background.js`** - Main extension logic, engine registry, command registration, OpenSearch discovery orchestration
2. **`features/search/suggestion-provider.js`** - Handles API calls to search engines, caching, parsing responses, privacy controls
3. **`features/search/settings.js`** - Management UI logic using peek-components, CRUD operations for engines
4. **`features/cmd/panel.js`** (existing) - Integration point for search suggestions dropdown, fallback handler for unmatched input
5. **`app/datastore/schema.js`** (existing) - Add `search_engines` table schema, migration for built-in engines

---

## Summary

This search extension brings modern browser search capabilities to Peek through:

1. **OpenSearch Discovery** - Auto-detect and install search engines from websites
2. **Command Integration** - Each engine gets a cmd (`/google`, `/ddg`) with suggestions
3. **Management UI** - Full settings interface using peek-components
4. **Smart Fallback** - Unmatched cmd input triggers default search
5. **Privacy-First** - Anonymous suggestions, in-memory cache, user controls

The implementation follows Peek's extension architecture, leverages the existing cmd system, and uses the peek-components library for consistent UI. Estimated 8-9 weeks for full MVP across 6 phases.
