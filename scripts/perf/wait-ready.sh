#!/usr/bin/env bash
# Poll a launched Peek's IPC sock until it is up and returning windows, then print them.
# Usage: PROF=<profile> bash scripts/perf/wait-ready.sh
cd "$(dirname "$0")/../.."
PROF="${PROF:-perfm}"
for i in $(seq 1 180); do
  if PEEK_PROFILE=$PROF node scripts/peek-cli.mjs debug-list-windows 2>/dev/null | grep -q webContentsId; then
    echo "READY after ${i}s (profile ${PROF})"
    PEEK_PROFILE=$PROF node scripts/peek-cli.mjs debug-list-windows 2>/dev/null
    exit 0
  fi
  sleep 1
done
echo "TIMEOUT waiting for Peek (profile ${PROF})"
exit 1
