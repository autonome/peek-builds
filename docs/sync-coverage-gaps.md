# Sync coverage gaps — what a server restore would not bring back

Research note. Surveys which parts of the datastore reach the sync server and which
are local-only, on the question: if a laptop is lost, what does restoring from the
server produce?

Nothing here is scheduled work. Each gap names what settles it.

Sources: `packages/schema/v1.json` (the canonical schema, `sync` flag per column),
`apps/desktop/main/sync.ts` (`pushSingleItem()`, `mergeServerItem()`,
`pullFromServer()`, `pushToServer()`, `syncTagsToItem()`, `pushTagsToServer()`,
`pullTagsFromServer()`, `mergeServerTag()`, `pushEventsToServer()`,
`pullEventsFromServer()`, `mergeServerEvent()`), `apps/desktop/main/rules.ts` and
`rule-engine.ts`, and `apps/server/db.js` (`initializeSchema()`, `saveItem()`,
`saveTags()`, `getTagsSince()`).

## Short answer

A restore returns items with all their fields — title, domain, favicon, visit
history, frecency, starred/archived state, deletion tombstones — their tags, tag
frecency, tag metadata, and now item events (the observations behind series and
feed items). It does not return user-created rules, because none exist yet: there
is no rule editor and no code path that creates a `source: 'user'` rule.

The remaining gaps are narrower than they once were: tag rename and tag deletion
don't propagate, event deletion doesn't propagate, and a push with no `tags` field
is a latent (not live) hazard. See below for each.

## 1. Item fields — all now sync

`title`, `domain`, `favicon`, `visitCount`, `lastVisitAt`, and `frecencyScore` are
`"sync": true` on `items` in `packages/schema/v1.json`, carried by `sync.ts
pushSingleItem()` / `mergeServerItem()`, and stored by `apps/server/db.js
saveItem()`. So are `mimeType`, `starred`, `archived`, and `deletedAt`.

`createdAt` is client-authoritative: `pushSingleItem()` sends the item's original
local `createdAt`, and `apps/server/db.js saveItem()` honors it only on INSERT, so
an item's original creation date survives a restore. `updatedAt` stays
server-stamped on every write instead — `mergeServerItem()`'s conflict resolution
(last-write-wins) compares on it, so it can't also carry client-supplied values
without breaking that comparison.

## 2. `item_events` now syncs, stamped per event

`packages/schema/v1.json` marks every `item_events` column `"sync": true` and lists
the table in `validation.required_sync_columns`. `sync.ts pushEventsToServer()` /
`pullEventsFromServer()` / `mergeServerEvent()` carry it, and `apps/server/db.js`
stores it. `series` and `feed` items — whose entire payload lives in `item_events`
rows rather than in the item itself — restore with their observations intact.

Push records delivery per event, in `item_events.pushedAt` (0 = never delivered),
rather than against any time watermark. The reason a watermark cannot serve here:
an event's `itemId` on the wire is the *server's* item id, resolved from the local
item's `syncId` — so an event whose parent item has no `syncId` yet (not pushed, or
still mid-push) has to be skipped for this run. Any watermark still advances at the
end of that run (items tolerate this, since they track their own per-row
`syncedAt`), which would push it past the skipped events' `createdAt` and strand
them permanently.

A dedicated event watermark, held below the oldest skipped event, was the previous
answer and had its own failure: an item the server permanently rejects — or one of a
type that never syncs at all — never earns a `syncId`, so it pinned that watermark
indefinitely and every run re-pushed the whole event tail behind it (24,000 events
per run, measured against production). With a per-row stamp, an event whose parent
cannot sync strands exactly itself and is picked up whenever that parent does sync.

`pushedAt` is declared `"sync": false` in `packages/schema/v1.json` — local
bookkeeping, never sent on the wire, no column on the server — so it needs no
datastore version bump. `datastore.ts migrateEventPushedAtColumn()` adds the column
and stamps everything at or below the retired watermark as already delivered; only
the tail behind it re-pushes, once, and the server ignores ids it already holds.

Deletion does not propagate: a locally hard-deleted event reappears on the next
pull if the server still has it. There is no `deletedAt` (or any tombstone) column
for `item_events` in any backend's schema.

**Settled by:** a tombstone column for `item_events`, plus push/pull handling for
it — unscheduled work, and the one piece of §2 still open.

## 2a. `item_visits` now syncs (desktop and server); the phone's does not

The desktop `item_visits` table (one row per page visit: `timestamp`, `duration`,
`source`, `sourceId`, `windowType`, `metadata`, `scrollDepth`, `interacted`, and the
`prevId`/`nextId` links) reaches the server and comes back. `sync.ts
pushVisitsToServer()` / `pullVisitsFromServer()` / `mergeServerVisit()` carry it
through `POST /visits` and `GET /visits/since/:timestamp`; `apps/server/db.js
saveVisits()` / `getVisitsSince()` store it. Before this, only the per-page totals on
`items` (`visitCount`, `lastVisitAt`) synced.

Unlike an event, a visit changes after it is written: `setItemVisitDuration()` fills
`duration` when the visit ends, and recording the next visit sets `nextId` on the
previous one. So `item_visits.pushedAt` (local only, `"sync": false`, added by
`datastore.ts migrateVisitPushedAtColumn()`) means "the server holds this exact row",
and every `UPDATE item_visits` sets it back to 0. The server upserts on the visit id
and stamps its own `updatedAt`; pull pages by `updatedAt`, not `createdAt`, so a
changed visit reaches the other devices. A pulled visit is written with `pushedAt`
set and never changes `items.visitCount` or `lastVisitAt`.

Still open:

- **The phone's `item_visits` table does not sync.** The mobile client has no visit
  push or pull.
- **Visit deletion does not propagate**, for the same reason as events: no tombstone.

## Desktop tables that still do not sync

`settings`, `feature_settings`, `themes`, `scripts_data`, `feeds`, `item_groups`,
`item_group_members`, `blobs`, `features_history`, `content`, `rules`.

Machine-local by design, never meant to sync: `manifest_cache`, `lazy_wake_shortcuts`,
`lazy_wake_declared`, `tile_schedule_runs`, `migrations`.

## 3. Tag metadata now syncs; tag identity and deletion are the remaining gaps

`slug`, `color`, `parentId`, `description`, and `metadata` on `tags` are `"sync":
true` as of DATASTORE_VERSION 3. `sync.ts pushTagsToServer()` /
`pullTagsFromServer()` / `mergeServerTag()` carry them, keyed by the tag's `name` —
the same identity `apps/server/db.js getOrCreateTagWithConn()` already used for tag
rows an item push derives. `parentId` travels on the wire under that same field
name but holds the parent's name, not any id — the server column of the same name
stores that name too, not a row id — resolved back to a local tag id on pull in a
second pass so a parent arriving after its child in the same pull still links
correctly; an incoming cycle of `parentId` (name) links is broken deterministically
(newest `updatedAt` loses its parent link, ties going to the lower `id`) so every
device that pulls the same cycle breaks the same link.

Two gaps remain, accepted rather than fixed:

- **Renaming a tag on one device creates a second tag rather than renaming the
  first.** Identity on the wire is the name; a syncId would give the same row two
  sources of truth to reconcile, and the push/pull code was built to avoid that
  rather than build rename support.
- **Tag deletion does not propagate.** There is no tombstone column on `tags` — a
  tag deleted on one device still exists, and can still be pulled back, on every
  other device.

**Settled by:** a real tag identity beyond name (needed for rename to sync) and a
`deletedAt` column plus tombstone push/pull (needed for delete to propagate) — both
separate, unscheduled work.

## 4. Rules are entirely local — deferred, not rejected

The `rules` table is `"sync": false` in every column. A survey of the code finds
zero rows with `source: 'user'`, and no path that produces one: there is a
`tile:rules:register` IPC handler (`api.rules.register`), but it always writes
`source: 'runtime'`, never `'user'`, and there is no rule editor UI. The only rules
that exist are `source: 'manifest'` (4 of them, across `entities` and
`tag-actions`), reconciled from feature manifests by `rules.ts
syncManifestRules()` on every load — so manifest rules regenerate themselves and
should not sync.

Rule sync isn't rejected, just blocked on a rule editor that doesn't exist yet.
Whoever builds one has to satisfy two constraints first for sync to be possible:

- **User-rule ids must be globally unique across devices.** The id is the only
  viable sync identity for a user rule. Manifest rules can't use plain ids for
  this because `rules.ts computeManifestRuleId()` derives theirs from a content
  hash of the rule's fields — a user rule minted the same way would collide by
  design the moment two devices declare similar-looking rules.
- **Rule deletion needs a tombstone.** `rules.ts deleteRule()` is a hard `DELETE
  FROM rules WHERE id = ?`, and there is no `deletedAt` (or equivalent) column on
  `rules` in any backend's schema. Syncing rules as-is would resurrect a deleted
  rule on every other device that still has it.

Separately, and true regardless of whether rules ever sync: `rule-engine.ts
fireRule()` resolves a rule's `scriptId` by publishing to
`scripts:execute:<scriptId>` — a plain pubsub topic. If no script on that device
subscribes to that topic (because the script doesn't exist there), the publish has
no listener, the rule silently never fires, and nothing logs it. A synced rule
naming a script the receiving device lacks would hit exactly this.

**Settled by:** building a rule editor (giving `source: 'user'` a real origin),
then deciding whether user-authored rules sync — filtered to `source = 'user'`,
once the id-uniqueness and tombstone constraints above are met.

## 5. The two copies of the canonical schema are no longer divergent

`apps/server/schema.json` is generated from `packages/schema/v1.json` by
`packages/schema/codegen.js generateServerSchema()`, and the generated file is
checked in. Generation is necessary because deploys upload `apps/server/` alone
(see `docs/server-backup-and-deploy.md`), so server code can never
`import` from `packages/schema` at runtime — it needs its own copy of whatever it
reads.

The generated file is a narrow projection, not a mirror: `SERVER_TABLES` in
`codegen.js` lists only the tables the server physically creates (`items`, `tags`,
`item_tags`, `item_events` — `rules` is desktop-only and deliberately dropped),
and for each it carries only `validation.required_sync_columns`, because that's
the only part `apps/server/db.js validateSchema()` reads at boot. Freshness is
covered by `packages/schema/check-freshness.js`, which regenerates and diffs
against the checked-in copy.

## 6. The server's `items` table columns — resolved

`apps/server/db.js initializeSchema()` creates `items` with `title`, `domain`,
`favicon`, `frecencyScore`, `visitCount`, `lastVisitAt`, and `mimeType` alongside
the original columns. This was downstream of §1: once those fields started
syncing, the server needed columns to receive them. See
`docs/mcp-remote-backend-design.md` §3.1.

## 7. A push with no `tags` field wipes the item's existing tag links

Every other item column `apps/server/db.js saveItem()` writes goes through
`COALESCE(?, existingColumn)`, so a client that omits a field on a re-push (e.g.
an older client that doesn't carry `title`/`domain`/`starred`/etc.) leaves the
stored value untouched. `tags` is the one exception: `saveItem()` unconditionally
runs `DELETE FROM item_tags WHERE itemId = ?` and rebuilds the links from the
pushed `tags` array, and `POST /items` defaults an absent `tags` field to `[]`. A
push with no `tags` field at all therefore clears the item's tags, where the same
omission on any other field is a no-op.

This is latent, not live: every current client (desktop, mobile, extension) always
sends a full `tags` array on every item push. Pinned by
`apps/server/test.js` "a push with no tags field wipes the item's existing tags
(latent hazard, not desirable)".

**Settled by:** giving `tags` the same COALESCE-style omitted-means-unchanged
treatment as every other column — unscheduled work, since no current client hits it.

## 8. What the sync test suites can and cannot catch

A green suite only means something if it is known what that suite is able to fail
on. Six suites carry sync coverage; this is what each one exercises for real and
what is invisible to it by construction. The occasion for writing it down:
`sync-e2e.test.js` was 2 passed / 11 failed for two months (2026-06-24 to
2026-08-18) while every other suite stayed green, because the only suite able to
see that class of fault was the broken one.

All six pass as of 2026-09-01: 41, 17, 9, 8, 17 and 7 cases respectively.

A worktree needs `yarn workspace @peek/desktop build` before the two suites that
import `apps/desktop/dist/main/` can run at all — without it they die on
`ERR_MODULE_NOT_FOUND` rather than reporting a failure against the code.

### `apps/desktop/main/sync.test.ts` — 41 cases

Runs as runner 1 of the 6-runner desktop gate (`yarn test:desktop:electron`), and
standalone via `yarn test:unit`. Exercises the real `sync.ts` push and pull
functions against the real server app and a real `node:sqlite` datastore, and is
the only suite covering all six stages deliberately rather than incidentally
(`describe('IPC entry points — tile:sync:push / tile:sync:pull must run all three
stages')`). It also owns the paged-pull cases (`describe('Paged pulls — the
client follows the server cursor')`), which answer the item pull from a stub
rather than the real app: what is under test there is the client's loop — how
many requests it makes and when it stops.

Blind by construction to any disagreement between two separately-configured HTTP
clients: `setup()` stubs `globalThis.fetch` and routes it into the server's Hono
`app.request()` in-process, so there is no socket, no header serialization round
trip, and no second fetch implementation. That is exactly the shape of the
`sync-e2e.test.js` fault, which is why this suite could not see it.

Also blind to drift in the real IPC handlers: `replayTileSyncPush()` and
`replayTileSyncPull()` re-implement the body of `tile-ipc.ts`'s handlers, because
`tile-ipc.ts` cannot be imported under `ELECTRON_RUN_AS_NODE`. If the registered
handler's stage order changes, the replay still passes.

Covers all three recent changes: `pushedAt` per-event stamping, the parked-item
columns, and the batched push including its 404 fallback.

### `packages/integration-tests/sync-e2e.test.js` — 17 cases

`yarn test:sync:e2e`. The only suite where a real desktop client and a real server
process talk over a real socket: it spawns `apps/server/index.js` on port 3458 and
drives the compiled `sync.ts` against it. This is the suite that can see a
client/server disagreement, and the reason step 1 of restoring the foundation was
repairing it rather than deleting it.

One limit remains:

- Authentication is bypassed. The server is spawned with `E2E_TEST=true`, which
  short-circuits `deviceMiddleware` and `multiUserMiddleware` in
  `apps/server/auth.js`, so a credential-handling mismatch on the wire is invisible
  *here*. `sync-auth-e2e.test.js` below is the suite that covers it.

Tag and event stages are no longer incidental. `testTagStagesOverSocket()` and
`testEventStagesOverSocket()` call the real `pushTagsToServer()` /
`pullTagsFromServer()` / `pushEventsToServer()` / `pullEventsFromServer()` and
confirm what crossed the wire by requesting `/tags/since` and `/events/since`
directly, in both directions. `testTagsetSync()` still covers only the `tags` array
on `/items`, which is a different thing from the tag-metadata routes.
Two cases used to print a pass on every path and never inject a failure. They
were replaced with assertions of the behaviour that actually holds now:
`testDeletionTombstonePropagates()` proves a soft delete reaches the server as a
`deletedAt` tombstone and drops out of the default listing, and
`testRejectedItemIsParked()` proves a permanently rejected row records
`syncError`/`syncErrorAt`, is not re-attempted while unchanged, and pushes once
edited. That makes the parked-item mechanism the one recent change proven over a
real socket rather than only in-process.

`pushedAt` and the `/items/batch` 404 fallback are now proven here too.
`testEventPushedAtStamping()` asserts a delivered event's `pushedAt` moves off zero
while an event whose parent item has no `syncId` stays at zero — the stranding
invariant §2 describes. The 404 fallback cannot be reached against the spawned
server, which always has the route, so `testBatchFallbackWhenRouteMissing()` puts a
`node:http` proxy in front that answers `POST /items/batch` with a 404 and forwards
everything else. The proxy counts what it sees, and the test asserts on those counts
rather than on the items alone: asserting only that the items arrive would pass just
as well if the batch route had never been attempted.

### `packages/integration-tests/sync-integration.test.js` — 9 cases

`yarn test:sync`. Real HTTP to a real spawned server on port 3457, with requests
built by hand in `serverRequest()`. No desktop code is loaded at all, so this is a
server-route suite: it validates `POST /items` and `GET /items/since/:timestamp`
and nothing else. No `/tags` or `/events` route is requested. Nothing about how
the real client builds a request or reads a response is under test.

### `packages/integration-tests/sync-three-way.test.js` — 8 cases

`yarn test:sync:three-way`. Real HTTP to a real spawned server on port 3459. Both
"mobile" and "desktop" are the same hand-rolled `clientRequest()` helper with
different `profile` query params — neither the desktop `sync.ts` nor the Rust
mobile client is involved. What it actually proves is server-side profile
resolution and isolation, including that an unregistered UUID gets its own profile
rather than falling into `default`. Only `/items` is touched; no tag or event
stages, no batching, no sync-state bookkeeping.

### `packages/integration-tests/sync-version-compat.test.js` — 17 cases

`yarn test:version-compat`. Two mechanisms in one file:

- Header negotiation (`test1_bothV1` through `test8_bothNoHeaders`,
  `testHealthCheck`, `testIncrementalSyncVersionCheck`) — real HTTP to a real
  server on port 3460, but the client side is `versionedRequest()` setting
  `X-Peek-Datastore-Version` and friends by hand, not `serverFetch()`. It proves
  the server's reading of those headers, not the desktop's writing of them.
- Version-bump behaviour (`test9_initWritesVersion` through
  `test13_legacyEncodedVersionFallback`, `testServerDBVersion`) — these now drive the
  real implementations. `checkAndWriteDatastoreVersion()` is module-private in
  `datastore.ts` and returns void, so it is exercised through its real entry point,
  `initDatabase()`, with the outcome read from the `feature_settings` row and from
  `isSyncDisabledDueToVersion()`; `tamperStoredVersion()` writes the stored version
  straight into sqlite between inits to stand in for a database left by another
  binary. `testServerDBVersion()` drives the real `db.js initializeSchema()` instead
  of hand-building a `settings` table. `test13_legacyEncodedVersionFallback` covers
  the bare-numeral encoding that `JSON.parse` rejects and the implementation's
  `parseInt` fallback recovers — a branch the previous copy did not distinguish.

Only `/items` is requested; no tag or event stages.

### `packages/integration-tests/sync-auth-e2e.test.js` — 7 cases

`yarn test:sync:auth`. Spawns the real server on port 3461 in multi-user mode with
no `E2E_TEST`, so `multiUserMiddleware` and `users.resolveDevice()` actually run.
Credentials are minted at runtime through `POST /admin/devices` behind `ADMIN_TOKEN`.
It covers the 401 paths (absent header, well-formed but unminted token), a minted
key succeeding, a revoked device's key failing afterwards — the individual-revocation
guarantee — the public health check, and that device keys and `ADMIN_TOKEN` cannot
authenticate each other's routes.

The case that closes the gap is `testRealDesktopClientAuthenticates()`: it configures
the compiled `sync.js` with a genuinely minted key, pushes, and confirms the item
lands, then reconfigures with an unminted key and asserts the push fails rather than
silently reporting success. That puts the client's own header construction under
test, not just the server's reading of a hand-built header.

### Nothing runs any of this automatically

There is no CI, no `.github/` workflows, no husky config, and no installed git
hook (`core.hooksPath` unset, `.git/hooks` holds only the stock samples). Suites 2
through 5 are standalone `yarn` scripts that no aggregate script calls. Suite 1
rides the desktop gate, which itself requires explicit human approval per
`apps/desktop/CLAUDE.md` before each run. That is why a June breakage surfaced in
August.

Decision: the five non-gate suites are grouped under `yarn test:sync:all` and run
before landing any sync change, rather than being wired into a pre-commit hook.
Each spawns a server process and together they take a few minutes, which is too
slow to run on every commit; the desktop gate stays the only place suite 1 runs.

They share fixed ports — 3457, 3458, 3459, 3460, 3461 — and each suite creates a
fixed-name profile on its own server. So two runs of the same suite at once collide:
`waitForServer()` polls the port and treats any 200 as its own server, and the second
run then fails on an already-existing profile. Run the chain serially.

### The gaps this leaves

The four gaps this section previously named are closed, each by the suite noted above:
tag and event stages now run over a real socket, real authentication is exercised end
to end by `sync-auth-e2e.test.js`, `pushedAt` and the `POST /items/batch` 404 fallback
are proven over the wire, and the version-bump logic drives the real implementation
rather than a copy.

What remains:

- Nothing runs any of it automatically. The aggregate `yarn test:sync:all` is still
  something a person has to remember, which is the condition that let a June breakage
  surface in August.
- Two suites depend on `apps/desktop/dist/` existing. A worktree that has not run
  `yarn workspace @peek/desktop build` gets a module-resolution crash from them, which
  is a louder failure than a silent pass but still not a result about the code.
- The header-negotiation half of `sync-version-compat.test.js` still builds its
  requests by hand in `versionedRequest()`, so it proves the server's reading of the
  version headers, not the desktop's writing of them.
- The mobile client is not covered by any of this. `sync_e2e_mobile` is a separate
  cargo suite, and nothing exercises the Rust client against a spawned server in the
  same way `sync-e2e.test.js` covers the desktop one.

## Verifying any of this

```
grep -n '"sync": false' packages/schema/v1.json
grep -rn "source: 'user'" apps/desktop/main --include='*.ts' --exclude='*.test.ts'   # returns nothing
yarn schema:check
```

The first is the local-only inventory — now just `rules` and the two accepted tag
gaps. The second is the §4 finding: no code path produces a user-authored rule.
The third regenerates `apps/server/schema.json` from `packages/schema/v1.json` and
diffs against the checked-in copy — a clean exit is §5 holding.

## Not covered by this note

- Whether the server's backup path (`apps/server/backup.js`) changes any of the
  above. It backs up what the server holds; it cannot restore what never arrived.
- Blob and image storage coverage.
- Whether any of these gaps have already caused loss in practice — no audit of the
  live server's data was run.
