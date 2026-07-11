#!/bin/bash
# Run the warm-restore oracle spec headed (HEADLESS=0), single worker. Proves the
# moveTop reconstruction ordering is correct up to 8 windows (crosses the
# eager/deferred cap) when restore runs in an already-running process.
# Paths derive from this script's own location, so it works in any checkout.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
cd "$REPO_ROOT" || exit 1
export HEADLESS=0
export BACKEND=electron
export DEBUG=1
exec npx playwright test \
  --config apps/desktop/playwright.config.ts \
  apps/desktop/tests/desktop/session-restore-oracle.spec.ts \
  --project=desktop \
  --grep "Restore Oracle" \
  --reporter=line \
  --workers=1
