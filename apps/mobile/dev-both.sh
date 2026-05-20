#!/bin/bash
# Start BOTH iOS simulator and Android emulator with HMR.
# Usage: ./dev-both.sh
#
# Architecture:
# 1. iOS: custom build pipeline + vite HMR server on port 5188
# 2. Android: `tauri android dev` (runs its own vite on port 1420, handles build/install/launch)
# 3. Ctrl+C cleans up everything

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/src-tauri/tauri.conf.json"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
PORT=5188
ADB=""
VITE_PID=""
EMULATOR_PID=""
TAURI_ANDROID_PID=""
IOS_OK=false
ANDROID_OK=false

ts() {
  date "+%H:%M:%S"
}

log() {
  echo "[$(ts)] $1"
}

# ── Environment setup ───────────────────────────────────────────────

# Kill any stale vite on our port
lsof -ti tcp:$PORT | xargs kill 2>/dev/null || true

# Get host IP (simulator/emulator both need this)
HOST_IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || echo "127.0.0.1")
log "Host IP: $HOST_IP"
log "HMR port: $PORT"

# Android env
if [ -z "$ANDROID_HOME" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
if [ -z "$JAVA_HOME" ]; then
    if [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
        export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    fi
fi
if [ -z "$NDK_HOME" ]; then
    NDK_VERSION=$(ls "$ANDROID_HOME/ndk/" 2>/dev/null | sort -V | tail -1)
    if [ -n "$NDK_VERSION" ]; then
        export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
    fi
fi

if [ -d "$ANDROID_HOME/platform-tools" ]; then
    ADB="$ANDROID_HOME/platform-tools/adb"
fi

# ── Backup and cleanup ─────────────────────────────────────────────

cp "$CONF" "$CONF.bak"

cleanup() {
    echo ""
    log "Cleaning up..."

    if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
        log "Stopping vite server..."
        kill "$VITE_PID" 2>/dev/null
        wait "$VITE_PID" 2>/dev/null || true
    fi

    if [ -n "$TAURI_ANDROID_PID" ] && kill -0 "$TAURI_ANDROID_PID" 2>/dev/null; then
        log "Stopping tauri android dev..."
        kill "$TAURI_ANDROID_PID" 2>/dev/null
        wait "$TAURI_ANDROID_PID" 2>/dev/null || true
    fi

    log "Restoring tauri.conf.json..."
    if [ -f "$CONF.bak" ]; then
        mv "$CONF.bak" "$CONF"
    fi

    log "Done."
}
trap cleanup EXIT

# ── Patch tauri.conf.json ───────────────────────────────────────────

python3 -c "
import json
with open('$CONF') as f:
    c = json.load(f)
c['build']['devUrl'] = 'http://$HOST_IP:$PORT'
c['build']['beforeBuildCommand'] = ''
with open('$CONF', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
"
log "Patched tauri.conf.json: devUrl=http://$HOST_IP:$PORT, beforeBuildCommand disabled"

# ── Bump build number (once for both) ──────────────────────────────

BUILD_FILE="$SCRIPT_DIR/BUILD_NUMBER"
BUILD_NUM=$(($(cat "$BUILD_FILE") + 1))
echo "$BUILD_NUM" > "$BUILD_FILE"
log "Build number: v$BUILD_NUM"

# ── Boot iOS simulator ────────────────────────────────────────────

boot_ios_simulator() {
    # Check if any simulator is already booted
    if xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
        log "[ios] Simulator already booted"
        return 0
    fi

    # Find an available iPhone simulator
    SIM_UDID=$(xcrun simctl list devices available -j 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if d.get('isAvailable') and 'iPhone' in d.get('name', ''):
            print(d['udid'])
            sys.exit(0)
" 2>/dev/null || true)

    if [ -z "$SIM_UDID" ]; then
        log "[ios] ERROR: No available iPhone simulator found"
        return 1
    fi

    SIM_NAME=$(xcrun simctl list devices available -j 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if d.get('udid') == '$SIM_UDID':
            print(d['name'])
            sys.exit(0)
" 2>/dev/null || true)

    log "[ios] Booting simulator: $SIM_NAME ($SIM_UDID)..."
    xcrun simctl boot "$SIM_UDID" 2>/dev/null || true
    open -a Simulator
    log "[ios] Simulator booted"
}

# ── Start Android emulator if needed ────────────────────────────────

start_android_emulator() {
    if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
        log "[android] ERROR: adb not found at $ADB"
        return 1
    fi

    DEVICES=$("$ADB" devices 2>/dev/null | grep -c 'device$' || true)
    if [ "$DEVICES" -eq 0 ]; then
        log "[android] No Android devices/emulators found, starting emulator..."
        EMULATOR="$ANDROID_HOME/emulator/emulator"
        if [ ! -x "$EMULATOR" ]; then
            log "[android] ERROR: emulator binary not found"
            return 1
        fi
        AVD=$("$EMULATOR" -list-avds 2>/dev/null | head -1)
        if [ -z "$AVD" ]; then
            log "[android] ERROR: No AVDs found. Create one in Android Studio."
            return 1
        fi
        log "[android] Starting emulator: $AVD"
        "$EMULATOR" -avd "$AVD" -no-snapshot-load &
        EMULATOR_PID=$!
        log "[android] Waiting for emulator to boot..."
        "$ADB" wait-for-device
        while [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
            sleep 1
        done
        log "[android] Emulator ready"
    else
        log "[android] Emulator/device already running ($DEVICES devices)"
    fi
    return 0
}

# Boot iOS simulator synchronously (fast if already booted)
boot_ios_simulator

# Start Android emulator in background (slow to boot)
start_android_emulator &
EMULATOR_BOOT_PID=$!

# ── Build iOS ───────────────────────────────────────────────────────

build_ios() {
    log "[ios] Building Rust library with devUrl..."
    cd "$SCRIPT_DIR"
    DEV_PORT=$PORT ./build-ios.sh --force

    log "[ios] Running xcodebuild..."
    rm -rf /tmp/peek-xcodebuild-sim
    cd "$TAURI_DIR/gen/apple"
    xcodebuild \
        -scheme peek-save_iOS \
        -configuration Debug \
        -sdk iphonesimulator \
        -derivedDataPath /tmp/peek-xcodebuild-sim \
        -destination 'generic/platform=iOS Simulator' \
        clean build 2>&1 | tail -5

    log "[ios] Installing to simulator..."
    xcrun simctl install booted '/tmp/peek-xcodebuild-sim/Build/Products/Debug-iphonesimulator/Peek Save.app'
    IOS_OK=true
    log "[ios] Build complete"
}

# ── Build Android ───────────────────────────────────────────────────

build_android() {
    # Validate Android env
    if [ ! -d "$ANDROID_HOME" ]; then
        log "[android] ERROR: Android SDK not found at $ANDROID_HOME"
        return 1
    fi
    if [ -z "$JAVA_HOME" ] || [ ! -d "$JAVA_HOME" ]; then
        log "[android] ERROR: JAVA_HOME not found"
        return 1
    fi

    log "[android] ANDROID_HOME=$ANDROID_HOME"
    log "[android] JAVA_HOME=$JAVA_HOME"
    log "[android] NDK_HOME=$NDK_HOME"

    # Ensure local.properties exists
    if [ ! -f "$TAURI_DIR/gen/android/local.properties" ]; then
        mkdir -p "$TAURI_DIR/gen/android"
        echo "sdk.dir=$ANDROID_HOME" > "$TAURI_DIR/gen/android/local.properties"
        log "[android] Created local.properties"
    fi

    # Wait for emulator boot to finish
    wait $EMULATOR_BOOT_PID 2>/dev/null || true

    # Restore original tauri.conf.json — `tauri android dev` needs an unpatched
    # config so it starts its own vite and sets devUrl itself.
    # iOS build is already complete by this point, so it's safe to restore.
    log "[android] Restoring tauri.conf.json for tauri android dev..."
    cp "$CONF.bak" "$CONF"

    # Use `tauri android dev` which handles everything:
    # - Starts its own Vite server (on default port 1420)
    # - Sets up adb reverse port forwarding
    # - Builds Rust + APK
    # - Installs and launches on emulator
    # Runs in background so we can also serve iOS.
    log "[android] Starting tauri android dev (runs its own vite + builds + installs)..."
    cd "$SCRIPT_DIR"
    npx tauri android dev &
    TAURI_ANDROID_PID=$!

    ANDROID_OK=true
    log "[android] tauri android dev started (PID $TAURI_ANDROID_PID)"
}

# ── Run builds ──────────────────────────────────────────────────────
# iOS uses our custom build pipeline; Android uses tauri android dev
# which handles its own vite + build + install + launch.

log "Starting builds..."

# Build iOS first
build_ios || log "[ios] BUILD FAILED (continuing with Android)"

# Build Android second
build_android || log "[android] BUILD FAILED (continuing)"

if [ "$IOS_OK" = false ] && [ "$ANDROID_OK" = false ]; then
    log "ERROR: Both builds failed. Exiting."
    exit 1
fi

# ── Start vite HMR server ──────────────────────────────────────────

log "Starting HMR dev server on 0.0.0.0:$PORT..."
cd "$SCRIPT_DIR"
npx vite --host 0.0.0.0 --port $PORT &
VITE_PID=$!

# Wait for vite to be ready
log "Waiting for vite server..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
        log "Vite server ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        log "ERROR: Vite server did not start within 15 seconds"
        exit 1
    fi
    sleep 0.5
done

# ── Launch iOS app ──────────────────────────────────────────────────
# Android launch is handled by `tauri android dev`

if [ "$IOS_OK" = true ]; then
    log "[ios] Launching app..."
    xcrun simctl terminate booted com.dietrich.peek-mobile 2>/dev/null || true
    if xcrun simctl launch booted com.dietrich.peek-mobile; then
        log "[ios] App launched"
    else
        log "[ios] WARNING: Failed to launch app (is simulator booted?)"
    fi
fi

# ── Summary ─────────────────────────────────────────────────────────

echo ""
log "================================================"
log "  Both platforms running with HMR"
log "  iOS Vite: http://0.0.0.0:$PORT"
log "  Android Vite: managed by tauri android dev"
log "  Build: v$BUILD_NUM"
if [ "$IOS_OK" = true ]; then
    log "  iOS simulator: RUNNING"
else
    log "  iOS simulator: FAILED"
fi
if [ "$ANDROID_OK" = true ]; then
    log "  Android emulator: RUNNING"
else
    log "  Android emulator: FAILED"
fi
log "  Press Ctrl+C to stop"
log "================================================"
echo ""

# Block on both background processes (Ctrl+C kills everything via trap)
wait $VITE_PID $TAURI_ANDROID_PID 2>/dev/null
