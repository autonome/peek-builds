---
enabled: true
touches: [packages/schema/v1.json, apps/server/schema.json, apps/server/db.js, apps/server/index.js, apps/server/test.js, apps/desktop/main/sync.ts, apps/desktop/main/sync.test.ts, apps/desktop/main/datastore.ts, apps/desktop/main/migrate-visit-pushed-at.test.ts, docs/sync-coverage-gaps.md]
depends-on: []
---

# Visit history syncs to the server and back

Every row of the desktop `item_visits` table stays on the machine that wrote it. Sync carries
only the per-page totals on `items` (`visitCount`, `lastVisitAt`). So the server, and every
other device, has no record of when each visit happened, how long the page was in front of the
user (`duration`), where it came from (`source`, `sourceId`), or which visit led to which
(`prevId`, `nextId`). Everything a user does is meant to sync; this spec adds visits.

Copy the pattern `item_events` already uses, end to end: `apps/desktop/main/sync.ts`
`pushEventsToServer()`, `markEventsPushed()`, `pullEventsFromServer()`, `mergeServerEvent()`;
`apps/server/index.js` `POST /events` and `GET /events/since/:timestamp`; `apps/server/db.js`
`saveEvents()` and `getEventsSince()`; `apps/desktop/main/datastore.ts`
`migrateEventPushedAtColumn()` and its test `main/migrate-event-pushed-at.test.ts`.

## The one difference from events: a visit changes after it is written

An event never changes. A visit does, in two places in `datastore.ts`:

- `setItemVisitDuration()` writes `duration` once, when the visit ends.
- Two other `UPDATE item_visits` statements set `prevId`/`nextId`, linking the previous visit
  to the new one. `grep -n "UPDATE item_visits" apps/desktop/main/datastore.ts` lists all
  three.

So a visit can be pushed, then change, and must be pushed again. Decisions:

- **Desktop:** add a local-only column `item_visits.pushedAt INTEGER NOT NULL DEFAULT 0`, by a
  new `migrateVisitPushedAtColumn()` shaped exactly like `migrateEventPushedAtColumn()` and run
  from the same place. Every `UPDATE item_visits` statement in `datastore.ts` also sets
  `pushedAt = 0`, so a changed visit becomes eligible again. A visit is eligible when
  `pushedAt = 0` and its item has a non-empty `syncId`.
- **Server:** the server's `item_visits` table has a server-stamped `updatedAt`. Saving a visit
  is an upsert on `id` (`INSERT ... ON CONFLICT(id) DO UPDATE`), setting every column from the
  pushed row and `updatedAt` to now. Re-sending an unchanged visit is harmless.
- **Pull** pages by the server's `updatedAt`, not `createdAt`, so a changed visit reaches other
  devices.

## Server

- `packages/schema/v1.json`: add an `item_visits` table with the columns `id`, `itemId`,
  `timestamp`, `duration`, `source`, `sourceId`, `windowType`, `metadata`, `scrollDepth`,
  `interacted`, `prevId`, `nextId` (same types and defaults as the desktop table in
  `datastore.ts`), plus `createdAt` and `updatedAt`. `pushedAt` is desktop-only: declare it
  `sync: false`, the way `item_events.pushedAt` is declared. Regenerate
  `apps/server/schema.json` with `node packages/schema/codegen.js`; do not hand-edit it.
- `apps/server/db.js`: create the table and indexes on `itemId`, `timestamp` and `updatedAt` in
  `initializeSchema()` next to `item_events`. Add `saveVisits(userId, profileId, visits)` (the
  upsert above, in one transaction, returning `{ saved, total }`) and
  `getVisitsSince(userId, profileId, unixMs, options)` (rows with `updatedAt > unixMs`, ordered
  by `updatedAt`, paged the same way as `getEventsSince()`). Export both.
- `apps/server/index.js`: `POST /visits` with body `{ visits: [...] }`, validated like
  `POST /events` (required `id`, `itemId`; finite `timestamp`; a cap on rows per push equal to
  `MAX_EVENTS_PER_PUSH`), and `GET /visits/since/:timestamp` returning
  `{ visits, since, nextCursor }` with `nextCursorFor(visits, page.options, "updatedAt")`. Both
  sit beside the event routes and use the same auth and profile resolution.
- **Do not bump `DATASTORE_VERSION`.** A new table needs no reset of existing sync state; every
  existing visit already starts at `pushedAt = 0` after the migration, so the first sync sends
  the whole history in chunks.

## Desktop

- `sync.ts`: add `pushVisitsToServer()`, `markVisitsPushed()`, `pullVisitsFromServer()` and
  `mergeServerVisit()`, each a copy of its event counterpart with these differences:
  - On the wire `itemId` is the server item id, taken from the local item's `syncId`, exactly as
    for events. `prevId` and `nextId` are visit ids and travel unchanged.
  - Drop a malformed row before sending (missing `id` or item `syncId`, non-finite `timestamp`)
    and log it through `groupFailuresByReason()` and `logSyncProgress()`, as events do.
  - Chunk the push and stamp `pushedAt` per delivered chunk.
  - A `404` from `POST /visits` or `GET /visits/since` means the server predates this spec: log
    one line and skip the stage, returning zero counts; never fail `syncAll()` for it.
  - `mergeServerVisit()` resolves the server `itemId` to a local item through `items.syncId`; a
    visit whose item is not present locally is skipped and counted. It upserts by `id`, writing
    `pushedAt = Date.now()` so a pulled visit is not pushed straight back. It never changes
    `items.visitCount` or `lastVisitAt`: those totals already sync on the item.
  - Track the visit pull watermark the same way the event pull watermark is tracked.
- `syncAll()`: run visits pull then visits push after the events stages, and add their counts to
  `SyncResult` next to the event counts.
- `resetPerItemSyncState()`: zero `item_visits.pushedAt` alongside `item_events.pushedAt`.

## Docs

`docs/sync-coverage-gaps.md`: record that `item_visits` now syncs (desktop and server), that the
phone's `item_visits` table still does not, and list the desktop tables that still do not sync:
`settings`, `feature_settings`, `themes`, `scripts_data`, `feeds`, `item_groups`,
`item_group_members`, `blobs`, `features_history`, `content`, `rules`. Name the machine-local
ones that are not meant to sync: `manifest_cache`, `lazy_wake_shortcuts`, `lazy_wake_declared`,
`tile_schedule_runs`, `migrations`.

## Tests

- `apps/server/test.js`: `POST /visits` saves rows; re-posting a changed row (new `duration`)
  updates it and advances `updatedAt`; `GET /visits/since/:ts` returns the changed row and pages
  with `nextCursor`; a malformed row is rejected with 400; more than the cap is rejected.
- `apps/desktop/main/migrate-visit-pushed-at.test.ts`: the migration adds the column once, is
  idempotent, and leaves existing rows at `pushedAt = 0`.
- `apps/desktop/main/sync.test.ts`, beside the event push/pull tests and using the same fake
  server: a visit is pushed once its item has a `syncId` and not before; `setItemVisitDuration()`
  after a push makes it eligible again and the second push carries the new duration; linking a
  next visit does the same; a pulled visit lands with `pushedAt` set and is not re-pushed; a
  pulled visit for an unknown item is skipped; pulling never changes `items.visitCount`; a 404
  from either visits route leaves `syncAll()` succeeding.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn server:test
yarn test:sync
```

Done when every command exits 0 with `fail 0` in each tally. Record each tally under
`**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` and `apps/server/CLAUDE.md` govern; read both before editing. Change
only the files in `touches`. Never add `yarn.lock` under `apps/server/`. Do not deploy the
server. Run one command per Bash call.
