#!/bin/sh
# setup-adb-shim.sh: create a shim ANDROID_HOME that intercepts adb calls.
#
# Usage:
#   . "$(dirname "$0")/setup-adb-shim.sh"   # source it to get env vars
#
# After sourcing, ANDROID_HOME and PEEK_REAL_ADB are set in the calling shell.
#
# What it does:
#   Creates /tmp/peek-android-shim/ mirroring the real ANDROID_HOME but with
#   platform-tools/adb replaced by the flock-serialised wrapper (bin/adb).
#   All other SDK dirs/files are symlinked so tauri-cli can still find the
#   emulator, cmdline-tools, ndk, build-tools, etc.
#
# The shim is recreated each invocation (idempotent; takes ~10ms).

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_WRAPPER_ADB="$_SCRIPT_DIR/adb"
_REAL_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
_TMP_BASE="${TMPDIR:-/tmp}"
_TMP_BASE="${_TMP_BASE%/}"
_SHIM_DIR="$_TMP_BASE/peek-android-shim"

if [ ! -d "$_REAL_HOME" ]; then
  echo "setup-adb-shim: ANDROID_HOME not found: $_REAL_HOME" >&2
  return 1 2>/dev/null || exit 1
fi

if [ ! -x "$_WRAPPER_ADB" ]; then
  echo "setup-adb-shim: wrapper not found: $_WRAPPER_ADB" >&2
  return 1 2>/dev/null || exit 1
fi

# Recreate shim dir from scratch each run (fast: mkdir + ln, no build overhead)
rm -rf "$_SHIM_DIR"
mkdir -p "$_SHIM_DIR"

# Symlink every top-level entry from the real SDK root, skipping platform-tools
# (which we shadow with a real directory containing our wrapper adb)
for _entry in "$_REAL_HOME"/*/; do
  _name="$(basename "$_entry")"
  if [ "$_name" != "platform-tools" ]; then
    ln -s "$_entry" "$_SHIM_DIR/$_name"
  fi
done

# Symlink hidden files at the SDK root (e.g. .knownPackages, .DS_Store)
for _f in "$_REAL_HOME"/.*; do
  _name="$(basename "$_f")"
  if [ "$_name" != "." ] && [ "$_name" != ".." ] && [ -e "$_f" ]; then
    ln -s "$_f" "$_SHIM_DIR/$_name" 2>/dev/null || true
  fi
done

# Build a real platform-tools/ directory with all files symlinked except adb
mkdir -p "$_SHIM_DIR/platform-tools"
for _pt in "$_REAL_HOME/platform-tools"/*; do
  _pt_name="$(basename "$_pt")"
  if [ "$_pt_name" != "adb" ]; then
    ln -s "$_pt" "$_SHIM_DIR/platform-tools/$_pt_name"
  fi
done

# Install our wrapper as the intercepted adb
cp "$_WRAPPER_ADB" "$_SHIM_DIR/platform-tools/adb"
chmod +x "$_SHIM_DIR/platform-tools/adb"

# Export the env vars into the calling shell
export PEEK_REAL_ADB="$_REAL_HOME/platform-tools/adb"
export ANDROID_HOME="$_SHIM_DIR"

# Prepend the shim's platform-tools to PATH so child processes that call
# `adb` without an explicit path (tauri-cli, Gradle tasks, etc.) resolve
# to our serialized wrapper instead of any system adb earlier on PATH.
# Without this, the user's PATH adb (e.g. ~/bin/platform-tools/adb) wins
# and bypasses the wrapper entirely — the SIGABRT race returns.
export PATH="$_SHIM_DIR/platform-tools:$PATH"
