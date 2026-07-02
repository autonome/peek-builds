# Peek Development Guide

## Project Overview

Peek is a web user agent application that provides alternative ways to interact with web pages through keyboard shortcuts, modal windows, and background scripts. It's designed as a concept preview exploring task-aligned interfaces for the web, moving beyond traditional tabbed browsers.

**Multi-Backend Architecture**: Peek supports multiple backends (Electron, Tauri) that can coexist and sync data. The `app/` directory is **backend-agnostic** and must not contain backend-specific code. Backend-specific code lives in `backend/{electron,tauri}/`.

**Remotes:**
- Tangled: `git@tangled.sh:burrito.space/peek` (primary)
- GitHub: `git@github.com:autonome/peek` (Railway deploy only — not for general use)

**Documentation:**
- [docs/architecture.md](docs/architecture.md) — tile model, state machines, comparison to webtil.es / DASL Tiles spec. **Start here if you're new.**
- [docs/api.md](docs/api.md) — API reference (legacy `window.app` surface)
- [docs/tile-api.md](docs/tile-api.md) — current tile preload surface (`window.app`)
- [docs/mobile.md](docs/mobile.md) — iOS/Android
- [docs/sync.md](docs/sync.md) — sync architecture

## Requirements

- **Node.js 24+** - Required for both desktop (Electron 40) and server
- Install via `nvm install 24` or download from nodejs.org

## Key Commands

### Development
```bash
nvm use 24                # Ensure Node 24 is active
yarn install              # Install dependencies
yarn debug                # Run in development mode (with devtools)
yarn start                # Start normally
yarn package              # Package (output: out/mac-arm64/)
yarn package:install      # Package and install to /Applications (macOS)
yarn make                 # Build distributable packages
yarn npm audit            # Check for security vulnerabilities

# Tauri backend
yarn tauri:dev            # Run Tauri in development
yarn tauri:build          # Build Tauri for production
yarn tauri:check          # Check Tauri compiles
yarn tauri:test           # Run Tauri smoke tests (Rust)

# Tauri Mobile (iOS/Android)
yarn tauri:ios:dev        # Run on iOS simulator
yarn tauri:ios:build      # Build for iOS
yarn tauri:ios:xcode      # Open Xcode project
yarn tauri:android:dev    # Run on Android emulator

# Server (webhook API for mobile sync)
yarn server:install       # Install server dependencies
yarn server:start         # Run production server
yarn server:dev           # Run with hot reload
yarn server:test          # Run server tests
yarn server:healthcheck   # Verify server starts
```

### Testing
```bash
yarn test:desktop:electron   # Full desktop (electron) suite — all 6 runners (~3300+), canonical
yarn test:desktop:tauri      # Full Tauri desktop suite (off critical path)
yarn test:visible            # Run with visible windows
yarn test:grep "pattern"     # Run specific test by name (fast, source-only)
```

**Testing Policy**: When fixing bugs or adding features, always add tests to cover the change. Tests live in `tests/desktop/smoke.spec.ts`.

## Architecture Overview

For the full picture (tile model, three runtime state machines, comparison to
the webtil.es / DASL Tiles spec) read [docs/architecture.md](docs/architecture.md).
The summary below is just enough to orient you.

### Core Structure

1. **Main Process** (`backend/electron/main.ts` and friends):
   - Manages app lifecycle, windows, shortcuts, IPC communication
   - Implements custom `peek://` protocol for internal navigation
   - Handles profile management and SQLite datastore
   - Owns the **tile lifecycle FSM** (`tile-lifecycle.ts`) and the
     **`tile:*` IPC chokepoint** (`tile-ipc-gate.ts`) — every tile renderer
     talks to the main process exclusively through capability-token-gated
     `tile:*` channels

2. **Core renderer** (`app/`) — backend-agnostic, runs identically under
   any backend:
   - **bgWindow** = `peek://app/background.html` → `app/index.js` is the core
     orchestrator. Initialises cmd registry, page canvas, and HUD via
     `initCmd()` / `initPage()` / `initHud()`. Always loaded at startup.
     Carries a `trustedBuiltin` capability grant — same tile mechanics as
     any feature tile, but capability checks short-circuit.
   - **cmd panel** (`app/cmd/`) — interactive command bar; pure state
     machine in `app/cmd/state-machine.js`
   - **page canvas** (`app/page/`) — shared chrome overlay for hybrid
     page-host content windows (canvas removed 2026-07 — see "Page View
     Canvas Architecture" below)
   - **HUD** (`app/hud/`) — always-on-top overlay
   - Settings UI at `peek://app/settings/settings.html`
   - The legacy `app/extensions/loader.js` and the consolidated
     extension-host iframe model are **gone** as of April 2026 (v1 removal).

3. **Feature tiles** (`features/<id>/`) — every feature is a tile. Each
   loads through the same `tile-preload.cts` and the same `tile:*` IPC,
   gated on the capabilities declared in its `manifest.json` (schema
   version 3). See [docs/architecture.md](docs/architecture.md) and
   [docs/tiles-single-file.md](docs/tiles-single-file.md).

4. **Peek API** (`window.app`) — exposed to every tile renderer by
   [`backend/electron/tile-preload.cts`](backend/electron/tile-preload.cts).
   The full surface is documented in [docs/tile-api.md](docs/tile-api.md).
   The headline namespaces:
   - `api.window.*` for window management (gated on the `window` capability)
   - `api.shortcuts.*` for hotkeys (local by default, `{ global: true }` for OS-level; gated on `shortcuts`)
   - `api.datastore.*` for data persistence (gated on per-table allowlist)
   - `api.commands.*` for command palette integration
   - `api.theme.*` for theme management
   - `api.publish()` / `api.subscribe()` / `api.pubsub.*` for cross-tile messaging

### Backend Structure
```
backend/
├── electron/          # Electron desktop backend (current primary)
│   ├── datastore.ts   # SQLite via better-sqlite3
│   ├── ipc.ts         # IPC handlers
│   └── protocol.ts    # peek:// protocol handler
├── tauri/             # Tauri desktop backend (Rust)
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── lib.rs          # App setup
│   │   │   ├── datastore.rs    # SQLite via rusqlite
│   │   │   └── commands/       # IPC command handlers
│   │   └── tests/smoke.rs      # Rust smoke tests
│   └── preload.js              # Peek API implementation (Tauri)
├── tauri-mobile/      # Tauri mobile app (iOS/Android)
│   ├── src/           # React frontend
│   └── src-tauri/     # Rust backend
├── extension/         # MV3 browser extension (Firefox/Chrome)
│   ├── background.js  # Service worker: alarms, message handling, sync init
│   ├── datastore.js   # IndexedDB adapter (mirrors SQLite schema)
│   ├── bookmarks.js   # Bookmark sync (one-way import)
│   ├── tabs.js        # Tab sync (one-way import)
│   ├── history.js     # History sync (one-way import, update-on-revisit)
│   ├── options.js     # Options page logic
│   └── tests/         # Unit tests (ELECTRON_RUN_AS_NODE=1, node --test)
└── server/            # Webhook API server for mobile sync
    ├── index.js       # Hono HTTP server
    ├── db.js          # SQLite via better-sqlite3
    └── users.js       # Multi-user API key auth
```

**Data Sync**: Both backends use the same SQLite database path (`~/.config/Peek/{profile}/datastore.sqlite`). Only one backend should run at a time (file lock).

### Custom Protocol
- `peek://app/...` — core renderer files (from `app/` directory)
- `peek://{tileId}/...` — feature tile files (one origin per tile)
- `peek://tauri/...` — Tauri backend files (only in Tauri)

### Tile architecture

Every feature is a **tile** — an HTML file that runs in its own
BrowserWindow with `tile-preload.cts` and a capability-gated `tile:*` IPC
surface. There is no "tile type", no "tile role", no separate "background
tile" concept; residency (`resident: true`) and visibility (`showSelf()` /
`hideSelf()`) are independent runtime properties. See
[docs/architecture.md#the-tile-model](docs/architecture.md#the-tile-model)
for the full picture and [docs/tiles-single-file.md](docs/tiles-single-file.md)
for the single-file tile rationale.

```
features/
├── hello-world/          # Tutorial / diagnostic tile (read this first)
├── cmd/                  # (Note: cmd panel UI is now in app/cmd; commands live here)
│   └── commands/         # Built-in command modules (note, url, tagset, tag, etc.)
├── editor/               # Item CRUD: add, edit content, delete
├── example/              # Hello world example
├── groups/
├── lex/                  # Lexicon Studio — AT Protocol identity and data browser
├── peeks/
├── slides/
└── tags/                 # Tag browsing, filtering, tag editing on items
    ├── manifest.json           # v3 tile manifest (id, tiles[], capabilities)
    ├── settings-schema.json    # Settings UI schema (optional)
    ├── home.html               # Entry point (single-file tile target)
    └── home.js                 # Main logic (ES module)
```

**Tile entry pattern** (single-file tile — preferred):

```javascript
const api = window.app;

api.commands.register({ name: 'my-cmd', description: '...', execute: fn });
api.shortcuts.register('Option+x', handler, { global: true });
api.subscribe('some:topic', (data) => { /* … */ });

// Tile starts hidden; show on demand:
async function open() {
  await api.window.showSelf();
}
```

The legacy `init()` / `uninit()` background-script pattern (loaded into a
shared extension-host iframe) was removed as part of v1 removal. Each tile
now owns its own BrowserWindow lifetime and the per-tile capability token
is revoked automatically on window close — no manual `unregister`
bookkeeping needed for shutdown.

### State machines

Peek runs three explicit state machines. Each has a design doc; the
summaries here tell you what each FSM owns so you know which one to read
when you hit a bug.

- **Tile lifecycle FSM** ([docs/tile-lifecycle-fsm.md](docs/tile-lifecycle-fsm.md),
  [`backend/electron/tile-lifecycle.ts`](backend/electron/tile-lifecycle.ts),
  [`backend/electron/tile-fsm.ts`](backend/electron/tile-fsm.ts))
  — owns *when a tile is alive*. States: `unregistered → registered →
  loading → ready → visible` plus `unloading` and `crashed`. Static
  declarations (commands, shortcuts, nouns, lazyEvents) are wired on
  `unregistered → registered` and visible in the cmd panel without the
  tile running. The capability token is minted on `loading → ready` and
  revoked on `→ unloading` / `→ crashed`.

- **PubSub state machine** ([docs/pubsub-state-machine.md](docs/pubsub-state-machine.md),
  [`backend/electron/pubsub.ts`](backend/electron/pubsub.ts), gated through
  [`backend/electron/tile-ipc-gate.ts`](backend/electron/tile-ipc-gate.ts))
  — owns *what messages can flow in each state*. Every `tile:*` IPC frame
  runs through a 6-step validation pipeline (channel / sender-frame /
  schema / token+grant / tile-state / sender-role) before any handler
  fires. Dropped publishes are impossible by construction: if a message
  doesn't flow, the pipeline says exactly which step rejected it.

- **Cmd panel state machine** ([docs/cmd-state-machine.md](docs/cmd-state-machine.md),
  [`app/cmd/state-machine.js`](app/cmd/state-machine.js)) — owns the
  interactive command-bar UI states (10 states from `IDLE` to `CLOSING`).
  Pure module, no DOM or IPC; the DOM adapter in `app/cmd/panel.js` is
  the only thing that talks to electron.

### Noun Registration API

Extensions that manage data (tags, groups, feeds, scripts, entities) should register **nouns** instead of individual verb commands. The noun system auto-generates standard verb commands (`list`, `open`, `new`) from capability declarations.

**Architecture:**
```
Tile → registerNoun() (app/cmd/nouns.js)
  → publishes noun metadata via pubsub
  → bgWindow's cmd registry receives, generates commands via app/cmd/noun-registry.js
  → commands appear in the cmd palette like any other commands
  → execution routes back via noun:{capability}:{name} pubsub
```

All layers use only `window.app` pubsub — zero platform-specific code.

**Usage:**
```javascript
import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

registerNoun({
  name: 'groups',             // Plural (required)
  singular: 'group',          // Singular (required)
  description: 'Saved tab groups',

  // Capabilities — each auto-generates verb commands
  query: async ({ search }) => items,   // → "list groups", bare "groups"
  browse: async () => { /* open UI */ },// → "open groups", bare "groups"
  open: async ({ search }) => {},       // → "open group {search}" (needs query too)
  create: async ({ search }) => result, // → "new group {search}"

  produces: 'application/json',         // MIME type for chaining
  params: [{type: 'tag', multiple: true}],
  skipBare: false,            // If true, suppress bare "{name}" command
});
```

**Auto-generated commands:**

| User types | Capability | Requires |
|-----------|-----------|----------|
| `groups` | browse (or query if no browse) | browse or query |
| `list groups` | query | query |
| `open groups` | browse | browse |
| `open group X` | open | query + open |
| `new group X` | create | create |

**Key files:**
- `app/cmd/noun-registry.js` — Pure command generation (no deps)
- `app/cmd/nouns.js` — Registration API (uses `window.app` pubsub)
- `app/cmd/commands.js` — Noun-aware proxy execution
- bgWindow (`app/index.js` → `initCmd()`) — owns the noun registry and command broadcasting

**Converted tiles:**

| Tile | Capabilities | `skipBare` | Regular commands kept |
|-----------|-------------|------------|----------------------|
| tags | query, browse | true | tag, tags, untag, tagset |
| groups | query, browse, open, create | false | — |
| feeds | query, browse, create | false | refresh feeds |
| entities | query, browse | true | extract entities |
| scripts | query, browse, open, create | false | — |
| pagestream | browse | false | — |
| editor | browse | true | — |

**When NOT to use nouns:** Panel-local commands (note, edit, history, url) that run directly in the panel window and don't go through pubsub. Also, action verbs that aren't standard CRUD (e.g., `refresh feeds`, `extract entities`).

### Editor tile

The editor tile (`features/editor/`) is the canonical surface for creating, editing, and deleting items. It complements the tags tile, which focuses on browsing and tag management.

**Features:**
- Inline add with smart type detection (URLs auto-detected vs text notes)
- Type-specific content editing (URL input, textarea, image preview, tagset notice)
- Tag editing with frecency-sorted available tags
- Delete with confirmation
- Keyboard navigation (vim keys, search with `/`)

**Shortcut:** `Option+E` opens the editor.

**Pubsub topics:**
- `editor:open` — open editor with a specific item for editing. Payload: `{ itemId }`
- `editor:add` — open editor in add mode. Payload: `{ type?, content?, url? }`
- `editor:changed` — published after any create/update/delete, so other views can refresh. Payload: `{ action, itemId }`

### Lexicon Studio (AT Protocol Identity)

The Lexicon Studio tile (`features/lex/`) connects Peek to the AT Protocol (Bluesky) network. It provides identity login, repo browsing, and record creation.

**Files:**
- `background.js` — Tile lifecycle, session management, pubsub API for the home UI
- `atproto.js` — AT Protocol helpers: OAuth (PKCE + DPoP via loopback server), XRPC requests, blob upload
- `home.js` / `home.html` — Main UI: login, sidebar navigation, three content panels
- `lexicon-ui.js` — Dynamic form generation from lexicon schemas with multi-layer resolution
- `home.css` — Styles for the home UI

**Key concepts:**

- **OAuth login** — PKCE + DPoP flow using `api.oauth.startLoopbackServer()`. Actor search uses the public Bluesky API (`app.bsky.actor.searchActorsTypeahead`). Session (tokens, DID, PDS URL) and profile are persisted via `api.settings`.
- **My Lexicons** — Lists all collections in the user's AT Protocol repo with record counts via `com.atproto.repo.describeRepo` and `com.atproto.repo.listRecords`.
- **Explore Lexicons** — Fetches the full lexicon directory from `lexidex.bsky.dev` (scrapes domain pages for NSIDs). Includes hardcoded extras from `standard.site`. Cached in `api.settings` with 24-hour TTL and background refresh.
- **Create Record** — Searchable lexicon picker, then auto-generated form from the lexicon schema or raw JSON mode. Schema resolution is layered: in-memory cache, persisted cache, GitHub raw URLs (known mappings for `app.bsky`, `com.atproto`, etc.), Lexicon Store API (`api.lexicon.store`), fallback to raw JSON.
- **Recent lexicons** — Successfully created record types appear as sidebar shortcuts. Persisted via `api.settings`. Removable with [x].
- **Token refresh** — XRPC requests auto-refresh expired tokens using DPoP-bound refresh tokens. The `onSessionRefresh` callback updates the stored session.

**Pubsub topics:**
- `lex:get-session` / `lex:session-state` — UI requests current session
- `lex:search-actors` / `lex:search-actors:response` — Actor typeahead search
- `lex:do-login` / `lex:session-changed` / `lex:login-error` — Login flow
- `lex:do-logout` / `lex:session-changed` — Logout
- `lex:get-collections` / `lex:collections:response` — Fetch repo collections
- `lex:search-lexicons` / `lex:search-lexicons:response` — Explore lexicon directory
- `lex:create-record` / `lex:create-record:response` — Create a record

**Command:** `lexicon studio` — opens the identity panel window (`peek://lex/home.html`).

### Cmd Commands (Item Creation)

Commands live in `features/cmd/commands/` and are loaded by the cmd panel.

| Command | With args | Without args |
|---------|-----------|--------------|
| `note <text or url>` | Saves item (auto-detects URL vs text note). Text notes tagged `note`, `from:cmd`. | Opens editor in add mode (text) |
| `url <url>` | Saves URL item | Opens editor in add mode (url) |
| `tagset <tag1,tag2,...>` | Creates tagset item with linked tags, tagged `from:cmd` | Opens editor in add mode (tagset) |
| `notes` | Lists recent notes (items tagged `note`) | — |

### Window Management
- Windows identified by keys for lifecycle management (e.g., `peek:${address}`)
- Modal windows use `type: 'panel'` to return focus to previous app on close
- Parameters: `modal`, `keepLive`, `persistState`, `transparent`, `height`, `width`, `key`
- **IZUI State Machine** - manages transient vs active window behavior. See `docs/izui.md`
  - **Transient**: Invoked from another app (global hotkey) - ESC closes immediately
  - **Active**: Invoked within Peek - ESC navigates internally, never closes
  - Transient state propagates to child windows (e.g., cmd → overlay)
  - Use `api.izui.isTransient()` to query current session state

### Page View Canvas Architecture

The canvas page-host (a fullscreen transparent BrowserWindow hosting a `<webview>`) was
removed 2026-07. The hybrid page-host (`WebContentsView` content + one shared chrome
overlay in `main/hybrid-overlay.ts`) is the only page-host implementation now — see git
history / peek item `e8081cce` for the removal.

### Data Storage

**Settings Storage (localStorage)**:
- Profile-based data separation in `{userData}/{PROFILE}/` directory
- Features use `openStore(id, defaults, clear)` utility from `app/utils.js`

**Datastore (TinyBase)**:
- In-memory TinyBase store for structured data
- Runs in main process with IPC handlers for renderer access
- Schema defined in `app/datastore/schema.js`
- Tables: `addresses`, `visits`, `content`, `tags`, `blobs`, `scripts_data`, `feeds`

**Profile Management**:

Peek supports user profiles for isolated data workspaces. See `docs/profiles.md` for full details.

- **Production builds** (installed in /Applications) use `default` profile
- **Development builds** (`yarn start`) ALWAYS use `dev` profile (isolated from production)
- **Custom profiles** can be created via Settings UI
- Profile switching requires app restart
- Each profile has its own:
  - SQLite database (`datastore.sqlite`)
  - Chromium session data (cookies, cache, localStorage)
  - Sync configuration (optional API key + server profile mapping)
- `PROFILE` env var overrides automatic detection (for testing)

## UI Development Guidelines

### Always Use Peek Components

**CRITICAL:** All new UI features MUST use components from `app/components/`. DO NOT create manual DOM with `innerHTML` or `createElement` for UI elements.

#### Available Components

- **Layout:** `peek-card`, `peek-grid`, `peek-list`/`peek-list-item`
- **Forms:** `peek-input`, `peek-button`, `peek-select`, `peek-switch`, `peek-button-group`
- **Interactive:** `peek-dialog`, `peek-drawer`, `peek-popover`, `peek-tabs`, `peek-carousel`
- **Native wrappers:** `peek-details` (disclosure/accordion), `peek-tooltip`

See `app/components/README.md` for complete documentation.

#### Component Usage Pattern

```javascript
// Import components at top of HTML
<script type="module" src="peek://app/components/peek-card.js"></script>
<script type="module" src="peek://app/components/peek-grid.js"></script>

// Use in JavaScript
const card = document.createElement('peek-card');
card.interactive = true;
card.elevated = true;

const header = document.createElement('div');
header.slot = 'header';
header.textContent = 'Card Title';
card.appendChild(header);

// Or use innerHTML for static content
card.innerHTML = `
  <div slot="header">Card Title</div>
  <p>Card content here</p>
`;
```

#### Styling Guidelines

- Use CSS custom properties for theming (see `app/components/tokens.css`)
- DO NOT override component internals
- Extend via slots and CSS parts
- Follow design tokens for consistency

```css
peek-card {
  --peek-card-bg: var(--base01);
  --peek-card-border: transparent;
  --peek-card-radius: 8px;
}

peek-card::part(header) {
  background: var(--base02);
}
```

#### Migration of Existing Code

Existing tiles are being migrated to peek-components. When touching existing UI code:

1. **Check migration status** in `notes/migration-ui-componentry.md`
2. **Follow established patterns** from already-migrated tiles
3. **Consider migrating** the code you're working on to components
4. **Ask first** if uncertain whether to migrate during your change

See `notes/migration-ui-componentry.md` for detailed migration patterns.

#### Benefits

- **Consistency** across all tiles
- **Automatic theme support** via CSS custom properties
- **Built-in accessibility** (ARIA patterns, keyboard navigation)
- **Reduced code duplication** (~50% less UI code)
- **Easier maintenance** - fix once, applies everywhere

#### Example: Creating a Card-Based UI

```javascript
// Import components
import 'peek://app/components/peek-card.js';
import 'peek://app/components/peek-grid.js';

// Create grid container
const grid = document.createElement('peek-grid');
grid.setAttribute('min-item-width', '200');
grid.setAttribute('gap', '12');

// Create cards
items.forEach(item => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.selected = item.id === selectedId;

  card.innerHTML = `
    <div slot="header">${escapeHtml(item.title)}</div>
    <p>${escapeHtml(item.description)}</p>
    <span slot="footer">${item.count} items</span>
  `;

  card.addEventListener('card-click', () => handleSelect(item));
  grid.appendChild(card);
});

document.body.appendChild(grid);
```

## Critical Rules

### Protected Directories

**NEVER modify files in `./app` without explicit review.** The `app/` directory is backend-agnostic - it must work unchanged with both Electron and Tauri backends. All backend-specific code belongs in `backend/{electron,tauri}/`.

### Tile preload must stay `.cts`, not `.ts`

[`backend/electron/tile-preload.cts`](backend/electron/tile-preload.cts) — the capability-gated preload exposed as `window.app` to every tile renderer — **must** remain a CommonJS TypeScript file (`.cts`). The backend `tsconfig.json` uses `module: NodeNext`, which emits ESM for plain `.ts` files, and Electron's sandbox preload silently rejects ESM (no API surface, no thrown error — just an empty `window.app` and every tile broken). If you rename or convert this file, the entire app loses its API surface with no obvious failure. See [docs/architecture.md](docs/architecture.md) and [docs/tile-preload-trimming-plan.md](docs/tile-preload-trimming-plan.md).

### Process Management

**Only use `yarn kill` to kill dev processes.** NEVER use generic pkill commands like `pkill -f "Peek"` or `pkill -f "electron"` - these will kill the production app if it's running.

```bash
yarn kill  # ONLY way to kill dev Peek
```

**Testing without UI**: When testing startup, logs, or non-interactive behavior, use headless mode:
```bash
./scripts/test-headless.sh 8    # Run headless for 8 seconds, auto-kills
yarn test:desktop:electron      # Run automated tests (full desktop electron suite)
```

## Common Pitfalls

1. Don't use relative paths in peek:// URLs - use absolute paths
2. Remember to unregister shortcuts when features unload
3. Windows opened by features should be tracked and closed on unload
4. Modal windows require both `modal: true` and `type: 'panel'`
5. Window keys must be unique - use pattern like `peek:${address}`
6. Check if items are enabled (`item.enabled == true`) before registering shortcuts
7. Datastore API returns `{ success, data }` - always check `result.success`
8. Pubsub subscriptions are keyed by source - same source subscribing twice overwrites
9. **Never put backend-specific code in `app/`** - see Critical Rules above
10. **Run `yarn install` after Electron upgrades** - Native modules (better-sqlite3) must be recompiled for the new Electron ABI. The postinstall script handles this automatically, but you must run `yarn install` to trigger it.

## Code Style

- ES6 modules throughout (type: "module" in package.json)
- Async/await preferred over callbacks
- Console logging for debugging (controlled by DEBUG env var)
- No TypeScript in app/, pure JavaScript
- Uses `nodemon` for hot reload during development

## Security Notes

- This is a concept preview, NOT production-ready
- No formal security audit performed
- Different security model than traditional browsers
- Be cautious with cross-origin access and custom APIs

## Linux / Wayland

Global hotkeys (cmd's `Option+Space`, peeks' `Option+0..9`, slides' `Option+arrows`) **don't fire when Peek is in the background on Wayland sessions**. The Wayland security model forbids apps from grabbing keys directly, so Electron's `globalShortcut.register()` returns false silently. Every feature that registers a global shortcut also registers it as a *local* shortcut, so the same accelerators work whenever a Peek window is focused.

The Settings UI surfaces this in the Keyboard Shortcuts group when running on Wayland.

For the full history (XWayland attempt, XDG GlobalShortcuts portal research and abandon reasoning, eventual-revisit conditions, and the implementation plan kept on file for that revisit), see [`docs/global-hotkeys-on-wayland.md`](docs/global-hotkeys-on-wayland.md).

## Claude Code Permissions

All package.json scripts are pre-approved via wildcard permissions in `.claude/settings.local.json`:

```json
"Bash(yarn:*)"   // All yarn commands
"Bash(npm:*)"    // All npm commands
"Bash(npx:*)"    // All npx commands
```

This covers all 146+ scripts automatically, including:
- Development: `yarn dev`, `yarn start`, `yarn debug`
- Testing: `yarn test`, `yarn test:*`
- Building: `yarn build`, `yarn build:*`
- Mobile: `yarn mobile:*`, `yarn tauri:*`
- Server: `yarn server:*`

**No manual permission updates needed** when adding new scripts - the wildcards handle it.

Other pre-approved tool patterns: `git:*`, `jj:*`, `node:*`, `cargo:*`, `electron:*`

## Mobile Development (Tauri iOS/Android)

Mobile development uses the separate `peek-save` app in `backend/tauri-mobile/`.

**CRITICAL - Do NOT run `xcodegen generate`:**
- The Xcode project has custom settings that xcodegen overwrites

### Two Build Pathways

There are exactly two ways to build and deploy the iOS app. Always use these — never ad-hoc commands.

#### Pathway 1: Simulator + HMR (frontend development)

For CSS/TSX changes that hot-reload instantly without rebuilding:

```bash
# From repo root:
yarn mobile:ios:dev
```

This runs `dev-ios-sim.sh` which:
1. Patches `tauri.conf.json` with a random-port `devUrl` (restores on exit)
2. Bumps `BUILD_NUMBER` (displayed as `vNNNN` in app footer)
3. Rebuilds Rust library WITHOUT `custom-protocol` feature (so app loads from devUrl)
4. Runs `xcodebuild` for simulator
5. Installs and launches on simulator
6. Starts vite HMR server — CSS/TSX changes appear instantly

After the initial build, edit frontend files and changes appear live. Stop with Ctrl+C.

#### Pathway 2: Device release (testing on physical device)

For testing on a connected USB device:

```bash
# From repo root:
yarn mobile:ios:xcodebuild:device:full   # build + xcodebuild + install
yarn mobile:ios:device:launch            # launch on device
```

This builds with `--features custom-protocol` so the app uses bundled assets (no dev server needed).

### Why `custom-protocol` Matters

The `custom-protocol` Cargo feature controls whether the app loads from bundled assets or a dev server URL:

- **Without** `custom-protocol` (simulator/HMR): app loads from `devUrl` in `tauri.conf.json` → connects to vite HMR server
- **With** `custom-protocol` (device/release): app uses bundled assets from `frontendDist` → standalone, no server needed

The default `Cargo.toml` has NO features enabled. `build-release.sh` explicitly adds `--features custom-protocol`. This separation is critical — do not add `custom-protocol` to the default dependency features or HMR will break.

### Build Commands (from repo root)

```bash
# Simulator + HMR (preferred for frontend work)
yarn mobile:ios:dev                       # Full HMR dev session (recommended)

# Simulator without HMR (one-off testing)
yarn mobile:ios:build [--force]           # Build Rust library (debug, simulator)
yarn mobile:ios:xcodebuild               # Build Xcode project
yarn mobile:ios:xcodebuild:install       # Install on simulator
yarn mobile:ios:sim:launch               # Launch app
yarn mobile:ios:xcodebuild:full          # All of the above in one command

# Device release
yarn mobile:ios:build:release [--force]   # Build Rust library (release, device)
yarn mobile:ios:xcodebuild:device         # Build Xcode project for device
yarn mobile:ios:device:run                # Install and launch on device
yarn mobile:ios:xcodebuild:device:full    # All of the above in one command
yarn mobile:ios:device:launch             # Launch (if already installed)
```

### Testing Bidirectional Sync

After running `npm run dev:ios`, test data is automatically seeded:

**Server has 3 items:**
- URL: https://github.com/from-server (tags: server, github)
- URL: https://example.com/from-server-1 (tags: server, test)
- Text: "This is a text note from the server" (tags: server, note)

**iOS Simulator has 3 items:**
- URL: https://mobile-only-1.example.com (tags: mobile, local)
- URL: https://mobile-news.example.com (tags: local)
- Text: "This text was created on mobile only" (tags: mobile)

**To test:**
1. Build and run in Xcode (Cmd+R)
2. Go to Settings in the app
3. Settings should already be configured (server URL and API key)
4. Tap **Sync All** to pull and push
5. After sync, both server and iOS should have 6 items

**Gotchas:**
- Xcode scheme is `peek-save_iOS` — all xcodebuild commands use this
- Simulator builds go to `/tmp/peek-xcodebuild-sim`, device builds to `/tmp/peek-xcodebuild-device` (separate derivedDataPaths so they can run in parallel)
- `tauri.conf.json` should NOT have `devUrl` or `beforeDevCommand` checked in — `dev-ios-sim.sh` patches these temporarily and restores on exit
- If Rust code changes during HMR, stop vite (Ctrl+C), restart `yarn mobile:ios:dev`
- `cargo tauri ios dev` is broken on Apple Silicon (passes `ARCHS=x86_64`) — use `yarn mobile:ios:dev` instead which bypasses it

### iOS Build System Architecture

#### Why `cargo build --lib` Instead of `cargo tauri build`

`cargo tauri build` fails on iOS because Swift FFI symbols (`webview_plugin_open`, `webview_plugin_close`) are only available at Xcode's final link stage. Our workaround:

1. `cargo build --lib` — build only the Rust library
2. Copy `libapp.a` to Xcode's expected location
3. Copy frontend assets to `gen/apple/assets/`
4. Let xcodebuild do the final linking with Swift code

#### Debug vs Release Build Separation

| Aspect | Debug (Simulator) | Release (Device) |
|--------|-------------------|------------------|
| Target | `aarch64-apple-ios-sim` | `aarch64-apple-ios` |
| Profile | `dev` (unoptimized) | `release` (optimized) |
| Features | none (uses devUrl) | `custom-protocol` (uses bundled assets) |
| Cache | `ios-cache/debug/` | `ios-cache/release/` |
| Xcode Externals | `Externals/arm64/Debug/` | `Externals/arm64/Release/` |
| Build script | `build-ios.sh` | `build-release.sh` |
| yarn command | `yarn mobile:ios:build` | `yarn mobile:ios:build:release` |

#### Build Number

`backend/tauri-mobile/BUILD_NUMBER` is a plain integer. `vite.config.ts` reads it as `__BUILD_NUMBER__` and displays `vNNNN` in the app footer. `dev-ios-sim.sh` auto-increments it on every HMR session start. Always check the build number in the app footer to confirm your changes deployed.

#### Cache

Caches are at the repo root level (`tmp/ios-cache/`) and shared across agent workspaces. The cache hash includes `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `build.rs`, and `src/*.rs`. Use `--force` to bypass cache.

#### Troubleshooting: "localhost" Error on Device

If the app shows "failed to request tauri://localhost" on device, the `custom-protocol` feature is missing from the build. Verify `build-release.sh` passes `--features custom-protocol` and rebuild:

```bash
yarn mobile:ios:build:release --force
yarn mobile:ios:xcodebuild:device
yarn mobile:ios:device:run
```

## Server Backend (Webhook API)

The server backend (`backend/server/`) is a remote HTTP API for syncing data from the mobile app. It's separate from the desktop backends - it doesn't implement the Peek API, it's a standalone Node.js server.

### Server Commands
```bash
# From project root
yarn server:install      # Install dependencies (first time)
yarn server:start        # Run production server (port 3000)
yarn server:dev          # Run with hot reload
yarn server:test         # Run unit tests (92 tests)
yarn server:healthcheck  # Verify server starts and responds

# From backend/server/
npm install
npm start
npm run dev
npm test
npm run test:api:local   # Test against local server (needs PEEK_LOCAL_KEY)
npm run test:api:prod    # Test against production (needs PEEK_PROD_KEY, PEEK_PROD_URL)
```

### Server Architecture
- **Hono** - Lightweight HTTP framework (like Express but faster)
- **better-sqlite3** - SQLite database (same as Electron backend)
- **Multi-user** - Each user gets isolated database in `./data/{userId}/`
- **API key auth** - Bearer token authentication, keys hashed with SHA-256

### Server API Endpoints
All endpoints except `/` require `Authorization: Bearer <api_key>` header.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check (public) |
| `/webhook` | POST | Receive items from mobile (`{ urls, texts, tagsets }`) |
| `/urls` | GET | List saved URLs |
| `/urls/:id` | DELETE | Delete URL |
| `/urls/:id/tags` | PATCH | Update URL tags |
| `/texts` | GET/POST | List or create texts |
| `/tagsets` | GET/POST | List or create tagsets |
| `/images` | GET/POST | List or upload images |
| `/images/:id` | GET/DELETE | Get or delete image |
| `/items` | GET/POST | Unified endpoint (filter with `?type=`) |
| `/tags` | GET | List tags by frecency |

### Server Deployment (Railway)

Railway project: `amusing-courtesy`, service: `peek-node`
URL: `https://peek-node.up.railway.app`

**Important:** The server uses **npm** (not yarn). Railway's Nixpacks builder auto-detects `package-lock.json` and uses npm. Do not add `yarn.lock` to `backend/server/` — it will cause Nixpacks to use yarn and fail with frozen lockfile errors.

**How it works:** The deploy script (`yarn server:deploy`) uses `git subtree split` to extract `backend/server/` into a standalone `deploy/server` branch, then pushes to GitHub. Railway watches this branch.

```bash
# Run tests first
yarn server:test

# Deploy (from repo root)
yarn server:deploy
```

This runs `scripts/deploy-server.sh` which:
1. Exports jj state to git (`jj git export`)
2. Splits `backend/server/` into branch `deploy/server` via `git subtree split`
3. Removes `yarn.lock` from the deploy branch if present
4. Pushes `deploy/server` to GitHub (`git push github deploy/server`)

Railway auto-deploys from the `deploy/server` branch on GitHub (`git@github.com:autonome/peek`).

**Manual Railway commands** (run `railway link -p amusing-courtesy` once first):
```bash
railway deployment list --service peek-node --limit 5   # Check deploy status
railway logs --service peek-node -n 50                   # View recent logs
railway logs --service peek-node --build -n 50           # View build logs
curl https://peek-node.up.railway.app/                   # Health check
```

**Initial Setup:**
1. Connect Railway to GitHub repo, `deploy/server` branch
2. Attach a persistent volume, set `DATA_DIR` env var to mount path
3. Create users via the `users.js` module

**Deployment Order (Server + Mobile):**
1. **Server first** - stateless, has auto-migrations that run on first request
2. **Mobile second** - works offline, adapts to server changes

**Migration Gotcha:**
When adding database columns via migration, ensure indexes on those columns are created AFTER the column migration runs, not in the initial CREATE TABLE statement.

### Server Database Schema
Different from desktop datastore - optimized for mobile sync:
- `items` - Unified table (type: url/text/tagset/image)
- `tags` - Tag names with frecency scoring
- `item_tags` - Many-to-many junction
- `settings` - Key-value config

Images stored on disk in `./data/{userId}/images/` with content-hash deduplication.

## Browser Extension (`backend/extension/`)

MV3 browser extension for Firefox and Chrome. Provides sync, profile management, and one-way browser data import behind test feature toggles.

### Running
```bash
yarn extension:firefox     # Launch Firefox with extension (web-ext)
yarn test:extension        # Run unit tests (node --test)
```

### Popup Commands

The popup (Alt+P) provides a command bar for quick actions. Commands show feedback before auto-closing.

| Command | With args | Without args |
|---------|-----------|--------------|
| `tag <tags>` | Tags current URL with comma-separated tags | — |
| `note <text>` | Saves text note attached to current page | — |
| `search <query>` | Searches saved items (results in console) | — |
| `server <url>` | Sets sync server URL (auto-adds https://) | Shows current server |
| `key <apikey>` | Sets API key for sync | Shows masked key (••••ab12) |
| `sync` | Triggers sync, shows "↓3 ↑2" (pulled/pushed) | — |

**UI features:**
- Tab-completion for command names
- Status bar shows sync state, pending item count, manual sync button
- Success: green checkmark + message, auto-closes after 600ms
- Error: red X + message, stays open

### Browser Data Import

Three sync modules import browser data as Peek URL items. All are one-way (browser → Peek), behind toggles in the options page Test Features section, and tag items with their source.

| Module | Toggle key | Tag | Behavior |
|--------|-----------|-----|----------|
| `bookmarks.js` | `peek_bookmarks_enabled` | `from:bookmark` | Add-and-skip: new bookmarks imported, existing URLs tagged |
| `tabs.js` | `peek_tabs_enabled` | `from:tab` | Add-and-skip: open tabs imported, listens for `onUpdated` |
| `history.js` | `peek_history_enabled` | `from:history` | **Update-on-revisit**: existing items get fresh visit metadata via `updateItem()` |

**Cross-source tagging**: When a URL already exists in Peek (from any source), each sync module still adds its own source tag to the existing item. Stats count by tag (e.g. `from:bookmark`, `from:history`). This means an item imported via bookmarks and later visited in history will have both `from:bookmark` and `from:history` tags.

**Diagnostics**: Stats are fetched from the background script via message passing (`get-bookmark-stats`, `get-tab-stats`, `get-history-stats`), not queried directly from the options page, due to Firefox IndexedDB isolation between extension contexts.

**Firefox note**: `chrome.history.search()` with `maxResults: 0` returns zero results in Firefox (unlike Chrome where 0 means unlimited). Use a large number instead.

## Sync Version Compatibility

Two integer version numbers gate sync compatibility between desktop, server, and mobile:

- **`DATASTORE_VERSION`** (`backend/version.ts`, `backend/server/version.js`) — schema shape of sync-relevant tables. Bump when a schema change would break sync.
- **`PROTOCOL_VERSION`** (same files) — wire format of sync JSON payloads. Bump when request/response shape changes.

### How it works

- Clients send `X-Peek-Datastore-Version` and `X-Peek-Protocol-Version` headers on sync requests
- Server checks incoming headers — returns **HTTP 409** on mismatch with a clear error message
- Desktop checks server response headers — throws on mismatch
- **Missing headers are allowed** (backward compat during rollout)
- Both sides are lenient about missing headers, strict about mismatched headers

### Deployment order

1. **Server first** — starts sending/checking version headers. Legacy clients with no headers still work.
2. **Desktop second** — starts sending headers. Server already understands them.
3. **Mobile** — same pattern (not yet implemented, separate workspace).

### Database version tracking

- Server writes `datastore_version` to its `settings` table after migrations
- Desktop writes `DATASTORE_VERSION` to `extension_settings` after migrations
- On startup, if stored version > code version, sync is disabled (prevents old binary from corrupting newer schema)

### Testing

```bash
yarn test:version-compat       # 15 automated tests (HTTP + DB logic)
yarn test:version-compat:e2e   # Full E2E with optional iOS simulator steps
```

## One-Time Dedup Cleanup

A one-time migration that removes pre-existing duplicate items on all platforms. Each platform runs the cleanup on startup, gated by a `dedup_cleanup_v1` settings flag so it only executes once.

### What counts as a duplicate

Items with the same `type` + matching content (non-deleted items only):
- **url**: same `content` value (server/desktop) or same `url` value (mobile)
- **text**: same `content` value
- **tagset**: same sorted set of tag names
- **image**: skipped (binary data)

### Strategy

For each group of duplicates: keep the item with the most recent `updatedAt`, preferring items that have a `syncId`. Hard-delete the rest from `items` and `item_tags`.

### Implementation

- **Server** (`backend/server/db.js`): `deduplicateItems(userId, profileId)` — called at startup via `deduplicateAllUsers()` in `index.js`
- **Desktop** (`backend/electron/datastore.ts`): `migrateDeduplicateItems()` — called from `initDatabase()` after existing migrations
- **Mobile** (`backend/tauri-mobile/src-tauri/src/lib.rs`): dedup block in `ensure_database_initialized()` — runs after existing migrations

### Testing

```bash
yarn test:e2e:full-sync   # Phase 3 tests dedup on all platforms (seeds duplicates, restarts, verifies removal)
```
