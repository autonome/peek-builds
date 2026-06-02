#!/usr/bin/env bash
# One-shot snapshot: top-level window count + Electron procs-by-type {count, RSS} (no CPU).
# Cheap single reading; use sample.sh for CPU + WindowServer + system + settle-over-time.
# Usage: PROF=<profile> bash scripts/perf/snapshot.sh "<label>"
cd "$(dirname "$0")/../.."
LABEL="${1:-snapshot}"
PROF="${PROF:-perfm}"
# Match Electron procs by --user-data-dir so the harness counts all helper procs
# (renderer, gpu, utility) correctly whether launched from the main checkout or a
# clone (clones symlink node_modules, so helpers resolve through the main checkout's
# dist path — a dist-path match would count only the browser process from a clone).
UDD="${HOME}/Library/Application Support/Peek/${PROF}"
echo "=== ${LABEL} (profile ${PROF}) ==="
WINS=$(PEEK_PROFILE=$PROF node scripts/peek-cli.mjs debug-list-windows 2>/dev/null | grep -c webContentsId)
echo "  windows (top-level): ${WINS}"
ps -axo pid=,rss=,command= \
  | awk -v udd="$UDD" '
    (index($0, udd) > 0) {
      rss=$2; type="browser";
      for(i=1;i<=NF;i++){ if($i ~ /^--type=/){ split($i,a,"="); type=a[2] } }
      count[type]++; mem[type]+=rss; total+=rss; n++; }
    END{
      for(t in count) printf "  %-16s %3d procs  %9.1f MB\n", t, count[t], mem[t]/1024;
      printf "  %-16s %3d procs  %9.1f MB\n", "TOTAL", n, total/1024;
    }'
echo ""
