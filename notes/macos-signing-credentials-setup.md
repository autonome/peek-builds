# Obtaining macOS signing credentials and setting up CI secrets

Reference checklist for Peek's downloadable macOS `.dmg` and `.zip` builds.
This document contains no credentials. Never put private keys or passwords in
this note, source control, chat, logs, or build artifacts.

A **signing identity** is an Apple signing certificate **plus its matching private
key**. Its display name looks like:

```text
Developer ID Application: Your Legal Name or Company (ABCDEFGHIJ)
```

The setup script asks for that full display name. It is not an Apple ID email or
the app's bundle ID.

## 1. Developer ID Application certificate → `.p12` file

On your **Mac**:

1. Open **Keychain Access**.
2. Select **login → My Certificates**.
3. Look for **Developer ID Application: …**.
4. Expand it. A **private key must appear underneath**.

If the certificate and private key are already present, skip to exporting.

### If you need a new certificate

1. In Keychain Access, choose **Keychain Access → Certificate Assistant → Request
   a Certificate From a Certificate Authority**.
2. Enter your email and common name, select **Saved to disk**, and save the
   certificate signing request (`.certSigningRequest`). This creates the matching
   private key on this Mac.
3. Open [Apple Developer → Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list).
4. Select the correct team, then **+ → Developer ID Application**—not Developer ID
   Installer, Apple Development, or Apple Distribution.
5. Upload the certificate signing request, create the certificate, and download
   the `.cer`.
6. Open the `.cer` to import it into Keychain Access. Confirm it appears under
   **My Certificates**, with its private key beneath it.

Creating this certificate may require the team's Account Holder. Do not revoke or
replace an existing production certificate merely to follow this checklist.

### Export the `.p12`

1. Under **My Certificates**, select the Developer ID Application certificate
   with its private key.
2. Choose **File → Export Items**.
3. Export as **Personal Information Exchange (`.p12`)**.
4. Set a strong export password and store the file and password securely.

You now have two setup-script inputs:

- `--p12`: path to the exported `.p12`.
- **P12 export password**: the password you just chose, not your Apple password.

If `.p12` export is unavailable, the certificate may lack its matching private key.
Downloading the `.cer` again will not recover that key; locate the original Mac or
backup, or create a new certificate under the team's certificate policy.

## 2. Full signing identity name

On the Mac containing the certificate and private key, run:

```sh
security find-identity -v -p codesigning
```

Find the entry beginning with `Developer ID Application:`. Copy the complete text
inside its quotation marks, including the team ID in parentheses. Do not copy the
numbered prefix or certificate fingerprint.

This is the script's **Expected full Developer ID Application identity** input.

## 3. Apple Team ID

1. Open [Apple Developer Account](https://developer.apple.com/account).
2. Select the same team that issued the certificate.
3. Open **Membership details** and find **Team ID**.

It is a ten-character uppercase letters/digits identifier. It should match the
identifier in parentheses at the end of the signing identity.

This is the script's **Apple team ID** input.

## 4. Notarization API private key → `.p8` file

This key is separate from the signing certificate. The certificate signs the app;
the API key authenticates requests to Apple's notarization service.

1. Open [App Store Connect](https://appstoreconnect.apple.com/).
2. Select the same organization/team.
3. Go to **Users and Access → Integrations → App Store Connect API**.
4. Use **Team Keys**, not an individual API key for this pipeline.
5. If API access is not enabled, the Account Holder must request it.
6. Generate a dedicated key, for example **Peek CI Notarization**, with
   **App Manager** access.
7. Download its private key, usually named `AuthKey_<KEY_ID>.p8`.

Apple permits downloading that private key only once. Keep an encrypted backup.
Never paste it into chat or commit it. This file is the script's `--p8` input.

**Scope warning:** this is not a notarization-only permission. Team API keys can
have access beyond Peek; review the impact if the team ships other apps.

## 5. API Key ID and Issuer ID

On the same **App Store Connect API → Team Keys** page:

- **Key ID:** on the row for the key you created; ten uppercase letters/digits.
- **Issuer ID:** on the team API page; a UUID with hyphens.

These are the script's **Team API key ID** and **Team API issuer UUID** inputs.
Use the values belonging to the same team/key as the `.p8`.

## 6. GitHub authentication and protected environment

For the account running the setup script:

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
```

That account needs permission to manage environment secrets in
**`autonome/peek-builds`**.

In GitHub:

1. Open **autonome/peek-builds → Settings → Environments**.
2. Create **macos-release-signing**.
3. Configure required approval and deployment branch/tag restrictions before
   adding credentials.
4. Restrict access to the trusted candidate refs used by the signing workflow;
   do not allow arbitrary branches to obtain signing secrets.

The exact ref policy must match the candidate workflow. The setup script does not
configure or certify these protections. Availability of protection features can
depend on the repository visibility and GitHub plan.

## 7. Run the setup script

At the time this note was written, the setup script was committed in the
**macos-signing** worktree, not yet merged to main. From that worktree, preview:

```sh
./scripts/setup-macos-signing-secrets.sh \
  --p12 "$HOME/secure/peek-developer-id.p12" \
  --p8 "$HOME/secure/AuthKey_YOURKEYID.p8" \
  --dry-run
```

Replace the paths with your actual local files. Then run the same command without
`--dry-run`. It prompts locally for metadata, the hidden P12 password, and explicit
destination confirmation before uploading.

Default destination:

- Repository: `autonome/peek-builds`
- GitHub environment: `macos-release-signing`

The script uses `gh secret set` with secret values on stdin, not command-line
arguments. Dry-run does not contact GitHub or validate remote prerequisites.
Uploads are not transactional; if one fails, follow the script's partial-failure
message and rerun with the same destination, auth mode, and complete inputs.

### Inputs at a glance

| Script input | Source |
|---|---|
| `.p12` file | Keychain Access export of certificate and private key |
| P12 password | Chosen during export |
| Signing identity | Full `Developer ID Application: … (TEAMID)` name |
| Team ID | Apple Developer membership details |
| `.p8` file | App Store Connect team API key download |
| Key ID | That API key's row |
| Issuer ID | Team API page |
| GitHub access | `gh auth login`, with environment-secret permissions |

### GitHub environment secret names

For API-key mode, the script uploads:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_SIGNING_IDENTITY`
- `APPLE_TEAM_ID`
- `APPLE_API_KEY_P8`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Base64 is encoding, not encryption. Protect the P12 secret as private key material.
Do not mix API authentication with stale Apple-ID/password authentication secrets;
the script refuses opposite-mode environment secrets rather than deleting them.

For this route, you do not need a Developer ID Installer certificate, provisioning
profile, App Store listing, or normal Apple Account password. Reassess provisioning
if restricted Apple capabilities are introduced later.

## Related material

- `notes/macos-signing-readiness.md` — detailed implementation findings and
  official sources; initially committed in the signing worktree.
- `docs/macos-signing-secrets.md` — setup script usage and safety details, in that
  same worktree until landed.

Signing/notarization is not a security audit or a runtime compatibility guarantee.
Real candidate signing, Apple acceptance, Gatekeeper verification, and clean-Mac
runtime checks remain separate rollout gates.
