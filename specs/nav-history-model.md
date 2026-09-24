---
enabled: true
touches: [apps/desktop/main/nav-history.ts, apps/desktop/main/nav-history.test.ts]
depends-on: []
---

# A pure back/forward-history snapshot module for reopen and session restore

Part of Peek item `452cd2c2`. This is the first slice: the Electron-free data model, size rules and
per-window cache that the undo-close and session-restore slices both build on. Nothing in this slice
is wired into a window yet.

## Problem

A closed page-host window comes back (undo-close, session restore) at its final URL only; its
back/forward trail is gone. Both restore paths need the same payload, and each needs the same rules
for how much history to keep and how to read it back safely from a persisted JSON row. Today no code
under `apps/desktop/main` captures `webContents.navigationHistory` entries or calls
`navigationHistory.restore` (the only uses are `canGoBack`/`goBack`/`goForward` in `ipc.ts` and
`tile-ipc.ts`).

## What goes

A new `apps/desktop/main/nav-history.ts`, importing nothing from `electron` (it must load under
`ELECTRON_RUN_AS_NODE=1` like `session-projection.ts`; the webContents is a structural parameter type):

- `NavHistoryEntry` = `{ url: string; title: string }`. No `pageState`: Chromium's page-state blob is
  2-20 KB per entry and would inflate the session row by roughly two orders of magnitude.
- `MAX_NAV_HISTORY_ENTRIES` = 50 and `MAX_NAV_TITLE_LENGTH` = 512.
- `captureNavHistory(entries, activeIndex)`: takes what `navigationHistory.getAllEntries()` and
  `getActiveIndex()` return and produces `{ navHistory, navHistoryIndex }`, or `null` when there is no
  trail to keep (fewer than 2 entries, or a non-finite index). Strips everything but url and title,
  truncates titles. When there are more than 50 entries it keeps a window of 50 that always contains the
  active entry, preferring the newest: start at `len - 50`, moved down to the active index if the user
  had gone back past it; `navHistoryIndex` is the active index relative to the kept window. (Slicing the
  last 50 and clamping the index, as the item's draft snippet does, points at the wrong page when the
  user was back in the trail at close time.)
- `readNavHistory(source)`: takes anything with optional `navHistory` / `navHistoryIndex` properties
  (a persisted closed-window entry, a session descriptor, or window-open options) and returns the same
  `{ navHistory, navHistoryIndex }` shape or `null`. Defensive against legacy and malformed rows: absent
  fields, a non-array, entries whose `url` is not a non-empty string, or a length under 2 all yield
  `null`; an over-long array is re-capped with the same window rule; a missing or out-of-range index
  defaults to the last entry.
- A per-window last-known cache keyed by the Electron window id: `refreshWindowNavHistory(windowId,
  wc)`, `seedWindowNavHistory(windowId, history)`, `getWindowNavHistory(windowId)`,
  `clearWindowNavHistory(windowId)`. `wc` is a structural type with `isDestroyed()` and
  `navigationHistory.getAllEntries()` / `getActiveIndex()`. Refresh is a no-op for a destroyed wc and
  swallows a throwing wc; a wc reporting zero entries (a deferred restore whose content has not loaded)
  leaves the cache untouched so a seeded trail survives; a wc reporting one entry clears the window's
  cache entry. The cache exists because on a page-host close the content webContents is torn down before
  the close-finalize tail runs, so the trail cannot be read live at close time; both later slices read
  this cache instead.
- `restoreNavHistory(wc, history)`: resolves `true` after calling `wc.navigationHistory.restore({
  entries, index })`, and `false` for a destroyed wc or a rejected/throwing restore, so a caller can fall
  back to a plain `loadURL(url)`. `wc` is a structural type with `isDestroyed()` and
  `navigationHistory.restore`.
- A header comment stating that navigation history is local machine state and is not part of any sync
  schema or synced topic.

## What stays

Everything else. `ClosedWindowEntry` (`main.ts`), `WindowDescriptor` (`window-registry.ts`),
`session-projection.ts`, `ipc.ts` and `session.ts` are not touched here.

## Tests to change

A new `apps/desktop/main/nav-history.test.ts` (compiled to `dist/main/`, run under the electron
runner) covering: capture strips `pageState` and truncates titles; capture returns `null` for 0 and 1
entries; the 50-entry window with the active entry at the end, in the middle and at index 0 of a
60-entry list; `readNavHistory` on a well-formed value, an absent value, each malformed shape above, and
a legacy closed-window-shaped object with no history fields; the cache (seed, refresh replaces, zero
entries leaves it, one entry clears it, destroyed wc ignored, throwing wc swallowed, clear); and
`restoreNavHistory` against fake targets (passes `entries` and `index`, `false` on destroyed, `false`
on rejection).

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when the electron runner reports `fail 0` with the new `nav-history.test.ts` cases included in the
count, and the node unit runner reports `fail 0`. Record both counts under **Result**.
