/**
 * Type declarations for the `@peek/capabilities` package.
 *
 * `index.js` is plain JavaScript (no TypeScript compiler runs over it), so
 * these declarations are hand-written and must be kept in sync with it by
 * hand. `apps/desktop/main/tile-manifest.ts` re-exports this whole surface;
 * that re-export is how TypeScript consumers (`capability-compare.ts`,
 * `tile-manifest.test.ts`, and everything else under `apps/desktop/main`)
 * keep their existing `import { ... } from './tile-manifest.js'` working
 * unchanged.
 */

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
 * Automation capability: drive pages the tile opened itself.
 *
 * Grants `tile:automation:run` (navigate, wait for a selector, run a
 * script, click, print to PDF) against a window the tile opened through
 * `tile:window:open`, only while that window's page is on one of
 * `origins`. Any feature may request it; the origin list is the scope.
 */
export interface AutomationCapability {
  /**
   * Origins the tile may drive: `https://host`, `http://host:port`, or
   * `https://*.host` for any subdomain of host. No paths.
   */
  origins: string[];
  /**
   * May capture downloads started in those windows and receive them as
   * bytes instead of having them saved to the Downloads folder.
   */
  downloads?: boolean;
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
   * Allow `feature-update:*` admin ops (check-all / apply / set-policy).
   * Required for tiles that drive the update flow (features-manager).
   */
  update?: boolean;
  /**
   * Allow `feature-dev:*` admin ops (reload / validate / pick-directory /
   * create). Required for tiles that scaffold and iterate on dev features.
   */
  dev?: boolean;
  /**
   * Allow `feature-publish:*` admin ops (list-local / read-feature-files).
   * Required for tiles that publish features to AT Protocol.
   */
  publish?: boolean;
  /**
   * Allow `feature-devtools:open` to open DevTools on any installed tile.
   * Privileged observability affordance — only management UIs should
   * declare this.
   */
  devtools?: boolean;
  /**
   * Allow `feature-browse:list-by-publisher` to enumerate feature
   * records hosted on a publisher's PDS. Gated on `browse` (defaults
   * to the existing `read` action when omitted — see
   * `tile-features-enforcement.ts`).
   */
  browse?: boolean;
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
 * IZUI capability: access to the IZUI (mode/overlay/role) coordinator.
 *
 * IZUI is Peek's role-based overlay system. Tiles that participate in
 * overlay lifecycle (windows switcher, cmd panel, hud) need to read the
 * coordinator state and — for builtin UI surfaces — ask their own window
 * to close via `izui:close-self`.
 *
 * The capability is a simple boolean. Strict `tile:izui:*` handlers
 * mirror the legacy `izui-*` IPC channels (defined in `ipc.ts`) and
 * gate them all behind this single grant.
 *
 * Shape rationale: IZUI operations are tightly coupled and mostly
 * read-only; there is no natural privilege boundary that warrants
 * sub-caps. Any future split (e.g. `izui: { read, closeSelf }`) can be
 * layered on top of this without breaking manifests that declared
 * `izui: true`.
 */
export type IzuiCapability = boolean;

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
  /** Can query IZUI coordinator state / ask own window to close */
  izui?: IzuiCapability;
  /** Can register / unregister event-dispatch rules at runtime */
  rules?: boolean;
  /** Can drive pages it opened, on the listed origins */
  automation?: AutomationCapability;
  /** Can keep its own secrets (tokens, passwords), encrypted at rest */
  secrets?: boolean;
  /** Its own windows may embed <webview> elements (builtin features only) */
  webview?: boolean;
  /**
   * Can read app-wide telemetry: memory totals across every Peek process
   * (`api.app.metrics()`) and pubsub message counts (`api.pubsub.stats()`).
   * Read-only counters; nothing about their contents.
   */
  diagnostics?: boolean;
}

// ─── Tile Definition Types ───────────────────────────────────────────

/** One schedule on a tile entry: publish `topic` every `everyMinutes`. */
export interface TileScheduleEntry {
  /** Pubsub topic published when the schedule comes due. */
  topic: string;
  /** Interval in whole minutes, minimum 1. */
  everyMinutes: number;
}

/**
 * A tile entry point — each tile in the manifest creates one context.
 *
 * Window properties are flat on this interface; there is no nested hints
 * object. Residency is declared via `resident: true` (loaded at startup
 * and kept live) — there is no `type` field.
 */
export interface TileEntry {
  /** Tile entry ID (unique within the manifest) */
  id: string;
  /** HTML file to load (relative to extension directory) */
  url: string;
  /**
   * If true, this tile is loaded at startup and kept live for the session.
   * If false/absent, the tile is loaded lazily on first use.
   */
  resident?: boolean;
  // ── Flat window properties ────────────────────────────────────────────
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  alwaysOnTop?: boolean;
  transparent?: boolean;
  focusable?: boolean;
  frame?: boolean;
  resizable?: boolean;
  /**
   * If true, this window is a card-grid view that supports the see-through
   * switch: `see-through view` may flip it between its normal look and the
   * frosted one. This declaration is how main knows which
   * windows the switch applies to — there is no list of URLs anywhere else.
   * A window that declares it must also be created transparent, since
   * transparency can only be set when a window is created.
   *
   * The declaration is also what the app-wide switch
   * (`see-through views everywhere`) acts on: it flips every open window
   * that declares it, and a declaring window opened while the switch is on
   * opens see-through.
   */
  seeThrough?: boolean;
  /** Window role for the IZUI system */
  role?: string;
  /** Unique key for window deduplication */
  key?: string;
  title?: string;
  /** If true, this tile is loaded lazily on first use */
  lazy?: boolean;
  /**
   * Pubsub topics that trigger lazy loading of this tile when published.
   * Used when another feature publishes an event (e.g. `editor:open`) that
   * this tile needs to handle, but this tile hasn't been loaded yet.
   * Only meaningful when `lazy: true`.
   */
  lazyEvents?: string[];
  /**
   * `"never"` keeps this tile loaded once it has been woken, however long it is idle. For a tile
   * whose job is to be running (or whose renderer holds state that cannot be rebuilt). Only
   * meaningful when `lazy: true`; use `api.tile.hold()` for a bounded stretch instead.
   */
  suspend?: 'never';
  /**
   * Schedules that make this tile run unattended. Each entry names a pubsub
   * topic and how often it comes due; when it does, main publishes the topic,
   * which loads the tile if it is asleep and reaches its handler if it is
   * already awake. The interval is fixed by the manifest. An entry that has
   * never fired, or whose last run is more than one interval old, is due at
   * startup and fires ONCE — never once per interval missed while the app was
   * closed. Only meaningful when `lazy: true`.
   */
  schedule?: TileScheduleEntry[];
  /**
   * If true, the BrowserWindow's `close` event is intercepted and the window
   * is hidden instead of destroyed. State (DOM, JS heap, registered commands,
   * pubsub subscriptions) is preserved so the next show is instant. Pairs
   * naturally with `resident: true` for tiles whose UI gets opened/closed
   * repeatedly (e.g. lists, websearch). Without this, closing a resident
   * tile via cmd+W destroys it, and any later `showSelf()` from a command
   * handler fails silently.
   */
  keepLive?: boolean;
}

/**
 * Command definition in tile manifest
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
 * Noun declared in a tile manifest — the static twin of the tile renderer's
 * `registerNoun` call (`renderer/cmd/nouns.js`). For a lazy tile, main
 * announces it at boot so the commands it generates (`new <singular>`,
 * `list <name>`, `open <singular>`, ...) are listed before the tile runs, and
 * a `noun:<capability>:<name>` dispatch wakes the tile.
 */
export interface TileNoun {
  /** Plural name, e.g. `groups`. Must match the renderer's `registerNoun` name. */
  name: string;
  /** Singular name, e.g. `group`. */
  singular: string;
  description?: string;
  /** Capabilities the renderer registers handlers for. */
  capabilities: Array<'query' | 'browse' | 'open' | 'create'>;
  /** MIME type the query capability produces. */
  produces?: string;
  /** If true, no bare `<name>` command is generated. */
  skipBare?: boolean;
}

/**
 * Shortcut definition in tile manifest.
 *
 * A manifest shortcut binds an accelerator (`keys`) to a WAKE TARGET,
 * declared in one of two additive forms:
 *
 *   - Command form (original): `{ keys, command }` — pressing the key
 *     publishes `cmd:execute:<command>`, which the lazy-load dispatch
 *     hook routes into waking the owning tile. Used by windows.
 *   - Topic form: `{ keys, wakeTopic, wakeArgs? }` — pressing the key
 *     publishes `wakeTopic` directly with `{ args: wakeArgs }`. Lets a
 *     feature declare a static default hotkey that wakes it via its own
 *     event topic rather than a command.
 *
 * Exactly one of `command` / `wakeTopic` should be present. These
 * manifest entries are the DEFAULTS used when the tile has no persisted
 * `lazy_wake_shortcuts` rows (see feature-shortcut-registrar.ts).
 */
export interface TileShortcut {
  keys: string;
  /** Command form: publishes `cmd:execute:<command>`. */
  command?: string;
  /** Topic form: publishes this topic directly. */
  wakeTopic?: string;
  /** Arguments for the topic form (ignored by the command form). */
  wakeArgs?: unknown[];
  global?: boolean;
  mode?: string;
}

/**
 * Manifest-declared rule. Persisted into the `rules` table by
 * feature-startup with `source: 'manifest'` and an id derived by
 * content-hashing this object — see rules.ts:computeManifestRuleId.
 *
 * Stage 1 (peek MCP plan 3d7d9239) defines the storage shape; Stage 2
 * adds the dispatcher and the predicate language for `match`.
 */
export interface TileRule {
  /** Event topic this rule listens for. Trailing wildcard supported. */
  topic: string;
  /** Script to execute when the predicate matches. */
  scriptId: string;
  /** JSON predicate evaluated against the event payload. Stage 2 spec. */
  match?: Record<string, unknown>;
  /** Config object passed to the script alongside the event. */
  config?: Record<string, unknown>;
  /** UI affordance hints. Empty / null = compute-only rule. */
  display?: { icon?: string; checkedIcon?: string; color?: string; checkedColor?: string; label?: string } | null;
  /** Defaults to true. Lets users disable a rule without deleting it. */
  enabled?: boolean;
  /** Tiebreaker when multiple rules match the same event. */
  ordering?: number;
}

// ─── Manifest Types ──────────────────────────────────────────────────

/**
 * Tile Manifest format. Current schema version is 3; legacy `type` and
 * `windowHints` compat fields are no longer accepted by the validator.
 */
export interface TileManifest {
  /** Manifest version — must be 3 for tile manifests */
  manifestVersion: 3;
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
  /** Nouns the tile registers at runtime, declared so a lazy tile's noun commands are listed before it wakes */
  nouns?: TileNoun[];
  /** Keyboard shortcuts */
  shortcuts?: TileShortcut[];
  /**
   * If true, this tile's REAL global wake hotkeys are DERIVED FROM USER
   * SETTINGS by its renderer (via `declareWakeShortcuts`) — the static
   * `shortcuts[]` above are only fresh-profile bootstrap defaults. On a
   * MIGRATED profile (saved `feature_settings` present but the tile has
   * never declared its wake set, e.g. settings predating the lazy-wake
   * system), main wakes the tile once at boot so it can declare; otherwise
   * a user whose configured hotkey prefix differs from the static default
   * has NO working hotkeys until they happen to press the default. Self-
   * heals: `declareWakeShortcuts` sets the declared marker, so later boots
   * skip the wake and stay lazy. See `wakeDeclarationBackfillNeeded` in
   * feature-shortcut-registrar.ts. Tiles with static (non-settings) hotkeys
   * (e.g. windows) MUST omit this — they never declare, so waking them
   * would re-fire every boot.
   */
  wakeShortcutsFromSettings?: boolean;
  /** Event-dispatch rules contributed by this feature. */
  rules?: TileRule[];
  /**
   * The Web Tiles protocols this tile imports, each mapped to how the tile
   * depends on it. A `required` protocol the host does not provide — because
   * no such protocol is registered, or because the tile lacks the capability
   * that gates it — stops the tile being opened at all, rather than letting
   * it fail partway. An `optional` one never blocks opening; the tile imports
   * it in a `try`.
   *
   *   "protocols": { "atproto": "required", "data": "optional" }
   */
  protocols?: Record<string, 'required' | 'optional'>;
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
export type ManifestVersion = 'legacy' | 'tile';

/**
 * Parsed manifest result — either legacy or current tile manifest
 */
export interface ParsedManifest {
  version: ManifestVersion;
  /** Original raw JSON */
  raw: Record<string, unknown>;
  /** Only set if version is 'tile' */
  manifest?: TileManifest;
}

// ─── Capability Grant ────────────────────────────────────────────────

/**
 * A resolved capability grant — what the runtime actually gives the tile.
 *
 * When `trustedBuiltin` is true, capability checks are expected to
 * short-circuit to "allowed" at every enforcement site. This is reserved
 * for CORE renderers bundled with the app (cmd, hud, page, and test
 * fixtures) — NOT for external feature tiles. See
 * `createTrustedBuiltinGrant` and the bypass calls in the `check*Allowed`
 * pure modules + inline checks in `tile-ipc.ts`.
 *
 * Name rationale: "core" is too vague, "system" is overloaded (pubsub
 * already has a `system` scope), "privileged" is too generic. The
 * explicit phrase `trustedBuiltin` makes the intent unmistakable in
 * code review — every grep hit is a known bypass site.
 */
export interface CapabilityGrant {
  tileId: string;
  /** Granted capabilities (may be a subset of requested) */
  capabilities: TileCapabilities;
  /** Capabilities that were requested but denied */
  denied: string[];
  /**
   * If true, every capability check at runtime returns `ok` without
   * consulting the granted capabilities. Reserved for bundled core
   * renderers. Default: omitted/false.
   */
  trustedBuiltin?: boolean;
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validation errors collected during parsing
 */
export interface ValidationError {
  path: string;
  message: string;
}

// ─── Functions ───────────────────────────────────────────────────────

/**
 * Detect whether a manifest JSON is legacy or a current tile manifest.
 * See `index.js` for the full decision rationale.
 */
export function detectManifestVersion(json: Record<string, unknown>): ManifestVersion;

/**
 * Validate a tile manifest. Returns array of errors (empty = valid).
 */
export function validateTileManifest(json: Record<string, unknown>): ValidationError[];

/**
 * Parse a manifest from a raw JSON object (for testing). Returns null if
 * the manifest fails validation.
 */
export function parseManifestJSON(json: Record<string, unknown>): ParsedManifest | null;

/**
 * Resolve capability grants for a tile. Takes the requested capabilities
 * from the manifest and determines what to actually grant.
 */
export function resolveCapabilities(
  tileId: string,
  requested: TileCapabilities,
  isBuiltin: boolean
): CapabilityGrant;

/**
 * Build a capability grant that short-circuits every check with "allowed".
 * See `index.js` for the full rationale and the bypass contract.
 */
export function createTrustedBuiltinGrant(rendererId: string): CapabilityGrant;
