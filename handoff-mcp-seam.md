# MCP remote backend — the store seam and async dispatch

Steps 2 and 3 of `docs/mcp-remote-backend-design.md` phase 1, split into their own
worktree so they can run alongside the server-side column work.

## Work only in this worktree

This file lives in `.worktrees/mcp-seam/`. Every edit, every command, every commit
belongs here.

- **Never edit `/home/dev/workspace/peek` itself.** The primary checkout holds `main`
  and stays clean; it is where merges happen, not where work happens.
- **Never edit any other `.worktrees/*` directory.** Two other agents are working in
  parallel right now: `.worktrees/fsm-window-kernel` on an unrelated initiative, and
  `.worktrees/mcp-phase1` on step 1 of this same design. Touching either corrupts
  in-flight work.
- **Never `git checkout` another branch here.** This worktree is pinned to
  `agent/mcp-seam`.
- **Do not merge, do not push, do not run `git worktree add`.** Commit on
  `agent/mcp-seam` and stop.
- Run every command with this directory as the working directory, or pass
  `-C /home/dev/workspace/peek/.worktrees/mcp-seam` explicitly.
- `yarn install` here before running anything.

## Scope: steps 2 and 3, as one unit

These are one refactor and land together. Step 2 alone would add an interface nothing
calls; step 3 alone has nothing to await.

**Files in scope: `apps/desktop/features/mcp-server/` only.** The parallel agent owns
`apps/server/db.js` and `apps/server/schema.json` — do not edit either, and do not edit
`apps/desktop/main/sync.ts` or `packages/schema/v1.json`.

### The seam — design section 2.1

A new `apps/desktop/features/mcp-server/store/` directory:

- `types.js` — the `PeekStore` typedef and its companion typedefs, JSDoc only with no
  runtime code, modelled on `apps/server/sql/types.js`.
- `sqlite-store.js` — the existing `db.js` body, every method `async` around unchanged
  synchronous work.
- `index.js` — `openStore(config)`, selecting an implementation from the environment,
  modelled on the `SQL_ADAPTER` switch in `apps/server/sql/index.js`.

`server.js` calls the store rather than importing `db.js` directly. Two signature
changes the design specifies: `resolveItemId(prefix)` loses its `{scopeTag}` option and
the store captures the scope at `openStore()` time, and a new `describe()` reports what
the store believes about itself.

No `remote-store.js` in this work — that is a later step.

### Async dispatch — design section 2.2

`handleToolCall()`, `handleResourceRead()` and `handleMessage()` become async. The
`rl.on('line')` handler serializes through a tail promise so requests stay strictly in
arrival order; the design gives the exact shape. `checkConfigDrift()` stays at the head
of the line handler.

## How to verify

```
node --test apps/desktop/features/mcp-server/server.test.js
node --test apps/desktop/features/mcp-server/schema-drift.test.js
```

**Both must pass with no edits to the test files.** This is a refactor with no intended
behaviour change, so a test that needs changing to pass means the refactor changed
something it should not have. Report the numeric pass count from a run actually executed.

`yarn test:desktop:electron` is not to be run — it needs the user's explicit go-ahead.

## Reporting

Commit on `agent/mcp-seam` and report the files changed, the real output of both test
commands, and anything left unverified. Do not merge, do not push, do not mark anything
done.
