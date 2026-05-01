/**
 * Tile Settings Defaults — pure helper (no Electron / DB deps)
 *
 * The `tile:settings:get` IPC handler queries `feature_settings` for the
 * requested key, and returns `null` when the row is missing. Tiles should
 * be able to rely on the backend returning the value declared in their
 * `settingsSchema` file's `defaults` block when the key has never been
 * written.
 *
 * This module does two things:
 *   1. `loadSchemaDefaults(tilePath, settingsSchemaRelPath)` — reads the
 *      schema file from disk and returns its `defaults` object (or null).
 *      Called once at tile-load time; the resulting object is cached on
 *      the in-memory manifest via `TileManifest.defaults`.
 *   2. `resolveSettingDefault(manifest, key)` — pure lookup against
 *      `manifest.defaults`. Returns the default value or `undefined`
 *      when none is declared. Supports both flat keys
 *      (`defaults[key]`) and dotted paths (`defaults.prefs.foo`).
 *
 * Extracted into its own module so it can be unit-tested without loading
 * Electron's ipcMain or a real SQLite database.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TileManifest } from './tile-manifest.js';

// ─── Schema Loading ──────────────────────────────────────────────────

/**
 * Read the `defaults` object from a tile's settings schema file.
 *
 * Returns `null` when:
 *   - the tile has no `settingsSchema` declared, or
 *   - the schema file does not exist, or
 *   - the schema file is not valid JSON, or
 *   - the schema file does not declare a top-level `defaults` object.
 *
 * Any file-system or JSON errors are swallowed and logged to stderr —
 * a missing / malformed schema must never prevent a tile from loading.
 */
export function loadSchemaDefaults(
  tilePath: string,
  settingsSchemaRelPath: string | undefined
): Record<string, unknown> | null {
  if (!settingsSchemaRelPath) return null;

  try {
    const schemaPath = path.join(tilePath, settingsSchemaRelPath);
    if (!fs.existsSync(schemaPath)) return null;

    const raw = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(raw) as Record<string, unknown>;

    const defaults = schema.defaults;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      return null;
    }

    return defaults as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[tile-settings-defaults] Failed to load defaults from ${settingsSchemaRelPath}:`,
      message
    );
    return null;
  }
}

// ─── Default Resolution ──────────────────────────────────────────────

/**
 * Resolve the declared default for `key` from a loaded manifest.
 *
 * Lookup order (first match wins):
 *   1. `manifest.defaults[key]` — flat / exact key
 *   2. If `key` contains one or more dots, walk each segment into
 *      `manifest.defaults` (e.g. `'prefs.foo'` → `defaults.prefs.foo`).
 *
 * Returns `undefined` when:
 *   - the manifest has no `defaults` block, or
 *   - no entry matches either lookup form.
 *
 * The sentinel is `undefined` (not `null`) so callers can distinguish
 * "no default declared" from "the declared default is `null`".
 */
export function resolveSettingDefault(
  manifest: TileManifest | null | undefined,
  key: string
): unknown | undefined {
  if (!manifest || !manifest.defaults) return undefined;
  if (typeof key !== 'string' || key.length === 0) return undefined;

  const defaults = manifest.defaults;

  // 1. Flat / exact lookup — covers `api.settings.get('prefs')` where the
  //    declared default is the whole `{ prefs: { ... } }` object.
  if (Object.prototype.hasOwnProperty.call(defaults, key)) {
    return defaults[key];
  }

  // 2. Dotted path — walk each segment. Supports
  //    `api.settings.get('prefs.foo')` against `{ prefs: { foo: ... } }`.
  if (key.includes('.')) {
    const segments = key.split('.');
    let cur: unknown = defaults;
    for (const seg of segments) {
      if (cur === null || typeof cur !== 'object') return undefined;
      const obj = cur as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) return undefined;
      cur = obj[seg];
    }
    return cur;
  }

  return undefined;
}
