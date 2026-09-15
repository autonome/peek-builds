#!/usr/bin/env bash
# Publishes the packaged Linux AppImage for a release tag.
#
#   1. Uploads the AppImage and a SHA256SUMS file to an R2 bucket, under <tag>/.
#   2. Attaches a small text file to the tag on tangled — the download URL and
#      checksum — as a sh.tangled.repo.artifact record in the repo owner's
#      atproto repo, so the tag page links to the build.
#
# The binary goes to R2 rather than straight onto the tag because tangled's
# artifact lexicon caps a blob at 50 MiB, and the AppImage is several times that.
#
# Runs in CI after the AppImage is packaged (.tangled/workflows/appimage.yml).
# When the run was not triggered by a tag, it exits 0 without publishing, so
# manual runs of that workflow only build.
#
# Environment. The spindle sets the TANGLED_* variables; the rest are repo
# secrets, added in the repo's tangled settings:
#   TANGLED_REF_TYPE, TANGLED_REF_NAME
#   TANGLED_REPO_DID        the repo owner's DID
#   TANGLED_REPO_REPO_DID   the repo's own DID
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   R2_PUBLIC_URL           public base URL of the bucket, no trailing slash
#   ATP_APP_PASSWORD        an app password for the repo owner's account
#
# Requires curl, jq, git, node and sha256sum.
set -euo pipefail

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

shopt -s nullglob
built=(out/*.AppImage)
if [ "${#built[@]}" -ne 1 ]; then
  echo "publish-release: expected exactly one out/*.AppImage, found ${#built[@]}" >&2
  exit 1
fi

arch=$(uname -m)
name="Peek-$tag-$arch.AppImage"
sha=$(sha256sum "${built[0]}" | cut -d' ' -f1)
url="$R2_PUBLIC_URL/$tag/$name"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s  %s\n' "$sha" "$name" >"$work/SHA256SUMS"

# --- R2 -----------------------------------------------------------------------

# R2 speaks the S3 API; curl signs the request itself. The payload is sent
# unsigned so curl does not hash the whole AppImage into the signature.
r2_put() { # <file> <object key> <content type>
  curl -fsS --retry 3 \
    --aws-sigv4 "aws:amz:auto:s3" \
    --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
    -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
    -H "Content-Type: $3" \
    -T "$1" \
    "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET/$2"
}

echo "publish-release: uploading $name to R2"
r2_put "${built[0]}" "$tag/$name" application/octet-stream
r2_put "$work/SHA256SUMS" "$tag/SHA256SUMS" text/plain

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

pointer="$name.txt"
printf 'Peek %s for Linux (%s)\n%s\nsha256 %s\n' "$tag" "$arch" "$url" "$sha" >"$work/$pointer"

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

echo "publish-release: published $url"
