/**
 * Tile Manifest v2 Schema and Parser
 *
 * Handles:
 * - TypeScript types for the v2 tile manifest format
 * - Detection of v1 vs v2 manifests
 * - Parsing and validation of v2 manifests
 * - Capability grant resolution (manifest declares needs, runtime validates)
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Capability Types ────────────────────────────────────────────────

/**
 * PubSub capability: which topic scopes the tile can access
 * - 'self': only topics within its own namespace (tile:{tileId}:*)
 * - 'global': can publish/subscribe to global topics
 * - 'system': can access system-level topics (privileged)
 */
export interface PubSubCapability {
  scopes: Array<'self' | 'global' | 'system'>;
  /** Optional allowlist of specific topic patterns (glob-style) */
  topics?: string[];
}

/**
 * Datastore capability: which tables/keys the tile can access
 */
export interface DatastoreCapability {
  /** Table names the tile can read/write */
  tables: string[];
  /** If true, tile can create new tables */
  createTables?: boolean;
}

/**
 * Network capability: which domains the tile can fetch from
 */
export interface NetworkCapability {
  /** Domain allowlist (e.g., ['api.github.com', '*.example.com']) */
  domains: string[];
}

/**
 * Window capability: can the tile create/manage windows
 */
export interface WindowCapability {
  /** Can create new windows */
  create?: boolean;
  /** Can query existing windows */
  query?: boolean;
  /** Can close/modify windows */
  manage?: boolean;
}

/**
 * Filesystem capability: which paths the tile can access
 */
export interface FilesystemCapability {
  /** Path patterns the tile can read (glob-style, relative to app data) */
  read?: string[];
  /** Path patterns the tile can write */
  write?: string[];
}

/**
 * Shortcuts capability: can register keyboard shortcuts
 *
 * May be expressed in the manifest as:
 *   - `true` — tile may register any shortcut
 *   - `{ keys: [...] }` — only these exact shortcut strings may be registered
 *
 * When `keys` is provided, the strict IPC handlers reject any attempt to
 * register a shortcut not in the list. When `keys` is omitted (or the
 * capability is `true`), no per-key filtering is applied — backward
 * compatible with manifests declaring `shortcuts: true`.
 */
export interface ShortcutsCapability {
  /** If present, only these shortcuts can be registered */
  keys?: string[];
}

/**
 * All capabilities a tile can request
 */
export interface TileCapabilities {
  pubsub?: PubSubCapability;
  datastore?: DatastoreCapability;
  network?: NetworkCapability;
  window?: WindowCapability;
  filesystem?: FilesystemCapability;
  /** Can register commands in the command palette */
  commands?: boolean;
  /** Can register keyboard shortcuts */
  shortcuts?: boolean | ShortcutsCapability;
  /** Can access sync APIs */
  sync?: boolean;
  /** Can read/write theme settings */
  theme?: boolean;
  /** Can read/write user settings */
  settings?: boolean;
}

// ─── Tile Definition Types ───────────────────────────────────────────

/**
 * Window hints for a tile's UI
 */
export interface TileWindowHints {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  alwaysOnTop?: boolean;
  transparent?: boolean;
  focusable?: boolean;
  frame?: boolean;
  resizable?: boolean;
  /** Window role for the IZUI system */
  role?: string;
  /** Unique key for window deduplication */
  key?: string;
  title?: string;
}

/**
 * A tile entry point — each tile in the manifest creates one context
 */
export interface TileEntry {
  /** Tile entry ID (unique within the manifest) */
  id: string;
  /** Type of tile context */
  type: 'window' | 'background' | 'panel';
  /** HTML file to load (relative to extension directory) */
  url: string;
  /** Window hints (only for type: 'window') */
  windowHints?: TileWindowHints;
  /** If true, this tile is loaded lazily on first use */
  lazy?: boolean;
  /**
   * Pubsub topics that trigger lazy loading of this tile when published.
   * Used when another feature publishes an event (e.g. `editor:open`) that
   * this tile needs to handle, but this tile hasn't been loaded yet.
   * Only meaningful when `lazy: true`.
   */
  lazyEvents?: string[];
}

/**
 * Command definition in v2 manifest (same structure as v1 for compat)
 */
export interface TileCommand {
  name: string;
  description?: string;
  action: {
    type: 'window' | 'publish' | 'execute';
    url?: string;
    topic?: string;
    data?: Record<string, unknown>;
    options?: Record<string, unknown>;
  };
  scope?: 'global' | 'window' | 'page';
  modes?: string[];
  accepts?: string[];
  produces?: string[];
  params?: Array<{
    name: string;
    type: string;
    required?: boolean;
    description?: string;
    [key: string]: unknown;
  }>;
}

/**
 * Shortcut definition in v2 manifest
 */
export interface TileShortcut {
  keys: string;
  command: string;
  global?: boolean;
  mode?: string;
}

// ─── Manifest Types ──────────────────────────────────────────────────

/**
 * V2 Tile Manifest format
 */
export interface TileManifestV2 {
  /** Manifest version — must be 2 for tile manifests */
  manifestVersion: 2;
  /** Unique tile ID */
  id: string;
  /** Short name for display */
  shortname?: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Semantic version */
  version?: string;
  /** Whether this is a built-in tile */
  builtin?: boolean;
  /** Hidden from UI listings */
  hidden?: boolean;
  /** Tile entry points (UI windows, background workers) */
  tiles: TileEntry[];
  /** Capabilities requested by this tile */
  capabilities: TileCapabilities;
  /** Commands registered by this tile */
  commands?: TileCommand[];
  /** Keyboard shortcuts */
  shortcuts?: TileShortcut[];
  /** Settings schema file path */
  settingsSchema?: string;
  /**
   * Default settings values, loaded from the `settingsSchema` file's
   * `defaults` field at tile-load time (see tile-settings-defaults.ts).
   *
   * Used by `tile:settings:get` to return a fallback when the key has never
   * been written to `feature_settings`. Shape mirrors the raw `defaults`
   * object in the schema file — typically `{ prefs: { ... }, ... }`.
   *
   * Resolution supports both flat keys (`defaults[key]`) and dotted keys
   * (`defaults.prefs.foo` via `api.settings.get('prefs.foo')`).
   */
  defaults?: Record<string, unknown>;
}

/**
 * Result of manifest detection
 */
export type ManifestVersion = 'v1' | 'v2';

/**
 * Parsed manifest result — either v1 or v2
 */
export interface ParsedManifest {
  version: ManifestVersion;
  /** Original raw JSON */
  raw: Record<string, unknown>;
  /** Only set if version is 'v2' */
  v2?: TileManifestV2;
}

// ─── Capability Grant ────────────────────────────────────────────────

/**
 * A resolved capability grant — what the runtime actually gives the tile
 */
export interface CapabilityGrant {
  tileId: string;
  /** Granted capabilities (may be a subset of requested) */
  capabilities: TileCapabilities;
  /** Capabilities that were requested but denied */
  denied: string[];
}

// ─── Constants ───────────────────────────────────────────────────────

/** Maximum number of tiles per manifest */
const MAX_TILES_PER_MANIFEST = 10;

/** Maximum number of network domains */
const MAX_NETWORK_DOMAINS = 50;

/** Maximum number of datastore tables */
const MAX_DATASTORE_TABLES = 20;

/** Capabilities that require explicit user approval (not auto-granted) */
const PRIVILEGED_CAPABILITIES = new Set<string>([
  'filesystem',
]);

/** Capabilities that are restricted to built-in tiles only */
const BUILTIN_ONLY_CAPABILITIES = new Set<string>([
  'sync',
]);

// ─── Detection ───────────────────────────────────────────────────────

/**
 * Detect whether a manifest JSON is v1 (legacy extension) or v2 (tile)
 *
 * v2 manifests are identified by having:
 * - `manifestVersion: 2`, OR
 * - Both `tiles` array AND `capabilities` object present
 */
export function detectManifestVersion(json: Record<string, unknown>): ManifestVersion {
  if (json.manifestVersion === 2) return 'v2';
  if (Array.isArray(json.tiles) && typeof json.capabilities === 'object' && json.capabilities !== null) {
    return 'v2';
  }
  return 'v1';
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validation errors collected during parsing
 */
export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validate a v2 tile manifest
 * Returns array of errors (empty = valid)
 */
export function validateTileManifest(json: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required fields
  if (!json.id || typeof json.id !== 'string') {
    errors.push({ path: 'id', message: 'id is required and must be a string' });
  }
  if (!json.name || typeof json.name !== 'string') {
    errors.push({ path: 'name', message: 'name is required and must be a string' });
  }

  // Tiles array
  if (!Array.isArray(json.tiles)) {
    errors.push({ path: 'tiles', message: 'tiles must be an array' });
  } else {
    if (json.tiles.length > MAX_TILES_PER_MANIFEST) {
      errors.push({ path: 'tiles', message: `maximum ${MAX_TILES_PER_MANIFEST} tiles per manifest` });
    }
    const tileIds = new Set<string>();
    for (let i = 0; i < json.tiles.length; i++) {
      const tile = json.tiles[i] as Record<string, unknown>;
      const prefix = `tiles[${i}]`;

      if (!tile.id || typeof tile.id !== 'string') {
        errors.push({ path: `${prefix}.id`, message: 'tile id is required' });
      } else if (tileIds.has(tile.id as string)) {
        errors.push({ path: `${prefix}.id`, message: `duplicate tile id: ${tile.id}` });
      } else {
        tileIds.add(tile.id as string);
      }

      if (!['window', 'background', 'panel'].includes(tile.type as string)) {
        errors.push({ path: `${prefix}.type`, message: 'tile type must be window, background, or panel' });
      }

      if (!tile.url || typeof tile.url !== 'string') {
        errors.push({ path: `${prefix}.url`, message: 'tile url is required' });
      }

      // Validate lazyEvents (optional array of strings)
      if (tile.lazyEvents !== undefined) {
        if (!Array.isArray(tile.lazyEvents)) {
          errors.push({ path: `${prefix}.lazyEvents`, message: 'lazyEvents must be an array of strings' });
        } else {
          for (let j = 0; j < tile.lazyEvents.length; j++) {
            const ev = tile.lazyEvents[j];
            if (typeof ev !== 'string' || ev.length === 0) {
              errors.push({ path: `${prefix}.lazyEvents[${j}]`, message: 'lazyEvents entries must be non-empty strings' });
            }
          }
        }
      }
    }
  }

  // Capabilities object
  if (typeof json.capabilities !== 'object' || json.capabilities === null) {
    errors.push({ path: 'capabilities', message: 'capabilities must be an object' });
  } else {
    const caps = json.capabilities as Record<string, unknown>;

    // Validate network domains
    if (caps.network && typeof caps.network === 'object') {
      const net = caps.network as Record<string, unknown>;
      if (Array.isArray(net.domains) && net.domains.length > MAX_NETWORK_DOMAINS) {
        errors.push({ path: 'capabilities.network.domains', message: `maximum ${MAX_NETWORK_DOMAINS} domains` });
      }
    }

    // Validate datastore tables
    if (caps.datastore && typeof caps.datastore === 'object') {
      const ds = caps.datastore as Record<string, unknown>;
      if (Array.isArray(ds.tables) && ds.tables.length > MAX_DATASTORE_TABLES) {
        errors.push({ path: 'capabilities.datastore.tables', message: `maximum ${MAX_DATASTORE_TABLES} tables` });
      }
    }

    // Validate pubsub scopes
    if (caps.pubsub && typeof caps.pubsub === 'object') {
      const ps = caps.pubsub as Record<string, unknown>;
      if (Array.isArray(ps.scopes)) {
        for (const scope of ps.scopes) {
          if (!['self', 'global', 'system'].includes(scope as string)) {
            errors.push({ path: 'capabilities.pubsub.scopes', message: `invalid scope: ${scope}` });
          }
        }
      }
    }

    // Validate shortcuts capability shape — must be boolean or { keys?: string[] }
    if (caps.shortcuts !== undefined) {
      const sc = caps.shortcuts;
      if (typeof sc === 'boolean') {
        // valid
      } else if (sc && typeof sc === 'object') {
        const scObj = sc as Record<string, unknown>;
        if (scObj.keys !== undefined) {
          if (!Array.isArray(scObj.keys)) {
            errors.push({ path: 'capabilities.shortcuts.keys', message: 'keys must be an array of strings' });
          } else {
            for (let i = 0; i < scObj.keys.length; i++) {
              const k = scObj.keys[i];
              if (typeof k !== 'string' || k.length === 0) {
                errors.push({ path: `capabilities.shortcuts.keys[${i}]`, message: 'keys entries must be non-empty strings' });
              }
            }
          }
        }
      } else {
        errors.push({ path: 'capabilities.shortcuts', message: 'shortcuts must be boolean or { keys: string[] }' });
      }
    }
  }

  // Commands validation
  if (json.commands !== undefined) {
    if (!Array.isArray(json.commands)) {
      errors.push({ path: 'commands', message: 'commands must be an array' });
    } else {
      for (let i = 0; i < json.commands.length; i++) {
        const cmd = json.commands[i] as Record<string, unknown>;
        if (!cmd.name || typeof cmd.name !== 'string') {
          errors.push({ path: `commands[${i}].name`, message: 'command name is required' });
        }
        if (!cmd.action || typeof cmd.action !== 'object') {
          errors.push({ path: `commands[${i}].action`, message: 'command action is required' });
        }
      }
    }
  }

  return errors;
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a manifest.json file and detect its version
 * Returns null if file doesn't exist or is invalid JSON
 */
export function parseManifestFile(manifestPath: string): ParsedManifest | null {
  try {
    if (!fs.existsSync(manifestPath)) return null;

    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    const version = detectManifestVersion(raw);

    if (version === 'v1') {
      return { version: 'v1', raw };
    }

    // Validate v2
    const errors = validateTileManifest(raw);
    if (errors.length > 0) {
      console.error(`[tile-manifest] Validation errors in ${manifestPath}:`);
      for (const err of errors) {
        console.error(`  ${err.path}: ${err.message}`);
      }
      return null;
    }

    const v2 = raw as unknown as TileManifestV2;
    return { version: 'v2', raw, v2 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tile-manifest] Failed to parse ${manifestPath}:`, message);
    return null;
  }
}

/**
 * Parse a manifest from a raw JSON object (for testing)
 */
export function parseManifestJSON(json: Record<string, unknown>): ParsedManifest | null {
  const version = detectManifestVersion(json);

  if (version === 'v1') {
    return { version: 'v1', raw: json };
  }

  const errors = validateTileManifest(json);
  if (errors.length > 0) {
    return null;
  }

  const v2 = json as unknown as TileManifestV2;
  return { version: 'v2', raw: json, v2 };
}

// ─── Capability Resolution ───────────────────────────────────────────

/**
 * Resolve capability grants for a tile
 *
 * Takes the requested capabilities from the manifest and determines
 * what to actually grant. Built-in tiles get broader access; external
 * tiles may have some capabilities denied.
 */
export function resolveCapabilities(
  tileId: string,
  requested: TileCapabilities,
  isBuiltin: boolean
): CapabilityGrant {
  const granted: TileCapabilities = {};
  const denied: string[] = [];

  // PubSub: always grant self scope, grant global/system based on request
  if (requested.pubsub) {
    const grantedScopes: Array<'self' | 'global' | 'system'> = ['self'];
    for (const scope of requested.pubsub.scopes) {
      if (scope === 'system' && !isBuiltin) {
        denied.push('pubsub.system');
      } else if (!grantedScopes.includes(scope)) {
        grantedScopes.push(scope);
      }
    }
    granted.pubsub = {
      scopes: grantedScopes,
      topics: requested.pubsub.topics,
    };
  }

  // Datastore: grant as requested (scoped to tile's tables)
  if (requested.datastore) {
    granted.datastore = {
      tables: requested.datastore.tables,
      createTables: requested.datastore.createTables,
    };
  }

  // Network: grant as requested (runtime enforces domain check)
  if (requested.network) {
    granted.network = {
      domains: requested.network.domains,
    };
  }

  // Window: grant as requested
  if (requested.window) {
    granted.window = { ...requested.window };
  }

  // Filesystem: deny for non-builtin (privileged)
  if (requested.filesystem) {
    if (isBuiltin) {
      granted.filesystem = { ...requested.filesystem };
    } else {
      denied.push('filesystem');
    }
  }

  // Commands: grant as requested
  if (requested.commands) {
    granted.commands = true;
  }

  // Shortcuts: grant as requested. Preserve object shape so strict IPC
  // handlers can read the `keys` allowlist (manifests may declare
  // `shortcuts: true` OR `shortcuts: { keys: [...] }`).
  if (requested.shortcuts) {
    if (requested.shortcuts === true) {
      granted.shortcuts = true;
    } else if (typeof requested.shortcuts === 'object') {
      granted.shortcuts = { ...requested.shortcuts };
    }
  }

  // Sync: builtin only
  if (requested.sync) {
    if (isBuiltin) {
      granted.sync = true;
    } else {
      denied.push('sync');
    }
  }

  // Theme: grant as requested
  if (requested.theme) {
    granted.theme = true;
  }

  // Settings: grant as requested
  if (requested.settings) {
    granted.settings = true;
  }

  return { tileId, capabilities: granted, denied };
}

// ─── V1 to V2 Conversion Helper ─────────────────────────────────────

/**
 * Convert a v1 extension manifest to v2 tile manifest format
 * This is used internally for the compatibility layer — doesn't modify files
 */
export function convertV1ToV2(v1: Record<string, unknown>): TileManifestV2 {
  const id = (v1.id || v1.shortname || 'unknown') as string;
  const name = (v1.name || id) as string;

  // Build tiles array from v1 background field
  const tiles: TileEntry[] = [];
  if (v1.background && typeof v1.background === 'string') {
    tiles.push({
      id: 'background',
      type: 'background',
      url: v1.background as string,
      lazy: v1.lazy === true,
    });
  }

  // Infer capabilities from v1 manifest
  const capabilities: TileCapabilities = {
    pubsub: { scopes: ['self', 'global'] },
    commands: Array.isArray(v1.commands) && v1.commands.length > 0,
    shortcuts: Array.isArray(v1.shortcuts) && v1.shortcuts.length > 0,
  };

  return {
    manifestVersion: 2,
    id,
    shortname: (v1.shortname as string) || undefined,
    name,
    description: v1.description as string | undefined,
    version: v1.version as string | undefined,
    builtin: v1.builtin as boolean | undefined,
    hidden: v1.hidden as boolean | undefined,
    tiles,
    capabilities,
    commands: v1.commands as TileCommand[] | undefined,
    shortcuts: v1.shortcuts as TileShortcut[] | undefined,
    settingsSchema: v1.settingsSchema as string | undefined,
  };
}
