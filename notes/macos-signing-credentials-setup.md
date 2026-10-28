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
  **P12 export password**. Keep that password; step 8 asks for it.
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

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
REPO=autonome/peek-builds
ENV=macos-release-signing
CANDIDATE_REF_PATTERN='<tag pattern>'   # the tags the signing workflow runs on
REVIEWER_ID=$(gh api user --jq .id)
gh api -X PUT "repos/$REPO/environments/$ENV" \
  -F "reviewers[][type]=User" -F "reviewers[][id]=$REVIEWER_ID" \
  -F "deployment_branch_policy[protected_branches]=false" \
  -F "deployment_branch_policy[custom_branch_policies]=true"
gh api -X POST "repos/$REPO/environments/$ENV/deployment-branch-policies" \
  -f name="$CANDIDATE_REF_PATTERN" -f type=tag
gh api "repos/$REPO/environments/$ENV" --jq '{protection_rules, deployment_branch_policy}'
```

- The account needs admin rights on the repo to manage the environment and its secrets.
- `CANDIDATE_REF_PATTERN` is not recorded anywhere yet:
  `specs/macos-signing-and-notarization.md` asks only for immutable trusted refs. Only refs
  matching it can reach the secrets. Use `type=branch` for a branch pattern.
- Required reviewers on a private repository depend on the GitHub plan; the last command
  shows what actually took effect. Set the protection before uploading any secret.

## 8. Upload the secrets

```sh
./scripts/setup-macos-signing-secrets.sh \
  --p12 "$SIGN_DIR/signing.p12" \
  --p8 "$SIGN_DIR/AuthKey_$KEY_ID.p8" \
  --dry-run
./scripts/setup-macos-signing-secrets.sh \
  --p12 "$SIGN_DIR/signing.p12" \
  --p8 "$SIGN_DIR/AuthKey_$KEY_ID.p8"
```

The dry run checks the inputs without contacting GitHub. The real run prompts for:

| Prompt | Value |
|---|---|
| Developer ID Application identity | commonName from step 4 |
| Apple team ID | from steps 4 and 5 |
| Team API key ID | `$KEY_ID` |
| Team API issuer UUID | Issuer ID from step 6 |
| P12 password (hidden) | export password from step 4 |
| Destination confirmation | `autonome/peek-builds`, environment `macos-release-signing` |

It uploads, with values on stdin, never as arguments:
`MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`,
`APPLE_TEAM_ID`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Uploads are not transactional. If one fails, rerun the same command with the same inputs. The
script refuses to run if Apple-ID/password secrets from the other authentication mode are
already in the environment; remove those first.

Check what landed:

```sh
gh secret list --repo "$REPO" --env "$ENV"
```

## Not covered here

The secrets being present proves nothing about signing. A real candidate signing run, Apple's
notarization verdict, Gatekeeper on the result and a launch on a clean Mac are separate checks.
Background and sources: `notes/macos-signing-readiness.md`; script details:
`docs/macos-signing-secrets.md`.
