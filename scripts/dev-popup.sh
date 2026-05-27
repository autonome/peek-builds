#!/usr/bin/env bash
# dev-popup.sh — iterate fast on the chrome-extension compat layer.
#
# Launches Peek in dev with:
#   - PEEK_AUTOOPEN_EXT=<extId>:<pageType>  → opens that extension UI page at
#     boot (after extensions finish loading) instead of restoring the dev
#     profile's session
#   - PROFILE=<profile>  → defaults to the dev profile so any login state
#     persists across iterations (override via env)
#   - dev:hot  → nodemon rebuilds + restarts Peek on source changes under
#     apps/desktop/, packages/, scripts/, schema/ — so editing
#     runtime-external.js / peek-bridge.js / peek-relay.js / entry.ts
#     auto-reloads the running Peek with the popup re-opened
#
# Usage:
#   scripts/dev-popup.sh                                       # proton-pass popup, dev profile
#   PEEK_AUTOOPEN_EXT=proton-pass:options scripts/dev-popup.sh # different page
#   PROFILE=ext-test scripts/dev-popup.sh                       # different profile
#
# Stop with Ctrl+C. The dev profile is preserved between runs.

set -euo pipefail

# Default to the proton-pass popup if not overridden.
export PEEK_AUTOOPEN_EXT="${PEEK_AUTOOPEN_EXT:-proton-pass:popup}"
# Default to the dev profile (preserves any Proton login state). Override via
# env if you want a fresh profile.
export PROFILE="${PROFILE:-dev}"
# Keep verbose logging on for iteration.
export DEBUG="${DEBUG:-1}"

echo "[dev-popup] launching Peek (profile=${PROFILE}, autoopen=${PEEK_AUTOOPEN_EXT})"
echo "[dev-popup] watching apps/desktop/ + chrome-api-polyfills via nodemon"
echo "[dev-popup] edits to .ts / .js / .cjs / .html under apps/desktop/main/ trigger rebuild + restart"

# Run from repo root so workspace resolution + relative paths work.
cd "$(dirname "$0")/.."

# Hand off to the workspace's dev:hot which already wires nodemon + rebuild +
# electron launch. Env vars propagate through.
exec yarn workspace @peek/desktop dev:hot
