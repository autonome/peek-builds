#!/usr/bin/env bash
# Publishes packaged release artifacts for a release tag.
#
#   1. Uploads each artifact and a per-platform SHA256SUMS file to an R2
#      bucket, under <tag>/.
#   2. Attaches a small text file to the tag on tangled — the download URLs and
#      checksums — as a sh.tangled.repo.artifact record in the repo owner's
#      atproto repo, so the tag page links to the build.
#
# Artifacts go to R2 rather than straight onto the tag because tangled's
# artifact lexicon caps a blob at 50 MiB, and every desktop build is larger.
#
# Usage:
#   scripts/publish-release.sh                      # legacy: one out/*.AppImage
#   scripts/publish-release.sh <platform> <file>... # e.g. macos-arm64 out/*.dmg out/*.zip
#
# Runs in CI after packaging (.tangled/workflows/appimage.yml and
# .github/workflows/macos.yml). When the run was not triggered by a tag, it
# exits 0 without publishing, so manual runs only build.
#
# Environment. The spindle sets the TANGLED_* variables; GitHub Actions sets
# them explicitly. The rest are repo secrets:
#   TANGLED_REF_TYPE, TANGLED_REF_NAME
#   TANGLED_REPO_DID        the repo owner's DID
#   TANGLED_REPO_REPO_DID   the repo's own DID
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   R2_PUBLIC_URL           public base URL of the bucket, no trailing slash
#   ATP_APP_PASSWORD        an app password for the repo owner's account
#
# Requires curl, jq, git, node and either sha256sum or shasum.
set -euo pipefail

legacy=0
platform=""
built=()

if [ "$#" -eq 0 ]; then
  legacy=1
  shopt -s nullglob
  built=(out/*.AppImage)
elif [ "$#" -ge 2 ]; then
  platform=$1
  shift
  built=("$@")
else
  echo "usage: $0 [<platform> <file>...]" >&2
  echo "  with no arguments, publishes exactly one out/*.AppImage" >&2
  exit 2
fi

if [ "${#built[@]}" -eq 0 ]; then
  echo "publish-release: no artifacts to publish" >&2
  exit 1
fi
if [ "$legacy" -eq 1 ] && [ "${#built[@]}" -ne 1 ]; then
  echo "publish-release: expected exactly one out/*.AppImage, found ${#built[@]}" >&2
  exit 1
fi
for f in "${built[@]}"; do
  if [ ! -f "$f" ]; then
    echo "publish-release: no such file: $f" >&2
    exit 1
  fi
done

if [ "${TANGLED_REF_TYPE:-}" != "tag" ]; then
  echo "publish-release: not a tag run, nothing to publish"
  exit 0
fi

for v in TANGLED_REF_NAME TANGLED_REPO_DID TANGLED_REPO_REPO_DID \
  R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_URL \
  ATP_APP_PASSWORD; do
  if [ -z "${!v:-}" ]; then
    echo "publish-release: missing environment variable $v" >&2
    exit 1
  fi
done

tag=$TANGLED_REF_NAME
collection=sh.tangled.repo.artifact

# Tangled attaches artifacts only to annotated tags, keyed by the tag object's
# hash. Check before uploading anything, so a lightweight tag fails loudly
# instead of publishing a build the tag page never shows.
if ! tag_hash=$(git rev-parse --verify --quiet "refs/tags/$tag^{tag}" 2>/dev/null); then
  echo "publish-release: $tag is not an annotated tag; recreate it with git tag -a" >&2
  exit 1
fi
# atproto encodes bytes as unpadded standard base64.
tag_bytes=$(node -e 'process.stdout.write(Buffer.from(process.argv[1], "hex").toString("base64").replace(/=+$/, ""))' "$tag_hash")

if [ "$legacy" -eq 1 ]; then
  legacy_arch=$(uname -m)
  platform="linux-$legacy_arch"
fi
case "$platform" in
*[!A-Za-z0-9._-]*)
  echo "publish-release: platform label must be filename-safe: $platform" >&2
  exit 2
  ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

names=()
shas=()
for f in "${built[@]}"; do
  if [ "$legacy" -eq 1 ]; then
    name="Peek-$tag-$legacy_arch.AppImage"
  else
    name="Peek-$tag-$platform.${f##*.}"
  fi
  names+=("$name")
  shas+=("$(sha256 "$f")")
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "$legacy" -eq 1 ]; then
  sums="SHA256SUMS"
  pointer="$name.txt"
else
  sums="SHA256SUMS-$platform"
  pointer="Peek-$tag-$platform.txt"
fi

: >"$work/$sums"
for ((i = 0; i < ${#names[@]}; i++)); do
  printf '%s  %s\n' "${shas[$i]}" "${names[$i]}" >>"$work/$sums"
done

{
  if [ "$legacy" -eq 1 ]; then
    printf 'Peek %s for Linux (%s)\n' "$tag" "$legacy_arch"
  else
    printf 'Peek %s for %s\n' "$tag" "$platform"
  fi
  for ((i = 0; i < ${#names[@]}; i++)); do
    printf '%s\nsha256 %s\n' "$R2_PUBLIC_URL/$tag/${names[$i]}" "${shas[$i]}"
  done
} >"$work/$pointer"

# --- R2 -----------------------------------------------------------------------

# R2 speaks the S3 API; curl signs the request itself. The payload is sent
# unsigned so curl does not hash the whole artifact into the signature.
r2_put() { # <file> <object key> <content type>
  curl -fsS --retry 3 \
    --aws-sigv4 "aws:amz:auto:s3" \
    --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
    -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
    -H "Content-Type: $3" \
    -T "$1" \
    "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET/$2"
}

for ((i = 0; i < ${#names[@]}; i++)); do
  echo "publish-release: uploading ${names[$i]} to R2"
  r2_put "${built[$i]}" "$tag/${names[$i]}" application/octet-stream
done
echo "publish-release: uploading $sums to R2"
r2_put "$work/$sums" "$tag/$sums" text/plain

# --- tangled ------------------------------------------------------------------

# The owner's PDS holds the artifact record; find it from the DID document.
case "$TANGLED_REPO_DID" in
did:plc:*) did_doc=$(curl -fsS "https://plc.directory/$TANGLED_REPO_DID") ;;
did:web:*) did_doc=$(curl -fsS "https://${TANGLED_REPO_DID#did:web:}/.well-known/did.json") ;;
*)
  echo "publish-release: unsupported DID method in $TANGLED_REPO_DID" >&2
  exit 1
  ;;
esac
pds=$(jq -r '.service[] | select(.id == "#atproto_pds") | .serviceEndpoint' <<<"$did_doc")

session=$(jq -n --arg id "$TANGLED_REPO_DID" --arg pw "$ATP_APP_PASSWORD" \
  '{identifier: $id, password: $pw}' |
  curl -fsS -X POST -H "Content-Type: application/json" --data @- \
    "$pds/xrpc/com.atproto.server.createSession")
jwt=$(jq -r .accessJwt <<<"$session")
did=$(jq -r .did <<<"$session")

xrpc_post() { # <method> ; JSON body on stdin
  curl -fsS -X POST -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" --data @- "$pds/xrpc/$1"
}

# Tangled keeps one artifact per tag and name and ignores later duplicates, so
# a re-run for the same tag deletes the earlier record before writing its own.
cursor=""
while :; do
  page=$(curl -fsS -G -H "Authorization: Bearer $jwt" \
    --data-urlencode "repo=$did" --data-urlencode "collection=$collection" \
    --data-urlencode "limit=100" ${cursor:+--data-urlencode "cursor=$cursor"} \
    "$pds/xrpc/com.atproto.repo.listRecords")
  stale=$(jq -r --arg name "$pointer" --arg tag "$tag_bytes" --arg repo "$TANGLED_REPO_REPO_DID" \
    '.records[]
     | select(.value.name == $name and .value.repoDid == $repo
              and ((.value.tag["$bytes"] // "") | rtrimstr("=")) == $tag)
     | .uri | split("/") | last' <<<"$page")
  for rkey in $stale; do
    echo "publish-release: replacing earlier artifact record $rkey"
    jq -n --arg repo "$did" --arg c "$collection" --arg rkey "$rkey" \
      '{repo: $repo, collection: $c, rkey: $rkey}' |
      xrpc_post com.atproto.repo.deleteRecord >/dev/null
  done
  cursor=$(jq -r '.cursor // empty' <<<"$page")
  [ -n "$cursor" ] || break
done

blob=$(curl -fsS -X POST -H "Authorization: Bearer $jwt" \
  -H "Content-Type: text/plain" --data-binary @"$work/$pointer" \
  "$pds/xrpc/com.atproto.repo.uploadBlob" | jq -c .blob)

jq -n --arg repo "$did" --arg c "$collection" --arg name "$pointer" \
  --arg tag "$tag_bytes" --arg repoDid "$TANGLED_REPO_REPO_DID" \
  --argjson blob "$blob" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{repo: $repo, collection: $c, validate: false,
    record: {"$type": $c, name: $name, tag: {"$bytes": $tag},
             repoDid: $repoDid, artifact: $blob, createdAt: $now}}' |
  xrpc_post com.atproto.repo.createRecord >/dev/null

echo "publish-release: published $pointer"
