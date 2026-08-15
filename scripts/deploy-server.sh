#!/bin/bash
# Deploy server to Railway by updating the deploy/server branch
# with apps/server/ contents at the root.
#
# NOTE: the final push in this script cannot succeed. This repository's
# remote is tangled, not GitHub, and pushing to github.com/autonome/peek
# is rejected with 403. Deploys are manual against Railway instead —
# see docs/server-backup-and-deploy.md. The subtree projection this
# script builds is still correct and useful as an input to that.
#
# Railway uses npm (not yarn). The deploy branch must not contain
# yarn.lock, otherwise Nixpacks will use yarn and fail.
set -e

# Find the repo root (where .git lives)
REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR="$REPO_ROOT"

if [ ! -d "$DIR/.git" ]; then
  echo "Error: could not find .git directory" >&2
  exit 1
fi

cd "$DIR"

echo "=== Server Deploy ==="
echo ""

# Auto-commit any pending changes
if [ -n "$(git status --porcelain)" ]; then
  echo ">>> Auto-committing pending changes..."
  git add -A
  git commit -m "chore: auto-commit for deploy"
fi

# Show what we're deploying
echo ""
echo ">>> Deploying from main:"
git log -1 --format='%H %s' main 2>/dev/null
echo ""

# Show recent commits that touched server
echo ">>> Recent commits touching apps/server/:"
git log -10 --format='%h %s' main -- apps/server/ 2>/dev/null | head -5
echo ""

# Ensure deploy/server branch exists
if ! git rev-parse --verify deploy/server &>/dev/null; then
  echo "Creating deploy/server branch..."
  git checkout --orphan deploy/server
  git rm -rf . 2>/dev/null || true
  git commit --allow-empty -m "Initial deploy/server branch"
  git checkout main
fi

# Create temp worktree for deploy branch
DEPLOY_DIR=$(mktemp -d)
trap "rm -rf $DEPLOY_DIR; git worktree remove $DEPLOY_DIR --force 2>/dev/null || true; git worktree prune 2>/dev/null || true" EXIT

# Clean any stale worktrees first
git worktree prune 2>/dev/null || true

git worktree add "$DEPLOY_DIR" deploy/server

# Read file content at the `main` commit (not the working tree) so the
# deploy branch reflects committed main regardless of what's checked out.
echo "Syncing apps/server/ to deploy branch..."
rm -rf "$DEPLOY_DIR"/* 2>/dev/null || true
git ls-tree -r --name-only main -- apps/server/ | while read f; do
  REL="${f#apps/server/}"
  [ "$REL" = "yarn.lock" ] && continue
  mkdir -p "$DEPLOY_DIR/$(dirname "$REL")"
  git show "main:$f" > "$DEPLOY_DIR/$REL"
done

# Commit and push if there are changes
cd "$DEPLOY_DIR"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "deploy: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo ">>> Deployed changes:"
  git log -1 --stat --oneline
  echo ""
else
  echo ">>> No changes to deploy"
fi

# Push to GitHub
git push github deploy/server --force-with-lease 2>/dev/null || git push github deploy/server -f
echo ""
echo ">>> Pushed deploy/server branch to GitHub"
echo ">>> Railway will auto-deploy from: https://github.com/autonome/peek/tree/deploy/server"
