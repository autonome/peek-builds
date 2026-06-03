#!/bin/bash
# Back up the production Peek desktop profile (the 'default' profile holding the
# user's real data) before installing a new build. READ-ONLY on the source.
#
# Usage:
#   scripts/backup-prod-profile.sh              # full profile (everything, GBs)
#   scripts/backup-prod-profile.sh --datastore  # just datastore.sqlite (+wal/shm)
#
# Only datastore.sqlite is migrated by a new app build, so --datastore is the
# sufficient safety net for a build test; the full profile also includes the
# (build-stable, regenerable) chromium storage + caches. Backups are timestamped
# under ~/Library/Application Support/Peek-backups/. Restore with
# scripts/restore-prod-profile.sh <backup-dir>.
set -euo pipefail

PROFILE="$HOME/Library/Application Support/Peek/default"
BACKUP_ROOT="$HOME/Library/Application Support/Peek-backups"
TS=$(date +%Y%m%d-%H%M%S)
MODE="${1:-full}"

if [ ! -d "$PROFILE" ]; then
  echo "error: prod profile not found: $PROFILE" >&2
  exit 1
fi
mkdir -p "$BACKUP_ROOT"

case "$MODE" in
  --datastore|datastore)
    DEST="$BACKUP_ROOT/prod-datastore-$TS"
    mkdir -p "$DEST"
    # Copy db + WAL + shm together so the snapshot is consistent.
    cp -p "$PROFILE/datastore.sqlite" "$DEST/"
    if [ -f "$PROFILE/datastore.sqlite-wal" ]; then cp -p "$PROFILE/datastore.sqlite-wal" "$DEST/"; fi
    if [ -f "$PROFILE/datastore.sqlite-shm" ]; then cp -p "$PROFILE/datastore.sqlite-shm" "$DEST/"; fi
    echo "Datastore backed up to: $DEST"
    ;;
  full)
    DEST="$BACKUP_ROOT/prod-full-$TS"
    mkdir -p "$DEST"
    rsync -a "$PROFILE/" "$DEST/"
    echo "Full profile backed up to: $DEST"
    ;;
  *)
    echo "usage: scripts/backup-prod-profile.sh [full|--datastore]" >&2
    exit 2
    ;;
esac
du -sh "$DEST"
