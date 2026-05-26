#!/bin/bash
# Build apps/mobile for Linux aarch64 (Alpine/musl) using a podman container.
# Intended target: postmarketOS on Pixel 3a (sargo). See apps/mobile/linux/README
# (TODO) for runtime install steps on the phone.
#
# Outputs:
#   apps/mobile/src-tauri/target-linux-musl/release/peek-save  (binary)
#   apps/mobile/dist/                                          (frontend, embedded)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_TAG="peek-mobile-linux-build"

cd "$REPO_ROOT"

if ! command -v podman >/dev/null 2>&1; then
  echo "ERROR: podman not found. Install with: sudo dnf install -y podman"
  exit 1
fi

echo "==> Building container image $IMAGE_TAG..."
podman build -t "$IMAGE_TAG" -f apps/mobile/linux/Containerfile .

echo "==> Compiling peek-save inside container..."
podman run --rm \
  -v "$REPO_ROOT:/work:Z" \
  -w /work \
  "$IMAGE_TAG" \
  bash apps/mobile/linux/in-container-build.sh

BIN=apps/mobile/src-tauri/target-linux-musl/release/peek-save
echo ""
echo "==> Build complete: $BIN"
ls -lh "$BIN"
