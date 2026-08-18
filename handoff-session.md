# Handoff — sync coverage and the datastore/server track

Covers work through 2026-08-18. Two other handoffs exist and are NOT this one:
`handoff.md` belongs to the window-manager initiative, and `handoff-mcp.md` is the
standing reference for the MCP remote backend design and its known gaps.

**This track lives in `.worktrees/sync`, on branch `sync`.** Work there, not in the
primary checkout, which stays on `main`.

**`.worktrees/fsm-window-kernel`, `.worktrees/bg-run-tmp-paths` and
`.worktrees/spindles-review` belong to other initiatives.** Nothing here touches them.

## Resume Here

### Goal

Everything in the datastore must reach the server, so that losing a device loses
nothing.

Sync coverage for items, events and tags is complete and proven against production.
**The next work is not more sync features — it is the test foundation.** The
end-to-end suite that exercises the real desktop sync module against a real server
over HTTP has been failing 11 of 13 tests since 2026-06-24, which means every recent
sync change landed on suites that cannot see a whole class of breakage. Restore that
suite, and establish what the remaining suites do and do not cover, before building
anything further on top.

### Current state

Five commits sit on `sync`, ahead of `main`, unlanded:

- `ca55f2ae` — event push tracks delivery per event in `item_events.pushedAt`,
  replacing a single global watermark that one unsyncable item could pin forever
  (every run re-pushed 24,000 events; measured live).
- `0234630d` — tests for that column's migration and backfill.
- `e17ed401` — an item the server permanently rejects is parked (`items.syncError`,
  `items.syncErrorAt`) instead of retried on every run forever.
- `64c5df6b` — item push batches through `POST /items/batch` instead of one HTTP
  request per item, with a 404 fallback to the old route.
- `740cffea` — `docs/sync.md` and `apps/server/README.md` describe the batched push.

Unit and route coverage is green across the board (see How to verify). Two things
about that are unverified rather than passing:

- **The full Electron gate has not been run on this branch.** Two datastore
  migrations and the whole item-push path changed. `apps/desktop/CLAUDE.md` forbids
  launching it without explicit human approval.
- **The server changes are not deployed.** `POST /items/batch` exists only in this
  branch; production still has the single-item route. That is safe — the client
  probes once per run, gets a 404, and pushes the old way — so the desktop can ship
  first, but the batching does nothing until the server goes up.

**`yarn test:sync:e2e` is 2 passed / 11 failed, and was already failing before any
of the work above** (confirmed by stashing every change and re-running). One root
cause, in the harness, not in the client or the server:

`packages/integration-tests/sync-e2e.test.js` talks to the server through two paths
that land in two different server-side profile buckets. Its own `serverRequest()`
sends no `profile` query param, so `apps/server/index.js` resolves the legacy slug
`"default"`. The real sync module always sends `?profile=<serverProfileId>`, and
`initDesktopDatastore()` passes the desktop's own locally-generated profile UUID as
that `serverProfileId` — an id the server has never seen. Since `a448079c`
(2026-06-24) `apps/server/users.js resolveProfileId()` gives an unregistered UUID its
own isolated profile instead of silently falling back to `"default"`, which was a
cross-profile data leak. So anything written through one path is invisible to the
other, and every test that mixes them fails. The two that pass use only one path.

The sibling suite `packages/integration-tests/sync-three-way.test.js` was updated for
that contract the day after it changed (`4f917fb1`) — it registers a real profile via
`POST /profiles` and uses the returned UUID on both sides. `sync-e2e.test.js` never
got the equivalent change.

### Next steps

Ordered. Steps 1 and 2 gate everything below them: no further sync feature work
until the test foundation is known-good, because a suite that cannot fail is a
suite that hides the regression the next change introduces.

1. **Repair `packages/integration-tests/sync-e2e.test.js` so both sides address the
   same server profile.** Two directions, either localized to that file:
   register a real server profile via `POST /profiles` and use the returned UUID in
   both `initDesktopDatastore()`'s `enableSync()` call and `serverRequest()` (what
   `sync-three-way.test.js createServerProfile()` already does, and the better
   model), or pass the literal slug `'default'` as `enableSync()`'s third argument to
   match what `serverRequest()` implicitly resolves to. Do NOT change
   `apps/server/users.js resolveProfileId()` — its isolation of unknown UUIDs is a
   deliberate data-leak fix.

   Expected result: 13 passed, 0 failed. Anything still red after the profile fix is
   a second, unrelated fault and needs its own diagnosis — several of these tests
   have never been observed passing on this machine.

2. **Audit what the sync suites actually cover, and write it down.** The point is to
   know which failures each suite can and cannot see, so a green run means something.
   At minimum, for each of `apps/desktop/main/sync.test.ts`,
   `packages/integration-tests/sync-e2e.test.js`,
   `packages/integration-tests/sync-integration.test.js`,
   `packages/integration-tests/sync-three-way.test.js` and
   `packages/integration-tests/sync-version-compat.test.js`: does it run, what does it
   exercise, and what class of fault is structurally invisible to it. One known
   example to record — `sync.test.ts` stubs `globalThis.fetch` straight into the
   server module in-process, so it is internally consistent by construction and can
   never catch two independently-configured HTTP clients disagreeing, which is
   exactly the bug in step 1. Record the result in `docs/sync-coverage-gaps.md`
   (which already carries the per-entity coverage story) rather than in this handoff.

   Also decide, and record, whether any of these suites should run in the desktop
   gate or a pre-commit hook. Today nothing runs them automatically, which is why a
   June breakage surfaced in August.

3. **Run the full Electron gate on this branch and diff the failing spec set against
   `apps/desktop/tests/gate-baseline.md`** — never against the failure count, which
   moves between identical runs.
   **blocked on: approval to run the gate** (it pins the CPU and pops up windows;
   `apps/desktop/CLAUDE.md` requires asking).

4. **Deploy the server so the batched item push takes effect.**
   `railway up ./apps/server --path-as-root --service peek-node --detach -m "<what
   changed>"` from the repo root. Ships `POST /items/batch` plus `db.js saveItems()`.
   **blocked on: authorization to deploy to production.**

5. **Paginate the bulk pull.** `/items/since/:timestamp` returns the entire profile
   in one body — 9.91 MB measured, unbounded as the datastore grows. The 120 s
   timeout only buys time. Touches the three `since` routes in `apps/server/index.js`
   and `pullFromServer`, `pullEventsFromServer`, `pullTagsFromServer` in
   `apps/desktop/main/sync.ts`, and needs a version story so an old client still
   works. This is the last piece of the push/pull performance work.

6. **Ship a mobile build.** The phone is locked out of `/items` entirely until a
   version-3 build ships: the shipped iOS build sends
   `X-Peek-Datastore-Version: 1` and `checkVersionHeaders()` in
   `apps/server/index.js` 409s it. Profile registration is not behind that check,
   which is why the device still shows a recent last-seen. Mobile source already
   declares version 3 in `apps/mobile/peek-core/src/types.rs`, review-verified only.

   Expect churn on the first pull: 747 tombstones arrive at once, and
   `merge_server_item()` in `apps/mobile/peek-core/src/sync.rs` matches them by server
   row id against the local `sync_id`. Where it matches, it soft-deletes the local row
   — invisible in the app, with no in-app undo — and then re-imports the surviving twin
   as a new local item with a fresh local id, orphaning visit/frecency history and
   offline blobs keyed to the old id. Take a server backup first and record the
   phone's pending count before and after.
   **blocked on: the Mac, which holds the iOS build environment and Xcode.**

7. **Keep the notes panel's editor open when something else changes.** Any subscribed
   pubsub event (`item:created`, `tag:item-added`, `sync:pull-completed`, …) makes
   `page-notes.js _reload()` rebuild the pane's whole DOM. Removing the focused
   textarea fires its blur handler, which saves and then sets `_editingId = null`, so
   an open note closes mid-typing and focus and caret are lost. **The text is NOT
   lost** — measured with a live probe. So this is an interruption, not data loss.

   A fix has to keep `_editingId` alive across a rebuild (the blur that the removal
   fires must save without closing) and restore the caret afterwards, which needs the
   in-progress value and selection held in pane state. An attempt that held the value
   and caret but left the blur handler clearing `_editingId` was reverted for changing
   nothing observable.

8. **Give the restore path a production rehearsal.** Backups are proven readable and
   the download route works against real data, but nothing has ever restored one.
   Until an archive is put back and verified, a backup is proven as an archive and
   unproven as recovery. Backups also still live on the same Railway volume as the
   live database with a 7-deep purge, so they do not protect against volume loss —
   the download route is the first half of fixing that; nothing pulls them off-box on
   a schedule.

9. **Sync `rules` — still deferred until something can write a user rule.** There are
   zero `source='user'` rows and no code path that creates one; `tile:rules:register`
   hardcodes `source: 'runtime'` and there is no rule editor. All existing rules are
   `source='manifest'` and regenerate, so they must not sync. Two constraints the rule
   editor must satisfy first: user-rule ids must be globally unique across devices,
   since the id is the only viable sync identity and manifest rules use a content hash
   that would collide by design; and rule deletion is a hard `DELETE` with no tombstone
   column, so sync would resurrect deleted rules until `rules` gains `deletedAt`.
   Separately, `scriptId` resolution fails silently — a synced rule naming a script the
   other device lacks never fires and logs nothing.

10. **Bootstrap the dispatch loop.** Needs Peek's MCP wired into this repo, which
    needs an MCP grant minted via `POST /admin/mcp-grants` (a production write
    creating a credential; the admin token is set and the route exists). No Peek
    datastore exists on this machine, so it must ride on the remote backend.
    `.claude/skills/dispatch/operating.md` covers the loop wiring and the autonomy
    ladder. **blocked on: authorization to mint an MCP grant, plus the scope tag it
    should be limited to and whether it is read-only.**

### Key files & symbols

- `packages/integration-tests/sync-e2e.test.js` — `initDesktopDatastore()` calls
  `enableSync(activeProfile.id, apiKey, activeProfile.id)`, passing a local UUID as
  the server profile id; `serverRequest()` sends no `profile` param at all. **That
  disagreement is the whole of step 1.**
- `packages/integration-tests/sync-three-way.test.js` — `createServerProfile()` and
  `clientRequest()`: the working pattern to copy.
- `apps/server/users.js resolveProfileId()` — an unregistered UUID gets its own
  isolated profile. **Deliberate (a cross-profile data-leak fix, `a448079c`); do not
  revert it to make a test pass.**
- `apps/desktop/main/sync.ts` — `syncAll()` runs six stages: pull tags, pull items,
  pull events, push tags, push items, push events.
  - `pushToServer()` batches through `pushItemsBatch()` in chunks of
    `MAX_ITEMS_PER_BATCH` (250), applies each chunk's per-row verdicts in one local
    transaction, and falls back to `pushSingleItem()` for the rest of the run on a
    404. Images always take the single-item route.
  - `parkRejectedItem()` records a permanent rejection as `syncError` plus
    `syncErrorAt` = the item's `updatedAt` at that moment. **The push query skips a
    parked item only while `updatedAt` has not moved past `syncErrorAt`, which is
    what makes any edit un-park it — no edit path in `datastore.ts` knows parking
    exists. Do not replace this with a flag that edit paths must clear.**
  - `pushEventsToServer()` selects `WHERE i.syncId != '' AND e.pushedAt = 0` and
    stamps `pushedAt` per delivered chunk. **Only delivered rows are stamped; that is
    the entire retry mechanism.**
  - `resetPerItemSyncState()` takes a `clearSyncId` flag — **keep `syncId` on a
    version bump or items duplicate.** It also clears `pushedAt` and the park columns.
  - `serverFetch()` carries `timeoutMs` (`DEFAULT_FETCH_TIMEOUT_MS` 15 s,
    `BATCH_PUSH_TIMEOUT_MS` 60 s, `BULK_PULL_TIMEOUT_MS` 120 s).
- `apps/server/index.js` — `POST /items/batch` validates per row and never rejects a
  whole chunk over one bad item, unlike `POST /events`. `checkVersionHeaders()` is
  mounted on `/items` and `/items/*` ONLY, so a version-mismatched client still
  reaches `/events` and `/tags`.
- `apps/server/db.js` — `saveItems()` wraps `saveItem()` in one transaction and
  returns a per-row result. `saveItem()` matches a pushed item by server row id, then
  by the `syncId` column. **No content fallback; syncId is canonical.**
- `apps/desktop/main/datastore.ts` — `migrateEventPushedAtColumn()` adds
  `item_events.pushedAt` and backfills from the retired watermark;
  `migrateItemSyncErrorColumns()` adds the park columns. Both are gated on the column
  being absent, which is what makes the backfill one-shot.
- `apps/desktop/tests/gate-baseline.md` — the failing-spec baseline; diff against it
  rather than reading the gate's failure count.
- `docs/sync-coverage-gaps.md` → the "`item_events` now syncs, stamped per event"
  section — why per-row delivery replaced a watermark.
- `docs/server-backup-and-deploy.md` → the "Restoring an archive" section — the
  restore route, its body, dry run, ordering, WAL handling and retention.

### How to verify

```
yarn test:sync:e2e                                                  # 2/13 today; 13 after step 1
yarn test:sync                                                      # 9
yarn server:test                                                    # 235
node --test apps/server/test-backup.js apps/server/test-restore.js  # 52
node --test packages/schema/fidelity.test.js                        # 32 pass, 0 fail, 9 skip
node packages/schema/check-freshness.js                             # all fresh
node --test packages/sync/test.js                                   # 96
npx tsc -p apps/desktop/tsconfig.json --noEmit                      # clean
yarn build && node --test apps/desktop/dist/main/sync.test.js       # 38
node --test apps/desktop/dist/main/datastore.test.js                # 45
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js         # 743
```

`yarn test:desktop:electron` is the full gate, takes ~15 minutes and pins the CPU.
Judge it by diffing the failing spec set against `apps/desktop/tests/gate-baseline.md`,
never by the count. **Requires human approval before each run.**

`npm install --prefix apps/server` is needed once in a fresh worktree, for plain JS
dependencies only — without it the desktop sync tests fail with `Cannot find module
'hono'`, because they drive the real server app in-process.

## Reference

### Decisions & gotchas

- **A local bookkeeping column needs no datastore version bump.** The rule that
  adding a synced column requires one exists because the push query only re-sends
  rows whose `syncedAt` is stale, so a bump is what forces the backfill. `pushedAt`,
  `syncError` and `syncErrorAt` are all declared `"sync": false` in
  `packages/schema/v1.json`: never on the wire, no server column, nothing a peer can
  observe. Adding them cost no bump and no full re-push.
- **`packages/schema/v1.json` is the source of truth, and the fidelity test only
  checks one direction per table.** For `item_events` the completeness test parses
  the literal `CREATE TABLE` text in `apps/desktop/main/datastore.ts` and does not
  union in `ALTER TABLE` statements, unlike the `items`/`tags` equivalents — so a
  column added only by a migration fails it. Add new columns to both the schema file
  and the `CREATE TABLE` literal, then run `yarn schema:codegen`, or
  `check-freshness.js` fails.
- **A permanent server rejection now costs one item, not the datastore.** Historical
  context for anyone reading the server's `CONTENT_REQUIRED_TYPES` comment: it used
  to stall the whole event stage, because the event watermark was held below every
  event behind the rejected item. Per-event stamps and item parking each removed one
  half of that. The server still accepts an empty `text` item deliberately.
- **`createdAt` is client-authoritative on INSERT; `updatedAt` stays server-stamped.**
  Preserving creation dates is what "lose nothing" means, while `updatedAt` is the key
  last-write-wins compares on.
- **Mobile has no version-change reset at all**, which is why it cannot reproduce the
  item-duplication bug. If it ever gains one it needs the same syncId-preserving rule
  the desktop has.
- **Mobile's park mechanism is not the desktop's.** `apps/mobile/peek-core/src/sync.rs
  mark_item_sync_failed()` nulls its own `sync_error` column from each update
  statement in `items.rs`; one missed statement there is an item that silently never
  syncs again. The desktop keys on `updatedAt` instead, so no edit path participates.
- **A parked check is skipped, never stubbed green.** Skips use the per-test form;
  `describe.skip` makes `node:test` drop subtests from the summary entirely.
- **The sync progress log is in-memory in the main process**, so an app restart loses
  it. `getSyncStatus().lastError` already persists the last failure across restarts.
  Whether the log itself should persist is an open product call.
- **Tag push has no per-tag error isolation**, unlike item push — a chunk failure
  there throws and aborts the whole push. Known and unaddressed.
- **Deleting an event does not propagate.** `tile:datastore:delete-item-event` is a
  live IPC any tile can call; a deleted observation returns on the next pull.
  Propagating it needs a tombstone column that no schema declares.
- **Tauri desktop is paused** and its schema fidelity checks are skipped with a stated
  reason. `apps/tauri-desktop/CLAUDE.md` records what to re-run before unpausing. Its
  `Item.sync_source` has no backing column: every SELECT building an `Item` in
  `apps/tauri-desktop/src-tauri/src/datastore.rs` reads `row.get(6)`, which is
  `createdAt`, an INTEGER — a runtime type mismatch that also shifts every later column
  index. Whether to add a real column or delete the phantom field is a design call.
- **Tauri desktop and mobile Rust do not compile on this machine** — both need
  GTK/glib development packages requiring privileges this environment does not grant.
  `apps/mobile/peek-core` does build and passes 107 tests.
- **The two IPC tests for `tile:sync:push`/`tile:sync:pull` replay the handler's stage
  order rather than invoking the registered closure**, because `tile-ipc.ts` imports
  `electron` statically, which throws at parse time outside a live Electron process.
  They prove the stages deliver; they would not catch a rewiring of `tile-ipc.ts`
  itself. The settings panel's live status line and log have no automated coverage at
  all for the same reason. Both belong in the step 2 audit.
- **A sync library was reviewed and rejected.** ElectricSQL, PowerSync and Zero all
  require Postgres, which this server is not. Zero and Evolu have no Rust client, so
  `apps/mobile/peek-core` could not speak them; Automerge's Rust and JS
  implementations are not wire-compatible with each other. Replicache is archived,
  CR-SQLite is ~2 years stale and self-declared not production ready, and Yjs solves
  concurrent text editing, which is not the problem here. Evolu otherwise fits (MIT,
  self-hostable, SQLite) but stores opaque encrypted mutations in its relay, which
  would end the server's own query surface, the MCP grants and the restore path.
- **The MCP remote backend is on the back burner** by decision, though its blocking
  question is answered: a real client (version 2.1.233) expands an embedded `${VAR}`
  in a `.mcp.json` url. The `#scope` fragment is never transmitted (HTTP does not send
  fragments); it is only a local credential-file key, and scope reaches the server as
  a column on the grant row via `apps/server/grants.js resolveMcpGrant()`. Zero MCP
  grants exist on the account, and a device key cannot authenticate `/mcp/*`
  (verified: 401 there, 200 on `/profiles`).

### Environment notes

- The Railway CLI is installed and authenticated; the repo is linked to project
  `amusing-courtesy`, service `peek-node`. Read-only commands need no confirmation.
  `railway variables` prints secrets — use `railway run --service peek-node -- node
  <script>` to get them into a process without displaying them.
- The device API key lives at `$HOME/.peek.config` as an `API_KEY=` line, mode 600. It
  authenticates the sync routes but NOT `/mcp/*`, which is a separate credential
  namespace.
- Deploy is a manual upload, not a GitHub push. Never add `yarn.lock` to
  `apps/server/` — Nixpacks would switch to yarn and the build breaks.
- The `sqlite3` CLI is not installed; use `node:sqlite` via node. `better-sqlite3` is
  absent from the whole workspace.
- `electron-builder` excludes `.worktrees`, so packaging no longer globs into other
  worktrees.
- Production data as of the last full sync: 12,440 items (11,625 live after
  tombstones), 24,087+ events, 518 tags. 747 duplicate rows created by an earlier
  syncId-clearing bug were soft-deleted on the server; zero duplicate groups remain.
