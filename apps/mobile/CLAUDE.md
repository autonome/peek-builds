# Mobile App (iOS / Android) — Agent Guide

This is the Tauri-mobile app ("Peek Save") for iOS and Android. Code lives under `apps/mobile/`:
- `src/` — Frontend (Vite/TypeScript)
- `src-tauri/` — Rust Tauri backend, Xcode project (`src-tauri/gen/apple/`), Android project
- `BUILD_NUMBER` — Plain-text integer, incremented by `deploy:sim` script before each sim install

For cross-cutting rules (git workflow, subagent dispatch, Bash discipline), see the root `CLAUDE.md`.

---

## Build Commands (use root yarn scripts, not raw xcodebuild/cargo)

Always check `apps/mobile/package.json` and the root `package.json` for the current script names before running anything. Canonical commands from the root:

| Goal | Command |
|------|---------|
| Simulator + HMR dev | `yarn mobile:ios:dev` |
| Full simulator build | `yarn mobile:ios:xcodebuild:full` |
| Full device build | `yarn mobile:ios:xcodebuild:device:full` |
| Android dev | `yarn mobile:android:dev` |
| Android build | `yarn mobile:android:build` |
| Run tests | `yarn test:mobile` |

Run builds in a **background agent** — they are verbose and long-running.

---

## iOS Specifics

### Simulator vs Device
- Simulator builds land in `/tmp/peek-xcodebuild-sim/`
- Device builds land in `/tmp/peek-xcodebuild-device/`
- `yarn mobile:ios:sim:boot` boots the simulator before install; `yarn mobile:ios:sim:launch` launches after install
- The `custom-protocol` feature is REQUIRED for iOS. Build scripts handle this automatically. **Never add it to the default `Cargo.toml` features.**

### BUILD_NUMBER
Lives in `apps/mobile/BUILD_NUMBER` (plain integer, newline-terminated). The `deploy:sim` script auto-increments it before each build. When filing build-number related issues, read this file first.

### Xcode project
`apps/mobile/src-tauri/gen/apple/peek-save.xcodeproj`. Open via `yarn mobile:ios:xcode`.

### Blank white page after build
Almost always a stale Rust cache. Run `yarn mobile:ios:sim:clean` or `yarn clean:rust:full` from `apps/mobile/`:

```bash
# From repo root
yarn mobile:ios:xcodebuild:full    # full rebuild
# or from apps/mobile/
yarn clean:rust:full               # nuke Rust cache, then rebuild
```

---

## Rust / Cargo Cache

`scripts/ios-cache.sh` (at repo root) caches `libapp.a` across agent workspaces by hashing `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `build.rs`, and `src/*.rs`. Cache lives in `tmp/ios-cache/`.

Before proposing a `CARGO_TARGET_DIR` or shared-cache scheme, check if `scripts/ios-cache.sh` already solves the problem.

---

## Android Specifics

Android build and dev scripts are in `apps/mobile/`:
- `build-android.sh` / `build-android-release.sh` / `dev-android.sh`
- Root: `yarn mobile:android:build`, `yarn mobile:android:dev`

**adb am start with `content://media` URIs fails with SecurityException** from synthetic adb tests. Real apps work via own-FileProvider grants. Do not conclude image-share is broken based on a synthetic adb test.

### tauri CLI version — use npm, not system cargo-tauri

The mobile app pins `@tauri-apps/cli` at `^2.10.1` (see `devDependencies` in `package.json`). All Android scripts (`dev-android.sh`, `build-android.sh`, `build-android-release.sh`, `dev-both.sh`) resolve the tauri CLI explicitly from `node_modules/.bin/tauri` — they do NOT use `npx tauri` or any system `cargo-tauri`.

Two reasons for this:
1. **Fresh-clone reliability**: `npx` resolution fails on pool clones where per-app `npm install` state isn't guaranteed (node_modules are symlinked from main, but npm's tauri resolution requires the symlink to be present).
2. **Version mismatch panic**: System `cargo-tauri` installed via `cargo install` (e.g. 2.9.6) panics inside `android-studio-script` against our npm CLI at 2.10.x. Minor versions are NOT compatible across the cargo/npm distributions.

If you have a system `cargo-tauri` installed, it is ignored by all scripts. If you need to verify which version will be used:

```bash
apps/mobile/node_modules/.bin/tauri --version
# or from repo root:
node_modules/.bin/tauri --version
```

Do NOT run `cargo install tauri-cli` to "fix" Android dev issues — use the npm CLI that the scripts resolve automatically.

---

## iOS Share Extension

The Share Extension Swift source examples live in `apps/mobile/` (`ShareViewController*.swift.example`, `ShareExtension-Info.plist.example`). The real implementation is inside the Xcode project. Build the share extension separately:

```bash
# From apps/mobile/
yarn build:share-ext
```

App Group ID for inter-extension data sharing: `com.dietrich.peek-mobile` (used for simulator DB access via `yarn mobile:ios:sim:db:*` scripts).

---

## Sim DB Inspection

```bash
yarn mobile:ios:sim:db:items    # Recent items
yarn mobile:ios:sim:db:tags     # Tags
yarn mobile:ios:sim:db:schema   # Table schema
yarn mobile:ios:sim:status      # Full status (profiles.json + DB list)
```

---

## Sync e2e test — `yarn test:sync:e2e:mobile` (mobile slot ONLY)

`apps/mobile/peek-core/tests/sync_e2e_mobile.rs` is the automated end-to-end test
for the mobile client's **per-bucket sync routing** (the fix for the Dev-1-of-7 /
stale-`synced_at`-after-rebind bug). It:
- boots the REAL server (`apps/server`, `node index.js`) on a temp data dir,
- drives the REAL `peek-core` push surface (`get_items_to_push` / `mark_item_synced`
  / `get_pending_sync_count`) over HTTP to two server buckets,
- asserts items synced to one bucket re-push to a newly-bound bucket, buckets stay
  isolated, and there is no re-push to the same bucket.

It is the only automated coverage that exercises the real mobile Rust client against
a live server — the JS `sync-three-way` test simulates clients with raw HTTP and
`sync-e2e` drives the *desktop* TS client; neither covers this path.

```bash
yarn test:sync:e2e:mobile   # cargo test ... --test sync_e2e_mobile -- --ignored
```

- It is `#[ignore]`d, so the normal `cargo test` / `yarn test:mobile` runs SKIP it
  (they still compile it). You must pass `--ignored` (the yarn script does).
- Requires `apps/server` installed (`npm install --prefix apps/server`); the test
  panics with that hint if it cannot spawn the server. Binds a fixed port (3461).
- **Run it ONLY from the dedicated `mobile` clone slot** (`scripts/spawn-mobile-workspace.sh`),
  never the main checkout or a pool clone. Mobile Rust build/test execution belongs
  in the `mobile` slot so it doesn't disturb the main checkout's target dir / interactive
  state, and so the fixed server port can't collide with another clone's run.

---

## Key Pitfalls

- Never invoke `cargo tauri ios build` or `xcodebuild` directly. Always use the yarn scripts.
- `CARGO_TARGET_DIR` environment variable can silently break incremental Rust builds if set incorrectly in an agent workspace.
- Mobile Tauri is distinct from Tauri Desktop (`apps/tauri-desktop/`). Do not confuse the two.
- Subagent builds must run `run_in_background=true`; iOS builds can take 5–20 min.
