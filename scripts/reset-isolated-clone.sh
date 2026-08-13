#!/bin/bash
# Reset an isolated clone back to main so it's ready for the next task.
#
# Preserves all agent-<name>-* branches as breadcrumbs for archaeology.
# Does NOT create a new branch — that's spawn's job.
#
# Usage:
#   echo <name> > /tmp/mpeek-agent-name
#   scripts/reset-isolated-clone.sh
#
# Called automatically by finalize-isolated-clone.sh after a successful
# fast-forward. Also usable standalone to abandon stale clone work without
# finalizing.

set -euo pipefail

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

if [ ! -d "$CLONE_DIR" ]; then
  echo "error: clone ${CLONE_DIR} does not exist" >&2
  exit 1
fi

cd "$CLONE_DIR"

# Fetch latest state from origin
git fetch origin >&2

# Detach HEAD onto origin/main and hard-reset the working tree. Detaching
# (rather than checking out a local branch) is what preserves the existing
# agent-* branches — checking one of them out here would let the next
# spawn's `git switch -C` silently overwrite it instead of leaving it as a
# breadcrumb.
git switch --detach origin/main >&2
git reset --hard >&2

echo "Reset clone ${NAME} to main (branches preserved)." >&2
