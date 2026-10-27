/**
 * Tile feature state — discovery and enabled-state helpers
 *
 * Thin filesystem + datastore queries that the rest of the backend uses
 * to enumerate features and check whether
 * a builtin is enabled. The actual tile launch / lifecycle lives in
 * `tile-launcher.ts` / `tile-lifecycle.ts`; manifest parsing lives in
 * `tile-manifest.ts` (returns the strict v3 `TileManifest` shape).
 *
 * Returned manifest objects here are deliberately untyped (`unknown`) —
 * callers that need typed access go through `tile-manifest.ts`. This
 * module is only for the few places that need a quick path-from-disk
 * read (e.g. the Features pane listing every registered tile).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './datastore.js';
import {
  validateSettingsSchema,
  logValidationIssues,
} from './settings-schema-validation.js';

export interface DiscoveredFeature {
  id: string;
  path: string;
  manifest: Record<string, unknown>;
}

/**
 * Discover features in a directory.
 * Scans for subdirectories containing manifest.json. Theme manifests
 * (`type: "theme"`) are skipped here — themes are discovered separately
 * by `discoverBuiltinThemes` in `main.ts` — and so are window-mode manifests
 * (`type: "window-mode"`, found by `discoverBuiltinWindowModes`).
 */
export function discoverFeatures(basePath: string): DiscoveredFeature[] {
  const features: DiscoveredFeature[] = [];

  if (!fs.existsSync(basePath)) return features;

  const entries = fs.readdirSync(basePath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const featPath = path.join(basePath, entry.name);
    const manifestPath = path.join(featPath, 'manifest.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;

      // Skip theme features — handled by discoverBuiltinThemes
      if (manifest.type === 'theme' || manifest.type === 'window-mode') continue;

      const id = (manifest.id as string | undefined)
        || (manifest.shortname as string | undefined)
        || entry.name;

      features.push({ id, path: featPath, manifest });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[feature:discovery] Failed to load ${entry.name}:`, message);
    }
  }

  return features;
}

/**
 * Load a feature's manifest.json (with optional settings schema merge).
 * Returns null if the manifest doesn't exist or fails to parse.
 *
 * If the manifest declares `settingsSchema`, the schema is loaded,
 * validated, and merged into the returned manifest so the Settings UI
 * can render it. Validation issues are logged but never block loading.
 */
export function loadFeatureManifest(featPath: string): Record<string, unknown> | null {
  try {
    const manifestPath = path.join(featPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;

    const settingsSchemaRel = manifest.settingsSchema as string | undefined;
    if (settingsSchemaRel) {
      const schemaPath = path.join(featPath, settingsSchemaRel);
      if (fs.existsSync(schemaPath)) {
        try {
          const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

          const featId = (manifest.id as string | undefined)
            || (manifest.shortname as string | undefined)
            || path.basename(featPath);
          try {
            const result = validateSettingsSchema(schema);
            logValidationIssues(featId, result);
          } catch (validationErr) {
            const vmsg = validationErr instanceof Error ? validationErr.message : String(validationErr);
            console.error(`[schema-validation] ${featId}: validator threw unexpectedly:`, vmsg);
          }

          // Merge schema fields into manifest for Settings UI
          manifest.schemas = { prefs: schema.prefs, item: schema.item };
          manifest.storageKeys = schema.storageKeys;
          manifest.defaults = schema.defaults;
          if (schema.labels) {
            manifest.labels = schema.labels;
          }
        } catch (schemaErr) {
          const featId = (manifest.id as string | undefined)
            || (manifest.shortname as string | undefined)
            || path.basename(featPath);
          const msg = schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
          console.error(`[schema-validation] ${featId}: failed to parse ${settingsSchemaRel}:`, msg);
        }
      }
    }

    return manifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[feature:manifest] Failed to load manifest from ${featPath}:`, message);
    return null;
  }
}

/**
 * Check if a built-in feature is enabled.
 * Defaults to true for built-in features.
 *
 * Uses the `ext_disabled` settings key to avoid collision with feature-
 * internal settings (some features use `enabled` for their own purposes,
 * e.g. HUD overlay toggle). Only the feature manager writes this key.
 */
export function isBuiltinFeatureEnabled(featId: string): boolean {
  try {
    const db = getDb();
    const setting = db.prepare(
      'SELECT * FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(featId, 'ext_disabled') as { value?: string } | undefined;

    if (setting) {
      try {
        return JSON.parse(setting.value || 'false') !== true;
      } catch {
        return true;
      }
    }
    return true; // Default to enabled for builtins
  } catch {
    return true; // Database not ready, default to enabled
  }
}
