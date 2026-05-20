#!/bin/bash
# Tear down an isolated clone: remove the clone dir, the registered git
# remote in the main checkout, the agent bookmark safety copy, and the
# clone's Electron profile dir.
#
# Usage: scripts/clean-isolated-clone.sh <name>
#
# Only call this when you want to fully reclaim the slot. For ongoing
# parallel work, prefer scripts/finalize-isolated-clone.sh which preserves
# the clone + bookmark for reuse.

set -euo pipefail

# Name read from /tmp/mpeek-agent-name only (see spawn-isolated-clone.sh for rationale).
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
PROFILE="clone-${NAME}"
PROFILE_DIR="${HOME}/Library/Application Support/Peek/${PROFILE}"

cd "$MAIN_DIR"

# Drop the git remote.
if git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git remote remove "$REMOTE_NAME"
  echo "Removed git remote ${REMOTE_NAME}" >&2
fi

# Drop any agent-<name>-* bookmarks (safety copies) in main.
BOOKMARKS=$(jj bookmark list -T 'name ++ "\n"' 2>/dev/null | grep "^agent-${NAME}-" || true)
if [ -n "$BOOKMARKS" ]; then
  for bm in $BOOKMARKS; do
    jj bookmark forget "$bm" >&2 || true
    echo "Forgot bookmark ${bm}" >&2
  done
fi

# Remove clone directory.
if [ -d "$CLONE_DIR" ]; then
  rm -rf "$CLONE_DIR"
  echo "Removed clone dir ${CLONE_DIR}" >&2
fi

# Remove profile dir.
if [ -d "$PROFILE_DIR" ]; then
  rm -rf "$PROFILE_DIR"
  echo "Removed profile dir ${PROFILE_DIR}" >&2
fi

echo "cleaned clone ${NAME}" >&2
