#!/bin/bash
# Claim an isolated jj workspace for a background agent.
#
# Usage: scripts/spawn-isolated-agent.sh <agent-name>
#
# IF YOU'RE CONSIDERING THE Agent TOOL'S `isolation: "worktree"` PARAMETER:
# STOP. That creates a git worktree outside jj's view; commits made there
# are orphaned from the main jj stack and require manual recovery. Use this
# script instead — it creates a real jj workspace that shares state with
# the default checkout.
#
# Workspaces are pooled — this script REUSES existing mpeek-agent-<name>
# if one exists, resetting its working copy to match the default workspace's @.
# If it doesn't exist, it's created.
#
# "Default workspace" here = the jj workspace at /Users/dietrich/misc/mpeek,
# the one you cd into normally. This script does NOT touch the `main`
# bookmark/branch — pushing to main is always an explicit user action.
#
# Each agent gets a dedicated Electron profile (PROFILE=agent-<name>) so
# tests/dev don't race on DB, ports, or window state with other agents or
# the default workspace.
#
# Prints two lines on stdout:
#   <absolute-workspace-path>
#   PROFILE=agent-<name>
#
# Finalize with scripts/finalize-isolated-agent.sh <agent-name> to rebase
# the agent's commits into the default workspace. Workspace and profile
# are PRESERVED for reuse. Use scripts/clean-isolated-agent.sh to tear
# one down.

set -euo pipefail

# Name source (in priority order):
#   1. $1 positional arg (interactive / manual use)
#   2. $AGENT_NAME env var
#   3. /tmp/mpeek-agent-name file contents (used by Claude Code calls so the
#      invocation has no varying args and only needs one allowlist approval)
NAME="${1:-${AGENT_NAME:-}}"
if [ -z "$NAME" ] && [ -r /tmp/mpeek-agent-name ]; then
  NAME=$(cat /tmp/mpeek-agent-name)
fi
if [ -z "$NAME" ]; then
  echo "usage: $0 <agent-name>   OR write name to /tmp/mpeek-agent-name" >&2
  exit 2
fi
DEFAULT_WS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_WS_DIR="${DEFAULT_WS_DIR}/../mpeek-agent-${NAME}"
AGENT_WS_NAME="mpeek-agent-${NAME}"
PROFILE="agent-${NAME}"

cd "$DEFAULT_WS_DIR"

if [ -d "$AGENT_WS_DIR" ]; then
  # Reuse existing workspace. Reset its @ to the default workspace's @ so the
  # agent starts on top of current state, not whatever was there last time.
  (cd "$AGENT_WS_DIR" && jj new --no-edit "@" >/dev/null 2>&1) || true
  DEFAULT_AT=$(jj log -r @ --no-graph -T 'commit_id' 2>/dev/null | head -1)
  if [ -n "$DEFAULT_AT" ]; then
    (cd "$AGENT_WS_DIR" && jj new "$DEFAULT_AT" >/dev/null 2>&1) || true
  fi
else
  # Create new workspace.
  jj workspace add "$AGENT_WS_DIR" >&2

  # Symlink node_modules and .yarn/releases so agent can run yarn scripts.
  if [ -d "${DEFAULT_WS_DIR}/node_modules" ]; then
    ln -s "${DEFAULT_WS_DIR}/node_modules" "${AGENT_WS_DIR}/node_modules"
  fi
  if [ -d "${DEFAULT_WS_DIR}/.yarn/releases" ]; then
    mkdir -p "${AGENT_WS_DIR}/.yarn"
    ln -s "${DEFAULT_WS_DIR}/.yarn/releases" "${AGENT_WS_DIR}/.yarn/releases"
  fi
fi

# Reset the profile directory so the agent starts with clean state.
# Peek stores profile data at ~/Library/Application Support/Peek/<profile>/
PROFILE_DIR="${HOME}/Library/Application Support/Peek/${PROFILE}"
if [ -d "$PROFILE_DIR" ]; then
  rm -rf "$PROFILE_DIR"
fi

# Print workspace path and profile env var for the caller.
echo "$AGENT_WS_DIR"
echo "PROFILE=${PROFILE}"
