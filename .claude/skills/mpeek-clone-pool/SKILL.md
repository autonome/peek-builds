---
name: mpeek-clone-pool
description: The isolated clone pool for agent work in mpeek. Invoke BEFORE spawning an isolated clone or workspace, running parallel agents, running heavy electron tests or `yarn start` alongside other work, doing iOS/Android (mobile) builds, or finalizing/cleaning a clone slot. Covers the spawn/finalize/clean scripts, the /tmp/mpeek-agent-name file convention, pool cap, the reserved persistent `mobile` slot, and the chaos-defense rationale behind the chokepoint scripts.
---

# Isolated agent workspaces (clone pool)

For parallel background agents (heavy rewrites, electron tests, `yarn start`),
claim an isolated **true clone** with its own `.jj` and `.git`. Each clone has a
dedicated Electron profile dir so tests don't race on shared DB / ports / window
state. The `node_modules` for the app(s) in scope are symlinked from the main
checkout; no `yarn install` needed.

**Pool cap: 5.** Check `ls ../mpeek-clone-*` before spawning a new slot.

```bash
echo <name> > /tmp/mpeek-agent-name
echo apps-migration > /tmp/mpeek-clone-base     # or main
echo apps/desktop > /tmp/mpeek-clone-scope      # optional: only that app's node_modules symlinked
scripts/spawn-isolated-clone.sh

# Inside the clone (you're cd'd into ../mpeek-clone-<name>):
PROFILE=clone-<name> yarn <script>

# After work is done — rebase commits into main checkout's bookmark:
scripts/finalize-isolated-clone.sh

# Only when fully done with the slot:
scripts/clean-isolated-clone.sh                 # forgets agent bookmark, removes clone dir + profile dir + git remote
```

Why true clones (not jj workspaces): physically separate `.jj` dirs eliminate
the concurrent-edit hazard. Integration happens via a registered `pool-<name>`
git remote in the main checkout — the main checkout's working state never
changes unexpectedly because an agent is working.

The old `spawn-isolated-agent.sh` family (jj workspaces, retired in Phase 6 of
the apps/ restructure) is GONE — use the clone pool.

## Scripts: file-name convention for invariant command text

Scripts that take a "name" arg (like the clone pool family) read from
`/tmp/mpeek-agent-name` rather than positional args. Caller pattern:

```bash
echo myname > /tmp/mpeek-agent-name
echo apps-migration > /tmp/mpeek-clone-base     # optional: BASE override
echo apps/desktop > /tmp/mpeek-clone-scope      # optional: --scope filter
scripts/spawn-isolated-clone.sh                 # invariant text, one allowlist entry covers all
```

This keeps the Bash command-text identical across every invocation, so the
Claude Code allowlist entry `Bash(scripts/spawn-isolated-clone.sh)` doesn't
re-prompt per call.

## Reserved slot: `mobile`

The name `mobile` is a **dedicated, persistent slot** outside the 5-clone pool
cap. It's purpose-built for iOS/Android builds, which produce hundreds of MB of
Rust `target/` output per ABI plus Xcode derived data + `libapp.a` /
`PeekCore.xcframework` outputs. Cold rebuild is ~2 min Rust + Xcode time;
cached is ~15 s.

```bash
scripts/spawn-mobile-workspace.sh    # hard-codes name=mobile, base=main, scope=apps/mobile
# clone at ../mpeek-clone-mobile/ — PERSISTS across spawns
# build outputs (target/, gen/apple/, peek-core/) are untracked → survive between sessions
```

`scripts/clean-isolated-clone.sh` **refuses** the `mobile` slot unless
`MOBILE_FORCE_CLEAN=1` is set in env — guards against accidentally torching
cached builds during routine pool cleanup.

Finalize works the same as any other slot (`scripts/finalize-isolated-clone.sh`).

## Chaos-defense background (why the chokepoints exist)

After the 2026-05-21 cleanup, two structural defenses replaced the previous
ad-hoc bookmark management:

1. **`scripts/finalize-isolated-clone.sh` is fast-forward-or-bust.** It refuses
   to rebase. If the agent's work isn't a strict descendant of current `main`,
   the script tells the agent to rebase IN THE CLONE before retrying. This
   eliminates the divergent-commit-id pattern caused by rebasing remote-tracked
   refs.

2. **`scripts/push-main.sh` is the only sanctioned path to publish `main`.** It
   verifies local `main` is a strict descendant of `main@tangled`, warns on
   divergent siblings on the push path, prints the exact commit list, requires
   `--yes` to proceed, and post-push prunes stale `pool-*` remote-tracking refs
   so future fetches can't resurrect cleaned-up divergence.

The binding rules live in the root `CLAUDE.md` (never manually
`jj bookmark set main`; `main` moves only via these two scripts).

Edit-in-clone discipline: when changing `scripts/*` or any tracked file that's
part of this machinery, work in a clone instead of the main checkout —
`jj op restore` inside the main checkout can wipe uncommitted edits, which
happened repeatedly during the 2026-05-21 session. The clone pool runs through
the same hardened path (spawn → commit → finalize) and is unaffected.

Related history: the Agent tool's `isolation: "worktree"` parameter (banned in
root `CLAUDE.md`) left 10 orphan git worktrees in `.claude/worktrees/` (since
cleaned) before the ban — that recovery cost is why the rule exists.
