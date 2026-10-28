#!/bin/bash
# Disable inherited tracing BEFORE reading any private material (including bash -x/-v).
set +x +v
set -euo pipefail
umask 077
# Byte-count secret limits consistently on macOS and Linux.
export LC_ALL=C

usage() {
  printf '%s\n' 'Usage: scripts/setup-macos-signing-secrets.sh [--config FILE] [--p12 FILE] [--p8 FILE] [options]' \
    '  --config FILE        Non-secret settings file (KEY=value lines); see scripts/macos-signing.env.example' \
    '  --mode api|password  Notarization auth (default: api; team API keys only)' \
    '  --repo OWNER/REPO    Default: autonome/peek-builds (github.com only)' \
    '  --env NAME           Default: macos-release-signing' \
    '  --p12 FILE, --p8 FILE  Credential files (override the config file)' \
    '  --allow-unprotected  Skip creating/verifying reviewer and ref protection (NOT recommended)' \
    '  --dry-run            Validate local inputs and print the planned gh api calls; contacts nothing' \
    '  --help               Show help' \
    'Settings missing from the config file are prompted for. The P12 export password,' \
    'app-specific password and the GitHub token are only ever read from a hidden prompt, never' \
    'from a file, flag or inherited environment. The token must be a fine-grained personal access' \
    'token limited to the target repository; the stored gh login is never used.' \
    'The script creates or updates the GitHub environment (required reviewer, ref policy), reads' \
    'it back, and refuses to upload secrets unless the protections are in effect.' \
    'See docs/macos-signing-secrets.md for preparation, permissions and retry guidance.'
}
required_permissions() {
  printf '%s\n' 'Required fine-grained token settings (https://github.com/settings/personal-access-tokens/new):' \
    "  Resource owner: the owner of $1" \
    "  Repository access: only select repositories -> $1" \
    '  Repository permissions: Administration: read and write; Environments: read and write;' \
    '    Actions: read; Metadata: read (automatic)'
}
gh_config_dir=''
cleanup() { [[ -z $gh_config_dir ]] || rm -rf "$gh_config_dir"; }
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
# Prompt only when the value was not supplied by the config file.
ask() { [[ -n ${!1} ]] || prompt "$@"; }
# Parse a settings file as data: strict key allowlist, never sourced or evaluated.
# Sets cfg_* variables in the caller's scope (bash 3.2 compatible: no arrays).
load_config() {
  local file=$1 line key value seen=' ' n=0
  [[ -f $file && -r $file ]] || fail 'Config must be a readable regular file.'
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ $line =~ ^([A-Z0-9_]+)=(.*)$ ]] || fail "Config line $n is not KEY=value."
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
    case $key in
      *PASS*|*SECRET*|*PRIVATE*|*TOKEN*) fail "Config line $n: $key looks like a secret. Secrets are only accepted at hidden prompts." ;;
    esac
    [[ $seen != *" $key "* ]] || fail "Config line $n: duplicate key $key."
    seen="$seen$key "
    [[ $value != *[[:cntrl:]]* ]] || fail "Config line $n: control characters are not allowed."
    case $key in
      P12_PATH|P8_PATH)
        # Only a leading $HOME/ or ~/ is expanded; nothing else is interpreted.
        case $value in '$HOME/'*) value=$HOME/${value#'$HOME/'} ;; '~/'*) value=$HOME/${value#'~/'} ;; esac ;;
    esac
    case $key in
      P12_PATH) cfg_p12=$value ;; P8_PATH) cfg_p8=$value ;;
      SIGNING_IDENTITY) cfg_identity=$value ;; TEAM_ID) cfg_team=$value ;;
      API_KEY_ID) cfg_key_id=$value ;; API_ISSUER) cfg_issuer=$value ;;
      APPLE_ID_EMAIL) cfg_apple_id=$value ;;
      REPO) cfg_repo=$value ;; ENVIRONMENT) cfg_environment=$value ;;
      REF_PATTERN) cfg_ref_pattern=$value ;; REF_TYPE) cfg_ref_type=$value ;;
      REVIEWER_LOGIN) cfg_reviewer=$value ;;
      *) fail "Config line $n: unknown key $key." ;;
    esac
  done < "$file"
}
main() {
  # Clear inherited export bindings before creating local prompt storage.
  unset certificate password private_key app_password gh_token identity team key_id issuer apple_id
  local repo='' environment='' mode='' dry=0 p12='' p8='' config='' allow_unprotected=0
  local reviewer='' ref_pattern='' ref_type='' reviewer_id=''
  local cfg_p12='' cfg_p8='' cfg_identity='' cfg_team='' cfg_key_id='' cfg_issuer='' cfg_apple_id=''
  local cfg_repo='' cfg_environment='' cfg_ref_pattern='' cfg_ref_type='' cfg_reviewer=''
  local identity='' team='' key_id='' issuer='' apple_id='' confirm names name opposite completed=0
  local certificate='' password='' private_key='' app_password='' gh_token=''
  # Do not let inherited exported variables turn prompt results into child environment.
  export -n certificate password private_key app_password gh_token identity team key_id issuer apple_id
  while (($#)); do
    case $1 in
      --help|-h) usage; return ;;
      --dry-run) dry=1; shift ;;
      --allow-unprotected) allow_unprotected=1; shift ;;
      --repo|--env|--mode|--p12|--p8|--config)
        [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail 'Option requires a value.'
        case $1 in
          --repo) repo=$2 ;; --env) environment=$2 ;; --mode) mode=$2 ;;
          --p12) p12=$2 ;; --p8) p8=$2 ;; --config) config=$2 ;;
        esac
        shift 2 ;;
      *) fail 'Unknown option; use --help.' ;;
    esac
  done
  if [[ -n $config ]]; then
    load_config "$config"
    # Command-line options win over the config file.
    : "${p12:=$cfg_p12}" "${p8:=$cfg_p8}" "${repo:=$cfg_repo}" "${environment:=$cfg_environment}"
    identity=$cfg_identity team=$cfg_team key_id=$cfg_key_id issuer=$cfg_issuer apple_id=$cfg_apple_id
    reviewer=$cfg_reviewer ref_pattern=$cfg_ref_pattern ref_type=$cfg_ref_type
  fi
  local v
  for v in GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; do
    [[ -z ${!v:-} ]] || fail "$v is set in the environment. Unset it; the token is only accepted at the script's hidden prompt."
  done
  : "${repo:=autonome/peek-builds}" "${environment:=macos-release-signing}" "${mode:=api}"
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
  if ((allow_unprotected)); then
    printf '%s\n' 'WARNING: --allow-unprotected: the environment will NOT be created or checked for reviewers and ref policy.' >&2
  else
    [[ -n $reviewer && -n $ref_pattern ]] || fail 'REVIEWER_LOGIN and REF_PATTERN are required (config file) so the environment can be protected. Use --allow-unprotected only to knowingly skip this.'
    : "${ref_type:=tag}"
    [[ $reviewer =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$ ]] || fail 'Invalid reviewer login.'
    [[ $ref_type == tag || $ref_type == branch ]] || fail 'REF_TYPE must be tag or branch.'
    [[ $ref_pattern =~ ^[A-Za-z0-9._/*-]+$ && ${#ref_pattern} -le 255 ]] || fail 'Invalid REF_PATTERN (letters, digits, dot, underscore, slash, hyphen, asterisk).'
  fi
  command -v base64 >/dev/null || fail 'base64 is required.'
  command -v tr >/dev/null || fail 'tr is required.'
  # Values stay in shell memory/pipes; no generated credential files, no exports.
  certificate=$(base64 < "$p12" | tr -d '\r\n') || fail 'Cannot encode P12.'
  [[ ${#certificate} -le 48000 ]] || fail 'Encoded P12 exceeds conservative GitHub secret size limit (48000 bytes).'
  ask identity 'Expected full Developer ID Application identity (including team)'
  [[ $identity == 'Developer ID Application: '* && $identity != *$'\r'* && ${#identity} -le 48000 ]] || fail 'Expected a Developer ID Application identity.'
  ask team 'Expected Apple team ID'
  [[ $team =~ ^[A-Z0-9]{10}$ && $identity == *"($team)" ]] || fail 'Team ID must be 10 uppercase letters/digits and match identity suffix.'
  if [[ $mode == api ]]; then
    private_key=$(< "$p8")
    [[ ${#private_key} -le 48000 && $private_key == *'-----BEGIN PRIVATE KEY-----'* && $private_key == *'-----END PRIVATE KEY-----'* ]] || fail 'P8 must contain a PEM private key under 48000 bytes.'
    ask key_id 'Team API key ID'
    [[ $key_id =~ ^[A-Z0-9]{10}$ ]] || fail 'Invalid team API key ID.'
    ask issuer 'Team API issuer UUID'
    [[ $issuer =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]] || fail 'Invalid issuer UUID.'
    opposite='APPLE_ID APPLE_APP_SPECIFIC_PASSWORD'
  else
    ask apple_id 'Dedicated authorized Apple Account email'
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
    if ((allow_unprotected)); then
      printf '%s\n' 'Planned: gh api repos/'"$repo/environments/$environment"' (existence check only; protections skipped)'
    else
      printf '%s\n' 'Planned gh api calls (not executed):' \
        "  gh api users/$reviewer --jq .id" \
        "  gh api -X PUT repos/$repo/environments/$environment -F reviewers[][type]=User -F reviewers[][id]=<reviewer id> -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true" \
        "  gh api repos/$repo/environments/$environment/deployment-branch-policies   (list; add only if missing)" \
        "  gh api -X POST repos/$repo/environments/$environment/deployment-branch-policies -f name=$ref_pattern -f type=$ref_type" \
        "  gh api repos/$repo/environments/$environment   (read back; refuse to upload unless reviewer $reviewer and $ref_type policy $ref_pattern are in effect)"
    fi
    printf '%s\n' "A fine-grained GitHub token will be requested at a hidden prompt (not in dry-run), first verified with: gh api repos/$repo"
    required_permissions "$repo"
    printf '%s\n' 'Dry-run: no gh calls, password prompts, or mutations. Remote prerequisites NOT checked.'
    return
  fi
  command -v gh >/dev/null || fail 'Install GitHub CLI (gh) first.'
  # Pin the host; never inherit GH_DEBUG, which can log request bodies.
  export GH_HOST=github.com GH_DEBUG='' GH_PROMPT_DISABLED=1
  # An empty config dir keeps the stored gh login from ever being read or used.
  trap cleanup EXIT
  gh_config_dir=$(mktemp -d "${TMPDIR:-/tmp}/peek-gh-config.XXXXXX") || fail 'Cannot create a temporary gh config directory.'
  export GH_CONFIG_DIR=$gh_config_dir
  printf '%s\n' "Paste a fine-grained token limited to $repo (input is hidden)." >&2
  prompt gh_token 'GitHub fine-grained token' private
  [[ $gh_token =~ ^github_pat_[A-Za-z0-9_]+$ && ${#gh_token} -le 1000 ]] || fail 'Expected a fine-grained personal access token (github_pat_...). Classic and OAuth tokens reach too much.'
  export GH_TOKEN=$gh_token
  gh api "repos/$repo" --silent >/dev/null 2>&1 || { required_permissions "$repo" >&2; fail "The token cannot access $repo (rejected, expired, or wrong owner or repository). Nothing uploaded."; }
  local env_path="repos/$repo/environments/$environment" policy_line="$ref_type $ref_pattern" out
  if ((allow_unprotected)); then
    gh api "$env_path" --silent >/dev/null 2>&1 || fail 'Environment must already exist and be accessible (protections were not managed: --allow-unprotected).'
  else
    reviewer_id=$(gh api "users/$reviewer" --jq .id 2>/dev/null) || fail "Cannot look up GitHub user $reviewer."
    [[ $reviewer_id =~ ^[0-9]+$ ]] || fail "Unexpected id for GitHub user $reviewer."
    gh api -X PUT "$env_path" -F 'reviewers[][type]=User' -F "reviewers[][id]=$reviewer_id" \
      -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true' \
      --silent >/dev/null 2>&1 || fail 'Cannot create or update the environment (admin rights on the repository are required). Nothing uploaded.'
    out=$(gh api "$env_path/deployment-branch-policies" --jq '.branch_policies[]? | "\(.type // "branch") \(.name)"' 2>/dev/null) || fail 'Cannot list environment ref policies.'
    if [[ $'\n'"$out"$'\n' != *$'\n'"$policy_line"$'\n'* ]]; then
      gh api -X POST "$env_path/deployment-branch-policies" -f "name=$ref_pattern" -f "type=$ref_type" --silent >/dev/null 2>&1 || fail 'Cannot add the ref policy. Nothing uploaded.'
    fi
    # Read everything back: a plan may silently ignore reviewers or ref policies.
    out=$(gh api "$env_path" --jq '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]? | .reviewer.id | tostring] | join(",")' 2>/dev/null) || fail 'Cannot read back the environment.'
    [[ ",$out," == *",$reviewer_id,"* ]] || fail "Required reviewer $reviewer is NOT in effect on this environment (the repository plan may not support required reviewers). Nothing uploaded. Use --allow-unprotected only to knowingly accept this."
    out=$(gh api "$env_path" --jq '.deployment_branch_policy.custom_branch_policies // false' 2>/dev/null) || fail 'Cannot read back the environment.'
    [[ $out == true ]] || fail 'Custom ref policy is NOT in effect on this environment. Nothing uploaded. Use --allow-unprotected only to knowingly accept this.'
    out=$(gh api "$env_path/deployment-branch-policies" --jq '.branch_policies[]? | "\(.type // "branch") \(.name)"' 2>/dev/null) || fail 'Cannot list environment ref policies.'
    [[ $'\n'"$out"$'\n' == *$'\n'"$policy_line"$'\n'* ]] || fail "Ref policy $ref_type $ref_pattern is NOT in effect. Nothing uploaded."
    printf 'Environment protections verified: required reviewer %s; %s ref policy %s.\n' "$reviewer" "$ref_type" "$ref_pattern"
  fi
  names=$(gh secret list --repo "$repo" --env "$environment" --json name --jq '.[].name' 2>/dev/null) || fail 'Cannot list environment secret names.'
  for name in $opposite; do
    if [[ $'\n'"$names"$'\n' == *$'\n'"$name"$'\n'* ]]; then
      fail "Opposite auth-mode secret $name exists. Remove obsolete credentials out of band after owner approval, then retry. Nothing uploaded."
    fi
  done
  printf '%s\n' 'Reviewer and ref policy are verified above; prevent-self-review, tag protection and' \
    'workflow/dependency protection must still be reviewed in GitHub settings.' \
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
