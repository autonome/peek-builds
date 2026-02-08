#!/bin/bash
# Start iOS simulator dev environment with a random available port.
# Usage: ./dev-ios-sim.sh
#
# This avoids port conflicts by picking a fresh port each run,
# patching tauri.conf.json temporarily, and restoring on exit.

set -e
cd "$(dirname "$0")"

# Pick a random available port
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
echo "[dev] Using port $PORT"

# Patch tauri.conf.json: add devUrl and beforeDevCommand
CONF=src-tauri/tauri.conf.json

# Save original for restoration
cp "$CONF" "$CONF.bak"

# Add devUrl and beforeDevCommand to the build section
python3 -c "
import json, sys
with open('$CONF') as f:
    c = json.load(f)
c['build']['devUrl'] = 'http://localhost:$PORT'
c['build']['beforeDevCommand'] = 'DEV_PORT=$PORT npm run dev'
with open('$CONF', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
"

echo "[dev] Patched tauri.conf.json with devUrl=http://localhost:$PORT"

# Restore tauri.conf.json on exit (any signal)
cleanup() {
  echo ""
  echo "[dev] Restoring tauri.conf.json..."
  mv "$CONF.bak" "$CONF"
  echo "[dev] Done."
}
trap cleanup EXIT

# Run cargo tauri ios dev (builds Rust in dev mode pointing to devUrl, starts vite, opens Xcode)
cd src-tauri && cargo tauri ios dev "iPhone 17 Pro"
