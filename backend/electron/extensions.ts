/**
 * Extension discovery and manifest management
 *
 * Handles:
 * - Discovering extensions from filesystem
 * - Loading and parsing manifest files
 * - Checking extension enabled state
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './datastore.js';

// Declarative command action types
export interface CommandActionWindow {
  type: 'window';
  url: string;
  options?: Record<string, unknown>;
}

export interface CommandActionPublish {
  type: 'publish';
  topic: string;
  data?: Record<string, unknown>;
}

export interface CommandActionExecute {
  type: 'execute';
}

export type CommandAction = CommandActionWindow | CommandActionPublish | CommandActionExecute;

// Declarative command definition in manifest.json
export interface ManifestCommand {
  name: string;
  description?: string;
  action: CommandAction;
  scope?: 'global' | 'window' | 'page';
  modes?: string[];
  accepts?: string[];
  produces?: string[];
  params?: Array<{ name: string; type: string; required?: boolean; description?: string; [key: string]: unknown }>;
}

// Declarative shortcut definition in manifest.json
export interface ManifestShortcut {
  keys: string;
  command: string;
  global?: boolean;
  mode?: string;
}

export interface ExtensionManifest {
  id?: string;
  type?: 'theme' | 'extension';
  shortname?: string;
  name?: string;
  description?: string;
  version?: string;
  background?: string | false;
  builtin?: boolean;
  lazy?: boolean;  // If true, extension iframe is not loaded at startup; loaded on first command use
  commands?: ManifestCommand[];
  shortcuts?: ManifestShortcut[];
  settingsSchema?: string;
  schemas?: {
    prefs?: unknown;
    item?: unknown;
  };
  storageKeys?: Record<string, string>;
  defaults?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DiscoveredExtension {
  id: string;
  path: string;
  manifest: ExtensionManifest;
}

/**
 * Discover extensions in a directory
 * Scans for subdirectories containing manifest.json
 */
export function discoverExtensions(basePath: string): DiscoveredExtension[] {
  const extensions: DiscoveredExtension[] = [];

  if (!fs.existsSync(basePath)) return extensions;

  const entries = fs.readdirSync(basePath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const extPath = path.join(basePath, entry.name);
    const manifestPath = path.join(extPath, 'manifest.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;

      // Skip theme extensions — they are handled by discoverBuiltinThemes
      if (manifest.type === 'theme') continue;

      // Use manifest.id or folder name as fallback
      const id = manifest.id || manifest.shortname || entry.name;

      extensions.push({ id, path: extPath, manifest });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ext:discovery] Failed to load ${entry.name}:`, message);
    }
  }

  return extensions;
}

/**
 * Load extension manifest with settings schema
 * Returns null if manifest doesn't exist or is invalid
 */
export function loadExtensionManifest(extPath: string): ExtensionManifest | null {
  try {
    const manifestPath = path.join(extPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;

    // Load settings schema if specified
    if (manifest.settingsSchema) {
      const schemaPath = path.join(extPath, manifest.settingsSchema);
      if (fs.existsSync(schemaPath)) {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
        // Merge schema fields into manifest for Settings UI
        manifest.schemas = { prefs: schema.prefs, item: schema.item };
        manifest.storageKeys = schema.storageKeys;
        manifest.defaults = schema.defaults;
        if (schema.labels) {
          manifest.labels = schema.labels;
        }
      }
    }

    return manifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ext:manifest] Failed to load manifest from ${extPath}:`, message);
    return null;
  }
}

/**
 * Check if a built-in extension is enabled
 * Defaults to true for built-in extensions
 * Note: 'cmd' used to be special-cased here but was extracted out of features/
 * into core app code (app/cmd/). It no longer appears in the extension registry.
 */
export function isBuiltinExtensionEnabled(extId: string): boolean {

  try {
    const db = getDb();
    // Use 'ext_disabled' key to avoid collision with extension-internal settings.
    // Extensions may use 'enabled' for their own purposes (e.g., HUD overlay toggle),
    // so we use a distinct key that only the extension manager writes.
    const setting = db.prepare(
      'SELECT * FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(extId, 'ext_disabled') as { value?: string } | undefined;

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

/**
 * Get all external extensions from datastore
 */
export function getExternalExtensions(): Array<{
  id: string;
  path: string | null;
  enabled: boolean;
}> {
  try {
    const db = getDb();
    const exts = db.prepare('SELECT * FROM extensions').all() as Array<{
      id: string;
      path?: string;
      enabled?: number;
    }>;

    return exts.map(ext => ({
      id: ext.id,
      path: ext.path || null,
      enabled: ext.enabled === 1
    }));
  } catch {
    return [];
  }
}
