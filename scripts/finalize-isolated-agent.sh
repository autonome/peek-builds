#!/bin/bash
# Merge an isolated agent's commits back into the main workspace and clean up.
#
# Usage: scripts/finalize-isolated-agent.sh <agent-name>
#
# Assumes the isolated workspace was created via spawn-isolated-agent.sh and
# named mpeek-agent-<name>. Rebases any commits the agent made (from the
# workspace's @- back to the shared ancestor with main workspace's @-) onto
# the current main workspace @.
#
# After rebase, forgets the workspace and removes its directory.

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

# Find the agent's head commit (the @- of the agent's workspace).
# jj workspace list shows: workspace_id  change_id  commit_id
# Grep by workspace name and extract the commit id.
AGENT_HEAD=$(jj workspace list | awk -v ws="$WS_NAME" '$1 == ws":" { print $NF }')

if [ -z "$AGENT_HEAD" ]; then
  echo "error: could not find workspace ${WS_NAME} in jj workspace list" >&2
  exit 1
fi

# The agent's working copy commit is usually empty (at tip). The useful commits
# are @-, @--, etc. back to the fork point. Rebase the roots of the agent's
# branch onto the main workspace's current @.
# `roots(::{agent}@ ~ ::@)` gives commits reachable from agent's tip but not
# from main's tip — i.e., the new commits the agent made.
AGENT_WORKSPACE_REF="${WS_NAME}@"
echo "Rebasing ${AGENT_WORKSPACE_REF} commits onto current main workspace @" >&2

# Use -r/-s to rebase. If the agent's tip is the working-copy empty commit,
# start from its parent. Let jj figure out the diff.
jj rebase -s "roots(::${AGENT_WORKSPACE_REF} ~ ::@)" -d @ >&2

# Forget the workspace (removes it from jj's tracking).
jj workspace forget "$WS_NAME" >&2

# Remove the directory.
rm -rf "$WS_DIR"

echo "finalized ${WS_NAME}" >&2
