#!/bin/bash
# Start iOS simulator dev environment with HMR.
# Usage: ./dev-ios-sim.sh
#
# Patches tauri.conf.json with devUrl, rebuilds Rust + frontend,
# deploys to simulator, then starts vite for hot module replacement.
# First run is slow (Rust rebuild), subsequent runs reuse cache.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/src-tauri/tauri.conf.json"

# Use a stable default port, only pick a random one if it's in use
DEFAULT_PORT=5188
if python3 -c "import socket; s=socket.socket(); s.bind(('',${DEFAULT_PORT})); s.close()" 2>/dev/null; then
  PORT=$DEFAULT_PORT
else
  PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
  echo "[dev] Default port $DEFAULT_PORT in use, using $PORT instead"
fi
echo "[dev] Using port $PORT"

# Get the Mac's IP address for simulator to connect (can't use localhost in simulator)
HOST_IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo "127.0.0.1")
echo "[dev] Using host IP $HOST_IP"

# Save original tauri.conf.json for restoration
cp "$CONF" "$CONF.bak"

VITE_PID=""
cleanup() {
  echo ""
  if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
    echo "[dev] Stopping vite server..."
    kill "$VITE_PID" 2>/dev/null
    wait "$VITE_PID" 2>/dev/null
  fi
  echo "[dev] Restoring tauri.conf.json..."
  mv "$CONF.bak" "$CONF"
  echo "[dev] Done."
}
trap cleanup EXIT

# Patch tauri.conf.json with devUrl
python3 -c "
import json
with open('$CONF') as f:
    c = json.load(f)
c['build']['devUrl'] = 'http://$HOST_IP:$PORT'
with open('$CONF', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
"
echo "[dev] Patched tauri.conf.json with devUrl=http://$HOST_IP:$PORT"

# Bump build number
BUILD_FILE="$SCRIPT_DIR/BUILD_NUMBER"
BUILD_NUM=$(($(cat "$BUILD_FILE") + 1))
echo "$BUILD_NUM" > "$BUILD_FILE"
echo "[dev] Build number: v$BUILD_NUM"

# Rebuild Rust library (picks up devUrl from tauri.conf.json)
# Uses --force to ensure config change is picked up
# DEV_PORT tells build-ios.sh to patch the bootstrap HTML with the actual port
echo "[dev] Building Rust library with devUrl..."
cd "$SCRIPT_DIR" && DEV_PORT=$PORT ./build-ios.sh --force

# Build with xcodebuild
echo "[dev] Running xcodebuild..."
rm -rf /tmp/peek-xcodebuild-sim
cd "$SCRIPT_DIR/src-tauri/gen/apple" && xcodebuild \
  -scheme peek-save_iOS \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath /tmp/peek-xcodebuild-sim \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  clean build 2>&1 | tail -5

# Start vite dev server in background BEFORE launching app (avoids race condition)
echo "[dev] Starting HMR dev server on port $PORT..."
cd "$SCRIPT_DIR" && npx vite --host 0.0.0.0 --port $PORT &
VITE_PID=$!

# Wait for vite to be ready
echo "[dev] Waiting for vite server to be ready..."
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    echo "[dev] Vite server ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[dev] ERROR: Vite server did not start within 15 seconds"
    exit 1
  fi
  sleep 0.5
done

# Install and launch
echo "[dev] Installing to simulator..."
xcrun simctl install booted '/tmp/peek-xcodebuild-sim/Build/Products/debug-iphonesimulator/Peek Save.app'
xcrun simctl terminate booted com.dietrich.peek-mobile 2>/dev/null || true
xcrun simctl launch booted com.dietrich.peek-mobile
echo "[dev] App launched. HMR active — Ctrl+C to stop."

# Wait for vite to exit (blocks until Ctrl+C)
wait $VITE_PID
