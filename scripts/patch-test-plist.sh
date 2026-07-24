#!/usr/bin/env bash
#
# patch-test-plist.sh — set LSUIElement=true on a TEST Electron/Peek app bundle.
#
# WHY: on macOS the OS activates each fresh Electron process frontmost BEFORE
# any JS runs, so app.setActivationPolicy('accessory') (main/headless-policy.ts)
# is too late to stop the launch-time focus grab. The test suite launches ~140
# Electron processes, so that blip becomes a repeated focus theft from whoever
# is at the machine. The ONLY pre-JS suppressor is LSUIElement=true in the
# bundle's Info.plist — it makes the process a UI-element (accessory) app from
# the moment it launches, before any code runs.
#
# This is TEST-ONLY. It must NEVER touch the production bundle
# (out/…/Peek.app used by build:electron:install → /Applications) or the dev
# `yarn start` binary — only the bundle a headless test run drives. Callers gate
# that: it is invoked exclusively from the test:desktop:electron[:x] scripts
# (packaged path) and from the test-only globalSetup copy (source path).
#
# Idempotent: safe to run repeatedly on the same bundle.
#
# Usage: patch-test-plist.sh <path-to-app-bundle>
set -euo pipefail

APP="${1:?usage: patch-test-plist.sh <path-to-.app>}"
PLIST="$APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "patch-test-plist: no Info.plist at $PLIST" >&2
  exit 1
fi

# Preferred: plutil -replace creates the key if absent and overwrites if present.
if plutil -replace LSUIElement -bool true "$PLIST"; then
  echo "patch-test-plist: LSUIElement=true set via plutil on $PLIST"
  exit 0
fi

# Fallback for older macOS where plutil -replace create-if-absent is uncertain.
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" \
  || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST"
echo "patch-test-plist: LSUIElement=true set via PlistBuddy on $PLIST"
