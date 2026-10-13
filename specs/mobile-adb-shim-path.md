---
enabled: true
touches: [apps/mobile/bin/setup-adb-shim.sh]
depends-on: []
---

# The adb shim directory path has a separator

Peek item `a8ca2b89`. `apps/mobile/bin/setup-adb-shim.sh` builds the shim path without a slash, so with `TMPDIR` unset it tries to create `/tmppeek-android-shim` and fails. macOS `TMPDIR` always ends in `/`, which hides the bug on a developer laptop. Minimal shells, CI containers and test runners hit it.

## What the code does now

`setup-adb-shim.sh` sets `_SHIM_DIR="${TMPDIR:-/tmp}peek-android-shim"`. It then runs `rm -rf "$_SHIM_DIR"` and `mkdir -p "$_SHIM_DIR"`, symlinks the real SDK entries into it, copies `bin/adb` to `platform-tools/adb`, and exports `ANDROID_HOME` and `PATH`. The sibling `apps/mobile/bin/adb` already writes `LOCKDIR="${TMPDIR:-/tmp}/peek-adb-server.lck"` with the slash.

## Decisions

- Strip one trailing slash from the base, then append `/peek-android-shim`. A trailing-slash `TMPDIR` then yields a clean path with no doubled slash. The item allows either form.
- Do not touch the rest of the script. When the fake SDK's `platform-tools` is empty, the `for _pt in .../*` loop makes one harmless dangling symlink named `*`. That is existing behaviour and out of scope.

## What changes

`setup-adb-shim.sh`: replace the `_SHIM_DIR=` line with a base variable (`${TMPDIR:-/tmp}` with a trailing `/` removed) and `_SHIM_DIR="$base/peek-android-shim"`. Update the header comment only if it disagrees with the new behaviour. It currently says `/tmp/peek-android-shim`, which stays true.

## Verify

No automated test covers this script. The check is a direct invocation against a throwaway SDK directory. It needs no device, emulator or macOS. From the repo root, one command per Bash call:

1. `mkdir -p /tmp/peek-fake-sdk/platform-tools`
2. `env -u TMPDIR ANDROID_HOME=/tmp/peek-fake-sdk bash -c '. apps/mobile/bin/setup-adb-shim.sh && echo "$ANDROID_HOME"'` must print `/tmp/peek-android-shim`.
3. `ls /tmp/peek-android-shim/platform-tools/adb` must exist.
4. `mkdir -p /tmp/peek-x`
5. `TMPDIR=/tmp/peek-x/ ANDROID_HOME=/tmp/peek-fake-sdk bash -c '. apps/mobile/bin/setup-adb-shim.sh && echo "$ANDROID_HOME"'` must print `/tmp/peek-x/peek-android-shim`.
6. Run once more with `TMPDIR=` set to empty. It must print `/tmp/peek-android-shim`.

Done when steps 2, 3, 5 and 6 print the stated paths. Record the printed outputs under `**Result**` in the handoff.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Run one command per Bash call.
