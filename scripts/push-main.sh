#!/bin/bash
# Push local `main` to tangled. The ONLY sanctioned path to publishing
# work — replaces the convention of `git push tangled main` run ad hoc.
#
# Usage:
#   scripts/push-main.sh           # preview what would be pushed; refuse to push
#   scripts/push-main.sh --yes     # push for real (still runs all checks)
#   scripts/push-main.sh --yes --no-disruptive   # skip the disruptive suite
#
# ## What it enforces
#
# 1. Local `main` is a strict descendant of `tangled/main`.
#    (Prevents accidental rewinds; refuses if local main is behind or sideways.)
# 2. Optional fetch-first: `--fetch` runs `git fetch tangled` to refresh the
#    local view of `tangled/main` before checks.
# 3. The `desktop-disruptive` Playwright suite, when the push touches
#    apps/desktop/. See "The disruptive suite" below.
#
# ## The disruptive suite
#
# Some specs drive REAL native macOS fullscreen. Native fullscreen allocates its
# own Space and animates the display into it, and the app's headless mode works
# by `setOpacity(0)` — which hides painting but cannot suppress a
# window-manager-level transition. So those specs take over the display of
# whoever is at the machine, headless or not, and are excluded from the normal
# agent-facing runs (`yarn test:desktop:electron`, `yarn test:grep`) by living in
# their own Playwright project. This script is where they run instead: a push is
# deliberate, human-initiated, and rare.
#
# It runs only with --yes (the default preview stays instant), only on macOS, and
# only when the push range touches apps/desktop/. Off macOS it is skipped with a
# message, because Linux under Xvfb cannot produce native fullscreen and the
# suite fails there regardless of the code. `--no-disruptive` skips it on macOS —
# for pushing from a machine someone is actively using, or when the display is
# mid-presentation.
#
# It lives HERE rather than in `.githooks/pre-push` deliberately: a push through
# this script is human-initiated and rare, so gating it at the one chokepoint
# that issues the push is simpler than wiring a hook that every push path would
# need to trigger correctly.

set -euo pipefail

YES=0
FETCH=0
DISRUPTIVE=1
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --fetch) FETCH=1 ;;
    --no-disruptive) DISRUPTIVE=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MAIN_DIR"

if [ "$FETCH" = 1 ]; then
  echo "Fetching from tangled..." >&2
  git fetch tangled >&2
fi

# Resolve commit IDs.
MAIN_REV=$(git rev-parse main 2>/dev/null || true)
TANGLED_REV=$(git rev-parse tangled/main 2>/dev/null || true)

if [ -z "$MAIN_REV" ]; then
  echo "error: local 'main' branch not found." >&2
  exit 1
fi
if [ -z "$TANGLED_REV" ]; then
  echo "error: 'tangled/main' not found — has tangled been fetched? Try --fetch." >&2
  exit 1
fi

# Same-commit: nothing to push.
if [ "$MAIN_REV" = "$TANGLED_REV" ]; then
  echo "main and tangled/main are at the same commit (${MAIN_REV:0:12}). Nothing to push." >&2
  exit 0
fi

# Check: is TANGLED_REV an ancestor of MAIN_REV? (i.e. main is a strict
# descendant of tangled/main — safe fast-forward push)
if ! git merge-base --is-ancestor "$TANGLED_REV" "$MAIN_REV"; then
  echo "" >&2
  echo "ERROR: local 'main' is NOT a strict descendant of tangled/main." >&2
  echo "" >&2
  echo "  local main:      ${MAIN_REV:0:12}" >&2
  echo "  tangled/main:    ${TANGLED_REV:0:12}" >&2
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
git log --oneline "$PUSH_RANGE" >&2

# Dry-run / preview mode.
if [ "$YES" != 1 ]; then
  echo "" >&2
  echo "(preview only — re-run with --yes to actually push)" >&2
  exit 0
fi

# The disruptive suite (see header). Gated on the push actually touching the
# desktop app: these specs only cover apps/desktop, and a docs- or server-only
# push has no reason to hijack the display for a couple of minutes.
if [ "$DISRUPTIVE" = 1 ] && [ "$(uname -s)" != "Darwin" ]; then
  # The specs assert real native macOS fullscreen; Linux under Xvfb cannot
  # produce it, so the suite fails there whatever the code does.
  echo "" >&2
  echo "Skipping the desktop-disruptive suite (it needs native macOS fullscreen; this is $(uname -s))." >&2
  DISRUPTIVE=0
fi
if [ "$DISRUPTIVE" = 1 ]; then
  TOUCHES_DESKTOP=$(git diff --name-only "$TANGLED_REV" "$MAIN_REV" 2>/dev/null | grep -c '^apps/desktop/' || true)
  if [ "$TOUCHES_DESKTOP" -gt 0 ]; then
    echo "" >&2
    echo "Running the desktop-disruptive suite (${TOUCHES_DESKTOP} apps/desktop/ file(s) in this push)." >&2
    echo "HEADS UP: this drives REAL native macOS fullscreen — the display WILL flip" >&2
    echo "in and out of a fullscreen Space. Headless cannot hide that; that is exactly" >&2
    echo "why these specs are excluded from every other run. Re-run with" >&2
    echo "--no-disruptive to skip." >&2
    echo "" >&2
    if ! yarn test:desktop:disruptive >&2; then
      echo "" >&2
      echo "ERROR: the desktop-disruptive suite FAILED. Push REFUSED." >&2
      exit 6
    fi
    echo "" >&2
    echo "desktop-disruptive suite passed." >&2
  else
    echo "" >&2
    echo "Skipping the desktop-disruptive suite (this push touches no apps/desktop/ files)." >&2
  fi
fi

# Push for real.
echo "" >&2
echo "Pushing main to tangled..." >&2
git push tangled main >&2

echo "" >&2
echo "Push complete. tangled/main is now at ${MAIN_REV:0:12}." >&2
