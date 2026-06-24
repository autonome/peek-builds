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
cd "$SCRIPT_DIR"
npm run build

# Always copy frontend assets to Xcode location (even on Rust cache hit).
# Runtime serves from the binary-embedded bundle via custom-protocol; this
# copy is for Xcode project parity and any disk-resolved fallback paths.
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
        FRONTEND_DIST=$(python3 -c "import json; c=open('tauri.conf.json').read(); print(json.loads(c)['build']['frontendDist'])")
        echo "Done! iOS release library ready (frontendDist: $FRONTEND_DIST). Now rebuild in Xcode with Release scheme on your device."
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
# Use cargo rustc with --crate-type to override Cargo.toml's crate-type list.
# Cargo.toml has ["staticlib", "cdylib", "rlib"] for Android compatibility,
# but cdylib triggers full linking which fails on iOS because Swift FFI symbols
# (webview_plugin_*) are only provided by Xcode at final link time.
# iOS only needs staticlib to produce the .a file for Xcode.
# Bake in a build id (git rev + source hash) so the running app can prove it's
# this build on-device — see write_build_id_marker() and the peek-device-verify
# skill. Derived from source, so a verifier recomputes it identically.
export PEEK_BUILD_ID="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)-$(get_source_hash "$TAURI_DIR" | cut -c1-12)"
echo "Build id: $PEEK_BUILD_ID"
cargo rustc --lib --crate-type staticlib --release --features custom-protocol --target aarch64-apple-ios

echo "Copying library to Xcode location..."
mkdir -p "$DEST_DIR"
# Remove any existing symlink (macOS case-insensitive: release vs Release conflict)
rm -f "$DEST_PATH"
cp target/aarch64-apple-ios/release/libpeek_save_lib.a "$DEST_PATH"

# Update cache
if [ "$NO_CACHE" = false ]; then
    update_cache "release" "$TAURI_DIR" "$DEST_PATH"
fi

FRONTEND_DIST=$(python3 -c "import json; c=open('tauri.conf.json').read(); print(json.loads(c)['build']['frontendDist'])")
echo "Done! iOS release library built (frontendDist: $FRONTEND_DIST). Now rebuild in Xcode with Release scheme on your device."
