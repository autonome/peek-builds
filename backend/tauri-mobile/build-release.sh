#!/bin/bash
# Script to build Rust library for iOS device (release)
# Uses shared cache to avoid rebuilds across agent workspaces

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
DEST_DIR="$TAURI_DIR/gen/apple/Externals/arm64/Release"
DEST_PATH="$DEST_DIR/libapp.a"

# Source cache utilities
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/scripts/ios-cache.sh"

# Parse flags
FORCE_REBUILD=false
NO_CACHE=false
while [ $# -gt 0 ]; do
    case "$1" in
        --force|-f)
            FORCE_REBUILD=true
            ;;
        --no-cache)
            NO_CACHE=true
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--force|-f] [--no-cache]"
            exit 1
            ;;
    esac
    shift
done

echo "Building frontend..."
npm run build

# Always copy frontend assets to Xcode location (even on Rust cache hit)
echo "Copying frontend assets..."
rm -rf "$TAURI_DIR/gen/apple/assets"
cp -R "$SCRIPT_DIR/dist" "$TAURI_DIR/gen/apple/assets"

cd "$TAURI_DIR"

# Check cache unless forced or disabled
if [ "$FORCE_REBUILD" = false ] && [ "$NO_CACHE" = false ]; then
    if check_cache "release" "$TAURI_DIR"; then
        mkdir -p "$DEST_DIR"
        # Remove any existing symlink (macOS case-insensitive: release vs Release conflict)
        rm -f "$DEST_PATH"
        use_cache "release" "$DEST_PATH"
        echo "Done! Now rebuild in Xcode with Release scheme on your device."
        exit 0
    fi
fi

# Build
if [ "$FORCE_REBUILD" = true ]; then
    echo "(Forcing Rust recompile...)"
    touch src/lib.rs
fi

echo "Building Rust for iOS device (release)..."
# Match the Xcode project's deployment target so cc-compiled objects
# don't emit "built for newer iOS" linker warnings
export IPHONEOS_DEPLOYMENT_TARGET=16.0
# Build only the lib target - the bin target would fail to link because
# Swift FFI symbols (webview_plugin_*) are provided by Xcode at final link time
# Use custom-protocol feature for bundled assets (not dev server)
cargo build --lib --release --features custom-protocol --target aarch64-apple-ios

echo "Copying library to Xcode location..."
mkdir -p "$DEST_DIR"
# Remove any existing symlink (macOS case-insensitive: release vs Release conflict)
rm -f "$DEST_PATH"
cp target/aarch64-apple-ios/release/libpeek_save_lib.a "$DEST_PATH"

# Copy frontend assets to Xcode location (normally done by cargo tauri build)
echo "Copying frontend assets..."
rm -rf "$TAURI_DIR/gen/apple/assets"
cp -R "$SCRIPT_DIR/dist" "$TAURI_DIR/gen/apple/assets"

# Update cache
if [ "$NO_CACHE" = false ]; then
    update_cache "release" "$TAURI_DIR" "$DEST_PATH"
fi

echo "Done! Now rebuild in Xcode with Release scheme on your device."
