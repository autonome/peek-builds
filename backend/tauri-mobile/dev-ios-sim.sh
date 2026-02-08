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

# Pick a random available port
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
echo "[dev] Using port $PORT"

# Save original tauri.conf.json for restoration
cp "$CONF" "$CONF.bak"

cleanup() {
  echo ""
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
c['build']['devUrl'] = 'http://localhost:$PORT'
with open('$CONF', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
"
echo "[dev] Patched tauri.conf.json with devUrl=http://localhost:$PORT"

# Bump build number
BUILD_FILE="$SCRIPT_DIR/BUILD_NUMBER"
BUILD_NUM=$(($(cat "$BUILD_FILE") + 1))
echo "$BUILD_NUM" > "$BUILD_FILE"
echo "[dev] Build number: v$BUILD_NUM"

# Rebuild Rust library (picks up devUrl from tauri.conf.json)
# Uses --force to ensure config change is picked up
echo "[dev] Building Rust library with devUrl..."
cd "$SCRIPT_DIR" && ./build-ios.sh --force

# Build with xcodebuild
echo "[dev] Running xcodebuild..."
rm -rf /tmp/peek-xcodebuild
cd "$SCRIPT_DIR/src-tauri/gen/apple" && xcodebuild \
  -scheme peek-save_iOS \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath /tmp/peek-xcodebuild \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  clean build 2>&1 | tail -5

# Install and launch
echo "[dev] Installing to simulator..."
xcrun simctl install booted '/tmp/peek-xcodebuild/Build/Products/debug-iphonesimulator/Peek Save.app'
xcrun simctl terminate booted com.dietrich.peek-mobile 2>/dev/null || true
xcrun simctl launch booted com.dietrich.peek-mobile
echo "[dev] App launched, starting HMR dev server on port $PORT..."

# Start vite dev server (blocks — HMR active until Ctrl+C)
cd "$SCRIPT_DIR" && DEV_PORT=$PORT npx vite --port $PORT
