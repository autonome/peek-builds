#!/bin/bash
# Script to build for Android emulator (debug)
# Analogous to build-ios.sh for iOS simulator
#
# Target: x86_64-linux-android (emulator on x86_64 host)
# Also builds aarch64-linux-android for ARM emulator images
#
# Usage: ./build-android.sh [--force|-f]

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

if [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then
    echo "ERROR: Android NDK not found"
    echo "Install NDK via Android Studio SDK Manager"
    exit 1
fi

echo "ANDROID_HOME=$ANDROID_HOME"
echo "JAVA_HOME=$JAVA_HOME"
echo "NDK_HOME=$NDK_HOME"

# Parse flags
FORCE_REBUILD=false
while [ $# -gt 0 ]; do
    case "$1" in
        --force|-f)
            FORCE_REBUILD=true
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--force|-f]"
            exit 1
            ;;
    esac
    shift
done

cd "$SCRIPT_DIR"

if [ "$FORCE_REBUILD" = true ]; then
    echo "(Forcing Rust recompile...)"
    touch "$TAURI_DIR/src/lib.rs"
fi

# Ensure local.properties exists
if [ ! -f "$TAURI_DIR/gen/android/local.properties" ]; then
    echo "sdk.dir=$ANDROID_HOME" > "$TAURI_DIR/gen/android/local.properties"
    echo "Created local.properties"
fi

echo "Building frontend..."
npm run build

echo "Building Android debug APK..."
# custom-protocol is required so Tauri serves bundled assets via scheme handler
# Tauri's android build handles cargo cross-compilation and Gradle packaging
export TAURI_ANDROID_FEATURES="custom-protocol"
npx tauri android build --debug

echo ""
echo "Done! Debug APK built."
echo "Install on emulator: adb install <path-to-apk>"
echo "APK location: src-tauri/gen/android/app/build/outputs/apk/debug/"
