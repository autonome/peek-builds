#!/bin/bash
# Finalize an isolated clone's commits into the main checkout's `main` branch.
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
# originals, leaving orphaned copies of the same work on both sides — the
# root cause of the chaos we cleaned up on 2026-05-21. Fast-forward-only
# finalize eliminates that by construction.
#
# Cost: if main moves while the agent is working (e.g. another agent
# finalized first), the agent has to rebase in their own clone before
# finalize succeeds. That's the right place for the rebase anyway — the
# agent has the context to resolve conflicts.
#
# ## Mechanism
#
# 1. In the clone, find the newest agent-<name>-<timestamp> branch — the
#    branch tip IS the work tip.
# 2. Fetch from the clone's pool-<name> git remote into the main checkout.
# 3. Check: is the fetched ref a strict descendant of current `main`?
#    - YES: advance `main` to the fetched tip.
#    - NO:  refuse with explicit rebase recipe.
#
# After a successful fast-forward, the clone is automatically reset to main
# (via reset-isolated-clone.sh) so it's ready for the next task. All agent
# branches are preserved as breadcrumbs for archaeology.
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

# ── Step 1: in the clone, find the newest agent branch ────────────────────
BRANCH=$(git -C "$CLONE_DIR" for-each-ref --sort=-creatordate --format='%(refname:short)' "refs/heads/agent-${NAME}-*" | head -1)
if [ -z "$BRANCH" ]; then
  echo "error: no agent-${NAME}-<timestamp> branch found in clone." >&2
  echo "       was the clone spawned via spawn-isolated-clone.sh?" >&2
  exit 1
fi
echo "Found branch in clone: ${BRANCH}" >&2

# ── Step 2: in main, fetch from the clone's git remote ────────────────────
cd "$MAIN_DIR"
if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  echo "error: git remote ${REMOTE_NAME} not registered in main checkout." >&2
  echo "       did you spawn this clone via spawn-isolated-clone.sh?" >&2
  exit 1
fi
echo "Fetching from ${REMOTE_NAME}..." >&2
git fetch "$REMOTE_NAME" >&2

REMOTE_REF="${REMOTE_NAME}/${BRANCH}"

# ── Step 3: fast-forward-or-bust check ────────────────────────────────────
REMOTE_REV=$(git rev-parse "$REMOTE_REF" 2>/dev/null || true)
MAIN_REV=$(git rev-parse main 2>/dev/null || true)

if [ -z "$REMOTE_REV" ]; then
  echo "error: could not resolve ${REMOTE_REF} after fetch." >&2
  exit 1
fi
if [ -z "$MAIN_REV" ]; then
  echo "error: could not resolve local 'main' branch." >&2
  exit 1
fi

# Same commit: no-op
if [ "$REMOTE_REV" = "$MAIN_REV" ]; then
  echo "agent ${NAME} has no new commits — main already at ${MAIN_REV:0:12}" >&2
  exit 0
fi

# Strict-descendant check: is MAIN_REV an ancestor of REMOTE_REV?
if ! git merge-base --is-ancestor "$MAIN_REV" "$REMOTE_REV"; then
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
  echo "  git fetch origin                             # pull latest main" >&2
  echo "  git rebase origin/main" >&2
  echo "  # resolve any conflicts, then: git rebase --continue" >&2
  echo "  cd ${MAIN_DIR}" >&2
  echo "  echo ${NAME} > /tmp/mpeek-agent-name" >&2
  echo "  scripts/finalize-isolated-clone.sh" >&2
  echo "" >&2
  exit 5
fi

# ── Step 3.5: strand guard (peek 0b908fef) ────────────────────────────────
# Step 4 below moves `main` onto the incoming line. Work the MAIN CHECKOUT is
# sitting on that is NOT on that line would be left referenced by nothing — the
# silent orphan trap.
#
# Committed work on `main` itself cannot be stranded: the fast-forward gate
# above already refuses unless `main` is an ancestor of the incoming tip, and
# work on any other branch stays reachable through that branch. The one hole is
# a DETACHED HEAD carrying commits — nothing names those, so moving `main` past
# them leaves them to the reflog and nothing else. Detect and refuse.
if ! git symbolic-ref -q HEAD >/dev/null 2>&1; then
  STRANDED=$(git log --oneline "${REMOTE_REV}..HEAD" 2>/dev/null || true)
  if [ -n "$STRANDED" ]; then
    echo "" >&2
    echo "ERROR: finalizing clone ${NAME} would STRAND main-checkout work:" >&2
    echo "" >&2
    echo "$STRANDED" >&2
    echo "HEAD is detached and these commits are on no branch. Moving main onto" >&2
    echo "the clone's line would orphan them silently (0b908fef). Give them a" >&2
    echo "name first, then rebase THIS clone onto the new main and re-run:" >&2
    echo "" >&2
    echo "  git switch -c <branch-name>          # or: git branch -f main HEAD" >&2
    echo "  cd ${CLONE_DIR}" >&2
    echo "  git fetch origin" >&2
    echo "  git rebase origin/main" >&2
    echo "  cd ${MAIN_DIR}" >&2
    echo "  echo ${NAME} > /tmp/mpeek-agent-name" >&2
    echo "  scripts/finalize-isolated-clone.sh" >&2
    echo "" >&2
    exit 6
  fi
fi

# ── Step 4: fast-forward main ──────────────────────────────────────────────
# `main` is normally the checked-out branch in the main checkout: fast-forward
# it in place with a merge when HEAD is on it, and move the ref directly
# otherwise. Refuse rather than clobber uncommitted edits.
CURRENT_BRANCH=$(git symbolic-ref --short -q HEAD || true)
if [ "$CURRENT_BRANCH" = "main" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "error: working tree is dirty; refusing to fast-forward 'main' in place." >&2
    echo "       commit or stash your changes, then re-run." >&2
    exit 1
  fi
  git merge --ff-only "$REMOTE_REV" >&2
else
  git branch -f main "$REMOTE_REV"
fi
echo "Fast-forwarded main: ${MAIN_REV:0:12} → ${REMOTE_REV:0:12}" >&2

echo "" >&2
echo "Finalized clone ${NAME} (fast-forward, no rebase, no divergence)." >&2

# Reset the clone back to main so it's ready for the next task.
# Branches are preserved as breadcrumbs for archaeology.
"${MAIN_DIR}/scripts/reset-isolated-clone.sh" >&2

echo "" >&2
echo "Next: push to tangled with scripts/push-main.sh" >&2
