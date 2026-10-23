---
enabled: true
touches: [packages/schema/v1.json, apps/server/schema.json, apps/server/db.js, apps/server/index.js, apps/server/test.js, apps/desktop/main/sync.ts, apps/desktop/main/sync.test.ts, apps/desktop/main/feature-settings-sync.ts, apps/desktop/main/feature-settings-sync.test.ts, docs/sync-coverage-gaps.md]
depends-on: [sync-visits]
---

# Feature preferences sync, machine-specific rows excluded

Every user preference lives in the desktop `feature_settings` table
(`id, featureId, key, value, updatedAt`, unique on `(featureId, key)`), and none of it syncs.
Changing the theme, the ad blocker or a peeklet's options on one machine leaves every other
machine as it was. This spec syncs the table with last-write-wins on `updatedAt`, keyed by
`(featureId, key)`, and leaves machine-specific rows out.

Follow the shape `specs/sync-visits.md` added for visits (`pushVisitsToServer()`,
`pullVisitsFromServer()`, `POST /visits`, `GET /visits/since/:timestamp`). Read that code on
`main` first, and copy its 404 tolerance, chunking and watermark handling.

## Which rows sync

All rows sync except those whose `featureId` is on a fixed list of machine-local features. A new
peeklet's settings therefore sync with no extra work. Put the list in a new module
`apps/desktop/main/feature-settings-sync.ts`. Export `MACHINE_LOCAL_FEATURES` (a `Set`) and
`isSyncedSetting(featureId, key)`. The list:

- `system` — `deviceId` is this machine's identity (`device.ts getDeviceId()`).
- `sync` — server URL, watermarks and last-sync bookkeeping (`sync.ts`).
- `session` and `closed-window-stack` — window bounds and window ids (`session.ts`, `main.ts`).
- `page-permissions` — per-origin grants (`permission-store.ts`).
- The featureId used by `atproto-session-store.ts` (credentials) and the one used by
  `debug-flag-store.ts`. Read both files for the exact strings, and name each in a comment next to
  its entry.

`isSyncedSetting()` returns false for those features and true for everything else. Push skips
non-synced rows. Pull ignores any incoming row for a machine-local feature, so a buggy client
cannot overwrite them.

## Server

- `packages/schema/v1.json`: add `feature_settings` with `featureId`, `key`, `value` and
  `updatedAt`. Regenerate `apps/server/schema.json` with `node packages/schema/codegen.js`.
- `apps/server/db.js`:
  - In `initializeSchema()`, create `feature_settings (featureId TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT, updatedAt INTEGER NOT NULL, receivedAt INTEGER NOT NULL, PRIMARY KEY (featureId,
    key))`, with an index on `receivedAt`.
  - Add `saveFeatureSettings(userId, profileId, rows)`. It upserts each row only when the incoming
    `updatedAt` is newer than the stored one, sets `receivedAt` to now on every row it writes, and
    returns `{ saved, total }`.
  - Add `getFeatureSettingsSince(userId, profileId, unixMs, options)`, paging by `receivedAt`.
  - Export both.
- `apps/server/index.js`:
  - Add `POST /feature-settings` with body `{ settings: [...] }`. Require `featureId`, `key` and a
    finite `updatedAt`. Cap rows per push at `MAX_EVENTS_PER_PUSH`.
  - Add `GET /feature-settings/since/:timestamp`, returning `{ settings, since, nextCursor }`.

## Desktop

- `sync.ts`:
  - Add `pushFeatureSettingsToServer()`, which sends synced rows whose `updatedAt` is newer than
    the stored watermark `lastFeatureSettingsPushAt`. Store the watermark in `feature_settings`
    under featureId `sync`, the way `lastTagPushAt` is stored.
  - Add `pullFeatureSettingsFromServer()` and `mergeServerFeatureSetting()`.
  - The merge writes a row only when the incoming `updatedAt` is newer than the local one, and
    keeps the incoming `updatedAt` rather than stamping `Date.now()`, so the row is not pushed
    straight back as a new change.
  - The local row id stays `${featureId}_${key}`, the form `tile-ipc.ts` `tile:settings:set` uses.
  - Run both in `syncAll()` after the visits stages, and add their counts to `SyncResult`.
- A 404 from an older server is logged once and the stage is skipped, as for visits.
- A pulled value takes effect the next time the owning feature reads its settings. Live tiles are
  not notified. This limit is recorded in the doc.

## Deletes

A hard `DELETE` of a synced row does not propagate. Today every hard delete is on a machine-local
feature (`permission-store.ts`, `session.ts`, `migrate-hud.ts`). Record this in the doc as an
accepted gap, and do not add tombstones.

## Docs

In `docs/sync-coverage-gaps.md`:

- Add a section saying `feature_settings` now syncs, with the machine-local list, the no-delete
  gap and the no-live-refresh limit.
- In the same section, record the desktop tables deliberately left unsynced, each with its
  reason:
  - `settings`: one-shot migration flags that mean something different on each machine.
  - `features_history`: a local install log keyed by autoincrement id.
  - `themes`: holds a local install path. The theme files themselves would have to move. The
    choice of active theme already syncs as a feature setting.
  - `feeds`, `scripts_data`, `item_groups`, `item_group_members` and the desktop `blobs` table:
    no code writes them outside the generic `setRow()`, so there is nothing to sync until
    something does.
  - `content`: the legacy notes table, replaced by `text` items.

## Tests

- `feature-settings-sync.test.ts`: `isSyncedSetting()` is false for each machine-local feature
  and true for `core` and an arbitrary tile id.
- `apps/server/test.js`:
  - A post saves rows.
  - An older `updatedAt` does not overwrite a newer one.
  - `since` returns only rows received after the watermark.
  - A malformed row returns 400.
- `sync.test.ts`, with the same fake server as the visit tests:
  - A `core` row is pushed and a `system` row is not.
  - A pulled newer row replaces the local value and keeps the incoming `updatedAt`.
  - A pulled older row is ignored.
  - A pulled `session` row is ignored.
  - A 404 leaves `syncAll()` succeeding.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn server:test
yarn test:sync
```

The spec is done when every command exits 0 and each test tally reads `fail 0`. Record each tally
under `**Result**` in the handoff.

## Working rules

- `apps/desktop/CLAUDE.md` and `apps/server/CLAUDE.md` govern. Read both before editing.
- Change only the files in `touches`.
- Never add `yarn.lock` under `apps/server/`.
- Do not deploy the server.
- Run one command per Bash call.
