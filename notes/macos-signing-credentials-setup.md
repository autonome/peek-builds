# macOS signing credentials: setup on the Mac

One pass, top to bottom, in a terminal on the Mac, from the repo root. It produces the
Developer ID signing `.p12` and the notarization `.p8`, and uploads both, with their metadata,
as GitHub environment secrets for the signing workflow.

This document holds no credentials. Never put a private key, passphrase or password in a file
under source control, a chat, a log or a build artifact. Run in a plain shell with no session
recording, debug wrappers or tracing (`set -x`). Passphrases are typed only at the scripts'
hidden prompts, never as arguments or environment variables.

Three steps happen in a browser, because Apple issues the certificate and the API key there:
3, 6 and the Team ID lookup in 5. Everything else is a command.

## 1. Tools and working directory

```sh
brew install openssl gh
export PATH="$(brew --prefix openssl)/bin:$PATH"
openssl version          # Homebrew OpenSSL, not LibreSSL
SIGN_DIR="$HOME/secure/peek-signing"
mkdir -p "$HOME/secure"
```

`$HOME/secure` should sit on encrypted storage that is backed up, and outside every git
checkout. `SIGN_DIR` itself must not exist yet: step 2 creates it.

## 2. Generate the private key and certificate request

```sh
./scripts/prepare-macos-signing-credentials.sh generate --dir "$SIGN_DIR"
```

- First prompt: a passphrase that encrypts the private key. Keep it; step 4 needs it.
- Then the request asks for that passphrase again and for subject details: use the legal
  name of the person or company on the Apple team. Leave the challenge password empty.
- Result: `developer-id-private-key.pem` (mode 600, never uploaded anywhere) and
  `developer-id.certSigningRequest`, in a mode-700 directory.

If the request step fails after the key was saved, the key is kept. Do not rerun `generate`
and do not delete the key; create only the request:

```sh
(umask 077; set -C; openssl req -new -sha256 \
  -key "$SIGN_DIR/developer-id-private-key.pem" \
  > "$SIGN_DIR/developer-id.certSigningRequest")
```

## 3. Get the certificate from Apple (browser)

```sh
open "https://developer.apple.com/account/resources/certificates/add"
```

Choose the team, then **Developer ID Application** (not Installer, Development or
Distribution). Upload `$SIGN_DIR/developer-id.certSigningRequest`. Creating it may need the
team's Account Holder. Do not revoke an existing production certificate to do this. Then move
the download into place:

```sh
mv ~/Downloads/developerID_application.cer "$SIGN_DIR/developer-id.cer"
```

(Adjust the source name if the download is named differently.)

## 4. Check the certificate and package the `.p12`

```sh
./scripts/prepare-macos-signing-credentials.sh inspect --cert "$SIGN_DIR/developer-id.cer"
./scripts/prepare-macos-signing-credentials.sh package \
  --dir "$SIGN_DIR" \
  --cert "$SIGN_DIR/developer-id.cer" \
  --key "$SIGN_DIR/developer-id-private-key.pem"
```

- `inspect` prints the certificate's **commonName**, for example
  `Developer ID Application: Legal Name (ABCDEFGHIJ)`. Copy the value alone: it is the
  signing identity asked for in step 8. The ten characters in parentheses are the Team ID.
- `package` checks that the certificate is a Developer ID Application certificate and that
  it matches the private key, then prompts for the key's passphrase and a new, non-empty
  **P12 export password** from a password manager (strong randomly generated ASCII
  recommended). Re-enter that password at the script's readback request; OpenSSL's
  own prompt/errors are suppressed for this check. Failed MAC/readability verification
  publishes no P12. Keep that password; step 8 asks for it. This is an OpenSSL
  round-trip, not proof of macOS import or validation of existing remote secrets.
- The export explicitly uses 3DES key and certificate PBE, SHA1 MAC and 2048
  iterations for macOS import compatibility rather than OpenSSL's changing defaults.
  This is a **legacy compatibility-only** password-protected transport profile,
  not modern archival protection and not the source-key encryption:
  the original AES-encrypted private key is unchanged. Keep a strong export password
  and encrypted storage; actual macOS import remains a candidate validation gate.
- Result: `$SIGN_DIR/signing.p12`. If it reports that the certificate and key don't match,
  stop: get the certificate issued for this request instead.

## 5. Confirm the Team ID (browser)

```sh
open "https://developer.apple.com/account#MembershipDetailsCard"
```

The **Team ID** there must equal the ten characters at the end of the signing identity.

## 6. Create the notarization API key (browser)

```sh
open "https://appstoreconnect.apple.com/access/integrations/api"
```

Under **Team Keys** (not an individual key), generate a key named `Peek CI Notarization`
with **App Manager** access. If API access isn't enabled, the Account Holder must request it.
Note the key's **Key ID** (on its row) and the **Issuer ID** (at the top of the page). Download
the key; Apple allows this only once. Team keys reach every app on the team, not just Peek.

```sh
KEY_ID=ABCDEFGHIJ        # the Key ID from that page
mv ~/Downloads/AuthKey_$KEY_ID.p8 "$SIGN_DIR/"
chmod 600 "$SIGN_DIR/AuthKey_$KEY_ID.p8"
```

Keep an encrypted backup of the `.p8` and of `$SIGN_DIR` as a whole.

## 7. GitHub login and the protected environment

Copy the example settings file to a place outside the checkout and fill it in. It holds only
non-secret values; the script reads it as data and rejects unknown keys.

```sh
cp scripts/macos-signing.env.example "$SIGN_DIR/signing.env"
```

| Key | Value |
|---|---|
| `P12_PATH`, `P8_PATH` | `$HOME/secure/peek-signing/signing.p12` and `.../AuthKey_<key id>.p8` (only a leading `$HOME/` is expanded) |
| `SIGNING_IDENTITY` | commonName from step 4 |
| `TEAM_ID` | from steps 4 and 5 |
| `API_KEY_ID`, `API_ISSUER` | Key ID and Issuer ID from step 6 |
| `REVIEWER_LOGIN` | GitHub login of the person who approves signing runs |
| `REF_PATTERN`, `REF_TYPE` | the tags (or branches) the signing workflow runs on; only refs matching it can reach the secrets |

For the implemented candidate path, the reserved namespace is
`v*-signing-candidate.*` (`REF_TYPE=tag`); replace the example's generic pattern after
owner review. Environment ref policy is not tag immutability: trusted creation and
no-update/no-delete rules must be separately authorized and established. The last
coordinator metadata check recorded active ruleset `26046298` prohibiting candidate
updates/deletion, with no bypass actors. Do not change existing
settings or reprovision secrets just to make a candidate pass. The P12 export
password is never read from this file.

Then create a fine-grained personal access token for the one repository. The script never uses
the stored `gh auth login` credential, which reaches every repository and organization the
account can reach.

```sh
open 'https://github.com/settings/personal-access-tokens/new'
```

- Resource owner: the account that owns the repository (`autonome`).
- Expiration: 7 days.
- Repository access: only select repositories, then `autonome/peek-builds`.
- Repository permissions: Administration read and write, Environments read and write,
  Actions read (Metadata read is added automatically).

Copy the token; the script asks for it at a hidden prompt and holds it only in its own process.
`GH_TOKEN`, `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` must not be set in the shell. Revoke the
token on the same settings page once step 8 has finished.

## 8. Create the environment and upload the secrets

**Existing candidate environment:** the user removed required reviewers for
candidate-only runs. The default commands below describe initial provisioning and
would reinstate a reviewer; do not rerun them unchanged for a rotation. Any real
validation/repackage/upload requires separate owner approval, preserving the
candidate-only ref policy and immutable tags. `--allow-unprotected` does not verify
those protections. Candidate .3 failed at keychain import, exit 1; the cause is not
known. Follow the [investigation and next-action record](macos-signing-readiness.md#candidate-3-import-investigation-2026-10-29)
before changing real secrets; a retry by itself cannot correct the P12.

```sh
./scripts/setup-macos-signing-secrets.sh --config "$SIGN_DIR/signing.env" --dry-run
./scripts/setup-macos-signing-secrets.sh --config "$SIGN_DIR/signing.env"
```

The dry run checks the local inputs and prints the `gh api` calls it would make, without
contacting GitHub. The real run:

1. Creates or updates the `autonome/peek-builds` environment `macos-release-signing` with the
   required reviewer and the ref policy (rerunning does not duplicate the policy).
2. Reads the environment back and stops, uploading nothing, unless the reviewer and ref policy
   are in effect. Required reviewers on a private repository depend on the GitHub plan;
   `--allow-unprotected` skips this knowingly and only checks that the environment exists.
3. Prompts for anything missing from the file, then for the GitHub token (hidden), verifies it
   can reach the repository, then for the P12 export password (hidden; export
   password from step 4) and a destination confirmation (`autonome/peek-builds/macos-release-signing api`).

It uploads, with values on stdin, never as arguments:
`MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`,
`APPLE_TEAM_ID`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Uploads are not transactional. If one fails, rerun the same command with the same inputs. The
script refuses to run if Apple-ID/password secrets from the other authentication mode are
already in the environment; remove those first.

Check what landed:

```sh
gh secret list --repo autonome/peek-builds --env macos-release-signing
```

## Not covered here

The preparation/uploader scripts avoid secret argv, but the signing adapter's
standard `security` CLI currently exposes P12/keychain passwords in subprocess
argv (alternative password-auth `notarytool` also does). The user approved that
exception on disposable GitHub-hosted runners only; no persistent/shared-runner
or raw-log authorization follows. See
[the explicit exposure/approval boundary](../docs/macos-signing-secrets.md#signing-subprocess-password-exposure--hosted-runner-exception-approved).

The secrets being present proves nothing about signing. A real candidate signing run, Apple's
notarization verdict, Gatekeeper on the result and a launch on a clean Mac are separate checks.
Background and sources: `notes/macos-signing-readiness.md`; script details:
`docs/macos-signing-secrets.md`.
