---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src/store.ts, apps/mobile/src/App.css, apps/mobile/src/tag-order.js, apps/mobile/src/tag-order.d.ts, apps/mobile/tests/tag-order.test.js, apps/mobile/peek-core/src/items.rs, apps/mobile/peek-core/src/lib.rs, apps/mobile/src-tauri/src/lib.rs]
depends-on: [mobile-sync-behaviour]
---

# Mobile list: last-modified sort, recency tag sort, selected tags on top

Peek items `38aa3c4c` (list sorted by sync-arrival time), `642030c4` (last-modified sort), `6070557b` (recency-only tag order), `86665c56` (selected tags on top).

## 38aa3c4c: already correct in code

The item says the list orders by when an item arrived via sync. The code does not. `peek-core/src/items.rs query_items` orders by `i.created_at`. Sync ingest in `peek-core/src/sync.rs` (the INSERT in the merge path) stores `created_at` and `updated_at` from the server item via `unix_ms_to_iso`, so synced items keep their real dates. Do not change the sort key. Add only the regression test below, which shows an older synced item sorts below a newer local one. If that test fails, the order is wrong after all: fix it, and record that under `**Result**`.

## Problems to fix

1. The sort control offers only newest and oldest. Add last-modified (by `updated_at`). Editing an item moves it to the top in that order. The choice persists.
2. The tag list has only frecency order. Add a recency-only order (last used, newest first). Frecency stays the default. The choice persists in localStorage.
3. Selected tags must be grouped at the top of the header tag list, in their existing relative order. Deselecting returns the tag to its place.

## What the code does now

- `App.tsx`: `sortOrder` state (`'newest' | 'oldest'`, localStorage key `sortOrder`), the `sort-btn` header button that toggles between them, and an effect that calls `storeActions.setSort`.
- `store.ts`: the `QuerySlice.sort` type, `setSort`, `buildArgs` (passes `sort` to `query_items`) and `lastCursor` (cursor is `{ saved_at, id }`). `ItemRow` and `UnifiedItem` carry `saved_at` only, which is `created_at`.
- `peek-core/src/items.rs`: `QueryItemsArgs.sort` ("newest"/"oldest"), `Cursor { saved_at, id }` and keyset predicates on `(i.created_at, i.id)`. `ItemRow.saved_at` equals `created_at`.
- Edits end with `loadSavedUrls()`-style calls, which trigger `storeActions.reloadCoalesced()`, so an edit already reloads the list.
- Tags: `get_tags_by_frecency` and `get_tags_by_frecency_for_url` (`peek-core/src/tags.rs`) return `TagStats { name, frequency, last_used, frecency_score }`. `types.rs TagStats` has no `rename_all`, so the JSON keys are snake_case (`last_used`). The TS interface `TagStats` in `App.tsx` declares `lastUsed` and `frecencyScore`, which is wrong. Nothing reads them today. Fix the interface to match the real keys before using them.
- The header tag list is `filteredTags` (a `useMemo` over `allTags`) rendered with the `selected` class for tags in `selectedFilterTags`. `TagsSection` already shows selected tags in their own block above the unused ones, so the editor and add pickers already satisfy item 3. Do not change them.

## Decisions

- The sort control cycles newest, oldest, modified. A different icon marks modified (a clock) and the button title names it. A stored unknown value falls back to `newest`.
- Value `"modified"` orders `COALESCE(i.updated_at, i.created_at) DESC, i.id DESC`. The keyset cursor field `saved_at` carries the active sort column's value (rename nothing). Add `updated_at` to `ItemRow` and `UnifiedItem` so `lastCursor` can read the right column for the active sort. Existing newest and oldest behaviour is unchanged.
- Tag recency is sorted in JS from `last_used` (descending), not in Rust. The data is already returned, so no new command is needed. It applies to every tag list that renders `TagStats` (header list and pickers). The domain-boosted list in the URL editor also follows the chosen order.
- The tag order toggle sits next to the header tag list (a small segmented control labelled "Frecent / Recent"), localStorage key `tagOrder`, default `frecency`.
- The comparator lives in a new `apps/mobile/src/tag-order.js` (with a `.d.ts`): `orderTags(tags, { mode, selected })` returns a new array. The selected group is stable-first, `mode` orders both groups, and ties keep input order.

## What changes

- `items.rs`: add the "modified" order and cursor handling to `query_items`. Update the `QueryItemsArgs.sort` doc comment and `ItemRow`. Check `src-tauri/src/lib.rs query_items` and the core `lib.rs` wrapper compile unchanged apart from the new field.
- `store.ts`: widen the sort union, add `updated_at` to the row and item types, and make `lastCursor` take the sort.
- `App.tsx`: three-state sort cycle and icon, validated persistence, `tagOrder` state and toggle, `TagStats` interface fix, and `orderTags` applied to the header list and `availableTags` props.
- `tag-order.js`, `tag-order.d.ts`.

## Tests to change

- `peek-core/src/items.rs` tests module: (a) an item inserted locally later but with an older `created_at` than another sorts below it in "newest" and above it in "oldest" (regression for `38aa3c4c`); (b) "modified" orders by `updated_at`, and paging with the cursor across a page boundary neither repeats nor skips an item.
- New `apps/mobile/tests/tag-order.test.js` (`node:test`): frecency mode keeps input order, recency mode sorts by `last_used` descending, selected tags come first with their relative order kept in both modes, and deselecting restores the order.

## Verify

Worker runs and records:
1. `yarn mobile:build` succeeds.
2. `node --test apps/mobile/tests/tag-order.test.js` reports `fail 0`, and `node --test apps/mobile/tests/*.test.js` shows no new failure.
3. `cargo test --manifest-path apps/mobile/peek-core/Cargo.toml` reports `0 failed`. Per `apps/mobile/CLAUDE.md`, mobile Rust tests run only from the standing mobile workspace. If the worker is not there, record "cargo test not run" under `**Result**` (needs the account holder).

Manual check (no automated UI test; either platform). The worker cannot run it. Record under `**Result**` as awaiting a manual check by the account holder:
1. `yarn mobile:ios:sim:run` (or `yarn mobile:android:dev`).
2. On a second client, create item X, wait until it is at least a day older than what you create next. On the phone, create Y. Sync from settings. Expected: Y sits above X, still after a force-quit and relaunch.
3. Tap the sort button until last-modified shows. Open an old item far down the list, edit and save it. Expected: it is at the top. Newest and oldest still behave as before. After a force-quit and relaunch the app is in last-modified order.
4. Apply a rarely-used tag to an item. Switch the tag list to Recent. Expected: that tag is at the top, while in Frecent it stays low. After a relaunch the app reopens in Recent.
5. With enough tags that the header list scrolls, select a tag from near the bottom, then a second, then deselect the first. Expected: each selected tag moves to the top group in its original relative order, and the deselected one drops back. The editor and add tag pickers behave the same (they already do).

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Run one command per Bash call.
