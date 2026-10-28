---
enabled: false
touches: [.github/workflows/macos-signing-candidate.yml, .github/workflows/macos.yml, scripts/macos-signing-adapter.cjs, scripts/macos-signing-adapter.test.cjs, apps/desktop/electron-builder.yml, apps/desktop/assets/entitlements.mac.plist, apps/desktop/assets/entitlements.mac.inherit.plist, apps/desktop/assets/entitlements.mac.helper.plist, scripts/electron-after-pack.cjs, scripts/macos-signing.cjs, scripts/macos-signing.test.cjs, scripts/setup-macos-signing-secrets.sh, scripts/setup-macos-signing-secrets.test.cjs, scripts/prepare-macos-signing-credentials.sh, scripts/prepare-macos-signing-credentials.test.cjs, docs/macos-signing-secrets.md, notes/macos-signing-credentials-setup.md, notes/macos-signing-readiness.md]
depends-on: []
---

# DISABLED: Developer ID signing and notarization for macOS arm64 CI

**Manual implementation approved: candidate-only path and local gh secrets setup.**
The user explicitly approved this implementation and requested a local setup script.
Keep `enabled: false`: this manual track owns implementation; no duplicate automated
writer is authorized. The user has additionally approved standard Apple CLI password
handling on disposable GitHub-hosted runners and proceeding with a protected signed
candidate. Enrollment, purchases, generating/exporting user keys, reading secret
values and signed public publication remain unapproved. The coordinator may perform
the explicitly authorized repo-scoped GitHub setup and candidate dispatch; required
human environment approval remains in force.

Delivered terminal-only preparation companion:
`scripts/prepare-macos-signing-credentials.sh` and offline fixture tests create an
encrypted RSA key/CSR, validate and package a manually issued Developer ID
Application certificate as P12, and inspect public identity/team metadata. This
is separate from uploading, never generates an Apple API P8, and performs no
account/keychain operations. Apple portal issuance and API key download remain
human-owned. See the [credential checklist](../notes/macos-signing-credentials-setup.md).

Delivered provisioning component: `scripts/setup-macos-signing-secrets.sh`, fake-gh
tests in `scripts/setup-macos-signing-secrets.test.cjs`, and
[usage instructions](../docs/macos-signing-secrets.md). The offline policy and
adapter-driven orchestration in `scripts/macos-signing.cjs` and its pure tests
are also implemented. The production process/filesystem adapter, protected manual
candidate workflow, release-scoped builder override and minimal entitlements are
now implemented with offline fake-tool/schema/workflow tests. **No live signed
candidate has run**. See the readiness audit and candidate runbook for remaining
human/macOS gates. One deliberate implementation difference is adapter-owned
bounded notarization/log inspection instead of the builder's opaque built-in
notarizer; builder still signs its dir target before mandatory app notarization,
stapling and final archive creation. Public signed publication remains disabled;
unsigned behavior is unchanged outside reserved signing-candidate tags/runs.

The user has requested resuming GitHub signing. Metadata-only checks found all seven
API-mode secret names in `macos-release-signing`, a required-reviewer protection and
custom tag policy now narrowed to `v*-signing-candidate.*`; no secret values were
accessed. Self-review is currently allowed. Preserve required reviewer protection. Candidate execution must remain behind
that explicit GitHub environment approval, and public signed publication stays
disabled. Use a reviewed immutable candidate tag plus an expected source SHA check;
never expose credentials to arbitrary mutable refs. Reserve an explicit
`v*-signing-candidate.*` namespace and prevent the existing unsigned tag workflow
from publishing those candidates. Existing normal release/unsigned behavior stays
unchanged outside this namespace.
Research and exact proposed secret names: [readiness notes](../notes/macos-signing-readiness.md).
Do not touch the startup-risk acknowledgment implementation or delay unsigned
builds. No dependency on that track is required.

## Review-fix security boundary (hosted-runner exception approved)

The standard `security` CLI currently puts P12 and ephemeral-keychain passwords
in subprocess argv (`import -P`, `create-keychain -p`, `unlock-keychain -p`,
`set-key-partition-list -k`). The alternative password-auth adapter path also
uses `notarytool store-credentials --password`; the workflow wires API-key file
auth only. Suppressing logs/errors does not prevent local argv inspection.
The user explicitly approved this standard Apple approach for disposable
GitHub-hosted runners ("apple's way is fine"). This exception permits the protected
candidate run, not persistent/shared runners, raw argument logging, or public signed
publication. Do not generalize the preparation/uploader scripts' no-secret-argv
guarantee to the signing adapter.

Tool subprocesses own isolated POSIX process groups. Timeout/cancellation/output
limit and surviving descendants receive SIGTERM, then bounded SIGKILL (250 ms).
Before credential cleanup the runner verifies group quiescence (no live members;
zombies cannot execute). Failure stops further tools/cleanup/upload and preserves
scratch for VM disposal. This is not containment of malicious dependencies that
escape process groups. Actual macOS cancellation and credential cleanup remain
unverified. P12 preparation explicitly exports 3DES key/cert PBE plus SHA1 MAC,
2048 iterations for Apple interoperability; tests inspect actual fixture metadata
and confirm the AES-encrypted source key is unchanged.

The coordinator created active tag ruleset `26046298`, matching
`refs/tags/v*-signing-candidate.*`, with update/deletion restrictions and no bypass
actors. Candidate creation still requires trusted repository write access; the
human reviewer must verify the source SHA. The environment permits only those
candidate tags and retains its required reviewer. Protected-ref and environment
policy alone are not substitutes for inspecting these rules.

## Human prerequisites / decisions

Before operating a signed candidate, record owner approval for:

1. Legal publisher, existing/new Apple Developer Program team, annual enrollment
   cost if needed, expected team ID/Developer ID Application identity and bundle ID.
2. Account Holder-provisioned certificate/private-key custody and recovery; the
   authorized human supplies protected GitHub environment secrets, not the agent.
3. Preferred dedicated App Store Connect team API key (App Manager scope, not
   app-limited) vs dedicated Apple Account/app-specific password. Do not use
   individual API keys with the current builder auth adapter.
4. Protected signing environment, reviewer(s), permitted immutable refs/tags,
   workflow/dependency change policy and clean-Mac acceptance owner. Confirm the
   account plan supports the required environment protections before relying on them.
5. Explicit resolution of the password-in-argv decision above, and authorization
   of an immutable reserved-tag ruleset before a candidate run.
6. Numeric CFBundleVersion policy, reviewed entitlement policy, recommended final
   DMG signature and candidate approval-to-publication process. Reject any
   entitlement broadening without evidence and explicit review.

## Scope / bounded implementation

- Preserve current unsigned builds and artifact publication behavior outside
  explicitly selected signed mode. In signed mode, no fallback upload of unsigned
  or partially verified bytes. Start with candidate-only manual runs: no R2 or
  Tangled publication until acceptance is approved. Ensure manual refs cannot
  bypass trusted-ref policy to obtain secrets.
- Keep all signing settings release-scoped; do not enable local identity discovery
  as a side effect. Use a generated temporary builder override if necessary, and
  verify how it merges with the base `mac.identity: null` before relying on it.
  Require `forceCodeSigning`, Developer ID distribution, hardened runtime and
  notarization. Preflight exactly one complete auth mode because `notarize: true`
  alone can skip silently on missing auth in builder 26.15.6. Implementation uses
  `mac.notarize: false` only inside the generated override: mandatory adapter-owned
  app/DMG notarization replaces it, retaining IDs, bounding waits and inspecting
  logs. This is not an option to skip notarization or upload unsigned artifacts.
- Keep neutral policy/orchestration in `scripts/macos-signing.cjs` plus pure-policy
  tests; add the production process/filesystem adapter and fake-tool regression
  tests in `scripts/macos-signing-adapter.cjs` and its test file. Explicitly
  separate preparation, verification and cleanup. Credential
  handling must not log values, shell-expand secrets into command strings, enable
  tracing/debug output or persist private material in the checkout. Review even
  errors/debug output from child tools for sensitive arguments before recording.
- Use a random-password temporary keychain with least-privilege codesign access;
  select via `CSC_KEYCHAIN`, expected identity via `CSC_NAME`. Prefer ephemeral
  keychain notarization profile via `APPLE_KEYCHAIN`/`APPLE_KEYCHAIN_PROFILE`.
  `APPLE_API_KEY_P8` is remote secret contents, not builder's `APPLE_API_KEY` path.
  Map them deliberately. Cleanup runs on success/failure/cancellation where the
  runner is still executing; VM disposal is the final backstop for hard termination.
- Workflow permissions `contents: read`, checkout without persisted credentials,
  reviewed SHA-pinned actions, trusted protected refs and environment approval.
  Build/dependency installation without signing credentials. Publication secrets
  only on the final step. Retain no secret-bearing keychain/cache/artifact.
- Assert native helper/addon existence/arm64 architecture in signed mode without
  changing normal local build fallbacks. Inventory all shipped Mach-O code.
  First test osx-sign discovery for both Resources binaries. If insufficient,
  use targeted `mac.binaries` or a narrowly scoped per-file signing policy;
  do not double-sign after sealing the outer app. Standalone Swift helper should
  not automatically receive Electron's JIT exceptions. Add a small signing hook
  only if discovery/per-file policy requires one, within the listed script.
- Explicit entitlement plists: Electron JIT as needed for main/helper processes;
  no `get-task-allow`, sandbox or broad unsigned-memory/library-validation
  exceptions by default. Standalone Swift helper has minimal entitlements. Test
  current Electron 43 and same-team native addon under hardened runtime. Do not
  change Electron fuses, MCP launcher, app behavior, architecture or private API
  use under cover of signing.
- Keep afterPack build-info/Info.plist writes before signing. Replace hex
  `CFBundleVersion` with the approved valid numeric build version; keep full SHA
  in `PeekBuildCommit` and JSON. Fail signed-mode stamping if invalid/missing.
- App signing/notarization/stapling before DMG and ZIP creation. The original
  built-in-notarization proposal is implemented using builder dir-target signing
  plus explicit adapter-owned app submission/log/stapling, because the locked
  built-in helper does not expose IDs/logs or a bounded wait. Separately
  sign (if selected), notarize and staple final DMG. Explicitly require Accepted
  status and inspect logs. Verify final ZIP has stapled app; never staple a ZIP.
  No edits to signed app payload after sealing and no checksum/publication until
  final stapling and container extraction verification pass.
- Retain sanitized notary submission IDs/logs and signature/entitlement inventory;
  bound waits/retries and diagnose prior submission on timeout rather than blindly
  resubmit. Reassess workflow's current 45-minute timeout. Existing
  `scripts/publish-release.sh` stays unchanged and receives only verified final
  artifacts. Old releases are not modified.

Dependencies are operational approvals and the pinned Electron/builder/notary
stack, not another spec. No new signing service, provisioning profile, `.pkg`,
Mac App Store target or paid infrastructure is required by this scope. If native
source or architecture changes become necessary, stop and propose a follow-up
rather than expanding the touches list silently.

## Tests required before any public signed release

Pure tests in `scripts/macos-signing.test.cjs`, with fake processes/files and no
credentials/network, must cover:

- unsigned mode unchanged; incomplete/mixed auth rejected; signed mode with null
  identity/ad-hoc/wrong team cannot succeed;
- missing helper or wrong architecture fails before signing;
- authority/team/runtime/timestamp/entitlement assertions reject invalid fixtures;
- notary status Invalid, In Progress, missing/invalid JSON or timeout blocks upload;
  retain ID for diagnostic polling; Accepted still requires staple verification;
- app/ZIP/DMG verification failure blocks **both** upload-artifact and publisher;
- ordering: afterPack → inner/outer sign → app notarize/staple → archive creation
  → final DMG sign/notarize/staple → extract/verify → hash/upload/publish;
- temporary credentials and keychain cleaned up on success and injected failure;
  search list restored; no secret values in mocked logs/artifacts.

Tests must exercise the real policy/orchestration module, not duplicate its logic.
A test fixture's Accepted result is not evidence of live Apple acceptance.

## Verification / rollout gates

1. `bash -n scripts/setup-macos-signing-secrets.sh` and
   `node --test scripts/setup-macos-signing-secrets.test.cjs` for provisioning;
   once signing orchestration exists, `node --test scripts/macos-signing.test.cjs`, relevant existing build-info
   tests if changed, workflow/config syntax checks, `git diff --check`.
2. Candidate-only authorized macOS arm64 job: toolchain/native preflight; signature
   inventory, `codesign --verify --deep --strict`, identity/team/runtime/timestamp
   assertions, `stapler validate`, Gatekeeper assessments, final-DMG notary log,
   ZIP extraction and DMG mount/copy verification per the readiness notes.
3. Negative candidate (mocked/no real credential change): missing auth and a
   failed verification must demonstrate no artifact upload or R2/Tangled call.
4. Clean Apple Silicon Mac browser download of **both** final formats, quarantine
   retained, Gatekeeper on, then fresh offline install/launch. Smoke browsing/JIT,
   native window addon, Spaces helper, extensions, MCP and relaunch. A successful
   notary scan alone is not runtime sign-off.
5. Record human acceptance; only then permit signed tagged publication. Hash final
   bytes only; verify published checksums without changing old release contents.

Research-track verification was documentation/reference/whitespace checking only.
Provisioning and policy/orchestration now have offline tests. Those tests validate
injected evidence and operation ordering, not macOS tool behavior, real credential
cleanup, actual upload gates or Apple acceptance. No signed candidate or any of
these live macOS gates has been run. Rollback means
stopping signed publication and deliberately selecting the existing **explicitly
unsigned** path, never disguising an unsigned artifact as a successful signed one.
