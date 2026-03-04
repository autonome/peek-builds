#!/bin/bash
# Script to build for Android device (release)
# Analogous to build-release.sh for iOS device
#
# Target: aarch64-linux-android (ARM64 device)
# Produces an APK or AAB for distribution
#
# Usage: ./build-android-release.sh [--force|-f] [--aab]

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
BUILD_AAB=false
while [ $# -gt 0 ]; do
    case "$1" in
        --force|-f)
            FORCE_REBUILD=true
            ;;
        --aab)
            BUILD_AAB=true
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--force|-f] [--aab]"
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

# custom-protocol is required so Tauri serves bundled assets
export TAURI_ANDROID_FEATURES="custom-protocol"

if [ "$BUILD_AAB" = true ]; then
    echo "Building Android release AAB (App Bundle for Play Store)..."
    npx tauri android build --aab
    echo ""
    echo "Done! Release AAB built."
    echo "AAB location: src-tauri/gen/android/app/build/outputs/bundle/release/"
else
    echo "Building Android release APK..."
    npx tauri android build --apk
    echo ""
    echo "Done! Release APK built."
    echo "APK location: src-tauri/gen/android/app/build/outputs/apk/release/"
fi

echo ""
echo "For Play Store distribution, use --aab flag for App Bundle format."
echo "For sideloading, the APK can be installed with: adb install <path-to-apk>"
