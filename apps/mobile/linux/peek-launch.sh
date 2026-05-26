#!/bin/sh
# Wrapper that sets the env vars peek-save needs to render correctly on
# Phosh / Wayland, then execs the binary. Deployed alongside peek-save by
# install.sh in this directory.
#
# Env var notes:
# - WAYLAND_DISPLAY / XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS: the
#   service unit (systemd-run --user) doesn't inherit a logged-in session's
#   bus by default; we point them at the standard per-user paths.
# - GDK_SCALE=2: Pixel-3a-style 2x display. Override on devices with
#   different scaling.
# - WEBKIT_DISABLE_DMABUF_RENDERER=1: webkit2gtk-4.1 has a paint-only-after-
#   first-input glitch on Phosh when the dmabuf path is on; the legacy
#   renderer is fine.

UID_NUM=$(id -u)

exec env \
  WAYLAND_DISPLAY=wayland-0 \
  XDG_RUNTIME_DIR="/run/user/${UID_NUM}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${UID_NUM}/bus" \
  GDK_SCALE=2 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  "$(dirname "$0")/peek-save" "$@"
