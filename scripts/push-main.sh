#!/bin/bash
# Push local `main` to tangled. The ONLY sanctioned path to publishing
# work — replaces the convention of `jj git push --bookmark main`.
#
# Usage:
#   scripts/push-main.sh           # preview what would be pushed; refuse to push
#   scripts/push-main.sh --yes     # push for real (still runs all checks)
#
# ## What it enforces
#
# 1. Local `main` is a strict descendant of `main@tangled`.
#    (Prevents accidental rewinds; refuses if local main is behind or sideways.)
# 2. No commits between `main@tangled` and `main` exist as divergent siblings.
#    (Catches the chaos-mode pattern where past rebases produced /0 /1 copies
#    of commits that are still hanging around — we don't want to push a copy
#    that has an alternate version on the remote already.)
# 3. Optional fetch-first: `--fetch` runs `jj git fetch --remote tangled` to
#    refresh the local view of `main@tangled` before checks.
#
# ## Post-push cleanup
#
# After a successful push, prunes any `pool-*` remote-tracking refs whose
# change_ids are now reachable from `main` — those refs held the OLD commit
# IDs from the clone-pool era. Keeping them around would let future
# `jj git fetch --remote tangled` resurrect divergent commits we just cleaned
# up.

set -euo pipefail

YES=0
FETCH=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --fetch) FETCH=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MAIN_DIR"

if [ "$FETCH" = 1 ]; then
  echo "Fetching from tangled..." >&2
  jj git fetch --remote tangled >&2
fi

# Resolve commit IDs.
MAIN_REV=$(jj log -r main --no-graph -T 'commit_id' 2>/dev/null | head -1)
TANGLED_REV=$(jj log -r 'main@tangled' --no-graph -T 'commit_id' 2>/dev/null | head -1)

if [ -z "$MAIN_REV" ]; then
  echo "error: local 'main' bookmark not found." >&2
  exit 1
fi
if [ -z "$TANGLED_REV" ]; then
  echo "error: 'main@tangled' not found — has tangled been fetched? Try --fetch." >&2
  exit 1
fi

# Same-commit: nothing to push.
if [ "$MAIN_REV" = "$TANGLED_REV" ]; then
  echo "main and main@tangled are at the same commit (${MAIN_REV:0:12}). Nothing to push." >&2
  exit 0
fi

# Check: is TANGLED_REV an ancestor of MAIN_REV? (i.e. main is a strict
# descendant of main@tangled — safe fast-forward push)
# jj DAG range X::Y = descendants(X) intersected with ancestors(Y). Empty iff
# X is NOT an ancestor of Y. The trailing `|| true` is needed because
# `head -1` exits after the first line, closing the pipe and triggering
# SIGPIPE on `jj log` — combined with `set -o pipefail` that would abort
# the script. We only care about whether the range is non-empty.
DAG_RANGE_HEAD=$(jj log -r "${TANGLED_REV}::${MAIN_REV}" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null | head -1 || true)
if [ -z "$DAG_RANGE_HEAD" ]; then
  echo "" >&2
  echo "ERROR: local 'main' is NOT a strict descendant of main@tangled." >&2
  echo "" >&2
  echo "  local main:      ${MAIN_REV:0:12}" >&2
  echo "  main@tangled:    ${TANGLED_REV:0:12}" >&2
  echo "" >&2
  echo "This means tangled has commits the local main doesn't include. Either:" >&2
  echo "  (a) someone (or a cron) pushed to tangled main since the last local fetch." >&2
  echo "      Run with --fetch to refresh, then re-run." >&2
  echo "  (b) local main was reset to an old position. Move it forward to include" >&2
  echo "      tangled's tip before re-running." >&2
  echo "" >&2
  echo "Push REFUSED to avoid losing work on tangled." >&2
  exit 5
fi

# List the commits we're about to push.
PUSH_RANGE="${TANGLED_REV}..${MAIN_REV}"
echo "" >&2
echo "Commits to push (${TANGLED_REV:0:12} → ${MAIN_REV:0:12}):" >&2
echo "" >&2
jj log -r "$PUSH_RANGE" --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"' >&2

# Check: any of those commit IDs have divergent siblings in the local jj?
# (Divergent siblings would mean we're pushing one of multiple versions of the
# same change_id — likely a re-occurrence of the chaos we cleaned up.)
PUSH_CHANGE_IDS=$(jj log -r "$PUSH_RANGE" --no-graph -T 'change_id ++ "\n"' 2>/dev/null)
DIVERGENT_HITS=""
for change_id in $PUSH_CHANGE_IDS; do
  count=$(jj log -r "change_id($change_id)" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -gt 1 ]; then
    DIVERGENT_HITS="${DIVERGENT_HITS} ${change_id}"
  fi
done
if [ -n "$DIVERGENT_HITS" ]; then
  echo "" >&2
  echo "WARNING: the following change_ids have divergent siblings in the local repo:" >&2
  for cid in $DIVERGENT_HITS; do
    echo "  ${cid}" >&2
  done
  echo "" >&2
  echo "Pushing one version means the alternates linger as orphans. Either:" >&2
  echo "  (a) Abandon the alternates first: jj abandon -r 'divergent() ~ ancestors(main)'" >&2
  echo "  (b) Accept the noise and push anyway (re-run with --yes if you've reviewed)." >&2
  echo "" >&2
  if [ "$YES" != 1 ]; then
    exit 5
  fi
fi

# Dry-run / preview mode.
if [ "$YES" != 1 ]; then
  echo "" >&2
  echo "(preview only — re-run with --yes to actually push)" >&2
  exit 0
fi

# Push for real.
echo "" >&2
echo "Pushing main to tangled..." >&2
jj git push --remote tangled --bookmark main >&2

# Post-push cleanup: prune pool-* remote-tracking refs whose change_ids are now
# reachable from main. Those refs held the OLD commit IDs from any prior
# rebase-style finalizes — keeping them lets future fetches resurrect divergence.
echo "" >&2
echo "Cleaning up stale pool-* remote-tracking refs..." >&2
PUSHED_CHANGE_IDS=$(jj log -r "${TANGLED_REV}..main" --no-graph -T 'change_id ++ "\n"' 2>/dev/null)
for change_id in $PUSHED_CHANGE_IDS; do
  # find any pool-*-tracked bookmark at the same change_id
  for bm in $(jj bookmark list --all-remotes -T 'name ++ "\n"' 2>/dev/null | grep '@pool-' | sort -u); do
    bm_change=$(jj log -r "$bm" --no-graph -T 'change_id' 2>/dev/null | head -1)
    if [ "$bm_change" = "$change_id" ]; then
      bm_name="${bm%@pool-*}"
      pool="${bm##*@}"
      echo "  pruning ${bm} (change_id now on main as commit ${bm_change:0:12})" >&2
      jj git push --remote "${pool#pool-}" --bookmark "$bm_name" --deleted 2>/dev/null || true
    fi
  done
done

echo "" >&2
echo "Push complete. main@tangled is now at ${MAIN_REV:0:12}." >&2
