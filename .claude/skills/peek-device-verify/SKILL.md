---
name: peek-device-verify
description: Prove the iOS app on device/simulator is actually running YOUR build (PEEK_BUILD_ID + scripts/verify-ios-build.sh), plus file-based diagnostics and simulator self-driving. Use after changing apps/mobile, before manual iOS testing, and BEFORE concluding an iOS fix didn't work.
---

# /peek-device-verify — Prove the iOS app on device is YOUR build

Use this whenever you change `apps/mobile` and need to confirm the code is
**actually running** on a device/simulator — before manual testing, and before
concluding "the fix didn't work."

## The footgun this defends against (read this first)

The iOS app embeds the built frontend **into `libapp.a` at Rust compile time**
and serves THAT embedded bundle at runtime. It does **not** serve
`src-tauri/gen/apple/assets/` — that copy exists only for Xcode parity/fallback.

Consequences that wasted a full session on 2026-06-24:

- The iOS build cache (`scripts/ios-cache.sh`) historically hashed only Rust
  inputs. A **frontend-only change got a cache hit**, the build `exit 0`'d before
  re-embedding, and the device kept running the **old embedded bundle**. The
  build reported SUCCESS and even refreshed `gen/apple/assets/` — so grepping
  that copy showed the new code while the device ran the old code.
- **Therefore: never verify a deploy by inspecting `gen/apple/assets/` or
  `dist/`.** Those are build outputs, not proof of what's installed/running.

The cache hash now also covers frontend + `peek-core` sources, so a normal build
busts the cache on any change. But always confirm at runtime.

## How verification works

Every build bakes a `PEEK_BUILD_ID` (`<git short rev>-<12-char source hash>`)
into `libapp.a` (see `build.rs` + the build scripts). On launch the app writes it
to `Documents/build-id.txt` (`write_build_id_marker()` in `lib.rs`). The id is a
pure function of source, so a verifier recomputes it and compares.

```bash
# After build + install, launch + assert the running app == current source:
scripts/verify-ios-build.sh device     # physical device (auto-detects udid; or DEVICE_ID=…)
scripts/verify-ios-build.sh sim        # booted simulator
```

`PASS` => the device is running exactly this source.
`FAIL` => stale build — rebuild with `--force` and reinstall (see below).

## Correct build → verify loop

1. **Build with re-embed guaranteed.** A plain `yarn mobile:ios:xcodebuild:*`
   relies on the cache being correct. When in doubt (or iterating on frontend),
   force it so `libapp.a` re-embeds:
   - Device: `apps/mobile/build-release.sh --force` then
     `yarn mobile:ios:xcodebuild:device` then `…:device:install`
   - Sim: `apps/mobile/build-ios.sh --force` then
     `yarn mobile:ios:xcodebuild` then `…:install`
   (Force is also the only sure fix for "I changed JS but nothing changed.")
2. **Launch + verify:** `scripts/verify-ios-build.sh device|sim`. Do NOT trust a
   green build — trust `PASS`.
3. Only then test behavior.

## Diagnosing behavior without manual testing

Log capture is unreliable on iOS: `console.log`/`println!` do **not** reliably
reach `xcrun simctl spawn booted log stream` (stdout isn't os_log), and there's
no `idevicesyslog` here. Use these instead:

- **File-based diagnostics (device-safe):** write diagnostics to a file under the
  app's Documents (the app already mirrors the App Group to `Documents/Backups/`),
  then pull with `devicectl … copy from --source Documents/<file>`. `ios_log()`
  in `lib.rs` is the natural hook to extend.
- **Simulator self-driver + on-screen overlay + screenshot** (fast iteration):
  a flag-gated `useEffect` that scripts a scenario (e.g. drives `setSearchText`
  through a sequence) plus a small fixed-position overlay rendering an in-memory
  diagnostic ring buffer. **Portal the overlay to `document.body`** — `.app` has
  a `transform`, which breaks `position: fixed` for descendants. Capture with
  `xcrun simctl io booted screenshot`. (This is how the typing-lag clear was
  finally pinned: a `SEARCH-ZEROS` counter proved the list never actually
  emptied during search.)
- Remember sim builds need `--force` too, or the overlay/self-driver silently
  won't deploy.

## Checklist before saying "it works on device"

- [ ] Built (forced if any frontend change)
- [ ] Installed to the target
- [ ] `scripts/verify-ios-build.sh` prints `PASS`
- [ ] Behavior confirmed (manually, or via file-diag / sim self-driver)
