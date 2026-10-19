# Peek Mobile

A Tauri-based iOS app for saving and organizing URLs, notes, and tag-sets using frecency (frequency + recency) scoring.

## Overview

Peek is a mobile bookmarking and note-taking app that allows you to:
- Save **Pages** (URLs) directly from the iOS share sheet
- Save **Notes** (text with inline #hashtags) from the share sheet or main app
- Create **Tag-sets** (collections of tags) for quick categorization
- Tag items with multiple tags using frecency-scored suggestions
- Automatically merge tags when saving duplicate items
- Browse saved items in tabbed interface (Pages | Notes | Tags)
- Use domain-affinity tag boost for smarter suggestions
- Sync all item types to an external webhook endpoint
- Edit and delete any saved item

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust with Tauri v2
- **Platform**: iOS (simulator and device)
- **Storage**: SQLite database in iOS App Groups container (shared between app and extension)
- **Database Access**:
  - Main app: Rust with `rusqlite` crate via Objective-C FFI bridge
  - Share Extension: Swift with GRDB.swift library
- **Native Bridge**: Objective-C bridge for accessing App Group container path from Rust

## Architecture

### Item Types

Peek supports three item types, accessible via tab navigation:

| Type | Description | Source |
|------|-------------|--------|
| **Pages** | URLs/bookmarks | Share Extension (Safari, etc.) |
| **Notes** | Text with inline #hashtags | Share Extension (text) or main app |
| **Tag-sets** | Tag collections only | Main app only |

**Notes** support two ways to add tags:
- Inline hashtags in the text (e.g., `#idea #todo`) are auto-parsed
- Tag buttons below the textarea for adding additional tags

**Tag-sets** are useful for creating reusable tag combinations.

### iOS Share Extension

The app uses an iOS Share Extension with a full UI that allows:
- Immediate tagging without opening the main app
- Tag selection from frecency-sorted list
- Creating new tags on the fly
- Automatic detection and merging of duplicate items
- Status display showing existing tags for already-saved items
- Support for both URLs and plain text content

### Native WKWebView (In-App Browser)

Each URL card has a "webview" button that opens the URL in a native WKWebView overlay, allowing users to view content without leaving the app.

**Implementation:**
- **Swift plugin:** `apps/mobile/src-tauri/gen/apple/Sources/peek-save/WebviewPlugin.swift`
- **FFI bridge:** `apps/mobile/plugins/tauri-plugin-webview/` - Rust crate exposing C functions
- **React integration:** `App.tsx` calls `window.__TAURI_INVOKE__("plugin:webview|open", { url })`

**Features:**
- Full-screen overlay with navigation bar
- Native "Done" button to close
- Tracks visited URLs (stores visit timestamp)
- Reader mode available (future)

### Pull-to-Refresh

The main list supports pull-to-refresh with a **hold gesture** to prevent accidental triggers during scroll.

**Behavior:**
1. Pull down to reveal refresh indicator
2. **Hold** for 300ms to trigger refresh
3. Release before 300ms → cancels (bounce back)
4. Visual feedback shows progress ring filling

**Implementation:** `src/App.tsx` - search for `pullToRefresh` state

### Frecency Algorithm

Tags are scored using frecency (frequency + recency):

```
frecency_score = frequency × 10 × decay_factor
decay_factor = 1 / (1 + days_since_use / 7)
```

This ensures frequently used tags appear first, but decay over time if not used.

### Domain-Affinity Tag Boost

When displaying unused tags in the save/edit interfaces, tags that have been used on URLs from the same domain get a **2x frecency score multiplier**. This makes relevant tags appear higher in suggestions.

**Example**: When saving a URL from `github.com/foo/bar`, any tags previously used on other GitHub URLs (e.g., `github.com/bar/baz`) will appear higher in the tag suggestions.

**Implementation:**
- Domain extraction removes `www.` prefix for matching
- Applied in both Share Extension (Swift) and main app edit mode (Rust/React)

### URL Deduplication

When saving a URL that already exists:
1. The share extension detects the duplicate
2. Shows status: "Already saved with tags: existing, tags"
3. Pre-selects existing tags
4. Button changes to "Update Tags"
5. On save, merges new tags with existing tags (set union)
6. Preserves original ID and timestamp

### Webhook Sync

The app supports syncing all item types to an external webhook endpoint:

- **Configure webhook URL and API key** in the Settings screen
- **Manual sync** via "Sync All" button
- **Auto-sync on save** from both main app and share extension
- **Daily auto-sync** checks `last_sync` timestamp, syncs if >24 hours
- **Offline detection** skips webhook POST if device is offline (uses `NWPathMonitor`)

**Payload format:**
```json
{
  "urls": [
    { "id": "uuid", "url": "https://...", "tags": ["tag1"], "saved_at": "..." }
  ],
  "texts": [
    { "id": "uuid", "content": "Note with #hashtag", "tags": ["hashtag"], "saved_at": "..." }
  ],
  "tagsets": [
    { "id": "uuid", "tags": ["tag1", "tag2"], "saved_at": "..." }
  ]
}
```

### The first sync pulls everything in one response

`pull_from_server()` in `apps/mobile/src-tauri/src/lib.rs` issues a plain
`GET /items?includeDeleted=true` on a first sync — no `limit`, no `cursor`, no chunking. The
paging that landed on the server covers only the three `since` routes, so a first sync fetches
the entire item set in a single response: around 10 MB against the production store as of
2026-09, and growing with it. It completes, but slowly, and every device syncing from scratch
pays it again.

Tombstones are safe across that pull. `merge_server_item()` in
`apps/mobile/peek-core/src/sync.rs` handles a matched tombstone with an in-place
`UPDATE items SET deleted_at = …` that keeps the local row id, so the `ON DELETE CASCADE` on
`blobs` and `item_visits` declared in `apps/mobile/peek-core/src/schema.rs` never fires and
visit history, frecency and offline blobs stay attached. The delete-and-reimport branch runs
only when no local row matches at all.

The client is also gated on datastore version: `checkVersionHeaders()` in `apps/server/index.js`
409s any client not sending `X-Peek-Datastore-Version: 3` across `/items` and `/items/*`.
Profile registration sits outside that check, so a version-mismatched build still shows a recent
last-seen while syncing nothing — a stale binary looks alive rather than broken.

### Profiles

Mobile profiles provide dev/production data isolation. See `docs/profiles.md` for full details.

**Quick summary:**
- **Auto-detection:** Xcode builds use `dev` profile, TestFlight/App Store use `default`
- **Separate databases:** Each profile has its own SQLite file (`peek-{profile-uuid}.db`)
- **Sync isolation:** All sync requests include `?profile={slug}`

### Data Storage

Data is stored in SQLite databases within the iOS App Groups container (`group.com.dietrich.peek-mobile`). This enables sharing between the main app and share extension with proper concurrent access via WAL mode.

**Per-profile database files:**
```
App Group Container/
├── profiles.json           # Profile metadata and sync config
├── peek-{uuid1}.db         # Default profile database
├── peek-{uuid2}.db         # Development profile database
└── peek-{uuid3}.db         # Additional profiles...
```

**Database Location:**
```
~/Library/Developer/CoreSimulator/Devices/<DEVICE_ID>/data/Containers/Shared/AppGroup/<GROUP_UUID>/peek.db
```

**Database Schema:**

```sql
-- Unified items table (pages, texts, tagsets)
CREATE TABLE items (
    id TEXT PRIMARY KEY,           -- UUID
    type TEXT NOT NULL DEFAULT 'page',  -- 'page', 'text', or 'tagset'
    url TEXT,                      -- URL (required for 'page' type)
    content TEXT,                  -- Text content (required for 'text' type)
    created_at TEXT NOT NULL,      -- ISO8601 timestamp
    updated_at TEXT NOT NULL,      -- ISO8601 timestamp
    deleted_at TEXT                -- Soft delete timestamp (NULL = active)
);

-- Tags table
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,     -- Tag name (lowercase)
    frequency INTEGER NOT NULL DEFAULT 0,
    last_used TEXT NOT NULL,       -- ISO8601 timestamp
    frecency_score REAL NOT NULL DEFAULT 0.0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Item-Tag junction table (many-to-many)
CREATE TABLE item_tags (
    item_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, tag_id),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Settings table (key-value store)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,          -- e.g., 'webhook_url', 'webhook_api_key', 'last_sync'
    value TEXT NOT NULL
);
```

**Key Features:**
- WAL mode for concurrent access from main app and share extension
- Unified items table supports all three item types
- Automatic migration from legacy `urls`/`url_tags` tables
- Normalized schema with junction table for item-tag relationships
- Indexes on frequently queried columns (type, url, content, frecency_score)

## Key Files

### Share Extension
- `apps/mobile/src-tauri/gen/apple/Peek/ShareViewController.swift` - Full UI share extension
- `ShareViewController-full-ui.swift.example` - Reference implementation

### App Group Bridge
- `apps/mobile/src-tauri/AppGroupBridge.m` - Objective-C bridge for App Groups access
- Provides C functions for Rust FFI:
  - `get_app_group_container_path()` - Returns path to App Group container for SQLite database
  - `get_system_is_dark_mode()` - Returns current system appearance (dark/light mode)

### Rust Backend
- `apps/mobile/src-tauri/src/lib.rs` - Tauri commands and business logic
- **Page commands**: `save_url`, `get_saved_urls`, `update_url`, `delete_url`
- **Text commands**: `save_text`, `get_saved_texts`, `update_text`
- **Tagset commands**: `save_tagset`, `get_saved_tagsets`, `update_tagset`
- **Tag commands**: `get_tags_by_frecency`, `get_tags_by_frecency_for_url`
- **Webhook commands**: `sync_to_webhook`, `auto_sync_if_needed`

### Frontend
- `src/App.tsx` - React UI with tabbed navigation (Pages | Notes | Tags)
- `apps/mobile/src/App.css` - Mobile-optimized styling with dark mode

### Tests
- `apps/mobile/tests/integration.test.js` - Integration tests against apps/server

### Configuration
- `apps/mobile/src-tauri/tauri.conf.json` - Bundle ID: `com.dietrich.peek-mobile`
- `src-tauri/gen/apple/tauri-app_iOS/tauri-app_iOS.entitlements` - App Groups entitlement
- `apps/mobile/src-tauri/gen/apple/Peek/Peek.entitlements` - Share extension entitlements

## Development

### Prerequisites

- Node.js and npm
- Rust and Cargo
- Xcode (for iOS development)
- Apple Developer certificate

### Setup

```bash
npm install
```

### Running

**Desktop (for quick UI testing):**
```bash
npm run tauri dev
```

### Hot Reload Development (Recommended)

For frontend development with instant CSS/JS hot reload:

```bash
npm run dev:ios:sim
```

This command:
1. Clears any pre-built `libapp.a` to force dev-mode build
2. Starts the Vite dev server on `http://localhost:1420`
3. Opens Xcode with the Tauri CLI process running

Then in Xcode:
1. Build and run (Cmd+R) with Debug scheme on simulator
2. Xcode runs the build script which compiles Rust in dev mode
3. The app loads from `localhost:1420` - changes hot reload instantly

**Note:** Keep the terminal process running - it maintains the dev server.

### Build Workflow

Frontend assets (CSS, JS, HTML) are **embedded in the Rust binary** at compile time for release builds. This means:
- Changing CSS/JS requires rebuilding Rust with `cargo tauri build` (NOT just `cargo build`)
- Simply rebuilding in Xcode won't pick up frontend changes for bundled builds
- The library file to copy is in the `deps/` subdirectory

**Debug Build (Simulator - Bundled Assets):**
```bash
npm run build:ios
# Then build in Xcode with Debug scheme, simulator target
```

**Release Build (Simulator - for testing release config):**
```bash
npm run build:ios:sim:release
# Then build in Xcode with Release scheme, simulator target
```

**Release Build (Device):**
```bash
npm run build:ios:release
# Then build in Xcode with Release scheme, device target
```

### npm Scripts Reference

| Script | Description |
|--------|-------------|
| `dev:ios:sim` | Hot reload development - starts vite, opens Xcode |
| `build:ios` | Debug build for simulator (bundled assets) |
| `build:ios:sim:release` | Release build for simulator |
| `build:ios:release` | Release build for device |
| `xcode` | Copy libraries and open Xcode (no build) |
| `dev:ios` | Full dev setup with server (for sync testing) |

### CLI Build Scripts (from repo root)

**Simulator builds:**
| Script | Description |
|--------|-------------|
| `mobile:ios:xcodebuild:full` | Full debug build + install on simulator |
| `mobile:ios:xcodebuild:release:full` | Full release build + install on simulator |
| `mobile:ios:sim:run` | Boot simulator + build + install + launch |
| `mobile:ios:sim:boot` | Boot iPhone 17 Pro simulator |
| `mobile:ios:sim:launch` | Launch app on booted simulator |

**Device builds:**
| Script | Description |
|--------|-------------|
| `mobile:ios:xcodebuild:device:full` | Full release build + install on USB device |
| `mobile:ios:device:launch` | Launch app on connected device |
| `mobile:ios:device:list` | List connected iOS devices |

**One-liner for device deployment:**
```bash
yarn mobile:ios:xcodebuild:device:full && yarn mobile:ios:device:launch
```

**Important Notes:**
- Debug uses `Externals/arm64/Debug/libapp.a` and target `aarch64-apple-ios-sim`
- Release uses `Externals/arm64/Release/libapp.a` and target `aarch64-apple-ios`
- Always copy from the `deps/` subfolder (has embedded assets), not the root folder
- Use `cargo tauri build`, NOT `cargo build` (the latter doesn't embed frontend assets)

The Xcode preBuildScript checks if `libapp.a` exists and skips the Rust build if so. For hot reload development, `dev:ios:sim` clears this file so Xcode runs the build script in dev mode.

### App Icon

The app uses `Peek.icon` bundle (Xcode 15+ unified icon format):
- Source: `src-tauri/gen/apple/Peek.icon/Assets/Peek clouds src.png` (1232x1232)
- Xcode generates all required icon sizes during build
- Do NOT recreate `Assets.xcassets/AppIcon.appiconset/` - that's Tauri's default icons

### In-App Icons (URL Action Buttons)

The URL cards have action buttons (Safari, WKWebView, copy, edit, delete) that use inline SVG icons.

**Location:** `apps/mobile/src/App.tsx` - search for `SvgIcon` components

**Styling:** The `.card-action-btn` class in `App.css` controls button appearance:
```css
.card-action-btn {
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  border: none;
  /* ... */
}
```

**Important:** iOS Safari/WebKit requires explicit `-webkit-appearance: none` and `background: transparent` to prevent default button styling that shows as gray backgrounds.

### Building

**Build Rust library for iOS:**
```bash
cd src-tauri
./build-ios.sh
```

**Build iOS app:**
```bash
cd src-tauri/gen/apple
xcodebuild -scheme tauri-app_iOS -configuration Debug -sdk iphonesimulator -derivedDataPath build
```

**Install on simulator:**
```bash
xcrun simctl install <DEVICE_ID> "src-tauri/gen/apple/build/Build/Products/debug-iphonesimulator/Peek.app"
```

### Bundle Identifiers

- Main app: `com.dietrich.peek-mobile`
- Share extension: `com.dietrich.peek-mobile.share` (must be prefixed with main app ID)
- App Group: `group.com.dietrich.peek-mobile`

**Important**: All three must match the `-mobile` suffix for the App Groups sharing to work.

### Build Script

The `build-ios.sh` script:
1. Builds Rust library for both `aarch64-apple-ios-sim` and `x86_64-apple-ios`
2. Creates universal library with `lipo`
3. Copies to `gen/apple/Externals/arm64/debug/libapp.a`
4. Compiles Objective-C bridge code

### Testing

Integration tests verify the webhook sync with the backend server (`apps/server/`):

```bash
# Run tests (starts server with temp data, runs tests, cleans up)
npm test

# Verbose mode (shows server logs)
npm run test:verbose
```

Tests cover:
- Webhook sync for pages (URLs)
- Texts API (create, read, update, delete)
- Tagsets API (create, read, update, delete)
- Unified `/items` API with type filtering
- Tags frecency tracking
- Update and delete operations

**Requirements:** Server dependencies installed (`cd ../server && npm install`)

### Cleaning Data

To clear all saved items and tags from simulator:

```bash
# Find the SQLite database
find ~/Library/Developer/CoreSimulator/Devices/<DEVICE_ID>/data/Containers/Shared/AppGroup -name "peek.db"

# Delete it (also removes WAL files)
rm "<path_to_peek.db>"*

# Or to just clear data without deleting the database:
sqlite3 "<path_to_peek.db>" "DELETE FROM item_tags; DELETE FROM items; DELETE FROM tags;"
```

### Share Extension in Xcode

The share extension must be configured in Xcode:
1. Target: "Peek" (Share Extension)
2. Bundle ID: `com.dietrich.peek-mobile.share`
3. Principal Class: `ShareViewController`
4. Copy `ShareViewController-full-ui.swift.example` to `apps/mobile/src-tauri/gen/apple/Peek/ShareViewController.swift`
5. Ensure entitlements include App Groups

## iOS Build System Architecture

This section documents the critical details of building Tauri iOS apps. **Read this before doing any iOS builds.**

### The `custom-protocol` Feature (CRITICAL)

**⚠️ The `custom-protocol` Cargo feature is REQUIRED for production builds.**

Without this feature, the app tries to connect to `localhost:1420` instead of using bundled assets, causing:
- "failed to request tauri://localhost" error
- iOS local network permission prompt
- Blank white screen

```toml
# apps/mobile/src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2", features = ["custom-protocol"] }

[features]
custom-protocol = ["tauri/custom-protocol"]
```

**How it works:** Tauri's build system sets `cargo:dev=true` or `cargo:dev=false` based on this feature:
- **With** `custom-protocol` → `dev=false` → uses bundled assets (production)
- **Without** `custom-protocol` → `dev=true` → tries to connect to localhost (dev mode)

**For hot reload development**, the feature is still present but we use `cargo tauri dev` which starts a dev server and connects to it.

### Debug vs Release Build Separation

Debug and release builds are completely separated to prevent cross-contamination:

| Aspect | Debug (Simulator) | Release (Device) |
|--------|-------------------|------------------|
| Target | `aarch64-apple-ios-sim` | `aarch64-apple-ios` |
| Library path | `Externals/arm64/Debug/libapp.a` | `Externals/arm64/Release/libapp.a` |
| Xcode scheme | Debug | Release |
| Cache directory | `tmp/ios-cache/debug/` | `tmp/ios-cache/release/` |
| Cargo flags | (none) | `--release --features custom-protocol` |
| Asset source | Bundled or localhost:1420 | Bundled (custom-protocol) |

**The iOS cache system** is at the repo root (`~/misc/mpeek/tmp/ios-cache/`) so it's shared across workspaces. This prevents duplicate Rust compilations.

### Why `cargo build --lib` Instead of `cargo tauri build`

The standard `cargo tauri build` fails on iOS due to Swift FFI symbols (`webview_plugin_open`, `webview_plugin_close`) that are defined in Swift code and only available at Xcode's final link stage.

**Workaround:**
1. Build only the lib target: `cargo build --lib --target aarch64-apple-ios --release --features custom-protocol`
2. Copy the library to Xcode's expected location
3. Let Xcode handle the final linking with Swift code

This is why the build scripts use `cargo build --lib` and why the `custom-protocol` feature must be explicitly specified.

### Build Scripts Reference

**From repo root (package.json):**

| Script | Description |
|--------|-------------|
| `yarn mobile:ios:cargo:debug` | Build Rust lib for simulator |
| `yarn mobile:ios:cargo:release` | Build Rust lib for device (with custom-protocol) |
| `yarn mobile:ios:xcodebuild` | Build app with xcodebuild for simulator |
| `yarn mobile:ios:xcodebuild:device` | Build app with xcodebuild for device |
| `yarn mobile:ios:xcodebuild:install` | Install built app on simulator |
| `yarn mobile:ios:xcodebuild:install:device` | Install built app on device |
| `yarn mobile:ios:xcodebuild:full` | Full pipeline: cargo + xcodebuild + install (simulator) |
| `yarn mobile:ios:xcodebuild:device:full` | Full pipeline: cargo + xcodebuild + install (device) |
| `yarn mobile:ios:assets` | Rebuild frontend assets only |

**From apps/mobile (package.json):**

| Script | Description |
|--------|-------------|
| `yarn build:ios` | Build for simulator with bundled assets |
| `yarn build:ios:release` | Build for device |
| `yarn dev:ios:sim` | Hot reload development |
| `yarn xcode` | Open Xcode project |

### Build Workflow: Simulator Debug

```bash
# Full rebuild from scratch
yarn mobile:ios:xcodebuild:full

# Or step by step:
yarn mobile:ios:cargo:debug           # 1. Build Rust library
yarn mobile:ios:xcodebuild            # 2. Build with xcodebuild (clean build)
yarn mobile:ios:xcodebuild:install    # 3. Install on simulator
yarn mobile:ios:sim:launch            # 4. Launch app
```

### Build Workflow: Device Release

```bash
# Full rebuild from scratch
yarn mobile:ios:xcodebuild:device:full

# Or step by step:
yarn mobile:ios:cargo:release            # 1. Build Rust library with custom-protocol
yarn mobile:ios:xcodebuild:device        # 2. Build with xcodebuild
yarn mobile:ios:xcodebuild:install:device # 3. Install on device
yarn mobile:ios:device:launch            # 4. Launch app
```

### Frontend-Only Changes

If you only changed CSS/JS/HTML and Rust is unchanged:

```bash
yarn mobile:ios:assets                # Rebuild frontend, copy to Xcode
yarn mobile:ios:xcodebuild            # Rebuild app (clean build required!)
yarn mobile:ios:xcodebuild:install    # Install
```

**Warning:** Xcode aggressively caches assets. Always use `clean build` (the scripts do this automatically) or changes won't appear.

---

## iOS App Group Containers & Data Persistence

Understanding iOS container lifecycle is critical to avoid data loss.

### What Is an App Group Container?

iOS apps store data in sandboxed containers. An **App Group container** is a shared container that multiple apps can access (main app + share extension). Our app uses:
- **App Group ID:** `group.com.dietrich.peek-mobile`
- **Container path:** `~/Library/Developer/CoreSimulator/Devices/<DEVICE_ID>/data/Containers/Shared/AppGroup/<UUID>/`

The `<UUID>` is assigned by iOS when the app is first installed.

### When Container UUIDs Change (Data Loss Scenarios)

| Action | Container UUID | Data |
|--------|---------------|------|
| `xcrun simctl install` (app update) | **Preserved** | **Preserved** ✓ |
| `xcrun simctl uninstall` then reinstall | **New UUID** | **LOST** ✗ |
| Manual delete from Home screen | **New UUID** | **LOST** ✗ |
| Simulator "Erase All Content and Settings" | **New UUID** | **LOST** ✗ |
| Code changes (any) | **Preserved** | **Preserved** ✓ |
| Xcode clean build | **Preserved** | **Preserved** ✓ |
| Bundle ID change | **New UUID** | Old data orphaned |
| App Group ID change | **New UUID** | Old data orphaned |

**Key insight:** Normal app updates preserve data. Only **uninstalling** the app deletes the container.

### Finding Your Container

**Simulator:**
```bash
# Find the peek database
find ~/Library/Developer/CoreSimulator/Devices/*/data/Containers/Shared/AppGroup -name "peek-*.db" 2>/dev/null

# Or find profiles.json
find ~/Library/Developer/CoreSimulator/Devices/*/data/Containers/Shared/AppGroup -name "profiles.json" 2>/dev/null
```

**Device:** Use the backup scripts (see below).

### Backing Up Data

**Device backup (recommended before any device work):**
```bash
yarn mobile:device:backup
# Creates timestamped backup in ~/sync/peek-backups/
```

**What gets backed up:**
- `appGroupContainer/` - All databases and profiles.json
- `appDataContainer/Documents/Backups/` - In-app backups

### Container Locations

**Simulator (per profile):**
```
~/Library/Developer/CoreSimulator/Devices/<DEVICE_ID>/data/Containers/Shared/AppGroup/<UUID>/
├── profiles.json
├── peek-<profile-uuid>.db
├── peek-<profile-uuid>.db-wal
└── peek-<profile-uuid>.db-shm
```

**Device:**
- Accessed via `ios-deploy` or Xcode's device file browser
- Same structure as simulator

---

## Troubleshooting

### localhost Error (Most Common)

**Symptom:** App shows "failed to request tauri://localhost", asks for local network permission, shows blank white screen.

**Cause:** Missing `custom-protocol` Cargo feature.

**Fix:**
```bash
# 1. Verify feature is in Cargo.toml
grep -A5 "\[features\]" apps/mobile/src-tauri/Cargo.toml
# Should show: custom-protocol = ["tauri/custom-protocol"]

# 2. Clean and rebuild with feature
rm -rf apps/mobile/src-tauri/target/aarch64-apple-ios*/release
yarn mobile:ios:cargo:release  # For device
# or
yarn mobile:ios:cargo:debug    # For simulator (if you want bundled assets)

# 3. Clean xcodebuild and reinstall
yarn mobile:ios:xcodebuild:device:full  # For device
```

### Builds Not Updating (Version Stuck)

**Symptom:** You changed code but the app still shows old version.

**Cause:** Xcode caches assets aggressively. A `build` without `clean` reuses cached assets.

**Fix:** The yarn scripts use `clean build`. If using Xcode GUI:
1. Product → Clean Build Folder (Cmd+Shift+K)
2. Delete DerivedData: `rm -rf /tmp/peek-xcodebuild-sim /tmp/peek-xcodebuild-device`
3. Rebuild

### Wrong Library Architecture

**Symptom:** Build fails with architecture mismatch errors.

**Cause:** Debug library in Release folder or vice versa.

**Fix:**
```bash
# Clear both caches
rm -rf ~/misc/mpeek/tmp/ios-cache/debug
rm -rf ~/misc/mpeek/tmp/ios-cache/release

# Rebuild the correct one
yarn mobile:ios:cargo:debug    # For simulator
yarn mobile:ios:cargo:release  # For device
```

### Share Extension Not Saving

**Symptom:** Share extension appears but items don't save.

**Cause:** App Group mismatch or database path issue.

**Fix:**
1. Verify all three IDs match:
   - Main app: `com.dietrich.peek-mobile`
   - Extension: `com.dietrich.peek-mobile.share`
   - App Group: `group.com.dietrich.peek-mobile`
2. Check entitlements files in Xcode
3. Rebuild both targets

### Stale Build Cache

If changes to `AppGroupBridge.m` aren't reflected:

```bash
cd src-tauri
cargo clean
./build-ios.sh
# Rebuild in Xcode
```

### Share Extension Not Appearing

Check:
1. Bundle ID has correct prefix: `com.dietrich.peek-mobile.share`
2. Share extension Info.plist has correct NSExtension configuration
3. App Groups entitlements match between app and extension

### No Saved URLs Showing

Verify:
1. App Groups identifier matches in all three places
2. Both Rust (rusqlite) and Swift (GRDB) are accessing the same database path
3. Database is being created in the App Group container, not the app sandbox
4. Check database contents: `sqlite3 <path_to_peek.db> "SELECT * FROM urls;"`

### "Built for newer iOS version" Linker Warnings

**Symptom:** Dozens of linker warnings like `Object file (libapp.a[...]) was built for newer 'iOS' version (26.2) than being linked (16.0)`.

**Cause:** The Rust build compiled C objects (ring crypto, sqlite, AppGroupBridge) using the system SDK's default deployment target instead of the project's iOS 16.0 target.

**Fix:** Both build scripts (`build-ios.sh` and `build-release.sh`) must set `export IPHONEOS_DEPLOYMENT_TARGET=16.0` before `cargo build`. This is already done — if warnings reappear, check that the env var is still present.

### Xcode Points at Wrong Workspace

**Symptom:** Build fails with `search path '.../ios-fixes-XXXX/...' not found` or similar, pointing at a stale/removed clone directory.

**Cause:** Xcode's DerivedData caches `$(PROJECT_DIR)` from whichever workspace the project was first opened from.

**Fix:**
1. Quit Xcode completely
2. Delete stale DerivedData: `rm -rf ~/Library/Developer/Xcode/DerivedData/peek-save-*`
3. Reopen from the correct workspace: `open apps/mobile/src-tauri/gen/apple/peek-save.xcodeproj`

### Xcode "Update to Recommended Settings"

When Xcode prompts to update settings, accept all **except "Enable User Script Sandboxing"** — that would break the "Build Rust Code" run script phase which needs filesystem access outside the sandbox.

## License

See LICENSE file.
