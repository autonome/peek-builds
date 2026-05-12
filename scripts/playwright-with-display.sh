#!/usr/bin/env bash
# Run `npx playwright <args>` with a display attached.
#
# On Linux we run under Xvfb + openbox so test BrowserWindows actually
# render to a virtual framebuffer and so X11 WM hints like maximize are
# honored. The show:false path triggers Chromium's PageVisibility=hidden
# state on Linux, which suspends requestAnimationFrame and hangs
# Playwright's default RAF-based waitForFunction polling — tests time
# out at 30s even though the underlying state has long since
# transitioned. macOS happens to keep RAF alive for show:false windows
# so it doesn't need this; we keep the existing HEADLESS=1 behavior
# there.
#
# We unset HEADLESS/PEEK_HEADLESS on Linux so the test fixture takes the
# normal "windows are shown" path; the windows appear inside Xvfb's
# virtual display and never reach the user's real session.
#
# On Wayland sessions we also unset WAYLAND_DISPLAY/WAYLAND_SOCKET.
# Electron 38+ defaults to Ozone Wayland whenever WAYLAND_DISPLAY is
# present and bypasses xvfb-run's DISPLAY redirect entirely — windows
# end up on the real compositor. Pair this with --ozone-platform=x11
# in the fixture's launch args so Electron stays on XWayland.
#
# Openbox: bare Xvfb has no window manager, so _NET_WM_STATE_MAXIMIZED_*
# requests get briefly honored then snapped back when other X events
# arrive. That breaks maximize-after-N-events tests like
# page-layout.spec.ts "panels clamped to screen edges when maximized"
# and window-targeting.spec.ts "maximize is non-toggling" — windows
# laid out as maximized, then measured at their pre-maximize width.
# Openbox is a tiny EWMH-compliant WM that makes maximize stick.

set -euo pipefail

if [ "$(uname -s)" = "Linux" ]; then
  unset HEADLESS PEEK_HEADLESS WAYLAND_DISPLAY WAYLAND_SOCKET
  exec xvfb-run -a -s "-screen 0 1920x1080x24" bash -c '
    openbox &
    OB_PID=$!
    # Give openbox a moment to claim the WM selection before any
    # BrowserWindow is created; otherwise the first window can be
    # created in pre-WM state.
    sleep 0.3
    trap "kill $OB_PID 2>/dev/null || true" EXIT
    exec npx playwright "$@"
  ' bash "$@"
fi

exec npx playwright "$@"
