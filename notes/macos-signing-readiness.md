# macOS Developer ID signing readiness

Status: **executable candidate integration implemented; no live candidate run**.
The [setup script and usage guide](../docs/macos-signing-secrets.md), neutral policy,
production adapter and manual candidate workflow have offline tests. The spec
stays `enabled: false` to prevent a duplicate writer. Metadata-only human/runtime
context reports all seven API secret **names**, reviewer `autonome` (self-review
allowed), and environment tag policy `v*` in `macos-release-signing`. Values,
credential validity, immutable-tag rules and clean-Mac acceptance remain unverified. This is not
authorization for the agent to enroll, spend money, change accounts/secrets, sign
a live build or publish a release. Distribution
is downloadable **arm64 `.dmg` and `.zip`**, not the Mac App Store. The unsigned
CI/test-build path and the separate startup-risk acknowledgment work must continue
unchanged. Manual-owned implementation plan: [disabled spec](../specs/macos-signing-and-notarization.md).

## Executable candidate path (offline verified, macOS acceptance pending)

`.github/workflows/macos-signing-candidate.yml` is manual-only, tag-only and gated
by `macos-release-signing`. It checks the reserved `v*-signing-candidate.N` name,
full expected source SHA, event SHA and tag's peeled commit. Both workflow and
adapter require GitHub's protected-ref flag; owner verification that the tag rules
actually prevent updates/deletion is still required. Checkout is detached
at the event SHA, without persisted credentials. Actions are full-SHA pinned,
permissions are `contents: read`, and installation/build/tests run before secrets
are introduced. Both automatic and manual unsigned workflow runs exclude the
reserved tag namespace. No public publisher or publication credentials are present.
GitHub artifacts are candidate downloads for repository readers, **not a public
release or a promise of private storage**.

`scripts/macos-signing-adapter.cjs` supplies real bounded process/filesystem
operations to the existing `runCandidate` policy. It imports one exact expected
identity into a random-password temporary keychain, validates/stores notary auth
there, uses the verified certificate fingerprint (builder rejects full-name
Developer ID prefixes), and passes only keychain/profile metadata to the builder
child. Scratch/credentials/config/copies are outside the checkout. It restores the
original search list even after partial preparation; SIGTERM/SIGINT abort the
active child then take the same cleanup path. Failed unmounts block success and
must not recursively delete a still-mounted volume. Hard termination relies on
hosted-VM disposal; this is not a self-hosted runner design.

The release-only override merges with the base `identity: null` using the locked
builder's actual merge implementation (covered by schema/merge tests), requires
`forceCodeSigning`, distribution identity and hardened runtime. Builder performs
`afterPack` **and signing inside the dir target**; the policy's subsequent
`signApp` operation verifies that completed seal rather than signing twice. Its
custom named sign export uses locked osx-sign's native discovery and per-file
options: JIT-only Electron app/process entitlements, empty Swift/addon/library
entitlements, no auto-entitlement/provisioning-profile injection. Signed afterPack
requires clean/full matching commit metadata and an explicitly owner-allocated
numeric build version; unsigned stamping remains unchanged.

**Deliberate implementation difference from the original built-in-notarize
proposal:** builder's override has `mac.notarize: false`; the adapter immediately
submits the signed app ZIP itself, waits at most 20 minutes, inspects Accepted plus
the matching zero-issue log, then staples/verifies **before any final archive is
created**. The locked built-in helper hides submission IDs/logs and has an unbounded
wait, so setting `notarize: true` as well would duplicate submissions without
meeting the audit/timeout requirement. This is not optional notarization or a
missing-auth fallback: neutral orchestration mandates both submissions and all
staple/Gatekeeper checks. Final ZIP uses ditto, final DMG uses hdiutil UDZO with an
Applications link; DMG is separately signed, notarized and stapled. No extra DMG
layout dependency or builder archive/notarize fallback is used.

The adapter inventories canonical Mach-O files, rejects symlink escapes, checks
arm64/signatures/entitlements and resolves dynamic dependencies conservatively
inside the bundle. It repeats verification on a fresh ZIP extraction and a
read-only mounted/copied DMG app. Only after both copies and credential cleanup
pass does it hash/copy exactly two final containers to the upload directory. The
sanitized receipt includes source/build identity, submission IDs, successful log
summaries and signature/entitlement/dependency inventories (no raw tool logs).
The workflow's final upload requires the adapter step's success. Failed verification
creates no upload directory/receipt and never calls a publisher.

Offline verification exercises the real adapter against filesystem fixtures and
fake tools, including partial prepare, wrong architecture/authority/team,
notary failures/timeouts/log issues, symlink escape, extracted-copy failures,
cleanup and cancellation. It does **not** establish that actual osx-sign discovery,
notarytool wait JSON, otool output/dyld contexts, keychain access, Gatekeeper or
Electron 43 works on the selected runner. Those checks, actual credential validity,
entitlement/build-number owner review, immutable tag creation protections and both
quarantined/offline clean-Mac downloads remain mandatory. See the operational
[candidate runbook](../docs/macos-signing-secrets.md#signed-candidate-runbook).

## Neutral policy/orchestration layer

`scripts/macos-signing.cjs` exports `runCandidate` plus shared evidence validators.
It has no CLI, subprocess, credential-file, upload or publisher implementation.
`scripts/macos-signing.test.cjs` exercises the module with injected operations and
synthetic data only. Do not treat its return value as a portable attestation,
a production upload authorization or a signed release approval.

Implemented policies:

- Explicit `unsigned` mode does not read credentials or call operations. Candidate
  mode requires a full Developer ID Application name matching the expected team,
  the existing bundle ID, full SHA, numeric build version, certificate inputs and
  exactly one complete auth mode. Ambient builder/notary fallback credentials and
  debug settings are rejected. Returned policy contains no credential material.
- Numeric format is canonical `major.minor.patch`: major 1–9999, minor/patch 0–99.
  This is a proposed *validation* policy, not a build-number allocator or owner
  approval. The eventual workflow must provide a stable, collision-aware numeric
  mapping and stamp it before signing, while retaining full commit metadata.
- Required native resources must be regular arm64 Mach-O files. App evidence
  requires complete native inventory, strict verification, expected signature
  authority/chain/team, timestamp, runtime for executables, explicit JIT-only
  Electron entitlements and empty helper/library entitlements. Dependencies must
  be system libraries or dynamic install names actually resolved inside the app.
- Both app and DMG submissions require valid IDs, explicit Accepted results and
  matching successful logs with no issues (warnings also block for review). App,
  ZIP-extracted app and mounted/copied DMG app evidence independently requires
  signature/inventory/build-identity/staple/Gatekeeper checks. DMG evidence also
  requires signature, staple and container verification.
- Ordering is preflight → prepare → pack/afterPack → inside-out app sign → app
  notarize/log/staple/verify → archives → DMG sign/notarize/log/staple/verify →
  extract/copy verification → cleanup → final hashing/manifest. No candidate
  receipt is returned on any failure, including cleanup failure. Errors suppress
  raw adapter/tool output; valid submission IDs survive for diagnosis. There is
  no retry/resubmit loop or public publisher operation.

**Historical adapter boundary (now implemented above; live validation pending):** real bounded subprocesses and plist/
Mach-O parsing; inventory discovery including symlinks and dependency resolution;
credential/keychain preparation and signal-safe cleanup/search-list restoration;
release-only builder configuration and per-file entitlements; numeric afterPack
stamping; real notarization/log retention and extraction/mount/copy verification;
final-byte immutability; and a separately protected, trusted-ref workflow with
SHA-pinned actions and fail-closed artifact upload. A boolean evidence flag is a
contract for that trusted adapter, not an independent observation by this module.
The fake-operation tests prove cleanup is **called**, not that a real keychain,
mount or credential file is removed. They prove no policy receipt on failure,
not live GitHub upload enforcement. Adapter/workflow structural tests now cover
that implementation offline. The only unsigned-CI change is excluding reserved
candidate tags; unsigned stamping/config and startup behavior are otherwise preserved.

Run the offline gate:

```sh
node --test scripts/macos-signing.test.cjs scripts/setup-macos-signing-secrets.test.cjs
bash -n scripts/setup-macos-signing-secrets.sh
shellcheck scripts/setup-macos-signing-secrets.sh
git diff --check
```

Provisioning fixtures now declare their own CommonJS package scope and self-test
before invoking the script. This avoids false authentication failures when
`TMPDIR` is inside the repository's `type: module` scope. Only dummy material and
fake gh are used; no real gh/account/credential operation is needed for the gate.

## Recommendation and account-holder checklist

Use Developer ID Application signing with hardened runtime, notarize and staple
the app before either archive is made, then notarize/staple the final DMG. Gate
**both** workflow artifact upload and R2/Tangled publication on verification.
Prefer a dedicated App Store Connect **team API key** over a person's app-specific
password, subject to the account holder accepting its account-wide scope.

Human actions, in order (none performed by this research):

- [ ] Identify whether an appropriate paid Apple Developer Program team already
  exists. Do not create another team or certificate until its owner confirms.
- [ ] Choose legal publisher: individual/sole proprietor vs organization. An
  individual's certificate identifies their legal name; an organization uses its
  verified entity name, not an arbitrary product/trade name. Confirm the desired
  name users will see and approve continued use of `com.autonome.peek`.
- [ ] If enrollment is needed, approve **US$99 per membership year**, with local
  pricing/tax as applicable. Eligible nonprofit/educational/government entities can
  request a waiver; open source alone is not a waiver. Enrollment needs an Apple
  Account with 2FA, legal identity and contact details. Organizations also need a
  legal entity, binding authority, D-U-N-S (except government), organization-domain
  email and a functional website. The Enterprise Program is not appropriate. [A1]
- [ ] Have the Account Holder create/approve a **Developer ID Application**
  certificate through Certificates, Identifiers & Profiles (CSR generated on a
  trusted Mac). Apple's manual certificate creation requires Account Holder;
  cloud-managed roles are a different route, not this exportable CI design. [A2]
- [ ] Assign certificate/key custodians and an encrypted backup/recovery process.
  Retain the CSR's private key; downloading the `.cer` alone is insufficient.
  Export certificate **with its private key** as a password-protected `.p12` on
  the trusted Mac. Transfer only through approved secret storage, never chat,
  source control, issue attachments, logs or artifacts. Base64 is encoding, not
  encryption. Do not share the Account Holder's password/2FA with CI.
- [ ] Choose notarization authentication below, obtain approval for its scope,
  and have an authorized human provision the named GitHub environment secrets.
  No App Store listing or App Review submission is needed to notarize this app.
- [ ] Approve a protected signing environment in `autonome/peek-builds`, trusted
  tag/ref policy, reviewers, renewal owner and incident contact. Confirm the
  actual team ID/certificate identity out of band; no account state is known here.
- [x] Authorize manual candidate-only implementation and the local gh setup script.
- [ ] Provision protected environment and separately authorize execution of a manual signed candidate
  **without public release**, then a clean-machine Gatekeeper/offline smoke test.
  Only after that approve signed tag publication. Do not retrofit existing releases.

**Certificate distinctions:** Developer ID Application signs `.app`, nested code
and optionally the DMG. Developer ID Installer signs flat installer **`.pkg`**;
Peek's DMG drag-install and ZIP do not require it. Mac App Store distribution uses
other distribution identities, provisioning/sandbox rules and App Review; that is
not this plan. A provisioning profile is not expected for the current non-sandboxed
Developer ID app using no restricted capabilities. Revisit if adding services such
as CloudKit, push, app groups or system extensions; do not add a profile or sandbox
entitlements merely because the build is signed. [A2, A3]

## Repository audit (facts, not a successful signed build)

| Area | Observed configuration / consequence |
|---|---|
| `.github/workflows/macos.yml` | `macos-15`, Node 24.11.1, immutable install, Electron headers, `yarn build`, `electron-builder --mac dmg zip --arm64`. No signing/notary credentials configured in the file. Artifact upload follows packaging; tagged runs then publish to R2/Tangled. No explicit signature/notary gate. This says nothing about remote secret inventory. |
| `apps/desktop/electron-builder.yml` | `appId: com.autonome.peek`, Electron 43.0.0, `mac.identity: null` explicitly disables builder signing. No explicit entitlements, hardened-runtime or notarize settings. Default mac target is `dir/arm64`; CI overrides targets. ASAR enabled. |
| Native code | Both build scripts in `apps/desktop/scripts/` hard-code `arm64-apple-macos12.0`. Missing Swift/compiler/headers can yield a warning and successful build with missing helper. Neither script runs Developer ID signing. `extraResources` copies `peek-desktop-helper` and `nonactivating-window.node` into `Contents/Resources/`, outside ASAR. |
| Other executable content | Electron main/helper apps/frameworks; any rebuilt native dependency (`.node`/dylib/Mach-O) under `app.asar.unpacked` must be inventoried too. `peek-mcp`, `peek-mcp-init` and `peek-cli.mjs` are scripts, sealed as resources, not standalone Mach-O signing targets. MCP uses Electron-as-Node: do not disable the RunAsNode fuse as a signing side effect. |
| Build identity | `scripts/electron-after-pack.cjs` changes resources and Info.plist in **afterPack**, before signing. Keep that order; never edit sealed payload after signing. It currently sets `CFBundleVersion` to a short git hash: replace with a valid numeric bundle build version before a signed candidate, keeping SHA in `PeekBuildCommit` and build-info.json. Do not assume Apple accepts an arbitrary hex hash as a build version. |
| Publication | `scripts/publish-release.sh macos-arm64 out/*.dmg out/*.zip` hashes/uploads its inputs, then announces URLs. It does not establish Apple trust. Verification must finish before calling it; checksums must describe final stapled bytes. |

`yarn.lock` pins electron-builder/app-builder-lib **26.15.6**,
`@electron/osx-sign` **1.3.3**, `@electron/notarize` **2.5.0**. Local installed
source agrees. Important version-specific findings [L1]:

- `MacTargetHelper.handleNullIdentity()` skips signing for `identity: null`;
  `forceCodeSigning: true` makes that an error. Release configuration must remove
  or override null, choose Developer ID distribution, require signing, and check
  the actual authority/team (not just command success or ad-hoc fallback).
- Non-MAS signing defaults to hardened runtime. Make it explicit in a future
  release-only configuration. `notarize: true` **does not fail closed for absent
  auth**: `notarizeIfProvided()` warns and skips when it cannot construct options.
  Credential preflight **and** final stapler/Gatekeeper checks are mandatory.
- Built-in notarization submits a temporary ZIP of the signed app with
  `notarytool --wait`, then staples the `.app`. This does not prove the final DMG
  has a ticket. Plan a separate final-DMG submission/stapling step.
- The signing walker visits nested binary content, including Resources, so both
  custom helpers are expected to be discovered. This is a source-based expectation,
  **not tested** on Peek. Inventory and individually verify them. If discovery
  misses code, use `mac.binaries` with app-relative paths such as
  `Contents/Resources/peek-desktop-helper`, or a narrowly scoped signing hook.
  Avoid signing the same binary twice or overriding a valid inner signature after
  the outer app has been signed. Do not use `codesign --deep` as a repair/signing
  strategy; sign inside-out. `--deep` is useful for verification.

### Native code and minimum entitlements

Apple requires valid Developer ID signatures for distributed executables, secure
signing timestamps, hardened runtime for app/command-line targets, and no true
`com.apple.security.get-task-allow`. Notarization is an automated scan, **not** a
security audit, App Review or a guarantee that private APIs keep working. [A3]

- Electron/V8 needs `com.apple.security.cs.allow-jit` on the relevant Electron
  host/helper processes. Current Electron notarize guidance says **not** to add
  `allow-unsigned-executable-memory` for Electron 12+. The pinned builder's default
  entitlement template nevertheless includes that and `disable-library-validation`
  in addition to JIT. Do not silently accept those broad defaults: provide reviewed
  explicit main/inherited plists and test Electron 43. [E2, L1]
- `nonactivating-window.node` is a Node-API Objective-C++ AppKit bundle loaded into
  an Electron process. Sign it with the same team as the host. Entitlements on a
  library are not a substitute for host entitlements. There is no observed need
  for its own special entitlement, JIT or an Apple provisioning profile. Library
  validation should allow Apple/same-team libraries; add
  `disable-library-validation` only if runtime evidence establishes a required
  third-party plugin/library load and a security review accepts the exception.
- `peek-desktop-helper` is a standalone Swift subprocess. It resolves SkyLight
  private APIs via `dlopen`/`dlsym` and talks JSON over stdin/stdout. It needs its
  own timestamped hardened Developer ID signature. No evidence suggests JIT or
  broad memory/library-validation exemptions; use a minimal helper policy rather
  than inheriting Electron's exceptions if a per-file signing hook is necessary.
  Loading an Apple system framework is not itself a reason to disable validation.
  Private APIs remain an OS compatibility and notarization risk to test, not a
  claim of App Store eligibility. Signing does not grant Accessibility/Screen
  Recording permissions or bypass TCC.
- **Required build behavior change for signed CI:** assert both native outputs
  exist, are executable/loadable Mach-O arm64 with expected dependencies, and
  survive packaging. Keep local fallback behavior outside signed release mode.
  No compiler flag/architecture rewrite is presently indicated; Intel/universal
  would need separate compilation and signing verification and is out of scope.
- Smoke-test pages over other apps, Spaces helper `hello`/layout, browser JIT,
  extensions and MCP from the installed app under hardened runtime. A notary
  acceptance alone cannot establish these work.

`arm64` is a CPU architecture, not a trust level. Compiler/runtime-provided ad-hoc
signatures can exist even in a build called “unsigned”; ad-hoc has no Developer ID
publisher identity and cannot replace notarization. Developer ID establishes
publisher/integrity, but without notarization a modern quarantined download can
still be blocked. A notarized/stapled Developer ID build is the intended normal
Gatekeeper path (with the normal first-launch confirmation, not silent execution).
Never make clearing quarantine, disabling Gatekeeper or “Open Anyway” part of its
release acceptance test.

## CI authentication contract (names only)

**Proposed, not created.** Put credentials in a protected GitHub environment, e.g.
`macos-release-signing`; name is a proposal. Nonsecret team/identity metadata may
be GitHub variables instead. No existing secret values were inspected.

| Name | Meaning / handling |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | Encrypted exported Developer ID Application identity (certificate + private key), base64 encoded. Decode into `$RUNNER_TEMP`, mode 0600; never workspace. |
| `MACOS_CERTIFICATE_PASSWORD` | Password for that P12. Independent from Apple Account auth. |
| `MACOS_SIGNING_IDENTITY` | Expected Developer ID Application identity selector (name or fingerprint); not private. Verify resulting signature's authority and team. |
| `APPLE_TEAM_ID` | Expected developer team ID; also needed for password auth. Not private. |
| `APPLE_API_KEY_P8` | **Preferred:** team API private key contents, downloaded once; write a 0600 temporary `.p8` file. |
| `APPLE_API_KEY_ID` | Key ID for that team key. |
| `APPLE_API_ISSUER` | Issuer ID for that team key. |
| `APPLE_ID` | **Alternative only:** dedicated authorized Apple Account login, if password auth is chosen. |
| `APPLE_APP_SPECIFIC_PASSWORD` | Alternative app-specific password; never the account's normal password or 2FA code. |

Preferred team API key: current `@electron/notarize` guidance specifies **App
Manager** access. Have the Account Holder request API access and Account
Holder/Admin create a dedicated team key. This is **not a notary-only role**:
Apple says team keys' app access cannot be limited to one app. Review blast radius
if this team also ships other products. Do not claim a Developer-role key is
sufficient without independently verifying it. Individual keys are now documented
for Xcode 26+ with the issuer omitted, but the pinned builder requires all three
API environment fields including issuer; do **not** select individual keys for
this design without a tooling change and validation. [A5, E2, L1]

At runtime prefer storing the selected auth in the **ephemeral keychain** with
`xcrun notarytool store-credentials`, validating it up front, then giving builder
only `APPLE_KEYCHAIN` (temporary keychain path) and `APPLE_KEYCHAIN_PROFILE`
(profile name). Neither is a remote secret. Alternatively, direct builder API
auth uses `APPLE_API_KEY` as the **absolute file path**, not `.p8` text, plus
`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`. Builder password auth uses
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`. Choose exactly one mode;
clear unused auth variables because password auth takes precedence over API,
then keychain-profile auth in this pinned version. Never mix credentials from
multiple teams.

Signing identity import can use explicit `security import` into the ephemeral
keychain (preferred for a single documented lifecycle). Builder also supports
`CSC_LINK` (P12 file path or base64), `CSC_KEY_PASSWORD` and `CSC_NAME`; these are
**alternative runtime mappings**, not extra remote secrets needed on top of this
contract. If importing explicitly, use `CSC_KEYCHAIN` to select that keychain and
verify the selected identity; do not also ask builder to import the P12. Neither
the API key nor an app-specific password can sign code without the P12 identity.

## Manual-approved design and publication order (not yet integrated)

1. Keep normal unsigned/manual builds unchanged. Add a separately authorized
   signed-candidate path with a protected environment and explicit signed mode.
   Signed-mode failure must never fall back to unsigned artifact publication.
2. Before exposing credentials: checkout a reviewed immutable commit/tag, use
   `permissions: contents: read`, `persist-credentials: false`, install/build with
   no signing credentials in scope, assert helpers/architecture. Restrict trusted
   tag creation, protect workflow/config changes, require reviewers, and pin
   third-party actions to reviewed full SHAs. No pull_request_target/untrusted
   PR or arbitrary workflow_dispatch ref may reach signing credentials. Environment
   branch/tag policies must enforce this, not just a UI checkbox or tag prefix.
3. Create a uniquely named keychain in `$RUNNER_TEMP` with a randomly generated
   per-job password (mask immediately; never persist it as a repository secret),
   unlock it with a bounded timeout, import only the required identity using
   `security import`, permit `/usr/bin/codesign` via the key partition list
   (`apple-tool:,apple:,codesign:`), and set/restore the user search list as needed.
   Check `security find-identity -v -p codesigning "$KEYCHAIN_PATH"` against the
   expected identity. Do not import into login/system keychains or use blanket
   allow-all application access. GitHub documents this lifecycle. [G1]
4. Decode credentials with shell tracing **off**, `umask 077`, no `echo` of
   values, no debug env dumps. Store/validate notarization credentials in the
   temporary keychain. Scope secret env only to the preparation/sign/notary steps;
   remember dependency hooks invoked during packaging can still access them.
   Code review/dependency integrity remains part of the trust boundary. Do not
   cache keys/keychains or include them in ASAR or upload globs.
5. Release-only configuration: Developer ID distribution identity, top-level
   `forceCodeSigning: true`, `mac.hardenedRuntime: true`, reviewed entitlements,
   `mac.notarize: true`, explicit keychain. Keep build-identity writes in afterPack,
   before signing; validate numeric CFBundleVersion. Verify nested signing and
   the app's team/authority/runtime/timestamp. Use default nested discovery first;
   add targeted signing only if necessary, before the outer seal.
6. Builder notarizes/staples the `.app` **before** generating DMG/ZIP. Verify this
   ordering on the pinned version, and inspect ZIP contents for the staple.
   Separately `notarytool submit` the final DMG, require JSON `status == Accepted`
   (not merely exit success), save submission ID, inspect the notary log even on
   success, then staple and validate the DMG. Signing the DMG with Developer ID
   Application is recommended; never alter it except stapling after submission.
   ZIP cannot be stapled: it must contain the already-stapled app. [A4]
7. Verify the app inside **each** shipped container, not only the staging `.app`.
   Retain sanitized signature inventories, submission IDs/logs and checksums for
   audit (review logs for sensitive metadata before upload). Finish clean-Mac
   acceptance before first public signed release. Only then upload artifacts,
   compute final hashes and call the existing publisher. Do not publish staging
   ZIPs submitted to Apple or pre-staple DMG bytes. Consider increasing the 45-min
   timeout: a notary queue delay is not a reason to publish unchecked bytes.
8. Always-run cleanup: delete temporary P12/P8, delete the temporary keychain,
   restore search list/default keychain if changed, clear temporary profiles and
   generated credential files. GitHub-hosted VMs are disposable, but cleanup is
   still required; no self-hosted runner design is implied. R2/ATP publication
   credentials belong only in the final publish step, not the signing step.

## Verification recipe for a future authorized macOS candidate

These are **proposed commands, not commands run in this research**. Paths/names
must be resolved from actual build outputs; reject ambiguous globs. The expected
team/identity comes from human-approved metadata, never from the artifact itself.

```sh
# Toolchain / native prerequisites (before packaging)
uname -m                          # require arm64 on the selected runner
xcodebuild -version
xcrun --find notarytool
xcrun --find stapler
file apps/desktop/dist/native/peek-desktop-helper
file apps/desktop/dist/native/nonactivating-window.node
lipo -archs apps/desktop/dist/native/peek-desktop-helper
lipo -archs apps/desktop/dist/native/nonactivating-window.node

# After signing and app stapling; set APP to the actual staging .app path
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --verbose=4 "$APP"      # require Developer ID Application, expected TeamIdentifier,
                                   # runtime flag and secure Timestamp (not ad-hoc)
codesign -d --entitlements :- "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"  # expect Notarized Developer ID
codesign --verify --strict --verbose=2 "$APP/Contents/Resources/peek-desktop-helper"
codesign -d --verbose=4 "$APP/Contents/Resources/peek-desktop-helper"
codesign --verify --strict --verbose=2 "$APP/Contents/Resources/nonactivating-window.node"
codesign -d --verbose=4 "$APP/Contents/Resources/nonactivating-window.node"
otool -L "$APP/Contents/Resources/peek-desktop-helper"
otool -L "$APP/Contents/Resources/nonactivating-window.node"

# Final DMG, using prepared ephemeral keychain auth; parse JSON status explicitly
xcrun notarytool submit "$DMG" --keychain "$KEYCHAIN_PATH" \
  --keychain-profile "$NOTARY_PROFILE" --wait --output-format json
xcrun notarytool log "$SUBMISSION_ID" --keychain "$KEYCHAIN_PATH" \
  --keychain-profile "$NOTARY_PROFILE" "$NOTARY_LOG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
hdiutil verify "$DMG"
codesign --verify --strict --verbose=2 "$DMG"   # when DMG signing is selected
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"

# Fresh directory: inspect the shipped ZIP, not a previous staging app
# ZIP_DEST must be a newly created empty directory outside the signed payload.
ditto -x -k "$ZIP" "$ZIP_DEST"
xcrun stapler validate "$ZIP_DEST/Peek.app"
codesign --verify --deep --strict --verbose=2 "$ZIP_DEST/Peek.app"
spctl --assess --type execute --verbose=4 "$ZIP_DEST/Peek.app"
```

Also enumerate every Mach-O in the app with `find`/`file` (not just file suffixes),
verify each signature/team and inspect process entitlements. Main and standalone
executables need runtime/timestamp checks; a library's entitlements do not grant
host permissions. Reject unexpected external build-machine dylib paths. Mount the
DMG read-only, copy its app to a fresh directory, repeat signature/stapler checks,
and detach it. Record authority/team and entitlement checks for **both** extracted
apps; commands that only display metadata need assertions in the implementation.

Download each final candidate in a browser to a clean Apple Silicon Mac so it has
quarantine; leave Gatekeeper enabled. Drag-install/open, confirm publisher and no
“unidentified developer” or “damaged” bypass, then test a freshly installed copy
with networking disabled (no prior online acceptance cache). Test both formats,
helper/addon behavior, normal browsing/renderer JIT, extensions, MCP and relaunch.
CI `spctl` on a non-quarantined staging bundle does not replace this acceptance.

## Failures, renewal and remaining decisions

- Missing identity/auth, ad-hoc authority, wrong team, unsigned native code,
  invalid entitlements, rejected/invalid notary result, missing staple or failed
  Gatekeeper assessment: stop signed-mode uploads/publication. Never silently
  disable hardened runtime or add broad entitlements to get green CI.
- For timeout/service failure retain the submission ID; use `notarytool info`,
  `log` or `history` through the selected profile before retrying. A timeout is
  not a rejection or acceptance. Avoid endless resubmission; Apple documents a
  75-submissions/day limit. Diagnose authentication/team/agreements, network,
  timestamp and nested signing from the notary log. Review warnings too. [A4]
- Assign a calendar owner for annual membership, actual certificate NotAfter,
  API-key/user access reviews and password rotation. Renew before expiry, test a
  candidate, then replace CI credentials; keep encrypted recovery custody.
  Timestamped Developer ID app signatures can survive certificate expiration,
  unlike revocation; do not assume this for expiring profiles or PKG installers.
  Membership expiry is different from certificate expiry. [A2]
- If compromised: stop signing/publication, remove CI access, have the authorized
  account owner revoke the API key/password and contact Apple about compromised
  Developer ID certificates/tickets; audit submissions/releases, issue fresh keys
  and a newly signed/notarized release. Revocation can break previously released
  apps; it is not routine renewal. Do not overwrite old release bytes silently.
- Decisions still required: legal publisher/team and identity; enrollment/cost
  approval if necessary; auth choice and account-wide API scope; custodians and
  reviewers; numeric build-number policy; entitlement policy validated on Electron
  43 and native helpers; whether to require DMG signing (recommended here);
  candidate-only workflow/ref policy and clean-Mac acceptance owner.

## Evidence and limits

Official pages retrieved during this track's research on **2026-10-27** (runner
clock/HTTP date). Account state, enrollment status, certificate inventory, remote
secrets and remote releases were **not** inspected. No Apple account was accessed,
no credentials generated/exported/imported, and no signing, notarization, macOS
packaging or Gatekeeper runtime test was performed. Documentation/reference and
whitespace checks were the only executed verification for the research commit.
Subsequent provisioning implementation is tested locally using fake gh and dummy
files only; see the setup guide. No real gh secret/account operations were run.

- **A1:** [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/)
  — requirements, entity choices and annual price.
- **A2:** [Apple: Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
  — roles, Application vs Installer, creation and expiration/revocation FAQ.
- **A3:** [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
  — signing, timestamp/runtime requirements, nested plugin entitlements.
- **A4:** [Apple: Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
  — notarytool, logs, containers, stapling and limits. Apple DocC JSON content
  was retrieved for A3/A4 rather than relying on JavaScript shell pages.
- **A5:** [Apple: App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
  — API access requests, team/individual keys, roles, scope and revocation.
- **E1:** [Electron: Code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
  — macOS signing/notarization overview.
- **E2:** [Electron notarize README](https://github.com/electron/notarize/blob/main/README.md)
  — JIT/unsigned-memory guidance, API-key/password/keychain auth; current upstream
  guidance, **not** evidence that every option works with Peek's pinned versions.
- **G1:** [GitHub: Installing an Apple certificate on macOS runners for Xcode development](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
  — P12 import, temporary keychain, partition list and cleanup lifecycle. Its
  provisioning-profile example does not mean Peek needs a profile.
- **L1:** Pinned installed sources: `node_modules/app-builder-lib/out/mac/MacTargetHelper.js`,
  `out/macPackager.js`, `templates/entitlements.mac.plist`;
  `node_modules/@electron/osx-sign/dist/cjs/{sign,util}.js`;
  `node_modules/@electron/notarize/lib/{index,notarytool}.js`. Recheck after upgrades.
  electron.build's `/code-signing` and old `/code-signing-mac.html` returned 404,
  `/mac/` returned a client redirect shell, and attempted versioned GitHub source
  URLs returned 404. Accordingly builder-specific claims above are based on the
  actual locked local source, not an invented successful current web citation.

`notes/electron-cross-platform-builds.md` has earlier proposals mixed with later
implementation notes. Use the current workflow/config and this audit for macOS
signing readiness, not its initial runner/trigger/publisher descriptions.
