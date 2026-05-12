#!/bin/bash
# Merge an isolated agent's commits back into the default jj workspace.
#
# Usage: scripts/finalize-isolated-agent.sh <agent-name>
#
# Rebases any commits the agent made onto the default workspace's @.
# Workspace and profile are PRESERVED for reuse by the next spawn.
#
# This does NOT touch the `main` bookmark/branch. It only moves commits
# between local jj workspaces (default <-- agent). Pushing to main is an
# explicit user action, never done here.
#
# If the rebase is clean (all commits apply), the agent workspace's @ now
# tracks the rebased versions — it's effectively "idle" and can be reused
# via spawn-isolated-agent.sh <same-name>. If you want to tear it down,
# use scripts/clean-isolated-agent.sh.

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

if [ ! -d "$AGENT_WS_DIR" ]; then
  echo "error: ${AGENT_WS_DIR} does not exist" >&2
  exit 1
fi

cd "$DEFAULT_WS_DIR"

# Agent's useful commits are at @- and below (not @ itself, which is the
# empty working-copy commit). Rebase range: commits reachable from the
# agent's @- but not from the default workspace's @.
AGENT_PARENT="${AGENT_WS_NAME}@-"

NEW_COMMITS=$(jj log -r "(::${AGENT_PARENT}) ~ (::@)" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null || true)

if [ -z "$NEW_COMMITS" ]; then
  echo "no new commits from ${AGENT_WS_NAME} to rebase" >&2
  exit 0
fi

echo "Rebasing commits from ${AGENT_PARENT} onto default workspace @" >&2
DEFAULT_HEAD=$(jj log -r @ --no-graph -T 'commit_id' | head -1)
jj rebase -s "roots((::${AGENT_PARENT}) ~ (::@))" -d @ >&2

# After rebase the agent's commits are children of default @ but default @
# itself hasn't moved. Capture the rebased tip before any cleanup.
NEW_HEAD=$(jj log -r "${AGENT_PARENT}" --no-graph -T 'commit_id' 2>/dev/null | head -1)

# Sweep empty + no-description commits in the rebased range.
# Agents accumulate these from `jj new` between work units (each fresh
# working copy is an empty placeholder until the next commit). Once
# the work is rebased here they're pure noise. Filter is conservative:
# BOTH empty AND no-description must hold — a description-less but
# content-bearing commit is preserved (might be WIP that got mislabeled).
SWEEP_RANGE="(${DEFAULT_HEAD}::${NEW_HEAD}) ~ ${DEFAULT_HEAD} ~ ${NEW_HEAD} & empty() & description(exact:\"\")"
EMPTY_NODESC=$(jj log -r "$SWEEP_RANGE" --no-graph -T 'commit_id.short() ++ " "' 2>/dev/null || true)
if [ -n "$EMPTY_NODESC" ]; then
  echo "Abandoning empty + no-description commits: ${EMPTY_NODESC}" >&2
  # shellcheck disable=SC2086
  jj abandon $EMPTY_NODESC >&2 || true
fi

# Advance default @ onto the rebased head so the next commit made in the
# default workspace includes the agent's work.
if [ -n "$NEW_HEAD" ] && [ "$NEW_HEAD" != "$DEFAULT_HEAD" ]; then
  echo "Advancing default workspace @ onto ${NEW_HEAD:0:12}" >&2
  jj new "$NEW_HEAD" >&2
fi

echo "finalized ${AGENT_WS_NAME} — workspace preserved for reuse" >&2
