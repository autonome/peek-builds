#!/bin/bash
# Tear down an isolated agent workspace — remove the jj workspace, its
# directory, and its Electron profile data.
#
# Usage: scripts/clean-isolated-agent.sh <agent-name>
#
# Only call this when you want to fully reclaim the slot. For ongoing
# parallel work, prefer scripts/finalize-isolated-agent.sh which preserves
# the workspace for reuse.

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
MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WS_DIR="${MAIN_DIR}/../mpeek-agent-${NAME}"
WS_NAME="mpeek-agent-${NAME}"
PROFILE="agent-${NAME}"
PROFILE_DIR="${HOME}/Library/Application Support/Peek/${PROFILE}"

cd "$MAIN_DIR"

# Forget jj workspace if present.
if jj workspace list | awk '{print $1}' | grep -q "^${WS_NAME}:$"; then
  jj workspace forget "$WS_NAME" >&2
fi

# Remove workspace directory.
if [ -d "$WS_DIR" ]; then
  rm -rf "$WS_DIR"
fi

# Remove profile data.
if [ -d "$PROFILE_DIR" ]; then
  rm -rf "$PROFILE_DIR"
fi

echo "cleaned ${WS_NAME} and profile ${PROFILE}" >&2
