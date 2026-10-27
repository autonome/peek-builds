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
2. On a trusted Mac, open Keychain Access → My Certificates, select the approved
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
5. An administrator must create the GitHub environment **out of band**. Default:
   `autonome/peek-builds` → Settings → Environments → `macos-release-signing`.
   Configure required reviewers, prevent self-review, restrict deployment refs to
   reviewed immutable candidate tags/commits, and protect tag creation and changes
   to workflow/build/dependency code. Confirm the repository's plan supports the
   required protections; do not proceed on an unprotected environment. The script
   verifies only existence/access, **not the adequacy of protections**. It does
   not create environments or weaken settings. No arbitrary dispatch/PR ref may
   receive credentials in the future workflow.
6. Record the exact full identity `Developer ID Application: … (TEAMID)` and its
   10-character team ID from the authorized owner, not a guessed publisher. This
   script stores both as environment **secrets**, consistently with the proposed
   workflow contract. Do not simultaneously rely on conflicting GitHub variables.

## Run

Start with a local-only preview (still prompts for identity, team, API key ID and
issuer, but not passwords). Replace paths with your approved local files:

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
bash -n scripts/setup-macos-signing-secrets.sh
node --test scripts/setup-macos-signing-secrets.test.cjs
git diff --check
```

Tests use only dummy local fixtures and a fake `gh` on PATH, never real accounts,
network, keychains or credentials. They cover both modes, dry-run/help, invalid
inputs/destinations, explicit confirmation, mode conflicts, missing environment,
partial failures, tracing/debug suppression, stdin-only payloads and absence of
generated credential files. Linux tests cannot certify real macOS signing,
notarization, Gatekeeper, protected GitHub environment policy or runtime behavior.

Next implementation steps remain the candidate-only workflow and signing policy
in the [disabled manual-owned spec](../specs/macos-signing-and-notarization.md),
followed by authorized macOS verification and clean-machine acceptance. Signed
public publication needs separate human approval after candidate acceptance.
