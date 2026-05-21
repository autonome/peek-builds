#!/bin/bash
# Claim the reserved mobile workspace slot.
#
# This is a thin wrapper around scripts/spawn-isolated-clone.sh that hard-codes:
#   - Name: "mobile" (single reserved slot, not a pool member)
#   - Base: "main"
#   - Scope: "apps/mobile" (only root + packages + apps/mobile node_modules symlinked)
#
# Why a dedicated slot: mobile builds produce huge Rust target/ + Xcode derived
# data + libapp.a/xcframework artifacts. A normal pool slot would pay the cold-
# build cost (~2 min Rust + Xcode time) on every spawn since clean-isolated-
# clone.sh tears down the dir. The mobile slot PERSISTS those artifacts across
# spawns: spawn-isolated-clone.sh on an existing clone only does `jj new BASE`
# and re-symlinks node_modules — untracked build outputs in the clone's WC
# survive untouched.
#
# Usage:
#   scripts/spawn-mobile-workspace.sh
#
# Then cd into the printed clone path. The clone is at ../mpeek-clone-mobile/.
# Finalize and clean use the same scripts as the regular pool, BUT
# scripts/clean-isolated-clone.sh refuses to clean the "mobile" slot unless
# MOBILE_FORCE_CLEAN=1 is set in env — protects against accidental wipe of
# hours of build cache.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "mobile" > /tmp/mpeek-agent-name
echo "main" > /tmp/mpeek-clone-base
echo "apps/mobile" > /tmp/mpeek-clone-scope

exec "$SCRIPT_DIR/spawn-isolated-clone.sh"
