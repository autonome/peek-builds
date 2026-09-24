---
enabled: true
touches: [apps/desktop/main/build-info.ts, apps/desktop/main/build-info.test.ts, apps/desktop/main/entry.ts, apps/desktop/electron-builder.yml, scripts/electron-after-pack.cjs]
depends-on: []
---

# Stamp build identity into packaged builds

Peek item `7aa426c2`. A packaged Peek has no record of the source it was built from. The root
`package.json` `version` is `0.0.1`. electron-builder's `app-builder-lib` sets `CFBundleVersion`
from `config.buildVersion`, falling back to that `version`, and neither is set here, so every
bundle reports `0.0.1`. `apps/desktop/version.ts` holds only `DATASTORE_VERSION` /
`PROTOCOL_VERSION` for sync. Nothing under `apps/desktop` or `scripts` mentions `build-info`.

This spec covers only what can be read from the bundle and the startup log line. A runtime surface
(about/settings page, tile API or MCP query) is out of scope and stays open on the item as a
follow-up.

## Already landed, only confirm

`apps/desktop/electron-builder.yml` `files` already lists `!.worktrees` and `!.worktrees/**`. Do
not change it. The Verify step confirms that a packed asar has no `.worktrees/` entries.

## What gets added

- **`apps/desktop/main/build-info.ts`**: pure logic, with no Electron import at module top level.
  - `resolveBuildInfo(inputs)` takes raw git outputs and returns the record. Inputs: the HEAD
    commit id, the commit timestamp, the `git status --porcelain` text, the branch
    (`git rev-parse --abbrev-ref HEAD`), the repo toplevel path, the build time, and the package
    version. The record is `{ commit, shortCommit, commitTime, buildTime, dirty, branch, checkout,
    version }`:
    - `dirty` is true exactly when the porcelain text is non-empty after trimming.
    - `branch` is null when the value is `HEAD` (detached).
    - `checkout` is `"main"` unless the toplevel path contains a `/.worktrees/<name>` segment, in
      which case it is `"worktree:<name>"`.
  - `formatBuildInfoLogLine(info)` returns one line naming the short commit, the dirty flag and the
    checkout, prefixed `[build]`.
  - `readBuildInfo(resourcesDir)` parses `build-info.json` from that directory. It returns null when
    the file is missing or malformed, which is the normal case for source runs.
- **`scripts/electron-after-pack.cjs`**: an electron-builder `afterPack` hook. It lives in root
  `scripts/`, which `files` already excludes, so the hook itself is not packaged.
  - It runs git through `execFileSync` and passes the outputs to `resolveBuildInfo`, loaded with
    `await import()` from `apps/desktop/dist/main/build-info.js`. Every packaging path runs
    `yarn build` first.
  - It writes `build-info.json` into the packaged resources directory:
    `<appOutDir>/<productFilename>.app/Contents/Resources` on macOS, `<appOutDir>/resources` on
    Linux and Windows.
  - On macOS it also rewrites `Contents/Info.plist` with the `plist` package, already in
    `node_modules`: `CFBundleVersion` becomes the short commit id, and it adds `PeekBuildCommit`
    (full id) and `PeekBuildDirty`. Signing is disabled (`identity: null`), so editing the plist
    after packing is safe.
  - A hook rather than a package script means every `electron-builder` invocation is stamped:
    `build:electron`, `build:electron:dist`, the install scripts and the `test:desktop:electron`
    gate.
- **`apps/desktop/electron-builder.yml`**: add `afterPack: scripts/electron-after-pack.cjs`.
- **`apps/desktop/main/entry.ts`**: at startup, when `app.isPackaged`, call
  `readBuildInfo(process.resourcesPath)` and `console.log` the `formatBuildInfoLogLine` result
  once, unconditionally rather than behind `DEBUG`. When `readBuildInfo` returns null, log that the
  build is unidentified rather than skipping the line.

## What stays

- `apps/desktop/version.ts`, which is unrelated to build identity.
- The root `package.json` `version`, so `CFBundleShortVersionString` stays `0.0.1`.
- All existing `files`, `asarUnpack` and `extraResources` entries.

## Tests to change

Add `apps/desktop/main/build-info.test.ts`, which compiles to `dist/main/build-info.test.js` and
runs under the electron runner. It imports the real `./build-info.js`, as the test-honesty lint
requires. Cover:

- `dirty` true for non-empty porcelain, false for empty or whitespace-only porcelain.
- A detached `HEAD` gives `branch: null`.
- A toplevel of `/x/peek` gives `checkout: "main"`; `/x/peek/.worktrees/foo` gives
  `"worktree:foo"`.
- `shortCommit` is a prefix of `commit`.
- The log line contains the short commit and the dirty flag.
- `readBuildInfo` on a temp dir returns the record when `build-info.json` is present, and null when
  it is absent or holds malformed JSON.

No existing test changes.

## Verify

The repo gate is the desktop unit tests. Record the counts from both runners under **Result**:

```
yarn workspace @peek/desktop test:unit
```

Done when both runners report `fail 0` with the new `build-info` cases counted. Then check the
packaged output (Linux x64 paths shown; on macOS use `out/mac-arm64/Peek.app/Contents/...` and also
run `plutil -extract CFBundleVersion raw out/mac-arm64/Peek.app/Contents/Info.plist`, which must
print the short commit):

```
yarn build
yarn build:electron
cat out/linux-unpacked/resources/build-info.json
git rev-parse HEAD
npx @electron/asar list out/linux-unpacked/resources/app.asar | grep -c '/.worktrees/'
```

Passing means:

- `build-info.json` exists and its `commit` equals `git rev-parse HEAD`.
- `dirty` matches whether `git status --porcelain` was non-empty at build time.
- The asar count prints `0`.
- Launching `out/linux-unpacked/peek --no-sandbox` prints one `[build]` line naming the commit and
  dirty flag. (`yarn packaged:log` only tails the macOS `run:packaged:bg` script's output, so it is
  not the place to look on Linux.)

## Working rules

Run one command per Bash call.
