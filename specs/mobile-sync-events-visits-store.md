---
enabled: true
touches: [apps/mobile/peek-core/src/schema.rs, apps/mobile/peek-core/src/items.rs, apps/mobile/peek-core/src/sync.rs, apps/mobile/peek-core/src/lib.rs, docs/sync-coverage-gaps.md]
depends-on: [sync-visits]
---

# Phone store side of event and visit sync

The phone app has `item_events` and `item_visits` tables (`apps/mobile/peek-core/src/schema.rs`),
but its sync (`peek-core/src/sync.rs`, driven by `apps/mobile/src-tauri/src/lib.rs
sync_all_internal()`) carries only items. This spec adds the store half of event and visit
sync in `peek-core`: which rows to push, marking them pushed, and merging pulled rows. Every
part of it can be unit-tested with plain `cargo test`. Calling these functions over HTTP from
`src-tauri/src/lib.rs` needs a build environment with the Tauri system libraries, so that call
is a separate spec and is out of scope here.

The wire format is the one the desktop already uses with the server. Read on `main`:

- events: `apps/desktop/main/sync.ts pushEventsToServer()` and `mergeServerEvent()`
- visits, added by `specs/sync-visits.md`: `pushVisitsToServer()` and `mergeServerVisit()`
- server validation: `apps/server/index.js` `POST /events` and `POST /visits`

On the wire, `itemId` is the server item id, which is the local item's `sync_id`. Field names are
camelCase.

## Schema (`schema.rs`)

Use the add-missing-column migration pattern already in `schema.rs`. Both `CREATE TABLE`
statements for `item_visits` and `item_events` (the fresh-install one and the migration one)
must end up with the same columns.

- `item_events`: add `pushedAt INTEGER NOT NULL DEFAULT 0`.
- `item_visits`: add these columns, keeping the table's snake_case:
  - `source_id TEXT DEFAULT ''`
  - `scroll_depth INTEGER DEFAULT 0`
  - `interacted INTEGER DEFAULT 0`
  - `prev_id TEXT DEFAULT NULL`
  - `next_id TEXT DEFAULT NULL`
  - `pushed_at INTEGER NOT NULL DEFAULT 0`

## Writers (`items.rs`)

- `record_visit()` and `track_navigation()` keep their behaviour.
- Any `UPDATE item_visits` this spec adds, or that already exists, also sets `pushed_at = 0`, so a
  changed visit is pushed again. This matches the desktop rule in `specs/sync-visits.md`.

## Store functions (`sync.rs`, exported through `lib.rs` `PeekStore`)

Shape each like `get_items_to_push()` and `mark_item_synced()`. Each struct is
`#[derive(Serialize, Deserialize)]` with `#[serde(rename_all = "camelCase")]`.

Event functions:

- `get_events_to_push(conn, limit) -> Vec<PushEvent>`
  - Selects events whose `pushedAt = 0` and whose item has a non-empty `sync_id`, oldest
    `createdAt` first.
  - `itemId` is set to that `sync_id`.
  - Rows with a non-finite `occurredAt` or `createdAt` are skipped.
- `mark_events_pushed(conn, ids)`
- `merge_server_event(conn, ServerEvent) -> MergeOutcome`
  - Resolves `itemId` to a local item through `sync_id`. Returns `Skipped` when the item is
    missing.
  - Does `INSERT OR IGNORE` by `id`, with `pushedAt` set to now.

Visit functions:

- `get_visits_to_push(conn, limit) -> Vec<PushVisit>`
  - Selects visits whose `pushed_at = 0` and whose item has a non-empty `sync_id`.
  - Maps each column to the desktop field name: `item_id` becomes `itemId` (holding the
    `sync_id`), `window_type` becomes `windowType`, `source_id` becomes `sourceId`,
    `scroll_depth` becomes `scrollDepth`, `prev_id` becomes `prevId` and `next_id` becomes
    `nextId`. `timestamp`, `duration`, `source`, `metadata` and `interacted` keep their names.
- `mark_visits_pushed(conn, ids)`
- `merge_server_visit(conn, ServerVisit) -> MergeOutcome`
  - Resolves the item the same way as for events.
  - Upserts by `id` with `pushed_at` set to now.
  - Never changes the item's visit count or last-visit time.

Watermarks:

- `get_last_events_pull` and `set_last_events_pull`
- `get_last_visits_pull` and `set_last_visits_pull`

Keep these the way `get_last_sync` and `set_last_sync` keep theirs.

## Tests (in `sync.rs` and `schema.rs` test modules)

- The migration adds the new columns to an old-shape database, and running it twice is safe.
- An event or visit is not pushable until its item has a `sync_id`, and is pushable after.
- A pushed visit whose duration changes becomes pushable again.
- The visit push body uses the camelCase desktop field names. Assert on the JSON produced by
  `serde_json::to_value`.
- A merged event or visit for an unknown item is skipped.
- A merged visit is not returned by `get_visits_to_push()`.
- Merging the same event twice leaves one row.

## Docs

`docs/sync-coverage-gaps.md`: record that the phone store can now produce and merge events and
visits, and that the phone does not yet send or fetch them because the HTTP calls in
`src-tauri/src/lib.rs sync_all_internal()` are a separate step.

## Verify

```
cargo test --manifest-path apps/mobile/peek-core/Cargo.toml
```

Done when the command exits 0 and the result line reads `0 failed`. Record the tally under
`**Result**` in the handoff.

## Working rules

- `apps/mobile/CLAUDE.md` governs. Read it before editing.
- Change only the files in `touches`.
- Do not build or touch `apps/mobile/src-tauri/`.
- Do not run `yarn test:sync:e2e:mobile`.
- Do not set `CARGO_TARGET_DIR`.
- Run one command per Bash call.
