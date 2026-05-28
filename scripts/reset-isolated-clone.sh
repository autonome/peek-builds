#!/bin/bash
# Reset an isolated clone back to main so it's ready for the next task.
#
# Preserves all agent-<name>-* bookmarks as breadcrumbs for archaeology.
# Does NOT create a new bookmark — that's spawn's job.
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
CLONE_DIR="${MAIN_DIR}/../mpeek-clone-${NAME}"

if [ ! -d "$CLONE_DIR" ]; then
  echo "error: clone ${CLONE_DIR} does not exist" >&2
  exit 1
fi

cd "$CLONE_DIR"

# Fetch latest state from origin
jj git fetch >&2

# Move working copy to main — leaves all bookmarks intact
jj new main@origin >&2

echo "Reset clone ${NAME} to main (bookmarks preserved)." >&2
