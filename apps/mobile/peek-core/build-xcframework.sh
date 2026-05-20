#!/usr/bin/env bash
# Build PeekCore.xcframework for iOS (device + simulator)
#
# Usage:
#   ./build-xcframework.sh          # Build both architectures + generate Swift bindings
#   ./build-xcframework.sh --sim    # Simulator only (faster for development)
#
# Output:
#   ./PeekCore.xcframework/         — Universal XCFramework for Xcode
#   ./generated/swift/peek_core.swift — Generated Swift bindings

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

TARGET_DIR="${SCRIPT_DIR}/target"
OUT_DIR="${SCRIPT_DIR}/generated/swift"
HEADER_DIR="${SCRIPT_DIR}/generated/headers"
XCFRAMEWORK_DIR="${SCRIPT_DIR}/PeekCore.xcframework"

SIM_TARGET="aarch64-apple-ios-sim"
DEVICE_TARGET="aarch64-apple-ios"

# Match the Xcode project iOS deployment target (see src-tauri/gen/apple/project.yml
# deploymentTarget.iOS = 16.0) so cc-compiled objects inside the static lib
# (e.g. sqlite3.o from rusqlite) do not emit "built for newer iOS version" linker
# warnings when Xcode links them into the app target.
export IPHONEOS_DEPLOYMENT_TARGET=16.0

SIM_ONLY=false
if [[ "${1:-}" == "--sim" ]]; then
    SIM_ONLY=true
fi

echo "=== Building peek-core for iOS ==="

# Step 1: Build static libraries
# Use cargo rustc with --crate-type to override Cargo.toml's crate-type list.
# Cargo.toml has ["lib", "staticlib", "cdylib"] for Android compatibility,
# but cdylib triggers full linking which can fail on iOS targets.
# iOS only needs staticlib to produce the .a file for XCFramework.
echo "--- Building for simulator ($SIM_TARGET) ---"
cargo rustc --lib --crate-type staticlib --release --target "$SIM_TARGET"

if [[ "$SIM_ONLY" == false ]]; then
    echo "--- Building for device ($DEVICE_TARGET) ---"
    cargo rustc --lib --crate-type staticlib --release --target "$DEVICE_TARGET"
fi

# Step 2: Generate Swift bindings from the simulator library
SIM_LIB="${TARGET_DIR}/${SIM_TARGET}/release/libpeek_core.a"

echo "--- Generating Swift bindings ---"
mkdir -p "$OUT_DIR" "$HEADER_DIR"

cargo run --bin uniffi-bindgen generate \
    --library "$SIM_LIB" \
    --language swift \
    --out-dir "$OUT_DIR"

# Step 3: Move the generated header and modulemap to header dir
# UniFFI generates: peek_coreFFI.h, peek_coreFFI.modulemap, peek_core.swift
mv "$OUT_DIR"/peek_coreFFI.h "$HEADER_DIR/"
mv "$OUT_DIR"/peek_coreFFI.modulemap "$HEADER_DIR/module.modulemap"

echo "--- Generated files ---"
ls -la "$OUT_DIR"/
ls -la "$HEADER_DIR"/

# Step 4: Create XCFramework
echo "--- Creating XCFramework ---"
rm -rf "$XCFRAMEWORK_DIR"

if [[ "$SIM_ONLY" == true ]]; then
    # Simulator-only framework
    xcodebuild -create-xcframework \
        -library "$SIM_LIB" \
        -headers "$HEADER_DIR" \
        -output "$XCFRAMEWORK_DIR"
else
    DEVICE_LIB="${TARGET_DIR}/${DEVICE_TARGET}/release/libpeek_core.a"

    xcodebuild -create-xcframework \
        -library "$DEVICE_LIB" \
        -headers "$HEADER_DIR" \
        -library "$SIM_LIB" \
        -headers "$HEADER_DIR" \
        -output "$XCFRAMEWORK_DIR"
fi

echo ""
echo "=== Done ==="
echo "XCFramework: $XCFRAMEWORK_DIR"
echo "Swift bindings: $OUT_DIR/peek_core.swift"
