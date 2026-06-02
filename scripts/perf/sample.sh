#!/usr/bin/env bash
# Comprehensive Peek resource sampler (perf epic d8e7efa5 / task ed717516).
# Per tick: window count, loading count, Electron procs-by-type {count, RSS, CPU%},
# WindowServer {RSS, CPU%}, and system {CPU user/sys/idle, PhysMem, load avg}.
# CPU% is computed from a cputime delta over DELTA seconds (true instantaneous load,
# NOT ps's lifetime-average %cpu which washes out spikes).
#
# Usage:  PROF=<profile> [ITERS=14] [INTERVAL=15] [DELTA=3] bash scripts/perf/sample.sh
#   PROF      profile name the app was launched with (e.g. a cloned prod profile). Default perfm.
#   ITERS     number of samples (default 14). Cover the load spike + a stable plateau.
#   INTERVAL  seconds between samples (default 15).
#   DELTA     CPU sampling window in seconds (default 3).
# See scripts/perf/README.md for the full measurement runbook.
cd "$(dirname "$0")/../.."
PROF="${PROF:-perfm}"
ITERS="${ITERS:-14}"
INTERVAL="${INTERVAL:-15}"
DELTA="${DELTA:-3}"
# Match Electron procs by --user-data-dir so the harness counts all helper procs
# (renderer, gpu, utility) correctly whether launched from the main checkout or a
# clone (clones symlink node_modules, so helpers resolve through the main checkout's
# dist path — a dist-path match would count only the browser process from a clone).
UDD="${HOME}/Library/Application Support/Peek/${PROF}"
TMPA="tmp/.psA.$$"
TMPB="tmp/.psB.$$"
mkdir -p tmp

for i in $(seq 1 "$ITERS"); do
  T=$(( (i-1) * INTERVAL ))
  WINS=$(PEEK_PROFILE=$PROF node scripts/peek-cli.mjs debug-list-windows 2>/dev/null | grep -c webContentsId)
  LOADING=$(PEEK_PROFILE=$PROF node scripts/peek-cli.mjs debug-list-windows 2>/dev/null | grep -c '"title": "Loading..."')

  ps -axo pid=,rss=,cputime=,command= > "$TMPA"
  sleep "$DELTA"
  ps -axo pid=,cputime= > "$TMPB"

  TOP=$(top -l 2 -n 0 -s 1 2>/dev/null)
  CPULINE=$(echo "$TOP" | grep 'CPU usage' | tail -1)
  MEMLINE=$(echo "$TOP" | grep 'PhysMem' | tail -1)
  LOADLINE=$(echo "$TOP" | grep -i 'Load Avg' | tail -1)

  echo "===== t=${T}s  windows=${WINS}  loading=${LOADING} ====="
  awk -v udd="$UDD" -v delta="$DELTA" '
    function cts(t,  a,n){ n=split(t,a,":"); if(n==2) return a[1]*60+a[2]; if(n==3) return a[1]*3600+a[2]*60+a[3]; return 0 }
    FNR==NR { ctb[$1]=$2; next }                      # TMPB: pid cputime (second snapshot)
    {
      pid=$1; rss=$2; cta=$3; line=$0;
      isElec=(index(line, udd) > 0); isWS=(line ~ /WindowServer/);
      if(!isElec && !isWS) next;
      cpu=(cts(ctb[pid]) - cts(cta))/delta*100; if(cpu<0) cpu=0;
      if(isWS){ wsR+=rss; wsC+=cpu; wsN++; next }
      type="browser";
      if(match(line,/--type=[a-z-]+/)) type=substr(line,RSTART+7,RLENGTH-7);
      cnt[type]++; mem[type]+=rss; cpu_t[type]+=cpu; tR+=rss; tC+=cpu; tN++;
    }
    END{
      for(t in cnt) printf "  %-14s %3d procs  %8.1f MB  %6.1f%% cpu\n", t, cnt[t], mem[t]/1024, cpu_t[t];
      printf "  %-14s %3d procs  %8.1f MB  %6.1f%% cpu\n", "ELECTRON TOT", tN, tR/1024, tC;
      printf "  %-14s %3d procs  %8.1f MB  %6.1f%% cpu\n", "WindowServer", wsN, wsR/1024, wsC;
    }' "$TMPB" "$TMPA"
  echo "  sys: ${CPULINE}"
  echo "  sys: ${MEMLINE}"
  echo "  sys: ${LOADLINE}"
  echo ""
  if [ "$i" -lt "$ITERS" ]; then sleep "$INTERVAL"; fi
done
rm -f "$TMPA" "$TMPB"
