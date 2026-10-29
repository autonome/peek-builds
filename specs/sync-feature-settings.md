---
enabled: true
touches: [packages/schema/v1.json, apps/server/schema.json, apps/server/db.js, apps/server/index.js, apps/server/test.js, apps/desktop/main/sync.ts, apps/desktop/main/sync.test.ts, apps/desktop/main/feature-settings-sync.ts, apps/desktop/main/feature-settings-sync.test.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/ipc.ts, apps/desktop/renderer/utils.js, docs/sync-coverage-gaps.md]
depends-on: [sync-visits]
---

# Feature preferences sync, allowlisted preferences only

Every user preference lives in the desktop `feature_settings` table
(`id, featureId, key, value, updatedAt`, unique on `(featureId, key)`), and none of it syncs.
Changing the theme, the ad blocker or a peeklet's options on one machine leaves every other
machine as it was. This spec syncs the table with last-write-wins on `updatedAt`, keyed by
`(featureId, key)`, for an explicit allowlist of portable preferences only.

Follow the shape `specs/sync-visits.md` added for visits (`pushVisitsToServer()`,
`pullVisitsFromServer()`, `POST /visits`, `GET /visits/since/:timestamp`). Read that code on
`main` first, and copy its 404 tolerance, chunking and watermark handling.

## Which rows sync

Only rows on an explicit allowlist sync; everything else stays on its machine. A new feature's
settings do not sync until someone adds them, because an exclusion list leaked credentials
(`wonderwall` OAuth tokens), absolute paths (`core` `backupDir`), window geometry (`peeks`/`slides`
`sizes`), OS-specific shortcuts (`cmd` `shortcutKey`) and per-machine caches (`cmd`
`command_cache`, `backup` `lastBackupTime`, `onboarding` `seeded`).

Put the allowlist in a new module `apps/desktop/main/feature-settings-sync.ts`. Export
`SYNCED_SETTINGS` (exact `featureId` + `key` pairs, with a sub-key allowlist where one stored
value is an object mixing portable and machine-specific fields) and `isSyncedSetting(featureId,
key)`. An entry qualifies only if it is a preference the user chose in the UI and means the same
on every machine and OS. Never: credentials or tokens, absolute paths, window sizes or positions,
display data, global shortcuts, caches, timestamps of local activity, install or onboarding
bookkeeping, device ids. Start with the theme choice, dark mode, the ad blocker's settings, and
the user-facing preference keys of `core`, `editor` and the built-in features, read from the
Settings UI and each feature's settings code. Record every entry with its file + symbol and
one line on why it is portable under Decisions, and every excluded preference that looked
tempting with why. When an object value mixes fields, sync only the allowed sub-keys and merge
them into the local object rather than replacing it.

Push sends only allowlisted rows. Pull ignores any incoming row not on the allowlist, so a buggy
or older client cannot write anything else.

## Writes that change nothing keep their timestamp

A write whose value equals the stored value leaves the row and its `updatedAt` untouched, in
every `feature_settings` write path: `tile-ipc.ts` `tile:settings:set`, `utils.js`
`createDatastoreStore.set()`, `ipc.ts` setters, and any other direct writer. Otherwise a machine
that only re-saved (on launch, on window resize) would overwrite real changes elsewhere.

## A machine pulls before it ever pushes

Until a machine has completed one full feature-settings pull, it pushes nothing and its local
rows lose every conflict. Record the completion in this machine's `sync` bookkeeping. A fresh or
reset machine therefore takes the user's existing settings rather than replacing them with its
defaults or startup writes.

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

A hard `DELETE` of a synced row does not propagate. Today every hard delete is on a non-synced
feature (`permission-store.ts`, `session.ts`, `migrate-hud.ts`). Record this in the doc as an
accepted gap, and do not add tombstones.

## Docs

In `docs/sync-coverage-gaps.md`:

- Add a section saying allowlisted `feature_settings` rows now sync, with the allowlist, the
  criteria for adding an entry, the pull-before-push rule, the no-delete gap and the
  no-live-refresh limit.
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

- `feature-settings-sync.test.ts`: `isSyncedSetting()` is true for each allowlisted pair, and
  false for an unknown tile id, `wonderwall`, `core` `backupDir`, `peeks` `sizes`, `cmd`
  `shortcutKey`, `cmd` `command_cache`, `backup` `lastBackupTime` and `onboarding` `seeded`.
- Saving an unchanged value through each write path leaves `updatedAt` as it was.
- Fresh machine: initialize a new profile and run its startup writers, then sync against a
  server holding older real values for allowlisted keys. The real values survive on the server
  and arrive locally; nothing is pushed before the first pull completes.
- A mixed object value syncs only its allowed sub-keys and keeps the local machine-specific ones.
- `apps/server/test.js`:
  - A post saves rows.
  - An older `updatedAt` does not overwrite a newer one.
  - `since` returns only rows received after the watermark.
  - A malformed row returns 400.
- `sync.test.ts`, with the same fake server as the visit tests:
  - An allowlisted row is pushed; a `system` row and a non-allowlisted `core` key are not.
  - A pulled newer row replaces the local value and keeps the incoming `updatedAt`.
  - A pulled older row is ignored.
  - A pulled `session` row and a pulled `wonderwall` row are ignored.
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
