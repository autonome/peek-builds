#!/usr/bin/env bash
# Copies the release-publishing values from this machine's Tangled/spindle
# config into GitHub Actions repository secrets on the macOS build mirror.
#
# Sources (all local, mode 600 where they hold credentials):
#   ~/.config/peek-releases-r2.env   R2_* values
#   ~/.config/entangle/env           TANGLED_APP_PASSWORD (the owner app password)
#   ~/.config/spindle/spindle.conf   SPINDLE_SERVER_OWNER (the owner DID)
#
# The repo DID is read from the public sh.tangled.repo record, so it cannot
# drift from the repo's actual DID.
#
# Usage:
#   scripts/set-github-secrets.sh             # set the secrets
#   scripts/set-github-secrets.sh --dry-run   # show names and value lengths only
#
# Set GITHUB_REPO to override the target (default autonome/peek-builds).
set -euo pipefail

repo="${GITHUB_REPO:-autonome/peek-builds}"
dry_run=0
case "${1:-}" in
--dry-run) dry_run=1 ;;
"") ;;
*)
  echo "usage: $0 [--dry-run]" >&2
  exit 2
  ;;
esac

r2_env="${HOME}/.config/peek-releases-r2.env"
atproto_env="${HOME}/.config/entangle/env"
spindle_conf="${HOME}/.config/spindle/spindle.conf"

for f in "$r2_env" "$atproto_env" "$spindle_conf"; do
  [ -f "$f" ] || {
    echo "missing $f" >&2
    exit 1
  }
done

read_env() { # <file> <key>
  awk -F= -v key="$2" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

require() { # <name> <value>
  if [ -z "$2" ]; then
    echo "empty value for $1" >&2
    exit 1
  fi
}

owner=$(read_env "$spindle_conf" SPINDLE_SERVER_OWNER)
atp_password=$(read_env "$atproto_env" TANGLED_APP_PASSWORD)
require SPINDLE_SERVER_OWNER "$owner"
require TANGLED_APP_PASSWORD "$atp_password"

did_doc=$(curl -fsS "https://plc.directory/$owner")
pds=$(jq -r '.service[] | select(.id == "#atproto_pds") | .serviceEndpoint' <<<"$did_doc")
[ -n "$pds" ] || {
  echo "could not resolve the PDS for $owner" >&2
  exit 1
}
# The sh.tangled.repo record for burrito.space/peek. Reading it (rather than
# listing every repo) keeps the repo DID in sync with Tangled without paging
# through the owner's whole repo list.
repo_record=$(curl -fsS -G \
  --data-urlencode "repo=$owner" \
  --data-urlencode "collection=sh.tangled.repo" \
  --data-urlencode "rkey=3mcpaj34xj622" \
  "$pds/xrpc/com.atproto.repo.getRecord")
repo_did=$(jq -r '.value.repoDid // empty' <<<"$repo_record")
[ -n "$repo_did" ] || {
  echo "could not read the peek sh.tangled.repo record for $owner" >&2
  exit 1
}

names=(
  TANGLED_REPO_DID
  TANGLED_REPO_REPO_DID
  R2_ACCOUNT_ID
  R2_BUCKET
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_PUBLIC_URL
  ATP_APP_PASSWORD
)
values=(
  "$owner"
  "$repo_did"
  "$(read_env "$r2_env" R2_ACCOUNT_ID)"
  "$(read_env "$r2_env" R2_BUCKET)"
  "$(read_env "$r2_env" R2_ACCESS_KEY_ID)"
  "$(read_env "$r2_env" R2_SECRET_ACCESS_KEY)"
  "$(read_env "$r2_env" R2_PUBLIC_URL)"
  "$atp_password"
)

for i in "${!names[@]}"; do
  require "${names[$i]}" "${values[$i]}"
done

echo "target: $repo"
echo "owner:  $owner"
echo "repo:   $repo_did"

for i in "${!names[@]}"; do
  name=${names[$i]}
  value=${values[$i]}
  if [ "$dry_run" -eq 1 ]; then
    printf '%s (%d chars)\n' "$name" "${#value}"
  else
    printf '%s' "$value" | gh secret set "$name" --repo "$repo" >/dev/null
    printf '%s set\n' "$name"
  fi
done
