#!/usr/bin/env bash
# Run `npx playwright <args>` with a display attached.
#
# On Linux we run under Xvfb so test BrowserWindows actually render to a
# virtual framebuffer instead of being created with show:false. The
# show:false path triggers Chromium's PageVisibility=hidden state on
# Linux, which suspends requestAnimationFrame and hangs Playwright's
# default RAF-based waitForFunction polling — tests time out at 30s
# even though the underlying state has long since transitioned. macOS
# happens to keep RAF alive for show:false windows so it doesn't need
# this; we keep the existing HEADLESS=1 behavior there.
#
# We unset HEADLESS/PEEK_HEADLESS on Linux so the test fixture takes the
# normal "windows are shown" path; the windows appear inside Xvfb's
# virtual display and never reach the user's real session.

set -euo pipefail

if [ "$(uname -s)" = "Linux" ]; then
  unset HEADLESS PEEK_HEADLESS
  exec xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright "$@"
fi

exec npx playwright "$@"
