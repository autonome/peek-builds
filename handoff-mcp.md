# MCP remote backend — phase 1

## Phase 1 is complete and landed on `main`

This file now records what exists, what is unproven, and what comes next. It is no
longer a worktree brief — the seven implementation steps it used to list are all on
`main`, and the worktrees they ran in are gone.

Any further work still gets its own worktree under `.worktrees/`, based on `main`,
per `~/.claude/docs/worktrees.md`. `.worktrees/fsm-window-kernel` belongs to an
unrelated initiative; `handoff.md` in the repo root is that initiative's file, not
this one.

---

## Resume Here

### Goal

Give the Peek MCP server a remote data backend, so an agent or client with no local
Peek install reads and writes the same item/tag/event store a local session sees.
This unblocks running the dispatch loop somewhere other than one laptop.

### Current state

Phase 1 of `docs/mcp-remote-backend-design.md` is implemented and on `main`: the store
interface and its two implementations, the thirteen `/mcp/*` endpoints, the grant
credential and its middleware, remote-mode scaffolding, and the wiring that makes
`main()` in `server.js` select a backend from the environment.

Test counts as landed, each from a run in the primary checkout:

| Command | Count |
|---|---|
| `yarn server:test` | 202 |
| `node --test apps/desktop/features/mcp-server/server.test.js` | 109 |
| `node --test apps/desktop/features/mcp-server/store/remote-store.test.js` | 30 |
| `node --test apps/desktop/features/mcp-server/setup.test.js` | 23 |
| `node --test apps/desktop/features/mcp-server/schema-drift.test.js` | 43 |

**The two halves have now talked to each other over a real socket, and they agree.**
Every unit test still stubs one side — the server tests exercise the routes through a
mirror app, and the remote store's tests stub `fetch` — so the end-to-end evidence comes
from `tools/socket-proof.mjs` and `tools/socket-proof-ambiguous.mjs`, which drive
`openRemoteStore()` against the live deployment. All twenty-one steps of the first and
both branches of the second passed on the first run, with no change required to either
half.

What that covers: `describe`, the list and search reads against both an empty and a
populated scope, `createItem`, `getItem`, `getItemTags`, `updateItem`, `tagItem`,
`untagItem`, `recordEvent`, `getTaskContext`, `resolveItemId` for a miss, a full-id hit
and an ambiguous prefix, and `deleteItem`. The ambiguity payload comes back in the shape
`resolveItemIdSync()` in `store/sqlite-store.js` defines — `{ id, ambiguous, candidates,
truncated }` — and `getItem()` turns it into the same text `formatAmbiguous()` produces,
which is the one place a non-200 has to become a value-bearing error.

A readonly grant is enforced, not merely reported. Running the same harness against a
grant minted with `readonly: true` refuses all six mutating routes with HTTP 403 and
leaves every read working; `tools/socket-proof.mjs` inverts its expectation for write
steps when `PEEK_MCP_EXPECT_READONLY` is set, so a readonly run that quietly succeeded at
writing fails rather than reading as green.

**The scaffolded path found the one real defect, in `entryEnvMatchesCurrent()`.** For a
remote install, `setup.js` writes `PEEK_MCP_REMOTE_URL` and `PEEK_MCP_CREDENTIAL` as
`${PEEK_SYNC_URL}` reference text, which the client expands before spawning the server.
The drift check compared that reference text against the expanded value, so it never
matched: a correctly scaffolded remote project failed the check on every spawn and exited,
and the client respawning produced the same result again. The diagnostic hid the cause by
printing only the scope, readonly and database-path fields, none of which differ, so it
showed two identical lines and called them a mismatch.

An on-disk value in `${...}` form now matches anything, because there is no on-disk value
to have drifted, while a literal still has to match exactly; the message prints the fields
the comparison actually used. Every existing test for this function used literal values,
which is why it survived — the two added cases use the reference form real installs write.
With the fix, `tools/socket-proof-scaffolded.mjs` drives a scaffolded child through
`initialize`, `tools/list`, and a create/list/delete round trip against the live server.

A related survey, `docs/sync-coverage-gaps.md`, records what the sync engine does not
carry between devices. **It is deliberately out of scope for this work.** Nothing in
phase 1 changes a `"sync": false` decision. If a step here seems to require one, that
is a signal to stop and report, not to widen the change.

### Next steps

The end-to-end run is done — see above. What it leaves open, and then the rest in no
particular order:

- **Redeploy before trusting the scaffolded path in practice.** The
  `entryEnvMatchesCurrent()` fix is in this repository, and the running deployment does
  not carry it. That does not affect the deployment (the drift check runs in the local
  MCP child, not on the server), but any project scaffolded from an older checkout still
  exits on every spawn.

- **Make `apps/server/index.js` testable** — guard the listener with
  `require.main === module` and export the app, so routes can be tested through the real
  file rather than a mirror. Rationale and what it nearly cost are under Known gaps.
- **Phase 2, MCP over HTTP from `apps/server`** — design §1. A `POST /mcp/rpc` route
  reusing the same dispatch, with the grant as bearer. This is what reaches a phone or a
  cloud agent with no local process, and it was deliberately sequenced after phase 1
  because phase 1 built everything it needs.
- **Settle the open questions in §10** — whether `title` and `domain` sync between
  devices, and whether the `LIKE` pre-filter holds at server scale. The first is
  entangled with `docs/sync-coverage-gaps.md`; the second wants a measurement against a
  real profile before phase 2 adds concurrent callers.

### Known gaps, carried forward

- **`apps/server/index.js` route wiring is not directly tested.** Requiring it starts a
  listening HTTP server as a side effect, so every test in `apps/server/test.js` — the
  pre-existing device and admin ones as well as the new MCP ones — wires a mirror Hono app
  around the real middleware and the real handler functions. Business logic and auth are
  covered for real; the glue in `index.js` (query-param extraction, status-code
  translation, route registration order) is duplicated rather than exercised.

  One consequence is live now: `GET /mcp/items/search` and `GET /mcp/items/resolve` must
  stay registered *before* `GET /mcp/items/:idOrPrefix`, or the parameter route swallows
  them and both silently resolve an item whose prefix is the literal word. The order is
  correct as landed and nothing tests it.

  The fix is to stop starting the listener on require — guard it with
  `require.main === module` and export the app — after which routes can be tested through
  the real `index.js`. That touches how the server boots under Railway, so it is its own
  reviewed change, not a rider on a feature step.

- **`getItem()` and `getTaskContext()` in `sqlite-store.js` now resolve an id prefix
  themselves.** They previously took a resolved id, because `server.js` resolved first
  and called the store second. Collapsing the read path to one round trip moved that
  resolution into both store implementations, so the local backend's behaviour at the
  store layer changed even though the tool-level behaviour did not. Anything calling
  these directly should expect a prefix to work and an ambiguous one to throw.

- **`main()` in `server.js` only self-invokes when the file is run directly**, guarded
  on `import.meta.url`, so its pure functions can be tested without spawning a
  subprocess. The 109 tests in `server.test.js` spawn the real server as a child
  process, which is what proves the guard did not break the spawn path.

- **`saveItem()` in `apps/server/db.js` takes fourteen positional parameters.** The MCP
  create route does not call it (an explicit create is always a create, per the design's
  section 3.3), so nothing is blocked; it is a cleanup worth doing before the next caller
  arrives.

### Key files and symbols

- `docs/mcp-remote-backend-design.md` — the spec. Section numbers above are its.
- `apps/desktop/features/mcp-server/server.js` — tool table `TOOLS`, dispatch
  `handleToolCall()`, scope helpers `inScope()` / `withScopeTag()` /
  `validateWriteTags()` / `assertItemInScope()`, `shapeItemForResponse()`,
  `formatAmbiguous()`, `resolveItemIdForMutation()`, `checkConfigDrift()`.
- `apps/desktop/features/mcp-server/db.js` — the fifteen exports that become the
  `PeekStore` interface. `resolveItemId()` is the prefix resolver whose `{scopeTag}`
  option is deliberately dropped (§2.1); `tagItemInTx()` is the tag-write policy the
  server must reproduce; `SEARCH_WEIGHTS`, `SNIPPET_RADIUS`, `buildSnippet()` are the
  ranking that moves server-side.
- `apps/server/db.js` — `initializeSchema()`, `saveItem()`, `getItemById()`,
  `getOrCreateTagWithConn()`. Note `saveItem()` mints its own id and stores the desktop
  id in `syncId`; the id-namespace consequence is §5's last subsection.
- `apps/server/users.js`, `apps/server/auth.js` — the credential model to copy.
- `apps/server/sql/types.js`, `apps/server/sql/index.js` — the typedef-plus-factory shape
  the store seam mirrors.

### How to verify

```
node --test apps/desktop/features/mcp-server/server.test.js
node --test apps/desktop/features/mcp-server/schema-drift.test.js
yarn server:test
```

The first is the gate for steps 2 and 3 — it must stay green with no test edits, because
those steps are a refactor. `yarn server:test` covers steps 1, 4 and 5.

**Do not run `yarn test:desktop:electron`** without asking first. It pins the CPU for ten
minutes and opens windows over whatever the user is doing; `apps/desktop/CLAUDE.md` makes
asking mandatory.

---

## Reference

### Gotchas

- **Never run `npm rebuild better-sqlite3` at the repo root.** The root copy is built for
  Electron's ABI; the server runs under system Node. Give the server its own copy with
  `npm install --prefix apps/server`. Rebuilding at the root breaks every desktop test.
  Full account in `apps/server/CLAUDE.md`.
- `apps/server/schema.json` is a stale duplicate of `packages/schema/v1.json`. Changing one
  and not the other is how they diverged; step 1 touches the server copy.
- `title`, `domain` and `frecencyScore` are `"sync": false` by decision, not oversight.
  Adding server columns does not change that, and phase 1 must not.
- Secrets and identifying values never enter a project file. Credentials resolve through an
  environment reference or a `0600` file outside the repo; documentation uses placeholders.

### Reporting

Commit on `agent/mcp-phase1` and report what changed, the actual output of the verify
commands, and anything left unverified. Do not merge, do not push, do not mark anything
done — landing and approval happen outside this worktree.
