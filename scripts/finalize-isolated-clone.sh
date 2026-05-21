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
# Clone and registered remote are PRESERVED for reuse by the next spawn.
# Tear down with scripts/clean-isolated-clone.sh.

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
CLONE_DIR="${MAIN_DIR}/../mpeek-clone-${NAME}"
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
ANCESTORS_OF_REMOTE=$(jj log -r "::${REMOTE_REV}" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null)
if ! echo "$ANCESTORS_OF_REMOTE" | grep -qx "$MAIN_REV"; then
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

# ── Step 4: fast-forward main and @ ───────────────────────────────────────
jj bookmark set main -r "$REMOTE_REV"
echo "Fast-forwarded main: ${MAIN_REV:0:12} → ${REMOTE_REV:0:12}" >&2

# Move @ onto the new tip (preserves the convention that @ rides above main)
jj new "$REMOTE_REV" >&2

echo "" >&2
echo "Finalized clone ${NAME} (fast-forward, no rebase, no divergence)." >&2
echo "Clone preserved at ${CLONE_DIR} for reuse." >&2
echo "" >&2
echo "Next: push to tangled with scripts/push-main.sh (step 4 of the chaos-defense plan)." >&2
