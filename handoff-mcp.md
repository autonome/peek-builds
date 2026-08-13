# MCP remote backend — phase 1

## Work only in this worktree

This file lives in `.worktrees/mcp-phase1/`. Every edit, every command, every commit
belongs here.

- **Never edit `/home/dev/workspace/peek` itself.** The primary checkout holds `main`
  and stays clean; it is where merges happen, not where work happens.
- **Never edit any other `.worktrees/*` directory.** `.worktrees/fsm-window-kernel`
  has another agent working in it on `wip/window-kernel-executor`. Touching it
  corrupts someone else's in-flight work.
- **Never `git checkout` another branch here.** This worktree is pinned to
  `agent/mcp-phase1`.
- **Do not merge, do not push, do not run `git worktree add`.** Commit on
  `agent/mcp-phase1` and stop. Landing is a separate reviewed step.
- Run every command with this directory as the working directory, or pass
  `-C /home/dev/workspace/peek/.worktrees/mcp-phase1` explicitly. A bare `yarn …`
  from the wrong cwd runs against the primary checkout.
- `yarn install` here before running anything — a worktree is its own checkout and
  its resolution state does not arrive with the files.

Note also `handoff.md` in the primary checkout belongs to the other initiative. This
file — `handoff-mcp.md` — is the only one for this work.

---

## Resume Here

### Goal

Give the Peek MCP server a remote data backend, so an agent or client with no local
Peek install reads and writes the same item/tag/event store a local session sees.
This unblocks running the dispatch loop somewhere other than one laptop.

### Current state

Design is done, reviewed, and landed on `main` as `docs/mcp-remote-backend-design.md`.
It is the specification for this work — read it before writing code. No implementation
exists yet; this worktree is empty of changes.

The design's own summary: keep the stdio child owning the MCP protocol, put a
`PeekStore` interface where `apps/desktop/features/mcp-server/db.js` sits, and add a
scoped `/mcp/*` API to `apps/server`. Serving MCP over HTTP directly is phase 2 and is
not in scope here.

A related survey, `docs/sync-coverage-gaps.md`, records what the sync engine does not
carry between devices. **It is deliberately out of scope for this work.** Nothing in
phase 1 changes a `"sync": false` decision. If a step here seems to require one, that
is a signal to stop and report, not to widen the change.

### Next steps

Each is a separate commit, reviewable on its own, in this order. Do one, verify it,
then take the next.

1. **Server columns** — `docs/mcp-remote-backend-design.md` §3.1, storage half only.
   Add `title`, `domain`, `frecencyScore`, `starred`, `archived` to the `items` table
   in `apps/server/db.js initializeSchema()` via the additive `ALTER TABLE … ADD COLUMN`
   guard already used there for `syncId`/`createdByDevice`; carry them through
   `saveItem()`, `getItems()`, `getItemsSince()`, `getItemById()`; mirror the shape into
   `apps/server/schema.json`. Do not touch `apps/desktop/main/sync.ts` — see §3.1's sync
   half for why.

2. **The store seam** — §2.1. New `apps/desktop/features/mcp-server/store/` holding
   `types.js` (the `PeekStore` typedef, no runtime code, modelled on
   `apps/server/sql/types.js`), `sqlite-store.js` (the existing `db.js` body with every
   method `async`), and `index.js` (`openStore()`, modelled on the `SQL_ADAPTER` switch in
   `apps/server/sql/index.js`). Behaviour must not change; `server.test.js` is the proof.

3. **Async dispatch** — §2.2. `handleToolCall()`, `handleResourceRead()` and
   `handleMessage()` in `server.js` become async, with the `rl.on('line')` handler
   serializing through a tail promise so requests stay strictly in arrival order.
   `checkConfigDrift()` stays at the head of the line handler.

4. **Grants and the `/mcp/*` auth middleware** — §4.1. The `mcp_grants` table in
   `system.db`, the three `ADMIN_TOKEN`-gated admin routes, and the middleware that
   resolves a bearer token into `scopeTag` / `readonly` / `userId` / `profileId`. Model on
   `apps/server/users.js` `createDevice()` / `resolveDevice()` and
   `apps/server/auth.js createAuthMiddleware()`. A device key must not work on `/mcp/*`
   and a grant key must not work on the sync routes.

5. **The `/mcp/*` routes** — §3.3, thirteen endpoints. Scope enforcement is a `WHERE`
   clause on every query, never a post-filter, so `LIMIT`/`OFFSET` count in-scope rows
   only. `POST /mcp/tasks/:id/complete` must stay one transaction, matching
   `db.js completeTask()`.

6. **`remote-store.js`** — §2.1 and §5. HTTP client against those routes, plus the
   unexpanded-`${VAR}` startup guard from §6 and the hard-failure behaviour from §7.1.
   No offline cache, no write queue — a network failure is a tool error naming the
   unreachable server.

7. **`peek-mcp-init --remote`** — §8. `buildEnv()` branches, `findDbPath()` is skipped,
   credentials resolve through an environment reference or the `0600` credential file,
   and no token, hostname, or account id is ever written into a project.

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
