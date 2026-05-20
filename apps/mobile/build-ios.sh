#!/bin/bash
# Script to build Rust library for iOS simulator (debug)
# Uses shared cache to avoid rebuilds across agent workspaces
#
# Always performs a standalone build: runs `npm run build` to produce the real
# Vite bundle in dist/, then embeds whatever frontendDist points to in
# tauri.conf.json at Rust compile time. Never mutates dist/index.html.
# For dev mode, dev-ios-sim.sh patches frontendDist to ../dev-shim before
# calling this script.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
DEST_DIR="$TAURI_DIR/gen/apple/Externals/arm64/Debug"
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

cd "$TAURI_DIR"

# Check cache unless forced or disabled
if [ "$FORCE_REBUILD" = false ] && [ "$NO_CACHE" = false ]; then
    if check_cache "debug" "$TAURI_DIR"; then
        mkdir -p "$DEST_DIR"
        use_cache "debug" "$DEST_PATH"
        echo "✓ iOS debug library ready at $DEST_PATH (from cache)"
        exit 0
    fi
fi

# Build
if [ "$FORCE_REBUILD" = true ]; then
    echo "(Forcing Rust recompile...)"
    touch src/lib.rs
fi

# Build real Vite bundle into dist/ (never overwritten by this script)
echo "Building frontend..."
cd "$SCRIPT_DIR"
npm run build
cd "$TAURI_DIR"

# Copy dist/index.html to gen/apple/assets/ for parity (runtime serves from
# the embedded binary, but keep the copy so asset paths resolve consistently)
echo "Embedding bundled frontend..."
mkdir -p "$TAURI_DIR/gen/apple/assets"
cp "$SCRIPT_DIR/dist/index.html" "$TAURI_DIR/gen/apple/assets/index.html"

echo "Building Rust for iOS simulator (debug)..."
# Match the Xcode project's deployment target so cc-compiled objects
# don't emit "built for newer iOS-simulator" linker warnings
export IPHONEOS_DEPLOYMENT_TARGET=16.0
# Build only the lib target - the bin target would fail to link because
# Swift FFI symbols (webview_plugin_*) are provided by Xcode at final link time
# custom-protocol is required so Tauri serves bundled assets via scheme handler;
# tauri_build embeds whatever frontendDist points to in tauri.conf.json at
# compile time — dev-ios-sim.sh patches that to ../dev-shim before calling here.
# Use cargo rustc with --crate-type to override Cargo.toml's crate-type list.
# Cargo.toml has ["staticlib", "cdylib", "rlib"] for Android compatibility,
# but cdylib triggers full linking which fails on iOS because Swift FFI symbols
# (webview_plugin_*) are only provided by Xcode at final link time.
# iOS only needs staticlib to produce the .a file for Xcode.
cargo rustc --lib --crate-type staticlib --target aarch64-apple-ios-sim --features custom-protocol

# Copy to Xcode location
mkdir -p "$DEST_DIR"
cp target/aarch64-apple-ios-sim/debug/libpeek_save_lib.a "$DEST_PATH"

# Update cache
if [ "$NO_CACHE" = false ]; then
    update_cache "debug" "$TAURI_DIR" "$DEST_PATH"
fi

FRONTEND_DIST=$(python3 -c "import json; c=open('tauri.conf.json').read(); print(json.loads(c)['build']['frontendDist'])")
echo "✓ iOS debug library built (frontendDist: $FRONTEND_DIST)"
