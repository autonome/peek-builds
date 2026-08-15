# Handoff — sync coverage, the node:sqlite conversion, and the MCP remote backend

Session-scoped. Covers work through 2026-08-15. Two other handoffs exist and are NOT
this one: `handoff.md` belongs to the window-manager initiative, and `handoff-mcp.md`
is the standing reference for the MCP remote backend design and its known gaps.

**`.worktrees/fsm-window-kernel` and `.worktrees/main-ab` belong to other initiatives.**
Nothing here touches them. Do not edit, rebase, or reclaim them.

## Resume Here

### Goal

Everything in the datastore must reach the server, so that losing a device loses
nothing. That decision is settled — the remaining work is carrying it through the
tables that still do not sync, and proving the remote backend against a real client.

### Current state

`main` is clean. `dcc1d28a` through `ba3a67c5`.

**Sync coverage — items, events and tags are complete; `rules` is deferred.**

Tag metadata (`slug`, `color`, `parentId`, `description`, `metadata`) syncs via `POST
/tags` and `GET /tags/since/:timestamp`. Tag identity on the wire is the **name**, not
an id, because the server already creates tag rows by name from item pushes and a
second identity would give one row two sources of truth. `parentId` therefore travels
as the parent's name. A pull merges in two passes — every tag first, parent links
second — so a parent arriving after its child still links, and a cycle is broken at the
most-recently-updated tag in it, deterministically on every device. Push uses its own
watermark (`feature_settings` key `lastTagPushAt`) that only advances when every tag in
the batch succeeded. Accepted gaps: renaming a tag creates a duplicate rather than
renaming, and tag deletion does not propagate.

**Every sync client is on `DATASTORE_VERSION` 3** — desktop, server, `packages/sync`
(the extension's engine, symlinked as `apps/extension/sync`) and `apps/mobile/peek-core`.
They had silently diverged: desktop and server moved to 2 while the other two stayed at
1, and `checkVersionHeaders()` 409s any client whose version is not an exact match, so
the extension and mobile were locked out of `/items` — and once the server ships 3, the
skew would have moved rather than closed. Raising the laggards is safe because every
newer column in `db.js saveItem()` binds through `COALESCE(?, existingColumn)` and
`POST /items` defaults absent fields to null, so a client that omits them preserves
what is stored. `packages/integration-tests/sync-version-compat.test.js` now imports
the real constants instead of restating literals, which is why it did not catch this.

**`apps/server/schema.json` is generated**, not hand-maintained — `packages/schema/codegen.js
generateServerSchema()` emits it from `v1.json` as a projection of the tables the server
actually has, and `check-freshness.js` covers it. It is checked in because the Railway upload
carries `apps/server/` alone (see `docs/server-backup-and-deploy.md`), so server code cannot
import from `packages/`. `check-freshness.js` itself was fixed — it compared against a second,
drifted copy of the generator and reported every freshly generated file as stale.

**An unknown item type now fails on the local MCP store.** `sqlite-store.js
createItemSync()` validates before writing. `image` stays accepted locally and refused
remotely, deliberately, per design §9.

Every `items` column now syncs: `title`, `domain`, `favicon`, `visitCount`,
`lastVisitAt`, `frecencyScore`, `mimeType`, `starred`, `archived`, and `deletedAt`.
`createdAt` is client-authoritative on INSERT so original creation dates survive;
`updatedAt` stays server-stamped because last-write-wins compares on it.
`item_events` syncs, so `series` and `feed` items restore with their observations
rather than as empty shells.

Three bugs fixed along the way, each of which lost data silently:

- **Desktop deletions never reached the server.** `sync.ts pushSingleItem()` sent
  `deleted_at`; `apps/server/index.js POST /items` read `deletedAt`. The route now
  dual-reads both spellings, so an older client in the wild starts deleting
  correctly on deploy.
- **`POST /items` discarded `title`, `domain` and `frecencyScore`**, hardcoding them
  to null even though the server columns existed and the schema asked for them.
- **Three separate event-stranding paths.** Details under "The event watermark".

**The `node:sqlite` conversion is finished.** `better-sqlite3` is absent from the
whole workspace. `scripts/check-native-modules.js` and the root `postinstall`
rebuild are deleted — there is no native module left to match against Electron's
ABI, so the mismatch that broke fresh worktrees cannot recur.

**The MCP remote backend is proven end to end**, 54/54 checks against a real socket:
credential resolution, header shape, real reads and writes, and tag scoping enforced
server-side rather than by the client. `.mcp.json` leaks no hostname. The text
`formatAmbiguous()` produces maps back byte-identically over HTTP.

**Tauri desktop is paused.** Its schema fidelity checks are skipped with a stated
reason rather than enforced. `apps/tauri-desktop/CLAUDE.md` records what to re-run
before unpausing. Its Rust column additions are kept, so resuming is cheaper.

**The server is deployed and live, twice over.** The live server reports
`datastore_version` 3: `/events` and `/tags` are live, and `checkVersionHeaders()`
no longer 409s desktop traffic. The migration added all five `tags` columns by
`ALTER TABLE` with no table rebuild, and the data came through intact — 11,121
items, 480 tags, 14,617 item-tag links.

Deploys are a manual `railway up` upload. The GitHub route is gone —
`scripts/deploy-server.sh` and the `server:deploy` script are deleted, because
this repository's remote is tangled and the GitHub push was rejected 403.
`docs/server-backup-and-deploy.md` carries the invocation, and the
`--path-as-root` flag is required or the CLI fails with `prefix not found`.

The server backup now covers real data. `apps/server/backup.js createBackup()`
enumerates every profile directory on disk (derived from `db.getProfileDir()`,
not a rebuilt path convention) and writes one per-user archive laid out as
`profiles/{profileId}/datastore.sqlite`, including each profile's `images/`.
`manifest.json` is version 2.0 and carries per-profile row counts, so an empty
backup is visible without unzipping. A failed profile no longer blocks the
others, `POST /backups` returns 500 instead of 200 on failure, and
`lastBackupTime` only advances on a fully clean run so a partial failure
retries rather than going quiet for 24 hours.

Verified against production rather than assumed: the archive went from 1.6 KB
covering one empty profile to 4.0 MB covering all eight, and downloading it,
unzipping it and opening the snapshot returns the same 11,121 items / 480 tags
/ 14,617 item-tag links as the live database.

### The event watermark — read this before touching event sync

Events borrow nothing from the item watermark. They have their own,
`feature_settings` key `lastEventPushAt`, because sharing the item one loses data
three ways:

1. An event whose parent item has no `syncId` yet is skipped, and a shared watermark
   advances past it — so a single failed item push stranded that item's entire
   history permanently.
2. An event created between the push query and the watermark write fell into the
   same hole. The watermark is therefore captured *before* the query and stepped
   back a millisecond: `Date.now()` is coarse enough for an event to land on the
   capture instant, and the comparison is strict.
3. `resetPerItemSyncState()` clears every `syncId` at once, then the same run
   re-populates many of them before the blocked-event scan runs — so the scan sees a
   healthy tree and rescues nothing. It now resets the event watermark too.

Cases 1 and 2 have tests that fail against the shared-watermark version. **Case 3 is
reasoned through and not test-covered.**

### Next steps

Ordered by consequence.

1. **Confirm event sync end to end.** The server is deployed and reports datastore
   version 3, so `/events` and `/tags` are live and `checkVersionHeaders()` no longer
   409s desktop traffic. The migration added all five `tags` columns by `ALTER TABLE`
   and the data came through intact — 11,121 items, 480 tags, 14,617 item-tag links.

   `item_events` on the server is still 0, because events have never had a route to
   reach it. The next desktop sync should push that history; verifying it actually
   lands is the cheapest proof that the whole chain works.

   A verified pre-deploy backup sits outside the repo under a `peek-backups` directory
   in the operator's home (`peek-prod-predeploy-20260815.tar.gz`, sha256 `bf6a05c8…`),
   holding consistent snapshots of all ten databases plus blobs. It was taken by hand
   before the server's own backup fix deployed, since restoring from either one still
   has no tested path — see step 4.

2. **Prove the credential reference against a real client.** Every remote-backend
   check so far expanded `${PEEK_SYNC_URL}` by hand. What is untested is whether
   Claude Code expands the *composite* reference `${PEEK_SYNC_URL}#<scope>` — a
   variable with a suffix — rather than only a bare `${VAR}`. If it does not, the
   credential lookup key never matches the stored file and remote mode fails for
   every real user, and no test on either side would catch it. Needs a real client
   restarted in a scaffolded directory.

3. **Run the full desktop Electron gate.** `yarn test:desktop:electron` has not been
   run this session. It pins the CPU for ten minutes and opens windows, so it needs
   explicit authorization. Nothing this session touched the overlay or window code
   that dominates its known failures, but that is reasoning rather than a run.
   Judging it means diffing the failing spec set against a baseline, not reading the
   count — the "The gate cannot go green on this machine" section under Reference
   explains why.

4. **Give the server a restore path.** Backups are now trustworthy and proven
   readable, but nothing restores them — no route, no script, and no test that puts
   an archive back. Restoring means placing `datastore.sqlite` onto the volume by
   hand. Until a test exercises backup-then-restore-then-verify, a backup is unproven
   as a recovery mechanism even though it is now proven as an archive.

5. **Sync `rules` — deferred until something can write a user rule.** Tag metadata now
   syncs. `rules` does not, and building it would be speculative: there are zero
   `source='user'` rows and no code path that creates one. `tile:rules:register` exists
   but hardcodes `source: 'runtime'`; there is no rule editor. All four existing rules
   are `source='manifest'` and regenerate, so they must not sync.

   Two constraints the rule editor has to satisfy before rule sync is possible:
   user-rule ids must be globally unique across devices, since the id is the only
   viable sync identity and manifest rules use a content hash that would collide by
   design; and rule deletion is a hard `DELETE` with no tombstone column, so sync would
   resurrect deleted rules until `rules` gains `deletedAt`. Separately, `scriptId`
   resolution fails silently — a synced rule naming a script the other device lacks
   never fires and logs nothing.

6. **Close the four remaining schema fidelity failures.** All four are the same gap:
   the canonical schema declares a `rules` table the server does not have, and the
   server's `items.type` CHECK omits `event`. Downstream of step 5.

7. **Bootstrap the dispatch loop.** It cannot run until the Peek MCP is wired into
   this repo. No Peek datastore exists on this machine, so it must ride on the remote
   backend, which makes it downstream of steps 1 and 2. `POST /admin/mcp-grants`
   previously 404'd because the live server predated those routes; the server is now
   current, so that is worth retrying. `.claude/skills/dispatch/operating.md` covers
   the loop wiring and the autonomy ladder.

### Known gaps carried forward

- **Deleting an event does not propagate.** `tile:datastore:delete-item-event` is a
  live IPC any tile can call; a deleted observation returns on the next pull.
  Propagating it needs a tombstone column that no schema declares.
- **Tauri desktop and mobile Rust do not compile on this machine** — both need
  GTK/glib development packages, and installing them needs privileges this
  environment does not grant. `apps/mobile/peek-core` does build and passes 107
  tests, so the substantive mobile logic is verified; `apps/mobile/src-tauri`'s push
  body and all of `apps/tauri-desktop`'s Rust are review-verified only.
- **Tauri desktop `Item.sync_source` has no backing column.** Every SELECT building
  an `Item` in `apps/tauri-desktop/src-tauri/src/datastore.rs` reads `row.get(6)`,
  which is `createdAt`, an INTEGER — a runtime type mismatch that also shifts every
  later column index. Predates this work. Whether to add a real column or delete the
  phantom field is a design call.
- **Tauri desktop never sends `createdAt`, `visitCount`, `lastVisitAt` or
  `mimeType`.** Those columns exist locally with no wire fields — present but dead.
- **The production backup has no restore path.** The path fault (`createBackup()`
  checking a location `migrateUserDataToProfiles()` renamed away at every startup)
  and the single-profile fault (backing up only `default`, an empty stub, while real
  content lives in UUID-named profiles) are both fixed and deployed. What remains:
  there is no restore code at all — no route, no script — and backups still live on
  the same Railway volume as the live database, with no download route and a
  7-deep retention purge, so they do not protect against volume loss.
  `docs/server-backup-and-deploy.md` has the detail.
- **The mobile and extension version bump is review-verified only.**
  `packages/sync/version.js` and `apps/mobile/peek-core/src/types.rs` were raised
  to `DATASTORE_VERSION` 3, with a matching test literal in
  `apps/mobile/peek-core/src/lib.rs`, but the mobile Rust does not compile on this
  machine, so that change has not been built or run. The extension side is plain
  JS, exercised by `packages/sync/test.js`.

### How to verify

```
yarn server:test                                                    # 225
node --test apps/server/test-backup.js                              # 29
node --test apps/server/test-migration.js                           # 9
node --test packages/schema/fidelity.test.js                        # 29 pass, 4 fail, 10 skip
node --test packages/sync/test.js                                   # 96
node --test packages/integration-tests/migration-regression.test.js # 6
node --test packages/integration-tests/sync-version-compat.test.js  # 16 assertions
node packages/schema/check-freshness.js                             # 6 files, all fresh
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js         # 743
npx tsc -p apps/desktop/tsconfig.json --noEmit                      # clean
yarn build && node --test apps/desktop/dist/main/sync.test.js       # 8
```

The four remaining fidelity failures are all one gap — the `rules` table has no server
support, and the server's `items.type` CHECK omits `event`. Step 6 closes them.

`yarn test:desktop:electron` is the full gate and needs an explicit go-ahead — it
pins the CPU for ten minutes and opens windows.

## Reference

### The gate cannot go green on this machine

Playwright Chromium is now installed, which fixed `components` (64) and `editor`
(91) — previously four failures and 151 tests that never ran. What remains:

- **Runner 3 fails 27–31 tests, varying between identical runs.** Clean `main` sits
  at the top of that range. The failing set is dominated by an overlay
  renderer-subscription race and by specs asserting macOS first-responder semantics
  that `apps/desktop/CLAUDE.md` itself calls unobservable off macOS. One spec fails
  for a missing `swift` helper binary.
- Judging a change against this gate means diffing the failing spec set against a
  baseline run, not reading the count. Counting alone reports a flake as a
  regression.

Current per-runner state: main-process unit 2629/2629, node unit 733/733,
desktop 400 pass / 30 fail, desktop-serial 39/1, components 64, editor 91.

### Decisions made during this session

- **`createdAt` is client-authoritative on INSERT; `updatedAt` stays
  server-stamped.** Preserving creation dates is what "lose nothing" means, while
  `updatedAt` is the key last-write-wins compares on — moving its authority would
  change conflict resolution.
- **Event sync needs no new schema column.** `required_sync_columns.item_events`
  declares no sync-tracking column, so adding one would ripple through every backend
  the fidelity test gates. Immutability plus idempotent push makes "created since the
  last successful push" sufficient.
- **A parked check is skipped, never stubbed green.** The mobile "KNOWN DRIFT" tests
  asserted `true` and checked nothing, which is why that backend sat seven required
  columns short without a test going red. Skips use the per-test form: `describe.skip`
  makes `node:test` drop subtests from the summary entirely, hiding them rather than
  showing them parked.
- **Adding synced columns requires a version bump.** The push query only selects rows
  where `syncedAt` is 0 or `updatedAt` exceeds `syncedAt`, so anything already synced
  keeps its old payload forever. `DATASTORE_VERSION` is at 2 and a profile that last
  synced under an older version runs the same reset a changed server URL triggers.
  Any future column addition needs the same treatment or the backup looks healthy
  while staying half empty.

### Environment notes

- The Railway CLI is installed and authenticated, and the repo is linked to project
  `amusing-courtesy`, service `peek-node`. Read-only commands need no confirmation;
  `railway variables` exposes `ADMIN_TOKEN` and `API_KEY`, so treat that output as
  secret. Deploy is a manual `railway up` upload, not a GitHub push — see
  `docs/server-backup-and-deploy.md`.
- `npm install --prefix apps/server` is still needed in a fresh worktree, now only
  for plain JS dependencies. It compiles nothing.
- `electron-builder` excludes `.worktrees` as of `e4974513`. Before that, packaging
  globbed into other worktrees and failed on a half-built one, so an unrelated
  initiative's working state could break any build here.
- The `sqlite3` CLI is not installed. Nothing depends on it.
