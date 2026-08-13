---
name: agent-review
description: Review-and-land loop for a pool-clone agent's committed diff — reviewer decision table, finalize + test gate, retry-in-clone on failure, peek:needs-review handoff. Use when a background/clone agent reports its task done and the work needs review, landing, or rejection.
---

# /agent-review — Pass/fail an agent-produced diff in a clone

Use when a pool-clone agent has finished a task and you need to decide whether
to finalize + land its work. Codifies the decision boundary, the reviewer-agent
brief, the land + verify loop, and the retry-in-clone path on test failure.

This is **distinct from `/review`**. `/review` reviews uncommitted local diffs.
`/agent-review` reviews a clone agent's committed work + drives it through the
chaos-defense chokepoints (finalize → `test:desktop:electron` → mark done).

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
1. `git -C .worktrees/<name> diff --stat main...HEAD` — scope check.
2. `git -C .worktrees/<name> diff main...HEAD` or `Read` each changed file.
3. Look for: cross-app touches, missing tests, scope creep, secrets,
   `webSecurity:false` / `sandbox:false` regressions, lazy `require('electron')`,
   `setTimeout` in main without `isDestroyed()` guard, top-level
   `await api.initialize()`.

---

## Reviewer subagent brief template

```
You are reviewing agent-produced work in clone .worktrees/<name>/.
The agent claims it implemented <task>. Verify the claim — do NOT trust it.

ACCEPTANCE (all runtime, all must pass — no grep shortcuts):
1. `git -C .worktrees/<name> diff --stat main...HEAD` — list files; flag any
   touch outside the declared scope.
2. `yarn workspace @peek/desktop test:unit` from the clone — must pass; report
   numeric count.
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
2. Review passes → finalize in dependency order if main has moved:
     a. echo <name> > /tmp/mpeek-agent-name
     b. scripts/finalize-isolated-clone.sh
     c. If FF rejected: rebase IN THE CLONE
          (git -C .worktrees/<name> fetch origin
           git -C .worktrees/<name> rebase origin/main)
        Then retry finalize.
3. After ALL targeted clones finalized:
     yarn test:desktop:electron   # run_in_background, FULL suite (all 6 runners, ~3300+, ~10 min), canonical gate
4. test:desktop:electron green → tasks move to NEEDS-REVIEW. **Do NOT auto-mark
   peek:done.** Surface the diff + test result to the user; only the user
   authorises `peek:done`. See [Needs-review handoff](#needs-review-handoff).
5. test:desktop:electron RED → see [Retry-in-clone](#retry-in-clone-on-test-failure).
6. Clean clones (`scripts/clean-isolated-clone.sh` per slot) unless the build
   cache is reusable for follow-up work — but only AFTER the user has approved
   peek:done. Clean'd clones can't be re-driven without respawn.
```

**Do NOT run `scripts/push-main.sh`** unless the user explicitly asks. Authorization
is per-request, never standing.

### Needs-review handoff

When tests are green but user approval is pending, the orchestrator must:

1. Tag the peek task `peek:needs-review` and untag `peek:todo` /
   `peek:wip`, clearing any `peek:ready` / `peek:triage` quality marker
   (see the `peek` skill's tag model).
2. Surface to the user, in one short message:
   - The commit IDs landed on main
   - The diff stat (`git diff --stat main...HEAD` in the clone, or per-commit)
   - The test result (numeric pass count, runtime)
   - "Approve to mark done, or call out anything to revisit"
3. Wait for explicit "approve" / "ok mark done" / equivalent before
   untagging `peek:todo` and tagging `peek:done`.

This applies even when the orchestrator personally reviewed the diff and ran
the tests. The user is the final gate. Tests + LLM review are necessary, not
sufficient.

---

## Retry-in-clone on test failure

When `test:desktop:electron` fails after landing:

1. Identify which finalized commit caused the failure (often obvious from the
   failing test's surface area; if not, `git log --oneline tangled/main..main`
   and bisect by resetting the clone to earlier commits).
2. In the CLONE (never the main checkout) —
   `git -C .worktrees/<name> reset --hard <sha-before-the-bad-commit>` —
   discards the clone's landed commit back to the last good state. Git has no
   operation log to restore from, so this is destructive: uncommitted work in
   the clone is gone. `main` already fast-forwarded past the bad commit and
   stays there; the fix lands as a new commit on top rather than rewriting
   history.
3. The clone still exists (preserved by finalize). SendMessage the **original
   agent** (not a fresh spawn) with:
   ```
   Your <task> landed but yarn test:desktop:electron failed: <paste failing test +
   relevant log lines>. The clone at .worktrees/<name>/ has been reset back
   to before your commit. Diagnose, fix in the clone, commit, and report back.
   Same brief as before re: do-not-finalize, do-not-push.
   ```
4. When the agent returns, run `/agent-review` on the updated diff.

Why SendMessage and not a new Agent: the original agent has full context on
what it did and why. A fresh spawn re-reads everything. The clone still has
its node_modules; no respawn overhead.

---

## Usage

```
/agent-review <clone-name>
/agent-review tags-cards
/agent-review adblocker-resilience
```

If no name passed, list clones in the pool (`ls -d .worktrees/*`) and ask.
