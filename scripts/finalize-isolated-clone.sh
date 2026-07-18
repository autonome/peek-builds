#!/bin/bash
# Finalize an isolated clone's commits into the main checkout's `main` bookmark.
#
# Usage:
#   echo <name> > /tmp/mpeek-agent-name
#   scripts/finalize-isolated-clone.sh
#
# ## Semantics: fast-forward-or-bust
#
# This script REFUSES to rebase. It only advances `main` if the agent's work
# is a strict descendant of the current `main`. Otherwise it surfaces the
# divergence and tells you to rebase IN THE CLONE.
#
# Why: rebasing agent commits inside the main checkout (the old behavior)
# rewrites commit IDs while the clone's pool-* remote still tracks the
# originals. That ALWAYS produces divergent change_ids in jj — the root
# cause of the chaos we cleaned up on 2026-05-21. Fast-forward-only finalize
# eliminates divergence by construction.
#
# Cost: if main moves while the agent is working (e.g. another agent
# finalized first), the agent has to rebase in their own clone before
# finalize succeeds. That's the right place for the rebase anyway — the
# agent has the context to resolve conflicts.
#
# ## Mechanism
#
# 1. In the clone, advance the agent's bookmark to @ or @- (depending on
#    whether the agent left work at @ or did `jj new` after).
# 2. Fetch from the clone's pool-<name> git remote into main checkout.
# 3. Check: is the fetched ref a strict descendant of current `main`?
#    - YES: advance `main` bookmark to the fetched tip. Move @ on top.
#    - NO:  refuse with explicit rebase recipe.
#
# After a successful fast-forward, the clone is automatically reset to main
# (via reset-isolated-clone.sh) so it's ready for the next task. All agent
# bookmarks are preserved as breadcrumbs for archaeology.
# Full teardown (reclaim slot): scripts/clean-isolated-clone.sh.

set -euo pipefail

# Name read from /tmp/mpeek-agent-name only (invariant command text → one allowlist).
if [ ! -r /tmp/mpeek-agent-name ]; then
  echo "error: write the clone name to /tmp/mpeek-agent-name first" >&2
  exit 2
fi
NAME=$(cat /tmp/mpeek-agent-name)
if [ -z "$NAME" ]; then
  echo "error: /tmp/mpeek-agent-name is empty" >&2
  exit 2
fi

MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Pool clones live in-repo at .worktrees/<name>. The `mobile` slot is the one
# exception: it stays at the legacy sibling path to preserve its warm iOS build
# cache (~12GB). This is a deliberate bridge — when mobile is next rebuilt from
# scratch it should move in-repo too and this special case can go.
if [ "$NAME" = "mobile" ]; then
  CLONE_DIR="${MAIN_DIR}/../mpeek-clone-${NAME}"
else
  CLONE_DIR="${MAIN_DIR}/.worktrees/${NAME}"
fi
REMOTE_NAME="pool-${NAME}"

if [ ! -d "$CLONE_DIR" ]; then
  echo "error: clone ${CLONE_DIR} does not exist" >&2
  exit 1
fi

# ── Step 1: in the clone, advance the agent bookmark to the work tip ──────
cd "$CLONE_DIR"
BOOKMARK=$(jj bookmark list -T 'name ++ "\n"' 2>/dev/null \
  | grep "^agent-${NAME}-" \
  | sort -t- -k3 -n -r \
  | head -1)
if [ -z "$BOOKMARK" ]; then
  echo "error: no agent-${NAME}-<timestamp> bookmark found in clone." >&2
  echo "       was the clone spawned via spawn-isolated-clone.sh?" >&2
  exit 1
fi
echo "Found bookmark in clone: ${BOOKMARK}" >&2

# Pick @ if it has a description (agent did `jj describe` without trailing
# `jj new` — the work IS @); otherwise @- (jj-canonical: work is @-, @ is
# an empty placeholder). --allow-backwards because `jj describe` keeps the
# change_id while changing commit_id, which jj treats as a sideways move.
AT_DESC=$(jj log -r @ --no-graph -T 'description' 2>/dev/null)
if [ -n "$AT_DESC" ]; then
  WORK_TIP=$(jj log -r @ --no-graph -T 'commit_id' 2>/dev/null | head -1)
  TIP_LABEL="@"
else
  WORK_TIP=$(jj log -r '@-' --no-graph -T 'commit_id' 2>/dev/null | head -1)
  TIP_LABEL="@-"
fi
if [ -n "$WORK_TIP" ]; then
  jj bookmark set "$BOOKMARK" -r "$WORK_TIP" --allow-backwards >&2
  echo "Bookmark ${BOOKMARK} advanced to ${TIP_LABEL} (${WORK_TIP:0:12})" >&2
fi

# ── Step 2: in main, fetch from the clone's git remote ────────────────────
cd "$MAIN_DIR"
if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  echo "error: git remote ${REMOTE_NAME} not registered in main checkout." >&2
  echo "       did you spawn this clone via spawn-isolated-clone.sh?" >&2
  exit 1
fi
echo "Fetching from ${REMOTE_NAME}..." >&2
jj git fetch --remote "$REMOTE_NAME" >&2

REMOTE_REF="${BOOKMARK}@${REMOTE_NAME}"

# ── Step 3: fast-forward-or-bust check ────────────────────────────────────
REMOTE_REV=$(jj log -r "$REMOTE_REF" --no-graph -T 'commit_id' 2>/dev/null | head -1)
MAIN_REV=$(jj log -r main --no-graph -T 'commit_id' 2>/dev/null | head -1)

if [ -z "$REMOTE_REV" ]; then
  echo "error: could not resolve ${REMOTE_REF} after fetch." >&2
  exit 1
fi
if [ -z "$MAIN_REV" ]; then
  echo "error: could not resolve local 'main' bookmark." >&2
  exit 1
fi

# Same commit: no-op
if [ "$REMOTE_REV" = "$MAIN_REV" ]; then
  echo "agent ${NAME} has no new commits — main already at ${MAIN_REV:0:12}" >&2
  exit 0
fi

# Strict-descendant check: is MAIN_REV an ancestor of REMOTE_REV?
# Computed as: does jj's ancestor set of REMOTE_REV contain MAIN_REV?
# (We grep instead of using `&` in the revset because chook blocks `&` in
# Bash tool args; this stays portable to interactive invocations too.)
#
# IMPORTANT: under `set -o pipefail`, `grep -q` short-circuits on first match
# and causes the upstream `echo` to receive SIGPIPE (exit 141). pipefail then
# makes the whole pipeline exit 141, and `if !` flips that to truthy — i.e.
# the ERROR branch runs even when MAIN_REV IS an ancestor. Use `grep -c`
# (counts every line, no early exit) with the count discarded; check grep's
# exit code directly, which is 0 iff at least one match was found.
ANCESTORS_OF_REMOTE=$(jj log -r "::${REMOTE_REV}" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null)
if ! echo "$ANCESTORS_OF_REMOTE" | grep -cFx "$MAIN_REV" >/dev/null; then
  echo "" >&2
  echo "ERROR: agent's work is NOT a fast-forward of main." >&2
  echo "" >&2
  echo "  main is at:        ${MAIN_REV:0:12}" >&2
  echo "  agent's work tip:  ${REMOTE_REV:0:12}" >&2
  echo "" >&2
  echo "Main moved since the clone was spawned. The agent must rebase in" >&2
  echo "their own clone before finalize. Recipe:" >&2
  echo "" >&2
  echo "  cd ${CLONE_DIR}" >&2
  echo "  jj git fetch                                # pull latest main" >&2
  echo "  jj rebase -s ${BOOKMARK} -d main@origin --skip-emptied" >&2
  echo "  # resolve any conflicts: jj resolve" >&2
  echo "  cd ${MAIN_DIR}" >&2
  echo "  echo ${NAME} > /tmp/mpeek-agent-name" >&2
  echo "  scripts/finalize-isolated-clone.sh" >&2
  echo "" >&2
  exit 5
fi

# ── Step 3.5: strand guard (peek 0b908fef) ────────────────────────────────
# Step 4 below does `jj bookmark set main` + `jj new` onto the clone's line.
# Any non-empty, described work the MAIN CHECKOUT is currently sitting on that
# is NOT on that incoming line would be left referenced by nothing — the silent
# orphan trap. Detect it and refuse, rather than evaporate it.
#
# Revset `::@ ~ ::REMOTE_REV ~ empty()`: everything on the main checkout's
# current @ line (`::@`), minus the incoming/shared history (`::REMOTE_REV` —
# removes old main and every clone commit), minus empty placeholders (the @
# left by a trailing `jj new`). What remains is exactly the main-checkout-only
# stack this finalize would strand. Scoped to `::@` (not `descendants(main)`)
# so unrelated abandoned breadcrumbs elsewhere in the DAG don't trip it.
STRANDED=$(jj log -r "::@ ~ ::${REMOTE_REV} ~ empty()" --no-graph \
  -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"' 2>/dev/null || true)
if [ -n "$STRANDED" ]; then
  echo "" >&2
  echo "ERROR: finalizing clone ${NAME} would STRAND main-checkout work:" >&2
  echo "" >&2
  echo "$STRANDED" >&2
  echo "These commits sit on the main checkout's @ line but not on the clone's" >&2
  echo "line. Moving main onto the clone would orphan them silently (0b908fef)." >&2
  echo "Land them first, then rebase THIS clone onto the new main and re-run:" >&2
  echo "" >&2
  echo "  scripts/finalize-main-checkout-stack.sh --yes   # FF main to that stack" >&2
  echo "  cd ${CLONE_DIR}" >&2
  echo "  jj git fetch" >&2
  echo "  jj rebase -s ${BOOKMARK} -d main@origin --skip-emptied" >&2
  echo "  cd ${MAIN_DIR}" >&2
  echo "  echo ${NAME} > /tmp/mpeek-agent-name" >&2
  echo "  scripts/finalize-isolated-clone.sh" >&2
  echo "" >&2
  exit 6
fi

# ── Step 4: fast-forward main and @ ───────────────────────────────────────
jj bookmark set main -r "$REMOTE_REV"
echo "Fast-forwarded main: ${MAIN_REV:0:12} → ${REMOTE_REV:0:12}" >&2

# Move @ onto the new tip (preserves the convention that @ rides above main)
jj new "$REMOTE_REV" >&2

echo "" >&2
echo "Finalized clone ${NAME} (fast-forward, no rebase, no divergence)." >&2

# Reset the clone back to main so it's ready for the next task.
# Bookmarks are preserved as breadcrumbs for archaeology.
"${MAIN_DIR}/scripts/reset-isolated-clone.sh" >&2

echo "" >&2
echo "Next: push to tangled with scripts/push-main.sh" >&2
