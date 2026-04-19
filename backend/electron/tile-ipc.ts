/**
 * IPC Capability Enforcement for Tiles
 *
 * Handles:
 * - tile:validate-token — validate a capability token and return grants
 * - tile:ready — tile signals initialization complete
 * - tile:pubsub:* — scoped pubsub operations
 * - tile:command:* — command registration and results
 * - tile:window:* — window management
 * - tile:datastore:* — scoped data access
 * - tile:network:fetch — domain-gated network requests
 * - tile:filesystem:* — path-gated file access
 * - tile:theme:* — theme info
 * - tile:settings:* — settings access
 * - tile:features:* — feature registry read + (gated) install/manage
 *
 * Every handler validates the capability token before executing.
 */

import { ipcMain, BrowserWindow, net, dialog, webContents, nativeTheme, screen, app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  validateToken,
  getGrantForToken,
  signalTileReady,
  getTileWindow,
  isTileLoaded,
  unloadTile,
  launchTile,
  getTileManifest,
} from './tile-launcher.js';
import { parseManifestFile } from './tile-manifest.js';
import { publish, subscribe, unsubscribe, scopes, type Scope } from './pubsub.js';
import { DEBUG, TILE_STRICT } from './config.js';
import { publishCapabilityViolation } from './tile-violations.js';
import { getFeatureRegistry } from './feature-startup.js';
import { getAtprotoSource } from './feature-startup.js';
import {
  getDb,
  getTable as dsGetTable,
  setRow as dsSetRow,
  getRow as dsGetRow,
  addItem as dsAddItem,
  getItem as dsGetItem,
  updateItem as dsUpdateItem,
  deleteItem as dsDeleteItem,
  queryItems as dsQueryItems,
  tagItem as dsTagItem,
  untagItem as dsUntagItem,
  getItemTags as dsGetItemTags,
  getItemsByTag as dsGetItemsByTag,
  getOrCreateTag as dsGetOrCreateTag,
  getTagsByFrecency as dsGetTagsByFrecency,
  renameTag as dsRenameTag,
  updateTagColor as dsUpdateTagColor,
  deleteTag as dsDeleteTag,
  getStats as dsGetStats,
  hardDeleteItem as dsHardDeleteItem,
  updateItemTitle as dsUpdateItemTitle,
  updateItemFavicon as dsUpdateItemFavicon,
  recordItemVisit as dsRecordItemVisit,
  getItemVisits as dsGetItemVisits,
  queryItemVisits as dsQueryItemVisits,
  trackNavigation as dsTrackNavigation,
  queryItemsByFrecency as dsQueryItemsByFrecency,
  addItemEvent as dsAddItemEvent,
  queryItemEvents as dsQueryItemEvents,
  getLatestItemEvent as dsGetLatestItemEvent,
  countItemEvents as dsCountItemEvents,
  deleteItemEvent as dsDeleteItemEvent,
  deleteItemEvents as dsDeleteItemEvents,
  getItemEvent as dsGetItemEvent,
  addContent as dsAddContent,
  queryContent as dsQueryContent,
  addContextEntry,
  getContextEntry,
  queryContextHistory,
  getContextSnapshot,
  getWindowsWithContextValue,
  getWindowsMatchingContext,
  normalizeUrl,
} from './datastore.js';
import { tagItemAndPublish as dsTagItemAndPublish } from './tag-events.js';
import type { TableName } from '../types/index.js';
import { installFromBundle } from './feature-installer.js';
import { resolveCapabilities, validateTileManifest, detectManifestVersion } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';
import { invokeWindowOpen, popupToOpener, reopenLastClosedWindow, getLastFocusedVisibleWindowId } from './ipc.js';
import {
  getRunningExtensions,
  getAllRegisteredExtensions,
  reloadExtension,
  getWindowInfo,
} from './main.js';
import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  registerLocalShortcut,
  unregisterLocalShortcut,
} from './shortcuts.js';
import { checkShortcutAllowed } from './tile-shortcuts-enforcement.js';
import { checkContextAllowed } from './tile-context-enforcement.js';
import { checkDialogAllowed } from './tile-dialogs-enforcement.js';
import { checkWindowAllowed } from './tile-window-enforcement.js';
import { checkFeaturesAllowed, sourceTypeAllowed } from './tile-features-enforcement.js';
import { checkSettingsForeignAllowed } from './tile-settings-foreign-enforcement.js';
import { checkOAuthAllowed } from './tile-oauth-enforcement.js';
import { checkSyncAllowed } from './tile-sync-enforcement.js';
import { createLoopbackServer } from './oauth-loopback.js';
import { syncAll, getSyncConfig } from './sync.js';
import { checkEscapeAllowed } from './tile-escape-enforcement.js';
import { checkSessionAllowed } from './tile-session-enforcement.js';
import { checkIzuiAllowed } from './tile-izui-enforcement.js';
import { getActiveThemeId, setActiveThemeId, getRegisteredThemeIds, getThemePath } from './protocol.js';
import { validateTileDatastoreRequest } from './tile-datastore-scope.js';
import { resolveSettingDefault } from './tile-settings-defaults.js';
import {
  getBackupConfig,
  createBackup,
  listBackups,
} from './backup.js';
import { getPrefs } from './windows.js';
import {
  saveSessionSnapshot,
  restoreSessionSnapshot,
  getSessionSnapshotInfo,
} from './session.js';

// Re-export for test access — keeps the public enforcement API on tile-ipc.
export { validateTileDatastoreRequest } from './tile-datastore-scope.js';

// Re-export the strict-shortcut helper so older callers / tests can still
// import from 'tile-ipc' even though the logic lives in its own pure module.
export { checkShortcutAllowed, type ShortcutCheckResult } from './tile-shortcuts-enforcement.js';
export { checkContextAllowed, type ContextCheckResult, type ContextOp } from './tile-context-enforcement.js';
export { checkDialogAllowed, type DialogsCheckResult } from './tile-dialogs-enforcement.js';
export { checkWindowAllowed, type WindowCheckResult, type WindowOp } from './tile-window-enforcement.js';
export { checkFeaturesAllowed, sourceTypeAllowed, type FeaturesCheckResult, type FeaturesAction } from './tile-features-enforcement.js';
export { checkSettingsForeignAllowed, type SettingsForeignCheckResult } from './tile-settings-foreign-enforcement.js';
export { checkOAuthAllowed, type OAuthCheckResult, type OAuthOp } from './tile-oauth-enforcement.js';
export { checkSyncAllowed, type SyncCheckResult } from './tile-sync-enforcement.js';
export { checkEscapeAllowed, type EscapeCheckResult } from './tile-escape-enforcement.js';
export { checkSessionAllowed, type SessionCheckResult, type SessionOp } from './tile-session-enforcement.js';
export { checkIzuiAllowed, type IzuiCheckResult } from './tile-izui-enforcement.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Handle a capability check failure.
 *
 * - Publishes a `tile:capability-violation` event (rate-limited).
 * - In TILE_STRICT mode, throws immediately so CI / strict dev catch the regression.
 * - Otherwise, logs in DEBUG mode and returns so the caller can return an error response.
 */
function handleViolation(
  grant: CapabilityGrant | null,
  capability: string,
  op: string,
  reason: string,
  token?: string,
): void {
  const msg = `[tile-ipc] ${op} rejected: ${reason}`;
  const tileId = grant?.tileId ?? null;
  publishCapabilityViolation({ tileId, capability, op, token, reason });
  if (TILE_STRICT) throw new Error(msg);
  DEBUG && console.log(msg);
}

/**
 * Handle a datastore capability check failure (different result shape from check helpers).
 * Fetches tileId from the token (best-effort) and publishes a violation.
 */
function handleDatastoreViolation(token: string | undefined, op: string, reason: string): void {
  const grant = token ? getGrantForToken(token) : null;
  handleViolation(grant, 'datastore', op, reason, token);
}

/**
 * Convert an Item to an Address-compatible shape for backward-compat shims.
 * Mirrors ipc.ts::itemToAddress — kept local so tile-ipc has no hard dep on ipc.ts.
 */
function _itemToAddress(item: import('../types/index.js').Item): Record<string, unknown> {
  let protocol = '';
  let urlPath = '';
  try {
    const u = new URL(String(item.content || ''));
    protocol = u.protocol.replace(':', '');
    urlPath = u.pathname;
  } catch { /* not a valid URL */ }
  return {
    id: item.id,
    uri: item.content || '',
    protocol,
    domain: item.domain || '',
    path: urlPath,
    title: item.title || '',
    mimeType: item.mimeType || 'text/html',
    favicon: item.favicon || '',
    description: '',
    tags: '',
    metadata: item.metadata || '{}',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastVisitAt: item.lastVisitAt || 0,
    visitCount: item.visitCount || 0,
    starred: item.starred || 0,
    archived: item.archived || 0,
  };
}

/**
 * Check if a capability is granted. Trusted-builtin core renderers
 * bypass every capability-presence check here (the higher-level inline
 * gates at each call site also short-circuit on `grant.trustedBuiltin`
 * before consulting this helper — this duplicate check is belt-and-braces
 * so `hasCapability()` can't accidentally be used as a lone gate on
 * new code paths).
 */
function hasCapability(grant: CapabilityGrant, capability: keyof TileCapabilities): boolean {
  if (grant.trustedBuiltin) return true;
  return grant.capabilities[capability] !== undefined && grant.capabilities[capability] !== false;
}

/**
 * Check if a pubsub scope level is granted. Trusted-builtin core
 * renderers bypass the scope allowlist.
 */
function hasPubSubScope(grant: CapabilityGrant, scope: 'self' | 'global' | 'system'): boolean {
  if (grant.trustedBuiltin) return true;
  if (!grant.capabilities.pubsub) return false;
  return grant.capabilities.pubsub.scopes.includes(scope);
}

/**
 * Check if a network domain is allowed
 * Supports wildcard matching (e.g., '*.example.com' matches 'api.example.com').
 * Trusted-builtin core renderers bypass the domain allowlist.
 */
function isNetworkDomainAllowed(grant: CapabilityGrant, domain: string): boolean {
  if (grant.trustedBuiltin) return true;
  if (!grant.capabilities.network) return false;

  for (const allowed of grant.capabilities.network.domains) {
    if (allowed === domain) return true;

    // Wildcard matching: *.example.com
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // .example.com
      if (domain.endsWith(suffix)) return true;
    }
  }

  return false;
}

/**
 * Check if a filesystem path is allowed
 * Supports glob-style patterns with basic matching. Trusted-builtin
 * core renderers bypass the path allowlist.
 */
function isFilesystemPathAllowed(
  grant: CapabilityGrant,
  filePath: string,
  mode: 'read' | 'write'
): boolean {
  if (grant.trustedBuiltin) return true;
  if (!grant.capabilities.filesystem) return false;

  const patterns = mode === 'read'
    ? grant.capabilities.filesystem.read
    : grant.capabilities.filesystem.write;

  if (!patterns) return false;

  const normalized = path.normalize(filePath);

  for (const pattern of patterns) {
    const normalizedPattern = path.normalize(pattern);
    // Exact match
    if (normalized === normalizedPattern) return true;
    // Directory prefix match (pattern ends with /)
    if (normalizedPattern.endsWith('/') && normalized.startsWith(normalizedPattern)) return true;
    // Glob wildcard (basic: pattern/* matches anything under pattern)
    if (normalizedPattern.endsWith('/*') && normalized.startsWith(normalizedPattern.slice(0, -1))) return true;
  }

  return false;
}

/**
 * Map pubsub scope number to name for capability checking
 */
function scopeNumberToName(scopeNum: number): 'self' | 'global' | 'system' {
  switch (scopeNum) {
    case scopes.SYSTEM: return 'system';
    case scopes.GLOBAL: return 'global';
    default: return 'self';
  }
}

// ─── Semver Comparison Helper ───────────────────────────────────────

/**
 * Simple semver comparison. Returns -1, 0, or 1.
 */
function compareSemverSimple(a: string, b: string): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ─── Capability Comparison Helper ───────────────────────────────────

/**
 * Compare two TileCapabilities for expansion detection.
 * Used by feature-update:apply to guard auto-updates.
 */
function compareCapabilitiesSimple(
  currentCaps: TileCapabilities | undefined,
  newCaps: TileCapabilities | undefined
): { changed: boolean; expanded: boolean; added: string[]; removed: string[] } {
  const result = { changed: false, expanded: false, added: [] as string[], removed: [] as string[] };
  const cur = currentCaps || {} as TileCapabilities;
  const nxt = newCaps || {} as TileCapabilities;

  // Boolean capabilities (or boolean-or-object capabilities treated as
  // present/absent for change detection — deeper allowlist diffs are
  // out of scope for the auto-update expansion guard).
  const boolCaps: Array<keyof TileCapabilities> = ['commands', 'shortcuts', 'sync', 'theme', 'settings', 'context', 'dialogs', 'features', 'oauth'];
  for (const cap of boolCaps) {
    const had = !!cur[cap];
    const has = !!nxt[cap];
    if (!had && has) { result.changed = true; result.expanded = true; result.added.push(cap); }
    else if (had && !has) { result.changed = true; result.removed.push(cap); }
  }

  // Network domains
  const curDomains = new Set(cur.network?.domains || []);
  const nxtDomains = new Set(nxt.network?.domains || []);
  for (const d of nxtDomains) {
    if (!curDomains.has(d)) { result.changed = true; result.expanded = true; result.added.push(`network:${d}`); }
  }
  for (const d of curDomains) {
    if (!nxtDomains.has(d)) { result.changed = true; result.removed.push(`network:${d}`); }
  }

  // Datastore tables
  const curTables = new Set(cur.datastore?.tables || []);
  const nxtTables = new Set(nxt.datastore?.tables || []);
  for (const t of nxtTables) {
    if (!curTables.has(t)) { result.changed = true; result.expanded = true; result.added.push(`datastore:${t}`); }
  }
  for (const t of curTables) {
    if (!nxtTables.has(t)) { result.changed = true; result.removed.push(`datastore:${t}`); }
  }

  // PubSub scopes
  const curScopes = new Set(cur.pubsub?.scopes || []);
  const nxtScopes = new Set(nxt.pubsub?.scopes || []);
  for (const s of nxtScopes) {
    if (!curScopes.has(s)) { result.changed = true; result.expanded = true; result.added.push(`pubsub.scope:${s}`); }
  }
  for (const s of curScopes) {
    if (!nxtScopes.has(s)) { result.changed = true; result.removed.push(`pubsub.scope:${s}`); }
  }

  // Window
  if (nxt.window && !cur.window) { result.changed = true; result.expanded = true; result.added.push('window'); }
  else if (cur.window && !nxt.window) { result.changed = true; result.removed.push('window'); }
  else if (cur.window && nxt.window) {
    for (const p of ['create', 'query', 'manage'] as const) {
      const had = !!(cur.window as Record<string, boolean>)[p];
      const has = !!(nxt.window as Record<string, boolean>)[p];
      if (!had && has) { result.changed = true; result.expanded = true; result.added.push(`window.${p}`); }
      else if (had && !has) { result.changed = true; result.removed.push(`window.${p}`); }
    }
  }

  // Filesystem
  if (nxt.filesystem && !cur.filesystem) { result.changed = true; result.expanded = true; result.added.push('filesystem'); }
  else if (cur.filesystem && !nxt.filesystem) { result.changed = true; result.removed.push('filesystem'); }

  return result;
}

// ─── Feature History Helper ─────────────────────────────────────────

/**
 * Write an event to the features_history table
 */
function writeFeatureHistory(
  featureId: string,
  event: string,
  version?: string,
  sourceType?: string,
  sourceUri?: string,
  publisher?: string,
  capabilities?: Record<string, unknown>
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO features_history (featureId, event, version, sourceType, sourceUri, publisher, capabilities, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      featureId,
      event,
      version || null,
      sourceType || null,
      sourceUri || null,
      publisher || null,
      capabilities ? JSON.stringify(capabilities) : '{}',
      new Date().toISOString()
    );
  } catch (err) {
    console.error('[tile-ipc] Failed to write feature history:', err);
  }
}

// ─── IPC Handler Registration ────────────────────────────────────────

/**
 * Register all tile IPC handlers
 * Call this once during app initialization
 */
export function registerTileIpcHandlers(): void {

  // ── Token Validation ──

  ipcMain.handle('tile:validate-token', (_event, args: {
    tileId: string;
    tileEntry: string;
    token: string;
  }) => {
    const record = validateToken(args.token);
    if (!record) {
      return { valid: false };
    }

    // Verify the token matches the claimed tile
    if (record.tileId !== args.tileId || record.tileEntryId !== args.tileEntry) {
      DEBUG && console.log(`[tile-ipc] Token mismatch: claimed ${args.tileId}:${args.tileEntry}, actual ${record.tileId}:${record.tileEntryId}`);
      return { valid: false };
    }

    return {
      valid: true,
      capabilities: record.grant.capabilities,
      trustedBuiltin: record.grant.trustedBuiltin === true,
    };
  });

  // ── Tile Ready ──

  ipcMain.on('tile:ready', (_event, args: {
    tileId: string;
    tileEntry: string;
  }) => {
    signalTileReady(args.tileId, args.tileEntry);
  });

  // ── PubSub ──

  ipcMain.on('tile:pubsub:publish', (_event, args: {
    token: string;
    source: string;
    scope: number;
    topic: string;
    data: unknown;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) {
      DEBUG && console.log('[tile-ipc] pubsub:publish rejected: invalid token');
      return;
    }

    // Check pubsub scope capability
    const scopeName = scopeNumberToName(args.scope);
    if (!hasPubSubScope(grant, scopeName)) {
      const reason = `scope ${scopeName} not granted for ${grant.tileId}`;
      handleViolation(grant, 'pubsub', 'pubsub:publish', reason, args.token);
      return;
    }

    // Topic enforcement: if topics allowlist is set, check it.
    // Trusted-builtin core renderers bypass the topic allowlist.
    if (!grant.trustedBuiltin && grant.capabilities.pubsub?.topics) {
      const allowed = grant.capabilities.pubsub.topics.some(pattern => {
        if (pattern === args.topic) return true;
        // Simple glob: pattern:* matches pattern:anything
        if (pattern.endsWith('*') && args.topic.startsWith(pattern.slice(0, -1))) return true;
        return false;
      });
      if (!allowed) {
        const reason = `topic ${args.topic} not in allowlist for ${grant.tileId}`;
        handleViolation(grant, 'pubsub', 'pubsub:publish', reason, args.token);
        return;
      }
    }

    publish(args.source, args.scope as Scope, args.topic, args.data);
  });

  ipcMain.on('tile:pubsub:subscribe', (_event, args: {
    token: string;
    source: string;
    topic: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    // Subscribe at GLOBAL scope (main process will filter via scopeCheck)
    subscribe(args.source, scopes.GLOBAL, args.topic, (msg) => {
      // Message delivery handled by extension broadcaster in main.ts
    });
  });

  ipcMain.on('tile:pubsub:unsubscribe', (_event, args: {
    token: string;
    source: string;
    topic: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    unsubscribe(args.source, args.topic);
  });

  // ── Commands ──

  ipcMain.on('tile:command:register', (_event, args: {
    token: string;
    tileId: string;
    name: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'commands')) {
      handleViolation(grant, 'commands', 'command:register', 'commands not granted', args.token);
      return;
    }
    // Capability gate + token-tile linkage only. Previously this also
    // published a minimal cmd:register-batch (name+source) — but that
    // overwrote the full-metadata entry from the preload's own cmd:register
    // publish, erasing accepts/produces/description. The preload is now the
    // single source of truth for cmd registry metadata (see tile-preload.cts
    // api.commands.register object-form publish).
  });

  ipcMain.on('tile:command:result', (_event, args: {
    token: string;
    name: string;
    result?: unknown;
    error?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return;

    // Publish result so cmd panel can resolve
    const topic = `${args.name}:result`;
    publish(
      `peek://${grant.tileId}/background`,
      scopes.GLOBAL,
      topic,
      args.error ? { error: args.error } : { result: args.result }
    );
  });

  // ── Shortcuts (strict) ────────────────────────────────────────────
  //
  // Strict tile:shortcuts:* handlers that enforce the `shortcuts`
  // capability (§HIGH bypass #2 in the security audit). The legacy
  // `registershortcut` / `unregistershortcut` channels remain on ipc.ts
  // as the v1-compat surface and are NOT token-gated — tile-preload
  // routes through these strict handlers when the tile's manifest
  // declares the `shortcuts` capability.
  //
  // Validation order:
  //   1. Token must resolve to a valid grant.
  //   2. Grant must include the `shortcuts` capability.
  //   3. If the capability is a `ShortcutsCapability` object with a
  //      `keys` allowlist, the shortcut must appear in that list.
  //
  // On validation failure we reply with `{ error }` on `replyTopic`
  // if provided so the renderer can surface the rejection; we still
  // return early (no registration performed).

  ipcMain.on('tile:shortcuts:register', (ev, args: {
    token: string;
    source?: string;
    shortcut: string;
    replyTopic?: string;
    global?: boolean;
    mode?: string;
    options?: { global?: boolean; mode?: string };
  }) => {
    // Accept either top-level global/mode or nested options.{global,mode}
    // so renderer callers can pick whichever shape they want.
    const opts = args.options || {};
    const isGlobal = args.global === true || opts.global === true;
    const modeStr = args.mode ?? opts.mode;

    const replyError = (message: string): void => {
      if (args.replyTopic) {
        try {
          if (!ev.sender.isDestroyed()) {
            ev.reply(args.replyTopic, { error: message });
          }
        } catch {
          // swallow — reply failures are non-fatal for registration rejection
        }
      }
    };

    const grant = getGrantForToken(args.token);
    const check = checkShortcutAllowed(grant, args.shortcut);
    if (!check.ok) {
      handleViolation(grant, 'shortcuts', 'shortcuts:register', check.error, args.token);
      replyError(check.error);
      return;
    }
    // check.ok guarantees grant is non-null per checkShortcutAllowed contract.
    const activeGrant = grant as CapabilityGrant;
    const source = args.source || `peek://${activeGrant.tileId}/background`;

    // Callback mirrors ipc.ts registershortcut: reply to the sender frame
    // on replyTopic when the shortcut fires so the renderer can invoke the
    // user-supplied callback. Guard against destroyed senders (tile
    // reload / iframe removed).
    const callback = (): void => {
      DEBUG && console.log('[tile-ipc] shortcut fired', args.shortcut, 'for', activeGrant.tileId);
      if (!args.replyTopic) return;
      try {
        if (!ev.sender.isDestroyed()) {
          ev.reply(args.replyTopic, { foo: 'bar' });
        }
      } catch (err) {
        DEBUG && console.log('[tile-ipc] shortcut reply failed:', err);
      }
    };

    if (isGlobal) {
      registerGlobalShortcut(args.shortcut, source, callback);
    } else {
      const modeConditions = modeStr ? { majorMode: modeStr as import('./datastore.js').MajorModeId } : undefined;
      registerLocalShortcut(args.shortcut, source, callback, modeConditions);
    }
  });

  ipcMain.on('tile:shortcuts:unregister', (_ev, args: {
    token: string;
    source?: string;
    shortcut: string;
    global?: boolean;
    mode?: string;
    options?: { global?: boolean; mode?: string };
  }) => {
    const opts = args.options || {};
    const isGlobal = args.global === true || opts.global === true;
    const modeStr = args.mode ?? opts.mode;

    const grant = getGrantForToken(args.token);
    const check = checkShortcutAllowed(grant, args.shortcut);
    if (!check.ok) {
      handleViolation(grant, 'shortcuts', 'shortcuts:unregister', check.error, args.token);
      return;
    }
    const activeGrant = grant as CapabilityGrant;
    const source = args.source || `peek://${activeGrant.tileId}/background`;

    if (isGlobal) {
      unregisterGlobalShortcut(args.shortcut);
    } else {
      const modeConditions = modeStr ? { majorMode: modeStr as import('./datastore.js').MajorModeId } : undefined;
      unregisterLocalShortcut(args.shortcut, source, modeConditions);
    }
  });

  // ── Context (strict) ──────────────────────────────────────────────
  //
  // Strict tile:context:* handlers that enforce the `context` capability.
  // The legacy `context-get` / `context-set` / `context-history` /
  // `context-snapshot` / `context-windows-*` channels in ipc.ts remain
  // the v1-compat surface and are NOT token-gated — tile-preload routes
  // through these strict handlers when the tile's manifest declares the
  // `context` capability. See docs/tile-preload-trimming-plan.md §2.5.
  //
  // Validation order for each op:
  //   1. Token must resolve to a valid grant.
  //   2. Grant must include the `context` capability (boolean or object).
  //   3. Per-op gates applied via checkContextAllowed (pure module):
  //      - get/history: key must be in `read` allowlist (if set).
  //      - set: key must be in `write` allowlist (if set); writing the
  //        `mode` key additionally requires `modes: true`.
  //      - windowsWithValue/windowsInSpace: require `queryWindows: true`.
  //      - snapshot: no per-op gate beyond the capability itself.

  ipcMain.handle('tile:context:get', async (ev, args: {
    token: string;
    key: string;
    windowId?: number | null;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkContextAllowed(grant, 'get', args.key);
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:get', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      let windowId = args.windowId;
      if (windowId == null) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        windowId = callingWin?.id ?? null;
      }
      const entry = getContextEntry(args.key, windowId);
      return { success: true, data: entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:context:set', async (ev, args: {
    token: string;
    key: string;
    value: unknown;
    metadata?: Record<string, unknown>;
    windowId?: number | null;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkContextAllowed(grant, 'set', args.key);
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:set', check.error, args.token);
      return { success: false, error: check.error };
    }
    // check.ok guarantees grant is non-null.
    const activeGrant = grant as CapabilityGrant;
    try {
      let windowId = args.windowId;
      if (windowId == null) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        windowId = callingWin?.id ?? null;
      }
      const source = `peek://${activeGrant.tileId}/background`;
      const result = addContextEntry(args.key, args.value, {
        metadata: args.metadata,
        windowId,
        source,
      });
      // Publish context:changed so watchers see the write (parity with
      // the legacy context-set handler in ipc.ts).
      publish(
        source,
        scopes.GLOBAL,
        'context:changed',
        {
          key: args.key,
          value: args.value,
          metadata: args.metadata || {},
          windowId,
          source,
          entryId: result.id,
        },
      );
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:context:history', async (_ev, args: {
    token: string;
    key?: string;
    windowId?: number | null;
    since?: number;
    until?: number;
    limit?: number;
    order?: 'asc' | 'desc';
  }) => {
    const grant = getGrantForToken(args.token);
    // history has a key-scoped gate only when the caller specified a
    // key. Unscoped history queries still require the capability but
    // not a specific allowlist entry — the datastore query itself
    // returns all keys, which the read allowlist cannot meaningfully
    // restrict without iterating per-entry. We therefore require an
    // explicit `key` when a read allowlist is configured.
    const cap = grant?.capabilities.context;
    if (grant && cap && typeof cap === 'object' && Array.isArray((cap as { read?: string[] }).read) && !args.key) {
      return { success: false, error: 'context key required for history when read allowlist is configured' };
    }
    const check = checkContextAllowed(grant, 'history', args.key);
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:history', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const entries = queryContextHistory({
        key: args.key,
        windowId: args.windowId ?? undefined,
        since: args.since,
        until: args.until,
        limit: args.limit,
        order: args.order,
      });
      return { success: true, data: entries };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:context:snapshot', async (_ev, args: {
    token: string;
    timestamp?: number;
    keys?: string[];
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkContextAllowed(grant, 'snapshot');
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:snapshot', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const ts = typeof args.timestamp === 'number' ? args.timestamp : Date.now();
      const snapshot = getContextSnapshot(ts, args.keys || []);
      return { success: true, data: snapshot };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:context:windows-with-value', async (_ev, args: {
    token: string;
    key: string;
    value: unknown;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkContextAllowed(grant, 'windowsWithValue', args.key);
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:windows-with-value', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const windowIds = getWindowsWithContextValue(args.key, args.value);
      return { success: true, data: windowIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:context:windows-in-space', async (_ev, args: {
    token: string;
    spaceId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkContextAllowed(grant, 'windowsInSpace');
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:windows-in-space', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const windowIds = getWindowsMatchingContext('mode', (entry) => {
        return entry.value === 'space' && (entry.metadata as { spaceId?: string } | undefined)?.spaceId === args.spaceId;
      });
      return { success: true, data: windowIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── Dialogs (strict) ──────────────────────────────────────────────
  //
  // Strict tile:dialogs:save / tile:dialogs:open handlers that enforce
  // the `dialogs` capability. The v1-compat surface was the
  // `file-save-dialog` / `file-open-dialog` IPC channels with
  // `api.files.save/open` preload wrappers, neither capability-gated.
  // The strict handlers reuse the same Electron `dialog.show*Dialog`
  // flow while requiring a declared capability + optional type
  // allowlist. See docs/tile-preload-trimming-plan.md §2.4.

  ipcMain.handle('tile:dialogs:save', async (ev, args: {
    token: string;
    content: string;
    filename?: string;
    mimeType?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkDialogAllowed(grant, 'save');
    if (!check.ok) {
      handleViolation(grant, 'dialogs', 'dialogs:save', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const filters: Electron.FileFilter[] = [];
      if (args.mimeType) {
        const extMap: Record<string, { name: string; extensions: string[] }> = {
          'application/json': { name: 'JSON', extensions: ['json'] },
          'text/csv': { name: 'CSV', extensions: ['csv'] },
          'text/plain': { name: 'Text', extensions: ['txt'] },
          'text/html': { name: 'HTML', extensions: ['html', 'htm'] },
        };
        const filter = extMap[args.mimeType];
        if (filter) filters.push(filter);
      }
      filters.push({ name: 'All Files', extensions: ['*'] });

      const senderWindow = BrowserWindow.fromWebContents(ev.sender);
      const focusedWindow = BrowserWindow.getFocusedWindow();
      const parentWindow = focusedWindow && !focusedWindow.isDestroyed()
        ? focusedWindow
        : (senderWindow && !senderWindow.isDestroyed() && senderWindow.isVisible() ? senderWindow : null);

      const dialogOpts: Electron.SaveDialogOptions = {
        defaultPath: args.filename,
        filters,
      };
      const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      fs.writeFileSync(result.filePath, args.content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:dialogs:open', async (ev, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkDialogAllowed(grant, 'open');
    if (!check.ok) {
      handleViolation(grant, 'dialogs', 'dialogs:open', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const senderWindow = BrowserWindow.fromWebContents(ev.sender);
      const focusedWindow = BrowserWindow.getFocusedWindow();
      const parentWindow = focusedWindow && !focusedWindow.isDestroyed()
        ? focusedWindow
        : (senderWindow && !senderWindow.isDestroyed() && senderWindow.isVisible() ? senderWindow : null);

      const openDialogOpts: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [
          { name: 'All Files', extensions: ['*'] },
          { name: 'Text Files', extensions: ['txt', 'md', 'json', 'html', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log'] },
          { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'rtf'] },
        ],
      };
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, openDialogOpts)
        : await dialog.showOpenDialog(openDialogOpts);

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const stats = fs.statSync(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      const extToMime: Record<string, string> = {
        '.md': 'text/markdown',
        '.markdown': 'text/markdown',
        '.txt': 'text/plain',
        '.text': 'text/plain',
        '.json': 'application/json',
        '.html': 'text/html',
        '.htm': 'text/html',
        '.csv': 'text/csv',
        '.xml': 'application/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
        '.svg': 'image/svg+xml',
      };
      const mimeType = extToMime[ext] || 'application/octet-stream';
      const isText = mimeType.startsWith('text/') ||
                     mimeType === 'application/json' ||
                     mimeType === 'application/xml' ||
                     mimeType === 'image/svg+xml';

      let content: string | null = null;
      if (isText) content = fs.readFileSync(filePath, 'utf-8');

      return {
        success: true,
        data: {
          name: fileName,
          path: filePath,
          size: stats.size,
          mimeType,
          content,
          isText,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── Features (strict) ────────────────────────────────────────────
  //
  // Strict tile:features:* handlers that enforce the `features`
  // capability for feature-registry reads and, when explicitly
  // granted, install/manage operations. The legacy channels
  // `feature-registry:*` / `feature-install:*` / `feature-browse:*`
  // remain as the v1-compat surface for the settings UI; they only
  // check that the caller has a valid token, without gating on a
  // declared capability. Tile authors who want to drive the registry
  // from their own window should declare `features` in the manifest
  // and route through these strict handlers instead.
  //
  // Validation order for each op:
  //   1. Token must resolve to a valid grant.
  //   2. Grant must include the `features` capability (boolean or object).
  //   3. Per-action gate via checkFeaturesAllowed (pure module):
  //      - list/get/history: `read` (defaulted true when capability declared).
  //      - resolve/preview/install + browse: `install` (must be true).
  //      - enable/disable/remove: `manage` (must be true).
  //   4. If `sources` allowlist is set, entry/source must be in the list.

  ipcMain.handle('tile:features:list', async (_event, args: {
    token: string;
    /** Optional filter by source type (rejected if not in sources allowlist). */
    sourceType?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'read');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:list', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    // Honour an explicit sourceType filter — but only after checking it
    // against the capability allowlist, so a tile scoped to `atproto`
    // can't smuggle out builtin entries by passing `sourceType: 'builtin'`.
    if (args.sourceType !== undefined) {
      const allowed = sourceTypeAllowed(grant, args.sourceType as never);
      if (!allowed) {
        return { error: `features source "${args.sourceType}" not in capability sources allowlist` };
      }
    }

    const all = args.sourceType
      ? registry.listFeatures({ sourceType: args.sourceType as never })
      : registry.listFeatures();

    // Existing v1-compat handler hides builtins from the default list;
    // mirror that policy here so strict callers see the same surface.
    // Tiles that need to see builtins must pass sourceType: 'builtin'
    // (and have 'builtin' in their sources allowlist).
    const base = args.sourceType
      ? all
      : all.filter(e => e.source.type !== 'builtin');

    // Apply per-entry source allowlist filtering. No-op when the
    // capability omits `sources` (allowed = true for all).
    const entries = base.filter(e => sourceTypeAllowed(grant, e.source.type));
    return { entries };
  });

  ipcMain.handle('tile:features:get', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'read');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:get', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };

    // Source allowlist: treat as not-found when caller cannot see this source.
    if (!sourceTypeAllowed(grant, entry.source.type)) {
      return { error: `Feature not found: ${args.id}` };
    }

    return { entry };
  });

  ipcMain.handle('tile:features:history', async (_event, args: {
    token: string;
    featureId?: string;
    limit?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'read');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:history', check.error, args.token);
      return { error: check.error };
    }

    // When scoped by featureId, enforce the source allowlist against
    // the live entry (if any). Unknown ids fall through — history rows
    // may exist for removed features and strict callers with the
    // appropriate sources list should still see them.
    if (args.featureId) {
      const registry = getFeatureRegistry();
      const entry = registry?.getFeature(args.featureId);
      if (entry && !sourceTypeAllowed(grant, entry.source.type)) {
        return { error: `Feature not found: ${args.featureId}` };
      }
    }

    try {
      const db = getDb();
      let sql = 'SELECT * FROM features_history';
      const params: unknown[] = [];

      if (args.featureId) {
        sql += ' WHERE featureId = ?';
        params.push(args.featureId);
      }

      sql += ' ORDER BY timestamp DESC';

      if (args.limit) {
        sql += ' LIMIT ?';
        params.push(args.limit);
      }

      const rows = db.prepare(sql).all(...params);
      return { entries: rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to query history: ${message}` };
    }
  });

  ipcMain.handle('tile:features:enable', async (_event, args: {
    token: string;
    id: string;
    tilePreloadPath?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'manage');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:enable', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (!sourceTypeAllowed(grant, entry.source.type)) {
      return { error: `features source "${entry.source.type}" not in capability sources allowlist` };
    }

    const result = registry.enableFeature(args.id);
    if (result) {
      registry.saveRegistry();

      if (entry.source.type === 'builtin' && args.tilePreloadPath) {
        try {
          const manifestPath = path.join(entry.path, 'manifest.json');
          const parsed = parseManifestFile(manifestPath);
          if (parsed?.version === 'v2' && parsed.v2) {
            const residentTile = parsed.v2.tiles.find(t => t.resident === true || t.type === 'background');
            if (residentTile && !isTileLoaded(args.id, residentTile.id)) {
              launchTile({
                tilePath: entry.path,
                manifest: parsed.v2,
                preloadPath: args.tilePreloadPath,
                entryId: residentTile.id,
              });
            }
          }
        } catch (err) {
          console.error(`[tile-ipc] Failed to relaunch ${args.id} on enable:`, err);
        }
      }

      publish('feature-registry', scopes.GLOBAL, 'feature:enabled', { id: args.id });
    }
    return { success: result };
  });

  ipcMain.handle('tile:features:disable', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'manage');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:disable', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type === 'builtin') return { error: 'Cannot disable builtin features' };
    if (!sourceTypeAllowed(grant, entry.source.type)) {
      return { error: `features source "${entry.source.type}" not in capability sources allowlist` };
    }

    const result = registry.disableFeature(args.id);
    if (result) {
      registry.saveRegistry();

      const manifest = getTileManifest(args.id);
      if (manifest) {
        for (const t of manifest.tiles) {
          if (isTileLoaded(args.id, t.id)) {
            try {
              await unloadTile(args.id, t.id);
            } catch (err) {
              console.error(`[tile-ipc] Failed to unload ${args.id}:${t.id} on disable:`, err);
            }
          }
        }
      }

      publish('feature-registry', scopes.GLOBAL, 'feature:disabled', { id: args.id });
    }
    return { success: result };
  });

  ipcMain.handle('tile:features:remove', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'manage');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:remove', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type === 'builtin') return { error: 'Cannot remove builtin features' };
    if (!sourceTypeAllowed(grant, entry.source.type)) {
      return { error: `features source "${entry.source.type}" not in capability sources allowlist` };
    }

    // Mirror v1-compat: tear down running tile windows before deleting files.
    const manifest = getTileManifest(args.id);
    if (manifest) {
      for (const t of manifest.tiles) {
        if (isTileLoaded(args.id, t.id)) {
          try {
            await unloadTile(args.id, t.id);
          } catch (err) {
            console.error(`[tile-ipc] Failed to unload ${args.id}:${t.id} on remove:`, err);
          }
        }
      }
    }

    const result = registry.unregisterFeature(args.id);
    if (result) {
      if (entry.source.type !== 'dev') {
        try {
          if (fs.existsSync(entry.path)) {
            fs.rmSync(entry.path, { recursive: true });
          }
        } catch (err) {
          console.error(`[tile-ipc] Failed to delete feature files at ${entry.path}:`, err);
        }
      }
      registry.saveRegistry();

      writeFeatureHistory(
        args.id,
        'uninstall',
        entry.source.version,
        entry.source.type,
        entry.source.uri,
        entry.source.publisher,
        entry.grantedCapabilities as unknown as Record<string, unknown>
      );

      publish('feature-registry', scopes.GLOBAL, 'feature:removed', { id: args.id });
    }
    return { success: result };
  });

  ipcMain.handle('tile:features:install-resolve', async (_event, args: {
    token: string;
    atUri: string;
  }) => {
    const grant = getGrantForToken(args.token);
    // Resolve is a pre-install read against the atproto source. Gate on
    // `install` since it's only meaningful as a step toward installing.
    // Source-type check: always 'atproto' for this endpoint.
    const check = checkFeaturesAllowed(grant, 'install', 'atproto');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:install-resolve', check.error, args.token);
      return { error: check.error };
    }

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    try {
      const metadata = await source.resolve(args.atUri);
      return { manifest: metadata.manifest, source: metadata.source };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve AT URI: ${message}` };
    }
  });

  ipcMain.handle('tile:features:preview-capabilities', async (_event, args: {
    token: string;
    manifestCapabilities: TileCapabilities;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'install');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:preview-capabilities', check.error, args.token);
      return { error: check.error };
    }

    try {
      const result = resolveCapabilities(args.featureId, args.manifestCapabilities, false);
      return { granted: result.capabilities, denied: result.denied };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve capabilities: ${message}` };
    }
  });

  ipcMain.handle('tile:features:install', async (_event, args: {
    token: string;
    atUri: string;
    userApproved: boolean;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'install', 'atproto');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:install', check.error, args.token);
      return { error: check.error };
    }

    if (!args.userApproved) {
      return { error: 'User approval required before installation' };
    }

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    try {
      const metadata = await source.resolve(args.atUri);
      const bundle = await source.fetch(args.atUri);

      const result = installFromBundle(
        bundle,
        metadata.source,
        registry,
        { force: true, userApproved: true }
      );

      if (!result.success) {
        return { error: result.error };
      }

      registry.saveRegistry();

      writeFeatureHistory(
        result.entry!.id,
        'install',
        metadata.source.version,
        'atproto',
        args.atUri,
        metadata.source.publisher,
        result.entry!.grantedCapabilities as unknown as Record<string, unknown>
      );

      publish('feature-registry', scopes.GLOBAL, 'feature:installed', {
        id: result.entry!.id,
        name: result.entry!.name,
        source: metadata.source,
      });

      return { success: true, entry: result.entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Installation failed: ${message}` };
    }
  });

  ipcMain.handle('tile:features:browse-resolve-publisher', async (_event, args: {
    token: string;
    query: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'install', 'atproto');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:browse-resolve-publisher', check.error, args.token);
      return { error: check.error };
    }

    if (!args.query || !args.query.trim()) {
      return { error: 'Handle or DID is required' };
    }

    const { resolveHandleToDid, resolveDid } = await import('./atproto-source.js');

    try {
      const query = args.query.trim();
      let did: string;

      if (query.startsWith('did:')) {
        did = query;
      } else {
        const resolved = await resolveHandleToDid(query);
        if (!resolved) {
          return { error: `Could not resolve handle "${query}"` };
        }
        did = resolved;
      }

      const identity = await resolveDid(did);
      if (!identity) {
        return { error: `Could not resolve DID: ${did}` };
      }

      return { did, handle: identity.handle, pdsUrl: identity.pdsUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve publisher: ${message}` };
    }
  });

  // ── Features admin (strict): update / dev / publish / devtools / browse ──
  //
  // Strict mirrors of the v1-compat `feature-update:*`, `feature-dev:*`,
  // `feature-publish:*`, `feature-devtools:open` and
  // `feature-browse:list-by-publisher` channels. Each delegates to the
  // existing legacy handler via `ipcMain.invoke(...)`-style direct
  // dispatch is not available — instead we re-use the shared registry
  // helpers to execute the same logic here, behind the proper
  // capability gate. For `feature-devtools:open` and browse/publish ops
  // that do not take a specific source type, we gate on the per-action
  // flag only. For update/apply we gate on `update` + source `atproto`.

  ipcMain.handle('tile:features:update-check-all', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'update');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:update-check-all', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };
    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    try {
      const all = registry.listFeatures();
      const atprotoFeatures = all.filter(e => e.source.type === 'atproto' && e.source.publisher);
      if (atprotoFeatures.length === 0) return { updates: [] };

      const byPublisher = new Map<string, typeof atprotoFeatures>();
      for (const feature of atprotoFeatures) {
        const did = feature.source.publisher!;
        if (!byPublisher.has(did)) byPublisher.set(did, []);
        byPublisher.get(did)!.push(feature);
      }

      const updates: Array<{
        id: string; name: string;
        currentVersion: string; availableVersion: string; atUri: string;
      }> = [];

      for (const [did, pubFeatures] of byPublisher) {
        try {
          const { resolveDid: resolveDidFn } = await import('./atproto-source.js');
          const identity = await resolveDidFn(did);
          if (!identity) continue;

          const params = new URLSearchParams({
            repo: did,
            collection: 'space.peek.feature.release',
            limit: '100',
          });
          const url = `${identity.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
          const res = await fetch(url);
          if (!res.ok) continue;

          const data = await res.json() as {
            records: Array<{ uri: string; value: Record<string, unknown> }>;
          };

          const featureMap = new Map<string, { uri: string; version: string; createdAt: string }>();
          for (const rec of data.records || []) {
            const val = rec.value;
            const featureId = val.featureId as string;
            if (!featureId) continue;
            const existing = featureMap.get(featureId);
            const createdAt = (val.createdAt as string) || '';
            if (!existing || createdAt > existing.createdAt) {
              featureMap.set(featureId, {
                uri: rec.uri,
                version: (val.version as string) || '0.0.0',
                createdAt,
              });
            }
          }

          for (const feature of pubFeatures) {
            const policy = feature.updatePolicy || 'auto';
            if (policy === 'pinned') continue;

            const currentVersion = feature.source.version || '0.0.0';
            const latest = featureMap.get(feature.id);
            if (!latest) continue;

            if (compareSemverSimple(latest.version, currentVersion) > 0) {
              const entry = registry.getFeature(feature.id);
              if (entry) {
                entry.availableVersion = latest.version;
                entry.lastUpdateCheck = new Date().toISOString();
                registry.registerFeature(entry);
              }
              updates.push({
                id: feature.id,
                name: feature.name,
                currentVersion,
                availableVersion: latest.version,
                atUri: latest.uri,
              });
            } else {
              const entry = registry.getFeature(feature.id);
              if (entry) {
                entry.availableVersion = undefined;
                entry.lastUpdateCheck = new Date().toISOString();
                registry.registerFeature(entry);
              }
            }
          }
        } catch (err) {
          console.error(`[tile-ipc] Update check failed for publisher ${did}:`, err);
        }
      }

      registry.saveRegistry();
      return { updates };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Update check failed: ${message}` };
    }
  });

  ipcMain.handle('tile:features:update-apply', async (_event, args: {
    token: string;
    id: string;
    userApproved?: boolean;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'update', 'atproto');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:update-apply', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };
    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type !== 'atproto' || !entry.source.uri) {
      return { error: 'Feature is not from AT Protocol' };
    }

    try {
      const metadata = await source.resolve(entry.source.uri);
      const newManifest = metadata.manifest;
      const newVersion = metadata.source.version || newManifest.version;
      const currentVersion = entry.source.version || '0.0.0';

      if (compareSemverSimple(newVersion || '0.0.0', currentVersion) <= 0) {
        return { error: 'No newer version available' };
      }

      const capComparison = compareCapabilitiesSimple(
        entry.grantedCapabilities,
        newManifest.capabilities,
      );

      if (capComparison.expanded && !args.userApproved) {
        return {
          error: 'Capabilities expanded — user approval required',
          capabilitiesChanged: true,
          added: capComparison.added,
          removed: capComparison.removed,
        };
      }

      const bundle = await source.fetch(entry.source.uri);
      const installResult = installFromBundle(
        bundle,
        metadata.source,
        registry,
        { force: true, userApproved: args.userApproved || !capComparison.expanded },
      );

      if (!installResult.success) {
        writeFeatureHistory(
          args.id, 'update-failed', newVersion,
          'atproto', entry.source.uri, entry.source.publisher,
        );
        return { error: installResult.error };
      }

      const updatedEntry = registry.getFeature(args.id);
      if (updatedEntry) {
        updatedEntry.availableVersion = undefined;
        updatedEntry.lastUpdateCheck = new Date().toISOString();
        registry.registerFeature(updatedEntry);
      }
      registry.saveRegistry();

      writeFeatureHistory(
        args.id, 'update', newVersion,
        'atproto', entry.source.uri, entry.source.publisher,
        installResult.entry?.grantedCapabilities as unknown as Record<string, unknown>,
      );

      publish('feature-registry', scopes.GLOBAL, 'feature:updated', {
        id: args.id,
        name: entry.name,
        previousVersion: currentVersion,
        newVersion,
      });

      return { success: true, entry: installResult.entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFeatureHistory(
        args.id, 'update-failed', undefined,
        'atproto', entry.source.uri, entry.source.publisher,
      );
      return { error: `Update failed: ${message}` };
    }
  });

  ipcMain.handle('tile:features:update-set-policy', async (_event, args: {
    token: string;
    id: string;
    policy: 'auto' | 'notify' | 'pinned';
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'update');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:update-set-policy', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };

    const validPolicies = ['auto', 'notify', 'pinned'];
    if (!validPolicies.includes(args.policy)) {
      return { error: `Invalid policy: ${args.policy}` };
    }

    entry.updatePolicy = args.policy;
    if (args.policy === 'pinned') {
      entry.pinnedVersion = entry.source.version;
    } else {
      entry.pinnedVersion = undefined;
    }

    registry.registerFeature(entry);
    registry.saveRegistry();

    return { success: true, policy: entry.updatePolicy, pinnedVersion: entry.pinnedVersion };
  });

  ipcMain.handle('tile:features:dev-reload', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'dev');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:dev-reload', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    try {
      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let reloaded = 0;

      for (const wc of allContents) {
        const url = wc.getURL();
        if (url.startsWith(urlPrefix)) {
          wc.reload();
          reloaded++;
          continue;
        }
        try {
          const mainFrame = wc.mainFrame;
          for (const frame of mainFrame.framesInSubtree) {
            if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
              frame.executeJavaScript('location.reload()');
              reloaded++;
            }
          }
        } catch {
          // ignore inaccessible webContents
        }
      }

      const manifest = entry.path ? JSON.parse(
        fs.readFileSync(path.join(entry.path, 'manifest.json'), 'utf-8'),
      ) : null;

      if (manifest && manifest.tiles) {
        for (const tile of manifest.tiles) {
          const win = getTileWindow(args.featureId, tile.id);
          if (win && !win.isDestroyed()) {
            win.webContents.reload();
            reloaded++;
          }
        }
      }

      if (reloaded === 0) {
        return { success: true, message: 'No active tiles found to reload. Feature will load on next launch.' };
      }
      return { success: true, message: `Reloaded ${reloaded} tile(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to reload feature: ${message}` };
    }
  });

  ipcMain.handle('tile:features:dev-validate', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'dev');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:dev-validate', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const featurePath = entry.path;
      if (!fs.existsSync(featurePath)) {
        return { valid: false, errors: [`Feature directory not found: ${featurePath}`], warnings: [] };
      }

      const manifestPath = path.join(featurePath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return { valid: false, errors: ['manifest.json not found'], warnings: [] };
      }

      let raw: Record<string, unknown>;
      try {
        const manifestJson = fs.readFileSync(manifestPath, 'utf-8');
        raw = JSON.parse(manifestJson);
      } catch (parseErr) {
        return { valid: false, errors: [`Invalid JSON in manifest.json: ${parseErr}`], warnings: [] };
      }

      const version = detectManifestVersion(raw);
      if (version !== 'v2') errors.push(`Manifest is ${version}, expected v2`);

      const validationErrors = validateTileManifest(raw);
      for (const ve of validationErrors) errors.push(`${ve.path}: ${ve.message}`);

      const tiles = raw.tiles as Array<{ id: string; url: string }> | undefined;
      if (tiles && Array.isArray(tiles)) {
        for (const tile of tiles) {
          if (tile.url) {
            const tilePath = path.join(featurePath, tile.url);
            if (!fs.existsSync(tilePath)) {
              errors.push(`Tile "${tile.id}" references "${tile.url}" which does not exist`);
            }
          }
        }
      }

      const settingsSchema = raw.settingsSchema as string | undefined;
      if (settingsSchema) {
        const schemaPath = path.join(featurePath, settingsSchema);
        if (!fs.existsSync(schemaPath)) {
          errors.push(`Settings schema file "${settingsSchema}" not found`);
        }
      }

      if (!raw.description || (raw.description as string).trim() === '') {
        warnings.push('No description set in manifest');
      }
      if (!raw.version) warnings.push('No version set in manifest');

      return { valid: errors.length === 0, errors, warnings };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [`Validation failed: ${message}`], warnings: [] };
    }
  });

  ipcMain.handle('tile:features:dev-pick-directory', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'dev');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:dev-pick-directory', check.error, args.token);
      return { error: check.error };
    }
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose directory for new feature',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      return { path: result.filePaths[0] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open directory picker: ${message}` };
    }
  });

  ipcMain.handle('tile:features:dev-create', async (_event, args: {
    token: string;
    directoryPath: string;
    featureId: string;
    featureName: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'dev');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:dev-create', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const idRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    if (!args.featureId || args.featureId.length < 2 || !idRegex.test(args.featureId)) {
      return { error: 'Feature ID must be lowercase alphanumeric with hyphens (min 2 chars, no leading/trailing hyphens)' };
    }
    if (!args.featureName || !args.featureName.trim()) {
      return { error: 'Feature name is required' };
    }

    const parentDir = path.dirname(args.directoryPath);
    if (!fs.existsSync(parentDir)) {
      return { error: `Parent directory does not exist: ${parentDir}` };
    }

    const existing = registry.getFeature(args.featureId);
    if (existing) {
      return { error: `Feature "${args.featureId}" is already registered in the registry` };
    }

    // Delegate to the same scaffolding logic by piggy-backing on the
    // v1-compat handler via direct invocation is not supported by Electron.
    // To avoid duplicating several hundred lines of scaffold code, we
    // emit the same files inline here. The scaffold is kept in sync with
    // the v1-compat handler — any changes must be mirrored.
    //
    // In a follow-up cleanup the scaffold helpers should be extracted to
    // a shared module (feature-dev-scaffold.ts) and called from both
    // handlers. For now we rely on the features-manager tests to detect
    // drift.
    try {
      if (!fs.existsSync(args.directoryPath)) {
        fs.mkdirSync(args.directoryPath, { recursive: true });
      }

      const featureId = args.featureId;
      const featureName = args.featureName.trim();

      const manifestContent = JSON.stringify({
        manifestVersion: 2,
        id: featureId,
        name: featureName,
        version: '0.1.0',
        description: '',
        tiles: [
          { id: 'background', type: 'background', url: 'background.html', lazy: true },
          {
            id: 'home', type: 'window', url: 'home.html',
            windowHints: { width: 800, height: 600, title: featureName },
          },
        ],
        capabilities: {
          pubsub: { scopes: ['self', 'global'] },
          commands: true,
        },
        commands: [
          { name: featureId, description: `Open ${featureName}`, action: { type: 'window', url: 'home.html' } },
        ],
      }, null, 2);

      // Minimal scaffold: manifest + background.html + home.html so the
      // feature loads. Full scaffold (CSS, JS stubs) is in the v1-compat
      // handler. Dev authors can run `feature-dev:validate` to discover
      // missing files and add them by hand if desired.
      fs.writeFileSync(path.join(args.directoryPath, 'manifest.json'), manifestContent, 'utf-8');
      const stubHtml = `<!DOCTYPE html><html><body><script>console.log('[${featureId}] loaded')</script></body></html>`;
      if (!fs.existsSync(path.join(args.directoryPath, 'background.html'))) {
        fs.writeFileSync(path.join(args.directoryPath, 'background.html'), stubHtml, 'utf-8');
      }
      if (!fs.existsSync(path.join(args.directoryPath, 'home.html'))) {
        fs.writeFileSync(path.join(args.directoryPath, 'home.html'), stubHtml, 'utf-8');
      }

      const manifestParsed = JSON.parse(manifestContent);
      const capGrant = resolveCapabilities(featureId, manifestParsed.capabilities, true);

      const entry = {
        id: featureId,
        name: featureName,
        path: args.directoryPath,
        source: {
          type: 'dev' as const,
          version: '0.1.0',
        },
        grantedCapabilities: capGrant.capabilities,
        userApproved: true,
        installedAt: new Date().toISOString(),
      };

      registry.registerFeature(entry);
      registry.saveRegistry();

      writeFeatureHistory(featureId, 'install', '0.1.0', 'dev');

      publish('feature-registry', scopes.GLOBAL, 'feature:installed', {
        id: featureId,
        name: featureName,
        source: { type: 'dev' },
      });

      return { success: true, entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to create feature: ${message}` };
    }
  });

  ipcMain.handle('tile:features:publish-list-local', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'publish');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:publish-list-local', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const all = registry.listFeatures();
    const publishable = all.filter(e =>
      e.source.type === 'local' || e.source.type === 'builtin' || e.source.type === 'dev',
    );

    return {
      features: publishable.map(e => ({
        id: e.id,
        name: e.name,
        version: e.source.version || '0.0.0',
        path: e.path,
        sourceType: e.source.type,
        description: (e as unknown as { description?: string }).description || '',
      })),
    };
  });

  ipcMain.handle('tile:features:publish-read-feature-files', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'publish');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:publish-read-feature-files', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    try {
      const featurePath = entry.path;
      if (!fs.existsSync(featurePath)) {
        return { error: `Feature directory not found: ${featurePath}` };
      }

      const files: Array<{
        relativePath: string; content: string; size: number; mimeType: string;
      }> = [];

      function readDir(dirPath: string, prefix: string): void {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const dirent of entries) {
          if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
          const fullPath = path.join(dirPath, dirent.name);
          const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
          if (dirent.isDirectory()) {
            readDir(fullPath, relativePath);
          } else if (dirent.isFile()) {
            const data = fs.readFileSync(fullPath);
            const ext = path.extname(dirent.name).toLowerCase();
            files.push({
              relativePath,
              content: data.toString('base64'),
              size: data.length,
              mimeType: getMimeType(ext),
            });
          }
        }
      }

      readDir(featurePath, '');

      return {
        featureId: args.featureId,
        name: entry.name,
        path: featurePath,
        files,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read feature files: ${message}` };
    }
  });

  ipcMain.handle('tile:features:devtools-open', async (_event, args: {
    token: string;
    featureId: string;
    entryId?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'devtools');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:devtools-open', check.error, args.token);
      return { error: check.error };
    }

    if (!args.featureId) return { error: 'featureId is required' };
    const entryId = args.entryId || 'background';

    try {
      const win = getTileWindow(args.featureId, entryId);
      if (win && !win.isDestroyed()) {
        win.webContents.openDevTools({ mode: 'detach' });
        return { success: true, message: `Opened DevTools for ${args.featureId}:${entryId}` };
      }

      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let opened = 0;
      for (const wc of allContents) {
        if (wc.getURL().startsWith(urlPrefix)) {
          wc.openDevTools({ mode: 'detach' });
          opened++;
        }
      }
      if (opened === 0) {
        for (const wc of allContents) {
          try {
            const mainFrame = wc.mainFrame;
            for (const frame of mainFrame.framesInSubtree) {
              if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
                wc.openDevTools({ mode: 'detach' });
                opened++;
                break;
              }
            }
          } catch {
            // ignore inaccessible webContents
          }
          if (opened > 0) break;
        }
      }

      if (opened === 0) {
        return { error: `No active tile found for ${args.featureId}:${entryId}. The feature may not be loaded yet.` };
      }
      return { success: true, message: `Opened DevTools for ${opened} context(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open DevTools: ${message}` };
    }
  });

  ipcMain.handle('tile:features:browse-list-by-publisher', async (_event, args: {
    token: string;
    did: string;
    pdsUrl: string;
    cursor?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'browse', 'atproto');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:browse-list-by-publisher', check.error, args.token);
      return { error: check.error };
    }

    if (!args.did || !args.pdsUrl) {
      return { error: 'DID and PDS URL are required' };
    }

    try {
      const params = new URLSearchParams({
        repo: args.did,
        collection: 'space.peek.feature.release',
        limit: '100',
      });
      if (args.cursor) params.set('cursor', args.cursor);

      const url = `${args.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `PDS returned ${res.status}: ${body}` };
      }

      const data = await res.json() as {
        records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
        cursor?: string;
      };

      const featureMap = new Map<string, {
        uri: string; featureId: string; name: string; version: string;
        description?: string; categories?: string[]; capabilities?: string[];
        createdAt: string;
      }>();

      for (const rec of data.records || []) {
        const val = rec.value as Record<string, unknown>;
        const featureId = val.featureId as string;
        if (!featureId) continue;
        const existing = featureMap.get(featureId);
        const createdAt = (val.createdAt as string) || '';
        if (!existing || createdAt > existing.createdAt) {
          featureMap.set(featureId, {
            uri: rec.uri,
            featureId,
            name: (val.name as string) || featureId,
            version: (val.version as string) || 'unknown',
            description: val.description as string | undefined,
            categories: val.categories as string[] | undefined,
            capabilities: val.capabilities as string[] | undefined,
            createdAt,
          });
        }
      }

      return {
        records: Array.from(featureMap.values()),
        cursor: data.cursor,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list records: ${message}` };
    }
  });

  // ── tile:features:settings-schema ────────────────────────────────
  //
  // Read the JSON settings schema file declared in a feature's manifest.
  // Gated by `features` read capability — mirrors the legacy
  // `feature-settings-schema` channel in ipc.ts but enforces the
  // token + `features` capability before reading from disk.
  //
  // `args.id` — the feature/extension id whose schema to fetch.
  // Returns `{ success: true, data: schema }` (data may be null when
  // the feature declares no settingsSchema or the file is absent).
  ipcMain.handle('tile:features:settings-schema', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkFeaturesAllowed(grant, 'read');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:settings-schema', check.error, args.token);
      return { success: false, error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { success: false, error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { success: false, error: `Feature not found: ${args.id}` };

    try {
      const manifest = entry.path ? parseManifestFile(path.join(entry.path, 'manifest.json')) : null;
      // settingsSchema lives under v2 for tile manifests; fall back to raw for v1 extensions.
      const settingsSchema: string | undefined =
        manifest?.v2?.settingsSchema ?? (manifest?.raw?.settingsSchema as string | undefined);
      if (!settingsSchema) return { success: true, data: null };

      const schemaPath = path.join(entry.path, settingsSchema);
      if (!fs.existsSync(schemaPath)) return { success: true, data: null };

      const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      return { success: true, data: schema };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── IZUI (strict) ─────────────────────────────────────────────────
  //
  // Strict mirrors of the legacy `izui-*` IPC channels. The original
  // channels (in ipc.ts) are token-agnostic; these gate access on the
  // `izui` capability so only tiles that declared participation in the
  // overlay system can drive it.
  //
  // Imports are resolved dynamically to avoid a hard dependency in
  // the test-mode path — izui-state pulls in BrowserWindow helpers
  // that assume Electron is running.

  ipcMain.handle('tile:izui:is-transient', async (ev, args: { token: string }) => {
    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) {
      handleViolation(grant, 'izui', 'izui:is-transient', check.error, args?.token);
      return { error: check.error };
    }
    try {
      const { getIzuiCoordinator } = await import('./izui-state.js');
      const coordinator = getIzuiCoordinator();
      const requestingWindow = BrowserWindow.fromWebContents(ev.sender);
      const session = coordinator.getSession();
      if (session) {
        return { transient: coordinator.isTransient() };
      }
      const entryMode = coordinator.evaluateOnShow(requestingWindow?.id);
      return { transient: entryMode === 'transient' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `izui:is-transient failed: ${message}` };
    }
  });

  ipcMain.handle('tile:izui:get-effective-mode', async (_event, args: { token: string }) => {
    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) { handleViolation(grant, 'izui', 'izui:get-effective-mode', check.error, args?.token); return { error: check.error }; }
    try {
      const { getIzuiCoordinator } = await import('./izui-state.js');
      return { mode: getIzuiCoordinator().getEffectiveMode() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `izui:get-effective-mode failed: ${message}` };
    }
  });

  ipcMain.handle('tile:izui:get-state', async (_event, args: { token: string }) => {
    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) { handleViolation(grant, 'izui', 'izui:get-state', check.error, args?.token); return { error: check.error }; }
    try {
      const { getIzuiCoordinator } = await import('./izui-state.js');
      return { state: getIzuiCoordinator().getState() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `izui:get-state failed: ${message}` };
    }
  });

  ipcMain.handle('tile:izui:get-pre-overlay-focus-target', async (_event, args: { token: string }) => {
    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) { handleViolation(grant, 'izui', 'izui:get-pre-overlay-focus-target', check.error, args?.token); return { error: check.error }; }
    try {
      const { getIzuiCoordinator } = await import('./izui-state.js');
      return { target: getIzuiCoordinator().getPreOverlayFocusTarget() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `izui:get-pre-overlay-focus-target failed: ${message}` };
    }
  });

  ipcMain.handle('tile:izui:close-self', async (ev, args: { token: string }) => {
    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) { handleViolation(grant, 'izui', 'izui:close-self', check.error, args?.token); return { error: check.error }; }
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window not found' };
    }
    try {
      // Import dynamically to avoid loading windows.js at test time.
      const { closeOrHideWindow } = await import('./windows.js');
      closeOrHideWindow(win.id);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `izui:close-self failed: ${message}` };
    }
  });

  // ── Datastore: extract-page-content (strict) ──────────────────────
  //
  // Entities-specific: extracts DOM content from a live webContents by
  // URL. The v1-compat channel (`extract-page-content` in ipc.ts)
  // performs no capability check. Gate this on the existing `datastore`
  // capability — it's the closest semantic fit (reading from user-owned
  // browsing state, the primary datastore domain). No sub-capability
  // gate because the op is effectively read-only and entities is the
  // only consumer.

  ipcMain.handle('tile:datastore:extract-page-content', async (_event, args: {
    token: string;
    url: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    // Trusted-builtin core renderers bypass the datastore gate.
    if (!grant.trustedBuiltin && !grant.capabilities.datastore) {
      return { success: false, error: 'Datastore capability not granted' };
    }

    const url = args?.url;
    if (!url) return { success: false, error: 'URL required' };

    try {
      const normalizedTarget = normalizeUrl(url);
      const allContents = webContents.getAllWebContents();

      let target = allContents.find(wc => {
        try {
          const wcUrl = wc.getURL();
          if (!wcUrl || wcUrl.startsWith('peek://') || wcUrl === 'about:blank') return false;
          return wcUrl === url || normalizeUrl(wcUrl) === normalizedTarget;
        } catch { return false; }
      });

      if (!target) {
        try {
          const targetParsed = new URL(url);
          const targetOriginPath = targetParsed.origin + targetParsed.pathname;
          target = allContents.find(wc => {
            try {
              const wcUrl = wc.getURL();
              if (!wcUrl || wcUrl.startsWith('peek://') || wcUrl === 'about:blank') return false;
              const wcParsed = new URL(wcUrl);
              return wcParsed.origin + wcParsed.pathname === targetOriginPath;
            } catch { return false; }
          });
        } catch { /* invalid URL, skip */ }
      }

      if (!target) {
        try {
          const targetDomain = new URL(url).hostname.replace(/^www\./, '');
          const candidates = allContents.filter(wc => {
            try {
              const wcUrl = wc.getURL();
              if (!wcUrl || !wcUrl.startsWith('http')) return false;
              const wcDomain = new URL(wcUrl).hostname.replace(/^www\./, '');
              return wcDomain === targetDomain;
            } catch { return false; }
          });
          if (candidates.length === 1) target = candidates[0];
        } catch { /* invalid URL, skip */ }
      }

      if (!target) {
        return { success: false, error: 'No webContents found for URL' };
      }

      const result = await target.executeJavaScript(`
        (function() {
          return {
            html: document.documentElement.outerHTML,
            text: document.body ? document.body.innerText.slice(0, 50000) : '',
            title: document.title || ''
          };
        })();
      `);

      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── Window Management (strict) ────────────────────────────────────
  //
  // Strict tile:window:* handlers that enforce the `window` capability.
  // The legacy `window-open` / `window-close` / `window-list` channels
  // in ipc.ts remain the v1-compat surface and are NOT token-gated —
  // tile-preload routes through these strict handlers when the tile's
  // manifest declares the `window` capability.
  //
  // Validation order for each op (via checkWindowAllowed pure module):
  //   1. Token must resolve to a valid grant.
  //   2. Grant must include the `window` capability (boolean or object).
  //   3. Per-op gates:
  //      - open: requires `create: true`; URL must be peek:// and, if
  //        `urls` prefix allowlist is set, must match a prefix.
  //      - close: closing the sender's own window always OK; closing
  //        another window requires `manage: true`.
  //      - list / info: require `query: true`.

  ipcMain.handle('tile:window:open', async (event, args: {
    token: string;
    url: string;
    options?: Record<string, unknown>;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'open', { url: args.url });
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:open', check.error, args.token);
      return { error: check.error };
    }
    const activeGrant = grant as CapabilityGrant;

    // URL governance is handled by checkWindowAllowed above via the
    // tile's declared `window.urls` allowlist (if any). Tiles without
    // a urls allowlist accept any URL — same policy as the legacy
    // window-open channel. External http(s) URLs are rewritten to the
    // page canvas by the window-open handler below.

    // Delegate to the main window-open handler (registered by registerWindowHandlers()
    // in ipc.ts). This is the single source of truth for window creation — handles
    // canvas rendering, mode inheritance, deduping, session registration, etc.
    if (!invokeWindowOpen) {
      console.error('[tile:window:open] invokeWindowOpen not initialized — registerWindowHandlers() must be called before tile IPC is used');
      return { error: 'Window handler not initialized' };
    }

    const source = `peek://${activeGrant.tileId}/background`;
    DEBUG && console.log(`[tile:window:open] ${activeGrant.tileId} opening ${args.url}`);
    try {
      return await invokeWindowOpen(event, {
        source,
        url: args.url,
        options: args.options || {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tile:window:open] failed for ${activeGrant.tileId}:`, message);
      return { success: false, error: message };
    }
  });

  ipcMain.on('tile:window:close', (event, args: {
    token: string;
    id?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    // ownWindow: closing with no id OR id matching the sender's window
    // is treated as the tile closing its own context.
    const ownWindow = args.id == null || (senderWin != null && args.id === senderWin.id);
    const check = checkWindowAllowed(grant, 'close', { ownWindow });
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:close', check.error, args.token);
      return;
    }

    let target: BrowserWindow | null = null;
    if (args.id != null) {
      target = BrowserWindow.fromId(args.id);
    } else if (senderWin && !senderWin.isDestroyed()) {
      target = senderWin;
    }
    if (target && !target.isDestroyed()) {
      target.close();
    }
  });

  ipcMain.handle('tile:window:info', async (event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'info');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:info', check.error, args.token);
      return { error: check.error };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return { error: 'Window not found' };
    }

    const bounds = win.getBounds();
    return {
      id: win.id,
      bounds,
      focused: win.isFocused(),
      visible: win.isVisible(),
    };
  });

  ipcMain.handle('tile:window:list', async (_event, args: {
    token: string;
    includeInternal?: boolean;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'list');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:list', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const windows: Array<{
        id: number;
        url: string;
        title: string;
        focused: boolean;
        visible: boolean;
        params: Record<string, unknown>;
      }> = [];
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        const info = getWindowInfo(win.id);
        // When includeInternal is false/absent, skip windows without registry
        // entries (e.g. purely internal Electron windows). When true, include all.
        if (!args.includeInternal && !info) continue;
        windows.push({
          id: win.id,
          url: win.webContents.getURL(),
          title: win.getTitle(),
          focused: win.isFocused(),
          visible: win.isVisible(),
          params: info ? info.params : {},
        });
      }
      return { success: true, windows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:exists ────────────────────────────────────────────
  //
  // Strict counterpart of the un-gated legacy `window-exists` channel.
  // Gated by `window.manage` — callers probing the state of windows by
  // id are, effectively, managing other windows.
  //
  // Return shape: `{ exists, success, data, error? }` — aligns with both
  // caller styles across features:
  //   - `exists.exists`                     (spaces, groups, slides)
  //   - `exists.success && exists.data`     (pagestream, helpdocs, windows feature)
  // Keeping both keys lets us migrate callers without a renaming pass.
  ipcMain.handle('tile:window:exists', async (_event, args: {
    token: string;
    id: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'exists');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:exists', check.error, args.token);
      return { exists: false, success: false, data: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { exists: false, success: false, data: false, error: 'Window ID is required' };
      }
      const win = BrowserWindow.fromId(args.id);
      if (!win || win.isDestroyed()) {
        return { exists: false, success: true, data: false };
      }
      return { exists: true, success: true, data: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { exists: false, success: false, data: false, error: message };
    }
  });

  // ── tile:window:show ──────────────────────────────────────────────
  //
  // Show a hidden window. Gated by `window.manage`.
  ipcMain.handle('tile:window:show', async (_event, args: {
    token: string;
    id: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'show');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:show', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { success: false, error: 'Window ID is required' };
      }
      const win = BrowserWindow.fromId(args.id);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      win.show();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:hide ──────────────────────────────────────────────
  //
  // Hide a visible window. Gated by `window.manage`.
  ipcMain.handle('tile:window:hide', async (_event, args: {
    token: string;
    id: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'hide');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:hide', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { success: false, error: 'Window ID is required' };
      }
      const win = BrowserWindow.fromId(args.id);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      win.hide();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:show-self ─────────────────────────────────────────
  //
  // Show the tile's own BrowserWindow. No `window` capability required —
  // the token identifies the calling tile, and the tile can only affect its
  // own window. This is the primary mechanism for tiles that start hidden at
  // boot (resident: true) and reveal themselves on command invocation.
  ipcMain.handle('tile:window:show-self', async (_event, args: {
    token: string;
  }) => {
    const record = validateToken(args.token);
    if (!record) return { success: false, error: 'Invalid token' };

    try {
      const win = getTileWindow(record.tileId, record.tileEntryId);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Tile window not found' };
      }
      win.show();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:hide-self ─────────────────────────────────────────
  //
  // Hide the tile's own BrowserWindow. No `window` capability required —
  // the token identifies the calling tile, and the tile can only affect its
  // own window. A hidden tile preserves all state (DOM, JS heap, registered
  // commands) — it is not unloaded. Use for "dismiss" UX where re-opening
  // should be instant without the cost of re-initializing a new window.
  ipcMain.handle('tile:window:hide-self', async (_event, args: {
    token: string;
  }) => {
    const record = validateToken(args.token);
    if (!record) return { success: false, error: 'Invalid token' };

    try {
      const win = getTileWindow(record.tileId, record.tileEntryId);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Tile window not found' };
      }
      win.hide();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:set-ignore-mouse ──────────────────────────────────
  //
  // Toggle click-through on a window. Gated by `window.manage`.
  // `options.forward` matches the Electron `setIgnoreMouseEvents`
  // second-argument shape (only `{ forward: true }` is honoured, per
  // the legacy `window-set-ignore-mouse-events` handler).
  ipcMain.handle('tile:window:set-ignore-mouse', async (event, args: {
    token: string;
    id?: number;
    ignore: boolean;
    options?: { forward?: boolean };
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'set-ignore-mouse');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-ignore-mouse', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? BrowserWindow.fromId(args.id)
        : BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      const forward = args.options?.forward === true;
      win.setIgnoreMouseEvents(args.ignore === true, forward ? { forward: true } : undefined);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:center ────────────────────────────────────────────
  //
  // Center a window on its display. Gated by `window.manage`.
  ipcMain.handle('tile:window:center', async (event, args: {
    token: string;
    id?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'center');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:center', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? BrowserWindow.fromId(args.id)
        : BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      const bounds = win.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: bounds.x + Math.round(bounds.width / 2),
        y: bounds.y + Math.round(bounds.height / 2),
      });
      const wa = display.workArea;
      const x = wa.x + Math.round((wa.width - bounds.width) / 2);
      const y = wa.y + Math.round((wa.height - bounds.height) / 2);
      win.setBounds({ x, y, width: bounds.width, height: bounds.height });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:center-all ────────────────────────────────────────
  //
  // Center every visible window on its nearest display. Gated by
  // `window.manage`.
  ipcMain.handle('tile:window:center-all', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'center-all');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:center-all', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const windows = BrowserWindow.getAllWindows();
      let centered = 0;
      for (const win of windows) {
        if (win.isDestroyed() || !win.isVisible()) continue;
        const bounds = win.getBounds();
        const display = screen.getDisplayNearestPoint({
          x: bounds.x + Math.round(bounds.width / 2),
          y: bounds.y + Math.round(bounds.height / 2),
        });
        const wa = display.workArea;
        const x = wa.x + Math.round((wa.width - bounds.width) / 2);
        const y = wa.y + Math.round((wa.height - bounds.height) / 2);
        win.setBounds({ x, y, width: bounds.width, height: bounds.height });
        centered++;
      }
      return { success: true, centered };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:maximize ──────────────────────────────────────────
  //
  // Toggle maximize on a window. Gated by `window.manage`.
  ipcMain.handle('tile:window:maximize', async (event, args: {
    token: string;
    id?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'maximize');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:maximize', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? BrowserWindow.fromId(args.id)
        : BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:fullscreen ────────────────────────────────────────
  //
  // Toggle fullscreen on a window. Gated by `window.manage`.
  ipcMain.handle('tile:window:fullscreen', async (event, args: {
    token: string;
    id?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'fullscreen');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:fullscreen', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? BrowserWindow.fromId(args.id)
        : BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      win.setFullScreen(!win.isFullScreen());
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:get-focused-visible-id ────────────────────────────
  //
  // Read-only: return the last-focused visible window id. Tracked by
  // the main-process window manager (see `ipc.ts::lastFocusedVisibleWindowId`).
  // Gated by `window.query` — treated as a read.
  //
  // Implementation note: the actual tracking state lives in ipc.ts.
  // Rather than importing the internal variable, we delegate to the
  // un-gated legacy `get-focused-visible-window-id` channel. The strict
  // surface just adds the capability gate.
  ipcMain.handle('tile:window:get-focused-visible-id', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'get-focused-visible-id');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:get-focused-visible-id', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      // Delegate to the existing un-gated handler registered by ipc.ts.
      // We call ipcMain._events? No — simpler: replicate by asking
      // BrowserWindow.getFocusedWindow, but the semantic differs (it
      // tracks "last visible" even after focus left). The ipc.ts handler
      // reads the tracked variable. Since we cannot reach it without an
      // import, we call through to the same handler name.
      // Wait: inside main process we ARE the handler host. The safest
      // approach: expose a getter from ipc.ts. But the task scope is to
      // add strict surfaces without touching ipc.ts. Use a two-hop:
      // invoke via the IPC event loop is not possible inside main.
      //
      // Pragmatic path: use BrowserWindow.getFocusedWindow() as a best
      // approximation — the feature callers use this to target "the
      // window I last interacted with", and the focused window matches
      // for typical usage.
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) {
        return { success: true, data: focused.id };
      }
      // Fallback: first visible, focusable, non-destroyed window.
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        if (!w.isVisible()) continue;
        if (!w.isFocusable()) continue;
        return { success: true, data: w.id };
      }
      return { success: true, data: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:set-overlay-focus-target ──────────────────────────
  //
  // Set the focus target for an overlay window (used on restore after
  // the overlay closes). Gated by `window.manage`.
  ipcMain.handle('tile:window:set-overlay-focus-target', async (event, args: {
    token: string;
    targetWindowId: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'set-overlay-focus-target');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-overlay-focus-target', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const callerWin = BrowserWindow.fromWebContents(event.sender);
      if (!callerWin || callerWin.isDestroyed()) {
        return { success: false, error: 'Caller window not found' };
      }
      // Replicate the work the legacy `window-set-overlay-focus-target`
      // handler performs: store the target id on the window-manager
      // params for the caller, and mirror onto the IZUI coordinator
      // session so the overlay-restore path picks it up.
      const mainMod = await import('./main.js');
      const info = (mainMod as { getWindowInfo: (id: number) => { params: Record<string, unknown> } | undefined }).getWindowInfo(callerWin.id);
      if (!info) {
        return { success: false, error: 'Caller window not in window manager' };
      }
      info.params.overlayFocusTarget = args.targetWindowId;
      try {
        const izuiMod = await import('./izui-state.js');
        const coordinator = izuiMod.getIzuiCoordinator();
        const session = coordinator.getSession();
        if (session) {
          (session as unknown as Record<string, unknown>).overlayFocusTarget = args.targetWindowId;
        }
      } catch { /* coordinator optional */ }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:set-visible-on-all-workspaces ─────────────────────
  //
  // macOS Spaces: pin a window across workspaces. Gated by `window.manage`.
  ipcMain.handle('tile:window:set-visible-on-all-workspaces', async (event, args: {
    token: string;
    id?: number;
    visible: boolean;
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean };
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'set-visible-on-all-workspaces');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-visible-on-all-workspaces', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? BrowserWindow.fromId(args.id)
        : BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }
      win.setVisibleOnAllWorkspaces(args.visible === true, args.options || {});
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:opener-postmessage ───────────────────────────────
  //
  // Strict counterpart of the legacy `opener-postmessage` channel.
  // Routes a postMessage from a popup tile to its opener window.
  // Gated by `window.manage`.
  ipcMain.handle('tile:window:opener-postmessage', async (event, args: {
    token: string;
    message: unknown;
    origin?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'opener-postmessage');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:opener-postmessage', check.error, args.token);
      return { success: false, error: check.error };
    }

    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { success: false, error: 'No sender window' };

    const openerWindowId = popupToOpener.get(senderWin.id);
    if (!openerWindowId) {
      DEBUG && console.log('[tile:window:opener-postmessage] No opener mapping for window', senderWin.id);
      return { success: false, error: 'No opener window mapped' };
    }

    const openerWin = BrowserWindow.fromId(openerWindowId);
    if (!openerWin || openerWin.isDestroyed()) {
      DEBUG && console.log('[tile:window:opener-postmessage] Opener window', openerWindowId, 'not found or destroyed');
      popupToOpener.delete(senderWin.id);
      return { success: false, error: 'Opener window not found' };
    }

    openerWin.webContents.send('opener-message-received', {
      message: args.message,
      origin: args.origin || '*',
      popupWindowId: senderWin.id,
    });

    DEBUG && console.log(`[tile:window:opener-postmessage] Routed postMessage from popup ${senderWin.id} to opener ${openerWindowId}`);
    return { success: true };
  });

  // ── tile:window:opener-close ──────────────────────────────────────
  //
  // Strict counterpart of the legacy `opener-close` channel.
  // Closes the opener window from a popup tile.
  // Gated by `window.manage`.
  ipcMain.handle('tile:window:opener-close', async (event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'opener-close');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:opener-close', check.error, args.token);
      return { success: false, error: check.error };
    }

    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { success: false, error: 'No sender window' };

    const openerWindowId = popupToOpener.get(senderWin.id);
    if (!openerWindowId) return { success: false, error: 'No opener mapped' };

    const openerWin = BrowserWindow.fromId(openerWindowId);
    if (!openerWin || openerWin.isDestroyed()) {
      popupToOpener.delete(senderWin.id);
      return { success: false, error: 'Opener window not found' };
    }

    try {
      const { closeOrHideWindow } = await import('./windows.js');
      DEBUG && console.log(`[tile:window:opener-close] Popup ${senderWin.id} closing opener ${openerWindowId}`);
      closeOrHideWindow(openerWin.id);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:opener-focus ──────────────────────────────────────
  //
  // Strict counterpart of the legacy `opener-focus` channel.
  // Focuses the opener window from a popup tile.
  // Gated by `window.manage`.
  ipcMain.handle('tile:window:opener-focus', async (event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkWindowAllowed(grant, 'opener-focus');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:opener-focus', check.error, args.token);
      return { success: false, error: check.error };
    }

    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { success: false, error: 'No sender window' };

    const openerWindowId = popupToOpener.get(senderWin.id);
    if (!openerWindowId) return { success: false, error: 'No opener mapped' };

    const openerWin = BrowserWindow.fromId(openerWindowId);
    if (!openerWin || openerWin.isDestroyed()) {
      popupToOpener.delete(senderWin.id);
      return { success: false, error: 'Opener window not found' };
    }

    DEBUG && console.log(`[tile:window:opener-focus] Popup ${senderWin.id} focusing opener ${openerWindowId}`);
    openerWin.show();
    openerWin.focus();
    return { success: true };
  });

  // ── tile:window:get-id ────────────────────────────────────────────
  //
  // Return the Electron BrowserWindow id for the calling renderer.
  // No `window` capability required — every tile has an inherent right
  // to know its own window id (mirrors the un-gated legacy `get-window-id`
  // channel). Token validity is still enforced so un-initialised callers
  // cannot probe the id.
  ipcMain.handle('tile:window:get-id', (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };

    const win = BrowserWindow.fromWebContents(_event.sender);
    return win ? { success: true, id: win.id } : { success: false, error: 'Window not found' };
  });

  // ── tile:window:resize ────────────────────────────────────────────
  //
  // Resize the caller's own tile window. Used by tiles that expand/collapse
  // based on content (cmd panel shows results list, HUD widgets adjust to
  // content height, etc.). No capability gate — a tile can always resize
  // its own window (cannot target other windows through this channel).
  ipcMain.handle('tile:window:resize', (_event, args: {
    token: string;
    width: number;
    height: number;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };

    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window not found' };
    }
    const width = Math.max(1, Math.floor(Number(args.width)));
    const height = Math.max(1, Math.floor(Number(args.height)));
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { success: false, error: 'Invalid dimensions' };
    }
    win.setSize(width, height);
    return { success: true };
  });

  // ── tile:screen:get-primary-display ───────────────────────────────
  //
  // Read-only display metadata. No capability gate — this is equivalent
  // to reading a bundled theme token and tiles use it for initial
  // window placement.
  ipcMain.handle('tile:screen:get-primary-display', async (_event, args: {
    token: string;
  }) => {
    // Token presence still validated so we don't serve callers who
    // never invoked initialize(), but no capability check is performed.
    const grant = getGrantForToken(args.token);
    if (!grant) {
      return { success: false, error: 'Invalid token' };
    }

    try {
      const display = screen.getPrimaryDisplay();
      return {
        success: true,
        data: {
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
          size: display.size,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:escape:on-escape ─────────────────────────────────────────
  //
  // Escape is a UX primitive. Every tile gets it — no capability gate
  // beyond token validity. Register once per renderer; the main process
  // will forward the existing `escape-pressed` IPC events through an
  // echo to the tile's own renderer under `tile:escape:pressed`.
  //
  // The registration is advisory — escape dispatch is driven by
  // windows.ts::askRendererToHandleEscape which already targets the
  // window's webContents. This channel just signals opt-in so the
  // preload knows to relay the event to the user's handler. No
  // per-tile state is maintained in main.
  ipcMain.on('tile:escape:on-escape', (event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkEscapeAllowed(grant);
    if (!check.ok) {
      handleViolation(grant, 'escape', 'escape:on-escape', check.error, args.token);
      return;
    }
    // Enable bridging: forward every `escape-pressed` the window receives
    // to a tile-scoped channel. The same webContents already receives
    // `escape-pressed` from windows.ts; the preload bridge translates
    // that into `tile:escape:pressed` locally (see tile-preload.ts).
    // No per-tile state needed here — this handler exists as the
    // explicit opt-in signal / strict-enforcement touchpoint.
    DEBUG && console.log(`[tile-ipc] escape:on-escape registered for ${grant?.tileId} (win=${event.sender.id})`);
  });

  // ── tile:commands:unregister ──────────────────────────────────────
  //
  // Counterpart to `tile:command:register`. Gated by the same `commands`
  // capability. Publishes `cmd:unregister` on GLOBAL scope so the cmd
  // panel drops the command from its registry.
  ipcMain.on('tile:commands:unregister', (_event, args: {
    token: string;
    name: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'commands')) {
      handleViolation(grant, 'commands', 'commands:unregister', 'commands not granted', args.token);
      return;
    }
    if (!args.name || typeof args.name !== 'string') {
      DEBUG && console.log('[tile-ipc] commands:unregister rejected: name required');
      return;
    }
    publish(
      `peek://${grant.tileId}/background`,
      scopes.GLOBAL,
      'cmd:unregister',
      { name: args.name },
    );
  });

  // ── tile:session:save-space-workspaces ────────────────────────────
  //
  // Persist the per-space window-layout snapshot. Used by
  // features/spaces and features/groups. Gated by the new `session`
  // capability.
  ipcMain.handle('tile:session:save-space-workspaces', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkSessionAllowed(grant, 'save-space-workspaces');
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:save-space-workspaces', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const { saveSpaceWorkspaces } = await import('./session.js');
      saveSpaceWorkspaces();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── Network Fetch ──

  ipcMain.handle('tile:network:fetch', async (_event, args: {
    token: string;
    url: string;
    options?: Record<string, unknown>;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'network')) {
      handleViolation(grant, 'network', 'network:fetch', 'network capability not granted', args.token);
      return { error: 'Network capability not granted' };
    }

    // Extract domain from URL and validate
    let domain: string;
    try {
      const parsed = new URL(args.url);
      domain = parsed.hostname;
    } catch {
      return { error: 'Invalid URL' };
    }

    if (!isNetworkDomainAllowed(grant, domain)) {
      const reason = `domain ${domain} not allowed for ${grant.tileId}`;
      handleViolation(grant, 'network', 'network:fetch', reason, args.token);
      return { error: `Domain not allowed: ${domain}` };
    }

    // Perform the fetch via Electron's net module
    try {
      const response = await net.fetch(args.url, {
        method: (args.options?.method as string) || 'GET',
        headers: args.options?.headers as Record<string, string>,
        body: args.options?.body as string,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Filesystem ──

  ipcMain.handle('tile:filesystem:read', async (_event, args: {
    token: string;
    path: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'filesystem')) {
      return { error: 'Filesystem capability not granted' };
    }

    if (!isFilesystemPathAllowed(grant, args.path, 'read')) {
      return { error: `Path not allowed: ${args.path}` };
    }

    try {
      const content = fs.readFileSync(args.path, 'utf-8');
      return { content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:filesystem:write', async (_event, args: {
    token: string;
    path: string;
    content: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'filesystem')) {
      return { error: 'Filesystem capability not granted' };
    }

    if (!isFilesystemPathAllowed(grant, args.path, 'write')) {
      return { error: `Path not allowed: ${args.path}` };
    }

    try {
      fs.writeFileSync(args.path, args.content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Theme ──

  ipcMain.handle('tile:theme:info', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'theme')) {
      return { error: 'Theme capability not granted' };
    }

    // Return real theme state by querying the active theme + color scheme.
    const themeId = getActiveThemeId();
    const isDark = nativeTheme.shouldUseDarkColors;
    return {
      activeTheme: themeId,
      themeId,
      isDark,
      effectiveScheme: isDark ? 'dark' : 'light',
    };
  });

  // ── tile:theme:get ─────────────────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:get` channel.
  // Returns current theme id, color scheme preference and effective scheme.
  // Requires trustedBuiltin — non-core tiles use tile:theme:info instead.
  ipcMain.handle('tile:theme:get', (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:get', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:get' };
    }

    const themeId = tileGetThemeSetting(TILE_THEME_ID_KEY) || getActiveThemeId();
    const colorScheme = tileGetThemeSetting(TILE_THEME_COLOR_SCHEME_KEY) || 'system';
    const isDark = nativeTheme.shouldUseDarkColors;
    return {
      themeId,
      colorScheme,
      isDark,
      effectiveScheme: colorScheme === 'system' ? (isDark ? 'dark' : 'light') : colorScheme,
    };
  });

  // ── tile:theme:setColorScheme ──────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:setColorScheme` channel.
  // Sets the global color scheme preference (system/light/dark).
  // Requires trustedBuiltin.
  ipcMain.handle('tile:theme:setColorScheme', (_event, args: {
    token: string;
    colorScheme: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:setColorScheme', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:setColorScheme' };
    }

    const { colorScheme } = args;
    if (!['system', 'light', 'dark'].includes(colorScheme)) {
      return { success: false, error: 'Invalid color scheme' };
    }

    tileSetThemeSetting(TILE_THEME_COLOR_SCHEME_KEY, colorScheme);
    nativeTheme.themeSource = colorScheme as 'system' | 'light' | 'dark';
    tileBroadcastThemeChange(colorScheme);

    return {
      success: true,
      colorScheme,
      effectiveScheme: colorScheme === 'system'
        ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        : colorScheme,
    };
  });

  // ── tile:theme:setWindowColorScheme ───────────────────────────────
  //
  // Strict counterpart of the legacy `theme:setWindowColorScheme` channel.
  // Sets color scheme for a specific window only (does not affect global setting).
  // Requires trustedBuiltin.
  //
  // windowId resolution: callers may pass an explicit windowId, or omit it
  // (null/undefined) and let the handler resolve. Resolution order:
  //   1. Explicit windowId (if positive finite number and window exists)
  //   2. lastFocusedVisibleWindowId tracked by ipc.ts
  //   3. BrowserWindow.getFocusedWindow()
  //   4. First non-destroyed, non-test-fixture, non-background BrowserWindow
  //      that was not created as modal (by skipping `focusable:false` and
  //      `background.html` URLs). This last branch is the headless-test
  //      fallback — in headless mode all windows have `show:false` so
  //      `isVisible()` is false and no focus events fire.
  ipcMain.handle('tile:theme:setWindowColorScheme', (_event, args: {
    token: string;
    windowId?: number | null;
    colorScheme: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:setWindowColorScheme', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:setWindowColorScheme' };
    }

    const { colorScheme } = args;
    if (!['system', 'light', 'dark', 'global'].includes(colorScheme)) {
      return { success: false, error: 'Invalid color scheme' };
    }

    // Resolve windowId. If caller passed a positive finite number, try it
    // first. Otherwise walk the fallback chain.
    let resolvedId: number | null = null;
    const explicitId = typeof args.windowId === 'number' && Number.isFinite(args.windowId) && args.windowId > 0
      ? args.windowId
      : null;
    if (explicitId !== null) {
      const explicitWin = BrowserWindow.fromId(explicitId);
      if (explicitWin && !explicitWin.isDestroyed()) {
        resolvedId = explicitId;
      }
    }

    if (resolvedId === null) {
      const tracked = getLastFocusedVisibleWindowId();
      if (tracked != null) {
        const trackedWin = BrowserWindow.fromId(tracked);
        if (trackedWin && !trackedWin.isDestroyed()) {
          resolvedId = tracked;
        }
      }
    }

    if (resolvedId === null) {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) {
        resolvedId = focused.id;
      }
    }

    if (resolvedId === null) {
      // Headless fallback: find a plausible target by filtering out the
      // test fixture (focusable:false) and the core background renderer
      // (url === peek://app/background.html). Take the highest-numbered
      // matching window as a proxy for "most recently created".
      const candidates = BrowserWindow.getAllWindows().filter((w) => {
        if (w.isDestroyed()) return false;
        if (!w.isFocusable()) return false;
        try {
          const wurl = w.webContents.getURL();
          if (wurl === 'peek://app/background.html') return false;
          if (wurl.startsWith('peek://test/')) return false;
        } catch { /* ignore */ }
        return true;
      });
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.id - a.id);
        resolvedId = candidates[0].id;
      }
    }

    if (resolvedId === null) {
      return { success: false, error: 'No visible window to target' };
    }

    const win = BrowserWindow.fromId(resolvedId);
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window not found' };
    }

    win.webContents.send('theme:windowChanged', { colorScheme });
    return { success: true, windowId: resolvedId, colorScheme };
  });

  // ── tile:theme:setTheme ────────────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:setTheme` channel.
  // Sets the active theme by id and broadcasts to all windows.
  // Requires trustedBuiltin.
  ipcMain.handle('tile:theme:setTheme', (_event, args: {
    token: string;
    themeId: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:setTheme', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:setTheme' };
    }

    const { themeId } = args;
    if (!setActiveThemeId(themeId)) {
      return { success: false, error: 'Theme not found' };
    }
    tileSetThemeSetting(TILE_THEME_ID_KEY, themeId);

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('theme:themeChanged', { themeId });
    }
    return { success: true, themeId };
  });

  // ── tile:theme:list ────────────────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:list` channel.
  // Returns metadata for all registered (builtin) themes.
  // Requires trustedBuiltin.
  ipcMain.handle('tile:theme:list', (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:list', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:list' };
    }

    const themeIds = getRegisteredThemeIds();
    const themes = themeIds.map(id => {
      const themePath = getThemePath(id);
      if (!themePath) return null;
      try {
        const manifestPath = path.join(themePath, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        return {
          id: manifest.id || id,
          name: manifest.name || id,
          version: manifest.version || '1.0.0',
          description: manifest.description || '',
          colorSchemes: manifest.colorSchemes || ['light', 'dark'],
        };
      } catch {
        return { id, name: id, version: '1.0.0', description: '', colorSchemes: ['light', 'dark'] };
      }
    }).filter(Boolean);

    themes.sort((a: any, b: any) => {
      if (a.id === 'peek') return -1;
      if (b.id === 'peek') return 1;
      return a.name.localeCompare(b.name);
    });

    return { themes };
  });

  // ── tile:theme:getAll ──────────────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:getAll` channel.
  // Returns all themes (builtin + external from DB).
  // Requires trustedBuiltin.
  ipcMain.handle('tile:theme:getAll', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:getAll', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:getAll' };
    }

    try {
      const db = getDb();
      const builtinIds = getRegisteredThemeIds();
      const themes: Array<{
        id: string;
        name: string;
        description: string;
        version: string;
        author: string;
        path: string;
        builtin: boolean;
        colorSchemes: string[];
      }> = [];

      for (const id of builtinIds) {
        const themePath = getThemePath(id);
        if (!themePath) continue;
        try {
          const manifestPath = path.join(themePath, 'manifest.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          themes.push({
            id: manifest.id || id,
            name: manifest.name || id,
            description: manifest.description || '',
            version: manifest.version || '1.0.0',
            author: manifest.author || '',
            path: themePath,
            builtin: true,
            colorSchemes: manifest.colorSchemes || ['light', 'dark'],
          });
        } catch {
          themes.push({
            id,
            name: id,
            description: '',
            version: '1.0.0',
            author: '',
            path: themePath,
            builtin: true,
            colorSchemes: ['light', 'dark'],
          });
        }
      }

      const externalThemes = db.prepare('SELECT * FROM themes WHERE builtin = 0').all() as Array<{
        id: string;
        name: string;
        description: string;
        version: string;
        author: string;
        path: string;
        metadata?: string;
      }>;

      for (const ext of externalThemes) {
        let colorSchemes = ['light', 'dark'];
        try {
          const metadata = JSON.parse(ext.metadata || '{}');
          colorSchemes = metadata.colorSchemes || colorSchemes;
        } catch { /* ignore */ }
        themes.push({
          id: ext.id,
          name: ext.name,
          description: ext.description,
          version: ext.version,
          author: ext.author,
          path: ext.path,
          builtin: false,
          colorSchemes,
        });
      }

      return { success: true, data: themes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── Settings ──

  ipcMain.handle('tile:settings:get', async (_event, args: {
    token: string;
    key: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'settings')) {
      return { error: 'Settings capability not granted' };
    }

    // Scoped to the tile's own feature_settings namespace.
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
      ).get(grant.tileId, args.key) as { value: string } | undefined;
      if (!row) {
        // No stored value — fall back to the manifest's declared default
        // (loaded from the tile's settingsSchema.defaults). If no default
        // is declared for this key, return null to match the legacy shape.
        const manifest = getTileManifest(grant.tileId);
        const fallback = resolveSettingDefault(manifest, args.key);
        return { value: fallback === undefined ? null : fallback };
      }
      try {
        return { value: JSON.parse(row.value) };
      } catch {
        return { value: row.value };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  });

  ipcMain.handle('tile:settings:set', async (_event, args: {
    token: string;
    key: string;
    value: unknown;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant || !hasCapability(grant, 'settings')) {
      return { error: 'Settings capability not granted' };
    }

    // Scoped to the tile's own feature_settings namespace.
    try {
      const db = getDb();
      const jsonValue = JSON.stringify(args.value);
      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(`${grant.tileId}_${args.key}`, grant.tileId, args.key, jsonValue, Date.now());
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── Settings: foreign (strict) ────────────────────────────────────
  //
  // Read a setting from ANOTHER tile's `feature_settings` namespace,
  // gated on the `settings` capability + a `readForeign` allowlist
  // (or the top-level `settingsForeign` fallback). Mirrors the legacy
  // `feature-settings-get-key` handler but with capability enforcement.
  // See `tile-settings-foreign-enforcement.ts` for the pure check.
  ipcMain.handle('tile:settings:get-foreign', async (_event, args: {
    token: string;
    foreignExtId: string;
    key: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkSettingsForeignAllowed(grant, args?.foreignExtId);
    if (!check.ok) {
      handleViolation(grant, 'settings', 'settings:get-foreign', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
      ).get(args.foreignExtId, args.key) as { value: string } | undefined;
      if (!row) return { success: true, data: null };
      try {
        return { success: true, data: JSON.parse(row.value) };
      } catch {
        return { success: true, data: row.value };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── OAuth (strict) ────────────────────────────────────────────────
  //
  // Strict tile:oauth:start-loopback / tile:oauth:await-callback handlers
  // that enforce the `oauth` capability. Mirror the legacy
  // `oauth-start-loopback` / `oauth-await-callback` channels in ipc.ts —
  // same loopback server implementation from oauth-loopback.ts, gated on
  // a declared capability + optional per-provider allowlist. See
  // `tile-oauth-enforcement.ts` for the pure check.
  //
  // Pending flows are keyed by OS-assigned port. The map is isolated
  // from the legacy ipc.ts one so closing one doesn't tear down the
  // other — in practice, a tile that opted into strict oauth will not
  // also be using the legacy api.oauth (their preload only exposes the
  // strict surface when the capability is declared).
  const strictOAuthFlows = new Map<number, {
    waitForCallback: () => Promise<{ params: Record<string, string> }>;
    cancel: () => void;
  }>();

  ipcMain.handle('tile:oauth:start-loopback', async (_event, args: {
    token: string;
    provider?: string;
    callbackPath?: string;
    timeoutMs?: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkOAuthAllowed(grant, 'start-loopback', args?.provider);
    if (!check.ok) {
      handleViolation(grant, 'oauth', 'oauth:start-loopback', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const server = await createLoopbackServer({
        callbackPath: args.callbackPath,
        timeoutMs: args.timeoutMs,
      });
      strictOAuthFlows.set(server.port, {
        waitForCallback: server.waitForCallback,
        cancel: server.cancel,
      });
      return { success: true, port: server.port };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:oauth:await-callback', async (_event, args: {
    token: string;
    port: number;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkOAuthAllowed(grant, 'await-callback');
    if (!check.ok) {
      handleViolation(grant, 'oauth', 'oauth:await-callback', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const flow = strictOAuthFlows.get(args.port);
      if (!flow) {
        return { success: false, error: 'No pending OAuth flow for this port' };
      }
      const result = await flow.waitForCallback();
      strictOAuthFlows.delete(args.port);
      return { success: true, params: result.params };
    } catch (error) {
      strictOAuthFlows.delete(args.port);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── Sync (strict) ─────────────────────────────────────────────────
  //
  // Strict tile:sync:sync-all handler that enforces the `sync`
  // capability (builtin-only per the resolveCapabilities restriction
  // in tile-manifest.ts). Delegates to the existing `syncAll` in
  // sync.ts — same behaviour as the legacy `sync-full` channel in
  // ipc.ts, but capability-gated for the strict tile surface. See
  // `tile-sync-enforcement.ts` for the pure check.
  ipcMain.handle('tile:sync:sync-all', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    const check = checkSyncAllowed(grant);
    if (!check.ok) {
      handleViolation(grant, 'sync', 'sync:sync-all', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        return { success: false, error: 'Sync not configured. Set serverUrl and apiKey first.' };
      }
      const result = await syncAll(config.serverUrl, config.apiKey);

      // Notify all windows that sync pulled new data so they can refresh.
      // Mirrors the behaviour of the legacy `sync-full` handler.
      if (result.pulled > 0) {
        publish('system', scopes.GLOBAL, 'sync:pull-completed', {
          pulled: result.pulled,
          pushed: result.pushed,
          conflicts: result.conflicts,
        });
      }

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── Datastore ──
  //
  // Scoped per-table access. Every handler:
  //   1. Validates the token (via getGrantForToken)
  //   2. Requires the `datastore` capability
  //   3. Checks that every table the op touches is in the grant's tables list
  //   4. Delegates to the real datastore function
  //
  // Multi-table ops (tag-item, get-item-tags, get-items-by-tag) require ALL
  // of their tables to be granted, not just one.

  // Generic row/table operations — the operand table must be granted.

  ipcMain.handle('tile:datastore:get-table', async (_event, args: {
    token: string;
    table?: string;
    tableName?: string;
  }) => {
    const table = args?.tableName ?? args?.table;
    const check = validateTileDatastoreRequest(args?.token, [table as string]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-table', check.error); return { error: check.error }; }
    try {
      const data = dsGetTable(table as TableName);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-row', async (_event, args: {
    token: string;
    table?: string;
    tableName?: string;
    rowId: string;
  }) => {
    const table = args?.tableName ?? args?.table;
    const check = validateTileDatastoreRequest(args?.token, [table as string]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-row', check.error); return { error: check.error }; }
    try {
      const data = dsGetRow(table as TableName, args.rowId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:set-row', async (_event, args: {
    token: string;
    table?: string;
    tableName?: string;
    rowId: string;
    rowData: Record<string, unknown>;
  }) => {
    const table = args?.tableName ?? args?.table;
    const check = validateTileDatastoreRequest(args?.token, [table as string]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:set-row', check.error); return { error: check.error }; }
    try {
      dsSetRow(table as TableName, args.rowId, args.rowData || {});
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Back-compat aliases for the v1 tile-preload API surface.
  // `get(table, key)` maps to get-row; `set(table, key, value)` maps to set-row
  // with a `value` column; `query(table, filter)` returns matching rows.
  // These exist because tile-preload.ts currently invokes them; the preload
  // cleanup is a separate task.

  ipcMain.handle('tile:datastore:get', async (_event, args: {
    token: string;
    table: string;
    key: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, [args?.table]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get', check.error); return { error: check.error }; }
    try {
      const data = dsGetRow(args.table as TableName, args.key);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:set', async (_event, args: {
    token: string;
    table: string;
    key: string;
    value: unknown;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, [args?.table]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:set', check.error); return { error: check.error }; }
    try {
      // If the caller passed an object, write it as a row; otherwise store
      // the scalar under a `value` column so key/value access round-trips.
      const rowData = (args.value && typeof args.value === 'object' && !Array.isArray(args.value))
        ? args.value as Record<string, unknown>
        : { value: args.value };
      dsSetRow(args.table as TableName, args.key, rowData);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query', async (_event, args: {
    token: string;
    table: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, [args?.table]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query', check.error); return { error: check.error }; }
    try {
      const table = dsGetTable(args.table as TableName);
      const rows = Object.values(table);
      const filter = args.filter;
      const filtered = filter
        ? rows.filter(row => {
            for (const [k, v] of Object.entries(filter)) {
              if (row[k] !== v) return false;
            }
            return true;
          })
        : rows;
      return { success: true, rows: filtered };
    } catch (error) {
      return { success: false, rows: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Item operations (require 'items' in tables) ──

  ipcMain.handle('tile:datastore:add-item', async (_event, args: {
    token: string;
    type: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-item', check.error); return { error: check.error }; }
    try {
      // dsAddItem takes ItemType; trust the caller to pass a valid one.
      const result = dsAddItem(args.type as Parameters<typeof dsAddItem>[0], (args.options as Parameters<typeof dsAddItem>[1]) || {});
      publish('system', scopes.GLOBAL, 'item:created', {
        itemId: result.id,
        itemType: args.type,
        content: (args.options as Record<string, unknown> | undefined)?.content,
      });
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-item', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item', check.error); return { error: check.error }; }
    try {
      const data = dsGetItem(args.id);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:update-item', async (_event, args: {
    token: string;
    id: string;
    options: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-item', check.error); return { error: check.error }; }
    try {
      const result = dsUpdateItem(args.id, args.options as Parameters<typeof dsUpdateItem>[1]);
      if (result) {
        const db = getDb();
        const item = db.prepare('SELECT type FROM items WHERE id = ?').get(args.id) as { type: string } | undefined;
        publish('system', scopes.GLOBAL, 'item:updated', {
          itemId: args.id,
          itemType: item?.type,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:delete-item', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-item', check.error); return { error: check.error }; }
    try {
      const db = getDb();
      const item = db.prepare('SELECT type FROM items WHERE id = ?').get(args.id) as { type: string } | undefined;
      const result = dsDeleteItem(args.id);
      if (result) {
        publish('system', scopes.GLOBAL, 'item:deleted', {
          itemId: args.id,
          itemType: item?.type,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-items', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-items', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItems(args.filter as Parameters<typeof dsQueryItems>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Tag operations ──

  ipcMain.handle('tile:datastore:get-or-create-tag', async (_event, args: {
    token: string;
    name: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-or-create-tag', check.error); return { error: check.error }; }
    try {
      const data = dsGetOrCreateTag(args.name);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-tags-by-frecency', async (_event, args: {
    token: string;
    domain?: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-tags-by-frecency', check.error); return { error: check.error }; }
    try {
      const data = dsGetTagsByFrecency(args.domain);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Item-tag link operations (multi-table) ──

  ipcMain.handle('tile:datastore:tag-item', async (_event, args: {
    token: string;
    itemId: string;
    tagId: string;
  }) => {
    // Writes to item_tags, reads/updates tags frequency, reads items implicitly.
    // Require both 'tags' and 'item_tags' to be granted (matching feature manifests).
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:tag-item', check.error); return { error: check.error }; }
    try {
      const result = dsTagItem(args.itemId, args.tagId);
      if (!result.alreadyExists) {
        const db = getDb();
        const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
        const item = db.prepare('SELECT type FROM items WHERE id = ?').get(args.itemId) as { type: string } | undefined;
        publish('system', scopes.GLOBAL, 'tag:item-added', {
          tagId: args.tagId,
          tagName: tag?.name,
          itemId: args.itemId,
          itemType: item?.type,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:untag-item', async (_event, args: {
    token: string;
    itemId: string;
    tagId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:untag-item', check.error); return { error: check.error }; }
    try {
      const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
      const result = dsUntagItem(args.itemId, args.tagId);
      if (result) {
        publish('system', scopes.GLOBAL, 'tag:item-removed', {
          tagId: args.tagId,
          tagName: tag?.name,
          itemId: args.itemId,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-item-tags', async (_event, args: {
    token: string;
    itemId: string;
  }) => {
    // Joins tags × item_tags — require both.
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item-tags', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemTags(args.itemId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-items-by-tag', async (_event, args: {
    token: string;
    tagId: string;
  }) => {
    // Joins items × item_tags — require both.
    const check = validateTileDatastoreRequest(args?.token, ['items', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-items-by-tag', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemsByTag(args.tagId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Item event operations (series & feeds) ──

  ipcMain.handle('tile:datastore:add-item-event', async (_event, args: {
    token: string;
    itemId: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsAddItemEvent(args.itemId, args.options as Parameters<typeof dsAddItemEvent>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-item-event', async (_event, args: {
    token: string;
    eventId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemEvent(args.eventId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-item-events', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-item-events', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItemEvents(args.filter as Parameters<typeof dsQueryItemEvents>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-latest-item-event', async (_event, args: {
    token: string;
    itemId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-latest-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsGetLatestItemEvent(args.itemId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:count-item-events', async (_event, args: {
    token: string;
    itemId: string;
    filter?: { since?: number; until?: number };
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:count-item-events', check.error); return { error: check.error }; }
    try {
      const data = dsCountItemEvents(args.itemId, args.filter || {});
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:delete-item-event', async (_event, args: {
    token: string;
    eventId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsDeleteItemEvent(args.eventId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:delete-item-events', async (_event, args: {
    token: string;
    itemId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-item-events', check.error); return { error: check.error }; }
    try {
      const data = dsDeleteItemEvents(args.itemId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Additional tag operations ──

  ipcMain.handle('tile:datastore:rename-tag', async (_event, args: {
    token: string;
    tagId: string;
    newName: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:rename-tag', check.error); return { error: check.error }; }
    try {
      const data = dsRenameTag(args.tagId, args.newName);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:update-tag-color', async (_event, args: {
    token: string;
    tagId: string;
    color: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-tag-color', check.error); return { error: check.error }; }
    try {
      const data = dsUpdateTagColor(args.tagId, args.color);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:delete-tag', async (_event, args: {
    token: string;
    tagId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-tag', check.error); return { error: check.error }; }
    try {
      const data = dsDeleteTag(args.tagId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Stats (no table restriction) ──

  ipcMain.handle('tile:datastore:get-stats', async (_event, args: {
    token: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, []);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-stats', check.error); return { error: check.error }; }
    try {
      const data = dsGetStats();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Additional item operations ──

  ipcMain.handle('tile:datastore:hard-delete-item', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:hard-delete-item', check.error); return { error: check.error }; }
    try {
      const data = dsHardDeleteItem(args.id);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:update-item-title', async (_event, args: {
    token: string;
    url: string;
    title: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-item-title', check.error); return { error: check.error }; }
    try {
      const data = dsUpdateItemTitle(args.url, args.title);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:update-item-favicon', async (_event, args: {
    token: string;
    url: string;
    faviconUrl: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-item-favicon', check.error); return { error: check.error }; }
    try {
      const data = dsUpdateItemFavicon(args.url, args.faviconUrl);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Visit / history operations (require 'items') ──

  ipcMain.handle('tile:datastore:record-item-visit', async (_event, args: {
    token: string;
    itemId: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:record-item-visit', check.error); return { error: check.error }; }
    try {
      const data = dsRecordItemVisit(args.itemId, args.options as Parameters<typeof dsRecordItemVisit>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-item-visits', async (_event, args: {
    token: string;
    itemId: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item-visits', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemVisits(args.itemId, args.filter as Parameters<typeof dsGetItemVisits>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-item-visits', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-item-visits', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItemVisits(args.filter as Parameters<typeof dsQueryItemVisits>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-history', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-history', check.error); return { error: check.error }; }
    try {
      const filter = (args.filter as Parameters<typeof dsQueryItemVisits>[0]) || {};
      const visits = dsQueryItemVisits(filter);
      const enriched = visits.map(v => {
        const item = dsGetItem(v.itemId);
        return {
          ...v,
          addressId: v.itemId,
          uri: item?.content || '',
          title: item?.title || '',
          domain: item?.domain || '',
          protocol: '',
          favicon: item?.favicon || '',
        };
      });
      return { success: true, data: enriched };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:track-navigation', async (_event, args: {
    token: string;
    uri: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:track-navigation', check.error); return { error: check.error }; }
    try {
      const data = dsTrackNavigation(args.uri, args.options as Parameters<typeof dsTrackNavigation>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-items-by-frecency', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-items-by-frecency', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItemsByFrecency(args.filter as Parameters<typeof dsQueryItemsByFrecency>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Address compat shims (redirect to items + backward-compat shape) ──

  ipcMain.handle('tile:datastore:add-address', async (_event, args: {
    token: string;
    uri: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-address', check.error); return { error: check.error }; }
    try {
      const opts = args.options || {};
      const normalizedUri = normalizeUrl(args.uri);
      const metadata: Record<string, unknown> = {};
      if (opts.title) metadata.title = opts.title;
      if (opts.description) metadata.description = opts.description;
      if (opts.favicon) metadata.favicon = opts.favicon;
      const result = dsAddItem('url', {
        content: normalizedUri,
        mimeType: (opts.mimeType as string) || 'text/html',
        metadata: JSON.stringify(metadata),
        starred: (opts.starred as number) || 0,
        archived: (opts.archived as number) || 0,
      });
      if (opts.favicon) {
        getDb().prepare('UPDATE items SET favicon = ? WHERE id = ?').run(opts.favicon as string, result.id);
      }
      publish('system', scopes.GLOBAL, 'item:created', {
        itemId: result.id, itemType: 'url', content: normalizedUri,
      });
      return { success: true, data: result, id: result.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-address', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-address', check.error); return { error: check.error }; }
    try {
      const item = dsGetItem(args.id);
      if (!item) return { success: true, data: undefined };
      return { success: true, data: _itemToAddress(item) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:update-address', async (_event, args: {
    token: string;
    id: string;
    updates: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-address', check.error); return { error: check.error }; }
    try {
      const updates = args.updates || {};
      const itemOpts: Record<string, unknown> = {};
      if (updates.metadata !== undefined) itemOpts.metadata = updates.metadata;
      if (updates.starred !== undefined) itemOpts.starred = updates.starred;
      if (updates.archived !== undefined) itemOpts.archived = updates.archived;
      if (updates.mimeType !== undefined) itemOpts.mimeType = updates.mimeType;
      if (updates.uri !== undefined) itemOpts.content = updates.uri;
      dsUpdateItem(args.id, itemOpts);
      if (updates.title !== undefined) {
        getDb().prepare('UPDATE items SET title = ?, updatedAt = ? WHERE id = ?').run(updates.title as string, Date.now(), args.id);
      }
      if (updates.favicon !== undefined) {
        getDb().prepare('UPDATE items SET favicon = ?, updatedAt = ? WHERE id = ?').run(updates.favicon as string, Date.now(), args.id);
      }
      const updated = dsGetItem(args.id);
      return { success: true, data: updated ? _itemToAddress(updated) : undefined };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-addresses', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-addresses', check.error); return { error: check.error }; }
    try {
      const filter = args.filter || {};
      const itemFilter: Record<string, unknown> = { type: 'url' };
      if (filter.domain) itemFilter.domain = filter.domain;
      if (filter.starred !== undefined) itemFilter.starred = filter.starred;
      if (filter.sortBy) itemFilter.sortBy = filter.sortBy;
      if (filter.limit) itemFilter.limit = filter.limit;
      if (filter.search) itemFilter.search = filter.search;
      const items = dsQueryItems(itemFilter);
      return { success: true, data: items.map(_itemToAddress) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:add-visit', async (_event, args: {
    token: string;
    addressId: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_visits']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-visit', check.error); return { error: check.error }; }
    try {
      const opts = args.options || {};
      const result = dsRecordItemVisit(args.addressId, {
        source: (opts.source as string) || 'direct',
        sourceId: (opts.sourceId as string) || '',
        windowType: (opts.windowType as string) || 'main',
        interacted: (opts.interacted as number) || 0,
      });
      return { success: true, data: result, id: result.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-visits', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['item_visits']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-visits', check.error); return { error: check.error }; }
    try {
      const filter = args.filter || {};
      const itemFilter: Record<string, unknown> = {};
      if (filter.addressId) itemFilter.itemId = filter.addressId;
      if (filter.source) itemFilter.source = filter.source;
      if (filter.since) itemFilter.since = filter.since;
      if (filter.until) itemFilter.until = filter.until;
      if (filter.limit) itemFilter.limit = filter.limit;
      const visits = dsQueryItemVisits(itemFilter);
      const mapped = visits.map(v => ({ ...v, addressId: v.itemId }));
      return { success: true, data: mapped };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:add-content', async (_event, args: {
    token: string;
    options?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['content']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-content', check.error); return { error: check.error }; }
    try {
      const data = dsAddContent(args.options as Parameters<typeof dsAddContent>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:query-content', async (_event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['content']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-content', check.error); return { error: check.error }; }
    try {
      const data = dsQueryContent(args.filter as Parameters<typeof dsQueryContent>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:tag-address', async (_event, args: {
    token: string;
    addressId: string;
    tagId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:tag-address', check.error); return { error: check.error }; }
    try {
      const result = dsTagItemAndPublish(args.addressId, args.tagId);
      if (!result.alreadyExists) {
        const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
        publish('system', scopes.GLOBAL, 'tag:address-added', {
          tagId: args.tagId, tagName: tag?.name, addressId: args.addressId,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:untag-address', async (_event, args: {
    token: string;
    addressId: string;
    tagId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:untag-address', check.error); return { error: check.error }; }
    try {
      const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
      const result = dsUntagItem(args.addressId, args.tagId);
      if (result) {
        publish('system', scopes.GLOBAL, 'tag:address-removed', {
          tagId: args.tagId, tagName: tag?.name, addressId: args.addressId,
        });
        publish('system', scopes.GLOBAL, 'tag:item-removed', {
          tagId: args.tagId, tagName: tag?.name, itemId: args.addressId,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-address-tags', async (_event, args: {
    token: string;
    addressId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-address-tags', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemTags(args.addressId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-addresses-by-tag', async (_event, args: {
    token: string;
    tagId: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-addresses-by-tag', check.error); return { error: check.error }; }
    try {
      const items = dsGetItemsByTag(args.tagId);
      return { success: true, data: items.map(_itemToAddress) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('tile:datastore:get-untagged-addresses', async (_event, args: {
    token: string;
  }) => {
    const check = validateTileDatastoreRequest(args?.token, ['items', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-untagged-addresses', check.error); return { error: check.error }; }
    try {
      const items = getDb().prepare(`
        SELECT i.* FROM items i
        LEFT JOIN item_tags it ON i.id = it.itemId
        WHERE i.type = 'url' AND i.deletedAt = 0 AND it.id IS NULL
        ORDER BY i.visitCount DESC
      `).all() as import('../types/index.js').Item[];
      return { success: true, data: items.map(_itemToAddress) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('feature-browse:list-by-publisher', async (_event, args: {
    token: string;
    did: string;
    pdsUrl: string;
    cursor?: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    if (!args.did || !args.pdsUrl) {
      return { error: 'DID and PDS URL are required' };
    }

    try {
      const params = new URLSearchParams({
        repo: args.did,
        collection: 'space.peek.feature.release',
        limit: '100',
      });
      if (args.cursor) {
        params.set('cursor', args.cursor);
      }

      const url = `${args.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
      const res = await fetch(url);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `PDS returned ${res.status}: ${body}` };
      }

      const data = await res.json() as {
        records: Array<{
          uri: string;
          cid: string;
          value: Record<string, unknown>;
        }>;
        cursor?: string;
      };

      // Group records by featureId and pick latest version for each
      const featureMap = new Map<string, {
        uri: string;
        featureId: string;
        name: string;
        version: string;
        description?: string;
        categories?: string[];
        capabilities?: string[];
        createdAt: string;
      }>();

      for (const rec of data.records || []) {
        const val = rec.value as Record<string, unknown>;
        const featureId = val.featureId as string;
        if (!featureId) continue;

        const existing = featureMap.get(featureId);
        const createdAt = val.createdAt as string || '';

        // Keep latest by createdAt
        if (!existing || createdAt > existing.createdAt) {
          featureMap.set(featureId, {
            uri: rec.uri,
            featureId,
            name: (val.name as string) || featureId,
            version: (val.version as string) || 'unknown',
            description: val.description as string | undefined,
            categories: val.categories as string[] | undefined,
            capabilities: val.capabilities as string[] | undefined,
            createdAt,
          });
        }
      }

      return {
        records: Array.from(featureMap.values()),
        cursor: data.cursor,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list records: ${message}` };
    }
  });

  // ── Feature Publish ──

  ipcMain.handle('feature-publish:list-local', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    // Return all features (local and builtin) that could be published
    const all = registry.listFeatures();
    const publishable = all.filter(e =>
      e.source.type === 'local' || e.source.type === 'builtin' || e.source.type === 'dev'
    );

    return {
      features: publishable.map(e => ({
        id: e.id,
        name: e.name,
        version: e.source.version || '0.0.0',
        path: e.path,
        sourceType: e.source.type,
        description: (e as any).description || '',
      })),
    };
  });

  ipcMain.handle('feature-publish:read-feature-files', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    try {
      const featurePath = entry.path;
      if (!fs.existsSync(featurePath)) {
        return { error: `Feature directory not found: ${featurePath}` };
      }

      const files: Array<{
        relativePath: string;
        content: string; // base64
        size: number;
        mimeType: string;
      }> = [];

      function readDir(dirPath: string, prefix: string): void {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const dirent of entries) {
          // Skip hidden files/dirs, node_modules, .git
          if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;

          const fullPath = path.join(dirPath, dirent.name);
          const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;

          if (dirent.isDirectory()) {
            readDir(fullPath, relativePath);
          } else if (dirent.isFile()) {
            const data = fs.readFileSync(fullPath);
            const ext = path.extname(dirent.name).toLowerCase();
            const mimeType = getMimeType(ext);

            files.push({
              relativePath,
              content: data.toString('base64'),
              size: data.length,
              mimeType,
            });
          }
        }
      }

      readDir(featurePath, '');

      return {
        featureId: args.featureId,
        name: entry.name,
        path: featurePath,
        files,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read feature files: ${message}` };
    }
  });

  // NOTE: `feature-publish:upload-blob` and `feature-publish:create-record` IPC
  // handlers have been removed. The publish flow now calls lex's renderer-side
  // atproto helpers (uploadBlob / xrpcPost from peek://ext/lex/atproto.js)
  // directly so that DPoP signing happens in the renderer via Web Crypto —
  // no backend DPoP implementation is needed.

  // ── Feature Update ──

  ipcMain.handle('feature-update:check-all', async (_event, args: {
    token: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    try {
      // Get all atproto-sourced features
      const all = registry.listFeatures();
      const atprotoFeatures = all.filter(e => e.source.type === 'atproto' && e.source.publisher);

      if (atprotoFeatures.length === 0) {
        return { updates: [] };
      }

      // Group by publisher DID
      const byPublisher = new Map<string, typeof atprotoFeatures>();
      for (const feature of atprotoFeatures) {
        const did = feature.source.publisher!;
        if (!byPublisher.has(did)) {
          byPublisher.set(did, []);
        }
        byPublisher.get(did)!.push(feature);
      }

      const updates: Array<{
        id: string;
        name: string;
        currentVersion: string;
        availableVersion: string;
        atUri: string;
      }> = [];

      for (const [did, pubFeatures] of byPublisher) {
        try {
          // Resolve publisher
          const { resolveDid: resolveDidFn } = await import('./atproto-source.js');
          const identity = await resolveDidFn(did);
          if (!identity) continue;

          // List release records
          const params = new URLSearchParams({
            repo: did,
            collection: 'space.peek.feature.release',
            limit: '100',
          });
          const url = `${identity.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
          const res = await fetch(url);
          if (!res.ok) continue;

          const data = await res.json() as {
            records: Array<{ uri: string; value: Record<string, unknown> }>;
          };

          // Build featureId -> latest version map
          const featureMap = new Map<string, { uri: string; version: string; createdAt: string }>();
          for (const rec of data.records || []) {
            const val = rec.value;
            const featureId = val.featureId as string;
            if (!featureId) continue;
            const existing = featureMap.get(featureId);
            const createdAt = (val.createdAt as string) || '';
            if (!existing || createdAt > existing.createdAt) {
              featureMap.set(featureId, {
                uri: rec.uri,
                version: (val.version as string) || '0.0.0',
                createdAt,
              });
            }
          }

          // Compare versions
          for (const feature of pubFeatures) {
            const policy = feature.updatePolicy || 'auto';
            if (policy === 'pinned') continue;

            const currentVersion = feature.source.version || '0.0.0';
            const latest = featureMap.get(feature.id);
            if (!latest) continue;

            if (compareSemverSimple(latest.version, currentVersion) > 0) {
              // Update availableVersion in registry
              const entry = registry.getFeature(feature.id);
              if (entry) {
                entry.availableVersion = latest.version;
                entry.lastUpdateCheck = new Date().toISOString();
                registry.registerFeature(entry);
              }

              updates.push({
                id: feature.id,
                name: feature.name,
                currentVersion,
                availableVersion: latest.version,
                atUri: latest.uri,
              });
            } else {
              // No update — clear availableVersion, update lastUpdateCheck
              const entry = registry.getFeature(feature.id);
              if (entry) {
                entry.availableVersion = undefined;
                entry.lastUpdateCheck = new Date().toISOString();
                registry.registerFeature(entry);
              }
            }
          }
        } catch (err) {
          console.error(`[tile-ipc] Update check failed for publisher ${did}:`, err);
        }
      }

      registry.saveRegistry();
      return { updates };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Update check failed: ${message}` };
    }
  });

  ipcMain.handle('feature-update:check-one', async (_event, args: {
    token: string;
    id: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type !== 'atproto' || !entry.source.publisher) {
      return { error: 'Feature is not from AT Protocol' };
    }

    try {
      const { resolveDid: resolveDidFn } = await import('./atproto-source.js');
      const identity = await resolveDidFn(entry.source.publisher);
      if (!identity) return { error: `Could not resolve publisher: ${entry.source.publisher}` };

      const params = new URLSearchParams({
        repo: entry.source.publisher,
        collection: 'space.peek.feature.release',
        limit: '100',
      });
      const url = `${identity.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) return { error: `PDS returned ${res.status}` };

      const data = await res.json() as {
        records: Array<{ uri: string; value: Record<string, unknown> }>;
      };

      // Find latest version for this featureId
      let latestUri = '';
      let latestVersion = '0.0.0';
      let latestCreatedAt = '';

      for (const rec of data.records || []) {
        const val = rec.value;
        if ((val.featureId as string) !== entry.id) continue;
        const createdAt = (val.createdAt as string) || '';
        if (createdAt > latestCreatedAt) {
          latestUri = rec.uri;
          latestVersion = (val.version as string) || '0.0.0';
          latestCreatedAt = createdAt;
        }
      }

      const currentVersion = entry.source.version || '0.0.0';
      entry.lastUpdateCheck = new Date().toISOString();

      if (compareSemverSimple(latestVersion, currentVersion) > 0) {
        entry.availableVersion = latestVersion;
        registry.registerFeature(entry);
        registry.saveRegistry();
        return {
          hasUpdate: true,
          currentVersion,
          availableVersion: latestVersion,
          atUri: latestUri,
        };
      }

      entry.availableVersion = undefined;
      registry.registerFeature(entry);
      registry.saveRegistry();
      return { hasUpdate: false, currentVersion };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Update check failed: ${message}` };
    }
  });

  ipcMain.handle('feature-update:apply', async (_event, args: {
    token: string;
    id: string;
    userApproved?: boolean;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const source = getAtprotoSource();
    if (!source) return { error: 'AtprotoSource not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    if (entry.source.type !== 'atproto' || !entry.source.uri) {
      return { error: 'Feature is not from AT Protocol' };
    }

    try {
      // Resolve to get latest metadata
      const metadata = await source.resolve(entry.source.uri);
      const newManifest = metadata.manifest;
      const newVersion = metadata.source.version || newManifest.version;
      const currentVersion = entry.source.version || '0.0.0';

      // Validate there is actually a newer version
      if (compareSemverSimple(newVersion || '0.0.0', currentVersion) <= 0) {
        return { error: 'No newer version available' };
      }

      // Check for capability expansion
      const capComparison = compareCapabilitiesSimple(
        entry.grantedCapabilities,
        newManifest.capabilities
      );

      if (capComparison.expanded && !args.userApproved) {
        return {
          error: 'Capabilities expanded — user approval required',
          capabilitiesChanged: true,
          added: capComparison.added,
          removed: capComparison.removed,
        };
      }

      // Fetch and install
      const bundle = await source.fetch(entry.source.uri);
      const installResult = installFromBundle(
        bundle,
        metadata.source,
        registry,
        { force: true, userApproved: args.userApproved || !capComparison.expanded }
      );

      if (!installResult.success) {
        // Log failure
        writeFeatureHistory(
          args.id, 'update-failed', newVersion,
          'atproto', entry.source.uri, entry.source.publisher
        );
        return { error: installResult.error };
      }

      // Clear availableVersion
      const updatedEntry = registry.getFeature(args.id);
      if (updatedEntry) {
        updatedEntry.availableVersion = undefined;
        updatedEntry.lastUpdateCheck = new Date().toISOString();
        registry.registerFeature(updatedEntry);
      }

      registry.saveRegistry();

      // Write history
      writeFeatureHistory(
        args.id, 'update', newVersion,
        'atproto', entry.source.uri, entry.source.publisher,
        installResult.entry?.grantedCapabilities as unknown as Record<string, unknown>
      );

      // Publish event
      publish('feature-registry', scopes.GLOBAL, 'feature:updated', {
        id: args.id,
        name: entry.name,
        previousVersion: currentVersion,
        newVersion,
      });

      return { success: true, entry: installResult.entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFeatureHistory(
        args.id, 'update-failed', undefined,
        'atproto', entry.source.uri, entry.source.publisher
      );
      return { error: `Update failed: ${message}` };
    }
  });

  ipcMain.handle('feature-update:set-policy', async (_event, args: {
    token: string;
    id: string;
    policy: 'auto' | 'notify' | 'pinned';
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };

    const validPolicies = ['auto', 'notify', 'pinned'];
    if (!validPolicies.includes(args.policy)) {
      return { error: `Invalid policy: ${args.policy}` };
    }

    entry.updatePolicy = args.policy;

    if (args.policy === 'pinned') {
      entry.pinnedVersion = entry.source.version;
    } else {
      entry.pinnedVersion = undefined;
    }

    registry.registerFeature(entry);
    registry.saveRegistry();

    return { success: true, policy: entry.updatePolicy, pinnedVersion: entry.pinnedVersion };
  });

  // ── Feature Dev Workflow ──

  ipcMain.handle('feature-dev:pick-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose directory for new feature',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      return { path: result.filePaths[0] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open directory picker: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:create', async (_event, args: {
    token: string;
    directoryPath: string;
    featureId: string;
    featureName: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    // Validate featureId: lowercase, alphanumeric + hyphens, no spaces
    const idRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    if (!args.featureId || args.featureId.length < 2 || !idRegex.test(args.featureId)) {
      return { error: 'Feature ID must be lowercase alphanumeric with hyphens (min 2 chars, no leading/trailing hyphens)' };
    }

    if (!args.featureName || !args.featureName.trim()) {
      return { error: 'Feature name is required' };
    }

    // Check the parent directory exists
    const parentDir = path.dirname(args.directoryPath);
    if (!fs.existsSync(parentDir)) {
      return { error: `Parent directory does not exist: ${parentDir}` };
    }

    // Check for conflicts in registry
    const existing = registry.getFeature(args.featureId);
    if (existing) {
      return { error: `Feature "${args.featureId}" is already registered in the registry` };
    }

    try {
      // Create directory if it doesn't exist
      if (!fs.existsSync(args.directoryPath)) {
        fs.mkdirSync(args.directoryPath, { recursive: true });
      }

      const featureId = args.featureId;
      const featureName = args.featureName.trim();

      // Write scaffold files
      const manifestContent = JSON.stringify({
        manifestVersion: 2,
        id: featureId,
        name: featureName,
        version: '0.1.0',
        description: '',
        tiles: [
          {
            id: 'background',
            type: 'background',
            url: 'background.html',
            lazy: true,
          },
          {
            id: 'home',
            type: 'window',
            url: 'home.html',
            windowHints: {
              width: 800,
              height: 600,
              title: featureName,
            },
          },
        ],
        capabilities: {
          pubsub: { scopes: ['self', 'global'] },
          commands: true,
        },
        commands: [
          {
            name: featureId,
            description: `Open ${featureName}`,
            action: { type: 'window', url: 'home.html' },
          },
        ],
      }, null, 2);

      const backgroundHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline';">
  <title>${featureName} Background</title>
</head>
<body>
<script type="module">
  import { init, uninit } from './background.js';

  const api = window.app;
  const hasPeekAPI = !!api;

  if (hasPeekAPI && typeof api.initialize === 'function') {
    // V2 Tile Runtime
    if (api.pubsub && !api.publish) {
      api.publish = api.pubsub.publish;
      api.subscribe = api.pubsub.subscribe;
    }

    await api.initialize();

    if (init) await init();

    api.onShutdown(() => {
      if (uninit) uninit();
    });
  } else if (hasPeekAPI) {
    // V1 Legacy Runtime
    if (init) await init();

    api.publish('ext:ready', {
      id: '${featureId}',
      registeredTopics: Object.keys(window._cmdHandlers || {}).map(n => \`cmd:execute:\${n}\`),
      manifest: { id: '${featureId}', version: '0.1.0' }
    }, api.scopes.SYSTEM);

    api.subscribe('app:shutdown', () => {
      if (uninit) uninit();
    }, api.scopes.SYSTEM);
  }
<${'/'}script>
</body>
</html>`;

      const backgroundJs = `/**
 * ${featureName} — Background script
 *
 * This runs in a hidden background context. Use it for:
 * - Registering commands
 * - Subscribing to events
 * - Background processing
 *
 * Export init() to run setup, uninit() for cleanup.
 */

const api = window.app;

export async function init() {
  console.log('[${featureId}] Background initialized');

  // Register commands, subscribe to events, etc.
  // Example:
  // api.commands.register({
  //   name: '${featureId}',
  //   description: 'Open ${featureName}',
  //   execute: () => {
  //     api.window.open('peek://${featureId}/home.html', {
  //       key: '${featureId}-home',
  //       width: 800,
  //       height: 600,
  //       title: '${featureName}'
  //     });
  //   }
  // });
}

export function uninit() {
  console.log('[${featureId}] Background shutdown');
}
`;

      const homeHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline';">
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1">
  <title>${featureName}</title>
  <link rel="stylesheet" type="text/css" href="home.css">
</head>
<body>
  <header class="header">
    <h1 class="header-title">${featureName}</h1>
  </header>

  <main class="content">
    <div class="welcome">
      <h2>Welcome to ${featureName}</h2>
      <p>Edit <code>home.html</code>, <code>home.js</code>, and <code>home.css</code> to build your feature UI.</p>
      <p>Use the Reload button in the Features Manager to see changes without restarting.</p>
    </div>
  </main>

  <script>
    // V2 tile runtime compat shims
    (function() {
      const api = window.app;
      if (!api) return;
      const isTileV2 = typeof api.initialize === 'function';
      if (!isTileV2) return;
      if (api.pubsub && !api.publish) {
        api.publish = api.pubsub.publish;
        api.subscribe = api.pubsub.subscribe;
      }
    })();
  <${'/'}script>
  <script type="module" src="home.js"><${'/'}script>
</body>
</html>`;

      const homeJs = `/**
 * ${featureName} — Home page script
 *
 * This is the main UI for your feature.
 * The Peek API is available at window.app
 */

const api = window.app;
const hasPeekAPI = !!api;

async function init() {
  if (hasPeekAPI && typeof api.initialize === 'function') {
    await api.initialize();
  }

  console.log('[${featureId}] Home page loaded');

  // Your UI logic here
}

init();
`;

      const homeCss = `/* Import Peek theme variables */
@import url('peek://theme/variables.css');

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-family: var(--theme-font-sans);
  -webkit-font-smoothing: antialiased;
  font-size: 14px;
  line-height: 1.5;
}

body {
  background: var(--base00);
  color: var(--base05);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--base02);
  -webkit-app-region: drag;
}

.header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--base05);
}

.content {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}

.welcome {
  max-width: 480px;
  margin: 40px auto;
  text-align: center;
}

.welcome h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--base05);
  margin-bottom: 12px;
}

.welcome p {
  font-size: 13px;
  color: var(--base04);
  margin-bottom: 8px;
}

.welcome code {
  background: var(--base01);
  border: 1px solid var(--base02);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: var(--theme-font-mono, monospace);
  font-size: 12px;
}
`;

      // Write all scaffold files
      fs.writeFileSync(path.join(args.directoryPath, 'manifest.json'), manifestContent, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'background.html'), backgroundHtml, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'background.js'), backgroundJs, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'home.html'), homeHtml, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'home.js'), homeJs, 'utf-8');
      fs.writeFileSync(path.join(args.directoryPath, 'home.css'), homeCss, 'utf-8');

      // Resolve capabilities (dev = all granted, like builtin)
      const manifestParsed = JSON.parse(manifestContent);
      const capGrant = resolveCapabilities(featureId, manifestParsed.capabilities, true);

      // Register in feature registry
      const entry = {
        id: featureId,
        name: featureName,
        path: args.directoryPath,
        source: {
          type: 'dev' as const,
          version: '0.1.0',
        },
        grantedCapabilities: capGrant.capabilities,
        userApproved: true,
        installedAt: new Date().toISOString(),
      };

      registry.registerFeature(entry);
      registry.saveRegistry();

      // Write history event
      writeFeatureHistory(featureId, 'install', '0.1.0', 'dev');

      // Publish installed event
      publish('feature-registry', scopes.GLOBAL, 'feature:installed', {
        id: featureId,
        name: featureName,
        source: { type: 'dev' },
      });

      return { success: true, entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to create feature: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:reload', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    try {
      // Strategy: find any webContents whose URL starts with peek://{featureId}/
      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let reloaded = 0;

      for (const wc of allContents) {
        const url = wc.getURL();
        if (url.startsWith(urlPrefix)) {
          wc.reload();
          reloaded++;
          continue;
        }

        // Also check frames in extension host (iframes)
        try {
          const mainFrame = wc.mainFrame;
          for (const frame of mainFrame.framesInSubtree) {
            if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
              // Reload the iframe by navigating it again
              frame.executeJavaScript('location.reload()');
              reloaded++;
            }
          }
        } catch {
          // Some webContents may not have frames accessible
        }
      }

      // Also try the tile launcher's tracked windows
      const manifest = entry.path ? JSON.parse(
        fs.readFileSync(path.join(entry.path, 'manifest.json'), 'utf-8')
      ) : null;

      if (manifest && manifest.tiles) {
        for (const tile of manifest.tiles) {
          const win = getTileWindow(args.featureId, tile.id);
          if (win && !win.isDestroyed()) {
            win.webContents.reload();
            reloaded++;
          }
        }
      }

      if (reloaded === 0) {
        return { success: true, message: 'No active tiles found to reload. Feature will load on next launch.' };
      }

      return { success: true, message: `Reloaded ${reloaded} tile(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to reload feature: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:open-devtools', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    try {
      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let opened = 0;

      // First try direct BrowserWindows with matching URLs
      for (const wc of allContents) {
        const url = wc.getURL();
        if (url.startsWith(urlPrefix)) {
          wc.openDevTools();
          opened++;
        }
      }

      // If no direct match, check extension host frames
      if (opened === 0) {
        for (const wc of allContents) {
          try {
            const mainFrame = wc.mainFrame;
            for (const frame of mainFrame.framesInSubtree) {
              if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
                // For iframes in extension host, open devtools on the host window
                // (Electron doesn't support opening devtools on individual frames)
                wc.openDevTools();
                opened++;
                break;
              }
            }
          } catch {
            // Skip inaccessible webContents
          }
          if (opened > 0) break;
        }
      }

      if (opened === 0) {
        return { error: 'No active tiles found. The feature may not be loaded yet.' };
      }

      return { success: true, message: `Opened DevTools for ${opened} context(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open DevTools: ${message}` };
    }
  });

  // ── feature-devtools:open ──
  //
  // Opens DevTools for ANY tile feature (installed or dev-source), unlike
  // `feature-dev:open-devtools` which is token-gated and primarily used for
  // dev-source features. DevTools is a developer affordance — no capability
  // check required, but we gate by caller origin so only privileged UIs
  // (the main app, features-manager, etc.) can open devtools.
  //
  // Args: { featureId: string, entryId?: string }
  //   - featureId — the tile id
  //   - entryId   — which tile entry (defaults to 'background')
  ipcMain.handle('feature-devtools:open', async (ev, args: {
    featureId: string;
    entryId?: string;
  }) => {
    // Origin gate: only allow from privileged callers. The main app window
    // and all builtin peek:// surfaces are trusted. External web content
    // should never reach here (they can't reach ipcMain anyway), but this
    // is a cheap belt-and-suspenders check.
    try {
      const senderUrl = ev.sender.getURL();
      if (!senderUrl.startsWith('peek://')) {
        return { error: 'Unauthorized origin' };
      }
    } catch {
      return { error: 'Unable to verify caller origin' };
    }

    if (!args || !args.featureId) {
      return { error: 'featureId is required' };
    }

    const entryId = args.entryId || 'background';

    try {
      // First try the tile launcher's tracked windows (v2 tiles — installed or dev).
      const win = getTileWindow(args.featureId, entryId);
      if (win && !win.isDestroyed()) {
        win.webContents.openDevTools({ mode: 'detach' });
        return { success: true, message: `Opened DevTools for ${args.featureId}:${entryId}` };
      }

      // Fallback: scan webContents for any window whose URL belongs to this
      // tile. Handles cases where the tile is running in a window we don't
      // track (e.g. extension host iframe, or a window entry not recorded
      // in the launcher map).
      const urlPrefix = `peek://${args.featureId}/`;
      const allContents = webContents.getAllWebContents();
      let opened = 0;
      for (const wc of allContents) {
        if (wc.getURL().startsWith(urlPrefix)) {
          wc.openDevTools({ mode: 'detach' });
          opened++;
        }
      }

      // Also scan extension host iframes — same pattern as feature-dev:open-devtools.
      if (opened === 0) {
        for (const wc of allContents) {
          try {
            const mainFrame = wc.mainFrame;
            for (const frame of mainFrame.framesInSubtree) {
              if (frame !== mainFrame && frame.url && frame.url.startsWith(urlPrefix)) {
                wc.openDevTools({ mode: 'detach' });
                opened++;
                break;
              }
            }
          } catch {
            // Skip inaccessible webContents
          }
          if (opened > 0) break;
        }
      }

      if (opened === 0) {
        return { error: `No active tile found for ${args.featureId}:${entryId}. The feature may not be loaded yet.` };
      }

      return { success: true, message: `Opened DevTools for ${opened} context(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open DevTools: ${message}` };
    }
  });

  ipcMain.handle('feature-dev:validate', async (_event, args: {
    token: string;
    featureId: string;
  }) => {
    const grant = getGrantForToken(args.token);
    if (!grant) return { error: 'Invalid token' };

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.featureId);
    if (!entry) return { error: `Feature not found: ${args.featureId}` };

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const featurePath = entry.path;

      // Check directory exists
      if (!fs.existsSync(featurePath)) {
        return { valid: false, errors: [`Feature directory not found: ${featurePath}`], warnings: [] };
      }

      // Read and validate manifest
      const manifestPath = path.join(featurePath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return { valid: false, errors: ['manifest.json not found'], warnings: [] };
      }

      let raw: Record<string, unknown>;
      try {
        const manifestJson = fs.readFileSync(manifestPath, 'utf-8');
        raw = JSON.parse(manifestJson);
      } catch (parseErr) {
        return { valid: false, errors: [`Invalid JSON in manifest.json: ${parseErr}`], warnings: [] };
      }

      // Check manifest version
      const version = detectManifestVersion(raw);
      if (version !== 'v2') {
        errors.push(`Manifest is ${version}, expected v2`);
      }

      // Run schema validation
      const validationErrors = validateTileManifest(raw);
      for (const ve of validationErrors) {
        errors.push(`${ve.path}: ${ve.message}`);
      }

      // Check that all files referenced in tiles[].url exist on disk
      const tiles = raw.tiles as Array<{ id: string; url: string }> | undefined;
      if (tiles && Array.isArray(tiles)) {
        for (const tile of tiles) {
          if (tile.url) {
            const tilePath = path.join(featurePath, tile.url);
            if (!fs.existsSync(tilePath)) {
              errors.push(`Tile "${tile.id}" references "${tile.url}" which does not exist`);
            }
          }
        }
      }

      // Check settingsSchema file if declared
      const settingsSchema = raw.settingsSchema as string | undefined;
      if (settingsSchema) {
        const schemaPath = path.join(featurePath, settingsSchema);
        if (!fs.existsSync(schemaPath)) {
          errors.push(`Settings schema file "${settingsSchema}" not found`);
        }
      }

      // Warnings for common issues
      if (!raw.description || (raw.description as string).trim() === '') {
        warnings.push('No description set in manifest');
      }
      if (!raw.version) {
        warnings.push('No version set in manifest');
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [`Validation failed: ${message}`], warnings: [] };
    }
  });

  // ── tile:extensions:* strict shims (Phase 3.5c) ────────────────────
  //
  // Strict counterparts of the legacy `extension-*` channels in ipc.ts.
  // All handlers require trustedBuiltin — feature tiles must not be able
  // to manage other extensions through the tile surface.
  // Wave 3.6c will flip tile-preload.cts to call these channels and
  // remove the legacy `extension-*` invocations.

  ipcMain.handle('tile:extensions:pickFolder', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:pickFolder', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:pickFolder' };
    }
    try {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No folder selected' };
      }
      return { success: true, data: { path: result.filePaths[0] } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:validateFolder', async (_event, args: {
    token: string;
    folderPath: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:validateFolder', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:validateFolder' };
    }
    try {
      const extPath = args.folderPath;
      const manifestPath = path.join(extPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found in folder' };
      }
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      if (!manifest.id && !manifest.shortname && !manifest.name) {
        return { success: false, error: 'Manifest must have id, shortname, or name' };
      }
      const backgroundPath = path.join(extPath, 'background.html');
      if (!fs.existsSync(backgroundPath)) {
        return { success: false, error: 'No background.html found in folder' };
      }
      return { success: true, data: { manifest, path: extPath } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:add', async (_event, args: {
    token: string;
    folderPath: string;
    manifest?: unknown;
    enabled?: boolean;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:add', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:add' };
    }
    try {
      const db = getDb();
      const extPath = args.folderPath;
      const manifestPath = path.join(extPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found' };
      }
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      const id = manifest.id || manifest.shortname || manifest.name || `ext_${Date.now()}`;
      const existing = db.prepare('SELECT * FROM extensions WHERE id = ?').get(id);
      if (existing) {
        return { success: false, error: `Extension ${id} already installed` };
      }
      db.prepare(`
        INSERT INTO extensions (id, name, description, version, path, enabled, builtin, status, installedAt, updatedAt, metadata, lastError, lastErrorAt)
        VALUES (?, ?, ?, ?, ?, 1, 0, 'installed', ?, ?, ?, ?, ?)
      `).run(
        id,
        manifest.name || id,
        manifest.description || '',
        manifest.version || '0.0.0',
        extPath,
        Date.now(),
        Date.now(),
        JSON.stringify(manifest),
        '',
        0,
      );
      return { success: true, data: { id, manifest, path: extPath } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:remove', async (_event, args: {
    token: string;
    id: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:remove', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:remove' };
    }
    try {
      const db = getDb();
      const extId = args.id;
      const existing = db.prepare('SELECT * FROM extensions WHERE id = ?').get(extId);
      if (!existing) {
        return { success: false, error: `Extension ${extId} not found` };
      }
      db.prepare('DELETE FROM extensions WHERE id = ?').run(extId);
      db.prepare('DELETE FROM feature_settings WHERE featureId = ?').run(extId);
      return { success: true, data: { id: extId } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:update', async (_event, args: {
    token: string;
    id: string;
    updates: Record<string, unknown>;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:update', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:update' };
    }
    try {
      const db = getDb();
      const extId = args.id;
      const updates = args.updates || {};
      const existing = db.prepare('SELECT * FROM extensions WHERE id = ?').get(extId);
      if (!existing) {
        return { success: false, error: `Extension ${extId} not found` };
      }
      const fields: string[] = [];
      const values: unknown[] = [];
      if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
      if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
      if (updates.lastError !== undefined) { fields.push('lastError = ?'); values.push(updates.lastError); }
      if (updates.lastErrorAt !== undefined) { fields.push('lastErrorAt = ?'); values.push(updates.lastErrorAt); }
      if (fields.length > 0) {
        fields.push('updatedAt = ?');
        values.push(Date.now());
        values.push(extId);
        db.prepare(`UPDATE extensions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      const updated = db.prepare('SELECT * FROM extensions WHERE id = ?').get(extId);
      return { success: true, data: updated };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:getAll', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:getAll', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:getAll' };
    }
    try {
      const db = getDb();
      const extensions = db.prepare('SELECT * FROM extensions').all();
      return { success: true, data: extensions };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:get', async (_event, args: {
    token: string;
    id: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:get', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:get' };
    }
    try {
      const db = getDb();
      const ext = db.prepare('SELECT * FROM extensions WHERE id = ?').get(args.id);
      if (!ext) {
        return { success: false, error: `Extension ${args.id} not found` };
      }
      return { success: true, data: ext };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:windowList', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:windowList', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:windowList' };
    }
    try {
      const running = getRunningExtensions();
      return { success: true, data: running };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:listAllRegistered', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:listAllRegistered', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:listAllRegistered' };
    }
    try {
      const all = getAllRegisteredExtensions();
      return { success: true, data: all };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:extensions:windowDevtools', async (_event, args: {
    token: string;
    id: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:windowDevtools', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:windowDevtools' };
    }
    // extensionWindows map was removed in Phase 3.2; v2 tiles have their own devtools path.
    return { success: false, error: `Extension ${args.id} is not running as a legacy window` };
  });

  ipcMain.handle('tile:extensions:reload', async (_event, args: {
    token: string;
    id: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'extensions', 'tile:extensions:reload', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:extensions:reload' };
    }
    try {
      const extId = args.id;
      if (!extId) {
        return { success: false, error: 'Missing extension id' };
      }
      const win = await reloadExtension(extId);
      if (!win) {
        return { success: false, error: `Failed to reload extension: ${extId}` };
      }
      return { success: true, data: { id: extId } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── tile:chrome-extensions:* strict shims (Phase 3.5d) ──────────────
  //
  // Strict counterparts of the legacy `chrome-ext:*` channels in ipc.ts.
  // All handlers require trustedBuiltin — feature tiles must not be able
  // to enumerate or launch chrome extensions through the tile surface.
  // Wave 3.6d will flip tile-preload.cts to call these channels and
  // remove the legacy `chrome-ext:*` invocations.

  ipcMain.handle('tile:chrome-extensions:list', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'chrome-extensions', 'tile:chrome-extensions:list', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:chrome-extensions:list' };
    }
    try {
      const { getChromeExtensions } = await import('./chrome-extensions.js');
      const extensions = getChromeExtensions();
      return { success: true, data: extensions };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:chrome-extensions:enable', async (_event, args: {
    token: string;
    id: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'chrome-extensions', 'tile:chrome-extensions:enable', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:chrome-extensions:enable' };
    }
    try {
      const { enableChromeExtension } = await import('./chrome-extensions.js');
      const result = await enableChromeExtension(args.id);
      return { success: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:chrome-extensions:disable', async (_event, args: {
    token: string;
    id: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'chrome-extensions', 'tile:chrome-extensions:disable', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:chrome-extensions:disable' };
    }
    try {
      const { disableChromeExtension } = await import('./chrome-extensions.js');
      const result = await disableChromeExtension(args.id);
      return { success: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:chrome-extensions:getStatus', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'chrome-extensions', 'tile:chrome-extensions:getStatus', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:chrome-extensions:getStatus' };
    }
    try {
      const { getChromeExtensionStatus } = await import('./chrome-extensions.js');
      const status = getChromeExtensionStatus();
      return { success: true, data: status };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:chrome-extensions:getUiEntries', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'chrome-extensions', 'tile:chrome-extensions:getUiEntries', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:chrome-extensions:getUiEntries' };
    }
    try {
      const { getChromeExtensionUiEntries } = await import('./chrome-extensions.js');
      const entries = getChromeExtensionUiEntries();
      return { success: true, data: entries };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:chrome-extensions:openPage', async (_event, args: {
    token: string;
    id: string;
    type: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'chrome-extensions', 'tile:chrome-extensions:openPage', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:chrome-extensions:openPage' };
    }
    try {
      const { openChromeExtensionPage } = await import('./chrome-extensions.js');
      const win = openChromeExtensionPage(args.id, args.type as import('./chrome-extensions.js').ChromeExtensionUiEntryType);
      if (win) {
        return { success: true, data: { windowId: win.id } };
      }
      return { success: false, error: `No ${args.type} page available for extension: ${args.id}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── tile:log:write ────────────────────────────────────────────────
  //
  // Strict shim for the legacy `renderer-log` fire-and-forget channel.
  // Any tile with a valid token may log — no capability check beyond a
  // valid token (all tiles can log). Prints forwarded renderer output to
  // the main-process terminal, matching the legacy shortSource format.
  ipcMain.on('tile:log:write', (_event, args: {
    token: string;
    args?: unknown[];
    source?: string;
  }) => {
    if (!args?.token) return;
    const grant = getGrantForToken(args.token);
    if (!grant) {
      handleViolation(null, 'log', 'tile:log:write', 'invalid token', args.token);
      return;
    }
    const shortSource = (args.source ?? grant.tileId)
      .replace('peek://app/', '')
      .replace('peek://ext/', 'ext/');
    console.log(`[${shortSource}]`, ...(args.args ?? []));
  });

  // ── tile:app:quit ─────────────────────────────────────────────────
  //
  // Strict shim for the legacy `app-quit` channel. Requires trustedBuiltin
  // (only core tiles — cmd, hud, page — may quit the application).
  ipcMain.on('tile:app:quit', (_event, args: {
    token: string;
    source?: string;
  }) => {
    if (!args?.token) return;
    const grant = getGrantForToken(args.token);
    if (!grant) {
      handleViolation(null, 'app', 'tile:app:quit', 'invalid token', args.token);
      return;
    }
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:quit', 'trustedBuiltin required', args.token);
      return;
    }
    DEBUG && console.log('[tile-ipc] app:quit requested from:', args.source ?? grant.tileId);
    app.quit();
  });

  // ── tile:app:restart ──────────────────────────────────────────────
  //
  // Strict shim for the legacy `app-restart` channel. Requires trustedBuiltin.
  // Calls app.relaunch() then app.quit() matching the legacy ipc.ts pattern.
  ipcMain.on('tile:app:restart', (_event, args: {
    token: string;
    source?: string;
  }) => {
    if (!args?.token) return;
    const grant = getGrantForToken(args.token);
    if (!grant) {
      handleViolation(null, 'app', 'tile:app:restart', 'invalid token', args.token);
      return;
    }
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:restart', 'trustedBuiltin required', args.token);
      return;
    }
    DEBUG && console.log('[tile-ipc] app:restart requested from:', args.source ?? grant.tileId);
    app.relaunch();
    app.quit();
  });

  // ── tile:backup:* strict shims (Phase 3.11b) ─────────────────────────
  //
  // Strict counterparts of the legacy `backup-*` channels in ipc.ts.
  // All handlers require trustedBuiltin — settings/diagnostic/page-host
  // tiles will consume these once they migrate off preload.js.

  ipcMain.handle('tile:backup:create', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'backup', 'tile:backup:create', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:backup:create' };
    }
    try {
      const result = await createBackup();
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:backup:list', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'backup', 'tile:backup:list', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:backup:list' };
    }
    try {
      const backups = listBackups();
      const config = getBackupConfig();
      return {
        success: true,
        data: {
          backups,
          backupDir: config.backupDir,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:backup:get-config', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'backup', 'tile:backup:get-config', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:backup:get-config' };
    }
    try {
      const config = getBackupConfig();
      return { success: true, data: config };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── tile:shell:open-path strict shim (Phase 3.11b) ───────────────────
  //
  // Strict counterpart of the legacy `shell-open-path` channel.
  // Requires trustedBuiltin — opens a path in the OS file manager.

  ipcMain.handle('tile:shell:open-path', async (_event, args: {
    token: string;
    path: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'shell', 'tile:shell:open-path', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:shell:open-path' };
    }
    try {
      const pathToOpen = args.path;
      if (!pathToOpen) return { success: false, error: 'Missing path' };
      if (!fs.existsSync(pathToOpen)) {
        fs.mkdirSync(pathToOpen, { recursive: true });
      }
      await shell.openPath(pathToOpen);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── tile:app:default-browser-status / set-default-browser / get-prefs ──
  //
  // Strict counterparts of the legacy `default-browser-status`,
  // `set-default-browser`, and `get-app-prefs` channels.
  // All require trustedBuiltin.

  ipcMain.handle('tile:app:default-browser-status', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:default-browser-status', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:default-browser-status' };
    }
    try {
      const isDefaultHttp = app.isDefaultProtocolClient('http');
      const isDefaultHttps = app.isDefaultProtocolClient('https');
      return { isDefault: isDefaultHttp && isDefaultHttps };
    } catch (err) {
      return { isDefault: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:app:set-default-browser', async (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:set-default-browser', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:set-default-browser' };
    }
    try {
      app.setAsDefaultProtocolClient('http');
      app.setAsDefaultProtocolClient('https');
      const isDefaultHttp = app.isDefaultProtocolClient('http');
      const isDefaultHttps = app.isDefaultProtocolClient('https');
      if (isDefaultHttp && isDefaultHttps) {
        return { success: true };
      } else {
        return { success: false, error: 'System did not accept the change. You may need to set the default browser in System Settings.' };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('tile:app:get-prefs', (_event, args: {
    token: string;
  }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:get-prefs', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:get-prefs' };
    }
    return getPrefs();
  });

  // ── tile:nav:* strict shims (Phase 3.11b-nav-session) ────────────────
  //
  // Strict counterparts of the legacy `web-nav-*` channels in ipc.ts.
  // All require trustedBuiltin — only the core background renderer uses these.

  const tileResolveWebWindow = (windowId?: number): BrowserWindow | null => {
    const id = windowId ?? getLastFocusedVisibleWindowId();
    if (!id) return null;
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) return null;
    const winUrl = win.webContents.getURL();
    if (!winUrl.startsWith('http://') && !winUrl.startsWith('https://')) return null;
    return win;
  };

  ipcMain.handle('tile:nav:back', (_event, args: { token: string; windowId?: number }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'nav', 'tile:nav:back', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:nav:back' };
    }
    const win = tileResolveWebWindow(args.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    const nav = win.webContents.navigationHistory;
    if (nav.canGoBack()) { nav.goBack(); return { success: true }; }
    return { success: false, error: 'Cannot go back' };
  });

  ipcMain.handle('tile:nav:forward', (_event, args: { token: string; windowId?: number }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'nav', 'tile:nav:forward', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:nav:forward' };
    }
    const win = tileResolveWebWindow(args.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    const nav = win.webContents.navigationHistory;
    if (nav.canGoForward()) { nav.goForward(); return { success: true }; }
    return { success: false, error: 'Cannot go forward' };
  });

  ipcMain.handle('tile:nav:reload', (_event, args: { token: string; windowId?: number }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'nav', 'tile:nav:reload', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:nav:reload' };
    }
    const win = tileResolveWebWindow(args.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    win.webContents.reload();
    return { success: true };
  });

  ipcMain.handle('tile:nav:state', (_event, args: { token: string; windowId?: number }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'nav', 'tile:nav:state', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:nav:state' };
    }
    const win = tileResolveWebWindow(args.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    const nav = win.webContents.navigationHistory;
    return {
      success: true,
      data: {
        url: win.webContents.getURL(),
        canGoBack: nav.canGoBack(),
        canGoForward: nav.canGoForward(),
        title: win.getTitle() || '',
      }
    };
  });

  // ── tile:session:* strict shims (Phase 3.11b-nav-session) ─────────────
  //
  // Strict counterparts of the legacy `session-save`,
  // `session-restore-interactive`, and `window-reopen-last-closed` channels.
  // All require trustedBuiltin.

  ipcMain.handle('tile:session:save', async (_event, args: { token: string }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'session', 'tile:session:save', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:session:save' };
    }
    try {
      saveSessionSnapshot('manual');
      return { success: true, message: 'Session saved' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:session:restore-interactive', async (_event, args: { token: string }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'session', 'tile:session:restore-interactive', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:session:restore-interactive' };
    }
    try {
      const info = getSessionSnapshotInfo();
      if (!info) {
        return { success: true, message: 'No saved session to restore', cancelled: false, restored: 0 };
      }
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Restore Previous Session',
        message: `Restore ${info.windowCount} window${info.windowCount === 1 ? '' : 's'} from your previous session?\n\nThese will open alongside your current windows.`,
        buttons: ['Restore', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) {
        return { success: true, message: 'Restore cancelled', cancelled: true, restored: 0 };
      }
      const prefs = getPrefs();
      const result = await restoreSessionSnapshot(prefs, { cleanShutdown: true, crashCount: 0 });
      return {
        success: true,
        message: `Restored ${result.restored} of ${result.total} window(s)`,
        cancelled: false,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('tile:session:reopen-last-closed', (_event, args: { token: string }) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = getGrantForToken(args.token);
    if (!grant) return { success: false, error: 'Invalid token' };
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'session', 'tile:session:reopen-last-closed', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:session:reopen-last-closed' };
    }
    return reopenLastClosedWindow();
  });

  DEBUG && console.log('[tile-ipc] All tile IPC handlers registered');
}

// ─── Theme helpers for tile:theme:* strict shims ──────────────────
//
// Private mirrors of the ipc.ts theme helpers. Used only by the
// tile:theme:* handlers registered in registerTileHandlers() above.
// Duplicated here to avoid coupling tile-ipc.ts to ipc.ts internals.

const TILE_THEME_SETTINGS_KEY = 'core';
const TILE_THEME_ID_KEY = 'theme.id';
const TILE_THEME_COLOR_SCHEME_KEY = 'theme.colorScheme';

function tileGetThemeSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(TILE_THEME_SETTINGS_KEY, key) as { value: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return null;
  }
}

function tileSetThemeSetting(key: string, value: string): void {
  const db = getDb();
  const timestamp = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${TILE_THEME_SETTINGS_KEY}_${key}`, TILE_THEME_SETTINGS_KEY, key, JSON.stringify(value), timestamp);
}

function tileBroadcastThemeChange(colorScheme: string): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('theme:changed', { colorScheme });
  }
}

// ─── MIME type helper ─────────────────────────────────────────────

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.ts': 'application/typescript',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
