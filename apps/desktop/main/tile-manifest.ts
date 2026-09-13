/**
 * Tile Manifest — filesystem loader
 *
 * The capability vocabulary, manifest types, detection, validation and
 * capability-resolution logic live in the shared `@peek/capabilities`
 * package so `apps/server` can enforce the same declarations the desktop
 * does instead of reimplementing them (see `docs/workers-capabilities.md`
 * §3.1). This file re-exports that whole surface unchanged — every call
 * site under `apps/desktop/main` keeps importing from `./tile-manifest.js`
 * — and keeps only `parseManifestFile()`, the one function that touches
 * the filesystem and has no use on the server.
 */

import fs from 'node:fs';
import type { ParsedManifest, TileManifest } from '@peek/capabilities';
import { detectManifestVersion, validateTileManifest } from '@peek/capabilities';

export * from '@peek/capabilities';

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a manifest.json file and detect its version
 * Returns null if file doesn't exist or is invalid JSON
 */
export function parseManifestFile(manifestPath: string): ParsedManifest | null {
  // Note: do NOT guard with `fs.existsSync` here. In packaged Electron builds
  // (asar archive), `existsSync` returns false for paths inside `app.asar` /
  // `app.asar.unpacked` even when the file is readable — see the manifest-cache
  // upsert flood reported on the AppImage build. Rely on `readFileSync`'s
  // ENOENT throw instead and treat that as "missing" silently.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    // ENOENT is "file legitimately doesn't exist" — silent return matches the
    // old existsSync()→null behaviour. Anything else (parse error, perms,
    // etc.) is real and worth logging.
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tile-manifest] Failed to parse ${manifestPath}:`, message);
    return null;
  }

  try {
    const version = detectManifestVersion(raw);

    if (version === 'legacy') {
      return { version: 'legacy', raw };
    }

    // Validate tile manifest
    const errors = validateTileManifest(raw);
    if (errors.length > 0) {
      console.error(`[tile-manifest] Validation errors in ${manifestPath}:`);
      for (const err of errors) {
        console.error(`  ${err.path}: ${err.message}`);
      }
      return null;
    }

    const manifest = raw as unknown as TileManifest;
    return { version: 'tile', raw, manifest };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tile-manifest] Validation crashed for ${manifestPath}:`, message);
    return null;
  }
}
