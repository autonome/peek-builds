---
name: dispatch
description: One tick of the automated work loop — reconcile running worktree agents, then claim and spawn at most one new dispatchable task from the Peek queue. Use when running the dispatch loop, when asked to pick up queued work without interactive prompting, or before hand-spawning a background agent against a peek:todo item.
---

# /dispatch — one tick of the work loop

Turns the actionable Peek queue into running background agents, one git
worktree each, without an interactive prompt per spawn. A tick is:
**reconcile in-flight → claim one → spawn one → stop.**

Stateless by construction. Everything a tick needs is readable at tick time —
`git worktree list` for slots, Peek tags for claim state, `ListAgents` for
liveness, `handoff.md` inside each worktree for what that initiative is mid-way
through. There is no dispatcher state file to corrupt, and a tick that dies
halfway leaves no wreckage a later tick can't read.

Rules owned elsewhere — follow the pointer, don't restate:

| Concern | Owner |
|---|---|
| Worktree layout, base-on-`main`, install-inside | `~/.claude/docs/worktrees.md` |
| Tag model, dispatchable contract | `peek` skill |
| Reviewer choice, reviewer brief, failure modes | `agent-review` skill |
| Agent liveness, brief sizing, routing | `~/.claude/docs/subagents.md` |
| Loop wiring, kill switch, known failure modes | `operating.md` beside this file |

The `agent-review` skill's *judgment* half is current; its finalize and
clone-pool commands describe retired machinery. Landing steps below supersede
them.

## Prerequisite: the Peek MCP must be wired into this repo

The queue lives in Peek, reached through `mcp__peek__*`. This repo has no
`.mcp.json`, so those tools are absent and every tick is a no-op until it is
wired, from the repo root:

```
/Applications/Peek.app/Contents/Resources/peek-mcp-init peek --writes
```

Then fully quit and reopen Claude Code here — the MCP server is a child process
whose env is frozen at spawn, and re-approving the `/mcp` prompt does not
respawn it. See the `peek-mcp-scope` skill.

Tools missing → report that and end the tick. Do not substitute a local file
queue, a built-in todo list, or a guess at what the queue contains.

## Where work happens

The **primary checkout holds `main`, stays clean, and is never a work slot.**
It is where merges and the test gate run. Every unit of work gets its own
worktree under `.worktrees/<slot>` on its own `agent/<slot>` branch. No agent —
dispatched or hand-spawned — edits the primary checkout.

## Rails

- **No code edits in a tick.** A dispatcher that starts writing code stops
  dispatching.
- **At most one spawn per tick.** Without this a loop fills the pool inside an
  hour and the failure is discovered at rate-limit time.
- **Cap: 4 task worktrees.** The real ceiling is lower anyway —
  `yarn test:desktop:electron` runs ~10 minutes in the primary checkout and
  landings serialize behind it.
- **`/tmp/mpeek-dispatch-off` exists → the tick is a no-op.** Report nothing,
  end.
- **`peek:hold` on an item makes it invisible to claiming.** Per-item pause.
- **Never land in the same tick that spawned.** Landing runs `git merge` and a
  ten-minute suite; mixing it with a spawn makes a stalled tick ambiguous.
- **Never push.** Publishing `main` is a separate, per-request authorization.

## 1. Capacity

```bash
git worktree list
```

The primary checkout is listed first and holds `main`; it is not a slot. Task
slots are the `.worktrees/*` entries, named `<task-id-prefix>-<short-label>`
(e.g. `71cfde09-chrome-host-gate`) so the listing is self-describing. A
long-lived worktree carrying a `wip/*` branch is a human-driven initiative —
count it against the cap, never reconcile or reclaim it.

If `/tmp/mpeek-dispatch-off` is present, stop here.

## 2. Reconcile in-flight — before claiming anything

For each task worktree, resolve its agent by slot name via `ListAgents` (the
spawn step in section 4 labels the agent with the slot name, which is what
makes this lookup work). Four cases:

- **Advancing** — `TaskOutput` shows new tool calls since the previous tick.
  Leave it alone.
- **Frozen** — `TaskOutput` unchanged across two ticks. `TaskStop` it,
  `record_event` on the Peek task noting the stall, and leave the worktree in
  place. The next tick respawns from the worktree's `handoff.md`.
- **Finished** — the completion notification already arrived. Route to
  section 5.
- **Orphaned** — a worktree with no agent in `ListAgents` and no completion
  seen, which is what a restarted dispatcher sees for every live slot. Read
  that worktree's `handoff.md` and `git -C .worktrees/<slot> log --oneline
  main..HEAD`: uncommitted or incomplete work respawns with `/pickup` in that
  directory; committed work matching the task's done-condition routes to
  section 5.

Never infer liveness from diffs or commits — they measure work product, not
whether the agent is alive.

## 3. Claim

```js
mcp__peek__list_items({ tags: ['peek:todo', 'peek:ready'] })
```

Drop anything tagged `peek:wip` or `peek:hold`. Drop anything whose body lacks
a `## Done looks like` or `## Verify` section — those are not dispatchable
regardless of tags, and the gap is a triage bug to report, not a gap for the
dispatcher to fill by inventing acceptance criteria.

Among what remains, prefer a `peek:scope:*` value not already in flight. Two
concurrent agents in `apps/desktop` is where merge pain comes from, and the
queue almost always holds something in a quieter area.

`peek:scope:cross` is never auto-claimed. Cross-app work has file-level
dependencies that worktree isolation does not solve; it wants one long-lived
worktree and a human deciding the sequence.

Claim by tagging **before** spawning, so a tick that dies mid-spawn cannot
double-claim:

```js
mcp__peek__tag_item({ itemId, tagName: 'peek:wip' })
mcp__peek__untag_item({ itemId, tagName: 'peek:todo' })
mcp__peek__untag_item({ itemId, tagName: 'peek:ready' })
mcp__peek__record_event({ itemId, type: 'started', value: 'dispatched to .worktrees/<slot>' })
```

## 4. Spawn

```bash
git -C /home/dev/workspace/peek worktree add .worktrees/<slot> -b agent/<slot> main
```

Then install inside it (`cd .worktrees/<slot> && yarn install`) — a worktree is
its own checkout and its resolution state is gitignored, so it never arrives
with the files.

Write `handoff.md` **inside the worktree** from the Peek item before spawning:
goal, current state (empty), next steps, the verify command. That file is what
makes the initiative survive a stalled agent, a dispatcher restart, and a
session boundary — it is the per-initiative version of the single-repo handoff
loop, and it is the reason more than one initiative can run at once.

Spawn with `run_in_background: true`, `subagent_type: routine-coder` for
specified mechanical work and `general-purpose` only when the task needs
judgment, labelled with the slot name. The brief must name the worktree path —
that is also what satisfies the second-writer spawn guard.

### Brief template

```
Work in the git worktree .worktrees/<slot>/ — never in the repo root, and never
in any other worktree. Read .worktrees/<slot>/handoff.md first; it states the
goal and the next steps.

Peek task: <item id> — <title>

DONE LOOKS LIKE: <verbatim from the item's "## Done looks like">
VERIFY: <verbatim from the item's "## Verify"> — must pass before reporting done.

Rules:
- Commit your work in the worktree on branch agent/<slot>. Do NOT merge, do NOT
  push, do NOT touch the worktree that holds `main`.
- Before you stop for any reason — done, blocked, or out of road — update
  .worktrees/<slot>/handoff.md so a fresh agent can resume cold.
- record_event on the Peek task with the outcome.
- One deliverable. If the work turns out to need several, do the first, write
  the rest into handoff.md as next steps, and report.

Report: what changed, the verify command's actual output, and anything you
could not verify.
```

## 5. Land a reviewed worktree

Only after `agent-review` returns a pass. In dependency order if several are
waiting:

```bash
git -C /home/dev/workspace/peek merge --ff-only agent/<slot>
```

Not a fast-forward → rebase **in the task worktree** (`git -C
.worktrees/<slot> rebase main`), then retry. Never rebase in the primary
checkout.

Then the gate, from the primary checkout, backgrounded:

```bash
yarn test:desktop:electron
```

Green → move the task to `peek:needs-review` and surface the commits, diff stat
and numeric pass count. **`peek:done` is the user's call, never the
dispatcher's.** Red → reset `main` back, send the failing output to the
original agent via `SendMessage` (it still has the context and the installed
worktree), and re-review when it returns.

Clean up only after the task is marked done:

```bash
git -C /home/dev/workspace/peek worktree remove .worktrees/<slot>
git -C /home/dev/workspace/peek branch -d agent/<slot>
```

## Tick report

One short block, every tick, even a quiet one: slots in use and what each is
working, anything stalled or reclaimed, what got claimed and spawned, anything
sitting in `peek:needs-review` awaiting approval. A tick that reports nothing
is indistinguishable from a dispatcher that died.
