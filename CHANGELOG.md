# Peek CHANGELOG

Completed work, grouped by week of year.
- See TODO.md for pending items, WIP.md for in-progress items

Newly done items go here, grouped under third-level headings by week of year.

### 2026-W06

Desktop - IZUI (Inverted Zooming User Interface)
- [x] feat(izui): implement IZUI state machine for transient vs active window behavior (457ce41d)
  - Centralized `IzuiStateCoordinator` manages session-based state tracking
  - Fixes cmd bar stuck on "group" mode when invoked transiently
  - Fixes ESC from overlay showing groups instead of returning to previous app
  - Transient state propagates to child windows (cmd -> overlay)
  - Uses `isFocused()` for accurate system focus detection
  - KeepLive windows re-evaluate transient state on each show
  - Added `api.izui.*` renderer API for querying state
  - 54 unit tests with dependency injection for testability
  - See `docs/izui.md` for full documentation
- [x] fix(izui): OS-level focus for transient detection + graceful test shutdown (e1764328)
  - Transient detection uses OS-level app focus (`app.isFocused`) instead of window visibility
  - Tests use graceful `app.quit()` instead of SIGTERM/SIGKILL (no more crash dialogs)
  - 5 new IZUI behavior tests for real app focus scenarios
- [x] refactor(izui): passive backend window manager - extensions use api.window.open() directly (188894c4)
  - Backend no longer creates windows for extensions; extensions open their own via API
  - Simplifies window lifecycle and reduces coupling
- [x] fix(izui): child windows always close on ESC + center windows on screen (b0d07b89)
  - ESC policy: child windows always close, active root windows do not
  - All new windows centered on screen at creation
- [x] fix(izui): visibility-based transient detection + active mode ESC protection (d74b62b5)
- [x] feat(izui): center child windows over parent window (bd947dbc)
  - Parent window position/size used to calculate centered placement
  - Focus restored to parent on child close
- [x] fix(izui): renderer-driven escape lifecycle for navigate mode windows (dc470b7f)
- [x] fix(izui): fix ESC navigation, window drag, and navbar cleanup (3ca4841b)
- [x] fix(izui): fix transient detection race condition (d634a52b)
- [x] fix: clean up modes, remove overlay, fix IZUI navigation stack (6be5fc45)
- [x] fix(groups): filter peek:// URLs and fix IZUI stack navigation (70ab1706)
- [x] cleanup(overlay): remove vestigial overlay references and rename events (16402840)
- [x] fix(main): remove non-existent overlay from CONSOLIDATED_EXTENSION_IDS (518c4406)

Desktop - Reactivity & Events
- [x] feat(reactivity): add tag-centric events for real-time UI updates (8c229cdf)
  - `tag:created`, `tag:item-added`, `tag:item-removed` events
  - Extensions can subscribe to tag changes for live UI updates
- [x] feat(reactivity): item CRUD events, debouncing, history/feeds subscriptions (1d351083)
  - `item:created`, `item:updated`, `item:deleted` events
  - Debounced event emission to prevent UI thrashing
  - History and feeds extensions subscribe to relevant events
- [x] feat(datastore): implement item_events table and CRUD operations (78950782)
- [x] feat(preload): expose item_events API to renderer (f8f85ebc)

Desktop - Window Management
- [x] feat(window): add overlay mode for transient full-screen views (0727112b)
- [x] fix(windows): hide other windows AFTER windows view opens (37ee7d43)
- [x] fix(windows): ESC always closes, remove fallback emoji (3fddd1a6)
- [x] refactor(windows): transparent bg with groups/tags card style (414e2139)
- [x] refactor(windows): use peek-card and peek-grid components (666efa8d)
- [x] fix(windows): use correct path for component imports (8b6686e4)

Desktop - Architecture & Modes
- [x] feat(context): add app-wide context API for extensible mode management (196a12d0)
- [x] refactor(modes): remove modes.ts, consolidate into context API and datastore (5943e223)
- [x] refactor(modes): remove settings mode and minor modes (simplify to page/group/default) (eab54a3f)
- [x] feat(schema): add feeds and series architecture (8688c501)
- [x] feat(feeds): add feed reader extension and API documentation (44c5b507)

Desktop - Editor & Commands
- [x] feat(editor): implement note editing flow with autosave (0ae56bb7)
- [x] feat(cmd): restore mode indicator to command bar (from orphaned commits) (917640ca)
  - Shows current mode (page/group/settings)
  - Click to cycle through modes
  - Auto-hides when in default mode
- [x] feat(cmd): add Sync now command for manual sync trigger (18d02d2c)
- [x] refactor(cmd): use connector pattern for edit and note commands (48465f72)
- [x] fix(cmd): url command returns error instead of opening editor when no URL provided (5141fb07)

Desktop - UI & Components
- [x] feat(components): add glass-morphism tokens and component modes (7b2e52dc)
- [x] fix(ui): center card headers, disable URL input autocapitalize, fix dev script (aa578e0d)
- [x] fix(page): set default background on webview content when page has none (9fc274ab)
  - Respects system theme (dark/light)
  - Only applies when page doesn't set its own background
- [x] fix(page): use trackNavigation for URL visit recording (f2677891)

Desktop - Profiles & Startup
- [x] feat(profiles): add Chromium session partition isolation per profile (2d704158)
- [x] fix(profiles): register peek:// protocol on profile session (cd80de8d)
- [x] fix(startup): respect startupFeature pref instead of always opening settings (5b920fab)

Desktop - Fixes
- [x] fix: ESC handling for Active mode windows (IZUI policy compliance)
- [x] fix: add getFocusedVisibleWindowId API for modal window targeting
- [x] fix: add trackNavigation API for unified page load tracking
- [x] fix: update test to use peek://ext/cmd/panel.html (correct URL after cleanup)
- [x] fix: window-list returns actual URLs from peek://app/page containers
- [x] fix: mode detection from URL in window creation
- [x] fix: add native module check script (prevents NODE_MODULE_VERSION mismatch)
- [x] fix(ipc): cast address to string for type safety (32a7f8a0)
- [x] fix(ipc): sanitize window params to prevent serialization crash (fca6a26f)
- [x] fix(build): exclude tmp/ agent workspaces from electron-builder (f0f26e31)
- [x] fix(build): electron-builder uses yml config via extends (4620155f)
- [x] fix(url): normalize trailing slash on bare domain URLs (3c2bbd61)

Mobile / iOS
- [x] feat(mobile): add URL action icons with native WKWebView + visit tracking (ee06ef99)
  - Open in Browser: opens URL in Safari
  - Open in Webview: opens URL in embedded native WKWebView
  - Track visits when URLs are loaded/navigated in webview
- [x] fix(webview-plugin): simplify Swift integration with direct FFI (18258830)
- [x] feat(mobile): fix native webview and restore icon system (1b641ed1)
- [x] fix(ios): require hold gesture for pull-to-refresh (prevents accidental triggers) (0efb4445)
- [x] feat(ios): bottom sheet webview + research docs (80fb7d8f)
- [x] feat(webview): card-expansion iframe overlay replaces native bottom sheet (eb43f135)
- [x] fix(ios): silence linker warnings and remove unused default icons (8cd36323)
- [x] fix(ios): UX polish pass - 18 fixes for editor, share extension, layout, build (cf5fe38b)
- [x] fix(ios): UX polish - 13 fixes for share sheet, editor, keyboard, sorting, filters (956fdcb8)
- [x] fix(ui): maximize editor card space - tighter padding, remove separator, expand to edges (2a0fc4bf)
- [x] fix(ui): undo/redo at top, reduce gaps, add webview link for text items (90d76c51)
- [x] fix(share): commit pending tag text when Done is tapped (712a5108)
- [x] fix(build): use dynamic DerivedData path for sim:install (94420c17)

Testing
- [x] feat(tests): add Playwright browser extension e2e tests
- [x] fix(tests): improve extension ID detection and shared instance handling
- [x] fix(tests): remove Firefox Playwright support (not supported by Playwright)
- [x] test: add integration tests for tag-centric events (ed9dd17a)

Refactoring
- [x] refactor(extensions): move tag and tagset commands to tags extension (d6636aaa)
- [x] refactor(extensions): create files extension with csv and save commands (435cc952)
- [x] refactor(extensions): create sync extension with sync command (e5867452)

Datastore & UI
- [x] fix(datastore): show addresses/visits/tags stats with safe error handling
- [x] fix(datastore): extract stats from result.data wrapper
- [x] chore: clean up settings and diagnostic UI

Code Cleanup
- [x] chore: remove vestigial app/cmd/ directory (24 files, replaced by extensions/cmd/)
- [x] chore: remove app/scripts/ (disabled feature with missing HTML files)
- [x] chore: remove dead functions from app/index.js (uninitFeature, initIframeFeature)
- [x] chore: remove Cmd and Scripts entries from app/config.js (non-existent URLs)
- [x] chore: simplify app/features.js (all features are now extensions)
- [x] chore: remove commented-out sendToWindow/onMessage APIs from preload.js
- [x] chore: remove 7 unused IPC handlers from ipc.ts (~155 lines)

### 2026-W05

Server
- [x] feat(server): add single-user mode support (no auth required for solo use)
- [x] feat(server): add storage abstraction layer for image handling
- [x] feat(server): add SQL abstraction layer for database portability

Extension
- [x] feat(extension): add command bar popup with tag, note, search
- [x] feat(extension): add Alt+P hotkey for command bar popup
- [x] feat(extension): simplify command bar popup UI
- [x] feat(extension): add e2e sync tests and preserve original timestamps

Desktop - Fullscreen Canvas
- [x] feat(page): implement fullscreen transparent canvas architecture
- [x] feat(page): fullscreen transparent canvas with floating navbar
- [x] fix(navbar): prevent hiding when hovering over gaps between child elements

Desktop - IZUI / ESC Handling
- [x] feat(izui): add minimal IZUI window navigation system
- [x] feat(izui): complete ESC key handling with IZUI integration
- [x] feat(izui): navigation stack for ESC in child windows
- [x] feat(izui): complete preload API wiring for ESC key handling
- [x] feat(esc): change default escapeMode from 'close' to 'auto'
- [x] fix(izui): overlay no longer steals ESC from web pages
- [x] fix(esc): web pages now close on first ESC key press
- [x] feat(cmd): add mode indicator to command bar

Mobile
- [x] feat(mobile): improve item card UI and keyboard stability
- [x] feat(mobile): migrate tags.id from INTEGER to TEXT for sync compatibility
- [x] fix(mobile): prevent orphaned databases and ensure dev profile in dev builds
- [x] fix(mobile): resolve deadlock and respect profile choice in dev builds
- [x] fix(sync): filter out peek:// URLs from server sync

Schema & Data Layer
- [x] feat(schema): add schema codegen system with single source of truth
- [x] feat(schema): integrate codegen into build system with Rust backend tests
- [x] feat(schema): comprehensive test coverage for generated types
- [x] chore(server): align Node engine to repo-wide v22 policy

Testing Infrastructure
- [x] test(components): add component test infrastructure
- [x] test(components): expand coverage to 56 tests with deterministic waits
- [x] docs(components): add Testing section to README
- [x] fix(tests): consolidate packaged tests to single Electron instance

Editor
- [x] feat(editor): integrate CodeMirror markdown editor with three-panel layout
  - Outline sidebar with header navigation
  - Live markdown preview sidebar
  - Vim mode toggle (persisted in settings)
  - Resizable panels, focus mode
  - Full syntax highlighting
- [x] feat(editor): add vim fold commands, status line, and comprehensive tests

Web Extensions
- [x] feat(web-ext): add bundled web extensions infrastructure
- [x] feat(extensions): bundle Consent-O-Matic for automatic cookie consent handling
- [x] docs: add research on bundled web extensions (uBlock, Proton Pass, Consent-O-Matic)
- [x] Integrated @cliqz/adblocker-electron for native ad blocking

Mobile / iOS
- [x] feat(mobile): add Release CLI builds via xcodebuild
  - Fix Share Extension configuration inheritance (CONFIGURATION=Release override)
  - Add yarn mobile:ios:xcodebuild:release command
  - Add yarn mobile:ios:xcodebuild:install:release command
- [x] feat(tests): iOS e2e testing improvements and window utilities
  - Add PEEK_AUTO_SYNC env var support
  - Add --headless and --build flags to e2e-full-sync-test.sh
- [x] docs: add research on xcodebuild CLI vs Xcode GUI environment issues

Developer Tooling
- [x] chore: add multi-agent workflow with jj workspaces
- [x] chore: update agent-setup to handle both install and update
- [x] docs: add CLAUDE.coordinator.md for coordinator agents
- [x] docs: update jj workflow - always commit before operations

### 2026-W04

- [x][desktop] history & addressability: track peek:// loads, all window/webview loads, in-page navigation, JS window.open child windows (mkylrnxy)
- [x][desktop] history chaining: prevId/nextId columns on visits table with migration backfill (mkylrnxy)
- [x][desktop] history API: getHistory() with date range filtering, enriched visit+address join query, IPC + preload exposure (mkylrnxy)
- [x] add device ID tracking to item metadata (swskpulq)
- [x] app version and datastore version as separate layers of compatibility (rltmkytv)
- [x] define compat detection system across desktop/server/mobile/other (rltmkytv)
- [x] define how sync works when incompatible (clients only sync w/ datastore-compatible nodes) (rltmkytv)
- [x] sync is not spoke server - all nodes equal participants (rltmkytv)
- [x] implement version compat in desktop/server (DATASTORE_VERSION + PROTOCOL_VERSION, exact match, 409 on mismatch) (rltmkytv)
- [x] implement version compat in mobile (add version headers to lib.rs sync) (rlrlqkqz)
- [x][mobile] fix sync re-pushing all items every time - per-item synced_at (nxszorty)
- [x][mobile] add version headers to mobile sync - DATASTORE_VERSION + PROTOCOL_VERSION (rlrlqkqz)
- [x][desktop] add new items - url/tagset/note commands (pwuyrstl)
- [x][desktop] editor extension with full note editing (rmztsrkr)
- [x][tauri] sync module, schema migrations, version compat to match Electron (zzyllzsk)
- [x] e2e sync & version test suite, fix sync profile resolution (rlrlqkqz)
- [x][mobile] fix share extension creating duplicate items per tag (yvumsuqr)
- [x][mobile] merge home and search into unified view, configurable archive tag (txzkumku)
- [x][mobile] fix big bottom bar showing again (tqnmowqm)
- [x][mobile] iOS profile support with build detection and per-profile databases (ylkwxtut)
- [x][mobile] UUID-based profile sync across mobile, desktop, and server (mlqntkvw)
- [x][mobile] iOS share extension fixes + tag input filtering (smuxwlzx)
- [x][mobile] consolidate editor views with shared components (wvvqrquo)
- [x][mobile] add clear buttons to all input fields and textareas (vyuwkrpy)
- [x][mobile] fix tags not persisting on text notes (qowppxlk)
- [x][mobile] add archive tag support to hide items from views (urmmzrvr)
- [x][mobile] add font size slider in settings with realtime preview (umqpnqto)
- [x][mobile] mobile editing ux - toasts, validation, draft persistence, spacing, bottom bar fix (rqwmmpnm)
- [x][mobile] pull-to-refresh gesture triggers sync (roqqsxyp)
- [x][desktop] window titlebar hide/show pref with settings UI (wpykxvrl)
- [x][desktop] windows movable and resizable by default with window.open API params (wpykxvrl)
- [x][desktop] persist keyed/url window position+size across app restarts (wpykxvrl)
- [x][desktop] pin window on top (app and OS level) with commands (wpykxvrl)
- [x][desktop] configurable escape behavior per-window via window.open API (wpykxvrl)
- [x][desktop] window animation API (to/from coords, time) + slides impl (wpykxvrl)
- [x][desktop] Desktop Windows - title bar, persistence, pin controls, animations (wpykxvrl)
- [x][desktop] migrate old addresses to items table, fix CHECK constraint (ltovmzon)
- [x][desktop] multi-tag search in tags UI (ltovmzon)
- [x][desktop] extension nav styling improvements (ltovmzon)
- [x][desktop] fix groups extension - add visit tracking, filter for URLs only (wuywuwyn)
- [x][desktop] fix sync status in settings UI - use correct field name for display (xxtpswys)
- [x][desktop] persist autoSync setting in extension_settings (vyvorvtq)
- [x][desktop+server] add sync version compatibility - DATASTORE_VERSION + PROTOCOL_VERSION (rltmkytv)
- [x][desktop+server] add user profiles and profile switching (qlyszyzx)
- [x][desktop] add tags extension for tag visualization and management (kwuwspun)
- [x][desktop] click-and-hold window dragging for frameless windows (myyozwzx)
- [x][desktop] fix better-sqlite3 node/electron version mismatch with postinstall script (mmywmysr)
- [x][desktop] debug and stabilize build on new Electron (stale node_modules after upgrade) (kszpuvqr)
- [x][desktop] upgrade Electron to 40 + pin Node to 24 (kszpuvqr)
- [x][desktop] e2e sync test infrastructure for production (snrnkvls)
- [x][desktop] daily data snapshots saved to compress archives in ~/sync/peek-backups (qkpozntl)
- [x][desktop] fix 5GB packaged build by adding exclusions to electron-builder.yml (~280MB now) (qknnlynl)
- [x][desktop] update release build and drive it (rlytpznn)
- [x][security] remove production server endpoint from source - require env config (rnxppwkx)
- [x][server] Add pre-migration backup to server migration (uvkkmoos)
- [x][server] add daily snapshot backups on server, test locally, deploy, test and confirm working on railway (vpvuotkr)
- [x][server] document Railway deployment info so agents don't have to relearn each time (wlwruzuq)
- [x][sync] fix duplicates: add sync_id parameter for server-side deduplication (yswsyzvl)
- [x][sync] investigate remaining sync edge cases (purnxzzz)
- [x][sync] E2E integration tests for desktop-server sync (uowlzlxm)
- [x] data model: multi-user support (server full, desktop profile isolation) (qlyszyzx)
- [x] desktop sync working (bidirectional in backend/electron/sync.ts) (mxwrymlv)
- [x] sync config in settings UI (vyvorvtq)
- [x] windows draggable/moveable (click-and-hold in app/drag.js) (myyozwzx)
- [x] notes in datastore (items table with type='text') (xxnxwnwx)
- [x] peek-node supports text/urls/tagsets/images (xxnxwnwx)
- [x] backup/restore snapshots (daily automated + manual) (zuzylokr)
- [x] action history storage (visits table) (wuywuwyn)
- [x] update main README (kpylorrl)
- [x][mobile] shared iOS build cache to avoid Rust rebuilds across agent workspaces (nputkypr)
- [x][mobile] update to full bidirectional sync (pull + push, not just webhook push) (otsvqvzo)
- [x][workflow] agent workspace isolation - rules to stay in workspace, no parent repo access (lorkrruo)
- [x][workflow] fix divergent commits - mmerge uses jj new+restore pattern (zponttxz)
- [x][workflow] Railway deploy scripts - npm/yarn scripts with --service flag (zponttxz)
- [x][workflow] fix TODO archival - updated agent templates with clearer instructions (uytsrstx)
- [x][workflow] clarify ./app rule - now about respecting front-end/back-end architecture boundary (tkvzpvlu)
- [x][workflow] restore git/github push for Railway deploys (vkrunkpn)
- [x][workflow] fix jj commit/merge strategy - agents no longer touch main bookmark (srmykyqy)

### 2026-W03

- [x][desktop] settings UI for sync (vyvorvtq)
- [x][desktop] test sync and package (ssxzpoxo)
- [x] merge peek-node into peek repo (now at backend/server/) (zturryym)
- [x] update peek-node to support multi-user and the core types (already done) (zturryym)
- [x] unify data model across mobile/desktop/server (nlxqykul)
- [x] sync working between all three (mxwrymlv)
- [x][mobile] test and deploy ios to prod (rtmtkykn)

### Old completed items

### Addressability / Core history
- [x] add peek:// loads to history table (mkylrnxy)
- [x] peek urls don't need params yet, but we'll need to do cmd params and connector data somehow maybe (mkylrnxy)
- [x] ensure all window/frame/webview loads of any kind are entered in history (mkylrnxy)
- [x] bug: some link clicks in web pages open in a window with a title bar that's clearly not entered in peek's window tracking, maybe js in the page opening windows? (mkylrnxy)
- [x] sync: don't sync peek addresses for now (mkylrnxy)
- [x] not doing paths/forking yet - is just one single chain of actions (mkylrnxy)
- [x] add next/prev cols to history table, or maintain in new table? (mkylrnxy)
- [x] when a history record is added, set prevId pointing to previous history record (mkylrnxy)
- [x] each time a history record is added, set nextId to its prevId (mkylrnxy)
- [x] enumerate history (mkylrnxy)
- [x] filter on date ranges (mkylrnxy)

### Server Backend
- [x] Add database integrity verification (uvkkmoos)

### Base Extensions
- [x] see notes/extensibility.md
- [x] window manager views (bad name, but what Peek "features" are now)
- [x] commands (eg Quicksilver, Ubiquity, Raycast style)

### Portability
- [x] Abstract back-end system
- [x] Electron back-end
- [x] Tauri back-end

### Pages, Tagging & Groups
- [x] Open page by default in cmd
- [x] Open page from OS, other apps
- [x] Cmd to tag current page
- [x] Groups based on tags, for now
- [x] Untagged -> default group
- [x] Cmd to open groups home
- [x] Escape for navigating back up the group views, not closing window
- [x] adaptive matching
- [x] frecency

### V.0.3 - Datastore
- [x] Datastore

### v0.2 - MVCP
- [x] app showing in dock even tho disabled
- [x] app not showing in tray, even tho enabled
- [x] all api calls get source attached
- [x] window cache s/custom/map/
- [x] window cache all windows not just persistent
- [x] window cache - evaluate key approach (use-case: apps need to identify windows they open)
- [x] always return window id, so apps can manage it
- [x] reimplement keys, so much easier for callers than managing ids
- [x] account for number of renderer processes (seems double?)
- [x] prototype window.open
- [x] evaluate webContents.setWindowOpenHandler
- [x] stop using openWindow to show pre-existing hidden windows?
  - [x] can track web windows locally
  - [x] can identify web windows on both sides (key/name)
  - [x] add new custom api for windows superpowers
- [x] collapse window opening to span both approaches
- [x] finish converting all openWindow to window.open
- [x] figure out single devtools window if possible

### v0.1 - MVPOC

minimum viable proof of concept.

question: would i use this?

Core moduluarization
- [x] Modularize feature types, eyeing the extensibility model
- [x] move settings window to features/settings

App cleanup
- [x] main window vs settings
- [x] change settings shortcut from global+esc to opt+comma

Window lifecycle
- [x] modularize window open/close + hidden/visible
- [x] update settings, peeks, slides, scripts
- [x] hide/show window vs create fresh
- [x] update slides impl to use openWindow (x, y)

Minimal Electron + Maximal Web
- [x] move features to all web code, with a couple special apis
- [x] make globalShortcut an api like openWindow

Create core app
- [x] core settings
- [x] registers other features

Move all features to web implementation
- [x] move all possible code from the electron file to the web app
- [x] move to web implemented globalShortcut
- [x] move to web implemented openWindow
- [x] move settings re-use code to utils lib
- [x] ability to add clickable links in settings panes
- [x] add links to Settings app
- [x] per-feature settings ui

Core+settings
- [x] move feature list and enablement to storage
- [x] merge core + settings
- [x] enable/disable features
- [x] configurable default feature to load on app open (default to settings)
- [x] wire up tray icon to pref
- [x] tray click opens default app

Core/Basic
- [x] basic command bar to open pages
- [x] fix setting layout wrapping issue

Commands/messaging
- [x] implement pubsub api
- [x] way to tell feature to open default ui (if there is one)
- [x] way tell feature to open its settings ui (if there is one)

Features cleanup
- [x] enable/disable individual slides, peeks
- [x] enable/disable individual scripts

Internal cleanup
- [x] s/guid/id/
- [x] fix label names, match to pwa manifest
- [x] put readable log labels back in
