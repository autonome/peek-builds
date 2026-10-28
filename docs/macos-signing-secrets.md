# Provision macOS candidate-signing secrets locally

The user approved **manual implementation of candidate-only signing**. Public
signed releases are **not** authorized. The automated spec remains `enabled:
false` so it cannot start a duplicate writer. This script is the provisioning
component; an executable manual candidate workflow and production adapter now
exist, with offline fake-tool tests but **no live signed candidate validation**.
Uploading secrets does not make the existing unsigned workflow sign builds.

## Prerequisites (human-owned)

1. Confirm the legal publisher, Apple Developer Program team and continued use of
   `com.autonome.peek`. Have the Account Holder approve a **Developer ID
   Application** certificate and private-key custody. Do not buy/enroll or create
   duplicate identities merely to run this script. See the
   [readiness checklist](../notes/macos-signing-readiness.md).
2. Prepare credentials separately from uploading. For the terminal-only route use
   [`prepare-macos-signing-credentials.sh`](../notes/macos-signing-credentials-setup.md)
   as described below. Alternatively, on a trusted Mac, open Keychain Access → My Certificates, select the approved
   Developer ID Application identity **with its private key**, and export it as
   a password-protected `.p12`. A downloaded `.cer` alone is insufficient. Keep it
   in approved encrypted storage **outside the checkout**, restrict local access,
   and retain an encrypted recovery copy. The script neither exports keys nor
   changes any local keychain. Do not put certificate passwords in shell commands.
3. Prefer an approved dedicated App Store Connect **team API key**, App Manager
   scope, with its downloaded `.p8`, key ID and issuer UUID. Team API keys have
   account-wide scope, not single-app access; get explicit owner approval. Keep
   the `.p8` outside the checkout with owner-only permissions. Individual API keys
   are not supported by this contract. Alternatively, obtain an app-specific
   password for an authorized dedicated Apple Account. Never supply a normal
   Apple Account password or a 2FA code.
4. Install GitHub CLI (`gh`) from its official distribution. The script does not
   use the stored `gh auth login` credential: it asks at a hidden prompt for a
   fine-grained personal access token (short expiry, revoke after the run) whose
   resource owner is the repository owner and whose repository access is only the
   target repository, with permissions Administration: read and write,
   Environments: read and write, Actions: read, Metadata: read. `GH_TOKEN`, `GITHUB_TOKEN` and
   `GH_ENTERPRISE_TOKEN` must be unset. This script targets github.com,
   not GitHub Enterprise. Run from a trusted local shell; no shell recording,
   untrusted `BASH_ENV`, wrappers, debug proxies or compromised executables.
5. The script creates or updates the GitHub environment (default:
   `autonome/peek-builds` → `macos-release-signing`) with one required reviewer
   and a custom deployment ref policy, both taken from the settings file, then
   reads the environment back and **refuses to upload** unless both are in effect
   (a repository plan may silently not support required reviewers).
   `--allow-unprotected` skips this knowingly. The account needs admin rights. The
   script does **not** verify prevent-self-review, protection of tag creation, or
   protection of workflow/build/dependency code: an administrator must still
   configure and confirm those. No arbitrary dispatch/PR ref may receive
   credentials in the future workflow.
6. Record the exact full identity `Developer ID Application: … (TEAMID)` and its
   10-character team ID from the authorized owner, not a guessed publisher. This
   script stores both as environment **secrets**, consistently with the proposed
   workflow contract. Do not simultaneously rely on conflicting GitHub variables.

## Prepare locally (separate companion; no upload)

Only if the owner needs a new certificate, on a trusted Mac with Bash, OpenSSL
and Git, choose approved encrypted storage **outside all checkouts**. The parent
must exist, and `generate` requires a fresh directory:

```sh
mkdir -p "$HOME/secure"
./scripts/prepare-macos-signing-credentials.sh generate --dir "$HOME/secure/peek-signing"
```

OpenSSL prompts for the encrypted RSA key's passphrase and CSR subject. Upload
**only** `developer-id.certSigningRequest` to Apple Developer → Certificates →
**Developer ID Application**, under the approved team. Certificate issuance is
manual; download the `.cer`, then run:

```sh
./scripts/prepare-macos-signing-credentials.sh inspect \
  --cert "$HOME/secure/peek-signing/developer-id.cer"
./scripts/prepare-macos-signing-credentials.sh package \
  --dir "$HOME/secure/peek-signing" \
  --cert "$HOME/secure/peek-signing/developer-id.cer" \
  --key "$HOME/secure/peek-signing/developer-id-private-key.pem"
```

`inspect` shows the exact commonName/signing identity, team OU, validity and public
fingerprint. `package` accepts DER or PEM, rejects non-Developer-ID-Application
subjects/extensions and mismatched keys, then prompts through OpenSSL for the key
passphrase and a strong nonempty P12 export password. Output is `signing.p12`.
These checks do not establish Apple trust, revocation, account authorization or
macOS acceptance. Download the approved team API `.p8` manually from App Store
Connect: **do not generate it locally**. No preparation command calls Apple/GitHub
APIs or imports anything into a keychain.

Directories/files are mode 700/600; outputs are never overwritten. Partial
exports and scratch artifacts are cleaned on ordinary failure/cancellation.
Completed encrypted keys survive subsequent CSR failure: see the
[credential checklist](../notes/macos-signing-credentials-setup.md) for CSR retry
and crash-recovery guidance. Keep encrypted backups; neither script is a key
recovery service. Passwords belong only at terminal prompts, never flags, exported
environment variables, shell history or logs. Run `--help` for the full interface.

After reviewing the protected environment, preview uploading the prepared P12:

```sh
./scripts/setup-macos-signing-secrets.sh \
  --p12 "$HOME/secure/peek-signing/signing.p12" \
  --p8 "$HOME/secure/AuthKey_YOURKEYID.p8" --dry-run
```

Remove `--dry-run` only when authorized to upload. Preparation and uploading do
not implement/enable the candidate signing workflow.

## Settings file

`--config FILE` reads non-secret settings so the run is not a series of prompts. Copy
[`scripts/macos-signing.env.example`](../scripts/macos-signing.env.example) to a path outside
the checkout (a repo-root `.env.signing` or `signing.env` is gitignored). It is parsed as
`KEY=value` data, never sourced; only the keys in the example are accepted, and a key that
looks like a password or token is rejected. Values still pass the script's validation;
command-line options override the file; anything missing is prompted. The P12 export
password and app-specific password are only ever read from hidden prompts. The file needs
`REVIEWER_LOGIN` and `REF_PATTERN` (with `REF_TYPE` tag or branch) unless
`--allow-unprotected` is given. `--dry-run` prints the `gh api` calls that would create the
environment and contacts nothing.

```sh
./scripts/setup-macos-signing-secrets.sh --config "$HOME/secure/peek-signing/signing.env" --dry-run
./scripts/setup-macos-signing-secrets.sh --config "$HOME/secure/peek-signing/signing.env"
```

## Run the upload script

The examples below pass everything on the command line instead. Start with a local-only
preview (still prompts for identity, team, API key ID and issuer, but not passwords; add
`--config` as above to supply the environment protection settings). Replace paths with
your approved local files:

```sh
./scripts/setup-macos-signing-secrets.sh \
  --p12 "$HOME/secure/peek-developer-id.p12" \
  --p8 "$HOME/secure/peek-notary.p8" \
  --dry-run
```

Then, when ready to **overwrite environment secrets**, run locally:

```sh
./scripts/setup-macos-signing-secrets.sh \
  --p12 "$HOME/secure/peek-developer-id.p12" \
  --p8 "$HOME/secure/peek-notary.p8"
```

Alternative auth (the script prompts for Apple Account email and an app-specific
password; no `.p8` is permitted):

```sh
./scripts/setup-macos-signing-secrets.sh \
  --mode password --p12 "$HOME/secure/peek-developer-id.p12"
```

Use `--repo OWNER/REPO --env NAME` to override the destination; names are limited
to a conservative URL-safe subset. `--help` lists options. There is deliberately
no `--yes`, password flag, secret-bearing environment-variable interface or
secret file generation. Enter metadata and passwords at the local prompts,
without shell quoting. Password input has echo disabled. The final prompt
requires typing `OWNER/REPO/ENVIRONMENT MODE` exactly as displayed and attests
that you reviewed destination protections. Ctrl-C or EOF before confirmation
aborts without uploads. Do not pipe real credentials from shell commands/history.

All selected local inputs are checked before the first upload. Validation covers
file readability/nonempty regular files, PEM boundaries, conservative GitHub size
limits and metadata shape; it **does not prove** certificate/password pairing,
private-key validity, Apple authorization, expiry or team ownership. Those require
future macOS signing preflight and account-owner review. Dry-run makes **no gh or
network calls**, but reads the local files for validation. It is not a remote
permission/protection check.

## Credential contract and safety

Every mode uploads:

- `MACOS_CERTIFICATE_P12_BASE64` — encoded encrypted P12 (base64 is not encryption)
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_SIGNING_IDENTITY`
- `APPLE_TEAM_ID`

API mode additionally uploads `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER`. Password mode uploads `APPLE_ID` and
`APPLE_APP_SPECIFIC_PASSWORD`. Values go exclusively through stdin to
`gh secret set NAME --repo OWNER/REPO --env NAME`, never `--body`, process argv,
shell interpolation commands, logs or exported environment variables. Inherited
shell xtrace/verbose and `GH_DEBUG` are disabled before private values are used.
Only secret **names** are listed remotely; values are never fetched. No temporary
secret files are created, so there is no cleanup path that can leave generated
credentials in the checkout. Shell variables/pipes are not secure erasure; use a
trusted machine. Upload tool output is suppressed to avoid accidental payload
logging in errors. Original files remain under your custody.

Opposite-mode secret names in the target environment cause a refusal **before any
uploads**. To switch modes, an authorized owner must remove obsolete auth secrets
out of band, after reviewing impact on consumers, then rerun. The script never
deletes credentials. Also audit repository/organization secrets and variables for
conflicting auth: this script checks environment names only. The future signing
workflow must map exactly the selected environment contract and clear unused
builder auth variables; it must not inherit fallback credentials.

Uploads are **not transactional**. Each completed name is reported. On failure,
the script names the failed secret and number of successful uploads; the failed
request itself may also have succeeded remotely. No rollback is attempted. Fix
access/network issues, then rerun **all inputs in the same mode and destination**
to converge. Review only names via GitHub settings or `gh secret list`; never
attempt to retrieve or print values. Environment secrets are last-writer-wins:
coordinate provisioning/rotation with the owner; do not run concurrent setup or
candidate jobs during a mode change/partial upload. Keep signing disabled until
setup is complete. A completed setup does not start a job or publish anything.

## Offline tests

```sh
bash -n scripts/prepare-macos-signing-credentials.sh scripts/setup-macos-signing-secrets.sh
node --test scripts/prepare-macos-signing-credentials.test.cjs scripts/setup-macos-signing-secrets.test.cjs
git diff --check
```

Preparation tests generate disposable local test keys/certificates with fixture-only
passwords supplied through descriptors by an OpenSSL wrapper; they check real
PEM/DER/key matching and actual P12 metadata (3DES key/certificate PBE, SHA1 MAC,
2048 iterations), unchanged AES-encrypted source key, cleanup, cancellation, nonoverwrite, permissions,
input/type failures, empty export-password rejection and tracing/argv safety.
Upload tests use only dummy local fixtures and a fake `gh` on PATH, never real accounts,
network, keychains or credentials. They cover both modes, dry-run/help, invalid
inputs/destinations, explicit confirmation, mode conflicts, missing environment,
partial failures, tracing/debug suppression, stdin-only payloads and absence of
generated credential files. Linux tests cannot certify real macOS signing,
notarization, Gatekeeper, protected GitHub environment policy or runtime behavior.

## Signing subprocess password exposure — approval pending

The setup uploader's stdin-only guarantee above does **not** describe the signing
adapter. Apple's standard `security` CLI currently receives the P12 password via
`import -P`, and the random ephemeral-keychain password via `create-keychain -p`,
`unlock-keychain -p` and `set-key-partition-list -k`: these secrets are in child
**argv**, observable by sufficiently privileged local processes. The separately
supported alternative password-auth mode also supplies the app-specific password
to `notarytool store-credentials --password`; the candidate workflow uses API-key
file auth instead. No raw command arguments, child errors or output are logged or
uploaded; this does not eliminate local process-list exposure.

**Live execution is blocked pending the user's answer**: accept this explicitly
scoped exception on a disposable GitHub-hosted runner, or require a reviewed
Security-framework/other secure-input helper before execution. The coordinator
has asked; no approval is recorded. Environment approval alone must not be
interpreted as answering that design decision. Do not run real signing, provision
replacement credentials, or claim that all secrets avoid argv in the meantime.

Tools run in isolated POSIX process groups. Timeout, cancellation and output-limit
failure send SIGTERM, then SIGKILL after 250 ms if the group remains; normal leader
exit also terminates surviving descendants. The runner verifies no live group
members (zombies cannot execute) within a bounded quiescence window before
credential cleanup. If verification fails, further tools, cleanup and upload stop;
private scratch is left for hosted-VM disposal rather than deleted under a live
tool. This controls ordinary descendant trees, not hostile tools that deliberately
escape their group/session; reviewed source/dependencies and runner isolation are
still required. Hard cancellation can bypass all handlers. Persistent runners
remain unsupported; actual macOS cancellation/cleanup still needs validation.

## Signed candidate runbook

These are **human/coordinator operations after landing and review**, not commands
run by the implementation agent. No signed job, tag, credential access or public
publication has been performed. Keep the [spec](../specs/macos-signing-and-notarization.md)
disabled; there must be no duplicate implementation writer.

1. Resolve and record the password-in-argv decision above **before any live run**.
   Review the workflow, adapter, locked dependencies, minimal entitlement plists
   and numeric build policy. Confirm legal publisher/team/identity/bundle ID,
   API-key scope/custody and acceptance owner. Review the implementation difference
   described in [readiness notes](../notes/macos-signing-readiness.md#executable-candidate-path-offline-verified-macos-acceptance-pending):
   builder signs the dir target, but the adapter—not builder's opaque built-in
   notarizer—owns bounded app/DMG submission, log inspection and stapling.
2. Confirm environment `macos-release-signing` actually enforces required reviewer
   approval on this repository plan. Metadata reports reviewer `autonome`,
   self-review allowed, tag policy `v*`, and all seven API-mode secret names. This
   does not validate values or certify protections. Do not change protections or
   secrets merely to make a run pass. The reviewer approves execution of the
   selected source and its dependency lifecycle hooks with signing capability.
3. The owner/coordinator must establish **immutable reserved tags**: protect their
   creation against untrusted writers and prohibit updates/deletion. Both job and
   adapter require GitHub's protected-ref flag; **an unprotected tag is skipped**.
   The flag alone cannot prove that the rule prohibits updates/deletion, so the
   owner must inspect the rule itself. The last coordinator metadata check found
   **no repository rulesets**; reserved-tag ruleset creation/authorization remains
   outstanding. This implementation session has not changed remote rules.
   A tag prefix plus an environment
   `v*` policy alone does not establish immutability/trust. The workflow binds
   checkout, event SHA and peeled tag to the expected full commit, never an input
   checkout ref; a reviewer must independently verify that expected SHA. Do not
   approve a mutable/unreviewed ref. Confirm the unsigned workflow's reserved-tag
   exclusion has landed **before** creating any candidate tag.
4. Allocate a new tag such as `v0.0.1-signing-candidate.1` at the reviewed landed
   source commit. Owner allocates a unique numeric `CFBundleVersion`, canonical
   `major.minor.patch` (major 1–9999, minor/patch 0–99), e.g. `1.0.1`.
   Keep an allocation record; use a new number/candidate for a rebuild, not a
   recycled number for different bytes. Full source SHA remains in plist/JSON.
   This adapter validates numbers but does not allocate them or approve policy.
5. After the owner has created/pushed the immutable tag, dispatch **on that tag**
   (not `main` and not this worktree branch), with explicit reviewed source SHA:

   ```sh
   # Set TAG, SHA and BUILD from the independently reviewed allocation record.
   gh workflow run macos-signing-candidate.yml --repo autonome/peek-builds \
     --ref "$TAG" -f expected_source_sha="$SHA" -f build_version="$BUILD"
   ```

   The workflow must already be present on the default branch for manual dispatch.
   Review the pending environment deployment, tag object/source, workflow and
   dependency changes; then the authorized human may approve. Approval gates the
   entire job. Installation/build/tests execute without signing secrets; only the
   adapter step receives the seven named API secrets. No other auth mode is wired
   into this workflow (the adapter's password mode is separately tested).
6. Require all checks green before downloading anything: imported exact identity,
   native arm64 inventory, numeric build stamp, app sign/notary/log/staple,
   ZIP/DMG creation, final DMG sign/notary/log/staple, Gatekeeper and signature /
   entitlement/dependency verification of staging plus **both extracted copies**,
   search-list/keychain cleanup and final-byte hashes. A failed gate uploads
   neither format. Artifact contains exactly one ZIP, one DMG and `receipt.json`,
   retained seven days. GitHub artifacts are accessible to repository readers;
   they are candidate artifacts, not a public GitHub/R2/Tangled signed release.
7. Validate actual macOS tool syntax/output against the selected Xcode, real
   osx-sign discovery of Resources helpers and framework aliases, per-file
   entitlements, keychain access/cleanup/search-list restoration (including a
   controlled failed job/cancellation), and notary IDs/logs. Offline tests are
   not evidence of these. The adapter intentionally fails closed on unsupported
   tool versions, ambiguous dyld resolution, notary warnings and output changes;
   review/fix parsers, never relax trust checks merely to get green.
8. Download **both** formats in a browser to a clean Apple Silicon Mac with
   quarantine retained and Gatekeeper on. Validate checksums from the receipt;
   install/launch fresh offline copies with no prior acceptance cache. Smoke-test
   JIT/browsing, native window addon, Spaces/Swift helper, extensions, MCP and
   relaunch. Record owner acceptance. No public signed publication is authorized
   until a separate owner decision after these tests.

Each notarization submits once and then waits up to 20 minutes. On timeout/failure,
only sanitized error codes and validated submission UUIDs are logged. Have the
credential custodian diagnose that submission with `notarytool info`/`log` via the
approved auth context before deciding whether to retry; do not blindly dispatch
another submission. Raw diagnostics stay out of uploaded receipts. If uploading
itself fails after signing succeeded, do not reuse partially uploaded artifacts as
release authority. Hosted VM disposal is the backstop if hard cancellation prevents
cleanup; this workflow must not be moved to a persistent self-hosted runner.

Offline gate (no real credentials/Apple tools required):

```sh
node --test scripts/macos-signing.test.cjs scripts/macos-signing-adapter.test.cjs \
  scripts/setup-macos-signing-secrets.test.cjs scripts/prepare-macos-signing-credentials.test.cjs
bash -n scripts/setup-macos-signing-secrets.sh scripts/prepare-macos-signing-credentials.sh
shellcheck scripts/setup-macos-signing-secrets.sh scripts/prepare-macos-signing-credentials.sh
git diff --check
```

The adapter tests parse workflow YAML, validate the locked builder schema/merge,
exercise the named signing hook and signed/unsigned afterPack stamps, and verify
both positive and negative process/filesystem fixtures. The remaining live gates
above are operational prerequisites, not completed tests.
