# Command Suggestions: Integrated Search-and-Act Flow for Cmd

**Status:** Research complete, ready for implementation
**Last Updated:** 2026-02-10
**Purpose:** Design a generic command + search matcher pattern for the cmd bar, enabling flows like `edit vampire` -> pick item from search results -> act on it

---

## 1. Problem Statement

Users want to type a command with a search term (e.g., `edit vampire`) and see matching items appear in the dropdown as they type. Currently, the `edit` command runs its search only on Enter, then dumps all results into output selection mode. The flow is:

1. Type `edit vampire`, press Enter
2. Command executes, fetches all matching notes
3. Panel enters output selection mode with results
4. User picks one, panel routes to editor

The desired flow is:

1. Type `edit vampire`
2. **As the user types**, matching items stream into the dropdown below the input
3. Arrow down to browse results
4. Press Enter on a result to open it

This should not be specific to `edit` or notes. It should be a generic pattern that any command can opt into: `tag <search>`, `open <search>`, `delete <search>`, `group add <search>`.

---

## 2. Current Cmd Architecture Analysis

### 2.1 File Layout

| File | Role |
|------|------|
| `features/cmd/background.js` | Command registry (provider pattern), shortcut handling, caching |
| `features/cmd/panel.js` | Panel UI, input handling, matching, execution, chain mode |
| `features/cmd/panel.html` | Panel layout and CSS |
| `features/cmd/commands.js` | Command loader, proxy command creation for cross-extension dispatch |
| `features/cmd/commands/index.js` | Aggregates built-in commands (edit, note, url, history, lists) |
| `features/cmd/commands/edit.js` | Edit command -- search notes, return items |
| `features/cmd/commands/note.js` | Note command -- save items |
| `features/cmd/config.js` | Extension ID, defaults, schemas |

### 2.2 Command Registration Flow

Two paths for registering commands:

**Path A -- Built-in commands** (same process as panel):
- `commands/index.js` exports an array of command objects
- `commands.js` loads them and dispatches `cmd-update-commands` event
- `panel.js` receives event, stores commands in `state.commands`
- Execute is called directly (same JS context)

**Path B -- Extension commands** (cross-process via pubsub):
- Extension calls `api.commands.register({ name, description, execute })`
- Preload batches and publishes `cmd:register-batch` via IPC
- `background.js` stores metadata in `commandRegistry` Map
- When panel opens, it publishes `cmd:query-commands`
- Background responds with `cmd:query-commands-response`
- `commands.js` creates proxy commands that dispatch via `cmd:execute:{name}` pubsub
- Results come back via `cmd:execute:{name}:result`

### 2.3 Current Matching Flow

In `panel.js`, when the user types:

1. `input` event fires, `state.typed` is updated
2. `findMatchingCommands(typed)` is called -- this matches **command names only**
3. Matches are sorted by exact match priority, then adaptive score, then frecency
4. `updateCommandUI()` renders inline completion hint
5. `updateResultsUI()` renders dropdown (only if `state.showResults` is true, toggled by ArrowDown)
6. On Enter, the selected command is executed with a `context` object containing `{ typed, name, params, search }`

### 2.4 Current Output Selection Mode

After a command returns `{ output: { data: [...], mimeType: 'item' } }`:

1. Panel enters `outputSelectionMode`
2. Items are rendered in the results dropdown
3. Arrow keys navigate, Enter/ArrowRight selects
4. For `mimeType: 'item'`, selection publishes `editor:open` with `itemId`
5. For other mimeTypes, selection enters chain mode

### 2.5 Execution Context

Commands receive:
```javascript
{
  typed: 'edit vampire',   // Full typed string
  name: 'edit',            // Command name
  params: ['vampire'],     // Array of params after command name
  search: 'vampire',       // Text after command name (joined)
  // Chain mode fields omitted for brevity
}
```

### 2.6 Key Observation: The Gap

The current architecture has a hard boundary between **command matching** (which operates on command names) and **item searching** (which happens inside command execution). There is no mechanism for a command to provide search suggestions back to the panel in real-time as the user types. The edit command's `searchNotes()` only runs on Enter.

---

## 3. Existing Search Infrastructure

### 3.1 Datastore Query API

The backend provides SQL-based search:

```javascript
// Basic query with type filter
api.datastore.queryItems({ type: 'text' })

// Query with search (LIKE %term% on content, title, domain)
api.datastore.queryItems({ type: 'url', search: 'github' })

// Frecency-ranked URL search
api.datastore.queryItemsByFrecency({ search: 'github', limit: 10 })
```

The `search` parameter in `queryItems` does a SQL `LIKE %term%` match against `content`, `title`, and `domain` columns. This is a basic substring search -- no fuzzy matching, no ranking beyond frecency.

### 3.2 Current Search Usage in Commands

- **`edit.js`**: Calls `queryItems({ type: 'text' })` then filters client-side with `content.toLowerCase().includes(query)`
- **`history.js`**: Calls `queryItems({ type: 'url' })` then filters client-side on URL and metadata title
- **`note.js`**: Calls `queryItems({ type: 'text' })` with `getItemTags()` per item (N+1 query pattern)
- **`tags/background.js`**: Uses `getTagsByFrecency()` for tag search

None use the built-in `search` parameter on `queryItems` -- they all fetch everything then filter client-side. This is an opportunity for optimization.

### 3.3 History Command: Dynamic Commands Pattern

The history module has a notable pattern: it registers **each URL as a separate command**. This makes URLs searchable by the command matcher, but does not scale and conflates items with commands.

---

## 4. Design Decision: Streaming Suggestions vs Top-Level Filter

### Option A: Extensions Stream Suggestions

Each extension publishes matching items for a query via pubsub. Cmd stitches results together from all responders.

**Flow:**
1. User types `edit vam`
2. Panel detects `edit` is a known command, extracts query `vam`
3. Panel publishes `cmd:suggest:edit` with `{ query: 'vam' }`
4. Edit command's extension responds with `cmd:suggest:edit:response` containing matching items
5. Panel merges responses from all extensions and renders dropdown

**Pros:**
- Fully decoupled -- any extension can provide suggestions for any command
- Multiple extensions can respond to the same query
- Works across process boundaries (pubsub is already cross-process)

**Cons:**
- Complex coordination (multiple async responders, merging, deduplication)
- Race conditions between slow and fast responders
- UI jank from incremental rendering as responses arrive
- Pubsub round-trips add latency (~5-20ms each in Electron IPC)
- Overkill for the common case (one command, one data source)

### Option B: Command-Level Suggestion Provider

Commands opt into providing suggestions via a `suggest(query)` function declared alongside `execute()`. The panel calls it directly (for built-in commands) or via a targeted pubsub call (for extension commands).

**Flow:**
1. User types `edit vam`
2. Panel detects `edit` is a known command with `suggest` capability
3. Panel calls `command.suggest('vam')` (or publishes targeted request)
4. Command returns an array of suggestion items
5. Panel renders them in the dropdown

**Pros:**
- Simple protocol: one command, one response
- No coordination complexity
- Direct function call for built-in commands (zero latency)
- Easy to reason about per-command behavior
- Natural extension of existing command object shape

**Cons:**
- Only the owning command provides suggestions (by design -- this is actually a feature)
- Extension commands need a pubsub round-trip (but only one, with a single responder)

### Recommendation: Option B (Command-Level Suggestion Provider)

Option B is the clear winner. It adds a single optional method to the command protocol, keeps the panel logic simple, and maps directly to the user's mental model: "I'm running the `edit` command, show me what `edit` can find."

The multi-extension streaming model (Option A) would only matter if we wanted `edit vampire` to simultaneously search notes, URLs, AND tags. That is a different feature (unified search / omnibox), and should be built as its own command (e.g., `find`) rather than complicating every command's suggestion path.

---

## 5. Suggestion Protocol Design

### 5.1 Command Object Extension

Add an optional `suggest` method to the command interface:

```javascript
{
  name: 'edit',
  description: 'Edit a note',
  produces: ['item'],

  // NEW: Optional suggestion provider
  // Called as user types after the command name
  // Returns array of suggestion items for the dropdown
  suggest: async (query, options) => {
    // query: string -- the text after the command name
    // options: { limit: 10 } -- hints from the panel
    // Returns: Array of { id, title, subtitle, icon?, data? }
    return [
      { id: 'abc-123', title: 'Vampire Notes', subtitle: 'text -- 2 hours ago', data: { itemId: 'abc-123' } },
      { id: 'def-456', title: 'Vampire Weekend Review', subtitle: 'url -- yesterday' }
    ];
  },

  // Existing execute method
  execute: async (ctx) => { ... }
}
```

### 5.2 Suggestion Item Shape

```javascript
{
  id: string,          // Unique identifier (for dedup and selection tracking)
  title: string,       // Primary display text (required)
  subtitle: string,    // Secondary text (type, date, tags, etc.)
  icon: string,        // Optional icon identifier or emoji
  data: object,        // Opaque payload passed to execute() on selection
  // The panel does NOT interpret `data` -- it passes it through
}
```

### 5.3 Panel Behavior When Suggestions Are Available

The panel needs to change its behavior when a typed command has a `suggest` method:

**Current flow:** Type command -> ArrowDown shows command list -> Enter executes

**New flow:** Type command + space + query -> suggestions appear automatically -> ArrowDown/Enter to pick

Specifically:

1. User types `edit ` (command name + space)
2. Panel recognizes `edit` as matched command
3. Panel detects `edit` has `suggest` method
4. Panel enters **suggestion mode** for this command
5. As user continues typing (`edit vam`), panel calls `suggest('vam')` with debounce
6. Results render in the dropdown (replacing command matches)
7. ArrowDown/Up navigate suggestions
8. Enter on a suggestion calls `execute()` with the suggestion's `data` in context
9. Escape exits suggestion mode (back to command matching)
10. Clearing back past the space exits suggestion mode

### 5.4 Execution Context with Suggestion Selection

When a user selects a suggestion, the execute context gets an extra field:

```javascript
{
  typed: 'edit vampire',
  name: 'edit',
  params: ['vampire'],
  search: 'vampire',

  // NEW: populated when user selected a suggestion
  selectedSuggestion: {
    id: 'abc-123',
    title: 'Vampire Notes',
    data: { itemId: 'abc-123' }
  }
}
```

The command's `execute()` can check for `ctx.selectedSuggestion` and skip its own search, directly acting on the selected item:

```javascript
execute: async (ctx) => {
  // Fast path: user already picked a specific item
  if (ctx.selectedSuggestion?.data?.itemId) {
    return {
      output: {
        data: { id: ctx.selectedSuggestion.data.itemId },
        mimeType: 'item'
      }
    };
  }

  // Slow path: execute search (for Enter without selecting)
  const notes = await searchNotes(ctx.search);
  // ... existing logic
}
```

### 5.5 Cross-Process Suggestion Protocol (Extension Commands)

For commands registered by other extensions (which execute via pubsub proxy):

1. Panel publishes `cmd:suggest:{commandName}` with `{ query, limit }`
2. Extension's preload handler calls the local `suggest()` function
3. Result published back via `cmd:suggest:{commandName}:result`
4. Panel renders suggestions

This requires extending `preload.js` to store `suggest` handlers alongside `execute` handlers, and creating the pubsub wiring similar to how `cmd:execute:{name}` works today.

### 5.6 Debouncing and Cancellation

- **Debounce:** 150ms after typing stops (fast enough to feel instant, slow enough to avoid thrashing)
- **Cancellation:** If user types more before suggestions return, discard stale results (use a generation counter or AbortController)
- **Minimum query length:** 1 character (commands can enforce their own minimum internally)
- **Maximum results:** Panel requests `limit: 10` by default, commands can return fewer

---

## 6. UI Flow Mockup

### 6.1 Initial State -- Command Matching (unchanged)

```
┌──────────────────────────────────────┐
│  edi                                 │  <- User types "edi"
│  edit (grey completion)              │  <- Inline suggestion
└──────────────────────────────────────┘
```

User presses ArrowDown to see commands:

```
┌──────────────────────────────────────┐
│  edi                                 │
├──────────────────────────────────────┤
│ ▸ edit         Edit a note      → item│
│   open editor  Open markdown editor  │
└──────────────────────────────────────┘
```

### 6.2 Entering Suggestion Mode

User presses Tab (autocompletes to `edit `) or types `edit `:

```
┌──────────────────────────────────────┐
│  edit                                │  <- Command matched, space typed
├──────────────────────────────────────┤
│   (type to search...)               │  <- Placeholder prompt
└──────────────────────────────────────┘
```

User types `vam`:

```
┌──────────────────────────────────────┐
│  edit vam                            │
├──────────────────────────────────────┤
│ ▸ Vampire Notes           text  2h ago│
│   Vampire Weekend Review   url  1d ago│
│   Interview with a Vampire text  3d ago│
└──────────────────────────────────────┘
```

### 6.3 Selection and Action

User arrows down to "Vampire Weekend Review" and presses Enter:

```
┌──────────────────────────────────────┐
│  edit vam                            │
├──────────────────────────────────────┤
│   Vampire Notes           text  2h ago│
│ ▸ Vampire Weekend Review   url  1d ago│  <- Selected
│   Interview with a Vampire text  3d ago│
└──────────────────────────────────────┘
```

Panel calls `edit.execute()` with `selectedSuggestion` -> routes to editor -> panel closes.

### 6.4 Enter Without Selection

If user presses Enter without arrowing down (no suggestion selected), the command executes with `ctx.search = 'vam'` and no `selectedSuggestion`. The command does its own search and returns results via the existing output selection mode.

This preserves backward compatibility -- suggestions are an acceleration, not a requirement.

### 6.5 Empty Query (No Search Term)

Some commands could provide "recent items" when the query is empty:

```
┌──────────────────────────────────────┐
│  edit                                │
├──────────────────────────────────────┤
│ ▸ Meeting Notes            text  1h ago│  <- Recent items
│   Shopping List             text  3h ago│
│   Project Ideas             text  1d ago│
└──────────────────────────────────────┘
```

This is opt-in per command. `suggest('')` with empty string means "show recents."

---

## 7. Commands That Would Benefit

| Command | Suggest Source | Action on Selection |
|---------|---------------|-------------------|
| `edit <query>` | `queryItems({ type: 'text', search })` | Open item in editor |
| `open <query>` | `queryItemsByFrecency({ search })` | Open URL in window |
| `tag <query>` | `getTagsByFrecency()` + filter | Apply tag to active window |
| `delete <query>` | `queryItems({ search })` | Soft-delete item |
| `open group <query>` | Groups list | Open group's URLs |
| `history <query>` | `queryItemsByFrecency({ search })` | Open URL from history |
| `note <query>` | `queryItems({ type: 'text', search })` | Open existing note in editor |

The history command currently registers every URL as a separate command. With the suggestion protocol, it could be a single `history` command with `suggest()` that searches URLs -- much cleaner and more scalable.

---

## 8. Implementation Phases

### Phase 1: Core Suggestion Infrastructure (panel.js)

**Goal:** Panel can call `suggest()` on built-in commands and render results in the dropdown.

**Changes to `features/cmd/panel.js`:**
- Add `suggestionMode` state: `{ active, commandName, query, results, selectedIndex, generation }`
- In `input` event handler: detect when typed text matches a command + has a space + command has `suggest`
- Call `command.suggest(query)` with debounce (150ms)
- Render suggestion items in `#results` instead of command matches
- Handle ArrowUp/Down for suggestion navigation
- On Enter with selection: build context with `selectedSuggestion`, call execute
- On Enter without selection: existing behavior (execute with `search`)
- On Escape: exit suggestion mode
- On Backspace past space: exit suggestion mode

**Changes to `features/cmd/panel.html`:**
- Add CSS for suggestion items (title + subtitle layout, type badge, timestamp)

**Estimated effort:** 1-2 days

### Phase 2: Migrate `edit` Command

**Goal:** `edit` command has a working `suggest()` method.

**Changes to `features/cmd/commands/edit.js`:**
- Add `suggest(query)` method that calls `queryItems({ type: 'text', search: query })` (use server-side search instead of client-side filter)
- Return formatted suggestion items: `{ id, title: firstLine, subtitle: 'text -- relative time' }`
- Modify `execute()` to check `ctx.selectedSuggestion` for fast-path routing

**Estimated effort:** Half a day

### Phase 3: Cross-Process Suggestion Protocol (preload + background)

**Goal:** Extension commands (registered via `api.commands.register`) can provide suggestions.

**Changes to `preload.js`:**
- Accept optional `suggest` in command registration
- Store suggest handler alongside execute handler in `window._cmdHandlers`
- Subscribe to `cmd:suggest:{name}` topic
- On receive: call local suggest handler, publish result to `cmd:suggest:{name}:result`

**Changes to `features/cmd/commands.js`:**
- When creating proxy commands, check if source extension declared `suggest` capability
- Add `suggest()` method on proxy that publishes `cmd:suggest:{name}` and awaits response

**Changes to `features/cmd/background.js`:**
- Store `hasSuggest` flag in command registry metadata
- Include in `cmd:query-commands-response`

**Estimated effort:** 1 day

### Phase 4: Migrate More Commands

**Goal:** `history`, `open group`, `tag` commands gain `suggest()` methods.

- **`history`**: Replace dynamic command registration with a single `suggest()` that calls `queryItemsByFrecency({ search })`
- **`open group`**: `suggest()` searches group names via `getTagsByFrecency()`
- **`tag`**: `suggest()` searches tag names for autocomplete

**Estimated effort:** 1 day

### Phase 5: Polish and UX

- Loading indicator while suggestions are fetching (subtle spinner after 200ms)
- "No results" message when search returns empty
- Keyboard hint in placeholder: "Type to search, Arrow to browse"
- Suggestion result count indicator
- Adaptive ranking: boost suggestions the user previously selected for a given query (reuse existing adaptive feedback mechanism)

**Estimated effort:** 1 day

---

## 9. Key Files That Need Changes

| File | Change Type | Description |
|------|------------|-------------|
| `features/cmd/panel.js` | Major | Add suggestion mode state machine, debounced suggest calls, suggestion rendering, keyboard navigation within suggestions |
| `features/cmd/panel.html` | Minor | CSS for suggestion item layout (title/subtitle/badge/time) |
| `features/cmd/commands.js` | Moderate | Proxy command `suggest()` via pubsub for extension commands |
| `features/cmd/commands/edit.js` | Moderate | Add `suggest()` method, update `execute()` with selectedSuggestion fast-path |
| `features/cmd/commands/history.js` | Moderate | Add `suggest()` method, potentially remove dynamic command registration |
| `features/cmd/background.js` | Minor | Track `hasSuggest` in registry metadata |
| `preload.js` | Moderate | Accept and wire `suggest` handler in command registration, pubsub plumbing |
| `features/tags/background.js` | Minor | Add `suggest()` to tag command |
| `features/groups/background.js` | Minor | Add `suggest()` to open group command |

---

## 10. State Machine: Suggestion Mode in panel.js

The panel currently has these modes:
- **Normal mode:** typing matches commands
- **Output selection mode:** navigating array results from command execution
- **Chain mode:** selecting next command after receiving typed output

The new **suggestion mode** fits between normal mode and output selection mode:

```
Normal Mode
    │
    ├─ (type command + space, command has suggest)
    ▼
Suggestion Mode ──── (Escape / Backspace past space) ──── Normal Mode
    │
    ├─ (Enter with selection)  → execute(ctx + selectedSuggestion) → close/chain
    ├─ (Enter without selection) → execute(ctx) → may enter Output Selection Mode
    │
    ▼
Output Selection Mode  (if command returns array)
    │
    ├─ (select item)
    ▼
Chain Mode  (if item has chainable mimeType)
    or
Close Panel  (if mimeType is 'item' → editor routing)
```

### Suggestion Mode State

```javascript
// Add to state object in panel.js
suggestionMode: false,         // Whether we're in suggestion mode
suggestionCommand: null,       // The command providing suggestions
suggestionQuery: '',           // Current query text
suggestionResults: [],         // Array of suggestion items
suggestionIndex: -1,           // Selected index (-1 = none)
suggestionGeneration: 0,       // Counter to discard stale results
suggestionTimer: null,         // Debounce timer
```

### Entry/Exit Conditions

**Enter suggestion mode when:**
1. Typed text matches exactly one command (or the top match)
2. There is a space after the command name
3. The matched command has a `suggest` method

**Exit suggestion mode when:**
1. User presses Escape
2. User deletes back past the space (no longer has command + space pattern)
3. User clears input entirely
4. A suggestion is selected and executed (mode exits naturally)

---

## 11. Alternative Considered: Unified Omnibox

An alternative to per-command suggestions is a unified "search everything" omnibox where typing any text simultaneously searches commands, items, URLs, tags, and groups:

```
┌──────────────────────────────────────┐
│  vampire                             │
├──────────────────────────────────────┤
│  Commands                            │
│   edit         Edit a note           │
│  Notes                               │
│ ▸ Vampire Notes             2h ago   │
│   Interview with a Vampire  3d ago   │
│  URLs                                │
│   vampirefreaks.com         1w ago   │
│  Tags                                │
│   #vampire                           │
└──────────────────────────────────────┘
```

This is a compelling UX but is architecturally different from the command suggestion pattern. It would require:
- A central search coordinator that queries all data sources
- Category grouping in the dropdown
- Disambiguation of what "Enter" does on different result types
- Priority ranking across heterogeneous result types

**Recommendation:** Build command suggestions (this doc) first. The omnibox can be built later as a special `find` command that uses the same `suggest()` protocol, aggregating suggestions from multiple sources.

---

## 12. Performance Considerations

### Query Optimization

The current `edit.js` fetches ALL text items then filters client-side. With the `suggest()` protocol, we should:

1. **Use server-side search:** `queryItems({ type: 'text', search: query })` instead of fetching all + filtering
2. **Limit results:** Always pass `limit: 10` to avoid transferring large result sets
3. **Index content column:** Consider adding SQLite FTS5 index for full-text search (future enhancement)

### Latency Budget

Target: suggestions visible within 100ms of typing pause.

- Debounce wait: 150ms
- IPC round-trip (built-in command): ~0ms (same process)
- IPC round-trip (extension command): ~10-20ms (pubsub via main process)
- SQLite query: ~1-5ms for LIKE search on <10K items
- **Total (built-in):** ~155ms -- meets target
- **Total (extension):** ~175ms -- meets target

For larger datasets (>10K items), FTS5 indexing would keep query time <5ms.

### Caching

Suggestions are ephemeral and short-lived. No persistent caching needed. In-memory cache with 5s TTL could help if user is rapidly editing the same query (backspace + retype), but this is premature optimization.

---

## 13. Relationship to Existing Research

### Search Extension (notes/research-search-extension.md)

The search extension research designs web search suggestions (Google, DuckDuckGo, etc.) in the cmd bar. The suggestion protocol designed here is complementary:

- Search extension commands (`google`, `ddg`) would use `suggest()` to fetch web search suggestions from engine APIs
- The same dropdown rendering, debounce, and selection logic applies
- The search extension is a **consumer** of the suggestion protocol, not the foundation of it

### Entity Recognition (notes/research-entity-recognition.md)

Entity recognition could enrich suggestion results with extracted metadata (people, places, dates). But it is orthogonal to the suggestion protocol itself.

---

## 14. Summary

### What to build

A `suggest(query)` optional method on commands, called by the panel as the user types after a command name, with results rendered in the dropdown for immediate selection.

### Why this approach

- Minimal protocol addition (one optional method)
- Zero breaking changes (commands without `suggest` work exactly as before)
- Natural extension of existing command shape
- Works for both built-in and extension commands
- Provides the desired `edit vampire` flow as the first use case
- Generalizes cleanly to `open`, `tag`, `delete`, `history`, `group` commands
- Leaves room for a unified omnibox as a future `find` command

### Key architectural decisions

1. **Command-level, not global:** Each command owns its suggestions. No central search coordinator.
2. **Optional opt-in:** Commands without `suggest()` are unaffected.
3. **Selection passthrough:** Selected suggestion's `data` is passed to `execute()` via `ctx.selectedSuggestion`, enabling fast-path execution.
4. **Enter without selection still works:** Falls back to existing execute-then-select flow.
5. **Debounced, not streamed:** Panel calls `suggest()` after 150ms typing pause, not on every keystroke.
