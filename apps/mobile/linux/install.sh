#!/bin/bash
# Deploy peek-mobile to a postmarketOS / Phosh device.
#
# Usage: ./install.sh user@host
#
# Prerequisite: build the binary first with apps/mobile/build-linux.sh.
# Prerequisite: target device has webkit2gtk-4.1 installed (`sudo apk add
# webkit2gtk-4.1`) and SSH key auth set up.
#
# What it deploys:
#   ~/peek-save                                     binary
#   ~/peek-launch.sh                                env wrapper
#   ~/.local/share/applications/peek-save.desktop   drawer entry
#   ~/.config/autostart/peek-save.desktop           autostart (login)
#   ~/.local/share/icons/hicolor/{128,256}x*/apps/peek.png   round icons
#
# The .desktop filename matches the running window's Wayland app_id
# ("peek-save"), which is what Phosh needs to associate the running
# window with the launcher entry (icon, name).
set -e

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Usage: $0 user@host"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$MOBILE_DIR/src-tauri/target-linux-musl/release/peek-save"

if [ ! -x "$BIN" ]; then
  echo "ERROR: binary not found at $BIN"
  echo "Build it first: apps/mobile/build-linux.sh"
  exit 1
fi

if ! command -v convert >/dev/null 2>&1; then
  echo "ERROR: ImageMagick 'convert' not found. Needed for round-icon mask."
  exit 1
fi

echo "==> Probing target..."
REMOTE_HOME=$(ssh "$TARGET" -- 'printenv HOME')
echo "    home: $REMOTE_HOME"

echo "==> Creating target dirs..."
ssh "$TARGET" -- mkdir -p \
  .local/share/applications \
  .config/autostart \
  .local/share/icons/hicolor/128x128/apps \
  .local/share/icons/hicolor/256x256/apps

# Stop any running instance so we can overwrite the binary
ssh "$TARGET" -- pkill -f peek-save >/dev/null 2>&1 || true

echo "==> Pushing binary..."
scp "$BIN" "$TARGET:peek-save"

echo "==> Pushing launcher wrapper..."
scp "$SCRIPT_DIR/peek-launch.sh" "$TARGET:peek-launch.sh"
ssh "$TARGET" -- chmod +x peek-launch.sh

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "==> Generating .desktop entry..."
sed "s|@PEEK_BIN@|$REMOTE_HOME/peek-launch.sh|" \
  "$SCRIPT_DIR/peek-save.desktop.in" > "$TMPDIR/peek-save.desktop"

scp "$TMPDIR/peek-save.desktop" "$TARGET:.local/share/applications/peek-save.desktop"
scp "$TMPDIR/peek-save.desktop" "$TARGET:.config/autostart/peek-save.desktop"

echo "==> Generating round icons (circular alpha mask)..."
convert "$MOBILE_DIR/src-tauri/icons/128x128.png" \
  \( +clone -alpha transparent -fill white -draw "circle 64,64 64,0" \) \
  -compose CopyOpacity -composite "$TMPDIR/peek-128.png"
convert "$MOBILE_DIR/src-tauri/icons/128x128@2x.png" \
  \( +clone -alpha transparent -fill white -draw "circle 128,128 128,0" \) \
  -compose CopyOpacity -composite "$TMPDIR/peek-256.png"

scp "$TMPDIR/peek-128.png" "$TARGET:.local/share/icons/hicolor/128x128/apps/peek.png"
scp "$TMPDIR/peek-256.png" "$TARGET:.local/share/icons/hicolor/256x256/apps/peek.png"

echo "==> Refreshing icon cache..."
ssh "$TARGET" -- gtk-update-icon-cache -t -f "$REMOTE_HOME/.local/share/icons/hicolor"

echo ""
echo "==> Done. To launch now without re-logging-in:"
echo "    ssh $TARGET -- systemd-run --user --unit=peek-save $REMOTE_HOME/peek-launch.sh"
