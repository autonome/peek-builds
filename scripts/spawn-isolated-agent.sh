#!/bin/bash
# Create an isolated jj workspace for a background agent.
#
# Usage: scripts/spawn-isolated-agent.sh <agent-name>
#
# Creates ../mpeek-agent-<name>/ as a jj workspace off the current @.
# Symlinks node_modules from the main workspace so the agent doesn't need
# to re-run yarn install. Prints the absolute path on stdout.
#
# Finalize with scripts/finalize-isolated-agent.sh <agent-name> when the
# agent is done — that rebases the agent's commits back into the main
# workspace and removes the isolated workspace.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <agent-name>" >&2
  exit 2
fi

NAME="$1"
MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WS_DIR="${MAIN_DIR}/../mpeek-agent-${NAME}"

if [ -e "$WS_DIR" ]; then
  echo "error: ${WS_DIR} already exists" >&2
  exit 1
fi

# Create workspace (jj workspace add creates the new directory and a working copy there).
cd "$MAIN_DIR"
jj workspace add "$WS_DIR" >&2

# Symlink node_modules so the agent can run yarn build / yarn test:unit without reinstall.
# Safe as long as package.json doesn't diverge during the agent's lifetime.
if [ -d "${MAIN_DIR}/node_modules" ]; then
  ln -s "${MAIN_DIR}/node_modules" "${WS_DIR}/node_modules"
fi

# Symlink .yarn/cache if present, same rationale.
if [ -d "${MAIN_DIR}/.yarn" ]; then
  # Don't symlink the whole .yarn — jj tracks install-state.gz. Only missing pieces.
  if [ ! -e "${WS_DIR}/.yarn/releases" ] && [ -d "${MAIN_DIR}/.yarn/releases" ]; then
    mkdir -p "${WS_DIR}/.yarn"
    ln -s "${MAIN_DIR}/.yarn/releases" "${WS_DIR}/.yarn/releases"
  fi
fi

# Print path for the caller to pass to the agent.
echo "$WS_DIR"
