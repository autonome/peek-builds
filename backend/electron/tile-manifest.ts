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
 * Window capability: can the tile create/manage windows.
 *
 * Strict `tile:window:*` handlers gate each operation on this grant:
 *   - `create` — required for `tile:window:open`.
 *   - `query` — required for `tile:window:list` / `tile:window:info`.
 *   - `manage` — required for `tile:window:close` (when closing a window
 *     the tile does not itself own).
 *   - `urls` — optional URL-prefix allowlist applied to `open`. When
 *     present, the target URL must start with one of the listed prefixes
 *     (exact string prefix match). Omitted = any peek:// URL allowed.
 *
 * The declared shape may be `true` or `WindowCapability`. `true` is
 * treated as `{ create: true, query: true, manage: true }` (unrestricted,
 * backward-compatible with pre-strict manifests).
 */
export interface WindowCapability {
  /** Can create new windows via `tile:window:open` */
  create?: boolean;
  /** Can list/inspect windows via `tile:window:list` / `tile:window:info` */
  query?: boolean;
  /** Can close/modify windows the tile does not own */
  manage?: boolean;
  /**
   * Optional URL-prefix allowlist for `open`. If present, the URL passed
   * to `tile:window:open` must start with one of these prefixes. Useful
   * for tiles that should only open their own UI (e.g. `['peek://my-tile/']`).
   */
  urls?: string[];
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
 * Context capability: access to the context-entry key/value store.
 *
 * Strict `tile:context:*` handlers gate each operation on the shape of
 * this grant:
 *   - `read` — key allowlist for `get` / `history`. If omitted, every
 *     key is readable (backward-compatible "unrestricted" mode).
 *   - `write` — key allowlist for `set`. If omitted, every key is
 *     writable.
 *   - `modes` — gates the `setMode` / `watchMode` future helpers and
 *     any write to the well-known `mode` key.
 *   - `queryWindows` — gates `windowsWithValue` / `windowsInSpace`.
 *
 * Like ShortcutsCapability, the capability may also be declared as
 * `true` in a manifest — treated as an empty object (unrestricted,
 * no window-query privileges).
 */
export interface ContextCapability {
  /** Keys the tile can read; omitted = all keys */
  read?: string[];
  /** Keys the tile can write; omitted = all keys */
  write?: string[];
  /** Allow mode management (setMode/watchMode + writing the `mode` key) */
  modes?: boolean;
  /** Allow windowsInSpace / windowsWithValue queries */
  queryWindows?: boolean;
}

/**
 * Dialogs capability: permission to show native save/open file dialogs.
 *
 * May be expressed in the manifest as:
 *   - `true` — tile may invoke any supported dialog type
 *   - `{ types: [...] }` — only the listed dialog types may be invoked
 *
 * Supported types (current surface): `'save'`, `'open'`. The strict
 * IPC handlers reject any invocation whose type is not in the list.
 * When `types` is omitted (or the capability is `true`), no per-type
 * filtering is applied.
 */
export type DialogType = 'save' | 'open';

export interface DialogsCapability {
  /** If present, only these dialog types can be shown */
  types?: DialogType[];
}

/**
 * Feature source types — see `FeatureSource['type']` in feature-registry.ts.
 * Exposed here so `FeaturesCapability` can declare a source allowlist
 * without pulling tile-manifest into a dependency on feature-registry.
 */
export type FeatureSourceType = 'builtin' | 'local' | 'atproto' | 'url' | 'dev';

/**
 * OAuth capability: permission to drive a browser-based OAuth loopback
 * flow. The handler opens a local HTTP server on 127.0.0.1 with an
 * OS-assigned port and waits for the provider to redirect to it.
 *
 * May be expressed in the manifest as:
 *   - `true` — tile may start a loopback for ANY provider
 *   - `{ providers: [...] }` — tile may only start a loopback when the
 *     advertised provider hint matches one of the listed strings. A
 *     single `'*'` entry grants blanket access (equivalent to `true`
 *     but keeps the object shape).
 *
 * The provider hint is optional on `start-loopback` — when the caller
 * doesn't pass one, the allowlist is NOT consulted (the capability's
 * presence is sufficient). Consuming tiles that care about per-provider
 * restrictions should always pass a hint.
 *
 * The `await-callback` op never carries a provider hint (it resolves a
 * pending flow by loopback port) and is therefore only gated on the
 * capability's presence.
 */
export interface OAuthCapability {
  /** If present, only these provider strings may be used with start-loopback */
  providers?: string[];
}

/**
 * Features capability: access to the feature registry — listing
 * installed features, reading metadata/history, and (for privileged
 * manager tiles) installing/enabling/disabling/removing features.
 *
 * Strict `tile:features:*` handlers gate each operation on the shape
 * of this grant:
 *   - `read` — allows list/get/history queries. Default `true` when
 *     the capability is declared without an explicit value.
 *   - `install` — allows installing new features from atproto/url
 *     sources. Gates `tile:features:install` and the resolve/preview
 *     helpers. Requires user approval at install time regardless.
 *   - `manage` — allows enabling, disabling, and removing features
 *     already in the registry.
 *   - `sources` — optional allowlist restricting which source types
 *     the tile can see/manage. When present, list results are filtered
 *     and get/enable/disable/remove are rejected for entries whose
 *     source type is not in the list. Omitted = all sources (except
 *     the main app's behaviour of hiding builtins from list, which
 *     continues to apply).
 *
 * Like ShortcutsCapability/ContextCapability/DialogsCapability, the
 * capability may also be declared as `true` in a manifest — treated as
 * an object with `read: true` only (no install/manage privileges).
 */
export interface FeaturesCapability {
  /** Allow listing features + reading metadata / history. Default `true`. */
  read?: boolean;
  /** Allow installing new features from registered sources. */
  install?: boolean;
  /** Allow enable / disable / remove of existing features. */
  manage?: boolean;
  /**
   * Optional allowlist of feature sources this tile may see or manage.
   * If omitted, all source types are permitted (subject to per-op
   * checks — e.g. builtin features cannot be removed).
   */
  sources?: FeatureSourceType[];
}

/**
 * Settings capability: permission to read / write the tile's own settings
 * namespace and (optionally) read OTHER tiles' settings keys.
 *
 * May be expressed in the manifest as:
 *   - `true` — read/write the tile's own settings; no cross-tile access.
 *   - `{ readForeign: ['ext-id', ...] }` — read/write own settings AND
 *     read (read-only) from the listed tiles' `feature_settings`
 *     namespaces. A single `'*'` entry grants blanket foreign-read
 *     access (intended for privileged builtins — external tiles SHOULD
 *     enumerate).
 *
 * Strict foreign-writes are NOT exposed. A tile can write only within
 * its own scope via `tile:settings:set`. Cross-tile writes happen today
 * through the legacy `feature-settings-set-key` channel which the tile
 * preload does not expose.
 *
 * Authors using the plain `settings: true` form who still need foreign
 * reads may add the top-level `settingsForeign` sibling array as a
 * fallback — the strict `tile:settings:get-foreign` handler consults
 * both shapes.
 */
export interface SettingsCapability {
  /**
   * Allowlist of other tile IDs whose `feature_settings` may be read
   * via `api.settings.getExtKey(extId, key)`. Omit to deny foreign
   * reads entirely; set to `['*']` for blanket access.
   */
  readForeign?: string[];
}

/**
 * All capabilities a tile can request
 */
export interface TileCapabilities {
  pubsub?: PubSubCapability;
  datastore?: DatastoreCapability;
  network?: NetworkCapability;
  window?: boolean | WindowCapability;
  filesystem?: FilesystemCapability;
  /** Can register commands in the command palette */
  commands?: boolean;
  /** Can register keyboard shortcuts */
  shortcuts?: boolean | ShortcutsCapability;
  /** Can access sync APIs */
  sync?: boolean;
  /** Can read/write theme settings */
  theme?: boolean;
  /** Can read/write user settings (own scope; foreign-read via readForeign) */
  settings?: boolean | SettingsCapability;
  /**
   * Fallback top-level allowlist for foreign-setting reads, usable when
   * `settings` is declared as the plain boolean `true`. Consulted by
   * `tile:settings:get-foreign` only when `settings.readForeign` is
   * absent from the grant. Prefer `settings: { readForeign: [...] }`.
   */
  settingsForeign?: string[];
  /** Can read/write application context (mode, spaces, user keys) */
  context?: boolean | ContextCapability;
  /** Can invoke native file dialogs (save/open) */
  dialogs?: boolean | DialogsCapability;
  /** Can drive an OAuth loopback server */
  oauth?: boolean | OAuthCapability;
  /** Can query / install / manage installed features */
  features?: boolean | FeaturesCapability;
  /**
   * Can invoke session-level operations (e.g. persisting per-space
   * window layouts). Minimal boolean capability for now — reserved for
   * future expansion to an object form with sub-flags.
   */
  session?: boolean;
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

    // Validate context capability shape — must be boolean or
    // { read?: string[]; write?: string[]; modes?: boolean; queryWindows?: boolean }
    if (caps.context !== undefined) {
      const cc = caps.context;
      if (typeof cc === 'boolean') {
        // valid
      } else if (cc && typeof cc === 'object') {
        const ccObj = cc as Record<string, unknown>;
        for (const listKey of ['read', 'write'] as const) {
          const v = ccObj[listKey];
          if (v !== undefined) {
            if (!Array.isArray(v)) {
              errors.push({ path: `capabilities.context.${listKey}`, message: `${listKey} must be an array of strings` });
            } else {
              for (let i = 0; i < v.length; i++) {
                const k = v[i];
                if (typeof k !== 'string' || k.length === 0) {
                  errors.push({ path: `capabilities.context.${listKey}[${i}]`, message: `${listKey} entries must be non-empty strings` });
                }
              }
            }
          }
        }
        for (const flagKey of ['modes', 'queryWindows'] as const) {
          if (ccObj[flagKey] !== undefined && typeof ccObj[flagKey] !== 'boolean') {
            errors.push({ path: `capabilities.context.${flagKey}`, message: `${flagKey} must be a boolean` });
          }
        }
      } else {
        errors.push({ path: 'capabilities.context', message: 'context must be boolean or { read?, write?, modes?, queryWindows? }' });
      }
    }

    // Validate window capability shape — must be boolean or
    // { create?, query?, manage?: boolean; urls?: string[] }
    if (caps.window !== undefined) {
      const wc = caps.window;
      if (typeof wc === 'boolean') {
        // valid
      } else if (wc && typeof wc === 'object') {
        const wcObj = wc as Record<string, unknown>;
        for (const flagKey of ['create', 'query', 'manage'] as const) {
          if (wcObj[flagKey] !== undefined && typeof wcObj[flagKey] !== 'boolean') {
            errors.push({ path: `capabilities.window.${flagKey}`, message: `${flagKey} must be a boolean` });
          }
        }
        if (wcObj.urls !== undefined) {
          if (!Array.isArray(wcObj.urls)) {
            errors.push({ path: 'capabilities.window.urls', message: 'urls must be an array of strings' });
          } else {
            for (let i = 0; i < wcObj.urls.length; i++) {
              const u = wcObj.urls[i];
              if (typeof u !== 'string' || u.length === 0) {
                errors.push({ path: `capabilities.window.urls[${i}]`, message: 'urls entries must be non-empty strings' });
              }
            }
          }
        }
      } else {
        errors.push({ path: 'capabilities.window', message: 'window must be boolean or { create?, query?, manage?, urls? }' });
      }
    }

    // Validate features capability shape — must be boolean or
    // { read?: boolean; install?: boolean; manage?: boolean;
    //   sources?: FeatureSourceType[] }
    if (caps.features !== undefined) {
      const fc = caps.features;
      if (typeof fc === 'boolean') {
        // valid
      } else if (fc && typeof fc === 'object') {
        const fcObj = fc as Record<string, unknown>;
        for (const flagKey of ['read', 'install', 'manage'] as const) {
          if (fcObj[flagKey] !== undefined && typeof fcObj[flagKey] !== 'boolean') {
            errors.push({ path: `capabilities.features.${flagKey}`, message: `${flagKey} must be a boolean` });
          }
        }
        if (fcObj.sources !== undefined) {
          if (!Array.isArray(fcObj.sources)) {
            errors.push({ path: 'capabilities.features.sources', message: 'sources must be an array of source type strings' });
          } else {
            const valid = new Set(['builtin', 'local', 'atproto', 'url', 'dev']);
            for (let i = 0; i < fcObj.sources.length; i++) {
              const s = fcObj.sources[i];
              if (typeof s !== 'string' || !valid.has(s)) {
                errors.push({ path: `capabilities.features.sources[${i}]`, message: 'sources entries must be one of: builtin, local, atproto, url, dev' });
              }
            }
          }
        }
      } else {
        errors.push({ path: 'capabilities.features', message: 'features must be boolean or { read?, install?, manage?, sources? }' });
      }
    }


    // Validate settings capability shape — must be boolean or { readForeign?: string[] }
    if (caps.settings !== undefined) {
      const ss = caps.settings;
      if (typeof ss === 'boolean') {
        // valid
      } else if (ss && typeof ss === 'object') {
        const ssObj = ss as Record<string, unknown>;
        if (ssObj.readForeign !== undefined) {
          if (!Array.isArray(ssObj.readForeign)) {
            errors.push({ path: 'capabilities.settings.readForeign', message: 'readForeign must be an array of strings' });
          } else {
            for (let i = 0; i < ssObj.readForeign.length; i++) {
              const k = ssObj.readForeign[i];
              if (typeof k !== 'string' || k.length === 0) {
                errors.push({ path: `capabilities.settings.readForeign[${i}]`, message: 'readForeign entries must be non-empty strings' });
              }
            }
          }
        }
      } else {
        errors.push({ path: 'capabilities.settings', message: 'settings must be boolean or { readForeign?: string[] }' });
      }
    }

    // Validate settingsForeign top-level fallback allowlist — optional
    // array of non-empty strings. Independent of settings shape so
    // authors using `settings: true` can still opt in to foreign reads.
    if (caps.settingsForeign !== undefined) {
      if (!Array.isArray(caps.settingsForeign)) {
        errors.push({ path: 'capabilities.settingsForeign', message: 'settingsForeign must be an array of strings' });
      } else {
        for (let i = 0; i < (caps.settingsForeign as unknown[]).length; i++) {
          const k = (caps.settingsForeign as unknown[])[i];
          if (typeof k !== 'string' || (k as string).length === 0) {
            errors.push({ path: `capabilities.settingsForeign[${i}]`, message: 'settingsForeign entries must be non-empty strings' });
          }
        }
      }
    }

    // Validate oauth capability shape — must be boolean or { providers?: string[] }
    if (caps.oauth !== undefined) {
      const oc = caps.oauth;
      if (typeof oc === 'boolean') {
        // valid
      } else if (oc && typeof oc === 'object') {
        const ocObj = oc as Record<string, unknown>;
        if (ocObj.providers !== undefined) {
          if (!Array.isArray(ocObj.providers)) {
            errors.push({ path: 'capabilities.oauth.providers', message: 'providers must be an array of strings' });
          } else {
            for (let i = 0; i < ocObj.providers.length; i++) {
              const p = ocObj.providers[i];
              if (typeof p !== 'string' || p.length === 0) {
                errors.push({ path: `capabilities.oauth.providers[${i}]`, message: 'providers entries must be non-empty strings' });
              }
            }
          }
        }
      } else {
        errors.push({ path: 'capabilities.oauth', message: 'oauth must be boolean or { providers?: string[] }' });
      }
    }

    // Validate session capability shape — boolean only for now.
    if (caps.session !== undefined && typeof caps.session !== 'boolean') {
      errors.push({ path: 'capabilities.session', message: 'session must be a boolean' });
    }

    // Validate dialogs capability shape — must be boolean or { types?: ('save'|'open')[] }
    if (caps.dialogs !== undefined) {
      const dc = caps.dialogs;
      if (typeof dc === 'boolean') {
        // valid
      } else if (dc && typeof dc === 'object') {
        const dcObj = dc as Record<string, unknown>;
        if (dcObj.types !== undefined) {
          if (!Array.isArray(dcObj.types)) {
            errors.push({ path: 'capabilities.dialogs.types', message: 'types must be an array of dialog type strings' });
          } else {
            const valid = new Set(['save', 'open']);
            for (let i = 0; i < dcObj.types.length; i++) {
              const t = dcObj.types[i];
              if (typeof t !== 'string' || !valid.has(t)) {
                errors.push({ path: `capabilities.dialogs.types[${i}]`, message: 'types entries must be one of: save, open' });
              }
            }
          }
        }
      } else {
        errors.push({ path: 'capabilities.dialogs', message: 'dialogs must be boolean or { types: string[] }' });
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

  // Window: preserve shape so strict IPC handlers can read the
  // create/query/manage flags and urls allowlist. Manifests may
  // declare `window: true` (treated as `{create, query, manage}` all
  // granted) OR an object form.
  if (requested.window) {
    if (requested.window === true) {
      granted.window = { create: true, query: true, manage: true };
    } else if (typeof requested.window === 'object') {
      granted.window = { ...requested.window };
    }
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

  // Settings: preserve object shape so the strict `tile:settings:get-foreign`
  // handler can read the `readForeign` allowlist. Manifests may declare
  // `settings: true` OR `settings: { readForeign: [...] }`.
  if (requested.settings) {
    if (requested.settings === true) {
      granted.settings = true;
    } else if (typeof requested.settings === 'object') {
      granted.settings = { ...requested.settings };
    }
  }

  // settingsForeign fallback allowlist — granted verbatim when present.
  // This piggybacks on the `settings` grant and is a no-op without it.
  if (Array.isArray(requested.settingsForeign) && requested.settingsForeign.length > 0) {
    granted.settingsForeign = [...requested.settingsForeign];
  }

  // OAuth: preserve object shape so the strict `tile:oauth:*` handlers
  // can read the `providers` allowlist. Manifests may declare
  // `oauth: true` OR `oauth: { providers: [...] }`.
  if (requested.oauth) {
    if (requested.oauth === true) {
      granted.oauth = true;
    } else if (typeof requested.oauth === 'object') {
      granted.oauth = { ...requested.oauth };
    }
  }

  // Context: preserve object shape so strict IPC handlers can read the
  // read/write allowlists and modes/queryWindows flags. Manifests may
  // declare `context: true` OR an object form.
  if (requested.context) {
    if (requested.context === true) {
      granted.context = true;
    } else if (typeof requested.context === 'object') {
      granted.context = { ...requested.context };
    }
  }

  // Dialogs: preserve object shape (types allowlist). Manifests may
  // declare `dialogs: true` OR `dialogs: { types: [...] }`.
  if (requested.dialogs) {
    if (requested.dialogs === true) {
      granted.dialogs = true;
    } else if (typeof requested.dialogs === 'object') {
      granted.dialogs = { ...requested.dialogs };
    }
  }

  // Features: preserve object shape (actions + sources allowlist).
  // Manifests may declare `features: true` OR an object form.
  if (requested.features) {
    if (requested.features === true) {
      granted.features = true;
    } else if (typeof requested.features === 'object') {
      granted.features = { ...requested.features };
    }
  }

  // Session: grant as requested (boolean-only for now).
  if (requested.session) {
    granted.session = true;
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
