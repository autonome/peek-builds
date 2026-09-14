#!/usr/bin/env bash
# tagged-path.sh — print the worktree-tagged /tmp path a :bg script (or a caller staging
# its input) uses in THIS checkout.
#
# Concurrent :bg runs from different worktrees (or the primary checkout) used to share one
# fixed /tmp path, so whichever run finished last silently overwrote the other's log and
# exit/pid sentinels. Each caller tags its path with the checkout's own identity instead:
#
#   tag="$(basename "$(git rev-parse --show-toplevel)")"
#
# — the worktree directory's basename, or the primary checkout's directory name. That's
# deterministic from repo location alone: no env var has to be set or exported for it to
# resolve correctly, so it holds for the primary checkout and for any shell that never
# inherited a runtime namespace, which `${TMPDIR:-/tmp}` alone would not — and unlike
# $TMPDIR, it isn't redirected to a per-user directory on macOS, so agents reading the log
# with the Read tool can predict the path without inspecting the environment.
#
# Usage: scripts/tagged-path.sh <name>
#   scripts/tagged-path.sh test-electron.log   ->  /tmp/test-electron-<tag>.log
#   scripts/tagged-path.sh test-spec           ->  /tmp/test-spec-<tag>
# The tag is inserted before the last extension when <name> has one, else appended.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: tagged-path.sh <name>" >&2
  exit 2
fi

tag="$(basename "$(git rev-parse --show-toplevel)")"
name="$1"

case "$name" in
  *.*)
    echo "/tmp/${name%.*}-${tag}.${name##*.}"
    ;;
  *)
    echo "/tmp/${name}-${tag}"
    ;;
esac
