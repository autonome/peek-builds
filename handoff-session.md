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

`main` is clean. Thirteen commits landed, `dcc1d28a` through `2c2507e9`.

**Sync coverage — items are complete, three tables remain.**

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

1. **Deploy the server.** The tombstone fix, the new item columns and the `/events`
   routes are all inert until the server has them. The live deployment is from
   2026-06-28 and predates every `/mcp/*` route — `POST /admin/mcp-grants` returns
   404 to a valid admin token. `yarn server:deploy` force-pushes a subtree to the
   GitHub `deploy/server` branch, which needs explicit authorization each time.

2. **Prove the credential reference against a real client.** Every remote-backend
   check so far expanded `${PEEK_SYNC_URL}` by hand. What is untested is whether
   Claude Code expands the *composite* reference `${PEEK_SYNC_URL}#<scope>` — a
   variable with a suffix — rather than only a bare `${VAR}`. If it does not, the
   credential lookup key never matches the stored file and remote mode fails for
   every real user, and no test on either side would catch it. Needs a real client
   restarted in a scaffolded directory.

3. **Sync the three remaining tables.** `tags` metadata (`slug`, `color`, `parentId`,
   `description`, `metadata`) — note there is no tag-row sync path at all today; tags
   travel as name strings inside the item payload and the server re-derives
   everything, so `parentId` needs an ordering rule or a hierarchy merge will
   clobber. Then `rules`, filtered to `source = 'user'` since manifest rules
   regenerate. `docs/sync-coverage-gaps.md` is the survey; its §1 and §6 are now
   stale.

4. **Resolve the divergent schema copies.** `apps/server/schema.json` is a stale
   hand-maintained copy of `packages/schema/v1.json` and it is load-bearing —
   `apps/server/db.js` reads it at startup and `validateSchema()` throws on a missing
   column, gating every `getConnection()`. Its `required_sync_columns` omits
   `item_events` entirely, so the server does not enforce what the canonical schema
   declares. A plain cross-package import will break the Railway deploy, because
   `scripts/deploy-server.sh` subtree-splits `apps/server/` alone — the copy has to
   be generated into `apps/server/` at build time.

5. **Decide the item-type validation split.** Creating an item with an unknown type
   succeeds locally and returns 400 remotely: `store/sqlite-store.js createItemSync()`
   validates nothing, `apps/server/mcp-items.js createItem()` enforces
   `CREATABLE_ITEM_TYPES`. Tightening the local store to match is the smaller change
   and makes a typo fail loudly; the `image` divergence is deliberate per design §9.

6. **Bootstrap the dispatch loop.** It cannot run until the Peek MCP is wired into
   this repo. No Peek datastore exists on this machine, so it must ride on the remote
   backend, which makes it downstream of steps 1 and 2.
   `.claude/skills/dispatch/operating.md` covers the loop wiring and the autonomy
   ladder.

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
- **`check-freshness.js` reports STALE on freshly generated files.** Its internal
  generator emits a `-- Generated: TIMESTAMP` line the real codegen never produces,
  and the strip regex leaves a blank line behind, so the hash never matches. It
  misfires on any regeneration, so that staleness gate cannot currently be trusted.

### How to verify

```
yarn server:test                                                    # 212
node --test apps/server/test-backup.js                              # 21
node --test apps/server/test-migration.js                           # 9
node --test packages/schema/fidelity.test.js                        # 43: 28 pass, 5 fail, 10 skip
node --test packages/sync/test.js                                   # 96
node --test packages/integration-tests/migration-regression.test.js # 6
npx tsc -p apps/desktop/tsconfig.json --noEmit                      # clean
yarn build && node --test apps/desktop/dist/main/sync.test.js       # 2
```

The five remaining fidelity failures are pre-existing and all Server/Electron: the
`rules` table has no server support, the `items.type` CHECK disagrees between
`v1.json` and the server, and three Electron/Server consistency gaps. Steps 3 and 4
close them.

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
  secret. Deploy is not a Railway CLI operation — it is a force-push to GitHub.
- `npm install --prefix apps/server` is still needed in a fresh worktree, now only
  for plain JS dependencies. It compiles nothing.
- `electron-builder` excludes `.worktrees` as of `e4974513`. Before that, packaging
  globbed into other worktrees and failed on a half-built one, so an unrelated
  initiative's working state could break any build here.
- The `sqlite3` CLI is not installed. Nothing depends on it.
