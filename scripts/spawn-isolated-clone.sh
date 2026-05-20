#!/bin/bash
# Claim an isolated CLONE for a background agent.
#
# Differs from spawn-isolated-agent.sh: that script creates a jj WORKSPACE
# sharing .jj/ with the main checkout. THIS script creates a TRUE INDEPENDENT
# CLONE with its own .jj/ and .git/, eliminating both concurrent-edit hazards
# between agents and the orphan-commit hazard of git worktrees.
#
# Integration back into the main checkout happens via a registered git
# remote (pool-<name>) — finalize fetches the agent's bookmark and rebases
# in the main checkout. The main checkout's working state never changes
# unexpectedly because of an agent.
#
# Usage: scripts/spawn-isolated-clone.sh <name> [--base=<branch>]
#
# --base defaults to "main". Pass --base=apps-migration (or any other
# bookmark name) to base the clone's working copy on a different branch.
#
# Pool cap: 5. Policy, not enforced. Check `ls ../mpeek-clone-*` before
# adding a new slot.
#
# Prints two lines on stdout (other output to stderr):
#   <absolute-clone-path>
#   PROFILE=clone-<name>
#
# Finalize with scripts/finalize-isolated-clone.sh <name>.
# Tear down with scripts/clean-isolated-clone.sh <name>.

set -euo pipefail

# Name source (priority order):
#   1. $1 positional arg
#   2. $AGENT_NAME env var
#   3. /tmp/mpeek-agent-name file contents
NAME="${1:-${AGENT_NAME:-}}"
if [ -z "$NAME" ] && [ -r /tmp/mpeek-agent-name ]; then
  NAME=$(cat /tmp/mpeek-agent-name)
fi
if [ -z "$NAME" ]; then
  echo "usage: $0 <name> [--base=<branch>]   OR write name to /tmp/mpeek-agent-name" >&2
  exit 2
fi

# --base=<branch> override
BASE="main"
for arg in "$@"; do
  case "$arg" in
    --base=*) BASE="${arg#--base=}" ;;
  esac
done

MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLONE_DIR="${MAIN_DIR}/../mpeek-clone-${NAME}"
PROFILE="clone-${NAME}"
PROFILE_DIR="${HOME}/Library/Application Support/Peek/${PROFILE}"
TIMESTAMP=$(date +%s)
AGENT_BOOKMARK="agent-${NAME}-${TIMESTAMP}"
REMOTE_NAME="pool-${NAME}"

cd "$MAIN_DIR"

if [ ! -d "$CLONE_DIR" ]; then
  echo "Creating new clone at ${CLONE_DIR}" >&2
  jj git clone --colocate "$MAIN_DIR" "$CLONE_DIR" >&2
  cd "$MAIN_DIR"
  if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    git remote add "$REMOTE_NAME" "${CLONE_DIR}/.git"
    echo "Registered git remote ${REMOTE_NAME} pointing at ${CLONE_DIR}/.git" >&2
  fi
else
  echo "Reusing existing clone at ${CLONE_DIR}" >&2
fi

# Reset clone to current BASE and create a fresh bookmark.
cd "$CLONE_DIR"
jj git fetch >&2
jj new "$BASE" >&2
jj bookmark create "$AGENT_BOOKMARK" -r @ >&2
echo "Working copy set to ${BASE}; bookmark ${AGENT_BOOKMARK} created at @" >&2

# Symlink node_modules per package. Hash-check yarn.lock; refuse on drift.
# We do NOT symlink .yarn/releases — the clone gets the yarn binary from the
# git checkout. The trailing-slash-free `node_modules` gitignore pattern
# (in main's .gitignore) covers symlinks at those paths.
cd "$MAIN_DIR"
while IFS= read -r pkg; do
  pkg_dir=$(dirname "$pkg")
  rel_dir="${pkg_dir#./}"
  src_modules="${MAIN_DIR}/${rel_dir}/node_modules"
  src_lock="${MAIN_DIR}/${rel_dir}/yarn.lock"
  dst_modules="${CLONE_DIR}/${rel_dir}/node_modules"
  dst_lock="${CLONE_DIR}/${rel_dir}/yarn.lock"
  if [ ! -d "$src_modules" ]; then
    continue
  fi
  if [ -L "$dst_modules" ] || [ -d "$dst_modules" ]; then
    continue
  fi
  if [ -f "$src_lock" ] && [ -f "$dst_lock" ]; then
    src_hash=$(shasum -a 256 "$src_lock" | awk '{print $1}')
    dst_hash=$(shasum -a 256 "$dst_lock" | awk '{print $1}')
    if [ "$src_hash" != "$dst_hash" ]; then
      echo "error: yarn.lock drift in ${rel_dir} between main and clone." >&2
      echo "       refuse to symlink stale node_modules." >&2
      echo "       resolve by: clean-isolated-clone.sh ${NAME}, OR yarn install in the clone." >&2
      exit 3
    fi
  fi
  ln -s "$src_modules" "$dst_modules"
  echo "Symlinked ${rel_dir}/node_modules" >&2
done < <(find . -name package.json \
  -not -path '*/node_modules/*' \
  -not -path '*/.jj/*' \
  -not -path '*/.git/*' \
  -not -path '*/tmp/*' \
  -not -path '*/.claude/*' \
  -not -path '*/out/*' \
  -not -path '*/dist/*' \
  -maxdepth 4)

if [ -d "$PROFILE_DIR" ]; then
  rm -rf "$PROFILE_DIR"
  echo "Reset profile dir ${PROFILE_DIR}" >&2
fi

echo "$CLONE_DIR"
echo "PROFILE=${PROFILE}"
echo "" >&2
echo "Next: cd ${CLONE_DIR} && PROFILE=${PROFILE} yarn <script>" >&2
echo "Finalize with: scripts/finalize-isolated-clone.sh ${NAME}" >&2
