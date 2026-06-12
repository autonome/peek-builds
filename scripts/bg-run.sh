#!/usr/bin/env bash
# bg-run.sh — portable detached background runner for the `:bg` test family.
#
# Detaches a command so the terminal returns immediately AND the run survives
# the parent shell exiting (SIGHUP). macOS has no `setsid`, so the previous
# `setsid -f …` recipe silently no-op'd here — this branches per platform:
#   - Linux:  setsid -f      (new session leader, fully detached)
#   - macOS:  nohup … &      (ignore SIGHUP; the redirects + closed stdin
#                             sever the controlling tty, so it outlives the
#                             launching shell just like setsid does)
# stdout+stderr → <logfile>; stdin ← /dev/null so nothing ever blocks on a tty.
# Runs at `nice -n 19` to stay off the foreground's back, matching the old
# recipe. The detached child reparents to init/launchd once we return.
#
# Usage: scripts/bg-run.sh <logfile> <command> [args...]
#   e.g. scripts/bg-run.sh /tmp/test-electron.log yarn test:desktop:electron
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: bg-run.sh <logfile> <command> [args...]" >&2
  exit 2
fi

log="$1"
shift

case "$(uname -s)" in
  Linux)
    setsid -f nice -n 19 "$@" >"$log" 2>&1 </dev/null
    ;;
  *)
    # macOS / BSD: no setsid. nohup + & + closed stdin = detached & SIGHUP-proof.
    nohup nice -n 19 "$@" >"$log" 2>&1 </dev/null &
    ;;
esac

echo "bg-run: detached → $log (tail with: yarn test:log)"
