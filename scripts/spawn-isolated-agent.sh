#!/bin/bash
# Claim an isolated jj workspace for a background agent.
#
# Usage: scripts/spawn-isolated-agent.sh <agent-name>
#
# Workspaces are pooled — this script REUSES existing mpeek-agent-<name>
# if one exists, resetting its working copy to match main workspace's @.
# If it doesn't exist, it's created.
#
# Each agent gets a dedicated Electron profile (PROFILE=agent-<name>) so
# tests/dev don't race on DB, ports, or window state with other agents or
# the main workspace.
#
# Prints two lines on stdout:
#   <absolute-workspace-path>
#   PROFILE=agent-<name>
#
# Finalize with scripts/finalize-isolated-agent.sh <agent-name> to merge
# the agent's commits back into the main workspace. The workspace and
# profile are PRESERVED for reuse. Use scripts/clean-isolated-agent.sh
# to actually tear one down.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <agent-name>" >&2
  exit 2
fi

NAME="$1"
MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WS_DIR="${MAIN_DIR}/../mpeek-agent-${NAME}"
WS_NAME="mpeek-agent-${NAME}"
PROFILE="agent-${NAME}"

cd "$MAIN_DIR"

if [ -d "$WS_DIR" ]; then
  # Reuse existing workspace. Reset its @ to main workspace's @ so the agent
  # starts on top of current main state, not whatever was there last time.
  # We do this by running jj new from the workspace's own perspective.
  (cd "$WS_DIR" && jj new --no-edit "@" >/dev/null 2>&1) || true
  # Ensure the workspace tracks current main @ by aborting any stale working
  # copy state and creating a new commit on top of the main workspace's @.
  MAIN_AT=$(jj log -r @ --no-graph -T 'commit_id' 2>/dev/null | head -1)
  if [ -n "$MAIN_AT" ]; then
    (cd "$WS_DIR" && jj new "$MAIN_AT" >/dev/null 2>&1) || true
  fi
else
  # Create new workspace.
  jj workspace add "$WS_DIR" >&2

  # Symlink node_modules and .yarn/releases so agent can run yarn scripts.
  if [ -d "${MAIN_DIR}/node_modules" ]; then
    ln -s "${MAIN_DIR}/node_modules" "${WS_DIR}/node_modules"
  fi
  if [ -d "${MAIN_DIR}/.yarn/releases" ]; then
    mkdir -p "${WS_DIR}/.yarn"
    ln -s "${MAIN_DIR}/.yarn/releases" "${WS_DIR}/.yarn/releases"
  fi
fi

# Reset the profile directory so the agent starts with clean state.
# Peek stores profile data at ~/Library/Application Support/Peek/<profile>/
PROFILE_DIR="${HOME}/Library/Application Support/Peek/${PROFILE}"
if [ -d "$PROFILE_DIR" ]; then
  rm -rf "$PROFILE_DIR"
fi

# Print workspace path and profile env var for the caller.
echo "$WS_DIR"
echo "PROFILE=${PROFILE}"
