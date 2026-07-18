#!/usr/bin/env sh
# Refuse to install over a RUNNING /Applications/Peek.app.
#
# Why this exists: build:electron:install does
#   rm -rf /Applications/Peek.app && cp -R out/mac-arm64/Peek.app /Applications/
# Electron parses the app.asar header (the per-file offset table) ONCE at process
# startup and caches it, then reads file *contents* from the asar path on demand.
# Replacing the asar under a live process leaves it with a STALE offset table over
# NEW bytes: every file then returns its correct *size* read from the WRONG
# location. The most visible symptom is the windows switcher
# (peek://windows/windows.html) rendering windows.css source as plaintext —
# "ESC shows source code instead of the windows view". Quitting and relaunching
# Peek re-reads the header and clears it.
#
# So: don't hard-quit the user's session (that's destructive too); just bail and
# let them quit it themselves, then re-run.
#
# Detection uses LaunchServices ("application ... is running"), which matches only
# the registered GUI app — NOT raw child processes like the MCP server — so a
# lingering mcp-server can't false-positive a block. Fails open (proceeds) if the
# check can't run, to avoid blocking installs on an automation-permission quirk.
if osascript -e 'application "Peek" is running' 2>/dev/null | grep -q true; then
  echo "ERROR: /Applications/Peek.app is running. Quit it (Cmd+Q), then re-run." >&2
  echo "Installing over a live app corrupts its in-memory asar — the windows" >&2
  echo "view renders windows.css source until you restart Peek." >&2
  exit 1
fi
