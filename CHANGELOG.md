# Peek CHANGELOG

<!--
@marss
title: Peek Changelog
link: https://tangled.org/burrito.space/peek
feedUrl: https://tangled.org/burrito.space/peek/raw/main/docs/feed.xml
description: Recent changes to Peek
-->

Completed work, grouped by week of year.
- See TODO.md for pending items, WIP.md for in-progress items

Newly done items go here, grouped under level-2 headings by week (date = Monday of that ISO week).

## 2026-02-16

Desktop - Command Palette
- [x] feat(cmd): generic command chaining with pipe system (597)
- [x] feat(cmd): replace embedded chain editor with popup window system (572)
- [x] feat(cmd): add parameter suggestions to command palette (693)
- [x] feat(cmd): add noun registration API for declarative command generation (191)
- [x] fix(cmd): remove download cmd, fix save filename, fix dialog parent, unify hashtag extraction (5b95)
- [x] fix(cmd): preserve noun routing metadata in command registry pipeline (39a4)

Desktop - Entity Recognition
- [x] feat(entities): add observation frequency ranking — Phase 1 (803)
- [x] feat(entities): add thumbs up/down feedback for entity quality scoring (c0e)

Desktop - Tags
- [x] feat(tags): add rename and delete tag operations (ac2)
- [x] fix(tags): add protocol 404 logging, handle all item types, fix filter counts (403e)

Desktop - Display Switching
- [x] refactor(display-watcher): replace 3-phase algorithm with safety-net-only approach (afa)
  - Gutted 881-line 3-phase algorithm, replaced with 304-line single-pass safety net
  - Lets macOS handle display migration natively, only rescues genuinely orphaned windows

Desktop - Page View & Dragging
- [x] fix(page): filter Cmd+L/R/[/] pubsub by windowId so only active page window responds (657)
- [x] fix(page): fully end drag on webview mouseup to prevent overlay blocking clicks (a7b)
- [x] fix(page): handle webview mousemove during active drag for window movement (ac37)
- [x] fix(drag): remove data-no-drag from extension window bodies to restore hold-to-drag (63c1)

Desktop - Auth & URLs
- [x] feat(auth): OAuth popup bridge and flow improvements (c93)
- [x] fix(url): wait for frontend ready and session restore before processing external URLs (e7ab)

Testing
- [x] test(cmd): add completer unit tests; fix tag # prefix stripping (610)
- [x] test(cmd): add integration tests for command execution through pubsub (e11)
- [x] test(cmd): add command chaining pipe system tests (566c)
- [x] test(oauth): add OAuth bridge unit tests (77b)
- [x] fix(test): fix 4 stale test expectations in desktop smoke tests (4d9)

## 2026-02-13

Desktop - Session Restore
- [x] feat(session): implement full session save/restore system (Phases 1-4) (0e8afccd, f270c56d, d0150877, d2fb834a)
  - Phase 1: Snapshot all windows on quit (position, size, URL, mode)
  - Phase 2: Restore windows on startup with confirmation dialog
  - Phase 3: Autosave timer and manual session commands
  - Phase 4: Crash recovery dialog and error handling
- [x] fix(session): save settings windows, strip stale params on restore, fix display-watcher race conditions (d12bd2b9)
- [x] fix(session): suppress display-watcher during session restore to preserve window positions (c32b73df)
- [x] fix(session): handle SIGINT/SIGTERM as clean shutdowns to prevent false crash dialog (f56f5624, 8ab6d36d, 16a2d4bc)
- [x] fix(session): synchronous SIGINT save and correct canvas page bounds (2df8a733)
- [x] fix(session): open startup feature when restore is declined or fails (0f280143)

Desktop - Display Switching
- [x] feat(display): reposition windows when displays change (d732fa79)
  - Pre-debounce bounds capture preserves window positions before OS moves them
  - Group-based distance scaling for proportional repositioning
- [x] fix(display-watcher): add home display tracking to restore windows after display reconnect (60b0798d)
- [x] fix(display): use group-based distance scaling for window repositioning (11166190)

Desktop - Entity Recognition
- [x] feat(entities): show source pages in entity list and add detail pane with full metadata (12feb902)
- [x] fix(entities): improve detection coverage and reduce price noise (82b70037)
- [x] fix(entities): migrate out standalone price entities lacking product context (383202ae)
- [x] fix(entities): require context for date entities, migrate out standalone dates (6ada27ba)

Desktop - Command Palette
- [x] feat(cmd): add command chaining flow for list notes, markdown, download, save as note (04ef4c8a)
- [x] feat(cmd): add "open file" command with chaining + fix note inline tag extraction (0717e87b)
- [x] fix(cmd): remove web search fallback on Enter — require explicit command match (49c6e5ec)
- [x] fix(cmd,perf): sort history by frecency, use targeted queries for URL lookups (0873e5ee)
- [x] fix(cmd): restore web page URLs in frecency suggestions (65baa072)
- [x] fix(cmd): ESC clears text first, Shift-Tab cycles backward, fix frecency tracking (8f6b41a8)
- [x] fix(cmd): register IZUI escape handler so ESC clears text before closing (80592eb0)
- [x] fix(cmd): remove prefix feedback that caused adaptive sort cross-contamination (5ceb0517)
- [x] fix(cmd): add deterministic tiebreaker to command palette sort for consistent autocomplete (566b63a8)

Desktop - Page View & Navigation
- [x] feat(page): replace fullscreen transparent window with minimal page host (c543e38b)
- [x] fix(page): eliminate navbar show/hide webview jump (43c9353e, 982f6a10, 083fbdf9, bd0449db)
- [x] fix(page): restore webview drag with mousedown/mouseup bridge from guest page (63cd1414)
- [x] fix(page): remove broken click-through code that activated unrelated windows (10f29146)

Desktop - Window Dragging
- [x] fix(drag): rewrite window drag system v3 — unified, faster, works everywhere (5a7c7899, fa58f66b, 1f815b61)

Desktop - HUD & Groups
- [x] fix(hud): hide on app blur using did-resign-active (be05026c)
- [x] fix(groups): fix group creation via inline form (141829f7)
- [x] fix(tags): restore reactivity on sync and data changes (60eb36df)
- [x] fix(tags/groups/cmd): fix item icons, group creation form, and tagset detection (5b0ca938)

Desktop - Dark Mode & Settings
- [x] fix(darkmode): respect OS color scheme in system mode (6813ea5f)
- [x] fix(websearch): fix suggestions, default engine setting, and settings UI (bcaeb205)
- [x] feat(websearch): add Kagi as built-in search engine (e7d05c94)
- [x] fix(settings): add descriptions and human-readable labels to core settings (0bfe87b9)
- [x] fix(settings): quit shortcut default reset, editor portrait, datastore table fix (f6a16ad4)

Desktop - Fixes
- [x] fix(mode,window): fix mode leak into global scope and bring existing windows to front (9b783b6b)
- [x] fix(shortcuts): silence spurious warnings when unregistering global shortcuts during shutdown (7941b5f6)
- [x] fix(cmd): ensure command registration after extensions loaded (3f9df015)
- [x] refactor(cmd): remove cmd:ready/query boilerplate, register commands directly (f7306de6)
- [x] feat(components): add sorting and view modes to card grid toolbar (83a85332)
- [x] fix(rss): use tangled.org URLs, fix localsearch manifest loading (06afcb89)

Testing
- [x] test(session): add 67 real integration tests for session save/restore (49f094f7)
- [x] test(display-watcher): add tests for pre-debounce capture, suppress timer cancellation, and isRemoval flag (fd56204f)
- [x] test: add 94 new unit tests and fix 3 E2E test failures (2251f86f)

## 2026-02-11

Desktop - New Extensions
- [x] feat(websearch): implement web search extension with OpenSearch discovery and suggestions (bf488889)
  - Search from command palette with live suggestions from multiple engines
  - Auto-discovers OpenSearch endpoints on visited pages
  - Widget notification in page view when OpenSearch engine found
- [x] feat(search): implement unified search extension (4b95973d)
- [x] feat(pagestream): implement vertical history stream extension (35f9afcc)

Desktop - History Unification
- [x] refactor(history): unify address/visit system into items table (6 phases) (475e97fe..6f90f258)
  - Phase 1-2: Remove dual-write, redirect renderer address APIs to items
  - Phase 3-4: IPC compatibility layer, update tests and URL normalization
  - Phase 5-6: Update Tauri backend, remove legacy address/visit code and types

Desktop - Dark Mode
- [x] feat(darkmode): implement 3-tier dark mode system for web pages (ef242dde)
  - Tier 1 (System): Sets prefers-color-scheme: dark for all webviews
  - Tier 2 (Force): Chromium WebContentsForceDark with CIELAB inversion
  - Settings UI with Off/System/Force selector

Desktop - Page View & Navigation
- [x] feat(page): add browser navigation hotkeys and editable URL bar (52a99ec7)
  - Cmd+R reload, Cmd+[/] back/forward, Cmd+L to edit URL
- [x] feat(page): add widget system with OpenSearch discovery notification (ce5ae4bb)
- [x] fix(page): improve drag-from-anywhere with long-press detection and all-corner resize (d135cfa6)
- [x] fix(page): apply background detection to non-canvas web pages (e1ac7b6f)
- [x] fix(nav): restore full-width navbar — remove floating bubble design (7769f1e1)
- [x] fix(titles): fix Loading... title bug, add page content extraction and URL metadata enrichment (61ca6f00)
  - Filter "Loading..." from stored titles across all code paths
  - Add extract-page-content IPC handler for live page HTML extraction
  - URL item metadata enrichment with OG tags, description, favicon

Desktop - Tags & Editor
- [x] feat(tags): embed editor in detail pane for inline note editing (a575013e)
  - Replace modal with inline detail view, ESC navigation between list and detail
  - Vim status/command bar overlaid on editor, respects vim mode preference
- [x] feat(tags): add content search with tag combo filtering, pin selected tags in sidebar (d005d3dd)
- [x] fix(editor,tags): fix note command blank editor, tags reactivity, and editor height (cb4d5e10)
  - New notes create datastore items immediately for autosave
  - Tags UI subscribes to item:updated events for live reactivity
- [x] fix(editor): forward ESC to vim in insert/visual mode before IZUI handles it (7b866e87)
- [x] fix(tags): editor layout, vim status bar positioning, and focus ring cleanup (08483e4e, 3100ec71, 3a072f24)

Desktop - Shortcuts & Commands
- [x] feat(shortcuts): implement dual hotkey registration — local Cmd+ alongside global Opt+ (545e95b4)
  - Cmd+K (palette), Cmd+E (editor), Cmd+T (tags), Cmd+G (groups), Cmd+H (HUD)
  - Fix: Cmd+Q quit, Cmd+, settings (were incorrectly using Opt+)
- [x] feat(api): implement commands.list() to query registered commands via pubsub (696c7859)
- [x] fix(cmd): fix frecency/adaptive sorting in command palette (2f6da3fd)
  - Unified weighted ranking combining adaptive score and frecency
  - Cross-query adaptive feedback for substring matches

Desktop - Settings & Extensions
- [x] fix(settings): rework extensions settings — rename sections, unify layout, add options buttons (cb540409)
  - Rename: Features (Peek extensions) vs Extensions (bundled webextensions)
  - Options button for extensions with options pages
- [x] fix(settings): dynamically list all builtin extensions in Features section (90fe93d0)
- [x] feat(chrome-ext): generic settings/UI system for bundled Chrome extensions (edbf5169)
- [x] feat(adblocker): migrate from @cliqz/adblocker-electron to @ghostery/adblocker-electron (93b44561)

Desktop - Fixes
- [x] fix(windows): HUD focus stealing, chrome ext options styling, duplicate group cards (47686da7)
- [x] fix(groups): prevent duplicate windows/URLs, fix race conditions and title resolution (20cb9956)
- [x] fix(hud): resolve extension disabled by settings key collision (671df42e)
- [x] fix(context): resolve window ID from caller when null, set mode before loadURL (c1d77f28)
- [x] fix(entities): align UI with groups/tags component and theme patterns (c5df43bc)
- [x] fix(scripts): align UI with groups/tags component and theme patterns (50c639ff)
- [x] fix(editor): use extension settings API for vim mode, audit localStorage usage (3962110b)
- [x] fix(build): pin Node version to 24.11.1 to match Electron 40 (96c05941)

Testing
- [x] test(history): add unified URL/history tests for unification refactor (d3ac05f7)
- [x] test(entities): add comprehensive test data for entity recognition (d710d039)

## 2026-02-09

Desktop - IZUI Role-Based Redesign
- [x] feat(izui): systemic ESC handling, peek-component migrations, HUD test fixes (21d59cc0)
  - Migrated peek-card, peek-grid, peek-list to shared peek-components
  - Unified ESC key handling across all window types
  - Fixed HUD test infrastructure
- [x] feat(izui): implement role-based window policy (Phase 1-2) (3fbcade9)
  - Replaced session-based transient/active detection with deterministic role system
  - Five roles: root, child-content, child-tool, hud, transient
  - Role assigned at window creation, governs ESC behavior and lifecycle
- [x] feat(izui): complete role-based migration (Phase 3-6) (8528f053)
  - Migrated all window creation sites to use role-based policy
  - Removed legacy IzuiStateCoordinator session tracking
  - ESC behavior fully determined by window role
- [x] fix(izui): promote content to child-content when opened from parent window (92d359c5)
- [x] fix(izui): promote transient session on app focus, fix startup role (055b77ed)

Desktop - Navigation & UI
- [x] fix(nav): restore floating nav bar — remove embedded regression (93060df3)
- [x] fix(peek-card): delegate click/focus through shadow DOM boundary (b15c6434)
- [x] feat(tags): migrate tags UI to shared peek-components (3145a08a)
  - Tags extension uses peek-card, peek-grid from shared component library
  - Consistent styling across all card-based views
- [x] fix(config): align startupFeature schema default with actual default (aab2b20b)
- [x] fix(external-url): delay URL processing to ensure app activation completes (f0d1e5bd)

Desktop - Entity Recognition
- [x] feat(entities): implement Phase 1 entity recognition extension (ae0cd811)
  - Extract entities (people, places, dates, etc.) from saved items
  - Extensible matcher and store architecture
  - Unit tests for extractors, matcher, and store

Desktop - HUD & Groups
- [x] fix(hud): populate mode, active window, and stats fields (be18f49f)
- [x] fix(groups): preserve group context through page navigation (1d69ce8f)
- [x] fix(datastore): disable FK checks during entity type migration (98025bcc)

Desktop - Shortcuts & Page
- [x] fix(shortcuts): guard ev.reply() against destroyed senders + add roundtrip tests (49b626e9)
- [x] fix(shortcuts): use BrowserWindow ID not WebContents ID for shortcut callbacks (d6fe8cbf)
- [x] fix(shortcuts): resolve stale IPC reference in global shortcut callbacks (221d5a44)
- [x] fix(page): content-sized BrowserWindow instead of fullscreen canvas (2eb7a703)

Desktop - Command Bar
- [x] fix(cmd): restore URL detection for domains without protocol (youtube.com) (8abf13b6)

Sync Architecture - syncSource Migration
- [x] feat(sync): Phase 1 - separate sync pull from user operations (b3cbb47e)
  - Sync pull is now architecturally separate from user-facing operations
  - Server _sync metadata preserved naturally without guards
- [x] refactor(sync): remove syncSource from unified sync module and update docs (3ffa9bf1)
  - Removed syncSource column from schema and all datastore code
  - Replaced with device ID tracking via _sync metadata in item metadata JSON
- [x] refactor(mobile): remove active sync_source usage from iOS sync (3ca335f0)
- [x] feat(mobile): add device ID and _sync metadata to mobile backend (abc40815)

Mobile / iOS
- [x] feat(ios): native inline WKWebView + fix dev build pipeline (ac1154e7)
- [x] fix(ios): separate dev/release build paths and enable media autoplay (50444786)
- [x] fix(mobile): prevent white flash when opening inline webview (edc1b5b9)
- [x] fix(mobile): tighten header layout alignment (6f639e85)
- [x] fix(ui): editor overlays fill to keyboard, tagset cards use tag chips (bb032a08)
- [x] fix(mobile): replace Once::call_once with retryable Mutex for DB init (bb02d535)
- [x] feat(mobile): hide from:history items from default list view (c6acfc60)
- [x] fix(build): separate derivedDataPath for simulator and device builds (d6870291)
- [x] fix(build): add --standalone flag to embed real frontend in iOS builds (90c7f5d8)

Testing
- [x] test(cmd): add comprehensive URL detection tests for command panel (ccc5a13b)
- [x] test(server): add syncSource migration simulation tests (72731acf)
- [x] test(entities): add unit tests for extractors, matcher, and store (8759b707)
- [x] test(groups): add mode context propagation tests (5fbcc1ca)
- [x] feat(test): deterministic profile IDs via PEEK_PROFILE_ID env var (7c61aa6e)
- [x] fix(test): run unit tests under Electron's Node to match native module ABI (e1e0c7c5)
- [x] fix(server): enable single-user mode for e2e tests (c6c249b5)

## 2026-02-02

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
- [x] fix: unit tests run under Electron's Node (ELECTRON_RUN_AS_NODE=1) to match native module ABI
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

## 2026-01-26

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

## 2026-01-19

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

## 2026-01-12

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
