#!/bin/bash
# Finalize a stack committed directly in the MAIN checkout by fast-forwarding
# the local `main` bookmark to the work tip. The main-checkout analogue of
# scripts/finalize-isolated-clone.sh (which handles ONLY pool clones).
#
# ## Why this exists
#
# Work committed in the main checkout with plain `jj commit` advances @ but
# NEVER the `main` bookmark — there is no auto-advance, and the two existing
# chokepoints don't cover this case: finalize-isolated-clone.sh is clone-only,
# and push-main.sh only PUSHES whatever `main` already points at (it never moves
# it forward). So a stack built in the main checkout strands `main` below it, and
# the only way anyone had to publish it was `jj bookmark set main` BY HAND — the
# exact move the repo rules forbid, because ad-hoc bookmark surgery is how the
# 2026-05-21 rebase-divergence chaos crept in. Three pushes in a row (2026-07-05
# .. -07) worked around this by hand. This script replaces that ritual with a
# guarded, fast-forward-ONLY chokepoint so nobody hand-moves `main` again.
#
# ## Semantics: fast-forward-or-bust
#
# Advances `main` only if the work tip is a STRICT DESCENDANT of the current
# `main`. It never rebases — rebasing rewrites commit_ids while remotes still
# track the originals, which manufactures divergent change_ids (the chaos). If
# `main` has moved ahead of your stack, rebase your work onto `main` first, then
# re-run.
#
# It does NOT push. Run scripts/push-main.sh afterward — that stays the sole
# pusher, and it runs its own strict-descendant + divergence gate before
# touching tangled.
#
# ## Usage
#
#   scripts/finalize-main-checkout-stack.sh          # preview what would advance
#   scripts/finalize-main-checkout-stack.sh --yes     # advance `main` for real
#   # then: scripts/push-main.sh          (preview)
#   #       scripts/push-main.sh --yes    (publish)

set -euo pipefail

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MAIN_DIR"

# ── Resolve the work tip ──────────────────────────────────────────────────
# @ if it carries a description (the work IS @); otherwise @- (jj-canonical:
# work is @-, @ is the empty placeholder left by a trailing `jj new`). Mirrors
# finalize-isolated-clone.sh's tip selection.
AT_DESC=$(jj log -r @ --no-graph -T 'description' 2>/dev/null)
if [ -n "$AT_DESC" ]; then
  WORK_TIP=$(jj log -r @ --no-graph -T 'commit_id' 2>/dev/null | head -1)
  TIP_LABEL="@"
else
  WORK_TIP=$(jj log -r '@-' --no-graph -T 'commit_id' 2>/dev/null | head -1)
  TIP_LABEL="@-"
fi
MAIN_REV=$(jj log -r main --no-graph -T 'commit_id' 2>/dev/null | head -1)

if [ -z "$WORK_TIP" ]; then
  echo "error: could not resolve work tip (${TIP_LABEL})." >&2
  exit 1
fi
if [ -z "$MAIN_REV" ]; then
  echo "error: local 'main' bookmark not found." >&2
  exit 1
fi

# Already at the tip: nothing to do.
if [ "$WORK_TIP" = "$MAIN_REV" ]; then
  echo "main is already at the work tip (${MAIN_REV:0:12}). Nothing to finalize." >&2
  exit 0
fi

# ── Strict-descendant (fast-forward) check ────────────────────────────────
# jj DAG range X::Y is empty iff X is NOT an ancestor of Y. The trailing
# `|| true` guards the SIGPIPE-from-`head` interaction under `set -o pipefail`
# (same reasoning as push-main.sh: head closes the pipe, jj log gets SIGPIPE,
# pipefail would otherwise abort the script).
DAG_RANGE_HEAD=$(jj log -r "${MAIN_REV}::${WORK_TIP}" --no-graph -T 'commit_id ++ "\n"' 2>/dev/null | head -1 || true)
if [ -z "$DAG_RANGE_HEAD" ]; then
  echo "" >&2
  echo "ERROR: the work tip is NOT a strict descendant of local 'main'." >&2
  echo "" >&2
  echo "  local main:   ${MAIN_REV:0:12}" >&2
  echo "  work tip:     ${WORK_TIP:0:12} (${TIP_LABEL})" >&2
  echo "" >&2
  echo "This is fast-forward-only and refuses to rebase. If 'main' moved ahead" >&2
  echo "of your stack, rebase your work onto it first, then re-run:" >&2
  echo "" >&2
  echo "  jj rebase -s 'roots(::@ ~ ::main)' -d main" >&2
  echo "" >&2
  exit 5
fi

# ── Preview the advance ───────────────────────────────────────────────────
echo "" >&2
echo "main would fast-forward (${MAIN_REV:0:12} → ${WORK_TIP:0:12}):" >&2
echo "" >&2
jj log -r "${MAIN_REV}..${WORK_TIP}" --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"' >&2

if [ "$YES" != 1 ]; then
  echo "" >&2
  echo "(preview only — re-run with --yes to advance 'main'," >&2
  echo " then scripts/push-main.sh to publish)" >&2
  exit 0
fi

# ── Fast-forward main ─────────────────────────────────────────────────────
# No --allow-backwards: the strict-descendant guard above proves this is a
# pure forward move, which `jj bookmark set` allows without the flag. Omitting
# it means a non-forward move (a bug in the guard) would fail loudly instead of
# silently rewinding `main`.
jj bookmark set main -r "$WORK_TIP" >&2
echo "" >&2
echo "Fast-forwarded main: ${MAIN_REV:0:12} → ${WORK_TIP:0:12}" >&2

# If the work tip WAS @ (no trailing empty placeholder), put a fresh empty @
# above it so the convention "@ rides above main" holds. When the tip was @-,
# @ is already that empty placeholder — leave it.
if [ "$TIP_LABEL" = "@" ]; then
  jj new "$WORK_TIP" >&2
fi

echo "" >&2
echo "Next: publish with scripts/push-main.sh (preview), then --yes." >&2
