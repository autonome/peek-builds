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

# Guard the reserved "mobile" slot — clean only on explicit override.
# This slot persists Rust target/, Xcode derived data, libapp.a, xcframework
# outputs across sessions; tearing it down means re-paying ~2 min Rust cold
# build + xcode time on next mobile work.
if [ "$NAME" = "mobile" ] && [ "${MOBILE_FORCE_CLEAN:-}" != "1" ]; then
  echo "error: refusing to clean the reserved 'mobile' workspace slot." >&2
  echo "       this slot caches hours of Rust + Xcode build outputs." >&2
  echo "       to clean anyway: MOBILE_FORCE_CLEAN=1 scripts/clean-isolated-clone.sh" >&2
  exit 4
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

# Report the task association, if one was recorded at spawn time, before it's
# deleted along with the rest of the clone dir. Informational only.
if [ -r "${CLONE_DIR}/.clone-task" ]; then
  TASK_ID=$(grep '^task=' "${CLONE_DIR}/.clone-task" | cut -d= -f2-)
  echo "reclaiming clone ${NAME} — task ${TASK_ID}" >&2
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
