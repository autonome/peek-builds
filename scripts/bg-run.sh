#!/usr/bin/env bash
# bg-run.sh — portable detached background runner for the `:bg` test family.
#
# Detaches a command so the terminal returns immediately AND the run survives
# the parent shell exiting (SIGHUP). macOS has no `setsid`, so this branches:
#   - Linux:  setsid -f      (new session leader, fully detached)
#   - macOS:  nohup … &      (ignore SIGHUP; the redirects + closed stdin
#                             sever the controlling tty, so it outlives the
#                             launching shell just like setsid does)
# stdout+stderr → <logfile>; stdin ← /dev/null so nothing ever blocks on a tty.
#
# Two hazards this script exists to defuse:
#
# 1. The yarn temp-shim race. Yarn 4 prepends a TEMPORARY shim dir to PATH
#    (basename `xfs-<hex>`, holding shims for yarn/node/electron/playwright)
#    and `rm -rf`s it when the launching yarn exits. A detached child resolves
#    its command at execvp — AFTER the fork — so it races that cleanup and
#    usually loses, dying instantly with "…/xfs-XXXX/yarn: No such file or
#    directory". We strip those entries from PATH before detaching, so the
#    child resolves against a permanent install instead. Safe because yarnrc
#    pins `yarnPath`: a launcher yarn re-execs the same pinned release.
#    (Do NOT "fix" this by capturing `command -v yarn` in the parent — that
#    resolves to the doomed shim itself and makes the race a certainty.)
#
# 2. Silent success. Backgrounding means `set -e` is inert and the script's
#    status reflects the fork, not the run — a dead-in-3ms child looked exactly
#    like a healthy 3600-test run. So: the child records its real exit code to
#    a sentinel file, the log always carries STARTED/EXIT banner lines, and we
#    check liveness before returning 0.
#
# Usage: scripts/bg-run.sh <logfile> <command> [args...]
#   e.g. scripts/bg-run.sh /tmp/test-electron.log yarn test:desktop:electron
# Side files, derived from <logfile>: <base>.exit (real exit code, written on
# completion) and <base>.pid (child pid, for the liveness check).
#
# <logfile> is taken as-is — this script has no opinion on the path. Callers (e.g.
# apps/desktop/package.json's `:bg` scripts) tag it via scripts/tagged-path.sh, which
# derives a suffix from the calling checkout's own worktree root, so two worktrees (or a
# worktree and the primary checkout) running the same gate at the same time don't share a
# log or a staging file. Do not flatten those tagged paths back to constants — that's what
# let one run's output silently clobber another's.
set -euo pipefail

# ---------------------------------------------------------------------------
# Child mode: re-entry into this same script, so the command's argv survives
# verbatim (no shell-quoting round-trip) while we still wrap it to record an
# exit code. Not part of the public interface.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--child" ]; then
  shift
  log="$1"; exitfile="$2"; pidfile="$3"
  shift 3

  echo "$$" >"$pidfile"
  {
    echo "bg-run: STARTED $* @$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$log" 2>&1

  set +e
  "$@" >>"$log" 2>&1 </dev/null
  code=$?
  set -e

  echo "bg-run: EXIT $code" >>"$log" 2>&1
  echo "$code" >"$exitfile"
  rm -f "$pidfile"
  exit "$code"
fi

# ---------------------------------------------------------------------------
# Parent mode
# ---------------------------------------------------------------------------
if [ "$#" -lt 2 ]; then
  echo "usage: bg-run.sh <logfile> <command> [args...]" >&2
  exit 2
fi

log="$1"
shift
base="${log%.log}"
exitfile="$base.exit"
pidfile="$base.pid"

# Stale state from a previous run must not be mistaken for this one's result.
rm -f "$exitfile" "$pidfile"

# --- 1. Strip yarn's temp shim dir(s) from PATH -----------------------------
# Match on the `xfs-<hex>` basename rather than a `*/T/xfs-*` full-path glob:
# the `/T/` segment is a macOS `$TMPDIR` artifact, and on Linux the same shim
# lands at /tmp/xfs-XXXX with no such segment.
clean_path=""
stripped=0
set -f            # no globbing while we word-split PATH
IFS=:
for p in $PATH; do
  case "${p##*/}" in
    xfs-*) stripped=1; continue ;;
  esac
  clean_path="${clean_path:+$clean_path:}$p"
done
unset IFS
set +f

if [ "$stripped" -eq 1 ] && ! PATH="$clean_path" command -v yarn >/dev/null 2>&1; then
  echo "bg-run: FATAL — yarn exists only inside yarn's temporary shim dir." >&2
  echo "  That dir is deleted when the launching yarn exits, so a detached" >&2
  echo "  child would die instantly. Install yarn permanently (e.g." >&2
  echo "  'brew install yarn') and retry. Refusing to detach." >&2
  exit 1
fi
PATH="$clean_path"
export PATH

# --- 2. Detach -------------------------------------------------------------
# No `nice -n 19` here. It used to be applied to exactly the process that most
# needs to hurry — the child racing yarn's shim-dir cleanup — and this is the
# gate a human is actively blocked on, so starving it buys nothing.
case "$(uname -s)" in
  Linux)
    # `setsid -f` returns the instant it forks, so $! is useless for liveness;
    # the pidfile the child writes is what we check instead.
    setsid -f "$0" --child "$log" "$exitfile" "$pidfile" "$@" >/dev/null 2>&1 </dev/null
    ;;
  *)
    # macOS / BSD: no setsid. nohup + & + closed stdin = detached & SIGHUP-proof.
    nohup "$0" --child "$log" "$exitfile" "$pidfile" "$@" >/dev/null 2>&1 </dev/null &
    ;;
esac

# --- 3. Fail loudly if the child is already dead ----------------------------
# Uniform across both branches (no reliance on $!, which Linux can't give us).
# Order matters: check for a completed run first, since a legitimately fast
# command is *supposed* to be gone by now.
sleep 1

if [ -f "$exitfile" ]; then
  code=$(cat "$exitfile")
  if [ "$code" -ne 0 ]; then
    echo "bg-run: FAILED — child exited $code within 1s. Log follows:" >&2
    cat "$log" >&2
    exit 1
  fi
  echo "bg-run: completed already, exit 0 → $log"
  exit 0
fi

if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "bg-run: detached → $log (tail with: yarn test:log)"
  echo "bg-run: exit code will land in $exitfile"
  exit 0
fi

# No exit code and no live pid: the child died without recording anything.
echo "bg-run: FAILED — child vanished without recording an exit code. Log follows:" >&2
cat "$log" >&2 2>/dev/null || echo "  (no log at $log — the command never started)" >&2
exit 1
