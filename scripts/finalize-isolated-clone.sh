#!/bin/bash
# Merge an isolated clone's commits back into the main checkout.
#
# Usage: scripts/finalize-isolated-clone.sh <name>
#
# Mechanism: each spawn creates a timestamped bookmark `agent-<name>-<unix>`
# in the clone. Finalize finds the latest such bookmark, fetches it from the
# pool-<name> git remote into the main checkout, and rebases its commits
# onto @ in main. The bookmark is preserved in main as a safety copy until
# explicit clean.
#
# Clone and registered remote are PRESERVED for reuse by the next spawn.
# Tear down with scripts/clean-isolated-clone.sh.

set -euo pipefail

NAME="${1:-${AGENT_NAME:-}}"
if [ -z "$NAME" ] && [ -r /tmp/mpeek-agent-name ]; then
  NAME=$(cat /tmp/mpeek-agent-name)
fi
if [ -z "$NAME" ]; then
  echo "usage: $0 <name>   OR write name to /tmp/mpeek-agent-name" >&2
  exit 2
fi

MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLONE_DIR="${MAIN_DIR}/../mpeek-clone-${NAME}"
REMOTE_NAME="pool-${NAME}"

if [ ! -d "$CLONE_DIR" ]; then
  echo "error: clone ${CLONE_DIR} does not exist" >&2
  exit 1
fi

# Find the most recent agent-<NAME>-* bookmark in the clone.
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

# Make sure clone's bookmark covers any commits the agent made after spawn.
# Move bookmark to @- (the last real commit; @ is typically an empty placeholder).
AT_DASH=$(jj log -r '@-' --no-graph -T 'commit_id' 2>/dev/null | head -1)
if [ -n "$AT_DASH" ]; then
  jj bookmark set "$BOOKMARK" -r "$AT_DASH" >&2
  echo "Bookmark ${BOOKMARK} advanced to @- (${AT_DASH:0:12})" >&2
fi

# Switch to main and fetch from the clone's remote.
cd "$MAIN_DIR"
if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  echo "error: git remote ${REMOTE_NAME} not registered in main checkout." >&2
  echo "       did you spawn this clone via spawn-isolated-clone.sh?" >&2
  exit 1
fi
echo "Fetching from ${REMOTE_NAME}..." >&2
jj git fetch --remote "$REMOTE_NAME" >&2

# The fetched bookmark appears as ${BOOKMARK}@${REMOTE_NAME} in main.
REMOTE_BOOKMARK="${BOOKMARK}@${REMOTE_NAME}"

# Find commits unique to the agent vs main's @.
NEW_COMMITS=$(jj log -r "(::${REMOTE_BOOKMARK}) ~ (::@)" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null || true)
if [ -z "$NEW_COMMITS" ]; then
  echo "no new commits from ${BOOKMARK} to rebase" >&2
  exit 0
fi

# Capture main's current head, then rebase.
MAIN_HEAD=$(jj log -r @ --no-graph -T 'commit_id' | head -1)
echo "Rebasing agent commits onto main @ (${MAIN_HEAD:0:12})" >&2
jj rebase -s "roots((::${REMOTE_BOOKMARK}) ~ (::@))" -d @ >&2

# After rebase, the new tip is at the bookmark's position. Pin a local bookmark
# at that tip as the safety copy.
NEW_HEAD=$(jj log -r "$REMOTE_BOOKMARK" --no-graph -T 'commit_id' 2>/dev/null | head -1)
if [ -n "$NEW_HEAD" ]; then
  jj bookmark create "$BOOKMARK" -r "$NEW_HEAD" >&2 2>/dev/null || jj bookmark set "$BOOKMARK" -r "$NEW_HEAD" >&2
  echo "Local bookmark ${BOOKMARK} pinned at ${NEW_HEAD:0:12} (safety copy)" >&2
fi

# Sweep empty + no-description commits in the rebased range.
SWEEP_RANGE="(${MAIN_HEAD}::${NEW_HEAD}) ~ ${MAIN_HEAD} ~ ${NEW_HEAD} & empty() & description(exact:\"\")"
EMPTY_NODESC=$(jj log -r "$SWEEP_RANGE" --no-graph -T 'commit_id.short() ++ " "' 2>/dev/null || true)
if [ -n "$EMPTY_NODESC" ]; then
  echo "Abandoning empty + no-description commits: ${EMPTY_NODESC}" >&2
  # shellcheck disable=SC2086
  jj abandon $EMPTY_NODESC >&2 || true
fi

# Advance main's @ onto the new head.
if [ -n "$NEW_HEAD" ] && [ "$NEW_HEAD" != "$MAIN_HEAD" ]; then
  echo "Advancing main @ onto ${NEW_HEAD:0:12}" >&2
  jj new "$NEW_HEAD" >&2
fi

echo "" >&2
echo "Finalized clone ${NAME}. Bookmark ${BOOKMARK} preserved as safety copy." >&2
echo "Clone preserved at ${CLONE_DIR} for reuse." >&2
