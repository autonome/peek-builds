# Handoff — sync coverage and the datastore/server track

Covers work through 2026-08-18. Two other handoffs exist and are NOT this one:
`handoff-mcp.md` is the standing reference for the MCP remote backend design and its
known gaps, and `handoff-mcp-seam.md` covers the MCP seam work.

**This track lives in `.worktrees/sync`, on branch `sync`.** Work there, not in the
primary checkout, which stays on `main`.

**`.worktrees/fsm-window-kernel`, `.worktrees/bg-run-tmp-paths` and
`.worktrees/spindles-review` belong to other initiatives.** Nothing here touches them.

## Resume Here

### Goal

Everything in the datastore must reach the server, so that losing a device loses
nothing.

Sync coverage for items, events and tags is complete and proven against production,
the test foundation under it is repaired and documented, and the bulk pull is paged.
**Every remaining step on this track needs a human first.** Nothing here should be
started until the four questions in Next Steps are answered — they gate the gate run,
the deploy, the mobile build and the dispatch loop respectively, and there is no
unblocked sync work left behind them.

### Current state

Thirteen commits sit on `sync`, ahead of `main`, unlanded. The seven from this
session:

- `fe14a3e6` — the end-to-end suite addresses one server profile from both sides. It
  had been 2 passed / 11 failed since 2026-06-24 because its own `serverRequest()`
  sent no `profile` param (resolving the legacy slug `"default"`) while the sync
  module sent the desktop's local profile UUID, and an unregistered UUID gets its own
  isolated profile. Now 13/13.
- `93cf0b5e` — `docs/sync-coverage-gaps.md` section 8: what each of the five sync
  suites exercises for real and what is invisible to it by construction. Adds
  `yarn test:sync:all`.
- `dc19ffd0` — the two end-to-end cases that printed a pass on every path replaced
  with real assertions: a deletion tombstone reaching the server, and an item the
  server permanently rejects being parked and then un-parked by an edit.
- `0a6e8216` — the three `since` routes accept `limit` and hand back `nextCursor`;
  the desktop's three pull loops follow it, merging page by page. A full pull now
  goes through `/items/since/0` instead of `GET /items`.
- `ad9d6495` — a note being typed in stays open when the notes pane rebuilds.
- `48c89956` — the coverage audit's per-suite counts refreshed for the paged-pull
  cases.
- `78e7a0fd` — an edited note's preview shows the new text immediately instead of
  the pre-edit text.

The six older ones (`ca55f2ae`, `0234630d`, `e17ed401`, `64c5df6b`, `740cffea`,
`4aeecd1d`) carry per-event push tracking in `item_events.pushedAt`, the parked-item
columns, the batched item push through `POST /items/batch`, and their docs.

Everything in How to verify is green. Two things are unverified rather than passing:

- **The full Electron gate fails `hybrid-overlay.spec.ts` "draft note: an empty blur
  creates nothing, a typed blur creates exactly one item"**, which is absent from
  `apps/desktop/tests/gate-baseline.md` and passed in both of the baseline's recorded runs.
  It reproduces only under the full desktop project — a single-file run of that spec on a
  freshly built package passes 47/48. Cause not yet identified.
- **The server changes are not deployed.** `POST /items/batch` and the `limit`/
  `cursor` parameters exist only in this branch. That is safe in both directions —
  the client probes the batch route once per run and falls back on a 404, and a
  server that ignores `limit` returns one unpaged page with no cursor, which ends the
  client's loop after one round trip — so the desktop can ship first, but neither
  change does anything until the server goes up.

### Next steps

**Steps 1 through 4 are questions, not work.** Ask all four at the start of the
session and wait for the answers before starting anything, including the steps
below them: step 5 needs the same production authorization, and steps 6 and 7 are
follow-on work that should not begin while the branch is unproven by the gate and
undeployed.

1. **Find the cause of the draft-note gate failure and fix it.** It is the one thing
   blocking this branch from landing. What is known: it reproduces only under the full
   desktop project, not in a single-file run or via `test:grep`; the item does reach the
   datastore (the test's count assertions pass) and what is empty is the rendered pane, so
   this is a render/reload problem rather than a lost write. `page-notes.js` `_render()`
   guards a rebuild with `_rebuilding`, and both blur handlers branch on it — the draft's
   handler is `async` and reads it again after an `await`, which is the prime suspect.
   `overlay.js` and the spec currently carry a temporary diagnostic (`window.__notesPaneDiag`
   plus a state dump on the failing assertion) — **remove both before committing.**

2. **Deploy the server so the batched push and the paged pull take effect.**
   `railway up ./apps/server --path-as-root --service peek-node --detach -m "<what
   changed>"` from the repo root. Ships `POST /items/batch`, `db.js saveItems()`, and
   `limit`/`cursor` on the three `since` routes.
   **blocked on: authorization to deploy to production.**

3. **Ship a mobile build.** The phone is locked out of `/items` entirely until a
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

4. **Bootstrap the dispatch loop.** Needs Peek's MCP wired into this repo, which
   needs an MCP grant minted via `POST /admin/mcp-grants` (a production write
   creating a credential; the admin token is set and the route exists). No Peek
   datastore exists on this machine, so it must ride on the remote backend.
   `.claude/skills/dispatch/operating.md` covers the loop wiring and the autonomy
   ladder. **blocked on: authorization to mint an MCP grant, plus the scope tag it
   should be limited to and whether it is read-only.**

Once those are answered, the work that remains on this track, in order:

5. **Give the restore path a production rehearsal.** Backups are proven readable and
   the download route works against real data, but nothing has ever restored one.
   Until an archive is put back and verified, a backup is proven as an archive and
   unproven as recovery. Backups also still live on the same Railway volume as the
   live database with a 7-deep purge, so they do not protect against volume loss —
   the download route is the first half of fixing that; nothing pulls them off-box on
   a schedule. `docs/server-backup-and-deploy.md` → the "Restoring an archive"
   section has the route, its body, dry run, ordering, WAL handling and retention.
   **blocked on: authorization to write to production, since a rehearsal restores
   into the live server.**

6. **Close the gaps the coverage audit names**, listed in
   `docs/sync-coverage-gaps.md` → the "The gaps this leaves" subsection of section 8:
   no suite exercises the tag or event stages over a real socket, none exercises real
   authentication end to end (the end-to-end suite spawns the server with
   `E2E_TEST=true`, which short-circuits `apps/server/auth.js`), `item_events.pushedAt`
   and the `POST /items/batch` 404 fallback are proven only in-process, and
   `sync-version-compat.test.js` asserts version-bump behaviour against a copy of
   `datastore.ts checkAndWriteDatastoreVersion()` rather than the real one.

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

### Key files & symbols

- `apps/desktop/main/sync.ts` — `syncAll()` runs six stages: pull tags, pull items,
  pull events, push tags, push items, push events.
  - `pullPages()` walks a `since` pull one page at a time, yielding each page's rows
    so the caller merges and discards rather than accumulating the profile. It stops
    on a missing `nextCursor`, an empty page, a repeated cursor, or `MAX_PULL_PAGES`.
    **Paging is opt-in on both sides — a server that ignores `limit` ends the loop
    after one request, which is what lets this ship before the server does.**
  - `pullFromServer()` uses `/items/since/0` for a full pull, not `GET /items`.
    **Consequence: a row whose `updatedAt` is missing or unparseable reads as 0 and is
    never returned.** Every write path stamps `updatedAt`, so this bites legacy rows
    only.
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
- `apps/server/index.js` — `resolvePageOptions()` and `nextCursorFor()` are shared by
  the three `since` routes; `MAX_SYNC_PAGE` is 1000. A bad `limit` or an undecodable
  `cursor` is a 400, deliberately, rather than a silent restart from the beginning.
  `POST /items/batch` validates per row and never rejects a whole chunk over one bad
  item, unlike `POST /events`. `checkVersionHeaders()` is mounted on `/items` and
  `/items/*` ONLY, so a version-mismatched client still reaches `/events` and `/tags`.
- `apps/server/db.js` — `encodeCursor()` / `decodeCursor()` / `appendCursorClause()`
  back the keyset scan. **The cursor carries the last row's timestamp AND id; rows
  share a millisecond, and a timestamp-only cursor either skips the rest of that
  group or repeats it forever.** `saveItems()` wraps `saveItem()` in one transaction
  and returns a per-row result; `saveItem()` matches a pushed item by server row id,
  then by the `syncId` column. **No content fallback; syncId is canonical.**
- `apps/server/users.js resolveProfileId()` — an unregistered UUID gets its own
  isolated profile. **Deliberate (a cross-profile data-leak fix, `a448079c`); do not
  revert it to make a test pass.**
- `apps/desktop/main/datastore.ts` — `migrateEventPushedAtColumn()` adds
  `item_events.pushedAt` and backfills from the retired watermark;
  `migrateItemSyncErrorColumns()` adds the park columns. Both are gated on the column
  being absent, which is what makes the backfill one-shot.
- `apps/desktop/renderer/page/page-notes.js` — `_render()` sets `_rebuilding` while it
  replaces the pane's DOM, `_captureOpenEditor()` snapshots the open editor's text and
  caret, and the textarea's `blur` handler keeps the note open when `_rebuilding` is
  set. Its closing branch also writes the new text onto the in-memory note before
  re-rendering, because `_render()` reads `this._notes` and the datastore save is
  fire-and-forget. **Chrome fires that blur while the textarea is still in the document, so
  `isConnected` cannot distinguish a rebuild from the user leaving — the flag is the
  only signal that works.** Verified by live trace, not by reasoning.
- `apps/desktop/tests/gate-baseline.md` — the failing-spec baseline; diff against it
  rather than reading the gate's failure count.
- `docs/sync-coverage-gaps.md` → section 8, "What the sync test suites can and cannot
  catch" — per suite: what is real, which stages it touches, what it cannot see.
- `docs/sync.md` → the "Paging a pull" section — the cursor contract and its
  compatibility story.

### How to verify

```
yarn test:sync:all                                                  # 9 + 8 + 16 + 13
yarn server:test                                                    # 245
node --test apps/server/test-backup.js apps/server/test-restore.js  # 52
node --test packages/schema/fidelity.test.js                        # 32 pass, 0 fail, 9 skip
node packages/schema/check-freshness.js                             # all fresh
node --test packages/sync/test.js                                   # 96
npx tsc -p apps/desktop/tsconfig.json --noEmit                      # clean
yarn build && node --test apps/desktop/dist/main/sync.test.js       # 41
node --test apps/desktop/dist/main/datastore.test.js                # 45
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js         # 743
yarn test:grep 'an open note survives a reload'                     # 1 passed
yarn test:grep 'leaving a note still closes it'                     # 1 passed
```

`yarn test:desktop:electron` is the full gate, takes ~15 minutes and pins the CPU. Run it
whenever a change warrants it; no approval needed. Judge it by diffing the failing spec set
against `apps/desktop/tests/gate-baseline.md`, never by the count.

**`test:desktop:electron:spec` does not build.** It runs `PACKAGED=1` against the last
`electron-builder` output, so after any source edit it tests a stale binary. Build and
repackage first, or use `yarn test:grep`, which rebuilds and runs from source.

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
  itself. Recorded in `docs/sync-coverage-gaps.md` section 8. The settings panel's
  live status line and log have no automated coverage at all for the same reason, and
  that one is not recorded anywhere else.
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
