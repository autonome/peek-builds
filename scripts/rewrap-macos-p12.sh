#!/usr/bin/env bash
# Re-wrap an existing signing P12 into the envelope macOS `security import`
# accepts (3DES key/cert encryption, SHA-1 MAC), keeping the same password.
# OpenSSL 3+ exports AES-256/SHA-256 by default, which `security import`
# rejects as "MAC verification failed ... (wrong password?)". The key and
# certificate are unchanged. The decrypted key exists only in a private
# temporary directory that is removed on exit.
set -euo pipefail

src=${1:-}
[[ -n $src && -f $src ]] || { printf 'Usage: %s <file.p12> [out.p12]\n' "$0" >&2; exit 2; }
out=${2:-${src%.p12}-mac.p12}
[[ ! -e $out ]] || { printf 'Error: %s already exists\n' "$out" >&2; exit 2; }

umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/peek-p12-rewrap.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

IFS= read -rsp 'P12 export password: ' P12_REWRAP_PASSWORD
printf '\n'
export P12_REWRAP_PASSWORD

openssl pkcs12 -in "$src" -passin env:P12_REWRAP_PASSWORD -nocerts -noenc -out "$scratch/key.pem"
openssl pkcs12 -in "$src" -passin env:P12_REWRAP_PASSWORD -clcerts -nokeys -out "$scratch/cert.pem"
grep -q 'PRIVATE KEY' "$scratch/key.pem" || { printf 'Error: no private key in %s\n' "$src" >&2; exit 1; }
grep -q 'BEGIN CERTIFICATE' "$scratch/cert.pem" || { printf 'Error: no certificate in %s\n' "$src" >&2; exit 1; }

openssl pkcs12 -export -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -iter 2048 \
  -inkey "$scratch/key.pem" -in "$scratch/cert.pem" -passout env:P12_REWRAP_PASSWORD -out "$scratch/out.p12"
openssl pkcs12 -in "$scratch/out.p12" -noout -passin env:P12_REWRAP_PASSWORD
mv "$scratch/out.p12" "$out"
printf 'Wrote %s\n' "$out"
