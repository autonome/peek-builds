#!/bin/bash
# Run the Playwright cold-start restore spec headed (HEADLESS=0), single worker.
# This exercises the DETERMINISTIC mechanism (first-frame -> ordered re-assert
# counters); the on-screen pixels are proven separately by run-real-coldstart.sh.
# Paths derive from this script's own location, so it works in any checkout.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
cd "$REPO_ROOT" || exit 1
export HEADLESS=0
export BACKEND=electron
export DEBUG=1
export PEEK_DIAG_RAISE=1
rm -f /tmp/peek-cmd-diag.log
exec npx playwright test \
  --config apps/desktop/playwright.config.ts \
  apps/desktop/tests/desktop/session-restore-coldstart.spec.ts \
  --project=desktop \
  --grep "Restore Cold-Start Oracle" \
  --reporter=line \
  --workers=1
