# /ios-build — Build for iOS

When the user invokes /ios-build:

1. First, read `apps/mobile/package.json` to confirm available scripts.

2. Determine build target from argument:

   | Argument | Command | Description |
   |----------|---------|-------------|
   | (none) or `sim` | `yarn mobile:ios:dev` | Simulator + HMR mode for frontend dev |
   | `device` | `yarn mobile:ios:xcodebuild:device:full` | Full device build for release testing |
   | `full` | `yarn mobile:ios:xcodebuild:full` | Full simulator rebuild (no HMR) |

3. Run the build in a **background agent** (`subagent_type=general-purpose`, `run_in_background=true`) — builds are verbose and long-running.

4. When complete, report:
   - Build success/failure
   - Build number from `apps/mobile/BUILD_NUMBER`
   - Any errors or warnings

## CRITICAL rules

- **Read package.json scripts first** — use yarn scripts only, never raw xcodebuild/cargo
- `custom-protocol` feature is REQUIRED for iOS — build scripts handle this automatically
- Simulator builds go to `/tmp/peek-xcodebuild-sim`, device to `/tmp/peek-xcodebuild-device`
- If user reports blank white page, may need `yarn clean:rust:full` (stale Cargo cache)
- NEVER add `custom-protocol` to default Cargo.toml features
- **A green build does NOT mean your code is on the device.** The frontend is
  embedded in `libapp.a` at compile time; the runtime serves that, not
  `gen/apple/assets/`. If a frontend change "did nothing", suspect a stale
  embed: rebuild with `build-release.sh --force` / `build-ios.sh --force`.
- **Always verify at runtime** with `scripts/verify-ios-build.sh device|sim`
  (`PASS` = the running app is current source). See `/peek-device-verify`.

## Usage

```
/ios-build
/ios-build sim
/ios-build device
/ios-build full
```
