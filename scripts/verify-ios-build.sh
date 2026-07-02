#!/bin/bash
# Verify the app actually RUNNING on an iOS device/simulator is the current
# source build — defeats the stale-embedded-frontend footgun documented in
# .claude/skills/peek-device-verify/SKILL.md.
#
# The app writes its embedded build id (PEEK_BUILD_ID, baked into libapp.a at
# Rust compile time) to Documents/build-id.txt on every launch. This script
# launches the app, pulls that file, and compares it to the id recomputed from
# current source. Match => the device is running exactly this source. Mismatch
# => a stale build (e.g. an iOS-cache hit that skipped the frontend re-embed);
# rebuild with --force and reinstall.
#
# Usage:
#   scripts/verify-ios-build.sh device     # physical device (default)
#   scripts/verify-ios-build.sh sim        # booted simulator
#   DEVICE_ID=<udid> scripts/verify-ios-build.sh device
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/mobile"
TAURI_DIR="$APP_DIR/src-tauri"
BUNDLE_ID="com.dietrich.peek-mobile"
MODE="${1:-device}"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/ios-cache.sh"

EXPECTED="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)-$(get_source_hash "$TAURI_DIR" | cut -c1-12)"
echo "Expected (current source) build id: $EXPECTED"

TMP="$(mktemp -d)"
DEST="$TMP/build-id.txt"

if [ "$MODE" = "sim" ]; then
    xcrun simctl launch booted "$BUNDLE_ID" >/dev/null
    sleep 3
    CONTAINER="$(xcrun simctl get_app_container booted "$BUNDLE_ID" data 2>/dev/null || true)"
    if [ -z "$CONTAINER" ] || [ ! -f "$CONTAINER/Documents/build-id.txt" ]; then
        echo "FAIL: no Documents/build-id.txt on simulator (app not installed, or an old build without the marker)."
        exit 1
    fi
    cp "$CONTAINER/Documents/build-id.txt" "$DEST"
else
    DEVICE_ID="${DEVICE_ID:-$(xcrun devicectl list devices 2>/dev/null | grep -m1 -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}')}"
    if [ -z "$DEVICE_ID" ]; then
        echo "FAIL: no iOS device found (set DEVICE_ID=<udid>)."
        exit 1
    fi
    xcrun devicectl device process launch --terminate-existing --device "$DEVICE_ID" "$BUNDLE_ID" >/dev/null
    sleep 3
    if ! xcrun devicectl device copy from --device "$DEVICE_ID" \
            --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
            --source Documents/build-id.txt --destination "$DEST" >/dev/null 2>&1; then
        echo "FAIL: could not pull Documents/build-id.txt (app not installed, or an old build without the marker)."
        exit 1
    fi
fi

RUNNING="$(head -1 "$DEST")"
echo "Running (on-device)       build id: $RUNNING"

if [ "$RUNNING" = "$EXPECTED" ]; then
    echo "PASS — the device is running the current source build."
else
    echo "FAIL — the device is running a STALE build."
    echo "      The embedded frontend/Rust does not match current source. This is the"
    echo "      iOS-cache footgun: rebuild with --force (build-release.sh --force /"
    echo "      build-ios.sh --force) so libapp.a re-embeds, then reinstall and re-verify."
    exit 1
fi
