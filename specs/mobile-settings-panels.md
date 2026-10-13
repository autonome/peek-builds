---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src/App.css, apps/mobile/src/reader.css, apps/mobile/src/font-scale.js, apps/mobile/src/font-scale.d.ts, apps/mobile/tests/font-scale.test.js, apps/mobile/peek-core/src/lib.rs, apps/mobile/peek-core/src/offline.rs, apps/mobile/peek-core/src/types.rs, apps/mobile/src-tauri/src/lib.rs]
depends-on: [mobile-gestures]
---

# Mobile settings: storage and item-count stats, font size slider

Peek items `a7abaa51` (stats panel: disk size and item counts) and `be9f3c4f` (font size slider).

## Problems

1. Settings reports only sync state. There is no view of how much space the local store uses, how many items of each type exist, or how many pages are cached for offline reading.
2. Text sizes are fixed. The user has no control.

## What the code does now

- Stats: the Rust command `get_offline_storage_size` (`src-tauri/src/lib.rs`, core `offline::get_offline_storage_size`) returns `SUM(size_bytes)` from the `offline_content` table. The `items` table has `type` (`url`, `text`, `tagset`, `image`) and `deleted_at`. The `blobs` table holds image data with `size_bytes`. `get_sync_status` already returns a pending count. The Settings view in `App.tsx` is the early-returned `if (showSettings)` branch, built from `settings-section` blocks. Commands are registered in the `invoke_handler` list in `src-tauri/src/lib.rs`.
- Fonts: `App.css` has about 85 `rem` or `em` font sizes and about 15 fixed `px` ones. `reader.css` has 9 `rem`/`em` sizes and 1 `px`. Settings already stores preferences in localStorage (`sortOrder`, `filterTagsHeight`, ...).

## Decisions

- Stats come from one new core function and one command, `get_storage_stats`, returning `{ dbSizeBytes, offlineBytes, totalBytes, counts: { url, text, tagset, image }, offlineItemCount }` with camelCase keys (use `#[serde(rename_all = "camelCase")]` on the new type). `dbSizeBytes` is `PRAGMA page_count * page_size`. A WAL file is not included. `offlineBytes` is the existing `SUM(size_bytes)` over `offline_content`. Counts exclude soft-deleted items. `offlineItemCount` counts `offline_content` rows joined to non-deleted items. The panel shows the numbers as they come, with sizes formatted in KB/MB in the UI.
- The panel loads when Settings opens (an effect keyed on `showSettings`), not at app start.
- Font scale: a slider from 80% to 140% in steps of 10, default 100%, stored under `fontScale` in localStorage and applied as a root CSS variable `--font-scale`. The root `font-size` becomes `calc(100% * var(--font-scale, 1))` so every `rem` size follows. The roughly 16 fixed `px` font sizes are converted to `calc(Npx * var(--font-scale, 1))`. `em` sizes follow their parent. List, editor and reader view all scale. Fixed icon sizes (SVG width and height) do not scale.
- The parse and clamp logic is in a new `apps/mobile/src/font-scale.js` (with a `.d.ts`): `parseFontScale(raw)` returns a value in [0.8, 1.4] and 1 for bad input.

## What changes

- `peek-core`: a `get_storage_stats` store method (in `lib.rs` backed by `offline.rs`) and its type in `types.rs`. `src-tauri/src/lib.rs`: the command and its registration.
- `App.tsx`: the `StorageStats` interface, the load effect, the stats panel in Settings, the slider and the persistence effect that sets `--font-scale`. `App.css` and `reader.css`: the root rule and the `px` conversions.
- `font-scale.js` and `font-scale.d.ts`.

## Tests to change

- `peek-core` tests: insert items of each type plus one soft-deleted item, and one `offline_content` row, then assert the counts, `offlineItemCount` and that `dbSizeBytes` is above 0 and grows after inserting a large blob.
- New `apps/mobile/tests/font-scale.test.js`: valid values pass through, out-of-range values clamp, and null or garbage returns 1.

## Verify

Worker runs and records:
1. `yarn mobile:build` succeeds.
2. `node --test apps/mobile/tests/font-scale.test.js` reports `fail 0`, and `node --test apps/mobile/tests/*.test.js` shows no new failure.
3. `cargo test --manifest-path apps/mobile/peek-core/Cargo.toml` reports `0 failed`. Rust tests run only from the standing mobile workspace (`apps/mobile/CLAUDE.md`). If the worker is elsewhere, record "cargo test not run". The `src-tauri` command is compiled only by a device or simulator build, so record that as not compiled.

Manual check (no automated UI test; either platform). The worker cannot run it. Record under `**Result**` as awaiting a manual check by the account holder:
1. `yarn mobile:ios:sim:run` (or `yarn mobile:android:dev`).
2. Open settings and note the size and counts.
3. Save several items including an image, then reopen settings. Expected: counts have risen by exactly what was added and the size has grown after the image.
4. Cache one item for offline reading and reopen settings. Expected: the offline count is up by one.
5. Move the font slider to its largest setting. Look at the list, an open editor and the reader view of a text item. Expected: text scales on all three and nothing is clipped or overlapping.
6. Move it to its smallest. Expected: the same three screens stay legible.
7. Force-quit and relaunch. Expected: the setting survives.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Run one command per Bash call.
