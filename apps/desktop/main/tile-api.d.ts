/**
 * Tile API Surface Typings — window.app
 *
 * Static hand-written .d.ts for the `window.app` surface injected by
 * `apps/desktop/main/tile-preload.cts` via `contextBridge.exposeInMainWorld`.
 *
 * Keep this file in sync with:
 *   - apps/desktop/main/tile-preload.cts  (implementation)
 *   - apps/desktop/main/tile-ipc.ts       (main-process handlers)
 *   - docs/tile-api.md                    (reference documentation)
 *
 * This file does NOT auto-generate — update manually when tile-preload.cts or
 * tile-ipc.ts adds/removes surfaces.
 *
 * Usage in a tile:
 *   /// <reference path="../../apps/desktop/main/tile-api.d.ts" />
 *   // or place in tsconfig.json "typeRoots" / "types" array
 */

// ─── PubSub ──────────────────────────────────────────────────────────

interface TilePubSub {
  /**
   * Publish a message to a topic.
   * Requires `pubsub` capability.
   * @param topic   Event topic string
   * @param data    Payload (any serialisable value)
   */
  publish(topic: string, data: unknown): void;

  /**
   * Subscribe to a topic.
   * Requires `pubsub` capability.
   * @returns Unsubscribe function
   */
  subscribe(topic: string, callback: (data: unknown) => void): () => void;
}

// ─── Commands ────────────────────────────────────────────────────────

interface TileCommandDefinition {
  name: string;
  description?: string;
  execute: (params: unknown) => unknown;
  scope?: string;
  modes?: string[];
  accepts?: unknown;
  produces?: unknown;
  params?: unknown;
}

interface TileCommands {
  /**
   * Register a command handler (minimal form).
   * Requires `commands` capability.
   */
  register(name: string, handler: (params: unknown) => unknown): void;

  /**
   * Register a command handler (full v1-compatible form).
   * Requires `commands` capability.
   */
  register(definition: TileCommandDefinition): void;

  /**
   * Unregister a command.
   * Requires `commands` capability.
   */
  unregister(name: string): void;
}

// ─── Window ──────────────────────────────────────────────────────────

interface TileWindowInfo {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  focused: boolean;
  visible: boolean;
}

interface TileWindowEntry {
  id: number;
  url: string;
  focused: boolean;
  visible: boolean;
}

interface TileWindowListResult {
  success: boolean;
  windows?: TileWindowEntry[];
  error?: string;
}

interface TileWindow {
  /**
   * Open a new window at a peek:// URL.
   * Requires `window.create` capability.
   */
  open(url: string, options?: Record<string, unknown>): Promise<{ success?: boolean; windowId?: number; error?: string }>;

  /**
   * Close a window. Omit id to close the calling tile's window.
   * Requires `window.manage` (or self-close with any window capability).
   */
  close(id?: number): void;

  /**
   * Get info about the calling tile's window.
   * Requires `window.query` capability.
   */
  getInfo(): Promise<TileWindowInfo | { error: string }>;

  /**
   * List all open windows.
   * Requires `window.query` capability.
   */
  list(): Promise<TileWindowListResult>;

  /**
   * Check if a window with the given id is open.
   * Requires `window.manage` capability.
   */
  exists(id: number): Promise<{ exists: boolean; success: boolean; data: boolean; error?: string }>;

  /**
   * Show a hidden window.
   * Requires `window.manage` capability.
   */
  show(id: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Hide a visible window.
   * Requires `window.manage` capability.
   */
  hide(id: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Raise a window to the front.
   * Requires `window.manage` capability.
   * No-op under headless test runs.
   */
  focus(id: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Center a window on its display. Omit id for calling window.
   * Requires `window.manage` capability.
   */
  center(id?: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Center all visible windows.
   * Requires `window.manage` capability.
   */
  centerAll(): Promise<{ success: boolean; error?: string }>;

  /**
   * Toggle maximize on a window. Omit id for calling window.
   * Requires `window.manage` capability.
   */
  maximize(id?: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Toggle fullscreen on a window. Omit id for calling window.
   * Requires `window.manage` capability.
   */
  fullscreen(id?: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Set whether a window ignores mouse events (click-through).
   * Requires `window.manage` capability.
   */
  setIgnoreMouseEvents(id: number | undefined, ignore: boolean, opts?: { forward?: boolean }): Promise<{ success: boolean; error?: string }>;

  /**
   * Pin or unpin a window across macOS Spaces.
   * Requires `window.manage` capability.
   */
  setVisibleOnAllWorkspaces(id: number | undefined, visible: boolean, opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): Promise<{ success: boolean; error?: string }>;

  /**
   * Get the id of the last-focused visible window, or null if none is
   * tracked. The preload wrapper unwraps the underlying IPC envelope, so
   * callers receive the bare id (or null) — not a `{success, windowId}`
   * object. Requires `window.query` capability.
   */
  getFocusedVisibleWindowId(): Promise<number | null>;

  /**
   * Set the overlay focus target for the calling tile's window.
   * Requires `window.manage` capability.
   */
  setOverlayFocusTarget(targetWindowId: number): Promise<{ success: boolean; error?: string }>;

  /**
   * Show this tile's own window.
   *
   * No `window` capability required. The tile's token is the authority —
   * it can only affect the window it runs in. Primary mechanism for tiles
   * that start hidden at boot (resident: true) and reveal on command.
   */
  showSelf(): Promise<{ success: boolean; error?: string }>;

  /**
   * Hide this tile's own window.
   *
   * Hides without destroying — all state (DOM, JS heap, registered commands)
   * is preserved and the window can be shown again cheaply via showSelf().
   * Use for "dismiss" UX where re-opening should be instant.
   *
   * No `window` capability required. The tile's token is the authority.
   */
  hideSelf(): Promise<{ success: boolean; error?: string }>;
}

// ─── Datastore ───────────────────────────────────────────────────────

type DatastoreTableName = 'items' | 'tags' | 'item_tags' | 'item_events';

interface TileDatastoreResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface TileDatastore {
  // Generic row/table operations
  get(table: DatastoreTableName, key: string): Promise<TileDatastoreResult>;
  set(table: DatastoreTableName, key: string, value: unknown): Promise<TileDatastoreResult>;
  query(table: DatastoreTableName, filter?: Record<string, unknown>): Promise<{ success: boolean; rows?: unknown[]; error?: string }>;
  getTable(table: DatastoreTableName): Promise<TileDatastoreResult<Record<string, unknown>>>;
  getRow(table: DatastoreTableName, rowId: string): Promise<TileDatastoreResult>;
  setRow(table: DatastoreTableName, rowId: string, rowData: Record<string, unknown>): Promise<TileDatastoreResult>;

  // Item operations (require 'items' table grant)
  addItem(type: string, options?: Record<string, unknown>): Promise<TileDatastoreResult>;
  getItem(id: string): Promise<TileDatastoreResult>;
  /** Find a URL item by canonical (normalized) URL match. Returns null when no item exists. */
  findUrlItem(url: string): Promise<TileDatastoreResult>;
  updateItem(id: string, options: Record<string, unknown>): Promise<TileDatastoreResult>;
  deleteItem(id: string): Promise<TileDatastoreResult>;
  queryItems(filter?: Record<string, unknown>): Promise<TileDatastoreResult<unknown[]>>;

  // Tag operations (require 'tags' table grant)
  getOrCreateTag(name: string): Promise<TileDatastoreResult>;
  getTagsByFrecency(domain?: string): Promise<TileDatastoreResult<unknown[]>>;

  // Item-tag link operations (require 'tags' + 'item_tags' grant)
  tagItem(itemId: string, tagId: string): Promise<TileDatastoreResult>;
  untagItem(itemId: string, tagId: string): Promise<TileDatastoreResult>;
  getItemTags(itemId: string): Promise<TileDatastoreResult<unknown[]>>;
  getAllItemTags(): Promise<TileDatastoreResult<unknown>>;

  // Requires 'items' + 'item_tags' grant
  getItemsByTag(tagId: string): Promise<TileDatastoreResult<unknown[]>>;

  // Item event operations (require 'item_events' table grant)
  addItemEvent(itemId: string, options?: Record<string, unknown>): Promise<TileDatastoreResult>;
  getItemEvent(eventId: string): Promise<TileDatastoreResult>;
  queryItemEvents(filter?: Record<string, unknown>): Promise<TileDatastoreResult<unknown[]>>;
  getLatestItemEvent(itemId: string): Promise<TileDatastoreResult>;
  countItemEvents(itemId: string, filter?: { since?: number; until?: number }): Promise<TileDatastoreResult<number>>;
  deleteItemEvent(eventId: string): Promise<TileDatastoreResult>;
  deleteItemEvents(itemId: string): Promise<TileDatastoreResult>;

  /**
   * Extract DOM content from a live webContents (by URL).
   * Requires `datastore` capability.
   */
  extractPageContent(url: string): Promise<TileDatastoreResult<string>>;
}

// ─── Settings ────────────────────────────────────────────────────────

interface TileSettings {
  /**
   * Get a setting value for this tile.
   * Requires `settings` capability.
   */
  get(key: string): Promise<{ success: boolean; value?: unknown; error?: string }>;

  /**
   * Set a setting value for this tile.
   * Requires `settings` capability.
   */
  set(key: string, value: unknown): Promise<{ success: boolean; error?: string }>;

  /**
   * Read a setting from another tile.
   * Requires `settings.readForeign` capability listing the target tile id.
   */
  getExtKey(foreignExtId: string, key: string): Promise<{ success: boolean; value?: unknown; error?: string }>;

  /**
   * Alias for getExtKey (deprecated name).
   * @deprecated Use getExtKey.
   */
  getForeign(foreignExtId: string, key: string): Promise<{ success: boolean; value?: unknown; error?: string }>;
}

// ─── Shortcuts ───────────────────────────────────────────────────────

interface TileShortcutOptions {
  global?: boolean;
  mode?: string;
}

interface TileShortcuts {
  /**
   * Register a keyboard shortcut.
   * Requires `shortcuts` capability (optionally with a `keys` allowlist).
   */
  register(shortcut: string, callback: () => void, options?: TileShortcutOptions): void;

  /**
   * Unregister a keyboard shortcut.
   * Requires `shortcuts` capability.
   */
  unregister(shortcut: string, options?: TileShortcutOptions): void;
}

// ─── Rules (event-dispatch registry, Stage 1) ────────────────────────

interface TileRule {
  id: string;
  featureId: string;
  topic: string;
  match: Record<string, unknown>;
  scriptId: string;
  config: Record<string, unknown>;
  display: Record<string, unknown> | null;
  enabled: boolean;
  source: 'manifest' | 'user' | 'runtime';
  ordering: number;
  createdAt: number;
  updatedAt: number;
}

interface TileRulesRegisterArgs {
  /** Optional caller-supplied id suffix. The persisted id is prefixed
   *  with `rule_<featureId>_` so two features can share the same suffix
   *  without colliding. If absent, a random suffix is generated. */
  id?: string;
  topic: string;
  scriptId: string;
  match?: Record<string, unknown>;
  config?: Record<string, unknown>;
  display?: Record<string, unknown> | null;
  enabled?: boolean;
  ordering?: number;
}

interface TileRules {
  /**
   * List rules owned by the calling feature.
   * Requires `rules` capability.
   */
  list(options?: { topic?: string; enabled?: boolean }): Promise<{ rules: TileRule[]; error?: string }>;

  /**
   * List every enabled rule with a non-empty `display` block, across
   * all features. Used by shared card UIs to render affordances
   * declared by any feature. Requires `rules` capability.
   */
  listAffordances(): Promise<{ rules: TileRule[]; error?: string }>;

  /**
   * Register a runtime rule for the calling feature. Idempotent when
   * the same `id` suffix is supplied — a re-register replaces the
   * previous row in place. Returns the persisted rule.
   * Requires `rules` capability.
   */
  register(rule: TileRulesRegisterArgs): Promise<{ rule?: TileRule; error?: string }>;

  /**
   * Unregister a runtime rule by id. Only own-feature, source='runtime'
   * rows are deletable — manifest-declared rules are managed by the
   * install pipeline.
   * Requires `rules` capability.
   */
  unregister(id: string): Promise<{ ok: boolean; error?: string }>;
}

// ─── Context ─────────────────────────────────────────────────────────

interface TileContextEntry {
  id: number;
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  windowId: number | null;
  source: string;
  timestamp: number;
}

interface TileContext {
  /**
   * Read a context value.
   * Requires `context.read` allowlist to include the key (or context: true).
   */
  get(key: string, windowId?: number | null): Promise<{ success: boolean; data?: TileContextEntry | null; error?: string }>;

  /**
   * Write a context value.
   * Requires `context.write` allowlist to include the key (or context: true).
   */
  set(key: string, value: unknown, metadata?: Record<string, unknown>, windowId?: number | null): Promise<{ success: boolean; data?: TileContextEntry; error?: string }>;

  /**
   * Read context history for a key.
   * Requires `context.read` capability.
   */
  history(key?: string, options?: {
    windowId?: number | null;
    since?: number;
    until?: number;
    limit?: number;
    order?: 'asc' | 'desc';
  }): Promise<{ success: boolean; data?: TileContextEntry[]; error?: string }>;

  /**
   * Get a full context snapshot.
   * Requires any `context` capability.
   */
  snapshot(options?: { timestamp?: number; keys?: string[] }): Promise<{ success: boolean; data?: unknown; error?: string }>;

  /**
   * Get window ids that have a matching context value.
   * Requires `context.queryWindows: true`.
   */
  windowsWithValue(key: string, value: unknown): Promise<{ success: boolean; data?: number[]; error?: string }>;

  /**
   * Get window ids in a space.
   * Requires `context.queryWindows: true`.
   */
  windowsInSpace(spaceId: string): Promise<{ success: boolean; data?: number[]; error?: string }>;
}

// ─── Filesystem ──────────────────────────────────────────────────────

interface TileFilesystem {
  /**
   * Read a file from disk.
   * Requires `filesystem.read` capability with the path in the allowlist.
   */
  read(path: string): Promise<{ success: boolean; data?: string; error?: string }>;

  /**
   * Write a file to disk.
   * Requires `filesystem.write` capability with the path in the allowlist.
   */
  write(path: string, content: string): Promise<{ success: boolean; error?: string }>;
}

// ─── Dialogs ─────────────────────────────────────────────────────────

interface TileDialogs {
  /**
   * Show a save dialog.
   * Requires `dialogs` capability (optionally with `types: ['save']`).
   */
  save(content: string, options?: { filename?: string; mimeType?: string }): Promise<{ success: boolean; filePath?: string; error?: string }>;

  /**
   * Show an open dialog.
   * Requires `dialogs` capability (optionally with `types: ['open']`).
   */
  open(): Promise<{ success: boolean; filePath?: string; content?: string; error?: string }>;
}

// ─── Network ─────────────────────────────────────────────────────────

interface TileNetwork {
  /**
   * Domain-gated HTTP fetch.
   * Requires `network.domains` allowlist to include the request domain.
   */
  fetch(url: string, options?: Record<string, unknown>): Promise<{ data?: unknown; error?: string }>;
}

// ─── Features ────────────────────────────────────────────────────────

interface TileFeatureEntry {
  id: string;
  name: string;
  version?: string;
  sourceType: string;
  description?: string;
  enabled?: boolean;
}

interface TileFeatures {
  /** List installed features. Requires `features.read`. */
  list(options?: { sourceType?: string }): Promise<{ entries?: TileFeatureEntry[]; error?: string }>;
  /** Get a feature by id. Requires `features.read`. */
  get(id: string): Promise<{ entry?: TileFeatureEntry; error?: string }>;
  /** Get install/update history. Requires `features.read`. */
  history(options?: { featureId?: string; limit?: number }): Promise<{ entries?: unknown[]; error?: string }>;
  /** Enable a feature. Requires `features.manage`. */
  enable(id: string, options?: { tilePreloadPath?: string }): Promise<{ success?: boolean; error?: string }>;
  /** Disable a feature. Requires `features.manage`. */
  disable(id: string): Promise<{ success?: boolean; error?: string }>;
  /** Remove a feature. Requires `features.manage`. */
  remove(id: string): Promise<{ success?: boolean; error?: string }>;
  /** Resolve install metadata from atproto source. Requires `features.install` + atproto source. */
  installResolve(atUri: string): Promise<{ manifest?: unknown; source?: unknown; error?: string }>;
  /** Preview capability grant for a manifest. Requires `features.install`. */
  previewCapabilities(featureId: string, manifestCapabilities: unknown): Promise<{ granted?: unknown; denied?: string[]; error?: string }>;
  /** Install a feature from atproto. Requires `features.install` + atproto source. */
  install(atUri: string, userApproved: boolean): Promise<{ success?: boolean; featureId?: string; error?: string }>;
  /** Resolve publisher handle/DID. Requires `features.install` + atproto source. */
  resolvePublisher(query: string): Promise<{ did?: string; handle?: string; error?: string }>;
  /** Check all features for updates. Requires `features.update`. */
  updateCheckAll(): Promise<{ updates?: unknown[]; error?: string }>;
  /** Apply an update. Requires `features.update` + atproto source. */
  updateApply(id: string, atUri: string, options?: { userApproved?: boolean }): Promise<{ success?: boolean; error?: string }>;
  /** Set update policy. Requires `features.update`. */
  updateSetPolicy(id: string, policy: 'auto' | 'notify' | 'pinned'): Promise<{ success?: boolean; error?: string }>;
  /** Reload a dev feature. Requires `features.dev`. */
  devReload(featureId: string): Promise<{ success?: boolean; error?: string }>;
  /** Validate a dev feature. Requires `features.dev`. */
  devValidate(featureId: string): Promise<{ valid?: boolean; errors?: string[]; error?: string }>;
  /** Show directory picker for new feature. Requires `features.dev`. */
  devPickDirectory(): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  /** Create a new dev feature. Requires `features.dev`. */
  devCreate(featureId: string, name: string, dir: string): Promise<{ success?: boolean; path?: string; error?: string }>;
  /** Open DevTools for a feature window. Requires `features.devtools`. */
  devtoolsOpen(featureId: string, entryId?: string): Promise<{ success?: boolean; error?: string }>;
  /** List local publishable features. Requires `features.publish`. */
  publishListLocal(): Promise<{ features?: TileFeatureEntry[]; error?: string }>;
  /** Read feature files for publishing. Requires `features.publish`. */
  publishReadFeatureFiles(featureId: string): Promise<{ featureId?: string; name?: string; files?: unknown[]; error?: string }>;
  /** List features by publisher DID. Requires `features.browse` + atproto source. */
  browseListByPublisher(did: string, pdsUrl: string): Promise<{ features?: unknown[]; error?: string }>;
}

// ─── OAuth ───────────────────────────────────────────────────────────

interface TileOAuth {
  /**
   * Start a loopback OAuth server.
   * Requires `oauth` capability.
   */
  startLoopback(options?: { provider?: string; callbackPath?: string; timeoutMs?: number }): Promise<{ success: boolean; port?: number; error?: string }>;

  /**
   * Await the OAuth callback on the given port.
   * Requires `oauth` capability.
   */
  awaitCallback(port: number): Promise<{ success: boolean; params?: Record<string, string>; error?: string }>;
}

// ─── Sync ────────────────────────────────────────────────────────────

interface TileSync {
  /**
   * Trigger a full sync. Requires `sync` capability (builtin tiles only).
   */
  syncAll(): Promise<{ success: boolean; pushed?: number; pulled?: number; error?: string }>;

  /** Read sync configuration. Used by Settings (trustedBuiltin only in practice). */
  getConfig(): Promise<{ success: boolean; config?: unknown; error?: string }>;

  /** Update sync configuration. */
  setConfig(config: unknown): Promise<{ success: boolean; error?: string }>;

  /** Read live sync status. */
  getStatus(): Promise<{ success: boolean; status?: unknown; error?: string }>;

  /** Pull from server. */
  pull(options?: unknown): Promise<{ success: boolean; pulled?: number; error?: string }>;

  /** Push to server. */
  push(options?: unknown): Promise<{ success: boolean; pushed?: number; error?: string }>;
}

// ─── IZUI ────────────────────────────────────────────────────────────

interface TileIzui {
  /** Returns whether this window is transient. Requires `izui` capability. */
  isTransient(): Promise<{ transient?: boolean; error?: string }>;
  /** Get the effective IZUI mode. Requires `izui` capability. */
  getEffectiveMode(): Promise<{ mode?: string; error?: string }>;
  /** Get IZUI state object. Requires `izui` capability. */
  getState(): Promise<{ state?: unknown; error?: string }>;
  /** Get pre-overlay focus target. Requires `izui` capability. */
  getPreOverlayFocusTarget(): Promise<{ target?: number | null; error?: string }>;
  /** Close this overlay window. Requires `izui` capability. */
  closeSelf(): Promise<{ success: boolean; error?: string }>;
}

// ─── Session ─────────────────────────────────────────────────────────

interface TileSession {
  /**
   * Persist space window layouts.
   * Requires `session` capability.
   */
  saveSpaceWorkspaces(): Promise<{ success: boolean; error?: string }>;
  /** Save the full session. Requires trustedBuiltin. */
  save(): Promise<{ success: boolean; error?: string }>;
  /** Restore the saved session interactively. Requires trustedBuiltin. */
  restoreInteractive(): Promise<{ success: boolean; error?: string }>;
  /** Reopen the most recently closed window. Requires trustedBuiltin. */
  reopenLastClosed(): Promise<{ success: boolean; error?: string }>;
}

// ─── Screen ──────────────────────────────────────────────────────────

interface TileDisplayInfo {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

interface TileScreen {
  /** Get primary display info. Always available (no capability required). */
  getPrimaryDisplay(): Promise<TileDisplayInfo | null>;
}

// ─── Escape ──────────────────────────────────────────────────────────

interface TileEscapeResult {
  handled: boolean;
}

interface TileEscape {
  /**
   * Register an ESC key handler. Always available (no capability required).
   * Return `{ handled: true }` to suppress the default ESC behaviour.
   */
  onEscape(callback: () => TileEscapeResult | void | Promise<TileEscapeResult | void>): void;
}

// ─── Profiles ─────────────────────────────────────────────────────────

interface TileProfileResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface TileProfiles {
  list(): Promise<TileProfileResult>;
  create(name: string): Promise<TileProfileResult>;
  get(slug: string): Promise<TileProfileResult>;
  delete(id: string): Promise<TileProfileResult>;
  getCurrent(): Promise<TileProfileResult>;
  switch(slug: string): Promise<TileProfileResult>;
  enableSync(profileId: string, apiKey: string, serverProfileId: string): Promise<TileProfileResult>;
  disableSync(profileId: string): Promise<TileProfileResult>;
  getSyncConfig(profileId: string): Promise<TileProfileResult>;
  getPartition(): Promise<TileProfileResult>;
}

// ─── Ad blocker ──────────────────────────────────────────────────────

interface TileAdblockerResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface TileAdblocker {
  getStatus(): Promise<TileAdblockerResult>;
  enable(): Promise<TileAdblockerResult>;
  disable(): Promise<TileAdblockerResult>;
  getBlockedCount(): Promise<TileAdblockerResult>;
  getAllowlist(): Promise<TileAdblockerResult>;
  isSiteAllowed(hostname: string): Promise<TileAdblockerResult>;
  allowSite(hostname: string): Promise<TileAdblockerResult>;
  disallowSite(hostname: string): Promise<TileAdblockerResult>;
}

// ─── Dark mode ───────────────────────────────────────────────────────

interface TileDarkMode {
  get(): Promise<{ mode: string } | { error: string }>;
  set(mode: string): Promise<{ success: boolean } | { error: string }>;
}

// ─── Web permissions (settings UI) ──────────────────────────────────

interface TilePermissionDecision {
  permission: string;
  origin: string;
  allowed: boolean;
  timestamp: number;
}

interface TilePermissionsResult {
  success: boolean;
  data?: TilePermissionDecision[];
  error?: string;
}

interface TilePermissions {
  list(): Promise<TilePermissionsResult>;
  forget(origin: string, permission: string): Promise<{ success: boolean; error?: string }>;
  forgetAll(): Promise<{ success: boolean; error?: string }>;
}

// ─── Full window.app API ─────────────────────────────────────────────

interface TileAPI {
  // ── Always available ───────────────────────────────────────────────

  /** Preload version string ('2.0.0'). */
  readonly version: string;

  /** Returns this tile's id string. */
  getTileId(): string | null;

  /** Returns this tile's entry filename. */
  getTileEntry(): string | null;

  /**
   * Initialize the tile. Must be called before using any capability APIs.
   * Validates the capability token with the main process.
   */
  initialize(): Promise<{ capabilities: Record<string, unknown> }>;

  /** Register a shutdown handler. */
  onShutdown(callback: () => void): void;

  /**
   * Register a handler that fires when the tile's window is re-shown
   * via the keepLive-reuse path in api.window.open. Delivered via
   * private `tile:lifecycle:visible` IPC before the open call resolves
   * to the caller, so state-reset handlers land ahead of any user input.
   */
  onVisible(callback: () => void): void;

  /** Whether the app is running in debug mode. */
  readonly debug: boolean;

  /** Log to main-process handler. */
  log(...args: unknown[]): void;

  screen: TileScreen;
  escape: TileEscape;
  profiles: TileProfiles;
  adblocker: TileAdblocker;
  darkMode: TileDarkMode;
  permissions: TilePermissions;

  // ── Removed v1 shims — these throw if called ──────────────────────

  /** @deprecated Removed. Use api.pubsub.publish. */
  publish(...args: unknown[]): never;
  /** @deprecated Removed. Use api.pubsub.subscribe. */
  subscribe(...args: unknown[]): never;
  /** @deprecated Removed. Use api.window.close(). */
  closeWindow(...args: unknown[]): never;

  // ── Capability-gated surfaces ──────────────────────────────────────

  pubsub: TilePubSub;
  commands: TileCommands;
  window: TileWindow;
  datastore: TileDatastore;
  settings: TileSettings;
  shortcuts: TileShortcuts;
  rules: TileRules;
  context: TileContext;
  filesystem: TileFilesystem;
  dialogs: TileDialogs;
  network: TileNetwork;
  features: TileFeatures;
  oauth: TileOAuth;
  sync: TileSync;
  izui: TileIzui;
  session: TileSession;
}

// ─── Augment window global ───────────────────────────────────────────

declare global {
  interface Window {
    /**
     * Tile capability API, injected by tile-preload.ts via contextBridge.
     * Call `await window.app.initialize()` before using any capability surfaces.
     */
    app: TileAPI;
  }
}

export {};
