# Handoff — sync coverage and the datastore/server track

Covers work through 2026-08-18. Two other handoffs exist and are NOT this one:
`handoff.md` belongs to the window-manager initiative, and `handoff-mcp.md` is the
standing reference for the MCP remote backend design and its known gaps.

**This track lives in `.worktrees/sync`, on branch `sync`.** Work there, not in the
primary checkout — the primary checkout stays on `main` and is not worked in. Every
commit through `d3cfbc98` predates that rule and landed on `main` directly; the branch
starts from it, so nothing is missing.

**`.worktrees/fsm-window-kernel`, `.worktrees/bg-run-tmp-paths` and
`.worktrees/spindles-review` belong to other initiatives.** Nothing here touches them.
Do not edit, rebase, or reclaim them.

## Resume Here

### Goal

Everything in the datastore must reach the server, so that losing a device loses
nothing. Sync coverage for items, events and tags is now complete and proven against
production. What remains is hardening (a restore that has never restored, an
unpaginated pull, mobile locked out) and the deliberately deferred `rules` table.

### Current state

`main` is clean and pushed to `tangled`; the last code commit is `205e4687`.

**Event sync is proven end to end.** A full desktop sync moved `item_events` on the
live server from 0 to 24,087 rows, and a following delta sync added a handful more —
so both the initial push and the incremental watermark path are exercised against
real data. Items 12,440 (11,625 live after tombstones), tags 518.

**A datastore version bump duplicated 11% of items, and that is fixed.**
`apps/desktop/main/sync.ts resetPerItemSyncState()` cleared `syncedAt` and `syncId`
together. Clearing `syncedAt` is what forces the re-push and is correct; clearing
`syncId` discarded the client's record of which server row an item corresponds to.
`apps/server/db.js saveItem()` matches only by server row id or the stored `syncId`
column, with an explicit no-content-fallback rule, so any item the desktop did not
originally push came back as a new row. Measured: a pre-sync snapshot held 11,121
items and zero duplicate groups; one sync later there were 12,432 items and 747
groups of rows identical in type, content and creation time to the millisecond. The
reset now takes the identity decision from its caller — a version bump keeps
`syncId`, a changed server URL still clears it.

The 747 duplicate rows were soft-deleted from production (tombstones; rows retained
with `deletedAt` set). Zero duplicate groups remain. The audit list of deleted ids
was rebuilt from the tombstones themselves and is NOT in the repo — it lives only in
the session scratchpad, so treat the server's own tombstones as the record.

**Four sync faults found and fixed while proving the above**, each of which could
hold sync at zero indefinitely:

- **The bulk pull aborted every run.** `serverFetch` applied a 15 s timeout to every
  request, while `/items/since/0` returns the whole profile as one unpaginated body
  (measured 9.91 MB). The pulls run before any push, so on a slow link the first
  request aborted and nothing ever pushed. Bulk pulls now get 120 s via
  `BULK_PULL_TIMEOUT_MS`; per-item writes keep the 15 s default.
- **One malformed event poisoned every future run.** `POST /events` rejects a whole
  batch if any event has an empty id/itemId or a non-numeric `occurredAt`/`createdAt`,
  and event push is the last stage, so the throw skipped `updateLastSyncTime` and the
  watermark write and the next run rebuilt the identical batch. `pushEventsToServer`
  now validates and drops unusable rows, holds the watermark below anything dropped,
  and isolates each chunk.
- **`tile:sync:push` pushed items alone** while advancing the sync time, so the
  Settings "Push to Server" button looked complete having sent neither tags nor
  events. `tile:sync:pull` had the mirror gap. Both now run all three stages.
- **Event-stage failure aborted the run's bookkeeping.** `syncAll` now records it
  through `lastSyncError` and still writes the sync time, since items and tags having
  landed is real progress.

**The server has a restore path, deployed.** `apps/server/restore.js restoreBackup()`
extracts each profile's snapshot, verifies it opens as SQLite, renames the live
database and its journal aside as a rollback, moves the snapshot into place,
re-registers the profile, then reopens and compares row counts to the manifest.
`POST /admin/restore` is admin-token gated and takes `userId` from the body (both auth
middlewares skip `/admin`). `GET /backups/:filename` streams an archive off the volume.
`apps/server/zip-read.js` is the shipped zip reader (archiver is write-only and no
unzip dependency exists); it rejects absolute paths, `.` and `..` segments, backslash
separators, drive prefixes, and throws naming zip64 on sentinel values.

The download route and the reader were exercised against real production data: this
morning's pre-sync archive downloaded, extracted and opened cleanly, and its contents
were used to prove the duplication finding. **The restore direction has still never
been run against production** — only against tests.

**Settings shows sync progress live, with a per-run log.** `sync.ts` keeps a bounded
ring buffer (`SYNC_LOG_MAX_ENTRIES` 300) and publishes each entry over the existing
pubsub topic; Settings seeds from it via `tile:sync:get-log` before subscribing, so
opening the panel mid-run shows history. Item-push progress throttles to every 100
items or 3 s. Push failures group by message (cap 20 distinct reasons, up to 20 ids)
and are classified: a 4xx reads as "will not succeed until the item changes", anything
else as "will retry next run". Entries carry ids, counts and error text only — never
item content, since the log renders in the UI.

**One empty note stalled the whole event stage, and that is fixed.** Six local `text`
items were rejected on every run with `Server error 400: {"error":"content is
required for type 'text'"}`. Queried against the live datastore, four of them exist
with empty content AND empty title — junk, not a client bug losing data
(`pushSingleItem` sends `content: item.content` straight from `SELECT * FROM items`,
so nothing is dropped in transit). The other two ids the log named are absent from
that datastore, unexplained and not chased.

The consequence was far larger than six items. `pushEventsToServer()` holds its
watermark below the oldest event of any item lacking a `syncId`, so nothing is
stranded when a parent item finally syncs — but an item the server permanently
rejects never earns one. The watermark stayed pinned in February and **every run
re-pushed the entire event tail behind it: 20,000+ events, measured live.** The
stage logged nothing between its start and finish lines, so it read as a hang.

Four changes closed it:

- **The server stores an empty `text` item** instead of rejecting it
  (`CONTENT_REQUIRED_TYPES` in `apps/server/index.js` drops `text`; `url` keeps the
  requirement). Deployed to production 2026-08-18 07:27 UTC. Rejecting an item the
  client retries forever is what turns one bad row into a stalled sync.
- **A deleted, never-synced item no longer pins the watermark** (`AND i.deletedAt = 0`
  on the blocked-event query). Deleting an unsyncable item is the obvious remedy, and
  without this it made the stall permanent instead of clearing it.
- **The event stage reports its batch plan and position**, so its size is visible
  before it starts working.
- **A one-time migration soft-deletes text items with neither content nor title**
  (`migrateEmptyTextCleanup`, flag `empty_text_cleanup_v1`).

**Those four changes were not enough — a rebuilt desktop still re-pushes 24,000 events
every run, with all items now syncing without error.** So the remaining pin is not bad
data, it is the design: the blocked-event scan holds the watermark below the oldest
event of ANY live item lacking a `syncId`, and several classes of item never earn one
by design — a type outside `getSyncedTypes()`, and anything whose content starts with
`peek://` (filtered in `pushToServer()`). One global watermark for all events means the
worst item in the datastore decides what every event costs. Next Step 1 replaces it.

**What created the empty notes.** `features/editor/home.js init()` created the row the
moment a blank editor opened, before any typing — introduced 2026-02-11 (`cb4d5e10`),
removed 2026-02-26 (`0bd98f19`). All four surviving ids decode to timestamps inside
that window. The overlay notes panel had the same shape (`page-notes.js _addNote()`
wrote the row on `+` and filled it on blur) and now defers the write to the first
non-empty keystroke, flushing a non-empty draft if the pane is torn down.

**The desktop Electron gate has a recorded baseline.** `apps/desktop/tests/gate-baseline.md`
lists the 27 desktop and 1 desktop-serial specs that fail on every run, and the 5 that
come and go, each with its cause. Recorded from two consecutive runs on an unchanged
tree, since one run cannot separate a deterministic failure from a flake.
`apps/desktop/CLAUDE.md` points at it. main-process unit, node unit, components and
editor are green here, so any failure in those four is a regression.

**Schema fidelity is green** — 32 pass, 0 fail, 9 skipped. The four failures this
handoff previously carried (a `rules` table the server lacks, and `items.type`
omitting `event`) were closed by commits `7d3178ab`, `2201e843` and `e03ffb74`.

**The MCP remote backend is on the back burner** by decision, though its blocking
question is answered: a real client (version 2.1.233) expands an embedded `${VAR}` in
a `.mcp.json` url — `"${PEEK_SYNC_URL}#work"` resolved and completed a full MCP
handshake against a logging stub. The `#scope` fragment is never transmitted (HTTP
does not send fragments); it is only a local credential-file key, and scope reaches
the server as a column on the grant row via `apps/server/grants.js resolveMcpGrant()`,
which is what the design requires. Zero MCP grants exist on the account, and a device
key cannot authenticate `/mcp/*` (verified: 401 there, 200 on `/profiles`).

**Mobile sync is dead until a build ships.** The shipped iOS build sends
`X-Peek-Datastore-Version: 1`; `checkVersionHeaders` in `apps/server/index.js` — mounted
on `/items` and `/items/*` only — 409s it, so push and pull both abort. Profile
registration is not behind that check, which is why the device still shows a recent
last-seen. Mobile source already declares version 3 in
`apps/mobile/peek-core/src/types.rs`, review-verified only.

### Next steps

Ordered by consequence.

1. **Track event sync per event, not with one global watermark.** This is the fix for the
   24,000-event re-push and it supersedes patching the blocked-event scan.

   Add `pushedAt INTEGER NOT NULL DEFAULT 0` to `item_events`, declared in
   `packages/schema/v1.json` so all three clients regenerate. `pushEventsToServer()` then
   selects `WHERE i.syncId != '' AND e.pushedAt = 0` and stamps `pushedAt` per chunk on
   success; `getLastEventPushAt`/`setLastEventPushAt`, the `lastEventPushAt` setting, and
   the whole blocked-event scan go away. An event whose parent cannot sync then strands
   exactly itself and is picked up whenever that parent does sync — the protection the
   pin existed for, without the coupling.

   Backfill decides how expensive the transition is: stamp every event at or below the
   current watermark as already pushed, and only the tail behind it re-pushes, once. The
   server takes events idempotently by event id, so a re-push duplicates nothing.
   **Open decision: whether this needs a datastore version bump.** The standing rule
   below says adding a synced column does; defaulting `pushedAt = 0` and accepting one
   re-push avoids the bump and its full item re-push. Check `packages/sync/version.js`
   before shipping.

   Then, in order: port `mark_item_sync_failed()` from `apps/mobile/peek-core/src/sync.rs`
   so the desktop parks what `isPermanentPushFailure()` already classifies as hopeless
   (today it classifies and acts on nothing); batch `POST /items` mirroring `POST /events`
   (1000 cap, per-row validation, one transaction), turning ~11k sequential requests into
   ~12; then Next Step 4's pagination.

   **A sync library was reviewed and rejected for this.** ElectricSQL, PowerSync and Zero
   all require Postgres — PowerSync explicitly does not support a SQLite backend — which
   this server is not. Zero and Evolu have no Rust client, so `apps/mobile/peek-core`
   could not speak them; Automerge's Rust and JS implementations are not wire-compatible
   with each other. Replicache is archived, CR-SQLite is ~2 years stale and self-declared
   not production ready, and Yjs solves concurrent text editing, which is not the problem
   here. Evolu otherwise fits (MIT, self-hostable, SQLite) but stores opaque encrypted
   mutations in its relay, which would end the server's own query surface, the MCP grants
   and the restore path. Nothing on offer is cheaper than the column above.

2. **Ship a mobile build.** Mobile cannot reproduce the duplication bug — it has no
   version-change reset at all, and `push_to_server()` in
   `apps/mobile/src-tauri/src/lib.rs` sends the server row id once it has one. But the
   phone is locked out of `/items` entirely until a version-3 build ships, so anything
   captured on it since the server moved to 3 has not reached the server.

   Expect churn on the first pull: 747 tombstones arrive at once, and
   `merge_server_item()` in `apps/mobile/peek-core/src/sync.rs` matches them by server
   row id against the local `sync_id`. Where it matches, it soft-deletes the local row
   — invisible in the app, with no in-app undo — and then re-imports the surviving twin
   as a new local item with a fresh local id, orphaning visit/frecency history and
   offline blobs keyed to the old id. Take a server backup first and record the phone's
   pending count before and after.
   **blocked on: the Mac, which holds the iOS build environment and Xcode.**

3. **Keep the notes panel's editor open when something else changes.** Any subscribed
   pubsub event (`item:created`, `tag:item-added`, `sync:pull-completed`, …) makes
   `page-notes.js _reload()` rebuild the pane's whole DOM. Removing the focused
   textarea fires its blur handler, which saves and then sets `_editingId = null`, so
   an open note closes mid-typing and focus and caret are lost. **The text is NOT
   lost** — measured with a live probe: after an unrelated write the note's preview
   held every typed character. So this is an interruption, not data loss.

   A fix has to keep `_editingId` alive across a rebuild (the blur that the removal
   fires must save without closing) and restore the caret afterwards, which needs the
   in-progress value and selection held in pane state. An attempt that held the value
   and caret but left the blur handler clearing `_editingId` was reverted for changing
   nothing observable.

4. **Paginate the bulk pull.** `/items/since/:timestamp` returns the entire profile in
   one body — 9.91 MB today and unbounded as the datastore grows. The 120 s timeout
   only buys time. This changes both `apps/server/index.js` (the three `since` routes)
   and the desktop pull functions `pullFromServer`, `pullEventsFromServer`,
   `pullTagsFromServer` in `apps/desktop/main/sync.ts`, and needs a version story so an
   old client still works.

5. **Batch the item push** — listed under Next Step 1, which carries the detail. A full
   re-push is one HTTP request per item, roughly 11k sequential requests taking about 25
   minutes on a normal connection, while `POST /events` already accepts batches of up to
   1000 and pushes 24k events in under a minute.

6. **Give the restore path a production rehearsal.** Backups are proven readable and
   the download route works against real data, but nothing has ever restored one.
   Until an archive is put back and verified, a backup is proven as an archive and
   unproven as recovery. Backups also still live on the same Railway volume as the
   live database with a 7-deep purge, so they do not protect against volume loss —
   the download route is the first half of fixing that; nothing pulls them off-box on
   a schedule.

7. **Sync `rules` — still deferred until something can write a user rule.** There are
   zero `source='user'` rows and no code path that creates one; `tile:rules:register`
   hardcodes `source: 'runtime'` and there is no rule editor. All existing rules are
   `source='manifest'` and regenerate, so they must not sync. Two constraints the rule
   editor must satisfy first: user-rule ids must be globally unique across devices,
   since the id is the only viable sync identity and manifest rules use a content hash
   that would collide by design; and rule deletion is a hard `DELETE` with no tombstone
   column, so sync would resurrect deleted rules until `rules` gains `deletedAt`.
   Separately, `scriptId` resolution fails silently — a synced rule naming a script the
   other device lacks never fires and logs nothing.

8. **Bootstrap the dispatch loop.** Needs Peek's MCP wired into this repo, which needs
   an MCP grant minted via `POST /admin/mcp-grants` (a production write creating a
   credential; the admin token is set and the route exists). No Peek datastore exists
   on this machine, so it must ride on the remote backend.
   `.claude/skills/dispatch/operating.md` covers the loop wiring and the autonomy
   ladder. **blocked on: authorization to mint an MCP grant, plus the scope tag it
   should be limited to and whether it is read-only.**

### Key files & symbols

- `apps/desktop/main/sync.ts` — `syncAll()` runs six stages in order: pull tags, pull
  items, pull events, push tags, push items, push events. `resetPerItemSyncState()`
  takes a `clearSyncId` flag — **keep `syncId` on a version bump or items duplicate**.
  `serverFetch()` carries `timeoutMs` (`DEFAULT_FETCH_TIMEOUT_MS` 15 s,
  `BULK_PULL_TIMEOUT_MS` 120 s). `pushEventsToServer()` owns event validation, per-chunk
  isolation and the `lastEventPushAt` watermark — **its blocked-event query holds that
  watermark below the oldest event of any live item without a `syncId`, so anything the
  server permanently rejects stalls the whole stage** (deleted items are excluded).
  `logSyncProgress()`/`getSyncLog()`/
  `resetSyncLog()` own the progress log; `groupFailuresByReason()` and
  `isPermanentPushFailure()` classify failures.
- `apps/server/db.js saveItem()` — matches a pushed item by server row id, then by the
  `syncId` column. **No content fallback; syncId is canonical.** This is why a lost
  syncId means a duplicate row.
- `apps/desktop/main/datastore.ts migrateEmptyTextCleanup()` — the one-shot cleanup, and
  the model for adding another (settings-flag gating, soft delete, exported so a node
  test can drive it against an in-memory database).
- `apps/desktop/renderer/page/page-notes.js` — the chrome overlay's notes panel.
  `_addNote()` holds a draft; `_createDraftNote()` writes the row on the first non-empty
  keystroke; `_flushPendingDraft()` saves it when the pane is retargeted or cleared.
- `apps/server/index.js` — `checkVersionHeaders()` is mounted on `/items` and
  `/items/*` ONLY, so a version-mismatched client still reaches `/events` and `/tags`.
  `POST /events` caps at 1000 per push and validates id/itemId/occurredAt/createdAt.
- `apps/server/restore.js restoreBackup()` — extract and verify before moving anything
  live; rename the old database and its `-wal`/`-shm` aside rather than deleting them.
- `apps/server/zip-read.js validateEntryName()` — the traversal guard every extraction
  path goes through.
- `apps/desktop/tests/gate-baseline.md` — the failing-spec baseline; diff against it
  rather than reading the gate's failure count.
- `docs/server-backup-and-deploy.md` → the "Restoring an archive" section — the restore
  route, its body, dry run, ordering, WAL handling and retention.
- `apps/mobile/peek-core/src/sync.rs merge_server_item()` — how the phone will apply
  the 747 tombstones.

### How to verify

```
yarn server:test                                                    # 225
node --test apps/server/test-backup.js                              # 29
node --test apps/server/test-restore.js                             # 23
node --test packages/schema/fidelity.test.js                        # 32 pass, 0 fail, 9 skip
node packages/schema/check-freshness.js                             # all fresh
node --test packages/sync/test.js                                   # 96
npx tsc -p apps/desktop/tsconfig.json --noEmit                      # clean
yarn build && node --test apps/desktop/dist/main/sync.test.js       # 30
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js         # 743
```

`yarn test:desktop:electron` is the full gate, takes ~15 minutes and pins the CPU.
Judge it by diffing the failing spec set against `apps/desktop/tests/gate-baseline.md`,
never by the count.

## Reference

### Decisions & gotchas

- **A permanent server rejection is a sync-wide stall, not a one-item problem.** The
  client retries a rejected item forever, so it never earns a `syncId`, and the event
  watermark is held below every event behind it. Validation that refuses to store
  something a client already holds costs far more than the row it saves — which is why
  the server now accepts an empty `text` item.

- **`createdAt` is client-authoritative on INSERT; `updatedAt` stays server-stamped.**
  Preserving creation dates is what "lose nothing" means, while `updatedAt` is the key
  last-write-wins compares on. A useful side effect: rows touched since a given moment
  are countable from `updatedAt`, which is how the duplication was measured without
  server shell access.
- **Adding a synced column requires a version bump**, because the push query only
  selects rows where `syncedAt` is 0 or `updatedAt` exceeds `syncedAt`. The bump is what
  makes old rows re-push and backfill. That is also what makes bumps expensive: a full
  re-push of every item, one request each.
- **Mobile's protection from the duplication bug is the absence of a reset, not a
  guard.** If mobile ever gains a version-change reset it needs the same syncId-preserving
  rule the desktop now has.
- **A parked check is skipped, never stubbed green.** Skips use the per-test form;
  `describe.skip` makes `node:test` drop subtests from the summary entirely, hiding
  them rather than showing them parked.
- **The sync progress log is in-memory in the main process**, so an app restart loses
  it. `getSyncStatus().lastError` already persists the last failure across restarts.
  Whether the log itself should persist is an open product call, deliberately not
  implemented.
- **Tag push has no per-tag error isolation**, unlike item push — a chunk failure there
  throws and aborts the whole push. That asymmetry is known and unaddressed.
- **Deleting an event does not propagate.** `tile:datastore:delete-item-event` is a live
  IPC any tile can call; a deleted observation returns on the next pull. Propagating it
  needs a tombstone column that no schema declares.
- **Tauri desktop is paused** and its schema fidelity checks are skipped with a stated
  reason. `apps/tauri-desktop/CLAUDE.md` records what to re-run before unpausing. Its
  `Item.sync_source` has no backing column: every SELECT building an `Item` in
  `apps/tauri-desktop/src-tauri/src/datastore.rs` reads `row.get(6)`, which is
  `createdAt`, an INTEGER — a runtime type mismatch that also shifts every later column
  index. Whether to add a real column or delete the phantom field is a design call.
  Tauri desktop also never sends `createdAt`, `visitCount`, `lastVisitAt` or `mimeType`.
- **Tauri desktop and mobile Rust do not compile on this machine** — both need GTK/glib
  development packages requiring privileges this environment does not grant.
  `apps/mobile/peek-core` does build and passes 107 tests.
- **The two IPC tests for `tile:sync:push`/`tile:sync:pull` replay the handler's stage
  order rather than invoking the registered closure**, because `tile-ipc.ts` imports
  `electron` statically, which throws at parse time outside a live Electron process.
  They prove the stages deliver; they would not catch a rewiring of `tile-ipc.ts`
  itself. Closing that needs either a Playwright spec or changing the import style in a
  7,000-line file. The settings panel's live status line and log have no automated
  coverage at all for the same reason.

### Environment notes

- The Railway CLI is installed and authenticated; the repo is linked to project
  `amusing-courtesy`, service `peek-node`. Read-only commands need no confirmation.
  `railway variables` prints secrets — use `railway run --service peek-node -- node
  <script>` to get them into a process without displaying them.
- The device API key lives at `$HOME/.peek.config` as an `API_KEY=` line, mode 600. It
  authenticates the sync routes but NOT `/mcp/*`, which is a separate credential
  namespace.
- Deploy is a manual upload, not a GitHub push:
  `railway up ./apps/server --path-as-root --service peek-node --detach -m "<what changed>"`
  from the repo root. `--path-as-root` is required. Never add `yarn.lock` to
  `apps/server/` — Nixpacks would switch to yarn and the build breaks.
- `npm install --prefix apps/server` is still needed in a fresh worktree, for plain JS
  dependencies only. It compiles nothing.
- The `sqlite3` CLI is not installed; use `node:sqlite` via node. `better-sqlite3` is
  absent from the whole workspace.
- `electron-builder` excludes `.worktrees`, so packaging no longer globs into other
  worktrees.
