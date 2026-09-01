---
name: agent-review
description: Review-and-land loop for a worktree agent's committed diff — reviewer decision table, merge + test gate, retry-in-worktree on failure, peek:needs-review handoff. Use when a background/worktree agent reports its task done and the work needs review, landing, or rejection.
---

# /agent-review — Pass/fail an agent-produced diff in a worktree

Use when an agent working in `.worktrees/<slot>` has finished a task and you
need to decide whether to land its work. Codifies the decision boundary, the
reviewer-agent brief, the land + verify loop, and the retry path on test
failure.

This is **distinct from `/review`**. `/review` reviews uncommitted local diffs.
`/agent-review` reviews a worktree agent's committed work + drives it through
landing (merge → `test:desktop:electron` → mark done). Worktree layout and the
`agent/<slot>` branch convention live in `~/.claude/docs/worktrees.md`.

---

## Decision: who reviews?

| Diff size                                       | Reviewer       |
|-------------------------------------------------|----------------|
| < ~100 lines, single area, CSS / config         | Orchestrator   |
| ≥ ~100 lines, new module, or cross-area         | Subagent       |
| New main-process IPC or capability surface      | Subagent       |
| Renames / mechanical refactors                  | Orchestrator   |

A reviewer subagent is overkill for tiny diffs *and* prone to the grep-shortcut
failure mode (see [Failure modes](#failure-modes-name-them-in-the-brief)). The
real gate is `yarn test:desktop:electron` in the main checkout — not a second LLM read.

Orchestrator review:
1. `git -C .worktrees/<slot> diff --stat main...HEAD` — scope check.
2. `git -C .worktrees/<slot> diff main...HEAD` or `Read` each changed file.
3. Look for: cross-app touches, missing tests, scope creep, secrets,
   `webSecurity:false` / `sandbox:false` regressions, lazy `require('electron')`,
   `setTimeout` in main without `isDestroyed()` guard, top-level
   `await api.initialize()`.

---

## Reviewer subagent brief template

```
You are reviewing agent-produced work in the git worktree .worktrees/<slot>/.
The agent claims it implemented <task>. Verify the claim — do NOT trust it.

ACCEPTANCE (all runtime, all must pass — no grep shortcuts):
1. `git -C .worktrees/<slot> diff --stat main...HEAD` — list files; flag any
   touch outside the declared scope.
2. `yarn workspace @peek/desktop test:unit` from the worktree — must pass;
   report numeric count.
3. <task-specific runtime check — e.g. "delete the cache file, run init in a
   smoke script, confirm it falls back without throwing">.
4. Read the actual implementation file end-to-end. Cite line numbers for any
   concern.

REPORT FORMAT:
- VERDICT: PASS or FAIL (one word).
- Diff scope: <ok | violates>.
- Runtime checks: <each acceptance item with observed result>.
- Concerns (with line numbers): <bullets>.
- Recommended action: land / land with follow-up task / send back to agent.

Under 300 words. Do NOT propose edits — that's the orchestrator's call.
```

### Failure modes — name them in the brief

Reviewer subagents drift toward these. Naming them in the brief reduces it.

- **Grep shortcut**: "I grepped for X and found it, so it's wired up." Greps
  prove presence of a string, not runtime behaviour. Always pair with an
  executed check.
- **Faux runtime**: "The test exists" — but did it pass *this run*? Demand the
  numeric pass count from a fresh run, not the agent's prior claim.
- **"Looks fine"**: shorthand for "I didn't actually read it." Require line
  citations for any concern AND for the overall PASS.
- **Scope blindness**: only checking the file the task names, missing
  cross-app collateral. The `diff --stat` against `main..@` catches this if you
  demand it explicitly.

---

## Land + verify loop (orchestrator drives this)

```
1. Decide reviewer (table above).
2. Review passes → land in dependency order, from the primary checkout:
     a. git merge --ff-only agent/<slot>
     b. Not a fast-forward → rebase IN THE WORKTREE
          (git -C .worktrees/<slot> rebase main)
        Then retry the merge. Never rebase in the primary checkout.
3. After ALL targeted worktrees have landed:
     yarn test:desktop:electron   # run_in_background, FULL suite (all 6 runners, ~3300+, ~10 min), canonical gate
4. test:desktop:electron green → tasks move to NEEDS-REVIEW. **Do NOT auto-mark
   peek:done.** Surface the diff + test result to the user; only the user
   authorises `peek:done`. See [Needs-review handoff](#needs-review-handoff).
5. test:desktop:electron RED → see [Retry-in-worktree](#retry-in-worktree-on-test-failure).
6. Retire the slot (`git worktree remove .worktrees/<slot>` then
   `git branch -d agent/<slot>`) unless its install/build cache is reusable for
   follow-up work — but only AFTER the user has approved peek:done. A removed
   worktree can't be re-driven without respawn.
```

**Never push.** Publishing `main` is a separate, per-request authorization.

### Needs-review handoff

When tests are green but user approval is pending, the orchestrator must:

1. Tag the peek task `peek:needs-review` and untag `peek:todo` /
   `peek:wip`, clearing any `peek:ready` / `peek:triage` quality marker
   (see the `peek` skill's tag model).
2. Surface to the user, in one short message:
   - The commit IDs landed on main
   - The diff stat (`git diff --stat main...HEAD` in the worktree, or per-commit)
   - The test result (numeric pass count, runtime)
   - "Approve to mark done, or call out anything to revisit"
3. Wait for explicit "approve" / "ok mark done" / equivalent before
   untagging `peek:todo` and tagging `peek:done`.

This applies even when the orchestrator personally reviewed the diff and ran
the tests. The user is the final gate. Tests + LLM review are necessary, not
sufficient.

---

## Retry-in-worktree on test failure

When `test:desktop:electron` fails after landing:

1. Identify which landed commit caused the failure (often obvious from the
   failing test's surface area; if not, `git log --oneline tangled/main..main`
   and bisect).
2. Leave `main` where it is — it already fast-forwarded past the bad commit,
   and the fix lands as a new commit on top rather than a history rewrite.
   Reset the WORKTREE (never the primary checkout) to the pre-merge base if the
   agent needs a clean slate: `git -C .worktrees/<slot> reset --hard main`.
   That is destructive — uncommitted work in the worktree is gone.
3. The worktree still exists. SendMessage the **original agent** (not a fresh
   spawn) with:
   ```
   Your <task> landed but yarn test:desktop:electron failed: <paste failing test +
   relevant log lines>. Fix it in .worktrees/<slot>/ on branch agent/<slot>,
   commit there, and report back. Same brief as before re: do-not-merge,
   do-not-push.
   ```
4. When the agent returns, run `/agent-review` on the updated diff.

Why SendMessage and not a new Agent: the original agent has full context on
what it did and why. A fresh spawn re-reads everything. The worktree still has
its install state; no respawn overhead.

---

## Usage

```
/agent-review <slot-name>
/agent-review tags-cards
/agent-review adblocker-resilience
```

If no name passed, list the slots (`git worktree list`) and ask.
