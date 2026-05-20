#!/bin/bash
# Build the full app (including Share Extension) and install on simulator
set -e

cd "$(dirname "$0")"

# Regenerate Xcode project from project.yml if xcodegen is available
if command -v xcodegen &> /dev/null; then
    echo "=== Regenerating Xcode project ==="
    xcodegen generate
fi

echo "=== Building full app with Share Extension ==="
xcodebuild \
    -scheme peek-save_iOS \
    -configuration debug \
    -sdk iphonesimulator \
    -derivedDataPath /tmp/peek-xcodebuild-sim \
    -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
    clean build 2>&1 | tee /tmp/peek-ext-build.log

echo "=== Installing on simulator ==="
xcrun simctl install booted '/tmp/peek-xcodebuild-sim/Build/Products/debug-iphonesimulator/Peek Save.app'

echo "=== Opening Safari ==="
xcrun simctl openurl booted https://example.com

echo "=== Done ==="
