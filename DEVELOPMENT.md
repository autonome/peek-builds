# Peek Development Guide

## Project Overview

Peek is a web user agent application that provides alternative ways to interact with web pages through keyboard shortcuts, modal windows, and background scripts. It's designed as a concept preview exploring task-aligned interfaces for the web, moving beyond traditional tabbed browsers.

**Multi-Backend Architecture**: Peek supports multiple backends (Electron, Tauri) that can coexist and sync data. The `app/` directory is **backend-agnostic** and must not contain backend-specific code. Backend-specific code lives in `backend/{electron,tauri}/`.

**Remotes:**
- Tangled: `git@tangled.sh:burrito.space/peek` (primary)
- GitHub: `git@github.com:autonome/peek` (Railway deploy only — not for general use)

**Documentation:** `docs/api.md` (API reference), `docs/mobile.md` (iOS/Android), `docs/sync.md` (sync architecture)

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
yarn test                 # Run all tests (headless)
yarn test:electron        # Run Electron tests only
yarn test:visible         # Run with visible windows
yarn test:grep "pattern"  # Run specific test by name
```

**Testing Policy**: When fixing bugs or adding features, always add tests to cover the change. Tests live in `tests/desktop/smoke.spec.ts`.

## Architecture Overview

### Core Structure

1. **Main Process** (`index.js`):
   - Manages app lifecycle, windows, shortcuts, IPC communication
   - Implements custom `peek://` protocol for internal navigation
   - Handles profile management and data persistence
   - Hosts the TinyBase datastore with IPC handlers for renderer access

2. **Renderer Process** (`app/`):
   - Core app logic loads from `peek://app/background.html`
   - Extension loader at `app/extensions/loader.js`
   - Feature modules: scripts, cmd (registered in `app/features.js`)
   - Built-in extensions: groups, peeks, slides, tags, editor (in `./extensions/`)
   - Settings UI at `peek://app/settings/settings.html`

3. **Peek API** (`window.app`):
   - `api.window.*` for window management
   - `api.shortcuts.*` for hotkeys (local by default, `{ global: true }` for OS-level)
   - `api.datastore.*` for data persistence
   - `api.commands.*` for command palette integration
   - `api.theme.*` for theme management
   - `api.publish()`/`api.subscribe()` for cross-window messaging

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
- `peek://app/...` - Core application files (from `app/` directory)
- `peek://ext/{shortname}/...` - Extension files
- `peek://tauri/...` - Tauri backend files (only in Tauri)

### Extensions Architecture

Extensions run in isolated BrowserWindow processes at `peek://ext/{id}/background.html`.

```
extensions/
├── cmd/                  # Command palette
│   └── commands/         # Built-in command modules (note, url, tagset, tag, etc.)
├── editor/               # Item CRUD: add, edit content, delete
├── example/              # Hello world example
├── groups/
├── me-core/              # AT Protocol identity and data browser
├── peeks/
├── slides/
└── tags/                 # Tag browsing, filtering, tag editing on items
    ├── manifest.json           # Extension metadata
    ├── settings-schema.json    # Settings UI schema (optional)
    ├── background.html         # Entry point
    └── background.js           # Main logic (ES module export)
```

**Background script pattern:**
```javascript
const api = window.app;

const extension = {
  id: 'example',
  labels: { name: 'Example' },

  init() {
    api.shortcuts.register('Option+x', handler, { global: true });
    api.commands.register({ name: 'my-cmd', description: '...', execute: fn });
  },

  uninit() {
    api.shortcuts.unregister('Option+x', { global: true });
    api.commands.unregister('my-cmd');
  }
};

export default extension;
```

### Noun Registration API

Extensions that manage data (tags, groups, feeds, scripts, entities) should register **nouns** instead of individual verb commands. The noun system auto-generates standard verb commands (`list`, `open`, `new`) from capability declarations.

**Architecture:**
```
Extension → registerNoun() (nouns.js)
  → publishes noun metadata via pubsub
  → cmd background.js receives, generates commands via noun-registry.js
  → commands appear in palette like any other commands
  → execution routes back via noun:{capability}:{name} pubsub
```

All layers use only `window.app` pubsub — zero platform-specific code.

**Usage:**
```javascript
import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

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
- `extensions/cmd/noun-registry.js` — Pure command generation (no deps)
- `extensions/cmd/nouns.js` — Registration API (uses `window.app` pubsub)
- `extensions/cmd/background.js` — Noun registry + command broadcasting
- `extensions/cmd/commands.js` — Noun-aware proxy execution

**Converted extensions:**

| Extension | Capabilities | `skipBare` | Regular commands kept |
|-----------|-------------|------------|----------------------|
| tags | query, browse | true | tag, tags, untag, tagset |
| groups | query, browse, open, create | false | — |
| feeds | query, browse, create | false | refresh feeds |
| entities | query, browse | true | extract entities |
| scripts | query, browse, open, create | false | — |
| pagestream | browse | false | — |
| editor | browse | true | — |

**When NOT to use nouns:** Panel-local commands (note, edit, history, url) that run directly in the panel window and don't go through pubsub. Also, action verbs that aren't standard CRUD (e.g., `refresh feeds`, `extract entities`).

### Editor Extension

The editor extension (`extensions/editor/`) is the canonical surface for creating, editing, and deleting items. It complements the tags extension, which focuses on browsing and tag management.

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

### Me Extension (AT Protocol Identity)

The me-core extension (`extensions/me-core/`) connects Peek to the AT Protocol (Bluesky) network. It provides identity login, repo browsing, and record creation.

**Files:**
- `background.js` — Extension lifecycle, session management, pubsub API for the home UI
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
- `me:get-session` / `me:session-state` — UI requests current session
- `me:search-actors` / `me:search-actors:response` — Actor typeahead search
- `me:do-login` / `me:session-changed` / `me:login-error` — Login flow
- `me:do-logout` / `me:session-changed` — Logout
- `me:get-collections` / `me:collections:response` — Fetch repo collections
- `me:search-lexicons` / `me:search-lexicons:response` — Explore lexicon directory
- `me:create-record` / `me:create-record:response` — Create a record

**Command:** `me:core` — opens the identity panel window (`peek://ext/me-core/home.html`).

### Cmd Commands (Item Creation)

Commands live in `extensions/cmd/commands/` and are loaded by the cmd panel.

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

**DO NOT REPLACE this architecture.** It was accidentally destroyed on Feb 8 2025 (commit `nnpvvvvk`) when a coordinate-mapping bug in slides was "fixed" by removing the entire canvas model. The real fix was to exclude slides from the canvas path via `useCanvas`. This section documents the restored architecture.

Web pages opened as content or child-content use a **fullscreen transparent canvas**:

1. **Backend** (`ipc.ts`): A `useCanvas` flag determines whether a web page gets the canvas treatment. Canvas pages (`useCanvas = true`) are content/child-content web pages that are not modals, overlays, or quick-views. Non-canvas web pages (slides, modals) load their URL directly in a positioned BrowserWindow.

2. **Fullscreen transparent BrowserWindow**: The canvas window is sized to cover the entire display work area at position (0,0) via `screen.getDisplayNearestPoint()`. Background color is `#00000000` (fully transparent). This creates an invisible surface for positioning UI elements.

3. **JS positioning** (`page.js`): All elements (`<webview>`, navbar, trigger zone, resize handle, mode indicator) are `position: absolute` siblings with NO CSS top/left/right/bottom. JS `updatePositions()` sets inline styles based on a `bounds` object `{x, y, width, height}` parsed from URL params.

4. **Custom drag/resize**: Dragging the navbar updates `bounds.x`/`bounds.y`. Resizing via the corner handle updates `bounds.width`/`bounds.height`. Both call `updatePositions()`. No `-webkit-app-region: drag` — the navbar uses a custom mousedown handler.

5. **Navbar**: Sits ABOVE the webview with an 8px gap. Shown by Cmd+L or hovering the trigger zone. Has rounded corners and grab cursor.

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

Existing extensions are being migrated to peek-components. When touching existing UI code:

1. **Check migration status** in `notes/migration-ui-componentry.md`
2. **Follow established patterns** from already-migrated extensions
3. **Consider migrating** the code you're working on to components
4. **Ask first** if uncertain whether to migrate during your change

See `notes/migration-ui-componentry.md` for detailed migration patterns.

#### Benefits

- **Consistency** across all extensions
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

### Process Management

**Only use `yarn kill` to kill dev processes.** NEVER use generic pkill commands like `pkill -f "Peek"` or `pkill -f "electron"` - these will kill the production app if it's running.

```bash
yarn kill  # ONLY way to kill dev Peek
```

**Testing without UI**: When testing startup, logs, or non-interactive behavior, use headless mode:
```bash
./scripts/test-headless.sh 8    # Run headless for 8 seconds, auto-kills
yarn test:electron              # Run automated tests
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
