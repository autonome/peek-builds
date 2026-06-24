#!/bin/bash
# iOS build cache utilities
# Caches Rust build artifacts to avoid rebuilds across agent workspaces

# Cache location (relative to repo root)
IOS_CACHE_DIR="tmp/ios-cache"

# Get the repository root directory
get_repo_root() {
    git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
}

# Compute hash of ALL inputs that affect the embedded iOS app.
#
# CRITICAL: the iOS app embeds the built frontend into libapp.a at Rust compile
# time and serves THAT embedded bundle at runtime (NOT the on-disk
# gen/apple/assets copy). So the cache key must cover the frontend sources too —
# otherwise a frontend-only change gets a cache hit, the stale embedded bundle is
# reused, and the device silently runs old code. (That footgun cost a full
# debugging session on 2026-06-24: every "fix" updated the gen/apple/assets
# parity copy but never the embedded bundle the device actually ran.)
#
# Inputs hashed:
#   - src-tauri: Cargo.toml/lock, tauri.conf.json, build.rs, src/**/*.rs
#   - peek-core (path dependency, embedded too): Cargo.toml, src/**/*.rs
#   - frontend (embedded bundle): src/**/*.{ts,tsx,js,jsx,css,html,json},
#     index.html, package.json, tsconfig.json, vite.config.*
get_source_hash() {
    local tauri_dir="$1"

    if [ -z "$tauri_dir" ]; then
        echo "Error: tauri_dir required" >&2
        return 1
    fi

    local app_dir
    app_dir="$(cd "$tauri_dir/.." && pwd)"

    {
        # Rust: src-tauri config + sources, plus the peek-core path dependency.
        cat "$tauri_dir/Cargo.toml" \
            "$tauri_dir/Cargo.lock" \
            "$tauri_dir/tauri.conf.json" \
            "$tauri_dir/build.rs" \
            "$app_dir/peek-core/Cargo.toml" 2>/dev/null
        find "$tauri_dir/src" "$app_dir/peek-core/src" -type f -name '*.rs' \
            -print0 2>/dev/null | sort -z | xargs -0 cat 2>/dev/null

        # Frontend: anything that changes the bundle embedded into libapp.a.
        find "$app_dir/src" -type f \
            \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
               -o -name '*.css' -o -name '*.html' -o -name '*.json' \) \
            -print0 2>/dev/null | sort -z | xargs -0 cat 2>/dev/null
        cat "$app_dir/index.html" \
            "$app_dir/package.json" \
            "$app_dir/tsconfig.json" \
            "$app_dir/vite.config.ts" \
            "$app_dir/vite.config.js" 2>/dev/null
    } | shasum -a 256 | cut -d' ' -f1
}

# Check if cache is valid for a given build type
# Returns 0 if cache hit, 1 if cache miss
# Usage: check_cache debug|release tauri_dir
check_cache() {
    local build_type="$1"
    local tauri_dir="$2"
    local repo_root
    repo_root="$(get_repo_root)"

    local cache_dir="$repo_root/$IOS_CACHE_DIR/$build_type"
    local lib_path="$cache_dir/libapp.a"
    local checksum_path="$cache_dir/checksum.txt"

    # Check if cached files exist
    if [ ! -f "$lib_path" ] || [ ! -f "$checksum_path" ]; then
        echo "Cache miss: no cached $build_type build found"
        return 1
    fi

    # Compare checksums
    local current_hash
    local cached_hash
    current_hash="$(get_source_hash "$tauri_dir")"
    cached_hash="$(cat "$checksum_path")"

    if [ "$current_hash" = "$cached_hash" ]; then
        echo "Cache hit: $build_type build matches (hash: ${current_hash:0:8}...)"
        return 0
    else
        echo "Cache miss: source changed (cached: ${cached_hash:0:8}..., current: ${current_hash:0:8}...)"
        return 1
    fi
}

# Update cache with newly built library
# Usage: update_cache debug|release tauri_dir lib_path
update_cache() {
    local build_type="$1"
    local tauri_dir="$2"
    local lib_path="$3"
    local repo_root
    repo_root="$(get_repo_root)"

    local cache_dir="$repo_root/$IOS_CACHE_DIR/$build_type"

    # Create cache directory if needed
    mkdir -p "$cache_dir"

    # Copy library to cache
    cp "$lib_path" "$cache_dir/libapp.a"

    # Save checksum
    get_source_hash "$tauri_dir" > "$cache_dir/checksum.txt"

    echo "Cache updated: $build_type build saved to $cache_dir"
}

# Copy cached library to workspace destination
# Usage: use_cache debug|release dest_path
use_cache() {
    local build_type="$1"
    local dest_path="$2"
    local repo_root
    repo_root="$(get_repo_root)"

    local cache_dir="$repo_root/$IOS_CACHE_DIR/$build_type"
    local lib_path="$cache_dir/libapp.a"

    # Ensure destination directory exists
    mkdir -p "$(dirname "$dest_path")"

    # Copy from cache
    cp "$lib_path" "$dest_path"

    echo "Using cached $build_type build: $dest_path"
}

# Clear cache for a build type or all caches
# Usage: clear_cache [debug|release]
clear_cache() {
    local build_type="$1"
    local repo_root
    repo_root="$(get_repo_root)"

    if [ -z "$build_type" ]; then
        rm -rf "$repo_root/$IOS_CACHE_DIR"
        echo "Cleared all iOS build caches"
    else
        rm -rf "$repo_root/$IOS_CACHE_DIR/$build_type"
        echo "Cleared $build_type iOS build cache"
    fi
}
