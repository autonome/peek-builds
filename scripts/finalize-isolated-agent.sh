#!/bin/bash
# Merge an isolated agent's commits back into the main workspace.
#
# Usage: scripts/finalize-isolated-agent.sh <agent-name>
#
# Rebases any commits the agent made onto the current main workspace @.
# Workspace and profile are PRESERVED for reuse by the next spawn.
#
# If the rebase is clean (all commits apply), the agent workspace's @ now
# tracks the rebased versions — it's effectively "idle" and can be reused
# via spawn-isolated-agent.sh <same-name>. If you want to tear it down,
# use scripts/clean-isolated-agent.sh.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <agent-name>" >&2
  exit 2
fi

NAME="$1"
MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WS_DIR="${MAIN_DIR}/../mpeek-agent-${NAME}"
WS_NAME="mpeek-agent-${NAME}"

if [ ! -d "$WS_DIR" ]; then
  echo "error: ${WS_DIR} does not exist" >&2
  exit 1
fi

cd "$MAIN_DIR"

# Agent's useful commits are at @- and below (not @ itself, which is the
# empty working-copy commit). Rebase range: commits reachable from the
# agent's @- but not from main workspace's @.
AGENT_PARENT="${WS_NAME}@-"

NEW_COMMITS=$(jj log -r "(::${AGENT_PARENT}) ~ (::@)" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null || true)

if [ -z "$NEW_COMMITS" ]; then
  echo "no new commits from ${WS_NAME} to rebase" >&2
  exit 0
fi

echo "Rebasing commits from ${AGENT_PARENT} onto current main workspace @" >&2
jj rebase -s "roots((::${AGENT_PARENT}) ~ (::@))" -d @ >&2

echo "finalized ${WS_NAME} — workspace preserved for reuse" >&2
