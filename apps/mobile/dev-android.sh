#!/bin/bash
# Start Android emulator dev environment with HMR.
# Usage: ./dev-android.sh
#
# Uses `tauri android dev` which handles:
# - Starting Vite with TAURI_DEV_HOST for mobile HMR
# - adb reverse port forwarding
# - Building APK, installing, and launching on emulator

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure ANDROID_HOME and JAVA_HOME are set
if [ -z "$ANDROID_HOME" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
fi

if [ -z "$JAVA_HOME" ]; then
    if [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
        export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    fi
fi

# Find NDK
if [ -z "$NDK_HOME" ]; then
    NDK_VERSION=$(ls "$ANDROID_HOME/ndk/" 2>/dev/null | sort -V | tail -1)
    if [ -n "$NDK_VERSION" ]; then
        export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
    fi
fi

# Validate environment
if [ ! -d "$ANDROID_HOME" ]; then
    echo "ERROR: Android SDK not found at $ANDROID_HOME"
    echo "Install Android Studio or set ANDROID_HOME"
    exit 1
fi

if [ -z "$JAVA_HOME" ] || [ ! -d "$JAVA_HOME" ]; then
    echo "ERROR: JAVA_HOME not found"
    echo "Install Android Studio or set JAVA_HOME"
    exit 1
fi

echo "ANDROID_HOME=$ANDROID_HOME"
echo "JAVA_HOME=$JAVA_HOME"
echo "NDK_HOME=$NDK_HOME"

# Ensure local.properties exists
TAURI_DIR="$SCRIPT_DIR/src-tauri"
if [ ! -f "$TAURI_DIR/gen/android/local.properties" ]; then
    mkdir -p "$TAURI_DIR/gen/android"
    echo "sdk.dir=$ANDROID_HOME" > "$TAURI_DIR/gen/android/local.properties"
    echo "Created local.properties"
fi

# Bump build number (auto-create if missing — fresh clones don't have this file)
BUILD_FILE="$SCRIPT_DIR/BUILD_NUMBER"
if [ ! -f "$BUILD_FILE" ]; then
  echo "0" > "$BUILD_FILE"
fi
BUILD_NUM=$(($(cat "$BUILD_FILE") + 1))
echo "$BUILD_NUM" > "$BUILD_FILE"
echo "[dev] Build number: v$BUILD_NUM"

# Start emulator if no devices connected
ADB="$ANDROID_HOME/platform-tools/adb"
if [ -x "$ADB" ]; then
    DEVICES=$("$ADB" devices 2>/dev/null | grep -c 'device$' || true)
    if [ "$DEVICES" -eq 0 ]; then
        echo "[dev] No Android devices/emulators found."
        EMULATOR="$ANDROID_HOME/emulator/emulator"
        if [ -x "$EMULATOR" ]; then
            AVD=$("$EMULATOR" -list-avds 2>/dev/null | head -1)
            if [ -n "$AVD" ]; then
                echo "[dev] Starting emulator: $AVD"
                "$EMULATOR" -avd "$AVD" -no-snapshot-load &
                echo "[dev] Waiting for emulator to boot..."
                "$ADB" wait-for-device
                # Wait for boot to complete
                while [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
                    sleep 1
                done
                echo "[dev] Emulator ready"
            else
                echo "ERROR: No AVDs found. Create one in Android Studio."
                exit 1
            fi
        else
            echo "ERROR: No emulator binary found. Connect a device or install an emulator."
            exit 1
        fi
    fi
fi

# Pre-set TAURI_CONFIG with the Android dev URL to eliminate the redundant
# second Rust compile.
#
# Background: `tauri android dev` runs TWO cargo builds:
#   1. Initial build (port 1420, direct Vite URL)
#   2. android-studio-script via Gradle (port 1430, ADB-forwarded URL)
#
# The two builds use different TAURI_CONFIG values → tauri-build emits
# cargo:rerun-if-env-changed=TAURI_CONFIG → build script reruns →
# regenerates Kotlin files → cascades to 5 crates (~12s wasted).
#
# Fix: pre-set TAURI_CONFIG to the ADB-forwarded URL (what android-studio-script
# uses) and pre-do the ADB reverse. If tauri-cli respects the parent env for
# the initial cargo build, both passes use identical TAURI_CONFIG → second
# pass is a cargo no-op. If tauri-cli overrides it anyway, this is a no-op
# (falls back to the original 12s behaviour, no regression).
#
# The port 1430 is tauri-cli's standard Android dev ADB forward port.
# Vite runs on port 1420; `adb reverse tcp:1430 tcp:1420` makes the emulator
# reach the host Vite server at 127.0.0.1:1430.
if [ -x "$ADB" ]; then
    "$ADB" reverse tcp:1430 tcp:1420 2>/dev/null || true
fi
export TAURI_CONFIG='{"build":{"devUrl":"http://127.0.0.1:1430"}}'

# Resolve tauri CLI - prefer apps/mobile/node_modules, fall back to repo root.
# Explicit path avoids two failure modes:
#   1. npx resolution fails on fresh pool clones (no per-app npm install state)
#   2. System cargo-tauri (e.g. 2.9.6) panics against our npm @tauri-apps/cli 2.10.x
# If neither path has the binary, run yarn install to bootstrap it.
TAURI_BIN="$SCRIPT_DIR/node_modules/.bin/tauri"
if [ ! -x "$TAURI_BIN" ]; then
  TAURI_BIN="$SCRIPT_DIR/../../node_modules/.bin/tauri"
fi
if [ ! -x "$TAURI_BIN" ]; then
  echo "[dev] tauri CLI not found — running yarn install to bootstrap node_modules..."
  cd "$SCRIPT_DIR"
  yarn install
  TAURI_BIN="$SCRIPT_DIR/node_modules/.bin/tauri"
fi
if [ ! -x "$TAURI_BIN" ]; then
  echo "ERROR: tauri CLI still not found after yarn install. Check package.json."
  exit 1
fi

# Let tauri android dev handle everything:
# - Starts Vite with TAURI_DEV_HOST set (for mobile HMR WebSocket config)
# - Sets up adb reverse port forwarding
# - Builds Rust + APK without custom-protocol
# - Installs and launches on device/emulator
echo "[dev] Starting tauri android dev..."
echo ""
cd "$SCRIPT_DIR"
"$TAURI_BIN" android dev
