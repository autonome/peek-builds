#!/bin/bash
# Start Android emulator dev environment with HMR
# Analogous to dev-ios-sim.sh for iOS simulator
#
# Usage: ./dev-android.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"

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
if [ ! -f "$TAURI_DIR/gen/android/local.properties" ]; then
    echo "sdk.dir=$ANDROID_HOME" > "$TAURI_DIR/gen/android/local.properties"
    echo "Created local.properties"
fi

cd "$SCRIPT_DIR"

echo "Starting Android dev environment..."
echo "Tauri will build frontend, compile Rust, and launch on emulator with HMR"
echo ""

# custom-protocol needed for asset serving
export TAURI_ANDROID_FEATURES="custom-protocol"
npx tauri android dev
