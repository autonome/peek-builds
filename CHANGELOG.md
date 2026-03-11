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

## 2026-03-11

Desktop - IZUI Navigation
- [x] ESC at root opens Windows switcher — new `escUnhandledPolicy` second-phase policy for workspace windows in active/idle sessions
- [x] Preserve role/escapeMode across session restore — fix canvas mode check to not depend on role

Desktop - Editor
- [x] Add img tag rendering in preview — sanitized HTML img tags with attribute allowlist and protocol security
- [x] Support relative image paths and file:// protocol — resolve images relative to edited file via `peek://local-file/` protocol

Desktop - Groups
- [x] Restructure group detail view header — group name, edit icon, view mode buttons, and inline sort controls in compact layout
- [x] Remove colored dot from group header

Desktop - Shortcuts
- [x] Change Pagestream shortcut from Cmd/Ctrl+P to Cmd/Ctrl+Shift+P (avoids conflict with Print)

Desktop - Docs
- [x] Update README — rewrite intro, add desktop screenshot, Core/Features/Keyboard Shortcuts/Feature API sections
- [x] Rename extension terminology to features throughout docs and README
- [x] Rename docs/extensions.md → features.md, extension-modes.md → feature-modes.md, extension-settings-api.md → feature-settings-api.md

## 2026-03-09

Desktop - Extensions
- [x] Fix extension ID mismatch — config.js IDs now match manifest IDs, fixing websearch and other lazy-loaded commands
- [x] Fix ext:ready ordering — all extensions call init() before publishing ext:ready, fixing cold-start command execution
- [x] Assert-and-trust lazy loading — remove polling, resolve immediately on ext:ready with subscriber verification
- [x] Fix websearch BroadcastChannel origin mismatch — switch to IPC pubsub for cross-origin communication

Desktop - Windows
- [x] URL-based window dedup — opening same http/https URL focuses existing window instead of creating duplicate
- [x] Fix window centering on display switch — use cursor display instead of primary display
- [x] Fix download navigation — page stays loaded when clicking download links, cleanup blank popups

Desktop - Page View
- [x] Add link hover tooltip — status bar shows URL destination on webview link hover

Desktop - Search
- [x] Migrate search list view to standard peek-card components

Desktop - Groups
- [x] Add remove-from-group icon on URL item cards in group detail view

Desktop - Testing
- [x] Add Playwright tests for websearch commands, window URL handling, and download navigation

Mobile
- [x] Android safe area, dark mode, crash fix, launcher icons, editor layout, 16KB alignment
- [x] Dual simulator dev command, DRY item components, fix iOS/Android crate-type conflict
- [x] Fullscreen image tap, today/later toggle, markdown reader mode for notes

## 2026-03-07

Desktop - Extensions
- [x] Deterministic lazy extension loading — replace setImmediate with hasSubscriber verification, message buffering for stubs/interceptors, 10s safety timeout ([upxv](https://tangled.org/burrito.space/peek/commit/upxv))
- [x] Convert lex to noun system — single `lex` noun with query/create/browse replaces 176+ dynamic command registrations ([upxv](https://tangled.org/burrito.space/peek/commit/upxv))

Desktop - Page View
- [x] Tags widget updates reactively when tags added/removed via commands ([upxv](https://tangled.org/burrito.space/peek/commit/upxv))

Desktop - Testing
- [x] Add pubsub and lazy-loading unit tests (24 tests), Playwright test for dynamic tags widget ([upxv](https://tangled.org/burrito.space/peek/commit/upxv))

## 2026-03-05

Desktop - Shortcuts
- [x] Fix extension shortcuts — change most extension shortcuts from global to local so they work on Linux Wayland; cmd palette shortcut registered as both global and local ([51e4](https://tangled.org/burrito.space/peek/commit/51e4))

Desktop - Extensions
- [x] Add dropzone diagnostic extension for inspecting dropped content ([6b91](https://tangled.org/burrito.space/peek/commit/6b91))
- [x] Wire up ext:ready pubsub to resolve lazy extension loading ([680a](https://tangled.org/burrito.space/peek/commit/680a))
- [x] Show all discovered extensions in Features settings, not just running ones ([d506](https://tangled.org/burrito.space/peek/commit/d506))
- [x] Restore importSource metadata and extension- prefix for device IDs ([ae80](https://tangled.org/burrito.space/peek/commit/ae80))

Desktop - Command Palette
- [x] Stop forwarding history registration logs to main process terminal ([7f0c](https://tangled.org/burrito.space/peek/commit/7f0c))
- [x] Add 'open groups' to manifest for immediate cmd palette availability ([d43c](https://tangled.org/burrito.space/peek/commit/d43c))

Desktop - Cards & UI
- [x] Restructure card layout — remove Text label, URL row, footer reorder ([2bc8](https://tangled.org/burrito.space/peek/commit/2bc8))

Desktop - Settings
- [x] Consolidate sync config into single Sync pane ([a035](https://tangled.org/burrito.space/peek/commit/a035))
- [x] Restore settings hotkey and add shortcuts to settings UI ([f2dd](https://tangled.org/burrito.space/peek/commit/f2dd))

Desktop - Codebase
- [x] Rename extensions/ → features/ and move chrome-extensions to project root ([a809](https://tangled.org/burrito.space/peek/commit/a809))

iOS - Share Extension
- [x] Make share extension content and OCR text editable ([33a9](https://tangled.org/burrito.space/peek/commit/33a9))
- [x] Add Vision image analysis to Share Extension ([f06b](https://tangled.org/burrito.space/peek/commit/f06b))
- [x] Image dedup via thumbnail hash, OCR content persistence, WAL safety ([4538](https://tangled.org/burrito.space/peek/commit/4538))
- [x] Share extension styling, theme generator, reader mode ([4461](https://tangled.org/burrito.space/peek/commit/4461))
- [x] Fix collection view spacing, image sharing activation ([e9fa](https://tangled.org/burrito.space/peek/commit/e9fa))
- [x] Add app group entitlements and webhook push tests ([b72a](https://tangled.org/burrito.space/peek/commit/b72a))

iOS - PeekCore
- [x] Create peek-core crate with types, schema, helpers, profiles ([68a9](https://tangled.org/burrito.space/peek/commit/68a9))
- [x] Extract item CRUD and tags, wire up PeekStore ([5b22](https://tangled.org/burrito.space/peek/commit/5b22))
- [x] Extract sync/offline DB operations ([97c9](https://tangled.org/burrito.space/peek/commit/97c9))
- [x] Add UniFFI annotations and XCFramework build pipeline ([82b6](https://tangled.org/burrito.space/peek/commit/82b6))
- [x] Migrate Share Extension from GRDB to PeekCore FFI ([e382](https://tangled.org/burrito.space/peek/commit/e382))

iOS - Editor
- [x] Shared EditorLayout component for all editor types ([eed9](https://tangled.org/burrito.space/peek/commit/eed9))
- [x] Full-screen height, working resizers, URL editor flex layout ([4999](https://tangled.org/burrito.space/peek/commit/4999))
- [x] Image editor content display + build script asset copy ([4732](https://tangled.org/burrito.space/peek/commit/4732))

Android
- [x] Add Tauri Android generated project files ([d7ee](https://tangled.org/burrito.space/peek/commit/d7ee))
- [x] Add Android build scripts and configuration ([b213](https://tangled.org/burrito.space/peek/commit/b213))
- [x] Add platform cfg guards for iOS-specific FFI ([b6a2](https://tangled.org/burrito.space/peek/commit/b6a2))

## 2026-03-04

Desktop - Shortcuts
- [x] Fix Linux keyboard shortcuts — translate Option→Alt for global shortcuts, use Ctrl instead of Meta for page navigation ([007b](https://tangled.org/burrito.space/peek/commit/007b), [c157](https://tangled.org/burrito.space/peek/commit/c157))

Desktop - Cards & UI
- [x] Extract shared search-result-card component — single source of truth for item cards across tags, search, lists, pagestream, and groups ([bb96](https://tangled.org/burrito.space/peek/commit/bb96))
- [x] Add x-key toggle for checkboxes in item cards — works in all card UIs via tag-action-toggle ([1fba](https://tangled.org/burrito.space/peek/commit/1fba))
- [x] Show entity type (Person, Organization, etc.) in shared card subtitle ([e0d8](https://tangled.org/burrito.space/peek/commit/e0d8))
- [x] Update all hardcoded 800x600 window sizes to XGA default 1024x768 ([99c9](https://tangled.org/burrito.space/peek/commit/99c9))

Desktop - Extensions
- [x] Rename localsearch extension to lists ([7426](https://tangled.org/burrito.space/peek/commit/7426))
- [x] Fix pagestream not loading — add command registration for lazy loading compatibility ([1fba](https://tangled.org/burrito.space/peek/commit/1fba))
- [x] Fix entities not auto-scanning — load extension eagerly, always publish extraction results, add rescan button ([rmyy](https://tangled.org/burrito.space/peek/commit/rmyy), [wqmp](https://tangled.org/burrito.space/peek/commit/wqmp))
- [x] Remove entity browser popup from extract command ([uxxu](https://tangled.org/burrito.space/peek/commit/uxxu))

Desktop - Command Palette
- [x] Fix input text overflow — scroll to keep cursor visible when text longer than bar width ([1730](https://tangled.org/burrito.space/peek/commit/1730))
- [x] Fix sample-data command name collision with lists extension ([9419](https://tangled.org/burrito.space/peek/commit/9419))

Desktop - Settings
- [x] Overhaul datastore pane — grouped tables, descriptions, row counts, timestamps, synced stats ([wplz](https://tangled.org/burrito.space/peek/commit/wplz))

Desktop - Search
- [x] Fix search icons showing "T" for all items — refactor to shared card-helpers with getItemDisplayInfo ([smky](https://tangled.org/burrito.space/peek/commit/smky), [mwtn](https://tangled.org/burrito.space/peek/commit/mwtn))

Schema & Sync
- [x] Add item_events table and entity type to server, Tauri desktop, and mobile backends ([vzwv](https://tangled.org/burrito.space/peek/commit/vzwv), [rtnz](https://tangled.org/burrito.space/peek/commit/rtnz), [mkpw](https://tangled.org/burrito.space/peek/commit/mkpw))

## 2026-03-01

Desktop - Editor
- [x] Redesign note editing — inline textarea replaces broken Edit button, auto-opens on new highlight ([2988](https://tangled.org/burrito.space/peek/commit/2988))
- [x] Notes pane UX polish — Enter creates newlines, delete confirms with two-click, collapsed hides + button, header shows selection text excerpt with ellipsis ([2a5c](https://tangled.org/burrito.space/peek/commit/2a5c))
- [x] Fix ESC in note textarea — Electron's before-input-event intercepted ESC before DOM, now handled via escape IPC callback ([f978](https://tangled.org/burrito.space/peek/commit/f978))

Desktop - Entities
- [x] Add lightweight NER — regex-based person name extraction with name database validation ([f42e](https://tangled.org/burrito.space/peek/commit/f42e))
- [x] Recursive JSON-LD extraction — walk nested objects, extract relationship entities (performer, location, organizer), expanded schema.org type mappings ([2816](https://tangled.org/burrito.space/peek/commit/2816))
- [x] Fix page fallback extractors — inline entity extraction in page.js now parses JSON-LD, relaxed relationship field filters, added pipeline logging ([d8f2](https://tangled.org/burrito.space/peek/commit/d8f2))
- [x] Expand name database with ~500 international names — Japanese, Korean, Chinese, Indian, African, Vietnamese, French, Spanish, Italian ([fe37](https://tangled.org/burrito.space/peek/commit/fe37))
- [x] Fix person name regex — mandatory \s+ between first and last name was missing, regex could never match normal names ([937e](https://tangled.org/burrito.space/peek/commit/937e))

Desktop - Page View
- [x] Remove translateX transforms from page panels — opacity-only fade animation as intended ([f70c](https://tangled.org/burrito.space/peek/commit/f70c))
- [x] Replace keyframe animations with 500ms CSS transitions for fade in/out ([5296](https://tangled.org/burrito.space/peek/commit/5296))

Desktop - Command Palette
- [x] Cache history commands — batch registration, skip re-registration when unchanged, incremental delta updates ([66ec](https://tangled.org/burrito.space/peek/commit/66ec))

## 2026-02-28

Desktop - Editor
- [x] Redesign pane management with uniform state model — visible/collapsed/width per pane, single source of truth via _applyPaneState() ([6a00](https://tangled.org/burrito.space/peek/commit/6a00b274))
- [x] Add Notes pane (renamed from Annotations) — Cmd+Shift+L to add note at selection/cursor, Cmd+Shift+H to toggle pane, line-anchored notes with + button ([7766](https://tangled.org/burrito.space/peek/commit/7766bcc1))
- [x] Add Cmd+Shift+Plus/Minus shortcuts for outline zoom in/out ([b860](https://tangled.org/burrito.space/peek/commit/b860b819))
- [x] Fix selection contrast — hardcoded rgba per color-scheme, works in both light and dark themes ([b860](https://tangled.org/burrito.space/peek/commit/b860b819))
- [x] Fix active line obscuring same-line selection — reduced to 4% opacity ([b860](https://tangled.org/burrito.space/peek/commit/b860b819))
- [x] Fix uniform sidebar header heights — constrain add-btn height ([81b4](https://tangled.org/burrito.space/peek/commit/81b4f2d2))

Desktop - Theme
- [x] Fix HUD, cmd palette, and page panels stuck in dark mode — replace hardcoded rgba with theme variables ([f39b](https://tangled.org/burrito.space/peek/commit/f39b1d52))

Desktop - IZUI
- [x] Fix ESC closing root-level content windows in active sessions — child-content now follows session-aware policy ([616b](https://tangled.org/burrito.space/peek/commit/616b3b69))

Desktop - Page View
- [x] Fix extension widget showing "not loaded" — filter by enabled, not loaded state ([692d](https://tangled.org/burrito.space/peek/commit/692d0cf0))
- [x] Fix widget spacing — recalculate positions after async entity content loads ([692d](https://tangled.org/burrito.space/peek/commit/692d0cf0))

Desktop - Tests
- [x] Add 15 IZUI escPolicy unit tests covering all role/session-state combinations ([616b](https://tangled.org/burrito.space/peek/commit/616b3b69))
- [x] Add editor notes/highlights unit tests — serialization, empty text, line-anchored highlights ([f8c0](https://tangled.org/burrito.space/peek/commit/f8c05fac))
- [x] Add editor layout Playwright tests — pane toggles, notes shortcuts, notes pane UI ([f8c0](https://tangled.org/burrito.space/peek/commit/f8c05fac))

## 2026-02-26

Desktop - Editor
- [x] Add file open/save with autosave and vim :w/:wq/:e support — Cmd+O opens file picker, Cmd+S saves, autosave to disk ([5658](https://tangled.org/burrito.space/peek/commit/56589716))
- [x] Sync outline sidebar collapse with document folds — bidirectional, click toggle or vim zc/zo ([efa7](https://tangled.org/burrito.space/peek/commit/efa77299))
- [x] Add inline suggestions with Tab/Shift-Tab cycling to vim command bar ([542f](https://tangled.org/burrito.space/peek/commit/542fe48f))
- [x] Skip saving empty notes with no tags — defer item creation until user types ([0bd9](https://tangled.org/burrito.space/peek/commit/0bd98f19))

Desktop - Command Palette
- [x] Fix single-select enum params accumulating on Tab — now replaces, with Shift-Tab reverse cycling ([e410](https://tangled.org/burrito.space/peek/commit/e4106a8a), [eefc](https://tangled.org/burrito.space/peek/commit/eefcfd58))
- [x] Fix local file paths treated as domain names — tighten domain regex, add filesystem-first check ([85b4](https://tangled.org/burrito.space/peek/commit/85b48192))
- [x] Fix connector commands with produces blocking param mode for edit command ([4c28](https://tangled.org/burrito.space/peek/commit/4c2840b9))

Desktop - Chrome Extensions
- [x] Show extension entry points from manifest in Settings, make them cmd-searchable ([f55b](https://tangled.org/burrito.space/peek/commit/f55b6bb3))
- [x] Add extensions widget to page view with per-site adblocker toggle ([046d](https://tangled.org/burrito.space/peek/commit/046d5dd6))
- [x] Fix Proton Pass black screen — remove browser.permissions shim that broke webextension-polyfill ([1aa6](https://tangled.org/burrito.space/peek/commit/1aa63e10))
- [x] Replace chrome.permissions completely before extension code runs — prevents Proton Pass Proxy override ([b744](https://tangled.org/burrito.space/peek/commit/b744e8b7))
- [x] Clear chrome.runtime.lastError before permission shim callbacks ([8569](https://tangled.org/burrito.space/peek/commit/8569c20d))
- [x] Add callback-style permissions shim for webextension-polyfill compatibility ([23f8](https://tangled.org/burrito.space/peek/commit/23f81b96))
- [x] Add chrome.storage.session and getBackgroundPage shims for Proton Pass service worker ([a7d7](https://tangled.org/burrito.space/peek/commit/a7d79dd2), [b48f](https://tangled.org/burrito.space/peek/commit/b48f5001))
- [x] Fix adblocker enable/disable state not persisting across restarts ([ced1](https://tangled.org/burrito.space/peek/commit/ced182ff))

Desktop - Tag Actions
- [x] Render tag action affordances as single toggle icon buttons in item cards ([b721](https://tangled.org/burrito.space/peek/commit/b721b51c))
- [x] Simplify config UI to tag pairs with icon style — checkbox, eye, star, heart, flag, bookmark ([fd82](https://tangled.org/burrito.space/peek/commit/fd82de24))
- [x] Fix event propagation on affordance clicks, fix \! syntax errors ([efa7](https://tangled.org/burrito.space/peek/commit/efa77299))

Desktop - Settings
- [x] Reorganize core pane into System/Data & Backup/Windows groups ([4d59](https://tangled.org/burrito.space/peek/commit/4d597f2e), [c7bf](https://tangled.org/burrito.space/peek/commit/c7bf11d1))
- [x] Add "Set as default handler for HTTP addresses and HTML documents" button ([85b4](https://tangled.org/burrito.space/peek/commit/85b48192))
- [x] Add HTML file association to electron-builder for macOS open command support ([85b4](https://tangled.org/burrito.space/peek/commit/85b48192))
- [x] Update default window sizes from 800x600 to 1024x768 across 21 files ([a9a1](https://tangled.org/burrito.space/peek/commit/a9a14310))

Desktop - Items
- [x] Fix text items showing link icon when content contains URLs — use datastore type for icon ([d47d](https://tangled.org/burrito.space/peek/commit/d47d759b))

Desktop - Infrastructure
- [x] Add jj-worktrees.sh script and Claude skill for multi-agent workflow ([85b4](https://tangled.org/burrito.space/peek/commit/85b48192))
- [x] Fix microseason preload null reference on document.documentElement ([efa7](https://tangled.org/burrito.space/peek/commit/efa77299))

## 2026-02-25

Desktop - Command Palette
- [x] Rewrite cmd panel to use state machine with transition table and dispatch — 10 states, guard-based transitions, enforced invariants ([0496](https://tangled.org/burrito.space/peek/commit/04960fb1), [08eb](https://tangled.org/burrito.space/peek/commit/08eb8055))
- [x] Add 76 unit tests and 15 integration tests for state machine ([3c05](https://tangled.org/burrito.space/peek/commit/3c05a142))
- [x] Fix IDLE → PARAM_MODE direct transition for fill-style input ([2f83](https://tangled.org/burrito.space/peek/commit/2f83e6d8))
- [x] Restore two-tone inline suggestion styling — bold typed text, dim completion ([4d35](https://tangled.org/burrito.space/peek/commit/4d35289b))

Desktop - Page View
- [x] Add page info and entities panels to navbar overlay — 75% off-page, 25% overlapping ([e144](https://tangled.org/burrito.space/peek/commit/e144dbd8))
- [x] Refactor page layout to flexbox centering — window padding expands symmetrically ([b494](https://tangled.org/burrito.space/peek/commit/b494e8a3))
- [x] Eliminate one-frame visual flash on navbar show/hide with opacity masking ([8f22](https://tangled.org/burrito.space/peek/commit/8f22aa70))
- [x] Fix Cmd+L navbar auto-hide on mouseleave ([4ff2](https://tangled.org/burrito.space/peek/commit/4ff260b2))
- [x] Fix navbar show/hide and loading lifecycle failures ([6780](https://tangled.org/burrito.space/peek/commit/67d01801))

Desktop - HUD
- [x] Fix macOS Spaces switching — use showInactive() to prevent activateIgnoringOtherApps ([0166](https://tangled.org/burrito.space/peek/commit/0166d4b3))
- [x] Make HUD visible on all macOS Spaces and pass through visibleOnAllWorkspaces option ([3893](https://tangled.org/burrito.space/peek/commit/3893e68b))

Desktop - Extensions
- [x] Add search view extension with text and tag search ([86a2](https://tangled.org/burrito.space/peek/commit/86a21be6))
- [x] Add tag actions extension for configurable tag-based automation ([a617](https://tangled.org/burrito.space/peek/commit/a6170230))
- [x] Extract shared grid navigation into app/lib/grid-nav.js ([e787](https://tangled.org/burrito.space/peek/commit/e787c66f))
- [x] Refactor tags to use shared card-helpers for peek-card slot construction ([0580](https://tangled.org/burrito.space/peek/commit/0580c349))

Desktop - Lexicon Studio
- [x] Seed recent lexicons from collections, fix sidebar styling ([a629](https://tangled.org/burrito.space/peek/commit/a629437c))
- [x] Always show recent lexicons section in sidebar ([d6cf](https://tangled.org/burrito.space/peek/commit/d6cfe9af))

Desktop - Windows
- [x] Unify hold-to-drag default to 1s, fix webview drag reliability ([ce48](https://tangled.org/burrito.space/peek/commit/ce483874))
- [x] Prevent macOS Space switching when opening cmd palette ([ac9a](https://tangled.org/burrito.space/peek/commit/ac9aa862))

## 2026-02-23

Desktop - Extensions
- [x] Reduce extension windows from 14 to 4 — consolidation with shared iframes, lazy loading, and show/hide instead of create/destroy ([7977](https://tangled.org/burrito.space/peek/commit/79772231))
- [x] Add declarative command and shortcut registration in extension manifests — no background.js needed for simple commands ([42ca](https://tangled.org/burrito.space/peek/commit/42ca20ac))
- [x] Migrate intra-extension messaging from IPC pubsub to BroadcastChannel ([7563](https://tangled.org/burrito.space/peek/commit/7563532d))
- [x] Migrate UI view preferences from api.settings to localStorage ([7aea](https://tangled.org/burrito.space/peek/commit/7aea1f74))
- [x] Fix lazy command replay, iframe ready signaling, and test updates ([d1c2](https://tangled.org/burrito.space/peek/commit/d1c2c614))
- [x] Fix peek-card slot handling, HUD focus tracking, test reliability ([51d8](https://tangled.org/burrito.space/peek/commit/51d859c2))

Desktop - Lexicon Studio
- [x] Add record viewing, detail panel, and record deletion ([62b4](https://tangled.org/burrito.space/peek/commit/62b4c259))
- [x] Rename me-core extension to Lexicon Studio across all user-facing strings ([6940](https://tangled.org/burrito.space/peek/commit/694d061f), [c3fb](https://tangled.org/burrito.space/peek/commit/c3fb9b52))
- [x] Eliminate background.js — make extension fully declarative with direct XRPC calls ([c637](https://tangled.org/burrito.space/peek/commit/c6375de5), [4aa1](https://tangled.org/burrito.space/peek/commit/4aa1789b))
- [x] Remove Bluesky reference from login and auto-close OAuth window ([65b0](https://tangled.org/burrito.space/peek/commit/65b0906d))
- [x] Add unit tests for pure functions ([a09d](https://tangled.org/burrito.space/peek/commit/a09d0f53))

Desktop - HUD
- [x] Add performance metrics widget — window counts and pubsub stats ([2dc8](https://tangled.org/burrito.space/peek/commit/2dc85478))
- [x] Show active window info in HUD window widget ([a7af](https://tangled.org/burrito.space/peek/commit/a7af389a))

Desktop - Editor
- [x] Add clickable links extension for CodeMirror ([5660](https://tangled.org/burrito.space/peek/commit/56600693))
- [x] Remove highlightSelectionMatches to stop highlighting matching text on other lines ([ef48](https://tangled.org/burrito.space/peek/commit/ef48d325))

Desktop - Command Palette
- [x] Fix Tab/Enter semantics — Tab fills inline suggestion text, Enter executes with correct item identity ([ced4](https://tangled.org/burrito.space/peek/commit/ced4c145))
- [x] Fix editor:open lazy-load interceptor so edit command opens editor on first use ([0d39](https://tangled.org/burrito.space/peek/commit/0d396ba8))
- [x] Fix cmd palette blink on hotkey — skip non-focusable windows in did-resign-active handler ([0d39](https://tangled.org/burrito.space/peek/commit/0d396ba8))

Desktop - Windows
- [x] Add maximize window and fullscreen toggle commands ([4ce0](https://tangled.org/burrito.space/peek/commit/4ce0a233))
- [x] Fix external URLs with no explicit position causing NaN coordinates ([1f7f](https://tangled.org/burrito.space/peek/commit/1f7f24d5))
- [x] Fix external URL opening from other apps — move single-instance lock before app.whenReady ([efa0](https://tangled.org/burrito.space/peek/commit/efa0bad6))

Desktop - Page View
- [x] Show navbar with loading spinner, tone down and theme the loading glow ([fc63](https://tangled.org/burrito.space/peek/commit/fc63631e))

Desktop - UI
- [x] Compact UI for tags and groups, muted accent colors for dark theme ([d3f0](https://tangled.org/burrito.space/peek/commit/d3f0be32))
- [x] Show source URL on entity cards with open button ([5ff4](https://tangled.org/burrito.space/peek/commit/5ff490b5))
- [x] Show URL on address cards in group view ([529f](https://tangled.org/burrito.space/peek/commit/529fc7ac))

Mobile
- [x] Add offline reading with saved article content ([0c55](https://tangled.org/burrito.space/peek/commit/0c55e5ce))
- [x] Add webview navigation tracking and configurable tag settings ([0c55](https://tangled.org/burrito.space/peek/commit/0c55e5ce))
- [x] Hide from:history items from default list view ([a0a4](https://tangled.org/burrito.space/peek/commit/a0a47cc1))
- [x] Move reader CSS from Rust to frontend for HMR support ([8a02](https://tangled.org/burrito.space/peek/commit/8a02b7c9))
- [x] Fix markdown list auto-bulleting bugs ([b9c3](https://tangled.org/burrito.space/peek/commit/b9c3c1da))

## 2026-02-20

Desktop - Lexicon Studio (AT Protocol Identity)
- [x] Add AT Protocol identity extension — connect your Bluesky/AT Protocol account via OAuth PKCE+DPoP ([b549](https://tangled.org/burrito.space/peek/commit/b549fa8a), [ea7b](https://tangled.org/burrito.space/peek/commit/ea7ba305))
- [x] Add lexicon browser — explore all known AT Protocol lexicons, view your repo's collections with record counts ([ba52](https://tangled.org/burrito.space/peek/commit/ba528419))
- [x] Add record creation — auto-generated forms from lexicon schemas, create records directly from the app ([93fc](https://tangled.org/burrito.space/peek/commit/93fc3561), [b9a4](https://tangled.org/burrito.space/peek/commit/b9a485e1))
- [x] Add recent lexicons sidebar — shortcuts for frequently used record types ([260c](https://tangled.org/burrito.space/peek/commit/260cf397))
- [x] Persist lexicon directory and schemas to survive restarts ([3ba9](https://tangled.org/burrito.space/peek/commit/3ba994f0))
- [x] Add chain-form popup — create records directly from command palette without opening full panel ([ba78](https://tangled.org/burrito.space/peek/commit/ba7814e4), [1eec](https://tangled.org/burrito.space/peek/commit/1eec6c47))

Desktop - Windows
- [x] Add reopen-last-closed-window with Cmd+Shift+T and command palette ([579c](https://tangled.org/burrito.space/peek/commit/579c9926))

Desktop - Extensions
- [x] Enable cross-origin fetch for extensions — extensions can now fetch from https:// origins ([5051](https://tangled.org/burrito.space/peek/commit/505123ab))

## 2026-02-19

Desktop - Themes
- [x] Switchable themes from command palette — themes are now installable CSS extensions ([213b](https://tangled.org/burrito.space/peek/commit/213b4794a5f6dac0f29da22b9317c41fd23563d9))
- [x] Add 七十二候 micro-seasons theme — colors change automatically every ~5 days based on Japan's 72 seasons calendar ([d031](https://tangled.org/burrito.space/peek/commit/d031c4f42b804bbe2442c1169069264c6ecfa326))
- [x] Fix theme font loading and URLs ([da4b](https://tangled.org/burrito.space/peek/commit/da4b78bf3077013c31ba650f02dba8a0b393eff9))
- [x] Improve syntax highlighting readability in dark mode ([de99](https://tangled.org/burrito.space/peek/commit/de993e4710b2c02369c0a0ef378c908f6e11f583))

Desktop - Groups
- [x] Save and restore window layouts per group ([1a25](https://tangled.org/burrito.space/peek/commit/1a25f1d8742a52ec3e849f99b9465cafc61f3089))
- [x] Close all windows in group, scope search to group, switch between groups, pin windows ([b8a6](https://tangled.org/burrito.space/peek/commit/b8a6befeb2eff51b5638aa4b790b77a74c4ddf52))
- [x] Add unit tests for group quick wins ([805d](https://tangled.org/burrito.space/peek/commit/805d0993e4c4edc294b57bd463bcfef71d9f0266))

Desktop - Widget System
- [x] Add widget sheet extension with freeform layout ([9644](https://tangled.org/burrito.space/peek/commit/96449d04269ac0a14740bad03067ddf2e784b6e3))
- [x] Migrate HUD to widget sheet system with individual widget pages ([4ec6](https://tangled.org/burrito.space/peek/commit/4ec60504040874495d9439636db38513188aad46))
- [x] Add widget demo extension ([7aeb](https://tangled.org/burrito.space/peek/commit/7aeb1baa90812f18a26699035eab6487294c78fd))
- [x] Add freeform layout mode with drag-to-move, edge-drag-to-resize, and snap-to-grid ([6f05](https://tangled.org/burrito.space/peek/commit/6f05c81f835653363d7f5df6ede6f48878495031))

Desktop - Editor
- [x] Add vim :set wrap/nowrap, :set number/nonumber, and :q command ([4750](https://tangled.org/burrito.space/peek/commit/4750ab83412366fa303bd4756fab3c393aebaaf8))
- [x] Persist vim :set settings across sessions ([ab30](https://tangled.org/burrito.space/peek/commit/ab30313bf529b5065a06a1e55517c2a1c7edff35))
- [x] Support multiple simultaneous editor instances ([a3be](https://tangled.org/burrito.space/peek/commit/a3beea130920c0f4da96ee99d4021ab673a576b9))

Desktop - Page View
- [x] Show loading indicator for in-page navigations ([538f](https://tangled.org/burrito.space/peek/commit/538f3769aa6cba57af1c12cb57cb14437527a4db))
- [x] Rewrite loading indicator for reliability ([847d](https://tangled.org/burrito.space/peek/commit/847dd119d0b540cd96f9fa1d9a6bdbd0c6fb2a95))
- [x] Ensure loading glow clears when page finishes loading ([1630](https://tangled.org/burrito.space/peek/commit/16304f58514b40a14cf040e31826699e83dc93a6))

Desktop - Entity Recognition
- [x] Add entity validation framework ([64f7](https://tangled.org/burrito.space/peek/commit/64f7a7a470aa06fd7576607113b04cfa9adfbb1c))
- [x] Add unit tests for name-validator module ([d81c](https://tangled.org/burrito.space/peek/commit/d81c07d73229f5920d1f253b220e2d4fa35d9578))

Desktop - Tauri
- [x] Add system tray with click-to-show ([c469](https://tangled.org/burrito.space/peek/commit/c469d9da5ea67e513eb0467bda8550f3f10e1c1c))
- [x] Add net-fetch proxy and file dialog commands ([83f5](https://tangled.org/burrito.space/peek/commit/83f5a1d261ff53a8d91407131c60218ba2eb2971))

Desktop - Refactoring
- [x] Extract shared modules to app/lib for platform-agnostic use between Electron and Tauri ([da44](https://tangled.org/burrito.space/peek/commit/da44fd3dd4ea7db548b9894687e8cefa18efbe64), [9ff2](https://tangled.org/burrito.space/peek/commit/9ff26e737bf254facffdcc47ec708ec5ef88db23), [10f0](https://tangled.org/burrito.space/peek/commit/10f0bfc0855ac5934ec1f6c7f6843fc5efd0025e), [e267](https://tangled.org/burrito.space/peek/commit/e267e2661139e7ebad0e91ac7e458af05a3502ba), [7ed8](https://tangled.org/burrito.space/peek/commit/7ed8b22556f1e2fbbe26c3cc833956f7cc29a270))

Desktop - Fixes
- [x] Fix hold/drag cursor feedback CSS ([6e86](https://tangled.org/burrito.space/peek/commit/6e862be638d70eac3fa1163c6c1dd7e14b11b8f5))
- [x] Make sync fire-and-forget with 15s timeout ([96ed](https://tangled.org/burrito.space/peek/commit/96edd06a18c374926e515b703d6193116fe2c19d), [73f9](https://tangled.org/burrito.space/peek/commit/73f9896fd1aa5c6b0b683cafa9d58ec12528be6c))
- [x] Handle macOS open command with local file paths ([1ae8](https://tangled.org/burrito.space/peek/commit/1ae8101e0554cf9d2e17db11ee94b9aabc58e8c7))
- [x] Prevent opening app directory as file:// URL on startup ([e12b](https://tangled.org/burrito.space/peek/commit/e12bef73e27699ed8cc7b53da178fc2a247b198b))
- [x] Use Promise.allSettled for extension loading so one failure doesn't block all commands ([d031](https://tangled.org/burrito.space/peek/commit/d031c4f42b804bbe2442c1169069264c6ecfa326))

Testing
- [x] Resolve pre-existing unit test failures across 4 test suites ([a961](https://tangled.org/burrito.space/peek/commit/a9610b631d66db1a190ab49332cc06667fad3ef9))

## 2026-02-16

Desktop - Command Palette
- [x] Generic command chaining with pipe system ([5975](https://tangled.org/burrito.space/peek/commit/5975f593ff109df82daf56b47233cf6910db89d3))
- [x] Replace embedded chain editor with popup window system ([5729](https://tangled.org/burrito.space/peek/commit/5729822b4748acc4bf98c9563d4f7c2a17ae2435))
- [x] Add parameter suggestions to command palette ([693d](https://tangled.org/burrito.space/peek/commit/693de4ad13de5edf49643088a724d2788936aca6))
- [x] Add noun registration API for declarative command generation ([191f](https://tangled.org/burrito.space/peek/commit/191fb02212c460355702d619f264fa5801edb6b3))
- [x] Remove download cmd, fix save filename, fix dialog parent, unify hashtag extraction ([5b95](https://tangled.org/burrito.space/peek/commit/5b95d1af28ec91787778989f5d0f4d8b34435769))
- [x] Preserve noun routing metadata in command registry pipeline ([39a4](https://tangled.org/burrito.space/peek/commit/39a45314a629b9083163e03a2e59162836266e31))

Desktop - Entity Recognition
- [x] Add observation frequency ranking for entities ([8031](https://tangled.org/burrito.space/peek/commit/80313a9eb1da5e586e5d5d50823c0f88a23f57b9))
- [x] Add thumbs up/down feedback for entity quality scoring ([c0e5](https://tangled.org/burrito.space/peek/commit/c0e5afab57ec4749b29ab35c5ab526b24912720b))

Desktop - Tags
- [x] Add rename and delete tag operations ([ac2a](https://tangled.org/burrito.space/peek/commit/ac2a86fb419412483cbaa784108526e15067642e))
- [x] Fix protocol 404 logging, handle all item types, fix filter counts ([403e](https://tangled.org/burrito.space/peek/commit/403ea5b151149ef10cd2a22b61838cf7fa3b02a8))

Desktop - Display Switching
- [x] Simplify display-watcher to safety-net-only approach — let macOS handle display migration natively, only rescue orphaned windows ([afae](https://tangled.org/burrito.space/peek/commit/afae1e4af08491ae69b6feb6dab9c6f1fa7cae10))

Desktop - Page View & Dragging
- [x] Fix keyboard shortcuts responding in wrong page window ([6573](https://tangled.org/burrito.space/peek/commit/65735c4d27ac2411d62d9c32c4b6c4494e28e0ba))
- [x] Fix drag ending on webview mouseup to prevent overlay blocking clicks ([a7b8](https://tangled.org/burrito.space/peek/commit/a7b8948d19f2fec4c239bf51217421dda79d4b80))
- [x] Fix webview mousemove during active drag for window movement ([ac37](https://tangled.org/burrito.space/peek/commit/ac37674d8b52be9359f4aa1706d86dca11c8ec72))
- [x] Restore hold-to-drag in extension windows ([63c1](https://tangled.org/burrito.space/peek/commit/63c17b27bd19b3c8f9a288ba491271054a31b450))

Desktop - Auth & URLs
- [x] Improve OAuth popup bridge and flow ([c93a](https://tangled.org/burrito.space/peek/commit/c93a46dc3ed7ce977e1227f8e3f8ce02152e4695))
- [x] Wait for frontend ready and session restore before processing external URLs ([e7ab](https://tangled.org/burrito.space/peek/commit/e7ab8092a3cdde2dd2ba99de18b7fd1babc4a3c2))

Testing
- [x] Add completer unit tests; fix tag # prefix stripping ([6102](https://tangled.org/burrito.space/peek/commit/61020b937d52bd87cfad5425f77167e65421c3c1))
- [x] Add integration tests for command execution through pubsub ([e11d](https://tangled.org/burrito.space/peek/commit/e11daddb41f2c53cbba0ecbae40b0e71e1ec4cb0))
- [x] Add command chaining pipe system tests ([566c](https://tangled.org/burrito.space/peek/commit/566c9ec7028c8197426369b93f148090aa2e7087))
- [x] Add OAuth bridge unit tests ([77b0](https://tangled.org/burrito.space/peek/commit/77b0f1972afb51f6e0c271bf8abaff09e80a8020))
- [x] Fix 4 stale test expectations in desktop smoke tests ([4d96](https://tangled.org/burrito.space/peek/commit/4d9683f93f590c58fc823024fddcc65f38b29183))

## 2026-02-13

Desktop - Session Restore
- [x] Full session save/restore — snapshot windows on quit, restore on startup with confirmation, autosave timer, crash recovery dialog ([0e8a](https://tangled.org/burrito.space/peek/commit/0e8afccdff0075b9151b3dbd40609f53f16a8521), [f270](https://tangled.org/burrito.space/peek/commit/f270c56db43c1799a0a6c8dd801a00a2419124e3), [d015](https://tangled.org/burrito.space/peek/commit/d0150877ced2ff5e02d7414b3c6c08cd404e0f17), [d2fb](https://tangled.org/burrito.space/peek/commit/d2fb834abcd81e1a7d23898b4875f996f8899c52))
- [x] Save settings windows, strip stale params on restore, fix display-watcher race conditions ([d12b](https://tangled.org/burrito.space/peek/commit/d12bd2b93d553c124f508fe37bbd6f7d325f4362))
- [x] Suppress display-watcher during session restore to preserve window positions ([c32b](https://tangled.org/burrito.space/peek/commit/c32b73dfaf9ef4f497623452d7f919be28194392))
- [x] Treat SIGINT/SIGTERM as clean shutdowns to prevent false crash dialog ([f56f](https://tangled.org/burrito.space/peek/commit/f56f5624550c93ef1e93f60392496a70b6dc393f), [8ab6](https://tangled.org/burrito.space/peek/commit/8ab6d36de9d593b894ef92893dc59b6af751ba3b), [16a2](https://tangled.org/burrito.space/peek/commit/16a2d4bcabce898ceb850ae3258965c384d71b89))
- [x] Fix synchronous SIGINT save and correct canvas page bounds ([2df8](https://tangled.org/burrito.space/peek/commit/2df8a7339298b2b3c30f81168eef6b0bfabf4299))
- [x] Open startup feature when restore is declined or fails ([0f28](https://tangled.org/burrito.space/peek/commit/0f280143d148e3bf25cd870b39cfaef528939d0a))

Desktop - Display Switching
- [x] Reposition windows when displays change — preserves positions before OS moves them ([d732](https://tangled.org/burrito.space/peek/commit/d732fa7912f47f70d32fde3b932f5842705fcc38))
- [x] Track home display to restore windows after display reconnect ([60b0](https://tangled.org/burrito.space/peek/commit/60b0798db24bc9b6b571a30106a1392b453eae1f))
- [x] Use group-based distance scaling for window repositioning ([1116](https://tangled.org/burrito.space/peek/commit/11166190d9066226b760225731477215c690a1c7))

Desktop - Entity Recognition
- [x] Show source pages in entity list and add detail pane with full metadata ([12fe](https://tangled.org/burrito.space/peek/commit/12feb9024640dc6a132b2080ae85012307407c78))
- [x] Improve detection coverage and reduce price noise ([82b7](https://tangled.org/burrito.space/peek/commit/82b700377bbc902113c276d7eb50a5df59812d92))
- [x] Remove standalone price entities lacking product context ([3832](https://tangled.org/burrito.space/peek/commit/383202ae65eb33aebafb52b01d4dd46579a6060b))
- [x] Require context for date entities, remove standalone dates ([6ada](https://tangled.org/burrito.space/peek/commit/6ada27ba19445ed4dc1c076961336ace34b0c83e))

Desktop - Command Palette
- [x] Add command chaining flow for list notes, markdown, download, save as note ([04ef](https://tangled.org/burrito.space/peek/commit/04ef4c8aaf106cb8ef8c5110abbda841b940f1b7))
- [x] Add "open file" command with chaining and fix note inline tag extraction ([0717](https://tangled.org/burrito.space/peek/commit/0717e87b6898b822075effa65d75beb4c9043120))
- [x] Require explicit command match on Enter — remove web search fallback ([49c6](https://tangled.org/burrito.space/peek/commit/49c6e5ec4027e472af606462fcaeef8044cfdc77))
- [x] Sort history by frecency, use targeted queries for URL lookups ([0873](https://tangled.org/burrito.space/peek/commit/0873e5ee688ec0a53440382fd88ccd681323a0f8))
- [x] Restore web page URLs in frecency suggestions ([65ba](https://tangled.org/burrito.space/peek/commit/65baa072eef50d9b1ef7c69ad4e03e33116af346))
- [x] ESC clears text first, Shift-Tab cycles backward, fix frecency tracking ([8f6b](https://tangled.org/burrito.space/peek/commit/8f6b41a8db9dc7ca85a1a696f3af4cca74915ac7))
- [x] Register IZUI escape handler so ESC clears text before closing ([8059](https://tangled.org/burrito.space/peek/commit/80592eb03a143100ddaaa3a4f32db2d95eabc3cc))
- [x] Remove prefix feedback that caused adaptive sort cross-contamination ([5ceb](https://tangled.org/burrito.space/peek/commit/5ceb05172fdfaf0c779ac6f23547a6e56567e123))
- [x] Add deterministic tiebreaker to sort for consistent autocomplete ([566b](https://tangled.org/burrito.space/peek/commit/566b63a8df0b21056b8157670216a668602e1855))

Desktop - Page View & Navigation
- [x] Replace fullscreen transparent window with minimal page host ([c543](https://tangled.org/burrito.space/peek/commit/c543e38bf36d79a2c448e3e860157a4a34da388c))
- [x] Eliminate navbar show/hide webview jump ([43c9](https://tangled.org/burrito.space/peek/commit/43c9353ec1523cd67d3c848ec5536561ad1e797b), [982f](https://tangled.org/burrito.space/peek/commit/982f6a10ac4ed9b7ab383e09b4889aa8224d8262), [083f](https://tangled.org/burrito.space/peek/commit/083fbdf90c90c9b717c259887ae4c22adebae84e), [bd04](https://tangled.org/burrito.space/peek/commit/bd0449db6277a60577ccbc0e6a37afb58adb433c))
- [x] Restore webview drag with mousedown/mouseup bridge from guest page ([63cd](https://tangled.org/burrito.space/peek/commit/63cd141464c98f54e17ad475248208c356957c8a))
- [x] Remove broken click-through code that activated unrelated windows ([10f2](https://tangled.org/burrito.space/peek/commit/10f29146d98c2cf25b8c63de56de3cfc85b712a9))

Desktop - Window Dragging
- [x] Rewrite window drag system — unified, faster, works everywhere ([5a7c](https://tangled.org/burrito.space/peek/commit/5a7c7899116f7501f40ca99cbe1b6ed8c93031f3), [fa58](https://tangled.org/burrito.space/peek/commit/fa58f66b384faf13746f8aa3e2bca266fdde3530), [1f81](https://tangled.org/burrito.space/peek/commit/1f815b618a836270b1b444cf9cbfc13c6373a884))

Desktop - HUD & Groups
- [x] Hide HUD on app blur ([be05](https://tangled.org/burrito.space/peek/commit/be05026c3fe8bf9d28c28c05490fc16c3a75a204))
- [x] Fix group creation via inline form ([1418](https://tangled.org/burrito.space/peek/commit/141829f79561a67556fb231fe89197de795cde09))
- [x] Restore tags reactivity on sync and data changes ([60eb](https://tangled.org/burrito.space/peek/commit/60eb36df2fc0febad130ac8ce104ce756649cc91))
- [x] Fix item icons, group creation form, and tagset detection ([5b0c](https://tangled.org/burrito.space/peek/commit/5b0ca9380c3217a63a66853858ab24dccb5d088f))

Desktop - Dark Mode & Settings
- [x] Respect OS color scheme in system dark mode ([6813](https://tangled.org/burrito.space/peek/commit/6813ea5f2e3fb51f11942470c1b706976e985afd))
- [x] Fix web search suggestions, default engine setting, and settings UI ([bcae](https://tangled.org/burrito.space/peek/commit/bcaeb2051189ac03e9c06279cfe87a49c33a730c))
- [x] Add Kagi as built-in search engine ([e7d0](https://tangled.org/burrito.space/peek/commit/e7d05c943f84b04b521fdce849312e5f05574a78))
- [x] Add descriptions and human-readable labels to core settings ([0bfe](https://tangled.org/burrito.space/peek/commit/0bfe87b9e109ded26ea92c90a0adc9629f29bf3a))
- [x] Fix quit shortcut default reset, editor portrait, datastore table ([f6a1](https://tangled.org/burrito.space/peek/commit/f6a16ad4a2d060b01ac213b6154bc02aee4f371b))

Desktop - Fixes
- [x] Fix mode leak into global scope and bring existing windows to front ([9b78](https://tangled.org/burrito.space/peek/commit/9b783b6b8e544458af64e6129a190fe6b218d436))
- [x] Silence spurious warnings when unregistering global shortcuts during shutdown ([7941](https://tangled.org/burrito.space/peek/commit/7941b5f670a2e4c764736ab9baff94c287a643b6))
- [x] Ensure command registration after extensions loaded ([3f9d](https://tangled.org/burrito.space/peek/commit/3f9df0153f85a43f3ed392d5bd07357b801dfa33))
- [x] Simplify command registration — remove boilerplate ([f730](https://tangled.org/burrito.space/peek/commit/f7306de6a6086d45fe56ce76bb5e27612ab593c1))
- [x] Add sorting and view modes to card grid toolbar ([83a8](https://tangled.org/burrito.space/peek/commit/83a8533205ca3eaf796046a61b627b925dae997f))
- [x] Use tangled.org URLs for RSS, fix localsearch manifest loading ([06af](https://tangled.org/burrito.space/peek/commit/06afcb89112a6ff4dfa9e707f9aeeff057c489f2))

Testing
- [x] Add 67 real integration tests for session save/restore ([49f0](https://tangled.org/burrito.space/peek/commit/49f094f7fa698dadd2745c802de1015dcc9f30a3))
- [x] Add display-watcher tests for pre-debounce capture, suppress timer, and isRemoval flag ([fd56](https://tangled.org/burrito.space/peek/commit/fd56204f81d78dcbb6b586aaea0ef97441eecbd8))
- [x] Add 94 new unit tests and fix 3 E2E test failures ([2251](https://tangled.org/burrito.space/peek/commit/2251f86f43643a9b308cac6fa46dbf593141cfb3))

## 2026-02-11

Desktop - New Extensions
- [x] Web search extension — search from command palette with live suggestions, auto-discovers OpenSearch endpoints on visited pages ([bf48](https://tangled.org/burrito.space/peek/commit/bf488889b77d22dd6b17d3613597379ba2b15737))
- [x] Unified search extension ([4b95](https://tangled.org/burrito.space/peek/commit/4b95973d39a9ab252cce55b8402fbed674d742c4))
- [x] Vertical history stream extension ([35f9](https://tangled.org/burrito.space/peek/commit/35f9afccca7020cee7762bb603ee68709949dcea))

Desktop - History Unification
- [x] Unify address/visit system into items table — remove dual-write, redirect APIs, update Tauri backend, remove legacy code ([475e](https://tangled.org/burrito.space/peek/commit/475e97feb695d45e1253e03cd05e1b8a2d1982d7)..[6f90](https://tangled.org/burrito.space/peek/commit/6f90f258e36b729608a49b178db50894478f628f))

Desktop - Dark Mode
- [x] 3-tier dark mode for web pages — System (prefers-color-scheme), Force (Chromium CIELAB inversion), with settings UI ([ef24](https://tangled.org/burrito.space/peek/commit/ef242dde9d5829fdb5342d1ba7781bc0e9767485))

Desktop - Page View & Navigation
- [x] Browser navigation hotkeys and editable URL bar — Cmd+R reload, Cmd+[/] back/forward, Cmd+L to edit URL ([52a9](https://tangled.org/burrito.space/peek/commit/52a99ec7c345ba5bd9cfc37036848d29ca0294ae))
- [x] Widget system with OpenSearch discovery notification ([ce5a](https://tangled.org/burrito.space/peek/commit/ce5ae4bb7d118320c02ae80a00af9793a5749bcf))
- [x] Improve drag-from-anywhere with long-press detection and all-corner resize ([d135](https://tangled.org/burrito.space/peek/commit/d135cfa61cc3563cb597987ebf7b55eea5e3d03c))
- [x] Apply background detection to non-canvas web pages ([e1ac](https://tangled.org/burrito.space/peek/commit/e1ac7b6f8920944019cbca21aaf1188b25592bd2))
- [x] Restore full-width navbar — remove floating bubble design ([7769](https://tangled.org/burrito.space/peek/commit/7769f1e19c6f74cb5fd18493c42bbaecc8a59644))
- [x] Fix Loading... title bug, add page content extraction and URL metadata enrichment ([61ca](https://tangled.org/burrito.space/peek/commit/61ca6f009ba9ad357e09f310770fa5cdf2940b9c))

Desktop - Tags & Editor
- [x] Embed editor in detail pane for inline note editing with vim status bar ([a575](https://tangled.org/burrito.space/peek/commit/a575013e7000b50db91235fa09b67104ea5293d2))
- [x] Content search with tag combo filtering, pin selected tags in sidebar ([d005](https://tangled.org/burrito.space/peek/commit/d005d3dd966595778c482c2ce8f555ffb8550ca6))
- [x] Fix note command blank editor, tags reactivity, and editor height ([cb4d](https://tangled.org/burrito.space/peek/commit/cb4d5e10b8d4a27c6529945e00efea2bed701fc0))
- [x] Forward ESC to vim in insert/visual mode before IZUI handles it ([7b86](https://tangled.org/burrito.space/peek/commit/7b866e87a87e357bd1482e5d8e5775f9702c5d81))
- [x] Fix editor layout, vim status bar positioning, and focus ring cleanup ([0848](https://tangled.org/burrito.space/peek/commit/08483e4ef820d8eece5fc28f7c113690ff002c82), [3100](https://tangled.org/burrito.space/peek/commit/3100ec71fc60978bc7cc89da1c1a5f8bf82f4e11), [3a07](https://tangled.org/burrito.space/peek/commit/3a072f24678bb375a193b04ea7fdb05b92d546be))

Desktop - Shortcuts & Commands
- [x] Dual hotkey registration — local Cmd+ alongside global Opt+ for palette, editor, tags, groups, HUD ([545e](https://tangled.org/burrito.space/peek/commit/545e95b47d436171406bc01c3783ac7d1e5ca382))
- [x] Query registered commands via pubsub ([696c](https://tangled.org/burrito.space/peek/commit/696c7859c3b10bb81a8ea741dbb65e595bbe3af3))
- [x] Fix frecency/adaptive sorting in command palette ([2f6d](https://tangled.org/burrito.space/peek/commit/2f6da3fd76ba4780daf8e0626bd45e9a50b1dd5e))

Desktop - Settings & Extensions
- [x] Rework extensions settings — separate Features vs Extensions sections, add options buttons ([cb54](https://tangled.org/burrito.space/peek/commit/cb54040945458d258ed48f9951820998ebdd6e75))
- [x] Dynamically list all builtin extensions in Features section ([90fe](https://tangled.org/burrito.space/peek/commit/90fe93d0fea4d2286ab6099ffd097e40205e1fef))
- [x] Generic settings/UI system for bundled Chrome extensions ([edbf](https://tangled.org/burrito.space/peek/commit/edbf5169a396539ed2d94df1b873690d168d7b7a))
- [x] Migrate ad blocker from @cliqz to @ghostery ([93b4](https://tangled.org/burrito.space/peek/commit/93b445613d086b8f1d4caea934d5e466a0b975a6))

Desktop - Fixes
- [x] Fix HUD focus stealing, chrome ext options styling, duplicate group cards ([4768](https://tangled.org/burrito.space/peek/commit/47686da71893feb30b286fbc5e45021e6f442e07))
- [x] Prevent duplicate windows/URLs, fix race conditions and title resolution ([20cb](https://tangled.org/burrito.space/peek/commit/20cb9956145d94e57a902a1976e1bd56a1242d4b))
- [x] Resolve extension disabled by settings key collision ([671d](https://tangled.org/burrito.space/peek/commit/671df42e33f9b08db4a058e98e8e4e6f7bdbddad))
- [x] Resolve window ID from caller when null, set mode before loadURL ([c1d7](https://tangled.org/burrito.space/peek/commit/c1d77f286c8ba45015514d6a836bf4a13df7f66a))
- [x] Align entity and script UIs with groups/tags component patterns ([c5df](https://tangled.org/burrito.space/peek/commit/c5df43bcf9d5f28dd1dbf129fe47612346c26b6f), [50c6](https://tangled.org/burrito.space/peek/commit/50c639ff3a591181e8bd6b10b8bfdd8f906406a3))
- [x] Use extension settings API for vim mode, audit localStorage usage ([3962](https://tangled.org/burrito.space/peek/commit/3962110b5db93447fd6b95379281de6a0223a203))
- [x] Pin Node version to 24.11.1 to match Electron 40 ([96c0](https://tangled.org/burrito.space/peek/commit/96c05941d16a0989f7407b00a63cda2994e52d24))

Testing
- [x] Add unified URL/history tests for unification refactor ([d3ac](https://tangled.org/burrito.space/peek/commit/d3ac05f7135ead6685d7c8ddb50ba378c2e700b9))
- [x] Add comprehensive test data for entity recognition ([d710](https://tangled.org/burrito.space/peek/commit/d710d039355e4e355c0c3e26844753c8c6d4e245))

## 2026-02-09

Desktop - IZUI Role-Based Redesign
- [x] Unified ESC handling, migrate components to shared peek-components, fix HUD tests ([21d5](https://tangled.org/burrito.space/peek/commit/21d59cc00e8516382e0425f2442019ff915936e5))
- [x] Role-based window policy — five deterministic roles (root, child-content, child-tool, hud, transient) govern ESC behavior and lifecycle ([3fbc](https://tangled.org/burrito.space/peek/commit/3fbcade9a47b8375e0e10d15bf693104587433f3))
- [x] Complete role-based migration — all window creation uses role policy, remove legacy session tracking ([8528](https://tangled.org/burrito.space/peek/commit/8528f053e1ef930b191eb2b834180eb84475851c))
- [x] Promote content to child-content when opened from parent window ([92d3](https://tangled.org/burrito.space/peek/commit/92d359c5c5ecdf8baa6aca5cdcc3fb81c34c7921))
- [x] Promote transient session on app focus, fix startup role ([055b](https://tangled.org/burrito.space/peek/commit/055b77ed748ccce030da378d116e1d8c503bf659))

Desktop - Navigation & UI
- [x] Restore floating nav bar — remove embedded regression ([9306](https://tangled.org/burrito.space/peek/commit/93060df349c11e0bae011121552a1901ec02c068))
- [x] Delegate click/focus through shadow DOM boundary in peek-card ([b15c](https://tangled.org/burrito.space/peek/commit/b15c6434bd885e0e00b31ce2ef62e670c282232c))
- [x] Migrate tags UI to shared peek-components for consistent styling ([3145](https://tangled.org/burrito.space/peek/commit/3145a08ad2604f17424b26604e8d1b003c4aacf9))
- [x] Align startupFeature schema default with actual default ([aab2](https://tangled.org/burrito.space/peek/commit/aab2b20b8a365fdb47c28554c9cbbf9062010ed2))
- [x] Delay URL processing to ensure app activation completes ([f0d1](https://tangled.org/burrito.space/peek/commit/f0d1e5bd1289caf470e9a6a9d793414abb3ae6a1))

Desktop - Entity Recognition
- [x] Entity recognition extension — extract entities (people, places, dates, etc.) from saved items with extensible matcher and store ([ae0c](https://tangled.org/burrito.space/peek/commit/ae0cd81109117239e4ad4ac0f30366246a1e94b9))

Desktop - HUD & Groups
- [x] Populate HUD mode, active window, and stats fields ([be18](https://tangled.org/burrito.space/peek/commit/be18f49f540738aab4bcd11cb2ab3f2c388ffd2e))
- [x] Preserve group context through page navigation ([1d69](https://tangled.org/burrito.space/peek/commit/1d69ce8fd81c9fc23faac81368fb004d7bb82d9a))
- [x] Disable FK checks during entity type migration ([9802](https://tangled.org/burrito.space/peek/commit/98025bcca6309076ea578a32b287d81091295a55))

Desktop - Shortcuts & Page
- [x] Guard ev.reply() against destroyed senders and add roundtrip tests ([49b6](https://tangled.org/burrito.space/peek/commit/49b626e9c92523f39dc190d8024770e84737d17d))
- [x] Use BrowserWindow ID not WebContents ID for shortcut callbacks ([d6fe](https://tangled.org/burrito.space/peek/commit/d6fe8cbfe845cd081eb712d6add07b4b08dab227))
- [x] Resolve stale IPC reference in global shortcut callbacks ([221d](https://tangled.org/burrito.space/peek/commit/221d5a442d970de8a1db07dfd4f5816b607a60f2))
- [x] Content-sized BrowserWindow instead of fullscreen canvas ([2eb7](https://tangled.org/burrito.space/peek/commit/2eb7a7037b92ef3d9a3961a39de2774fbf41ecff))

Desktop - Command Bar
- [x] Restore URL detection for domains without protocol (youtube.com) ([8abf](https://tangled.org/burrito.space/peek/commit/8abf13b6300b6735ff748d65a71145f584972fed))

Sync Architecture
- [x] Separate sync pull from user operations — server metadata preserved naturally ([b3cb](https://tangled.org/burrito.space/peek/commit/b3cbb47e44fa6fb766c98a1e87547d86f2fce87c))
- [x] Remove syncSource from schema, replace with device ID tracking via _sync metadata ([3ffa](https://tangled.org/burrito.space/peek/commit/3ffa9bf15275feeafcb1fcef5cfce0013276d7db))
- [x] Remove sync_source usage from iOS sync ([3ca3](https://tangled.org/burrito.space/peek/commit/3ca335f097031f0d227d9d4984274f019a53f05d))
- [x] Add device ID and _sync metadata to mobile backend ([abc4](https://tangled.org/burrito.space/peek/commit/abc408159b76a74cf8712ab42e6c6f572b9f9ebc))

Mobile / iOS
- [x] Native inline WKWebView and fix dev build pipeline ([ac11](https://tangled.org/burrito.space/peek/commit/ac1154e70ac137d8c4079ebfd90fbf504c951f9e))
- [x] Separate dev/release build paths and enable media autoplay ([5044](https://tangled.org/burrito.space/peek/commit/5044478650895bf02ea44ab07247a1437de290c4))
- [x] Prevent white flash when opening inline webview ([edc1](https://tangled.org/burrito.space/peek/commit/edc1b5b97953a149f48bdea6f7b02e5a00e1b26a))
- [x] Tighten header layout alignment ([6f63](https://tangled.org/burrito.space/peek/commit/6f639e85a362d16b7a3a0d40d55d2369fb679929))
- [x] Editor overlays fill to keyboard, tagset cards use tag chips ([bb03](https://tangled.org/burrito.space/peek/commit/bb032a08cc463712f90feff4d66d2e79c89ff534))
- [x] Replace Once::call_once with retryable Mutex for DB init ([bb02](https://tangled.org/burrito.space/peek/commit/bb02d53584824cc53a8231b5edf603798a309933))
- [x] Hide from:history items from default list view ([c6ac](https://tangled.org/burrito.space/peek/commit/c6acfc60))
- [x] Separate derivedDataPath for simulator and device builds ([d687](https://tangled.org/burrito.space/peek/commit/d687029109f05f5d20cebeb6b3c459e1f86469fe))
- [x] Add --standalone flag to embed real frontend in iOS builds ([90c7](https://tangled.org/burrito.space/peek/commit/90c7f5d80c3c7333c51c4838a3b04597b4dff348))

Testing
- [x] Add comprehensive URL detection tests for command panel ([ccc5](https://tangled.org/burrito.space/peek/commit/ccc5a13b2af9dff5333de06918bd9b89595dcd30))
- [x] Add syncSource migration simulation tests ([7273](https://tangled.org/burrito.space/peek/commit/72731acf9cd9d3be88c0a1f8f5f92217c023ce70))
- [x] Add unit tests for entity extractors, matcher, and store ([8759](https://tangled.org/burrito.space/peek/commit/8759b7070b4d9fb4703d9b3533a2b3b3d6c22a69))
- [x] Add mode context propagation tests ([5fbc](https://tangled.org/burrito.space/peek/commit/5fbcc1cae400d44fba0007d77155937b7e03b7a7))
- [x] Deterministic profile IDs via PEEK_PROFILE_ID env var ([7c61](https://tangled.org/burrito.space/peek/commit/7c61aa6e47e5d0b03b63918b68134c449d99b867))
- [x] Run unit tests under Electron's Node to match native module ABI ([e1e0](https://tangled.org/burrito.space/peek/commit/e1e0c7c5c989c296fc75adf8f493ada592443caa))
- [x] Enable single-user mode for e2e tests ([c6c2](https://tangled.org/burrito.space/peek/commit/c6c249b52830b6efd18b2d91ea2eaad6e3bc94f6))

## 2026-02-02

Desktop - IZUI (Inverted Zooming User Interface)
- [x] IZUI state machine for transient vs active window behavior — centralized state tracking, ESC behavior depends on context ([457c](https://tangled.org/burrito.space/peek/commit/457ce41d3dd96dc2447951347ce5047f85d87029))
- [x] OS-level focus for transient detection, graceful test shutdown ([e176](https://tangled.org/burrito.space/peek/commit/e17643284ffa2e175fa4d48aca1b973382a60b96))
- [x] Passive backend window manager — extensions open their own windows via API ([1888](https://tangled.org/burrito.space/peek/commit/188894c4855996600fbbb1702a592b6a2b6be035))
- [x] Child windows always close on ESC, new windows centered on screen ([b0d0](https://tangled.org/burrito.space/peek/commit/b0d07b893143dff7da8fdebc2669e0520c01a2a8))
- [x] Visibility-based transient detection and active mode ESC protection ([d74b](https://tangled.org/burrito.space/peek/commit/d74b62b550f87d05a927a1f5e3fee75b82159355))
- [x] Center child windows over parent window, restore focus on close ([bd94](https://tangled.org/burrito.space/peek/commit/bd947dbcbcd76009990571d8292f283d81268cd1))
- [x] Renderer-driven escape lifecycle for navigate mode windows ([dc47](https://tangled.org/burrito.space/peek/commit/dc470b7fe05f1b83c77f66e4ffe0b38522848919))
- [x] Fix ESC navigation, window drag, and navbar cleanup ([3ca4](https://tangled.org/burrito.space/peek/commit/3ca4841b6a279c6280d9673632b64f6433e88f45))
- [x] Fix transient detection race condition ([d634](https://tangled.org/burrito.space/peek/commit/d634a52bd07f2b64112e5a7d6cd3e60119a5a959))
- [x] Clean up modes, remove overlay, fix IZUI navigation stack ([6be5](https://tangled.org/burrito.space/peek/commit/6be5fc453d88914a3536d66cc6ecb80e5118d731))
- [x] Filter peek:// URLs and fix IZUI stack navigation ([70ab](https://tangled.org/burrito.space/peek/commit/70ab1706b21a2456b0f5896a60ac5acf0e23c5d2))
- [x] Remove vestigial overlay references and rename events ([1640](https://tangled.org/burrito.space/peek/commit/164028401acd7efb18e149270868cb6ca3ddf220))
- [x] Remove non-existent overlay from consolidated extension IDs ([518c](https://tangled.org/burrito.space/peek/commit/518c44065a4b23cd221bca9f1e054eeb5ea6a7c9))

Desktop - Reactivity & Events
- [x] Tag-centric events for real-time UI updates — tag:created, tag:item-added, tag:item-removed ([8c22](https://tangled.org/burrito.space/peek/commit/8c229cdf68c32bb51332f49c7feb6093b7201a2e))
- [x] Item CRUD events with debouncing, history/feeds subscriptions ([1d35](https://tangled.org/burrito.space/peek/commit/1d351083780203bd00166ecf0d800167f5d038bb))
- [x] Implement item_events table and CRUD operations ([7895](https://tangled.org/burrito.space/peek/commit/78950782d132b1f3e2fc25b5e76fd10dbdb52759))
- [x] Expose item_events API to renderer ([f8f8](https://tangled.org/burrito.space/peek/commit/f8f85ebcba23b323d93c38bd97a4308c7472301d))

Desktop - Window Management
- [x] Add overlay mode for transient full-screen views ([0727](https://tangled.org/burrito.space/peek/commit/0727112b71e08949c5c85ab1f4ae11eb4e5f519c))
- [x] Hide other windows after windows view opens ([37ee](https://tangled.org/burrito.space/peek/commit/37ee7d4361aa10d5f320a4d41c7985837b2a75c4))
- [x] ESC always closes windows, remove fallback emoji ([3fdd](https://tangled.org/burrito.space/peek/commit/3fddd1a6beaaeb2d9032c5a697d2a1b3814726c3))
- [x] Transparent background with groups/tags card style ([414e](https://tangled.org/burrito.space/peek/commit/414e2139f66fa276266fe53e27f4b8c563c8301d))
- [x] Use peek-card and peek-grid components for windows ([666e](https://tangled.org/burrito.space/peek/commit/666efa8d77ddf47fa81f214cff5e8564db06d074))
- [x] Fix component import paths ([8b66](https://tangled.org/burrito.space/peek/commit/8b6686e4809a891ee9db6007fb5c79d7ab059b3d))

Desktop - Architecture & Modes
- [x] App-wide context API for extensible mode management ([196a](https://tangled.org/burrito.space/peek/commit/196a12d063dcb5c6eafca5a2e9c40b9b1ab4c474))
- [x] Consolidate modes into context API and datastore ([5943](https://tangled.org/burrito.space/peek/commit/5943e2232e66658377ba0843d607f7ee0101f605))
- [x] Simplify to page/group/default modes ([eab5](https://tangled.org/burrito.space/peek/commit/eab54a3ff2b29957873ecd224dd419f8d8185511))
- [x] Add feeds and series architecture ([8688](https://tangled.org/burrito.space/peek/commit/8688c50133ebac280772bca4173b5ee99cd4a61b))
- [x] Add feed reader extension ([44c5](https://tangled.org/burrito.space/peek/commit/44c5b507a1d0f879ba60c68de0b1e529bc5feed9))

Desktop - Editor & Commands
- [x] Note editing flow with autosave ([0ae5](https://tangled.org/burrito.space/peek/commit/0ae56bb7c9586de0c2c9cf14245148ae9de2ecfd))
- [x] Restore mode indicator to command bar — shows current mode, click to cycle ([9176](https://tangled.org/burrito.space/peek/commit/917640cacdb7e6f016cdd7e5a4dec3434a198d4b))
- [x] Add "Sync now" command for manual sync trigger ([18d0](https://tangled.org/burrito.space/peek/commit/18d02d2cd3d65f60537a1d1622923c0696029999))
- [x] Use connector pattern for edit and note commands ([4846](https://tangled.org/burrito.space/peek/commit/48465f72a50e5b801a71e9c09c4262dff0636ebb))
- [x] URL command returns error instead of opening editor when no URL provided ([5141](https://tangled.org/burrito.space/peek/commit/5141fb07b095f117552fd8ce461ac318f5907219))

Desktop - UI & Components
- [x] Add glass-morphism tokens and component modes ([7b2e](https://tangled.org/burrito.space/peek/commit/7b2e52dca752a2c46920364667e0f58a42360ba2))
- [x] Center card headers, disable URL input autocapitalize, fix dev script ([aa57](https://tangled.org/burrito.space/peek/commit/aa578e0d91539d6f4d7b6e177e993106e9e9b226))
- [x] Set default background on webview content when page has none — respects system theme ([9fc2](https://tangled.org/burrito.space/peek/commit/9fc274ab7ffc402f4409769023bed2bfcb439d3e))
- [x] Use trackNavigation for URL visit recording ([f267](https://tangled.org/burrito.space/peek/commit/f267789149b2418d4e58d90f24da86c023bf930f))

Desktop - Profiles & Startup
- [x] Chromium session partition isolation per profile ([2d70](https://tangled.org/burrito.space/peek/commit/2d704158814b911fd76579febe03ea6119e596ea))
- [x] Register peek:// protocol on profile session ([cd80](https://tangled.org/burrito.space/peek/commit/cd80de8d23562964ac212b240f49813535f9b1d3))
- [x] Respect startupFeature pref instead of always opening settings ([5b92](https://tangled.org/burrito.space/peek/commit/5b920fab23aa7c30105f3e435931a0d25092fa70))

Desktop - Fixes
- [x] ESC handling for Active mode windows (IZUI policy compliance)
- [x] Add getFocusedVisibleWindowId API for modal window targeting
- [x] Add trackNavigation API for unified page load tracking
- [x] Update test to use peek://ext/cmd/panel.html
- [x] Window-list returns actual URLs from peek://app/page containers
- [x] Mode detection from URL in window creation
- [x] Add native module check script (prevents NODE_MODULE_VERSION mismatch)
- [x] Unit tests run under Electron's Node to match native module ABI
- [x] Cast address to string for type safety ([32a7](https://tangled.org/burrito.space/peek/commit/32a7f8a0b97b12718211cc4cd39264cea5a6de49))
- [x] Sanitize window params to prevent serialization crash ([fca6](https://tangled.org/burrito.space/peek/commit/fca6a26f963623bc04a94bc2361cb9e4f49a2678))
- [x] Exclude tmp/ agent workspaces from electron-builder ([f0f2](https://tangled.org/burrito.space/peek/commit/f0f26e312d0174f2d6a304ed8638145d09a2c94b))
- [x] Electron-builder uses yml config via extends ([4620](https://tangled.org/burrito.space/peek/commit/4620155f4f96c9a42bdf00211967efa547063e19))
- [x] Normalize trailing slash on bare domain URLs ([3c2b](https://tangled.org/burrito.space/peek/commit/3c2bbd619327e7cb6dfbba027ce1805d5873e0b2))

Mobile / iOS
- [x] URL action icons with native WKWebView + visit tracking — open in Safari or embedded webview ([ee06](https://tangled.org/burrito.space/peek/commit/ee06ef990eb2bad8a17de65708a088198625e7f7))
- [x] Simplify Swift webview integration with direct FFI ([1825](https://tangled.org/burrito.space/peek/commit/182588302aef990b8ced2c8b4bd1143ba813653f))
- [x] Fix native webview and restore icon system ([1b64](https://tangled.org/burrito.space/peek/commit/1b641ed1fdd510c83847c8cf213cc14eac5e1319))
- [x] Require hold gesture for pull-to-refresh to prevent accidental triggers ([0efb](https://tangled.org/burrito.space/peek/commit/0efb444539dba1d4cc7ed5cbd68815978ee2a5b0))
- [x] Bottom sheet webview ([80fb](https://tangled.org/burrito.space/peek/commit/80fb7d8f9f3df9d064720c4801c91af0898e611f))
- [x] Card-expansion iframe overlay replaces native bottom sheet ([eb43](https://tangled.org/burrito.space/peek/commit/eb43f135aaf8ed51c69dff6d7726cf995bf0c3ed))
- [x] Silence linker warnings and remove unused default icons ([8cd3](https://tangled.org/burrito.space/peek/commit/8cd36323c9173e18559108b909718589433bbcda))
- [x] UX polish pass — 18 fixes for editor, share extension, layout, build ([cf5f](https://tangled.org/burrito.space/peek/commit/cf5fe38b9cf9148fb2b506085aced75a0871221f))
- [x] UX polish — 13 fixes for share sheet, editor, keyboard, sorting, filters ([956f](https://tangled.org/burrito.space/peek/commit/956fdcb80b723c155a25195e6a6aa55e9a35b336))
- [x] Maximize editor card space — tighter padding, expand to edges ([2a0f](https://tangled.org/burrito.space/peek/commit/2a0fc4bf7c778068a7a76bee723410d98a44265b))
- [x] Undo/redo at top, reduce gaps, add webview link for text items ([90d7](https://tangled.org/burrito.space/peek/commit/90d76c5178864b8d313333b0a6507b64ff1eaf6b))
- [x] Commit pending tag text when Done is tapped ([712a](https://tangled.org/burrito.space/peek/commit/712a5108ebca84bfa96143b6dfd12d0725a79b54))
- [x] Use dynamic DerivedData path for sim:install ([9442](https://tangled.org/burrito.space/peek/commit/94420c1731e25992049d270b48b6a0626f13a54e))

Testing
- [x] Add Playwright browser extension e2e tests
- [x] Improve extension ID detection and shared instance handling
- [x] Remove Firefox Playwright support (not supported by Playwright)
- [x] Add integration tests for tag-centric events ([ed9d](https://tangled.org/burrito.space/peek/commit/ed9dd17a41ba94b54faae75cd595934f2e9cecb2))

Refactoring
- [x] Move tag and tagset commands to tags extension ([d663](https://tangled.org/burrito.space/peek/commit/d6636aaa3087c2ec7bcf817363f16a9b7c901244))
- [x] Create files extension with csv and save commands ([435c](https://tangled.org/burrito.space/peek/commit/435cc952196795389322bda8f9f9d48b176c4340))
- [x] Create sync extension with sync command ([e586](https://tangled.org/burrito.space/peek/commit/e5867452459b6c136b01c663d1237cc3c05a4899))

Datastore & UI
- [x] Show addresses/visits/tags stats with safe error handling
- [x] Extract stats from result.data wrapper
- [x] Clean up settings and diagnostic UI

Code Cleanup
- [x] Remove vestigial app/cmd/ directory (24 files, replaced by features/cmd/)
- [x] Remove app/scripts/ (disabled feature with missing HTML files)
- [x] Remove dead functions from app/index.js
- [x] Remove Cmd and Scripts entries from app/config.js
- [x] Simplify app/features.js (all features are now extensions)
- [x] Remove commented-out sendToWindow/onMessage APIs from preload.js
- [x] Remove 7 unused IPC handlers from ipc.ts (~155 lines)

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
