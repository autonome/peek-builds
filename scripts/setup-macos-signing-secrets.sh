#!/bin/bash
# Disable inherited tracing BEFORE reading any private material (including bash -x/-v).
set +x +v
set -euo pipefail
umask 077
# Byte-count secret limits consistently on macOS and Linux.
export LC_ALL=C

usage() {
  printf '%s\n' 'Usage: scripts/setup-macos-signing-secrets.sh --p12 FILE [--p8 FILE] [options]' \
    '  --mode api|password  Notarization auth (default: api; team API keys only)' \
    '  --repo OWNER/REPO    Default: autonome/peek-builds (github.com only)' \
    '  --env NAME           Default: macos-release-signing' \
    '  --dry-run            Validate local inputs; no gh calls or secret prompts/uploads' \
    '  --help               Show help' \
    'Metadata and passwords are prompted locally; never pass passwords as arguments.' \
    'Requires an existing protected environment. Does not create/change protections.' \
    'See docs/macos-signing-secrets.md for preparation, permissions and retry guidance.'
}
fail() { printf '%s\n' "Error: $*" >&2; exit 1; }
prompt() {
  printf '%s: ' "$2" >&2
  if [[ ${3:-} == private ]]; then
    IFS= read -r -s "$1" || fail 'Input ended before all prompts were answered.'
    printf '\n' >&2
  else
    IFS= read -r "$1" || fail 'Input ended before all prompts were answered.'
  fi
  [[ -n ${!1} ]] || fail 'Empty input is not allowed.'
}
main() {
  # Clear inherited export bindings before creating local prompt storage.
  unset certificate password private_key app_password identity team key_id issuer apple_id
  local repo=autonome/peek-builds environment=macos-release-signing mode=api dry=0 p12='' p8=''
  local identity team key_id issuer apple_id confirm names name opposite completed=0
  local certificate password private_key app_password
  # Do not let inherited exported variables turn prompt results into child environment.
  export -n certificate password private_key app_password identity team key_id issuer apple_id
  while (($#)); do
    case $1 in
      --help|-h) usage; return ;;
      --dry-run) dry=1; shift ;;
      --repo|--env|--mode|--p12|--p8)
        [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail 'Option requires a value.'
        case $1 in
          --repo) repo=$2 ;; --env) environment=$2 ;; --mode) mode=$2 ;;
          --p12) p12=$2 ;; --p8) p8=$2 ;;
        esac
        shift 2 ;;
      *) fail 'Unknown option; use --help.' ;;
    esac
  done
  [[ $repo =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$ && $repo != */. && $repo != */.. ]] || fail 'Invalid OWNER/REPO.'
  # Conservative subset avoids API path escaping/terminal control ambiguities.
  [[ $environment =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && ${#environment} -le 255 ]] || fail 'Invalid environment name (use letters, digits, dot, underscore, hyphen).'
  [[ $mode == api || $mode == password ]] || fail 'Mode must be api or password.'
  [[ -n $p12 && -f $p12 && -r $p12 && -s $p12 ]] || fail 'P12 must be a readable nonempty regular file.'
  if [[ $mode == api ]]; then
    [[ -n $p8 && -f $p8 && -r $p8 && -s $p8 ]] || fail 'API mode needs a readable nonempty regular P8 file.'
  else
    [[ -z $p8 ]] || fail 'Password mode cannot include --p8.'
  fi
  command -v base64 >/dev/null || fail 'base64 is required.'
  command -v tr >/dev/null || fail 'tr is required.'
  # Values stay in shell memory/pipes; no generated credential files, no exports.
  certificate=$(base64 < "$p12" | tr -d '\r\n') || fail 'Cannot encode P12.'
  [[ ${#certificate} -le 48000 ]] || fail 'Encoded P12 exceeds conservative GitHub secret size limit (48000 bytes).'
  prompt identity 'Expected full Developer ID Application identity (including team)'
  [[ $identity == 'Developer ID Application: '* && $identity != *$'\r'* && ${#identity} -le 48000 ]] || fail 'Expected a Developer ID Application identity.'
  prompt team 'Expected Apple team ID'
  [[ $team =~ ^[A-Z0-9]{10}$ && $identity == *"($team)" ]] || fail 'Team ID must be 10 uppercase letters/digits and match identity suffix.'
  if [[ $mode == api ]]; then
    private_key=$(< "$p8")
    [[ ${#private_key} -le 48000 && $private_key == *'-----BEGIN PRIVATE KEY-----'* && $private_key == *'-----END PRIVATE KEY-----'* ]] || fail 'P8 must contain a PEM private key under 48000 bytes.'
    prompt key_id 'Team API key ID'
    [[ $key_id =~ ^[A-Z0-9]{10}$ ]] || fail 'Invalid team API key ID.'
    prompt issuer 'Team API issuer UUID'
    [[ $issuer =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]] || fail 'Invalid issuer UUID.'
    opposite='APPLE_ID APPLE_APP_SPECIFIC_PASSWORD'
  else
    prompt apple_id 'Dedicated authorized Apple Account email'
    [[ $apple_id =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ && ${#apple_id} -le 48000 ]] || fail 'Invalid Apple Account email.'
    opposite='APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER'
  fi
  printf 'Destination: github.com/%s environment %s; auth mode: %s\n' "$repo" "$environment" "$mode"
  printf '%s\n' 'Secrets: MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD MACOS_SIGNING_IDENTITY APPLE_TEAM_ID'
  if [[ $mode == api ]]; then
    printf '%s\n' 'Secrets: APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER'
  else
    printf '%s\n' 'Secrets: APPLE_ID APPLE_APP_SPECIFIC_PASSWORD'
  fi
  if ((dry)); then
    printf '%s\n' 'Dry-run: no gh calls, password prompts, or mutations. Remote prerequisites NOT checked.'
    return
  fi
  command -v gh >/dev/null || fail 'Install GitHub CLI (gh) first.'
  # Pin the host; never inherit GH_DEBUG, which can log request bodies.
  export GH_HOST=github.com GH_DEBUG='' GH_PROMPT_DISABLED=1
  gh auth status --hostname github.com >/dev/null 2>&1 || fail 'Run gh auth login --hostname github.com separately first.'
  gh api "repos/$repo/environments/$environment" --silent >/dev/null 2>&1 || fail 'Environment must already exist and be accessible; create/protect it separately.'
  names=$(gh secret list --repo "$repo" --env "$environment" --json name --jq '.[].name' 2>/dev/null) || fail 'Cannot list environment secret names.'
  for name in $opposite; do
    if [[ $'\n'"$names"$'\n' == *$'\n'"$name"$'\n'* ]]; then
      fail "Opposite auth-mode secret $name exists. Remove obsolete credentials out of band after owner approval, then retry. Nothing uploaded."
    fi
  done
  printf '%s\n' 'Before continuing: verify required reviewers, prevent self-review, trusted immutable ref policy,' \
    'and workflow/dependency protection in GitHub settings. This script cannot certify those controls.' \
    'Uploads overwrite names and are NOT transactional. No secrets are deleted.'
  prompt password 'P12 export password' private
  [[ ${#password} -le 48000 ]] || fail 'P12 password too long.'
  if [[ $mode == password ]]; then
    prompt app_password 'Apple APP-SPECIFIC password (never normal password or 2FA)' private
    [[ $app_password =~ ^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$ ]] || fail 'Expected Apple app-specific password format.'
  fi
  prompt confirm "Type $repo/$environment $mode to confirm protections reviewed and uploads approved"
  [[ $confirm == "$repo/$environment $mode" ]] || fail 'Confirmation did not match; nothing uploaded.'
  upload() {
    # printf is a bash builtin: value never appears in a process argv. Suppress gh
    # output/errors since even unexpected tool errors must not disclose payloads.
    if ! printf '%s' "$2" | gh secret set "$1" --repo "$repo" --env "$environment" >/dev/null 2>&1; then
      fail "Upload failed at $1 after $completed successful uploads. State may be partial (including this name). Fix access/network and rerun the SAME mode/destination with all inputs; no rollback was attempted."
    fi
    completed=$((completed + 1))
    printf 'Uploaded %s\n' "$1"
  }
  upload MACOS_CERTIFICATE_P12_BASE64 "$certificate"
  upload MACOS_CERTIFICATE_PASSWORD "$password"
  upload MACOS_SIGNING_IDENTITY "$identity"
  upload APPLE_TEAM_ID "$team"
  if [[ $mode == api ]]; then
    upload APPLE_API_KEY_P8 "$private_key"
    upload APPLE_API_KEY_ID "$key_id"
    upload APPLE_API_ISSUER "$issuer"
  else
    upload APPLE_ID "$apple_id"
    upload APPLE_APP_SPECIFIC_PASSWORD "$app_password"
  fi
  unset certificate password private_key app_password
  printf '%s\n' 'Setup finished. No signing, notarization or publication was started.'
}
main "$@"
