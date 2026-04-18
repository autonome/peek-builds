# Phase 3 — v1-removal destructive cleanup

## Status

Starting Phase 3. Phase 1 and Phase 2 are landed:
- cmd/hud/page run on `tile-preload.cts` + `createTrustedBuiltinGrant()` (Phase 1).
- Playwright test fixture `bgWindow` is `peek://test/index.html` (v2 BrowserWindow via `test-fixture-glue.ts`). `getBackgroundWindow()` returns the v2 renderer. (Phase 2.)
- URL.origin-for-peek:// broadcast-filter bug fixed in `b8dbc1b8`.

## Pre-deletion audit — key findings

### Files already absent (no work needed)

- `app/background.js` — does not exist.
- `backend/electron/preload.js` — does not exist. v1 preload lives at
  repo root: `/Users/dietrich/misc/mpeek/preload.js`.

### v1 preload.js (root) — STILL LIVE

Referenced from:
- `backend/electron/entry.ts:149` — `getPreloadPath()` consumer;
  assigned as preload for background window (main.ts:2109), webviews
  loading `peek://` URLs (entry.ts:179), and window.open callbacks
  (ipc.ts:2296, ipc.ts:2698).
- `backend/tauri/src-tauri/src/lib.rs:30` — `include_str!` for Tauri
  (mobile) backend to inject as main-world script.
- Cross-cutting: v1 tiles (remaining consolidated features, external
  extensions, `app/background.html` / `WEB_CORE_ADDRESS`) depend on
  the v1 `window.app` surface.

**Cannot delete in Phase 3.** Requires migrating:
- `WEB_CORE_ADDRESS` background window to a v2 renderer.
- All remaining consolidated v1 feature extensions (there is still a
  `CONSOLIDATED_EXTENSION_IDS` list with ~20 features that load via
  `loadExtInHost` into `extensionHostWindow` with `preload.js`).
- External chrome-style extensions loaded via `createExtensionWindow`.

### `app/background.html` — STILL LIVE (as WEB_CORE_ADDRESS)

Referenced from `backend/config.ts:12` as `WEB_CORE_ADDRESS`. Loaded
by `createBackgroundWindow()` in `main.ts:2116`. Plus session.ts and
ipc.ts special-case it as an internal URL never saved/restored.

Plan's Part A says this was replaced by `app/_test/index.html` for the
test fixture, and implies it's deletable. But `createBackgroundWindow`
is a separate code path (the core app's persistent window) still
pointed at it. This is OUT of Phase 3's safe scope.

### `extensionHostWindow` / `loadExtInHost` / `extensionWindows` — STILL LIVE

Used to load ~20 remaining v1 feature extensions (CONSOLIDATED_EXTENSION_IDS)
as iframes in a single shared host window. Features not yet migrated
to v2 include: editor, groups, lex, lists, peeks, search, slides,
spaces, websearch, windows, files, pagestream, sheets, tags, feeds,
helpdocs, entities, scripts, timers, wonderwall.

**Cannot delete in Phase 3.** This was the understanding stated in
v1-removal-plan.md's Option A2 ("keep test fixture out of v1 cleanup"
— but also applies to v1 features).

### tile-preload.cts legacy fallback branches — CONDITIONAL

The plan's idea is "these become unconditional strict paths once v1 is
deleted". But v1 isn't deleted (see above). Converting these to strict
would break any v2 tile that doesn't declare the relevant capability —
unclear if any exist, but audit cost exceeds budget.

## What is actually doable in Phase 3

Given the above, the ONLY deletions that are safe within the 90-minute
budget without scope creep are very small or none. The plan's Phase 3
preconditions (Phase 1 AND Phase 2 AND all v1 features migrated) are
not all met — only Phase 1 + Phase 2 are complete, with ~20 v1 features
still loading via `extensionHostWindow` + `preload.js`.

Plan for this run:

1. Commit this triage stub (documents the blocker).
2. Investigate tile-preload.cts fallback conversions that are proven
   dead (no v2 tile could hit the fallback) — this is the one slice
   that might be safely unwound without touching shared plumbing.
3. If no safe slices, commit a follow-up doc note to `v1-removal-plan.md`
   explaining that Phase 3 requires Phase 2.5 — "migrate remaining v1
   features to v2" — and exit.

## Open items for Phase 4 / a future "Phase 2.5"

- Migrate `CONSOLIDATED_EXTENSION_IDS` features off `loadExtInHost` to
  v2 tile launcher (each one: manifest capabilities, tile-preload).
- Migrate `createBackgroundWindow()` / `WEB_CORE_ADDRESS` to v2.
- Migrate `createExtensionWindow()` (external extensions).
- Audit `session.ts`, `ipc.ts` INTERNAL_URLS, `session.test.ts`,
  `closed-window.test.ts` for `peek://app/background.html` references
  after migration.
- Tauri `lib.rs` reads `preload.js` via `include_str!` — ensure parity
  of any replacement for mobile backend.
