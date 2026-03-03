#!/bin/bash
# Build the Peek Share Extension target only
set -e

cd "$(dirname "$0")"

# Regenerate Xcode project from project.yml if xcodegen is available
if command -v xcodegen &> /dev/null; then
    echo "=== Regenerating Xcode project ==="
    xcodegen generate
fi

echo "=== Building Peek Share Extension ==="
xcodebuild \
    -target Peek \
    -sdk iphonesimulator \
    -configuration debug \
    ONLY_ACTIVE_ARCH=YES \
    build 2>&1 | tee /tmp/peek-ext-build.log

echo "=== Build complete ==="
