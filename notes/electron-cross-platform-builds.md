# Automated cross-platform builds for the Electron desktop app

Status: research + proposed approach. Scope: packaged Electron desktop artifacts
(Linux, Windows, macOS). Tests are out of scope; this is about producing builds.

## Short version

Split by capability, not by convenience:

| Platform | Where | Artifact |
|---|---|---|
| Linux | Tangled spindle (existing) | `Peek-<tag>-x86_64.AppImage` |
| Windows | Tangled spindle, new workflow | `.zip` + portable `.exe` (no Wine needed); NSIS later |
| macOS | GitHub Actions `macos-14`, triggered from Tangled | `.dmg` + `.zip`, unsigned first |

Tangled cannot host the macOS job: both spindle engines ("nixery" and "microvm")
are Linux-only. GitHub Actions is the cheapest hosted macOS runner for a public
project, but the source does not need to move there — a tiny trigger repo can
clone `https://tangled.org/burrito.space/peek` at the tag. That keeps Tangled
canonical and avoids maintaining a source mirror.

Do not ship the macOS `.app` that can be cross-built on Linux. It works
mechanically, but it is unsigned, cannot be notarized, cannot be a `.dmg`, and
silently loses the two macOS native helpers that only build on Darwin.

## What exists today

- `.tangled/workflows/appimage.yml`: install, build, package AppImage on version
  tags and manual runs. `engine: nixery`.
- `.tangled/workflows/gate.yml`: manual-only install/typecheck/tests.
- `.tangled/workflows/feed.yml`: RSS generation.
- `scripts/publish-release.sh`: uploads exactly one `out/*.AppImage` and
  `SHA256SUMS` to R2, then writes a `sh.tangled.repo.artifact` record pointing
  at it. Skips publishing on non-tag runs. Uses `uname -m` and `sha256sum`.
- `apps/desktop/electron-builder.yml`:
  - Linux targets: `dir`, `AppImage`.
  - macOS targets: `dir`, arm64 only, `identity: null` (no signing).
  - Windows targets: `dir` only.
  - `afterPack` stamps build identity; `extraResources` include two native
    helpers that are built only when `process.platform === 'darwin'`.

So "cross-platform builds" is not only CI. The repo currently has no
distributable macOS or Windows target configured.

## What I verified locally (Linux x64, electron-builder 26.15.6)

These were packaging-only runs against the existing `apps/desktop/dist`; the
real workflows run `yarn build` first.

- `npx electron-builder --win zip --x64` → succeeds, `out/Peek-0.0.1-win.zip`
  (~185 MB). No Wine involved.
- `npx electron-builder --win portable --x64` → succeeds,
  `out/Peek 0.0.1.exe`. The portable target uses NSIS but does not build the
  uninstaller, so it also needs no Wine.
- `npx electron-builder --mac zip --arm64` → succeeds,
  `out/Peek-0.0.1-arm64-mac.zip`, but logs
  `skipped macOS application code signing: supported only on macOS` and warns
  that `peek-desktop-helper` / `nonactivating-window.node` are absent.
- `npx electron-builder --mac dmg --arm64` → fails at `sips process failed
  ENOENT`; `.dmg` creation is macOS-only.
- Tangled docs: nixery runs each step in a Docker container from a Nixery image;
  microvm runs the workflow in a Linux NixOS/Alpine/AlmaLinux VM. No
  macOS/Windows engine.
- `https://tangled.org/burrito.space/peek/raw/main/...` serves raw files, which
  makes AppVeyor's Generic Git mode viable if GitHub is unacceptable.

Not verified: a clean `yarn build` on Windows or macOS, running any produced
artifact on those platforms, or Wine/NSIS on the spindle. Treat the Windows
build as a build-system success, not a runtime sign-off.

## Constraints that drive the design

### Tangled

- Linux only. Both engines are Linux; there is no macOS runner and no way to
  boot one. `.dmg` also needs `sips`/`hdiutil`.
- One workflow is a single job; there is no native matrix. Separate platforms
  are separate workflow files, and they cannot depend on each other.
- Tag artifacts are capped at 50 MiB, hence R2 in the existing publish script.
  The AppImage is several times that, and a Windows zip/macOS dmg will be too.
- Workflow secrets are repo-level, so the existing R2 and ATP credentials are
  already available to a new Windows workflow.

### electron-builder cross-builds

- Windows `zip`/`portable` are pure JS + 7-Zip + `makensis`; verified on Linux.
  NSIS installer additionally runs the generated 32-bit uninstaller stub under
  Wine. That can be added later with a `wine`/`wine64` nix dependency, but it is
  a separate fragility (Nix's loader path is already the reason the AppImage
  workflow replaces electron-builder's tools).
- macOS `.app`/`.zip` can be produced on Linux, but signing is skipped at the
  builder level and the native macOS helpers are not built. Cross-built macOS
  artifacts are for smoke tests only, not releases.
- `win.icon` points at `apps/desktop/assets/appicon.ico` and `linux.icon` at
  `apps/desktop/assets/appicon.png`; neither file exists. Both builds currently
  fall back to the default Electron icon. `mac.icon` is fine (`appicon.icns`).
- `files: **/*` currently packs `.tangled/workflows/*` into `app.asar` (and would
  pack `.github/`). Small, but CI config should not ship.
- `apps/desktop/scripts/build-nonactivating-window.mjs` needs Node-API headers
  in `~/.electron-gyp/<electron-version>`. `yarn build` runs before
  electron-builder, so a fresh macOS CI runner must install those headers first
  or the addon is silently skipped.

### Signing / distribution

- macOS `identity: null` means unsigned. An unsigned arm64 app may launch
  locally after clearing quarantine, but it is not a normal download; proper
  distribution needs an Apple Developer ID ($99/yr) plus notarization.
- Windows has no certificate. `.zip`/portable will trigger SmartScreen; an NSIS
  installer would too. Signing can come later (OV/EV cert or Azure Trusted
  Signing).
- Ad-hoc macOS signing and `rcodesign` on Linux exist, but neither is worth
  building a release pipeline around.

## Options considered

| Option | macOS | Windows | Linux | Source on Tangled | Cost / caveat |
|---|---|---|---|---|---|
| Tangled only | no | cross-build yes | yes | yes | Cannot build macOS |
| GitHub Actions | yes | yes | yes | needs mirror or trigger repo | Free standard runners for public repos; second forge |
| AppVeyor Generic Git | yes | yes | yes | yes | Free OSS, 1 concurrent job, 60 min/job; external YAML URL; older Mac images |
| Buildkite / self-hosted Mac | yes | yes | yes | yes | You supply and maintain a Mac |
| Azure Pipelines | yes | yes | yes | needs mirror | Free OSS minutes; GitHub/Azure/Bitbucket sources |
| Cirrus CI | yes | yes | yes | needs GitHub | Free OSS; GitHub-only |
| GitLab SaaS | yes (paid minutes) | yes | yes | needs mirror | Hosted macOS not free |
| MacStadium / AWS Mac | yes | — | — | yes | $70–$100+/mo for one Mac; unnecessary |

The realistic shortlist is GitHub Actions (best macOS image, free for OSS,
familiar) and AppVeyor (no GitHub dependency, but clunkier). Everything else is
either GitHub-only, paid, or requires owning a Mac.

## AppVeyor, specifically

### Cost

- **Open-source plan: $0.** Unlimited public projects, 1 concurrent job,
  5 self-hosted jobs, community support. Every plan caps a single job at
  60 minutes.
- **Paid plans** only matter for concurrency or private projects: Basic $29/mo,
  Pro $59/mo, Premium $99/mo (2 concurrent jobs). Extra concurrency is
  $50/mo per job. AppVeyor advertises a 50% discount for open-source projects
  that need more compute, so the realistic paid step is ~$25-30/mo, not $99.
- **Artifacts** are retained 1 month on free accounts (3 months paid); build
  logs 6 months. Irrelevant here because artifacts go to R2 immediately.
- Apple's Developer Program ($99/yr) is separate and only needed for macOS
  signing/notarization, not for building.

For release-only macOS builds, one concurrent job is enough. Cost is $0.

### What the macOS runner actually is

- Images: `macos-sonoma` (macOS 14.2.1), `macos-ventura` (13.6.4),
  `macos-monterey` (12.7.3). Xcode 15.2 on Sonoma. Node 21 is preinstalled;
  nvm is available.
- The official image-update feed has recent Windows and Ubuntu entries through
  2026 but **no macOS entries at all**, and the macOS software page still lists
  Xcode 15.2 / macOS 14.2 from early 2024. Treat the macOS images as stale.
- Nothing in the docs advertises Apple Silicon. AppVeyor's hosted macOS VMs are
  historically Intel Mac minis. You can still cross-compile and package the
  arm64 Electron app (Xcode's `-target arm64-apple-macos...` works on Intel),
  but you cannot launch or smoke-test the result on the runner.
- 60-minute job cap is fine; the Electron build is dominated by downloads and
  should finish well inside it.

### Clunk, in order of annoyance

1. **Tag triggers depend on the git provider.** AppVeyor's docs section is
   literally "Build on tags (GitHub, BitBucket, GitLab, Gitea)". Generic Git
   does not get automatic tag builds. A Tangled-only setup therefore needs a
   Tangled workflow that POSTs `/api/builds` with the commit SHA and passes the
   tag as an environment variable. Workable, but it is a custom trigger, and
   the build will not look like a normal tag build in AppVeyor.
2. **Generic Git cannot fetch `appveyor.yml` from an arbitrary provider.**
   AppVeyor reads the YAML on its central servers before cloning, and supports
   that only for GitHub/Bitbucket/GitLab/Azure/Kiln/Gitea. For Tangled you must
   either use an external YAML URL (Tangled raw works:
   `https://tangled.org/burrito.space/peek/raw/main/appveyor.yml`) or configure
   the build in the UI. With the external URL, the config is read from `main`,
   not from the tag being released.
3. **The YAML and UI are dated and Windows-first.** Scripts are cmd/PowerShell
   on Windows and bash on macOS; matrices are a first-class concept but the
   syntax is unfamiliar. None of this is hard, it just reads like 2015 CI.
4. **Node 24 is not preinstalled.** Each run needs
   `nvm install 24.11.1 && nvm use 24.11.1 && corepack enable`, which adds a
   couple of minutes and one more moving part.
5. **No Tangled commit status.** AppVeyor can post status back to GitHub et al.,
   not Tangled. Irrelevant for release-only builds; would matter if this ever
   becomes a PR check.

If the source is a GitHub mirror, items 1 and 2 disappear entirely and the
remaining clunk is mild. But at that point GitHub Actions is strictly better:
`macos-14` is arm64, newer, and the same $0 for a public repo.

### AppVeyor verdict

Viable and free, and the only realistic non-GitHub hosted option with macOS.
The cost is not the problem; the macOS image freshness/architecture is. I would
use it only if avoiding GitHub is a hard requirement, or if a self-hosted Mac is
already available (AppVeyor BYOC can drive one). If a GitHub mirror is fine,
GitHub Actions is the lower-friction choice for the same price.

## Proposed approach

### Phase 1 — Windows on the spindle

Add `.tangled/workflows/windows.yml`, mirroring `appimage.yml`:

```yaml
when:
  - event: ["push"]
    tag: ["v*"]
  - event: ["manual"]

engine: "nixery"

dependencies:
  nixpkgs: [nodejs_24, yarn-berry, git, p7zip]

steps:
  - name: install
    command: yarn install --immutable

  - name: build
    command: yarn build

  - name: package Windows zip and portable exe
    command: |
      set -e
      export ELECTRON_BUILDER_7ZIP_PATH="$(command -v 7za || command -v 7zz)"
      yarn workspace @peek/desktop run build:electron:win
```

Add a desktop script:

```json
"build:electron:win": "cd ../.. && ./scripts/timed.sh electron-builder --win zip portable --x64"
```

Why `p7zip`: electron-builder otherwise downloads a 7za binary that may hit the
same missing `/lib64` loader as the AppImage tools on a Nix-based image.
`ELECTRON_BUILDER_7ZIP_PATH` is a supported override. If the spindle image
happens to run it, the override is still harmless.

Start with `zip` + `portable`. Add NSIS only if users need an installer; it
requires running a 32-bit uninstaller under Wine and is a separate risk.

Optionally also add `--linux AppImage --arm64` if Linux arm64 is wanted; it can
be cross-packaged from an x64 spindle. Out of scope here.

### Phase 2 — macOS on GitHub Actions

Implemented as `.github/workflows/macos.yml`. It assumes the GitHub repo is a
read-only mirror of the Tangled repo, so an ordinary tag push can trigger it:

- `runs-on: macos-15` (arm64; macOS 14 runners are deprecated).
- Node 24.11.1 via `setup-node`, then `corepack enable` and
  `yarn install --immutable`.
- `npx node-gyp install` for Electron 43's Node-API headers before
  `yarn build`, so `nonactivating-window.node` is actually built.
- `npx electron-builder --mac dmg zip --arm64`.
- Uploads `out/*.dmg` and `out/*.zip` as the `peek-macos-<tag>` artifact.

The mirror is the only new piece of infrastructure. Pushing tags to it is what
starts the build; there is no repository-dispatch chain and no separate trigger
repo. Do not use the cross-built macOS zip on the spindle as a release artifact.

### Phase 3 — publish per platform

Implemented in `scripts/publish-release.sh`:

```
scripts/publish-release.sh                      # legacy: one out/*.AppImage
scripts/publish-release.sh <platform> <file>... # e.g. macos-arm64 out/*.dmg out/*.zip
```

- Derives names from the tag and platform label, e.g.
  `Peek-<tag>-macos-arm64.dmg`, `Peek-<tag>-macos-arm64.zip`.
- Uploads every file plus `SHA256SUMS-<platform>` to R2 under `<tag>/`.
- Writes one Tangled artifact record per platform, named
  `Peek-<tag>-<platform>.txt`, containing each URL and checksum. Tangled allows
  multiple records per tag as long as `name` differs.
- Keeps the no-argument AppImage path and naming unchanged.
- Falls back to `shasum -a 256` when `sha256sum` is absent (macOS).

The macOS workflow calls it after packaging, gated on a tag run. It needs these
GitHub repo secrets, mirroring the Tangled repo secrets:
`TANGLED_REPO_DID`, `TANGLED_REPO_REPO_DID`, `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL`,
`ATP_APP_PASSWORD`.

Each builder publishes its own artifact. There is no way for a Tangled workflow
to wait for the GitHub macOS job, and a "publish after all platforms" job would
need a shared coordinator. Per-platform publishing is simpler and idempotent
(the script replaces stale records for the same tag+name).

### Phase 4 — signing, when there is something to distribute

- macOS: Developer ID Application cert + notarization, set `identity` and
  `notarize` in `electron-builder.yml`, add `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` as secrets.
- Windows: OV/EV cert or Azure Trusted Signing, then re-add `nsis` if wanted.
- Until then, label macOS/Windows artifacts explicitly as unsigned.

## Prerequisite cleanups (small, worth doing first)

1. Fix the icons. Either generate `appicon.png` and `appicon.ico`, or point
   `win.icon`/`linux.icon` at `apps/desktop/assets/appicon-rounded.png` and let
   electron-builder convert. Today both platforms ship the Electron icon.
2. Add `!.tangled`, `!.tangled/**` to `electron-builder.yml` `files`.
   `.tangled/workflows` is still inside `app.asar`; `!.github` is done.
3. Add explicit `artifactName` templates per platform so the publish step does
   not parse electron-builder defaults.
4. Decide macOS arch. The app is arm64-only today: both native helper scripts
   hard-code `arm64-apple-macos12.0` and the mac target is `dir/arm64`. An
   Intel or universal build is extra work (per-arch native addons), not a CI
   flag.
5. Run the Node-API header install before `yarn build` on macOS CI (done in
   the macOS workflow).

## Recommendation

Phase 1 is still the next small step (Windows zip/portable on the spindle).
Phases 2 and 3 are implemented; the remaining macOS work is operational:
mirror the repo, add the secrets, push a tag. Signing/notarization is still its
own decision because it costs money and is the only way the macOS artifact
becomes a normal download.

## Open questions

- Is a GitHub-hosted macOS runner acceptable, or should this stay entirely off
  GitHub even at the cost of owning/renting a Mac?
- Is Windows a real distribution target, or only something to keep building?
  That decides `zip` vs NSIS vs signed installer.
- Are unsigned macOS/Windows artifacts useful to anyone, or should they stay
  internal until signing is in place?
- Is Linux arm64 wanted alongside x64?
