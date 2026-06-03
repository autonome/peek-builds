#!/bin/bash
# Restore the production Peek desktop profile from a backup created by
# scripts/backup-prod-profile.sh.
#
# QUIT Peek first — AND any Claude Code session using the bundled Peek MCP.
# Anything with datastore.sqlite open will corrupt the restore; this script
# refuses while a /Applications/Peek.app process (GUI or MCP server) is running.
#
# Usage:
#   scripts/restore-prod-profile.sh <backup-dir>
set -euo pipefail

PROFILE="$HOME/Library/Application Support/Peek/default"
BACKUP_ROOT="$HOME/Library/Application Support/Peek-backups"
SRC="${1:-}"

if [ -z "$SRC" ]; then
  echo "usage: scripts/restore-prod-profile.sh <backup-dir>" >&2
  echo "" >&2
  echo "available backups (newest first):" >&2
  ls -1dt "$BACKUP_ROOT"/*/ >&2 2>/dev/null || echo "  (none in $BACKUP_ROOT)" >&2
  exit 2
fi
if [ ! -d "$SRC" ]; then
  echo "error: backup dir not found: $SRC" >&2
  exit 1
fi
if [ ! -f "$SRC/datastore.sqlite" ]; then
  echo "error: $SRC has no datastore.sqlite — not a Peek profile backup." >&2
  exit 1
fi
# Refuse while any Peek process holds the DB open (GUI or bundled MCP server).
if pgrep -f '/Applications/Peek.app/Contents/MacOS/Peek' >/dev/null 2>&1; then
  echo "error: a Peek process is running (GUI or its MCP server)." >&2
  echo "Quit Peek (Cmd+Q) and any Claude Code session using the Peek MCP, then retry." >&2
  exit 1
fi

if [ -d "$SRC/chromium" ]; then
  echo "Restoring FULL profile from: $SRC"
  echo "(makes $PROFILE exactly match the backup; removes anything added since)"
  rsync -a --delete "$SRC/" "$PROFILE/"
else
  echo "Restoring datastore only from: $SRC"
  cp -p "$SRC/datastore.sqlite" "$PROFILE/"
  # Replace/clear WAL+shm so a stale live WAL can't apply over the restored db.
  rm -f "$PROFILE/datastore.sqlite-wal" "$PROFILE/datastore.sqlite-shm"
  if [ -f "$SRC/datastore.sqlite-wal" ]; then cp -p "$SRC/datastore.sqlite-wal" "$PROFILE/"; fi
  if [ -f "$SRC/datastore.sqlite-shm" ]; then cp -p "$SRC/datastore.sqlite-shm" "$PROFILE/"; fi
fi
echo "Restore complete from: $SRC"
