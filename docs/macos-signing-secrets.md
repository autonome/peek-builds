# Provision macOS candidate-signing secrets locally

The user approved **manual implementation of candidate-only signing**. Public
signed releases are **not** authorized. The automated spec remains `enabled:
false` so it cannot start a duplicate writer. This script is the provisioning
component; **the candidate signing workflow is not implemented yet**. Uploading
secrets does not make the existing unsigned workflow sign builds.

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
4. Install GitHub CLI (`gh`) from its official distribution and authenticate
   separately with `gh auth login --hostname github.com`. Use an account/token
   authorized to manage environment secrets in the target repository, with the
   organization's SSO authorization if required. This script targets github.com,
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
PEM/DER/key matching and export, cleanup, cancellation, nonoverwrite, permissions,
input/type failures, empty export-password rejection and tracing/argv safety.
Upload tests use only dummy local fixtures and a fake `gh` on PATH, never real accounts,
network, keychains or credentials. They cover both modes, dry-run/help, invalid
inputs/destinations, explicit confirmation, mode conflicts, missing environment,
partial failures, tracing/debug suppression, stdin-only payloads and absence of
generated credential files. Linux tests cannot certify real macOS signing,
notarization, Gatekeeper, protected GitHub environment policy or runtime behavior.

Next implementation steps remain the candidate-only workflow and signing policy
in the [disabled manual-owned spec](../specs/macos-signing-and-notarization.md),
followed by authorized macOS verification and clean-machine acceptance. Signed
public publication needs separate human approval after candidate acceptance.
