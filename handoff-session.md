# Handoff — parallel agent loop, MCP remote backend, and the sqlite cleanup it exposed

Session-scoped. Covers work done 2026-08-13 through 2026-08-15 and what is left of
it. Two other handoffs exist and are NOT this one: `handoff.md` belongs to the
window-manager initiative, and `handoff-mcp.md` is the standing reference for the
MCP remote backend design and its known gaps.

**`.worktrees/fsm-window-kernel` belongs to another agent's initiative.** Nothing in
this handoff touches it. Do not edit, rebase, or reclaim it.

## Resume Here

### Goal

Two threads that turned out to be one. First, a way to run several initiatives at
once without a human prompting each step — worktree-isolated agents claiming work
from a queue. Second, the remote Peek MCP backend that lets that queue be reached
from somewhere other than one laptop. Pursuing the second surfaced a set of data
integrity problems that are now the largest open item.

### Current state

All of the following is landed on `main`, which is clean:

- **The dispatch machinery** — `.claude/skills/dispatch/SKILL.md`, its
  `operating.md`, and `.claude/skills/triage-pass/SKILL.md`. `peek.md` gained the
  `peek:ready` contract: an item is only dispatchable with a `## Done looks like`
  and a runnable `## Verify` in its body.
- **MCP remote backend, phase 1** — the store interface and its SQLite and HTTP
  implementations, thirteen `/mcp/*` endpoints, the `mcp_grants` credential and its
  middleware, remote-mode `peek-mcp-init`, and the wiring that lets `main()` in
  `server.js` select a backend from the environment. Details and the design's own
  open questions are in `handoff-mcp.md`; the spec is
  `docs/mcp-remote-backend-design.md`.
- **`apps/server` runs on `node:sqlite`** — `better-sqlite3` is gone from that app,
  and with it the ABI mismatch that made every fresh worktree fail until
  `npm install --prefix apps/server` ran.
- **A backup bug fix**, buried in the same commit as that conversion (`0c717ce5`).
  See "The backup bug" below — it is the most consequential thing in this session.

**Neither of the two headline features has been proven end to end.** The dispatch
loop has never run, because the Peek MCP is not wired into this repo. The remote
backend's two halves have never talked over a real socket — every test stubs one
side.

### The backup bug — read this first

`createBackup()` in `apps/server/backup.js` was checking
`DATA_DIR/{userId}/peek.db`, the pre-multi-profile path that `index.js`'s own
one-time migration moves data *away from*. For every migrated user it found no
database, logged "skipping backup", and returned. Server-side backups were silently
not happening.

It is fixed — the path now comes from `getProfileDir()` in `apps/server/db.js` — and
`test-backup.js` passes at 21. Two things follow:

- **The fix rides inside a refactor commit.** `0c717ce5` is titled as the
  `node:sqlite` conversion. Splitting it is optional archaeology, not required work.
- **`test-backup.js` already covered this.** It could not run, because the ABI
  mismatch broke the suite before it got there. The bug was visible to a test nobody
  could execute. That is the argument for finishing the `node:sqlite` conversion
  rather than leaving it half done.

### Next steps

Ordered by consequence, not by size.

1. **Decide what the sync engine carries.** `docs/sync-coverage-gaps.md` is the
   survey: a server restore returns items, tags and tag frecency, and returns
   nothing else. Titles, domains, visit history, every item event, tag hierarchy and
   user-authored rules are local-only. `item_events` is the sharpest — every column
   is declared `"sync": true` and `apps/desktop/main/sync.ts` never touches it, so
   `series` and `feed` items restore as empty shells. Each gap in that document names
   what would settle it. `apps/desktop/main/datastore.ts` is the policy owner.

2. **Fix `test-migration.js` Scenario 2.** It asserts an orphaned `syncSource` column
   survives migration, but its fixture also carries the old four-value `type` CHECK,
   and `hasStaleTypeCheck` in `apps/server/db.js` force-rebuilds on exactly that,
   dropping the column. Driver-independent — the premise was already false before the
   conversion. Needs either a fixture without the stale CHECK or a corrected
   expectation. Currently 8 of 9 pass.

3. **Finish the `node:sqlite` conversion.** Two remaining groups, each its own
   change:
   - `packages/sync/{index.js,test.js,adapters/better-sqlite3.js}`,
     `packages/integration-tests/{sync-version-compat,migration-regression}.test.js`,
     and `scripts/{preconfigure-sync.mjs,check-r2-window-ops.mjs,test-sync-desktop.sh}`.
     These have their own fast suites and suit an unattended agent.
   - `apps/desktop/main` — fifteen files including `datastore.ts`, `profiles.ts`,
     `manifest-cache.ts`, `session.ts`, `entry.ts`, and six test files. **This one
     cannot be verified unattended**: its tests live in runner 1 of
     `yarn test:desktop:electron`, which needs an explicit go-ahead before running.
     Once it lands, `scripts/check-native-modules.js` and the root `postinstall`
     rebuild both become deletable.

4. **Prove the MCP remote backend end to end.** Deploy the server, mint a grant via
   `POST /admin/mcp-grants`, scaffold a throwaway project with
   `peek-mcp-init --remote <url> --store-token`, restart, and confirm a scoped
   session reads and writes. Expect the first failure in the seam nothing tested:
   credential resolution, header shape, or an error body that does not map back to
   the text `formatAmbiguous()` produces.

5. **Bootstrap the dispatch loop.** It cannot run until the Peek MCP is wired here —
   `peek-mcp-init peek --writes` from the repo root, then a full restart. After that,
   `dispatch/operating.md` describes the two `/loop` invocations and the autonomy
   ladder. Start at level one, where the loop spawns and a human approves every
   landing.

6. **Make `apps/server/index.js` testable** — guard the listener with
   `require.main === module` and export the app. Today every test wires a mirror app,
   so route registration order is untested; `handoff-mcp.md` records what that nearly
   cost.

### Key files and symbols

- `docs/sync-coverage-gaps.md` — the local-only inventory. Step 1 lives here.
- `docs/mcp-remote-backend-design.md` — the remote backend spec, sections numbered;
  section 10 holds its open questions.
- `handoff-mcp.md` — MCP phase-1 state, test counts, and known gaps including the
  `saveItem()` fourteen-positional-parameter cleanup.
- `apps/server/backup.js` `createBackup()` — the fixed path; `apps/server/db.js`
  `getProfileDir()` is the convention it now follows.
- `apps/server/db.js` `hasStaleTypeCheck` — why step 2's fixture fails.
- `apps/server/sql/node-sqlite-adapter.js` — the conversion's shape, and the model
  for step 3. Its `transaction()` is an explicit BEGIN/COMMIT/ROLLBACK wrapper; no
  call path nests, so savepoints were not needed. Re-check that before reusing it
  elsewhere.
- `.claude/skills/dispatch/SKILL.md` — the tick. `operating.md` beside it covers the
  loop wiring and failure modes, including a permission prompt with nobody there to
  answer it.

### How to verify

```
yarn server:test                                                    # 202
node --test apps/server/test-backup.js                              # 21
node --test apps/server/test-migration.js                           # 8 of 9, see step 2
node --test apps/desktop/features/mcp-server/server.test.js         # 109
node --test apps/desktop/features/mcp-server/store/remote-store.test.js   # 30
node --test apps/desktop/features/mcp-server/setup.test.js          # 23
node --test apps/desktop/features/mcp-server/schema-drift.test.js   # 43
```

`yarn test:desktop:electron` is the full gate and needs an explicit go-ahead before
it runs — it pins the CPU for ten minutes and opens windows. Nothing above requires
it; step 3's desktop half does.

## Reference

### Decisions made during this session

- **`tags.slug` is not written server-side, and server tag frecency matches the
  desktop's.** `packages/schema/v1.json` marks `slug` `"sync": false` and describes
  it desktop-only, while `frecencyScore` is `"sync": true`. This settled one of the
  design's open questions from the schema rather than by preference.
- **The MCP API stores `title`, `domain` and `frecencyScore` server-side without
  changing what sync carries.** Adding the columns is storage; whether
  `sync.ts` sends them is the separate policy question in step 1.
- **`.mcp.json` never contains a server host.** It carries `${PEEK_SYNC_URL}` and a
  credential lookup key. The design's section 6 lists hostname among what must never
  enter a project file.

### Environment notes

- Permissions were added to `.claude/settings.local.json` (gitignored) for writes
  under `/tmp` and `~/.config/peek`, and for `git worktree add` / `remove`. An agent
  that trips a permission prompt with nobody watching waits indefinitely rather than
  failing — it looks exactly like an agent that is thinking.
- `npm install --prefix apps/server` is still needed on a fresh worktree, now only
  for plain JS dependencies. It no longer compiles anything, and no longer risks the
  ABI mismatch.
- The `sqlite3` CLI is not installed on this machine. Nothing depends on it any more:
  `server.test.js` was converted to `node:sqlite` for exactly that reason.
