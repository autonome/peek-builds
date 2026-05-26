#!/bin/bash
# Runs inside the alpine container started by ../build-linux.sh.
# Builds the peek-mobile binary for Linux aarch64 (musl).
set -e

cd /work/apps/mobile

if [ ! -d node_modules ]; then
  echo "[in-container] Installing npm deps..."
  npm install --silent
fi

echo "[in-container] Building frontend (vite -> dist/)..."
# vite.config.ts reads BUILD_NUMBER unconditionally — seed a default if missing
# (gitignored file, normally created by iOS deploy:sim script).
[ -f BUILD_NUMBER ] || echo "0" > BUILD_NUMBER
npm run build

echo "[in-container] Compiling Rust binary..."
cd src-tauri

# Separate target dir so musl artifacts don't collide with host glibc target/
export CARGO_TARGET_DIR=/work/apps/mobile/src-tauri/target-linux-musl

# custom-protocol embeds dist/ into the binary (per mobile/CLAUDE.md, never enable by default;
# always opt-in at build time).
cargo build --release --bin peek-save --features custom-protocol

echo "[in-container] Done."
ls -lh "$CARGO_TARGET_DIR/release/peek-save"
