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

# Bump build number
BUILD_FILE="$SCRIPT_DIR/BUILD_NUMBER"
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

# Let tauri android dev handle everything:
# - Starts Vite with TAURI_DEV_HOST set (for mobile HMR WebSocket config)
# - Sets up adb reverse port forwarding
# - Builds Rust + APK without custom-protocol
# - Installs and launches on device/emulator
echo "[dev] Starting tauri android dev..."
echo ""
cd "$SCRIPT_DIR"
npx tauri android dev
