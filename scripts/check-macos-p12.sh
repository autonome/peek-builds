#!/usr/bin/env bash
# Check, on a Mac, that a signing P12 and its export password work the way the
# CI adapter uses them: OpenSSL can open it, `security import` accepts it into a
# throwaway keychain, and a codesigning identity comes out. The password is read
# once and given to both tools so a typo cannot make them disagree. Nothing is
# uploaded and the login/system keychains and search list are never touched.
# The password reaches `security import` as an argument, as it does in CI; run
# this only on a trusted Mac.
set -uo pipefail

p12=${1:-}
[[ -n $p12 && -f $p12 ]] || { printf 'Usage: %s <file.p12>\n' "$0" >&2; exit 2; }
[[ $(uname) == Darwin ]] || { printf 'Error: needs macOS (security).\n' >&2; exit 2; }

scratch=$(mktemp -d "${TMPDIR:-/tmp}/peek-p12-check.XXXXXX") || exit 1
keychain=$scratch/check.keychain-db
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

IFS= read -rsp 'P12 export password: ' P12_CHECK_PASSWORD
printf '\n'
export P12_CHECK_PASSWORD

printf '\n== OpenSSL (%s)\n' "$(openssl version)"
if openssl pkcs12 -in "$p12" -noout -passin env:P12_CHECK_PASSWORD >/dev/null 2>&1; then
  printf 'password opens the file: yes\n'
  openssl pkcs12 -in "$p12" -info -noout -passin env:P12_CHECK_PASSWORD 2>&1 |
    grep -E '^(MAC|PKCS7|Shrouded|PKCS8|Certificate bag|Key bag)' | sort | uniq -c
else
  printf 'password opens the file: NO (wrong password, or OpenSSL cannot read this format)\n'
  openssl pkcs12 -in "$p12" -info -noout -passin env:P12_CHECK_PASSWORD 2>&1 | head -3
fi

printf '\n== macOS security import\n'
security create-keychain -p check "$keychain" >/dev/null 2>&1 || { printf 'Error: cannot create keychain\n'; exit 1; }
security unlock-keychain -p check "$keychain" >/dev/null 2>&1
security import "$p12" -k "$keychain" -P "$P12_CHECK_PASSWORD" -T /usr/bin/codesign 2>&1
printf 'import exit status: %s\n' "$?"

printf '\n== Identities (all, then valid only)\n'
security find-identity -p codesigning "$keychain" 2>&1
