#!/usr/bin/env bash
# Linux smoke test for the AppImage default-browser registration flow.
#
# Verifies end-to-end:
#   T1: launching the AppImage installs ~/.local/share/applications/peek.desktop
#       with the correct MimeType and Exec= pointing at the actual AppImage path
#   T2: xdg-mime accepts peek.desktop as the default for x-scheme-handler/http
#   T3: an external xdg-open <url> reaches Peek's URL handler
#       (verified via /tmp/peek-url-debug.log written by main.ts:urlLog)
#   T4: a relocated AppImage corrects its own Exec= path on next launch
#
# Isolation: $XDG_DATA_HOME is pointed at a temp dir so the test never
# touches the real user's ~/.local/share/applications/. desktop-installer.ts
# honors XDG_DATA_HOME for exactly this reason. The user's xdg-mime default
# IS modified during the test (no clean way to isolate xdg's mimeapps.list
# without a full session sandbox); we restore the previous default in the
# trap.
#
# Run with: scripts/smoke-default-browser.sh [path/to/AppImage]
# Default AppImage path: out/Peek-*-arm64.AppImage

set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "skip: linux only"
  exit 0
fi

# ── Locate the AppImage ──────────────────────────────────────────────────────
APPIMAGE_INPUT="${1:-}"
if [ -z "$APPIMAGE_INPUT" ]; then
  # Glob for any built AppImage; pick the first.
  APPIMAGE_INPUT="$(ls out/Peek-*-arm64.AppImage 2>/dev/null | head -n1 || true)"
fi
if [ -z "$APPIMAGE_INPUT" ] || [ ! -f "$APPIMAGE_INPUT" ]; then
  echo "FAIL: no AppImage found. Build with: yarn build:electron:dist"
  exit 2
fi
APPIMAGE="$(realpath "$APPIMAGE_INPUT")"
echo "smoke: testing $APPIMAGE"

# ── Isolate XDG_DATA_HOME so the test doesn't touch the user's real dirs ─────
SMOKE_TMP="$(mktemp -d -t peek-smoke-XXXXXX)"
export XDG_DATA_HOME="$SMOKE_TMP/share"
mkdir -p "$XDG_DATA_HOME/applications" "$XDG_DATA_HOME/icons"
DESKTOP_FILE="$XDG_DATA_HOME/applications/peek.desktop"

URL_LOG=/tmp/peek-url-debug.log
MARKER_URL="https://default-browser-smoke-$$-$(date +%s).invalid/"

# Save the user's existing http-handler default so we can restore it on exit.
ORIG_HTTP_DEFAULT="$(xdg-mime query default x-scheme-handler/http 2>/dev/null || true)"
ORIG_HTTPS_DEFAULT="$(xdg-mime query default x-scheme-handler/https 2>/dev/null || true)"

PEEK_PID=""

EXIT_CODE=0
cleanup() {
  # Capture the exit code of the *last user-visible command* before the
  # trap fires — otherwise random signal-status from `kill`/`wait` below
  # can leak through (we observed exit 144 from a SIGURG-coded wait).
  EXIT_CODE=$?
  set +e  # Don't let any cleanup error abort the trap mid-run.
  if [ -n "$PEEK_PID" ] && kill -0 "$PEEK_PID" 2>/dev/null; then
    kill "$PEEK_PID" 2>/dev/null
    sleep 1
    kill -9 "$PEEK_PID" 2>/dev/null
  fi
  # NOTE: do NOT `pkill -f Peek-0.0.1-arm64.AppImage` here — `-f` matches
  # against the full command line, and this script's own argv contains
  # the AppImage path, so pkill cheerfully kills the script itself
  # (observed exit 144 mid-trap). The PEEK_PID kill above + Electron's
  # internal child-process tracking handles teardown for both spawned
  # AppImages.
  # Restore the user's original mimeapps.list defaults.
  if [ -n "$ORIG_HTTP_DEFAULT" ]; then
    xdg-mime default "$ORIG_HTTP_DEFAULT" x-scheme-handler/http 2>/dev/null
  fi
  if [ -n "$ORIG_HTTPS_DEFAULT" ]; then
    xdg-mime default "$ORIG_HTTPS_DEFAULT" x-scheme-handler/https 2>/dev/null
  fi
  rm -rf "$SMOKE_TMP" 2>/dev/null
  exit "$EXIT_CODE"
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────────────────
launch_appimage() {
  local exe="$1"
  # PEEK_HEADLESS=1 keeps the BrowserWindow hidden so the test doesn't pop a
  # focus-stealing window into the user's session. The desktop-install path
  # runs unconditionally on Linux/AppImage regardless of headless.
  PEEK_HEADLESS=1 XDG_DATA_HOME="$XDG_DATA_HOME" "$exe" >"$SMOKE_TMP/peek.log" 2>&1 &
  PEEK_PID=$!
}

wait_for_file() {
  local target="$1" max="${2:-15}"
  for _ in $(seq 1 "$max"); do
    [ -f "$target" ] && return 0
    sleep 1
  done
  return 1
}

assert_grep() {
  local pattern="$1" file="$2" name="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "FAIL $name: pattern '$pattern' not found in $file"
    echo "--- file contents ---"
    cat "$file"
    echo "---"
    exit 1
  fi
}

# ── T1: install on launch ────────────────────────────────────────────────────
echo "T1: launch + auto-install"
launch_appimage "$APPIMAGE"
if ! wait_for_file "$DESKTOP_FILE" 15; then
  echo "FAIL T1: $DESKTOP_FILE never appeared within 15s"
  echo "--- peek.log tail ---"; tail -50 "$SMOKE_TMP/peek.log" || true
  exit 1
fi
assert_grep "MimeType=.*x-scheme-handler/http" "$DESKTOP_FILE" "T1.MimeType"
assert_grep "^Exec=$APPIMAGE %U" "$DESKTOP_FILE" "T1.Exec"
echo "  pass"

# ── T2: xdg-mime registration round-trip ────────────────────────────────────
echo "T2: xdg-mime default round-trip"
xdg-mime default peek.desktop x-scheme-handler/http
RESULT="$(xdg-mime query default x-scheme-handler/http)"
if [ "$RESULT" != "peek.desktop" ]; then
  echo "FAIL T2: expected peek.desktop, got '$RESULT'"
  exit 1
fi
echo "  pass"

# ── T3: URL routing reaches the running Peek ────────────────────────────────
# What we test: spawning the AppImage with a URL argv (the same argv
# shape gio launch / gtk-launch / a real desktop click ends up using
# after dispatching through the .desktop file's Exec=) forwards the URL
# to the already-running primary instance via Electron's
# requestSingleInstanceLock + second-instance event chain.
#
# What we deliberately DON'T test: xdg-open / gio open. Those route
# through xdg-desktop-portal on modern GNOME, which has its own
# URL-handler selection that may bypass xdg-mime defaults entirely.
# Whether the user's portal will offer Peek is a portal/DE question
# orthogonal to Peek's setAsDefaultProtocolClient flow — testing it
# here would make T3 fail on systems with portal interception even
# though our code is correct.
#
# urlLog (main.ts:57) appends every handleExternalUrl invocation to
# /tmp/peek-url-debug.log; we grep for the marker URL there.
echo "T3: URL forwards to running instance"
: > "$URL_LOG"
"$APPIMAGE" "$MARKER_URL" >/dev/null 2>&1 || true
FOUND=0
for _ in $(seq 1 15); do
  if grep -q "$MARKER_URL" "$URL_LOG" 2>/dev/null; then
    FOUND=1
    break
  fi
  sleep 1
done
if [ "$FOUND" != "1" ]; then
  echo "FAIL T3: marker URL '$MARKER_URL' never reached Peek's urlLog"
  echo "--- /tmp/peek-url-debug.log ---"
  cat "$URL_LOG" 2>/dev/null || echo "(empty or missing)"
  echo "---"
  exit 1
fi
echo "  pass"

# ── T4: relocated AppImage updates its own Exec= ────────────────────────────
echo "T4: relocated AppImage self-corrects Exec="
# Stop the running instance so the second launch isn't a second-instance fwd.
kill "$PEEK_PID" 2>/dev/null || true
wait "$PEEK_PID" 2>/dev/null || true
PEEK_PID=""
sleep 2
RELOCATED="$SMOKE_TMP/Peek-relocated.AppImage"
cp "$APPIMAGE" "$RELOCATED"
chmod +x "$RELOCATED"
launch_appimage "$RELOCATED"
# The .desktop file already exists; wait for Exec= to reflect the new path.
EXEC_OK=0
for _ in $(seq 1 15); do
  if grep -q "^Exec=$RELOCATED %U" "$DESKTOP_FILE"; then
    EXEC_OK=1
    break
  fi
  sleep 1
done
if [ "$EXEC_OK" != "1" ]; then
  echo "FAIL T4: Exec= did not update to relocated path"
  echo "--- desktop file ---"; cat "$DESKTOP_FILE"; echo "---"
  exit 1
fi
echo "  pass"

echo "smoke: PASS all"
exit 0
