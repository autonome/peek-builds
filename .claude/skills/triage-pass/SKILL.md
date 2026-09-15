---
name: triage-pass
description: Groom the Peek intake and triage queue into dispatchable work — propose scope, a done-condition and a verify command per item, promote only what is unambiguous, and digest the rest for a human. Use when running the triage loop, when the dispatch queue is starving, or when asked to groom the backlog.
---

# /triage-pass — turn intake into dispatchable work

The dispatcher can only claim items that are `peek:todo` + `peek:ready` **and**
carry a done-condition and a verify command. Producing those is this pass, and
it is the loop's actual bottleneck: a starved queue looks exactly like a broken
dispatcher.

**Read-only against the repo. Writes only to Peek.** No edits, no commits, no
worktrees, no spawning. Repo access exists so a verify command can be written
from the real test scripts rather than guessed. Reading happens in the primary
checkout, which holds `main` and stays clean — this pass never needs a worktree.

**Prerequisite:** the Peek MCP is not wired into this repo yet (no `.mcp.json`),
so `mcp__peek__*` is absent and this pass cannot run. Wire it with
`peek-mcp-init peek --writes` from the repo root, then restart Claude Code
fully — see `dispatch/operating.md`. Tools missing → say so and stop; never
substitute a local file queue.

The tag model, the quality markers and the `peek:ready` contract are owned by
the `peek` skill. This pass applies them; it does not redefine them.

## Input

```js
mcp__peek__list_items({ tags: ['peek'] })                      // intake — membership tag only
mcp__peek__list_items({ tags: ['peek:todo', 'peek:triage'] })  // scoped but not yet dispatchable
```

Skip anything tagged `peek:wip`, `peek:needs-review`, `peek:hold`,
`peek:future` or `peek:wontfix`.

## Per item

1. **Deduplicate first.** `search_items({ query: '<keywords>' })` before
   touching anything. A duplicate gets `peek:wontfix` and a `record_event`
   naming the surviving item's id.
2. **Scope it.** Add the `peek:scope:*` tag that matches the apps it touches.
   Unsure → leave it off; an unscoped item is a human's job, and a wrong scope
   sends an agent into the wrong tree.
3. **Topic tags.** `list_tags({ search: 'peek:' })` before inventing one. Reuse
   beats coining — this repo already carries three tags for "tests" because
   nobody looked.
4. **Write the two sections** into the item body, appended, never replacing
   what is there:

   ```markdown
   ## Done looks like
   <observable end state — what is true afterward that is not true now>

   ## Verify
   <a command that actually exists in package.json, plus what its passing
   output looks like>
   ```

   The verify command must be real. `yarn test:desktop:electron` is the full
   gate; narrower work usually wants `yarn test:desktop:electron:grep` with a
   pattern, `yarn workspace @peek/desktop test:unit`, or `yarn test:extension`.
   A command that does not exist is worse than no command: it sends an agent to
   fabricate its own acceptance criteria.

   Exception: for a mobile UI change (`apps/mobile`), Verify may instead be a
   manual check on a phone — Android or iOS — naming the device, the exact
   steps, and what the screen shows when it passes. "No automated check
   exists" alone is no longer a reason to hold a mobile UI item in
   `peek:triage`.

5. **Promote, or don't.**
   - Both sections written with confidence, and scope known →
     `peek:todo` + `peek:ready`, clearing `peek:triage`.
   - Anything ambiguous — a vague ask, an unknown scope, a done-condition that
     needed guessing — stays `peek:triage` and goes into the digest. This is
     the important half of the rule. An unattended pass inventing acceptance
     criteria produces work nobody asked for, which is more expensive than a
     backlog item sitting one more day.

## Output: one digest, not a report per item

Append to the `META:`-prefixed `peek:starred` tracking item, so "what should I
work on" stays a single query:

- **Promoted** — one line each: id prefix, title, scope.
- **Needs a decision** — one line each: id prefix, title, and *the specific
  question* blocking it. Not "needs scoping" — the actual fork, in words that
  make sense without opening the item.
- **Closed as duplicate** — id prefix and the survivor's id.
- **Queue depth** — how many dispatchable items remain, per scope. This is the
  number that predicts whether the dispatcher starves before the next pass.

Don't echo item bodies back into chat. The digest is the report.

## Cadence and pressure

Runs on a slow loop (see `dispatch/operating.md`). When queue depth in an
active scope drops below roughly two dispatchable items, that scope's intake is
the priority for the next pass — depth in a scope nobody is working is not
worth deepening.

Greenfield design work is the cheapest thing to make dispatchable: the output
is a document, there is nothing to merge, and the verify command is a human
reading it. Those items still need a done-condition, but the bar for promoting
them is lower than for code.
