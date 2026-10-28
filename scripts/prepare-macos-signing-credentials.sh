#!/bin/bash
# Disable inherited tracing before any private handling. Use a trusted local shell.
set +x +v
set -euo pipefail
umask 077
export LC_ALL=C

usage() {
  printf '%s\n' \
    'Usage: scripts/prepare-macos-signing-credentials.sh COMMAND [options]' \
    '  generate --dir NEW_ABSOLUTE_DIRECTORY' \
    '    Create encrypted RSA key and CSR in a fresh private directory.' \
    '  package --dir PRIVATE_DIRECTORY --cert FILE --key FILE' \
    '    Validate Developer ID Application certificate/key; export signing.p12.' \
    '  inspect --cert FILE' \
    '    Show public commonName, team OU, validity and fingerprint only.' \
    '  --help  Show this help (also accepted after a command).' \
    'OpenSSL prompts on the terminal for all passphrases and CSR subject fields.' \
    'No password arguments/environment interface. No overwrite, keychain or API operations.' \
    'Use trusted storage outside ALL git checkouts; retain encrypted backups.' \
    'Apple portal issuance and App Store Connect team API P8 download remain manual.' \
    'See notes/macos-signing-credentials-setup.md for the manual handoffs.'
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
work=''
cleanup() { if [[ -n $work ]]; then rm -rf -- "$work"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Resolve the parent physically, including symlinks, before checking git membership.
private_location() {
  [[ $dir == /* && $dir != *$'\n'* && $dir != *$'\r'* ]] || fail '--dir must be an absolute path.'
  parent=$(cd -- "$(dirname -- "$dir")" && pwd -P) || fail 'Directory parent must exist.'
  leaf=$(basename -- "$dir")
  [[ $leaf != . && $leaf != .. && $leaf != / ]] || fail 'Choose a dedicated private directory.'
  dir="$parent/$leaf"
  if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail 'Private output directories must be outside git checkouts.'
  fi
}
private_existing() {
  [[ -d $dir && ! -L $dir && -O $dir ]] || fail 'Private directory must exist, be owned by you, and not be a symlink.'
  local mode
  mode=$(stat -f '%Lp' "$dir" 2>/dev/null) || mode=$(stat -c '%a' "$dir")
  [[ $mode == 700 ]] || fail 'Private directory must have permissions 700.'
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail 'Private output directories must be outside git checkouts.'
  fi
}
input_file() { [[ -f $1 && -r $1 && -s $1 ]] || fail 'Input must be a readable nonempty regular file.'; }
no_output() { [[ ! -e $1 && ! -L $1 ]] || fail 'Output already exists; nothing will be overwritten.'; }
publish() {
  # Hard-link publication is atomic and refuses existing names, even dangling symlinks.
  chmod 600 "$1"
  ln -- "$1" "$2" || fail 'Cannot publish output without overwriting; existing files preserved.'
}
certificate() {
  input_file "$cert"
  # Try each format explicitly; never trust extensions or pass unvalidated bytes onward.
  if ! openssl x509 -inform PEM -in "$cert" -out "$work/cert.pem" 2>/dev/null; then
    openssl x509 -inform DER -in "$cert" -out "$work/cert.pem" 2>/dev/null || fail 'Not a PEM or DER X.509 certificate.'
  fi
  openssl x509 -in "$work/cert.pem" -noout -subject -nameopt sep_multiline,sname,utf8,esc_ctrl > "$work/subject"
  cn=$(awk '/^[[:space:]]*CN=/{sub(/^[[:space:]]*CN=/, ""); print}' "$work/subject")
  team=$(awk '/^[[:space:]]*OU=/{sub(/^[[:space:]]*OU=/, ""); print}' "$work/subject")
  [[ $team =~ ^[A-Z0-9]{10}$ && $cn == 'Developer ID Application: '* && $cn == *"($team)" && $cn != *$'\n'* ]] || fail 'Expected one Developer ID Application commonName and matching ten-character team OU.'
  openssl x509 -in "$work/cert.pem" -noout -text > "$work/cert.txt"
  grep -Eq '1\.2\.840\.113635\.100\.6\.1\.13([^0-9.]|$)' "$work/cert.txt" || fail 'Missing Apple Developer ID Application certificate extension.'
  printf 'Signing identity / commonName: %s\nTeam / organizationalUnit: %s\n' "$cn" "$team"
  openssl x509 -in "$work/cert.pem" -noout -dates -fingerprint -sha256
  printf '%s\n' 'Public metadata only; cross-check team with Apple Membership details. This is not Apple chain/account validation.'
}

[[ $# -gt 0 ]] || { usage; exit 1; }
command_name=$1
shift
case $command_name in --help|-h) usage; exit 0 ;; generate|package|inspect) ;; *) fail 'Unknown command; use --help.' ;; esac
dir='' cert='' key=''
while (($#)); do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --dir|--cert|--key)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail 'Option requires a value.'
      case $1 in
        --dir) [[ -z $dir ]] || fail 'Duplicate --dir.'; dir=$2 ;;
        --cert) [[ -z $cert ]] || fail 'Duplicate --cert.'; cert=$2 ;;
        --key) [[ -z $key ]] || fail 'Duplicate --key.'; key=$2 ;;
      esac
      shift 2 ;;
    *) fail 'Unknown option; use --help.' ;;
  esac
done
for tool in openssl git stat mktemp chmod ln rm awk grep dirname basename mkdir cmp; do
  command -v "$tool" >/dev/null || fail "Required tool unavailable: $tool"
done
case $command_name in
  generate)
    [[ -n $dir && -z $cert && -z $key ]] || fail 'generate requires only --dir.'
    private_location
    no_output "$dir"
    mkdir -m 700 -- "$dir" || fail 'Cannot create fresh private directory.'
    work=$(mktemp -d "$dir/.prepare.XXXXXXXX")
    printf '%s\n' 'Choose a strong private-key passphrase at the OpenSSL prompts.'
    openssl genrsa -aes256 -out "$work/key.pem" 2048 || fail 'Key generation failed; no completed key published.'
    publish "$work/key.pem" "$dir/developer-id-private-key.pem"
    printf 'Encrypted key saved: %s\n' "$dir/developer-id-private-key.pem"
    printf '%s\n' 'Next: unlock that key and enter CSR subject details; leave challenge password unset.'
    openssl req -new -sha256 -key "$dir/developer-id-private-key.pem" -out "$work/request.csr" || fail 'CSR failed. Your completed encrypted key is preserved; do not delete it.'
    publish "$work/request.csr" "$dir/developer-id.certSigningRequest"
    printf 'Upload ONLY %s to Apple Developer Certificates → Developer ID Application.\n' "$dir/developer-id.certSigningRequest"
    printf '%s\n' 'Download the issued .cer manually, then use package --dir DIR --cert FILE --key FILE.'
    ;;
  package)
    [[ -n $dir && -n $cert && -n $key ]] || fail 'package requires --dir, --cert and --key.'
    private_location
    private_existing
    no_output "$dir/signing.p12"
    input_file "$key"
    # Accept encrypted PKCS#8 or encrypted traditional RSA PEM, never plaintext.
    grep -Eq '^-----BEGIN ENCRYPTED PRIVATE KEY-----\r?$|^Proc-Type: 4,ENCRYPTED\r?$' "$key" || fail 'Key must be an encrypted PEM private key.'
    work=$(mktemp -d "$dir/.prepare.XXXXXXXX")
    certificate
    printf '%s\n' 'Unlock the encrypted key to verify its public key before export.'
    openssl pkey -in "$key" -pubout -out "$work/key.pub" || fail 'Cannot unlock/read private key.'
    openssl x509 -in "$work/cert.pem" -pubkey -noout > "$work/cert.pub"
    cmp -s "$work/key.pub" "$work/cert.pub" || fail 'Certificate/key mismatch; obtain the certificate issued for this key CSR.'
    printf '%s\n' 'Unlock the key again, then choose and confirm a strong nonempty P12 export password.'
    openssl pkcs12 -export -inkey "$key" -in "$work/cert.pem" -out "$work/signing.p12" || fail 'P12 export failed; inputs preserved.'
    # Probe ONLY the empty password (not a secret); never read a real password into Bash.
    if openssl pkcs12 -in "$work/signing.p12" -noout -passin pass: >/dev/null 2>&1; then
      fail 'Empty P12 password refused; rerun package and choose a nonempty password.'
    fi
    publish "$work/signing.p12" "$dir/signing.p12"
    printf 'Saved: %s\n' "$dir/signing.p12"
    printf '%s\n' 'Back up the encrypted key and P12 securely. Download the approved team API P8 manually from App Store Connect; do not generate it locally.'
    # Print a literal placeholder for the user's later invocation, not our HOME.
    # shellcheck disable=SC2016
    printf './scripts/setup-macos-signing-secrets.sh --p12 %q --p8 "$HOME/secure/AuthKey_YOURKEYID.p8" --dry-run\n' "$dir/signing.p12"
    printf '%s\n' 'Review protected GitHub environment and metadata first; remove --dry-run only when authorized to upload.'
    ;;
  inspect)
    [[ -n $cert && -z $dir && -z $key ]] || fail 'inspect requires only --cert.'
    # Public certificate scratch only; never store private material in ambient TMPDIR.
    work=$(mktemp -d /tmp/peek-signing-inspect.XXXXXXXX)
    certificate
    ;;
esac
