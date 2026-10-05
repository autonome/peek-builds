/**
 * IPC Capability Enforcement for Tiles
 *
 * Handles:
 * - tile:validate-token — validate a capability token and return grants
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
import type { BaseWindow } from 'electron';
import { broadcast, getAllLiveWindows, getLiveWindow, windowFromWebContents } from './window-registry.js';
import fs from 'node:fs';
import path from 'node:path';

import {
  validateToken,
  getGrantForToken,
  getTileWindow,
  isTileLoaded,
  unloadTile,
  getTileManifest,
} from './tile-launcher.js';
import { registerTileIpc } from './tile-ipc-gate.js';
import { performAtprotoRequest, isAtprotoHostAllowed, type AtprotoRequest } from './atproto-proxy.js';
import { readAtprotoSession, writeAtprotoSession } from './atproto-session-store.js';
import { parseManifestFile } from './tile-manifest.js';
import { loadOrArmFeatureTile, disarmLazyTile, type AnnotatedTile } from './tile-arm.js';
import { computePlacement, toProportional, ownDisplay } from './window-placement.js';
import { publish, subscribe, unsubscribe, getStats as getPubSubStats } from './pubsub.js';
import { DEBUG, TILE_STRICT, isHeadless, getTilePreloadPath } from './config.js';
import {
  setDebug,
  setDevTools,
  getDebugFlags,
  onDebugFlagsChange,
} from './debug-flag.js';
import { getMcpStatus, setMcpConfig, listScopedProjects, scaffoldProject, removeScopedProject } from './mcp-config.js';
import { publishCapabilityViolation } from './tile-violations.js';
import { getFeatureRegistry } from './feature-startup.js';
import { getAtprotoSource } from './feature-startup.js';
import { getFeatureLoadErrors } from './feature-startup.js';
import {
  getDb,
  getTable as dsGetTable,
  setRow as dsSetRow,
  getRow as dsGetRow,
  addItem as dsAddItem,
  getItem as dsGetItem,
  findUrlItem as dsFindUrlItem,
  updateItem as dsUpdateItem,
  deleteItem as dsDeleteItem,
  restoreItem as dsRestoreItem,
  queryItems as dsQueryItems,
  tagItem as dsTagItem,
  untagItem as dsUntagItem,
  getItemTags as dsGetItemTags,
  getAllItemTags as dsGetAllItemTags,
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
  setContextDefault,
  queryContextHistory,
  getContextSnapshot,
  getWindowsWithContextValue,
  getWindowsMatchingContext,
  normalizeUrl,
  setWakeShortcuts as dsSetWakeShortcuts,
  type WakeShortcut,
} from './datastore.js';
import {
  lazyShortcutSource,
  registerWakeShortcutList,
} from './feature-shortcut-registrar.js';
import { unregisterShortcutsForAddress } from './shortcuts.js';
import { tagItemAndPublish as dsTagItemAndPublish } from './tag-events.js';
import {
  listRules as rulesList,
  upsertRule as rulesUpsert,
  deleteRule as rulesDelete,
  type Rule,
  type RulesDb,
} from './rules.js';
import type { TableName } from '../types/index.js';
import { installFromBundle } from './feature-installer.js';
import { resolveCapabilities, validateTileManifest, detectManifestVersion } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities, TileManifest } from './tile-manifest.js';
import { compareSemver, evaluateUpdateGate } from './capability-compare.js';
import { invokeWindowOpen, reopenLastClosedWindow, getDarkModeSetting, setDarkModeSetting, applyDarkModeSetting, persistAdBlockerPref } from './ipc.js';
import {
  getWindowInfo,
  validateThemeCSS,
} from './main.js';
import { getWindowPresentation } from './window-presenter.js';
import { getAllHybridWindows, getHybridWindow } from './hybrid-page-host-registry.js';
import {
  getTopmostContentWindowId,
  getTopmostWebPageWindowId,
  getWindowModeName,
  getWindowIdFor,
  getNativeWindowFor,
  getMachineWindowRecord,
  getKernelExecutorForApp,
} from './window-machine.js';
import { wmLog } from './window-diag.js';
import {
  kernelSetFullscreen,
  kernelSetBounds,
  kernelMaximize,
  kernelUnmaximize,
  kernelSetDesktopMembership,
  kernelShowRequested,
  kernelHideRequested,
  kernelSetAcceptsInput,
  kernelSetLayer,
  kernelArmSelectionFocus,
} from './window-kernel-dispatch.js';
import { BASE_LAYER } from './window-kernel.js';
import { FLOATING_LAYER } from './izui-roles.js';
import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  registerLocalShortcut,
  unregisterLocalShortcut,
  isWaylandSession,
} from './shortcuts.js';
import { resolveCliHelperPath, formatCliCommand } from './cli-helper.js';
import { checkShortcutAllowed } from './tile-shortcuts-enforcement.js';
import { checkContextAllowed } from './tile-context-enforcement.js';
import { checkDialogAllowed } from './tile-dialogs-enforcement.js';
import { checkWindowAllowed } from './tile-window-enforcement.js';
import { checkFeaturesAllowed, sourceTypeAllowed } from './tile-features-enforcement.js';
import * as manifestCache from './manifest-cache.js';
import { enrichFeatureEntries } from './feature-list-entries.js';
import { getState as getTileEntryState } from './tile-lifecycle.js';
import {
  liveDevtoolsEntries,
  pickDevtoolsEntries,
  type LiveEntriesResult,
} from './feature-devtools-target.js';
import { checkSettingsForeignAllowed } from './tile-settings-foreign-enforcement.js';
import { checkOAuthAllowed } from './tile-oauth-enforcement.js';
import { checkSyncAllowed } from './tile-sync-enforcement.js';
import { createLoopbackServer } from './oauth-loopback.js';
import {
  syncAll,
  getSyncConfig,
  setSyncConfig,
  getSyncStatus,
  getSyncLog,
  pullFromServer,
  pushToServer,
  pullTagsFromServer,
  pullEventsFromServer,
  pushTagsToServer,
  pushEventsToServer,
  listDevices,
  renameDevice,
  revokeDevice,
  clearSyncCredentials,
  createEnrolmentCode,
  exchangeEnrolmentCode,
} from './sync.js';
import {
  listProfiles,
  createProfile,
  getProfileByFolder,
  deleteProfile,
  getActiveProfile,
  setActiveProfile,
  enableSync,
  disableSync,
  getSyncConfig as getProfileSyncConfig,
  updateLastSyncTime,
} from './profiles.js';
import { checkEscapeAllowed } from './tile-escape-enforcement.js';
import { checkSessionAllowed } from './tile-session-enforcement.js';
import { checkIzuiAllowed } from './tile-izui-enforcement.js';
import { getActiveThemeId, setActiveThemeId, getRegisteredThemeIds, getThemePath, registerThemePath } from './protocol.js';
import { validateTileDatastoreRequest } from './tile-datastore-scope.js';
import { resolveSettingDefault } from './tile-settings-defaults.js';
import {
  getBackupConfig,
  createBackup,
  listBackups,
} from './backup.js';
import { getPrefs, closeOrHideWindow, showWindowHeadlessSafe } from './windows.js';
import {
  saveSessionSnapshot,
  restoreSessionSnapshot,
  getSessionSnapshotInfo,
} from './session.js';

/**
 * Which of a feature's declared tile entries are running right now.
 *
 * The single derived answer to "is this feature running", read from the
 * lifecycle FSM plus the tile window map. Both the devtools-open handler
 * and the feature list go through it, so the card's enabled state and the
 * handler's verdict cannot disagree.
 */
function featureEntryLiveness(featureId: string): LiveEntriesResult {
  let entryIds: string[] = [];
  try {
    const tiles = (manifestCache.get(featureId)?.manifest as
      { tiles?: Array<{ id?: string }> } | null | undefined)?.tiles;
    if (Array.isArray(tiles)) {
      entryIds = tiles
        .map(tile => tile?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    }
  } catch (err) {
    DEBUG && console.warn('[featureEntryLiveness] manifest-cache unavailable:', err);
  }

  return liveDevtoolsEntries(entryIds, entryId => {
    const win = getTileWindow(featureId, entryId);
    return {
      state: getTileEntryState(featureId, entryId),
      hasWindow: !!win && !win.isDestroyed(),
    };
  });
}

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
import { isNetworkDomainAllowed } from './tile-network-enforcement.js';
export { isNetworkDomainAllowed } from './tile-network-enforcement.js';

// ─── Helpers ─────────────────────────────────────────────────────────

// The `fsDiag` / `[fs-toggle]` / `[fs-target]` file-based traces are DELETED —
// the kernel's DEBUG-gated transition log (`window-kernel-executor.ts
// WindowKernelExecutor.logTransition`) is the permanent replacement, so the
// next live repro needs zero instrumentation.

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

// ─── Phase 8: IPC chokepoint (tile-ipc-gate.ts) ──────────────────────
//
// Every `tile:*` IPC handler is registered through `registerTileIpc`,
// which runs the six-step validation pipeline (§The IPC chokepoint in
// docs/pubsub-state-machine.md) before invoking the handler. The
// validated grant is injected as the handler's third argument — the
// pre-Phase-8 inline `const grant = verifyTokenSender(...)` calls have
// been removed; every handler aliases `const grant = _grant` to keep
// the body mechanically unchanged.

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

// Network-fetch domain enforcement lives in a pure (Electron-free) module so
// it can be unit-tested in isolation; re-exported here for in-file callers and
// test access. See tile-network-enforcement.ts.

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

// ─── Semver + Capability Comparison ─────────────────────────────────
//
// The auto-update capability-expansion gate (privilege-escalation
// boundary) lives in ./capability-compare.ts as a single tested source of
// truth — imported above as `compareSemver` / `evaluateUpdateGate`. The
// previous in-file `compareSemverSimple` / `compareCapabilitiesSimple`
// duplicates were untested; they were collapsed into that module (see
// capability-compare.test.ts) so the gate's code is the code under test.

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
 * Builtin features that are required infrastructure and may NOT be disabled
 * through the Features Manager. `cmd` owns the command panel every feature
 * dispatches commands through; disabling it would brick the app. Every other
 * builtin (peeks, slides, groups, windows, …) is freely disablable — the
 * registry `disabled` flag is the boot-time load gate.
 */
const REQUIRED_BUILTIN_FEATURE_IDS = new Set<string>(['cmd', 'features-manager']);

/**
 * Register all tile IPC handlers
 * Call this once during app initialization
 */
export function registerTileIpcHandlers(): void {

  // ── Token Validation ──

  registerTileIpc('tile:validate-token', { mode: 'handle' }, (event, args: {
    tileId: string;
    tileEntry: string;
    token: string;
  }, _grant) => {
    // Sender-frame cross-check: same rules as every other tile:*
    // handler. This is also the TOFU bind point for renderers we
    // couldn't bind eagerly (webview guests).
    const grant = _grant;
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
  //
  // Private lifecycle IPC (`tile:lifecycle:ready` / `tile:lifecycle:shutdown`)
  // lives in tile-lifecycle.ts. See docs/pubsub-state-machine.md
  // §Topics that are NOT pubsub.

  // ── PubSub ──

  registerTileIpc('tile:pubsub:publish', { mode: 'on' }, (event, args: {
    token: string;
    source: string;
    topic: string;
    data: unknown;
  }, _grant) => {
    const grant = _grant;

    // Topic enforcement: if topics allowlist is set, check it.
    // Trusted-builtin core renderers bypass the topic allowlist.
    //
    // Infrastructure topics owned by the cmd / noun registry are exempt
    // from per-tile allowlists when the tile has the `commands`
    // capability — they're the pubsub half of api.commands.register,
    // api.commands.registerNoun, and the noun-execute → result
    // round-trip (`noun:browse:*`, `noun:query:*`, `noun:open:*`,
    // `noun:create:*`, and the dynamic `noun:result:<noun>:<ts>` topics
    // the cmd panel subscribes to for each invocation). Gating these on
    // manifest topics would require every feature to hand-copy an
    // opaque infrastructure-topic list and enumerate the dynamic result
    // topic pattern. `tile:command:register/unregister` IPC already
    // bypasses the check this way; the registerNoun + noun-invocation
    // publish paths go through here so we must exempt them too.
    const INFRA_EXACT_TOPICS = new Set([
      'cmd:register',
      'cmd:register-batch',
      'cmd:unregister',
    ]);
    // `cmd:execute:*` covers both the dispatch topic and its result
    // reply (e.g. `cmd:execute:hello:result:1776…:abc`). A tile's
    // command handler MUST be able to publish the result-reply back
    // to the cmd panel; without this exemption the reply is silently
    // dropped and the panel's proxy times out at 30s, leaving a
    // spinner on screen. Gated on the `commands` capability so non-
    // command tiles can't spoof dispatch topics.
    const isInfraTopic = hasCapability(grant, 'commands') && (
      INFRA_EXACT_TOPICS.has(args.topic) ||
      args.topic.startsWith('cmd:execute:') ||
      args.topic.startsWith('noun:')
    );

    if (!grant.trustedBuiltin && !isInfraTopic && grant.capabilities.pubsub?.topics) {
      const allowed = grant.capabilities.pubsub.topics.some(pattern => {
        if (pattern === args.topic) return true;
        // Simple glob: pattern:* matches pattern:anything
        if (pattern.endsWith('*') && args.topic.startsWith(pattern.slice(0, -1))) return true;
        // Leading glob: *:suffix matches anything:suffix. Used by the
        // Features Manager to publish each feature's `<shortname>:settings-changed`
        // when it edits that feature's Options (the shortname set is dynamic,
        // so a trailing-glob can't express it). Bounded to the literal suffix.
        if (pattern.startsWith('*') && args.topic.endsWith(pattern.slice(1))) return true;
        return false;
      });
      if (!allowed) {
        const reason = `topic ${args.topic} not in allowlist for ${grant.tileId}`;
        handleViolation(grant, 'pubsub', 'pubsub:publish', reason, args.token);
        return;
      }
    }

    publish(args.source, args.topic, args.data);
  });

  registerTileIpc('tile:pubsub:subscribe', { mode: 'on' }, (event, args: {
    token: string;
    source: string;
    topic: string;
  }, _grant) => {
    const grant = _grant;

    subscribe(args.source, args.topic, (msg) => {
      // Message delivery handled by extension broadcaster in main.ts
    });
  });

  registerTileIpc('tile:pubsub:unsubscribe', { mode: 'on' }, (event, args: {
    token: string;
    source: string;
    topic: string;
  }, _grant) => {
    const grant = _grant;

    unsubscribe(args.source, args.topic);
  });

  // ── tile:pubsub:stats ────────────────────────────────────────────
  //
  // Pubsub telemetry for the HUD stats widget + developer diagnostics.
  // trustedBuiltin only — exposes raw subscription counts which a
  // third-party tile shouldn't need to introspect. Replaces legacy
  // un-gated `pubsub-stats` ipcMain handler.
  registerTileIpc('tile:pubsub:stats', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'pubsub', 'tile:pubsub:stats', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:pubsub:stats' };
    }
    return { success: true, data: getPubSubStats() };
  });

  // ── Commands ──

  registerTileIpc('tile:command:register', { mode: 'on' }, (event, args: {
    token: string;
    tileId: string;
    name: string;
  }, _grant) => {
    const grant = _grant;
    if (!hasCapability(grant, 'commands')) {
      handleViolation(grant, 'commands', 'command:register', 'commands not granted', args.token);
      return;
    }

    // Publish a minimal cmd:register-batch so downstream subscribers know
    // the tile claims ownership of this command name (used by the cmd
    // panel's query-backed registry for lazy/external tiles that don't
    // go through registerLazyTile at startup — e.g. `example`).
    //
    // This publish does NOT carry metadata (accepts/produces/description)
    // — those come from either (a) registerLazyTile at startup for built-in
    // tiles, or (b) the preload's own full cmd:register publish that
    // fires after this send. cmd:register-batch and cmd:register are
    // separate topics in the resident, and for a given command name the
    // full publish arrives second and overwrites the minimal.
    publish(
      `peek://${args.tileId}/background`,
      'cmd:register-batch',
      {
        commands: [{
          name: args.name,
          source: `peek://${args.tileId}/background`,
        }],
      }
    );
  });

  // ── Rules (event-dispatch registry) ───────────────────────────────
  //
  // Stage 1 of the rule engine (peek MCP plan 3d7d9239). The storage
  // layer lives in rules.ts; these handlers expose runtime CRUD over
  // the per-feature slice of the `rules` table. Manifest-declared
  // rules are reconciled at feature install/load time elsewhere
  // (feature-startup.ts) — the runtime handlers here only ever read
  // their own feature's rows and only ever write source='runtime'
  // rows. Keeping the source split prevents a runtime call from
  // racing with a manifest reconcile.
  //
  // featureId is bound to grant.tileId so a tile can never list /
  // register / unregister rules for another feature.

  registerTileIpc('tile:rules:list', {
    mode: 'handle',
    requiredCapabilities: ['rules'],
  }, (event, args: { token: string; topic?: string; enabled?: boolean }, grant) => {
    void event;
    const filter: { featureId: string; topic?: string; enabled?: boolean } = { featureId: grant.tileId };
    if (typeof args.topic === 'string') filter.topic = args.topic;
    if (typeof args.enabled === 'boolean') filter.enabled = args.enabled;
    const db = getDb() as unknown as RulesDb;
    return { rules: rulesList(db, filter) };
  });

  registerTileIpc('tile:rules:register', {
    mode: 'handle',
    requiredCapabilities: ['rules'],
  }, (event, args: {
    token: string;
    id?: string;
    topic: string;
    scriptId: string;
    match?: Record<string, unknown>;
    config?: Record<string, unknown>;
    display?: Record<string, unknown> | null;
    enabled?: boolean;
    ordering?: number;
  }, grant) => {
    void event;
    if (!args.topic || typeof args.topic !== 'string') return { error: 'topic-required' };
    if (!args.scriptId || typeof args.scriptId !== 'string') return { error: 'scriptId-required' };

    const db = getDb() as unknown as RulesDb;
    const id = args.id && typeof args.id === 'string'
      ? `rule_${grant.tileId}_${args.id}`
      : `rule_${grant.tileId}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const nowMs = Date.now();
    const rule: Rule = {
      id,
      featureId: grant.tileId,
      topic: args.topic,
      match: args.match ?? {},
      scriptId: args.scriptId,
      config: args.config ?? {},
      display: args.display ?? null,
      enabled: args.enabled !== false,
      source: 'runtime',
      ordering: typeof args.ordering === 'number' ? args.ordering : 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    const persisted = rulesUpsert(db, rule);
    publish(`peek://${grant.tileId}/background`, 'rules:changed', {
      featureId: grant.tileId,
      action: 'register',
      ruleId: persisted.id,
    });
    return { rule: persisted };
  });

  registerTileIpc('tile:rules:list-affordances', {
    mode: 'handle',
    requiredCapabilities: ['rules'],
  }, (event, _args: { token: string }, _grant) => {
    void event; void _args; void _grant;
    // Cross-feature read: every enabled rule with a non-empty `display`
    // block. Affordances are visual surfaces that any consumer (card UI,
    // page widget, …) may render — feature scoping wouldn't make sense.
    const db = getDb() as unknown as RulesDb;
    const all = rulesList(db, { enabled: true });
    return {
      rules: all.filter(r => r.display && Object.keys(r.display).length > 0),
    };
  });

  registerTileIpc('tile:rules:unregister', {
    mode: 'handle',
    requiredCapabilities: ['rules'],
  }, (event, args: { token: string; id: string }, grant) => {
    void event;
    if (!args.id || typeof args.id !== 'string') return { error: 'id-required' };
    const db = getDb() as unknown as RulesDb;
    // Only own-feature, runtime-source rules are deletable via this
    // handler. Manifest rows are owned by the install pipeline.
    const rows = rulesList(db, { featureId: grant.tileId, source: 'runtime' });
    if (!rows.some(r => r.id === args.id)) return { ok: false };
    const ok = rulesDelete(db, args.id);
    if (ok) {
      publish(`peek://${grant.tileId}/background`, 'rules:changed', {
        featureId: grant.tileId,
        action: 'unregister',
        ruleId: args.id,
      });
    }
    return { ok };
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

  registerTileIpc('tile:shortcuts:register', { mode: 'on' }, (ev, args: {
    token: string;
    source?: string;
    shortcut: string;
    replyTopic?: string;
    global?: boolean;
    mode?: string;
    options?: { global?: boolean; mode?: string };
  }, _grant) => {
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

    const grant = _grant;
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
      // Surface registration errors back to the caller. Previously the return
      // value was dropped, so a failed global shortcut (common on Linux
      // Wayland — see `registerGlobalShortcut`) looked indistinguishable
      // from success to the renderer.
      const err = registerGlobalShortcut(args.shortcut, source, callback);
      if (err) {
        // On Wayland, registerGlobalShortcut already logged the one-time
        // session hint — don't repeat the per-tile error noise. Still
        // reply with the error so the renderer can fall back if it wants.
        if (!isWaylandSession()) {
          console.error(
            `[tile-ipc] tile:shortcuts:register global failed for tile=${activeGrant.tileId} shortcut="${args.shortcut}": ${err.message}`
          );
        }
        replyError(err.message);
        return;
      }
    } else {
      const modeConditions = modeStr ? { majorMode: modeStr as import('./datastore.js').MajorModeId } : undefined;
      registerLocalShortcut(args.shortcut, source, callback, modeConditions);
    }
  });

  registerTileIpc('tile:shortcuts:unregister', { mode: 'on' }, (ev, args: {
    token: string;
    source?: string;
    shortcut: string;
    global?: boolean;
    mode?: string;
    options?: { global?: boolean; mode?: string };
  }, _grant) => {
    const opts = args.options || {};
    const isGlobal = args.global === true || opts.global === true;
    const modeStr = args.mode ?? opts.mode;

    const grant = _grant;
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

  // ── Lazy-wake shortcuts (strict) ──────────────────────────────────
  //
  // `tile:shortcuts:declare-wake` lets a feature persist its user-
  // configured global wake hotkeys so the main process can replay them
  // at boot WITHOUT the feature's renderer (see feature-shortcut-
  // registrar.ts::registerWakeShortcuts). The renderer declares the full
  // set each time; the handler stores a SNAPSHOT (replace-all) and live-
  // re-registers immediately so customizations take effect this session,
  // not just next boot.
  //
  // Gated on the same `shortcuts` capability as register/unregister:
  // every declared accelerator must pass `checkShortcutAllowed` (so a
  // `shortcuts: { keys: [...] }` allowlist is enforced; `shortcuts: true`
  // allows any). The wakeTopic/wakeArgs are opaque feature payload — the
  // main process never interprets them.
  registerTileIpc('tile:shortcuts:declare-wake', { mode: 'on' }, (_ev, args: {
    token: string;
    shortcuts?: Array<{ accelerator: string; wakeTopic: string; wakeArgs?: unknown[] }>;
  }, _grant) => {
    const grant = _grant;
    if (!grant) {
      handleViolation(null, 'shortcuts', 'shortcuts:declare-wake', 'Invalid token', args.token);
      return;
    }
    const list = Array.isArray(args.shortcuts) ? args.shortcuts : [];

    // Validate every accelerator against the shortcuts capability /
    // keys allowlist. Reject the whole declaration on the first miss —
    // a partial persist would leave the tile in a confusing state.
    for (const sc of list) {
      if (!sc || typeof sc.accelerator !== 'string' || typeof sc.wakeTopic !== 'string') {
        handleViolation(grant, 'shortcuts', 'shortcuts:declare-wake', 'malformed wake shortcut entry', args.token);
        return;
      }
      const check = checkShortcutAllowed(grant, sc.accelerator);
      if (!check.ok) {
        handleViolation(grant, 'shortcuts', 'shortcuts:declare-wake', check.error, args.token);
        return;
      }
    }

    const tileId = grant.tileId;
    const wakeList: WakeShortcut[] = list.map((sc) => ({
      accelerator: sc.accelerator,
      wakeTopic: sc.wakeTopic,
      wakeArgs: Array.isArray(sc.wakeArgs) ? sc.wakeArgs : [],
    }));

    // Persist snapshot (replace-all for this tile).
    dsSetWakeShortcuts(tileId, wakeList);

    // Live re-register: drop the tile's prior wake-shortcut group, then
    // register the new set so the customization takes effect now.
    unregisterShortcutsForAddress(lazyShortcutSource(tileId));
    registerWakeShortcutList(tileId, wakeList);
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

  registerTileIpc('tile:context:get', { mode: 'handle' }, async (ev, args: {
    token: string;
    key: string;
    windowId?: number | null;
  }, _grant) => {
    const grant = _grant;
    const check = checkContextAllowed(grant, 'get', args.key);
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:get', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      let windowId = args.windowId;
      if (windowId == null) {
        const callingWin = windowFromWebContents(ev.sender);
        windowId = callingWin?.id ?? null;
      }
      const entry = getContextEntry(args.key, windowId);
      return { success: true, data: entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:context:set', { mode: 'handle' }, async (ev, args: {
    token: string;
    key: string;
    value: unknown;
    metadata?: Record<string, unknown>;
    windowId?: number | null;
  }, _grant) => {
    const grant = _grant;
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
        const callingWin = windowFromWebContents(ev.sender);
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

  // Declare (or clear, with `value: null`) the default a key takes on every
  // window opened from now on whose opener sets none — see
  // `datastore.ts setContextDefault`. Gated like a write to that key.
  registerTileIpc('tile:context:set-default', { mode: 'handle' }, async (_ev, args: {
    token: string;
    key: string;
    value: unknown;
    metadata?: Record<string, unknown>;
  }, _grant) => {
    const grant = _grant;
    const check = checkContextAllowed(grant, 'set', args.key);
    if (!check.ok) {
      handleViolation(grant, 'context', 'context:set-default', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      setContextDefault(
        args.key,
        args.value === null || args.value === undefined
          ? null
          : { value: args.value, metadata: args.metadata || {} },
      );
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:context:history', { mode: 'handle' }, async (ev, args: {
    token: string;
    key?: string;
    windowId?: number | null;
    since?: number;
    until?: number;
    limit?: number;
    order?: 'asc' | 'desc';
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:context:snapshot', { mode: 'handle' }, async (ev, args: {
    token: string;
    timestamp?: number;
    keys?: string[];
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:context:windows-with-value', { mode: 'handle' }, async (ev, args: {
    token: string;
    key: string;
    value: unknown;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:context:windows-in-space', { mode: 'handle' }, async (ev, args: {
    token: string;
    spaceId: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:dialogs:save', { mode: 'handle' }, async (ev, args: {
    token: string;
    content: string;
    filename?: string;
    mimeType?: string;
  }, _grant) => {
    const grant = _grant;
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

      const senderWindow = windowFromWebContents(ev.sender);
      // Parent the dialog over the machine front (the sole focus authority),
      // not BrowserWindow.getFocusedWindow(): the OS query returns null for a
      // hybrid BaseWindow host (dialog would fall back to the sender or float
      // unparented) and returns the chrome overlay when the address bar is
      // focused (dialog would parent over the chrome, not the page). dialog
      // parenting accepts a BaseWindow, so a hybrid front parents directly.
      const frontId = getTopmostContentWindowId();
      const frontWin = frontId != null ? getNativeWindowFor(frontId) : null;
      const parentWindow = frontWin && !frontWin.isDestroyed()
        ? frontWin
        : (senderWindow && senderWindow.isVisible() ? senderWindow : null);

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

  registerTileIpc('tile:dialogs:open', { mode: 'handle' }, async (ev, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkDialogAllowed(grant, 'open');
    if (!check.ok) {
      handleViolation(grant, 'dialogs', 'dialogs:open', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const senderWindow = windowFromWebContents(ev.sender);
      // Same front-based parenting as tile:dialogs:save above (machine front,
      // not getFocusedWindow() — see that handler's comment).
      const frontId = getTopmostContentWindowId();
      const frontWin = frontId != null ? getNativeWindowFor(frontId) : null;
      const parentWindow = frontWin && !frontWin.isDestroyed()
        ? frontWin
        : (senderWindow && senderWindow.isVisible() ? senderWindow : null);

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

  registerTileIpc('tile:features:list', { mode: 'handle' }, async (event, args: {
    token: string;
    /** Optional filter by source type (rejected if not in sources allowlist). */
    sourceType?: string;
  }, _grant) => {
    const grant = _grant;
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
    const visible = base.filter(e => sourceTypeAllowed(grant, e.source.type));

    // Join the manifest cache on top. The registry alone carries no
    // description and no command declarations, which used to force the
    // Features Manager into a settings-schema round-trip PER FEATURE —
    // each one a sync readFileSync + full manifest validation on the
    // main thread, ~34 of them, to return null for the ~24 features
    // that declare no schema. `manifestCache.list()` is one SQLite
    // query for the same facts, already kept in step with every
    // install / uninstall / disable by feature-startup's registry
    // listener.
    //
    // includeDisabled: the manager lists disabled features too, and a
    // disabled feature still needs its description to render.
    //
    // Cache failure degrades to the un-enriched registry entries rather
    // than failing the list — this handler is the manager's only data
    // source, and a feature with an unreadable manifest must stay
    // listable (and therefore removable).
    let rows: manifestCache.ManifestCacheRow[] = [];
    try {
      rows = manifestCache.list({ includeDisabled: true });
    } catch (err) {
      DEBUG && console.warn('[tile:features:list] manifest-cache unavailable:', err);
    }
    // Per-entry running state, from the same derivation the devtools-open
    // handler uses — so a card's DevTools button is enabled exactly when
    // that handler would find something to attach to.
    const liveEntries = new Map<string, string[]>();
    for (const feature of visible) {
      liveEntries.set(feature.id, featureEntryLiveness(feature.id).live);
    }

    const entries = enrichFeatureEntries(visible, rows, getFeatureLoadErrors(), liveEntries);
    return { entries };
  });

  registerTileIpc('tile:features:get', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:history', { mode: 'handle' }, async (event, args: {
    token: string;
    featureId?: string;
    limit?: number;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:enable', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
    tilePreloadPath?: string;
  }, _grant) => {
    const grant = _grant;
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

      // Re-arm the feature live so a mid-session enable reaches the same end
      // state as a fresh boot with the feature enabled — no restart. Boot's
      // loader SKIPS disabled features, so a re-enabled lazy tile is NOT in the
      // lazy registry and has NO wake accelerators; flipping the `disabled` flag
      // (above) alone left its global hotkeys + command-palette entries dead
      // until the next launch. Route through the SAME shared path boot uses
      // (`loadOrArmFeatureTile`: register path + arm-lazy-or-launch-resident).
      // The preload path the renderer omits (core:feature:toggle calls
      // api.features.enable with no path) falls back to the cached canonical one.
      try {
        const parsed = parseManifestFile(path.join(entry.path, 'manifest.json'));
        if (parsed?.version === 'tile' && parsed.manifest) {
          const annotated: AnnotatedTile = { id: args.id, path: entry.path, manifest: parsed.manifest };
          loadOrArmFeatureTile(annotated, { tilePreloadPath: args.tilePreloadPath || getTilePreloadPath() });
        }
      } catch (err) {
        console.error(`[tile-ipc] Failed to re-arm ${args.id} on enable:`, err);
      }

      publish('feature-registry', 'feature:enabled', { id: args.id });
    }
    return { success: result };
  });

  registerTileIpc('tile:features:disable', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkFeaturesAllowed(grant, 'manage');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:disable', check.error, args.token);
      return { error: check.error };
    }

    const registry = getFeatureRegistry();
    if (!registry) return { error: 'Feature registry not initialized' };

    const entry = registry.getFeature(args.id);
    if (!entry) return { error: `Feature not found: ${args.id}` };
    // Builtins ARE disablable from the Features Manager (the registry
    // `disabled` flag is the boot-time load gate honoured by tile-loader),
    // EXCEPT required infrastructure. `cmd` provides the command panel that
    // every feature dispatches through — disabling it would brick the app,
    // so it stays locked the same way the renderer locks its toggle.
    if (REQUIRED_BUILTIN_FEATURE_IDS.has(args.id)) {
      return { error: `Cannot disable required feature "${args.id}"` };
    }
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

      // Tear down the lazy arming live so the disable takes effect WITHOUT a
      // restart and a disable→enable cycle stays clean: drop the OS wake
      // accelerators (otherwise a stale hotkey keeps trying to wake a disabled
      // tile) and remove the tile from the lazy registry + command palette.
      // Safe/idempotent for resident-only or never-armed tiles.
      disarmLazyTile(args.id);

      publish('feature-registry', 'feature:disabled', { id: args.id });
    }
    return { success: result };
  });

  registerTileIpc('tile:features:remove', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    const grant = _grant;
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

    // Same live teardown as disable: a removed lazy feature must not leave a
    // stale lazy-registry entry or registered wake accelerators behind.
    disarmLazyTile(args.id);

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

      publish('feature-registry', 'feature:removed', { id: args.id });
    }
    return { success: result };
  });

  registerTileIpc('tile:features:install-resolve', { mode: 'handle' }, async (event, args: {
    token: string;
    atUri: string;
  }, _grant) => {
    const grant = _grant;
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
      return {
        manifest: metadata.manifest,
        source: metadata.source,
        iconUrl: metadata.iconUrl,
        screenshotUrls: metadata.screenshotUrls,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to resolve AT URI: ${message}` };
    }
  });

  registerTileIpc('tile:features:preview-capabilities', { mode: 'handle' }, async (event, args: {
    token: string;
    manifestCapabilities: TileCapabilities;
    featureId: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:install', { mode: 'handle' }, async (event, args: {
    token: string;
    atUri: string;
    userApproved: boolean;
  }, _grant) => {
    const grant = _grant;
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

      publish('feature-registry', 'feature:installed', {
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

  registerTileIpc('tile:features:browse-resolve-publisher', { mode: 'handle' }, async (event, args: {
    token: string;
    query: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:update-check-all', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
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

            if (compareSemver(latest.version, currentVersion) > 0) {
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

  registerTileIpc('tile:features:update-apply', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
    userApproved?: boolean;
  }, _grant) => {
    const grant = _grant;
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

      // ── The auto-update gate (privilege-escalation boundary) ──
      // Pure, tested decision in ./capability-compare.ts. Two gates:
      // version monotonicity, then capability-expansion-without-approval.
      const decision = evaluateUpdateGate({
        currentVersion,
        newVersion,
        currentCapabilities: entry.grantedCapabilities,
        newCapabilities: newManifest.capabilities,
        userApproved: args.userApproved,
      });

      if (!decision.allow) {
        if (decision.reason === 'not-newer') {
          return { error: 'No newer version available' };
        }
        return {
          error: 'Capabilities expanded — user approval required',
          capabilitiesChanged: true,
          added: decision.comparison.added,
          removed: decision.comparison.removed,
        };
      }

      const capComparison = decision.comparison;

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

      publish('feature-registry', 'feature:updated', {
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

  registerTileIpc('tile:features:update-set-policy', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
    policy: 'auto' | 'notify' | 'pinned';
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:dev-reload', { mode: 'handle' }, async (event, args: {
    token: string;
    featureId: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:dev-validate', { mode: 'handle' }, async (event, args: {
    token: string;
    featureId: string;
  }, _grant) => {
    const grant = _grant;
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
      if (version !== 'tile') errors.push(`Manifest is not a valid tile manifest (got: ${version})`);

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

  registerTileIpc('tile:features:dev-pick-directory', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:dev-create', { mode: 'handle' }, async (event, args: {
    token: string;
    directoryPath: string;
    featureId: string;
    featureName: string;
  }, _grant) => {
    const grant = _grant;
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
        manifestVersion: 3,
        id: featureId,
        name: featureName,
        version: '0.1.0',
        description: '',
        tiles: [
          { id: 'background', url: 'background.html', lazy: true },
          {
            id: 'home', url: 'home.html',
            width: 800, height: 600, title: featureName,
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

      publish('feature-registry', 'feature:installed', {
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

  registerTileIpc('tile:features:publish-list-local', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:publish-read-feature-files', { mode: 'handle' }, async (event, args: {
    token: string;
    featureId: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:features:devtools-open', { mode: 'handle' }, async (event, args: {
    token: string;
    featureId: string;
    entryId?: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkFeaturesAllowed(grant, 'devtools');
    if (!check.ok) {
      handleViolation(grant, 'features', 'features:devtools-open', check.error, args.token);
      return { error: check.error };
    }

    if (!args.featureId) return { error: 'featureId is required' };

    try {
      // Authoritative path: the lifecycle FSM says which entries are running
      // and the window map says which of those can actually be attached to.
      const { live, drift } = featureEntryLiveness(args.featureId);
      const picked = pickDevtoolsEntries(args.entryId, live, drift, args.featureId);

      if (live.length > 0) {
        if (!picked.entries) return { error: picked.error };
        const attached: string[] = [];
        for (const pickedEntryId of picked.entries) {
          const win = getTileWindow(args.featureId, pickedEntryId);
          if (win && !win.isDestroyed()) {
            win.webContents.openDevTools({ mode: 'detach' });
            attached.push(`${args.featureId}:${pickedEntryId}`);
          }
        }
        if (attached.length > 0) {
          return { success: true, message: `Opened DevTools for ${attached.join(', ')}` };
        }
      }

      // Fallback: webview-hosted tile contexts (HUD widgets, page-canvas
      // guests) never appear in the tile window map, so a URL scan is their
      // only route. Reached only when the map yielded nothing to attach to.
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
        // Every matching webContents, not just the first: a feature hosted in
        // several subframes has several contexts worth opening.
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
        }
      }

      if (opened === 0) {
        return { error: picked.error ?? `No active tile found for ${args.featureId}. The feature may not be loaded yet.` };
      }
      return { success: true, message: `Opened DevTools for ${opened} context(s)` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to open DevTools: ${message}` };
    }
  });

  registerTileIpc('tile:features:browse-list-by-publisher', { mode: 'handle' }, async (event, args: {
    token: string;
    did: string;
    pdsUrl: string;
    cursor?: string;
  }, _grant) => {
    const grant = _grant;
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

      const { buildFeatureBlobUrl, registerPublisherPds } = await import('./atproto-source.js');

      // Register this publisher's PDS so the `peek://feature-blob` handler can
      // fetch + CID-verify its display blobs (the list itself is not
      // signature-verified — only install is — but the handler still guarantees
      // the displayed bytes match the advertised CID).
      registerPublisherPds(args.did, args.pdsUrl);

      // Narrow a record's `icon`/`screenshots` fields to verified-blob URLs.
      // Display-only: loaded by the renderer via <img src> through the
      // `peek://feature-blob` handler, which CID-verifies the bytes before
      // serving (404 → letter-avatar fallback). Never installed.
      type RawBlobRef = { ref?: { $link?: string } };
      const blobUrl = (b: unknown): string | undefined => {
        const link = (b as RawBlobRef | undefined)?.ref?.$link;
        return link ? buildFeatureBlobUrl(args.did, link) : undefined;
      };

      const featureMap = new Map<string, {
        uri: string; featureId: string; name: string; version: string;
        description?: string; categories?: string[]; capabilities?: string[];
        iconUrl?: string; screenshotUrls?: string[];
        createdAt: string;
      }>();

      for (const rec of data.records || []) {
        const val = rec.value as Record<string, unknown>;
        const featureId = val.featureId as string;
        if (!featureId) continue;
        const existing = featureMap.get(featureId);
        const createdAt = (val.createdAt as string) || '';
        if (!existing || createdAt > existing.createdAt) {
          const iconUrl = blobUrl(val.icon);
          const shots = Array.isArray(val.screenshots)
            ? (val.screenshots as unknown[]).map(blobUrl).filter((u): u is string => !!u)
            : [];
          featureMap.set(featureId, {
            uri: rec.uri,
            featureId,
            name: (val.name as string) || featureId,
            version: (val.version as string) || 'unknown',
            description: val.description as string | undefined,
            categories: val.categories as string[] | undefined,
            capabilities: val.capabilities as string[] | undefined,
            iconUrl,
            screenshotUrls: shots.length > 0 ? shots : undefined,
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
  registerTileIpc('tile:features:settings-schema', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    const grant = _grant;
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
      // settingsSchema lives on the parsed manifest; fall back to raw for legacy extensions.
      const settingsSchema: string | undefined =
        manifest?.manifest?.settingsSchema ?? (manifest?.raw?.settingsSchema as string | undefined);
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

  registerTileIpc('tile:izui:is-transient', { mode: 'handle' }, async (ev, args: { token: string }, _grant) => {    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) {
      handleViolation(grant, 'izui', 'izui:is-transient', check.error, args?.token);
      return { error: check.error };
    }
    try {
      const { getIzuiCoordinator } = await import('./izui-state.js');
      const coordinator = getIzuiCoordinator();
      const requestingWindow = windowFromWebContents(ev.sender);
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

  registerTileIpc('tile:izui:get-effective-mode', { mode: 'handle' }, async (event, args: { token: string }, _grant) => {    const grant = getGrantForToken(args?.token);
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

  registerTileIpc('tile:izui:get-state', { mode: 'handle' }, async (event, args: { token: string }, _grant) => {    const grant = getGrantForToken(args?.token);
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

  registerTileIpc('tile:izui:get-pre-overlay-focus-target', { mode: 'handle' }, async (event, args: { token: string }, _grant) => {    const grant = getGrantForToken(args?.token);
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

  registerTileIpc('tile:izui:close-self', { mode: 'handle' }, async (ev, args: { token: string }, _grant) => {    const grant = getGrantForToken(args?.token);
    const check = checkIzuiAllowed(grant);
    if (!check.ok) { handleViolation(grant, 'izui', 'izui:close-self', check.error, args?.token); return { error: check.error }; }
    const win = windowFromWebContents(ev.sender);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }
    try {
      // Import dynamically to avoid loading windows.js at test time.
      const { closeOrHideWindow } = await import('./windows.js');
      await closeOrHideWindow(win.id);
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

  registerTileIpc('tile:datastore:extract-page-content', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:window:open', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
    options?: Record<string, unknown>;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'open', { url: args.url });
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:open', check.error, args.token);
      return { error: check.error };
    }
    const activeGrant = grant as CapabilityGrant;

    // URL governance is handled by checkWindowAllowed above via the
    // tile's declared `window.urls` allowlist (if any). Tiles without
    // a urls allowlist accept any URL — same policy as the legacy
    // window-open channel. External http(s) URLs open in a hybrid
    // page-host via the window-open handler below.

    // Delegate to the main window-open handler (registered by registerWindowHandlers()
    // in ipc.ts). This is the single source of truth for window creation — handles
    // the hybrid page-host, mode inheritance, deduping, session registration, etc.
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

  registerTileIpc('tile:window:close', { mode: 'on' }, (event, args: {
    token: string;
    id?: number;
  }, _grant) => {
    const grant = _grant;
    const senderWin = windowFromWebContents(event.sender);
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
      target = getLiveWindow(args.id);
    } else if (senderWin) {
      target = senderWin;
    }
    if (target) {
      // Route through closeOrHideWindow so windows with keepLive:true are
      // HIDDEN rather than destroyed — the api.window.open key-reuse path
      // in ipc.ts then finds the window in findWindowsByKey and calls
      // win.show() + dispatches tile:lifecycle:visible. Without this, a
      // raw target.close() destroys the window regardless of keepLive,
      // defeating the reuse path and causing cmd panel-like "rapid
      // invocation stalls" that the repeat-invocation spec catches.
      // Fire-and-forget: closeOrHideWindow is async (hybrid branch awaits a
      // fullscreen exit) but never rejects; this handler is mode:'on' (no result).
      void closeOrHideWindow(target.id);
      return;
    }
    // Hybrid page-host (BaseWindow) — invisible to getLiveWindow. Route through
    // closeOrHideWindow (NOT closeHostWindow directly) so a hybrid window with
    // keepLive:true is HIDDEN rather than destroyed — same gate the
    // BrowserWindow `target` branch above goes through, and the same gate the
    // app-switch / focus-autoclose dismissal paths use. Its hybrid branch
    // honors keepLive (hide) and otherwise closeHostWindow's the BaseWindow
    // (content WebContents destroyed first — the page-host close UAF guard).
    // No-op (null) when args.id is not a hybrid window.
    if (args.id != null) {
      const hybrid = getHybridWindow(args.id);
      if (hybrid && !hybrid.baseWin.isDestroyed()) {
        // Fire-and-forget (async, never rejects) — mode:'on' handler.
        void closeOrHideWindow(args.id);
      }
    }
  });

  registerTileIpc('tile:window:info', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'info');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:info', check.error, args.token);
      return { error: check.error };
    }

    const win = windowFromWebContents(event.sender);
    if (!win) {
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

  registerTileIpc('tile:window:list', { mode: 'handle' }, async (event, args: {
    token: string;
    includeInternal?: boolean;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'list');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:list', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      // Use the window presenter so the response carries user-facing facts
      // (resolved address for page-hosts, canvas-aware bounds, favicon, etc.)
      // — consumers don't have to know about page-host shell URLs.
      const windows: Array<{
        id: number;
        url: string;
        title: string;
        focused: boolean;
        visible: boolean;
        favicon: string;
        thumbnail: string;
        bounds: Electron.Rectangle;
        maximized: boolean;
        preMaxBounds: Electron.Rectangle | null;
        params: Record<string, unknown>;
      }> = [];
      for (const win of getAllLiveWindows()) {
        // Params come from the machine's registry payload (getWindowInfo is
        // the numeric-id seam over the reducer records). The includeInternal
        // filter skips windows without a registry payload.
        const info = getWindowInfo(win.id);
        if (!args.includeInternal && !info) continue;
        const params: Record<string, unknown> = info ? info.params : {};
        const presentation = getWindowPresentation(win.id);
        if (!presentation) continue;
        windows.push({
          id: presentation.id,
          // Field is named `url` for backward compat; value is the resolved
          // user-facing address (inner URL for page-hosts).
          url: presentation.address,
          title: presentation.title,
          focused: presentation.focused,
          visible: presentation.visible,
          favicon: presentation.favicon,
          thumbnail: presentation.thumbnail,
          bounds: presentation.bounds,
          maximized: presentation.maximized,
          preMaxBounds: presentation.preMaxBounds,
          params,
        });
      }

      // Hybrid page-host windows are BaseWindows, so `getAllLiveWindows()`
      // (BrowserWindow.getAllWindows-backed) never enumerates them — without
      // this the windows feature can't see them. Each hybrid is presented
      // through the SAME `getWindowPresentation` path as any other window, so
      // its entry shape (id/url/title/favicon/…) is indistinguishable from
      // one. The `seen` guard is belt-and-suspenders against a future id
      // overlap.
      const seen = new Set(windows.map((w) => w.id));
      for (const h of getAllHybridWindows()) {
        if (seen.has(h.windowId)) continue;
        const presentation = getWindowPresentation(h.windowId);
        if (!presentation) continue;
        windows.push({
          id: presentation.id,
          url: presentation.address,
          title: presentation.title,
          focused: presentation.focused,
          visible: presentation.visible,
          favicon: presentation.favicon,
          thumbnail: presentation.thumbnail,
          bounds: presentation.bounds,
          maximized: presentation.maximized,
          preMaxBounds: presentation.preMaxBounds,
          // Hybrid windows DO have a registry payload (declared on their
          // machine registration in the hybrid open branch). Read it the same
          // way the getAllLiveWindows() loop above does, so parentWindowId/
          // role/placement/escapeMode survive in the listed entry.
          params: getWindowInfo(h.windowId)?.params ?? {},
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
  //   - `exists.success && exists.data`     (pagestream, windows feature)
  // Keeping both keys lets us migrate callers without a renaming pass.
  registerTileIpc('tile:window:exists', { mode: 'handle' }, async (event, args: {
    token: string;
    id: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'exists');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:exists', check.error, args.token);
      return { exists: false, success: false, data: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { exists: false, success: false, data: false, error: 'Window ID is required' };
      }
      const win = getLiveWindow(args.id);
      if (!win) {
        // Hybrid page-host (BaseWindow) — invisible to getLiveWindow. A live
        // hybrid window still "exists"; consult the hybrid registry directly.
        const hybrid = getHybridWindow(args.id);
        if (hybrid && !hybrid.baseWin.isDestroyed()) {
          return { exists: true, success: true, data: true };
        }
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
  registerTileIpc('tile:window:show', { mode: 'handle' }, async (event, args: {
    token: string;
    id: number;
    inactive?: boolean;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'show');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:show', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { success: false, error: 'Window ID is required' };
      }
      const win = getLiveWindow(args.id);
      if (!win) {
        // Hybrid page-host (BaseWindow) — invisible to getLiveWindow. Route
        // the show through the machine (§5 step 6A-4): the backend owns the
        // whole show policy (headless opacity-0 mask, quick-view NSPanel
        // non-activation) and echoes WINDOW_SHOWN itself, so the old
        // imperative baseWin.show() + isHeadless() guard here are gone.
        const hybrid = getHybridWindow(args.id);
        if (hybrid && !hybrid.baseWin.isDestroyed()) {
          const machineId = getWindowIdFor(args.id);
          if (machineId != null) {
            kernelShowRequested(machineId, true);
          }
          return { success: true };
        }
        return { success: false, error: 'Window not found' };
      }
      showWindowHeadlessSafe(win, { active: args.inactive !== true });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:hide ──────────────────────────────────────────────
  //
  // Hide a visible window. Gated by `window.manage`.
  registerTileIpc('tile:window:hide', { mode: 'handle' }, async (event, args: {
    token: string;
    id: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'hide');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:hide', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { success: false, error: 'Window ID is required' };
      }
      const win = getLiveWindow(args.id);
      if (!win) {
        // Hybrid page-host (BaseWindow) — invisible to getLiveWindow. Hide the
        // host BaseWindow directly so the windows-feature hide/unhide affordance
        // works for a web-page window. No-op (null) when args.id is not a
        // hybrid window.
        const hybrid = getHybridWindow(args.id);
        if (hybrid && !hybrid.baseWin.isDestroyed()) {
          // Black-window fix: exit native fullscreen FIRST (awaited via the
          // machine, the single setFullScreen owner) so a fullscreen host hidden
          // mid-state doesn't strand a black macOS Space. No-op when not
          // fullscreen. Re-check destroyed after the await.
          const machineId = getWindowIdFor(args.id);
          const fsMode = machineId != null ? getWindowModeName(machineId) : null;
          if (machineId != null && fsMode != null && fsMode !== 'normal') {
            // Feed the kernel (window-kernel-dispatch.ts) — this is what
            // drives the window manager.
            kernelSetFullscreen(machineId, false);
            const outcome = await getKernelExecutorForApp().waitForSettledFsMode(machineId, 'normal');
            if (outcome !== 'settled') {
              // Timed out or vanished: proceed into the destroyed re-check
              // and the hide below exactly as before this wait was bounded —
              // logged so a stranded black Space is diagnosable from a live run.
              wmLog('fs-settle-wait-non-settled', { site: 'tile:window:hide', id: machineId, outcome });
            }
          }
          if (hybrid.baseWin.isDestroyed()) return { success: true };
          // Route the hide through the kernel (§5 step 6A-4): HideWindow →
          // backend.hideWindow. The backend's native 'hide' listener is the
          // only WINDOW_HIDDEN source — the old synchronous hand-dispatch
          // (peek 71cfde09's workaround for the macOS BaseWindow 'hide'-event
          // lag) is gone, the same acceptance the 6A-3 keepLive cutover made
          // in closeOrHideWindow.
          if (machineId != null) {
            kernelHideRequested(machineId);
          }
          return { success: true };
        }
        return { success: false, error: 'Window not found' };
      }
      // Kernel hide intent (§5 step 6A-4) — R2: only the backend hides.
      {
        const machineId = getWindowIdFor(win);
        if (machineId != null) {
          kernelHideRequested(machineId);
        }
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:set-pinned ────────────────────────────────────────
  //
  // Moves an already-open window between the pinned band and the base band
  // in place (window-kernel.ts `SetLayer`) — no close/reopen, so the page
  // keeps its state. Gated by `window.manage`. `args.pinned` goes through
  // the same headless gate the open-time `alwaysOnTop` request already does
  // (ipc.ts's `alwaysOnTopResolved`), so a headless window's `layer` doesn't
  // start reporting pinned when its native always-on-top flag was never
  // actually applied.
  registerTileIpc('tile:window:set-pinned', { mode: 'handle' }, async (event, args: {
    token: string;
    id: number;
    pinned: boolean;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'set-pinned');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-pinned', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { success: false, error: 'Window ID is required' };
      }
      const machineId = getWindowIdFor(args.id);
      if (machineId == null) {
        return { success: false, error: 'Window not found' };
      }
      kernelSetLayer(machineId, !isHeadless() && args.pinned ? FLOATING_LAYER : BASE_LAYER);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:focus ─────────────────────────────────────────────
  //
  // Raise a window to the front. Gated by `window.manage`. No-op under
  // headless test runs to avoid stealing focus between parallel Electron
  // instances.
  registerTileIpc('tile:window:focus', { mode: 'handle' }, async (event, args: {
    token: string;
    id: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'focus');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:focus', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (typeof args.id !== 'number') {
        return { success: false, error: 'Window ID is required' };
      }
      // Route the raise through the machine (§5 step 8e): one
      // WINDOW_SHOW_REQUESTED {activate:true} replaces BOTH the imperative
      // native focus() (BrowserWindow and hybrid BaseWindow branches alike —
      // the machine path handles both kinds) and the hand-dispatched
      // OS_FOCUS_GAINED intent mirror. The backend owns the whole activate
      // policy (headless never steals OS focus) and echoes WINDOW_SHOWN
      // {focused:true}, so the machine's `front` intent is recorded in both
      // modes and the closing front assertion drives the raise plus the
      // first-responder half (FOCUS_CONTENT for page-hosts).
      const win = getLiveWindow(args.id);
      if (!win) {
        // Hybrid page-host (BaseWindow) — invisible to getLiveWindow;
        // consult the hybrid registry for the existence check.
        const hybrid = getHybridWindow(args.id);
        if (!hybrid || hybrid.baseWin.isDestroyed()) {
          return { success: false, error: 'Window not found' };
        }
      }
      const machineId = getWindowIdFor(args.id);
      if (machineId != null) {
        kernelShowRequested(machineId, true);
      }
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
  registerTileIpc('tile:window:show-self', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {    const record = validateToken(args.token);
    if (!record) return { success: false, error: 'Invalid token' };

    try {
      const win = getTileWindow(record.tileId, record.tileEntryId);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Tile window not found' };
      }
      // Machine show intent (§5 step 6A-4): the backend owns the headless
      // policy now — opacity is zeroed BEFORE the show, so nothing paints on
      // the real display and no OS focus is stolen from other Electron
      // instances in parallel Playwright workers (the old blanket
      // isHeadless() skip). The tests that assert showSelf's effect check
      // state via pubsub / evaluate, not visual presence.
      showWindowHeadlessSafe(win, { active: true });
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
  registerTileIpc('tile:window:hide-self', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {    const record = validateToken(args.token);
    if (!record) return { success: false, error: 'Invalid token' };

    try {
      const win = getTileWindow(record.tileId, record.tileEntryId);
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Tile window not found' };
      }
      // Kernel hide intent (§5 step 6A-4) — R2: only the backend hides.
      {
        const machineId = getWindowIdFor(win);
        if (machineId != null) {
          kernelHideRequested(machineId);
        }
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:set-ignore-mouse ──────────────────────────────────
  //
  // Toggle click-through on a window. Gated by `window.manage`. `options` is
  // accepted for API-compat but no longer read: the native realization,
  // `forward` option included, is now entirely `electron-window-backend.ts
  // setAcceptsInput`'s decision (window-kernel.ts SetAcceptsInput), not this
  // handler's — same platform-neutral-port discipline as every other
  // `tile:window:*` mutation here.
  registerTileIpc('tile:window:set-ignore-mouse', { mode: 'handle' }, async (event, args: {
    token: string;
    id?: number;
    ignore: boolean;
    options?: { forward?: boolean };
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'set-ignore-mouse');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-ignore-mouse', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? getLiveWindow(args.id)
        : windowFromWebContents(event.sender);
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      // Kernel click-through intent (window-kernel.ts SetAcceptsInput) — R2:
      // only the backend touches `setIgnoreMouseEvents` now; this handler asks
      // the machine and the executor realizes it.
      const machineId = getWindowIdFor(win);
      if (machineId != null) {
        kernelSetAcceptsInput(machineId, args.ignore !== true);
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:center ────────────────────────────────────────────
  //
  // Center a window on its display. Gated by `window.manage`.
  registerTileIpc('tile:window:center', { mode: 'handle' }, async (event, args: {
    token: string;
    id?: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'center');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:center', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (args.id !== undefined && typeof args.id !== 'number') {
        return { success: false, error: `Invalid window id: ${typeof args.id}` };
      }
      const win = typeof args.id === 'number'
        ? getLiveWindow(args.id)
        : windowFromWebContents(event.sender);
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      const bounds = win.getBounds();
      // Route through `computePlacement` so the "center this window" command
      // shares the same code path as automatic re-centering on display
      // change. The placement engine picks "own current display" from
      // `currentBounds` directly — no synthetic cursor needed.
      const result = computePlacement({
        placement: { mode: 'centered' },
        currentBounds: bounds,
        windowSize: { width: bounds.width, height: bounds.height },
        displays: screen.getAllDisplays(),
        primaryDisplayId: screen.getPrimaryDisplay().id,
      });
      if (result.kind === 'reposition') {
        // Kernel-owned since §5 step 7E: the rect is computed here at the
        // feed site (the kernel keeps zero value imports) and the write is
        // driven as the kernel's SetBounds effect through the port.
        const machineId = getWindowIdFor(win);
        if (machineId != null) {
          kernelSetBounds(machineId, result.bounds);
        }
      }
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
  registerTileIpc('tile:window:center-all', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'center-all');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:center-all', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const windows = getAllLiveWindows();
      let centered = 0;
      // Snapshot displays + primary id once outside the loop — they don't
      // change between iterations and reading them is not free.
      const displays = screen.getAllDisplays();
      const primaryDisplayId = screen.getPrimaryDisplay().id;
      for (const win of windows) {
        if (!win.isVisible()) continue;
        const bounds = win.getBounds();
        // Each window centers on its OWN current display (derived from
        // `currentBounds` by the placement engine).
        const result = computePlacement({
          placement: { mode: 'centered' },
          currentBounds: bounds,
          windowSize: { width: bounds.width, height: bounds.height },
          displays,
          primaryDisplayId,
        });
        if (result.kind === 'reposition') {
          // §5 step 7E — same kernel-routed write as tile:window:center.
          const machineId = getWindowIdFor(win);
          if (machineId != null) {
            kernelSetBounds(machineId, result.bounds);
          }
        }
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
  // Maximize a window. Non-toggling: re-maximize re-snaps without
  // overwriting the pre-maximize stash. Pair with
  // `tile:window:unmaximize` to restore. Gated by `window.manage`.
  //
  // Machine-owned since §5 step 7C (same shape as ipc.ts page:maximize,
  // §5 step 7B): the handler resolves the display work area at the
  // dispatch site (the reducer keeps zero value imports, so the rect
  // rides the event) and dispatches MAXIMIZE_REQUESTED; the REDUCER
  // stashes preMaxBounds from its own bounds mirror, flips `maximized`,
  // and drives the snap as a SET_BOUNDS effect through the executor/
  // backend. Explicit work-area bounds rather than a native maximize()
  // because frameless/panel-style windows on macOS don't respond to
  // native maximize() reliably. The old X11 at-work-area slack heuristic
  // (guarding the re-maximize stash-overwrite trap by GEOMETRY) is
  // subsumed by the reducer's flag-idempotent MAXIMIZE_REQUESTED clause
  // — the machine's own flag is trusted, geometry no longer votes.
  registerTileIpc('tile:window:maximize', { mode: 'handle' }, async (event, args: {
    token: string;
    id?: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'maximize');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:maximize', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      // Reject non-number ids loudly. The convention is "omit id for the
      // calling window", not "pass an object and silently fall back" —
      // a malformed caller (e.g. forgetting to unwrap a `{success, data}`
      // envelope) would otherwise silently maximize the wrong window.
      if (args.id !== undefined && typeof args.id !== 'number') {
        return { success: false, error: `Invalid window id: ${typeof args.id}` };
      }
      const win = typeof args.id === 'number'
        ? getLiveWindow(args.id)
        : windowFromWebContents(event.sender);
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      // Logged unconditionally — wrong-window targeting bugs are reported
      // by symptom ("the window behind got maximized"), and seeing the
      // resolved id + url in production stderr makes it diagnosable
      // without re-instrumenting the user.
      try {
        console.log(
          `[tile:window:maximize] id=${args.id ?? 'sender-fallback'} resolved=${win.id} url=${win.webContents.getURL().slice(0, 80)}`
        );
      } catch { /* logging must never throw */ }

      const machineId = getWindowIdFor(win);
      if (machineId == null) {
        return { success: false, error: 'Window not registered with window-state machine' };
      }
      // Feed-site reads: current bounds pick the display; the work area
      // rides the command (the kernel imports no value modules).
      const currentBounds = win.getBounds();
      const workArea = screen.getDisplayMatching(currentBounds).workArea;
      const workAreaRect = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
      // Pre-feed record — the renderer notification below reports the
      // pre-maximize rect, and after the feed the record already reflects
      // the maximize.
      const recBefore = getMachineWindowRecord(machineId);
      // Feed the kernel (window-kernel-dispatch.ts) — this is what drives the
      // window manager. The kernel's `Maximize` command carries the work
      // area as data (`459ed219` shape — see `kernelMaximize`'s doc).
      kernelMaximize(machineId, workAreaRect);
      // Targeted notification to the window's renderer — a renderer that
      // owns internal layout state subscribes via
      // api.window.onMaximizeRequest to keep its layout in sync without
      // going through pubsub broadcast. prevWindowBounds is null on a
      // re-maximize (the kernel's stash is not overwritten — matching the
      // kernel's idempotent Maximize clause); otherwise it is the kernel's
      // bounds mirror (what the kernel stashed), falling back to the live
      // read for a mirror the kernel never saw.
      try {
        win.webContents.send('tile:window:maximize-request', {
          prevWindowBounds: recBefore?.maximized === true ? null : {
            ...(recBefore?.bounds ?? currentBounds),
          },
        });
      } catch { /* renderer may be gone */ }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:unmaximize ────────────────────────────────────────
  //
  // Restore a maximized window to its pre-maximize bounds. Machine-owned
  // since §5 step 7C: dispatches UNMAXIMIZE_REQUESTED — the reducer
  // restores the stashed preMaxBounds via a SET_BOUNDS effect and clears
  // flag+stash (a null stash just clears the flag; not-maximized is a
  // no-op). The old isMaximized() distrust block (stash-else-native
  // fallback, native unmaximize() calls) is deleted: maximize is a
  // reducer fact, never an OS question (§3 — the port has no query
  // half). Gated by `window.manage`.
  registerTileIpc('tile:window:unmaximize', { mode: 'handle' }, async (event, args: {
    token: string;
    id?: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'maximize');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:unmaximize', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (args.id !== undefined && typeof args.id !== 'number') {
        return { success: false, error: `Invalid window id: ${typeof args.id}` };
      }
      const win = typeof args.id === 'number'
        ? getLiveWindow(args.id)
        : windowFromWebContents(event.sender);
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      const machineId = getWindowIdFor(win);
      if (machineId == null) {
        return { success: false, error: 'Window not registered with window-state machine' };
      }
      const rec = getMachineWindowRecord(machineId);
      try {
        console.log(
          `[tile:window:unmaximize] id=${args.id ?? 'sender-fallback'} resolved=${win.id} maximized=${rec?.maximized === true} hasPreBounds=${rec?.preMaxBounds != null} url=${win.webContents.getURL().slice(0, 80)}`
        );
      } catch { /* logging must never throw */ }

      // Feed the kernel (window-kernel-dispatch.ts) — this is what drives the
      // window manager.
      kernelUnmaximize(machineId);
      // Targeted notification — see comment in tile:window:maximize.
      try { win.webContents.send('tile:window:unmaximize-request'); } catch { /* renderer may be gone */ }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:fullscreen ────────────────────────────────────────
  //
  // Toggle fullscreen on a window. Gated by `window.manage`.
  registerTileIpc('tile:window:fullscreen', { mode: 'handle' }, async (event, args: {
    token: string;
    id?: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'fullscreen');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:fullscreen', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      if (args.id !== undefined && typeof args.id !== 'number') {
        return { success: false, error: `Invalid window id: ${typeof args.id}` };
      }
      // Both window kinds now route through ONE path: feed the kernel's
      // single `SetFullscreen` command (the single `setFullScreen` owner +
      // settle-aware transition table). `id` defaults to the front window.
      // The kernel resolves `preBounds` itself from its own bounds mirror on
      // the normal→entering edge (the fullscreen-lookalike session-save
      // fix) — this seam does not need to read or pass bounds. An
      // unregistered id is a kernel no-op (both browser and hybrid windows
      // register at creation).
      // Resolve the target both ways at the seam: a renderer-supplied `args.id`
      // is an ELECTRON window id (the tile IPC surface stays numeric until the
      // id-space collapse lands); no id means "the front window", which the
      // machine hands back as a WM WindowId.
      let machineId: ReturnType<typeof getTopmostContentWindowId> = null;
      if (typeof args.id === 'number') {
        machineId = getWindowIdFor(args.id);
      } else {
        machineId = getTopmostContentWindowId();
      }
      if (machineId == null) {
        // An explicit id that never registered with the kernel was a no-op
        // before the id-space split too — keep that a silent success.
        if (typeof args.id === 'number') return { success: true };
        return { success: false, error: 'Window not found' };
      }
      // Toggle off the CURRENT fsMode so the kernel's `SetFullscreen`
      // carries an explicit boolean rather than one this module invents:
      // `normal` and `leaving` both want fullscreen next, `fullscreen` and
      // `entering` both want out. Skipped when the kernel holds no record
      // for this id.
      const oldMode = getWindowModeName(machineId);
      // Feed the kernel (window-kernel-dispatch.ts) — this is what drives the
      // window manager.
      if (oldMode !== null) {
        const desired = oldMode === 'normal' || oldMode === 'leaving';
        kernelSetFullscreen(machineId, desired);
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:get-focused-visible-id ────────────────────────────
  //
  // Read-only: return the last-focused visible window id. Tracked by
  // the main-process window manager via `getLastFocusedVisibleWindowId()`
  // exported from ipc.ts. Gated by `window.query`.
  //
  // Resolution chain:
  //   1. The tracked id (set on focus events excluding modals + bg windows)
  //   2. BrowserWindow.getFocusedWindow() if no tracked id
  //   3. First visible, focusable, non-destroyed window
  registerTileIpc('tile:window:get-focused-visible-id', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'get-focused-visible-id');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:get-focused-visible-id', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      // The kernel's topmost content window IS "the focused visible window":
      // it collapses the old S1 tracked-id + S2 active-hybrid + the 7-input
      // `resolveFocusedVisibleWindowId` cascade (all three since deleted) into
      // one arbitrated authority, `window-kernel.ts isContentWindow` scanned
      // over `order`. Satellites (the command palette / modal issuers, the
      // chrome + switcher overlays) are excluded by role, so the
      // modal-exclusion and overlay redirects that resolver did are now
      // structural. A focused hybrid host (a BaseWindow `getFocusedWindow()`
      // returns null for) answers here too.
      //
      // The renderer-facing id surface stays ELECTRON-numeric until the
      // id-space collapse lands, so resolve the kernel's window id back to its
      // native window's id at this seam.
      const front = getTopmostContentWindowId();
      const frontWin = front != null ? getNativeWindowFor(front) : null;
      return { success: true, data: frontWin ? frontWin.id : null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:devtools ─────────────────────────────────────────
  //
  // Open devtools (detached) on a target window. Resolution order:
  //   1. args.id if provided
  //   2. the topmost web-page window — a content / child-content role, which
  //      `izui-roles.ts inferIzuiRole` reaches only through its `isWebPage`
  //      gate, so this is the last-focused REAL page
  //   3. the topmost content window of ANY kind, `peek://` surfaces included
  // Step 2 is what makes `view devtools` land on the page the user is reading
  // rather than on whatever `peek://` tile happens to sit above it: a
  // `peek://` open infers role `workspace`, which IS a content role, so step 3
  // alone answers with the tile.
  // Step 3 covers page-hosts (peek://app/page/?url=...), settings, and any
  // other peek:// surface — without it, `view devtools` from the cmd palette
  // would fail in a session that has no web page open at all.
  //
  // trustedBuiltin only — devtools is a developer surface; third-party
  // tiles must not trigger it on arbitrary windows. Replaces legacy
  // `window-devtools` ipcMain handler.
  registerTileIpc('tile:window:devtools', { mode: 'handle' }, (event, args: {
    token: string;
    id?: number;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'window', 'tile:window:devtools', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:window:devtools' };
    }
    try {
      // args.id is an ELECTRON id from the renderer; the machine's selectors
      // return WM WindowIds — resolve both to a native Electron id at the seam
      // (the renderer-facing surface stays numeric until the id-space collapse).
      let targetId: number | null = typeof args.id === 'number' ? args.id : null;
      if (targetId == null) {
        const machineId = getTopmostWebPageWindowId() ?? getTopmostContentWindowId();
        const nativeWin = machineId != null ? getNativeWindowFor(machineId) : null;
        targetId = nativeWin ? nativeWin.id : null;
      }
      if (!targetId) {
        return { success: false, error: 'No focused window available' };
      }
      const win = getLiveWindow(targetId);
      if (!win) {
        return { success: false, error: 'Window not found or destroyed' };
      }
      win.webContents.openDevTools({ mode: 'detach' });
      return { success: true, id: targetId, url: win.webContents.getURL() };
    } catch (error) {
      console.error('Failed to open devtools:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── tile:window:set-overlay-focus-target ──────────────────────────
  //
  // Set the focus target for an overlay window (used on restore after
  // the overlay closes). Gated by `window.manage`.
  registerTileIpc('tile:window:set-overlay-focus-target', { mode: 'handle' }, async (event, args: {
    token: string;
    targetWindowId: number;
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'set-overlay-focus-target');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-overlay-focus-target', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const callerWin = windowFromWebContents(event.sender);
      if (!callerWin) {
        return { success: false, error: 'Caller window not found' };
      }
      // Arm the kernel's own selection latch, which is what actually restores
      // focus when this switcher closes (window-kernel.ts
      // `State.pendingSelectionFocus`). THIS is the moment both windows are
      // alive and resolvable to `WindowId`s — the decision used to live in
      // `main.ts`'s native `'closed'` handler and had to, because the backend
      // has already dropped its numeric-id map by the time the kernel hears
      // about the close, leaving nothing to resolve the target with.
      //
      // A target that no longer resolves clears the latch rather than arming a
      // dangling one: the user picked a window that has since gone, and the
      // right answer to that is the same as a plain dismiss — restore nothing
      // and leave the user's desktop alone.
      // The armer must be a window the kernel has — the latch is spent by its
      // `WindowClosed` and by nothing else, so arming against an unregistered
      // caller would leave one nothing can ever spend. `decide` rejects that
      // too; refusing here is what turns it into an answer the caller can read.
      const armerId = getWindowIdFor(callerWin.id);
      if (armerId == null) {
        return { success: false, error: 'Caller window not in window manager' };
      }
      kernelArmSelectionFocus(armerId, getWindowIdFor(args.targetWindowId) ?? null);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:set-visible-on-all-workspaces ─────────────────────
  //
  // macOS Spaces: pin a window across workspaces. Gated by `window.manage`.
  registerTileIpc('tile:window:set-visible-on-all-workspaces', { mode: 'handle' }, async (event, args: {
    token: string;
    id?: number;
    visible: boolean;
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean };
  }, _grant) => {
    const grant = _grant;
    const check = checkWindowAllowed(grant, 'set-visible-on-all-workspaces');
    if (!check.ok) {
      handleViolation(grant, 'window', 'window:set-visible-on-all-workspaces', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const win = typeof args.id === 'number'
        ? getLiveWindow(args.id)
        : windowFromWebContents(event.sender);
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      const machineId = getWindowIdFor(win);
      if (machineId == null) {
        return { success: false, error: 'Window not registered with window-state machine' };
      }
      // Kernel-owned since §5 step 10. The renderer's raw boolean IS the
      // same on/off fact the kernel's `DesktopMembership` names, so it is
      // translated directly rather than carried as a second, boolean-shaped
      // command: `true` -> rides along with the user (`'follow'`), `false`
      // -> stays on the desktop it was opened on (`'anchor'`). The
      // caller-supplied platform options (`args.options`) are NOT fed — they
      // are Electron `setVisibleOnAllWorkspaces` argument names and have no
      // meaning to the kernel's platform-neutral command. This predates the
      // legacy-engine deletion (`f189496b`): this feed already
      // dropped `args.options` before that commit, which only removed the
      // parallel dispatch into the OLD machine's already-no-op effect arm —
      // the caller-supplied options never reached Electron either way.
      kernelSetDesktopMembership(machineId, args.visible === true ? 'follow' : 'anchor');
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── tile:window:get-id ────────────────────────────────────────────
  //
  // Return the Electron BrowserWindow id for the calling renderer.
  // No `window` capability required — every tile has an inherent right
  // to know its own window id (mirrors the un-gated legacy `get-window-id`
  // channel). Token validity is still enforced so un-initialised callers
  // cannot probe the id.
  registerTileIpc('tile:window:get-id', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;

    const win = windowFromWebContents(event.sender);
    return win ? { success: true, id: win.id } : { success: false, error: 'Window not found' };
  });

  // ── tile:window:get-bounds ────────────────────────────────────────
  //
  // Return the full bounds (x, y, width, height) for the calling renderer's
  // window. No `window` capability required — a tile always has an inherent
  // right to know its own bounds. Token validity is still enforced so
  // un-initialised callers cannot probe bounds.
  registerTileIpc('tile:window:get-bounds', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;

    const win = windowFromWebContents(event.sender);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }
    const bounds = win.getBounds();
    return { success: true, ...bounds };
  });

  // ── tile:window:get-display-info ──────────────────────────────────
  //
  // Return display info (workArea, bounds, scaleFactor) for the display
  // that contains the calling window. No `window` capability required —
  // a tile can always query the display it lives on.
  registerTileIpc('tile:window:get-display-info', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;

    const win = windowFromWebContents(event.sender);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }
    const display = screen.getDisplayMatching(win.getBounds());
    return {
      success: true,
      workArea: display.workArea,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      data: { workArea: display.workArea, bounds: display.bounds, scaleFactor: display.scaleFactor },
    };
  });

  // ── tile:window:set-bounds ────────────────────────────────────────
  //
  // Set the position and/or size of the calling window. No `window`
  // capability required — a tile can always reposition its own window.
  // (Cannot target other windows through this channel.)
  //
  // Per the placement spec (docs/window-placement.md), every set-bounds
  // call updates the registry's recorded `placement`:
  //
  //   - `proportional` (or absent): recompute (relX, relY) against the
  //     window's current display, write back as the new intent. One write
  //     covers move + resize uniformly.
  //   - `centered` / `edge` / `parent-centered`: by-design modes; intent
  //     is left untouched. Bounds will return to the projected position
  //     on the next consume (display change, reuse). Slides are
  //     edge-anchored by design; a stray drag does not promote them to
  //     proportional.
  registerTileIpc('tile:window:set-bounds', { mode: 'handle' }, (event, args: {
    token: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }, _grant) => {
    const grant = _grant;

    const win = windowFromWebContents(event.sender);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }
    const current = win.getBounds();
    const next: Electron.Rectangle = {
      x: args.x ?? current.x,
      y: args.y ?? current.y,
      width: args.width ?? current.width,
      height: args.height ?? current.height,
    };
    // Kernel-owned since §5 step 7E: the partial-args merge against the live
    // rect happens here at the feed site; the write is the kernel's
    // SetBounds effect through the port. The bounds mirror updates only via
    // the backend's BOUNDS_CHANGED echo.
    const machineId = getWindowIdFor(win);
    if (machineId != null) {
      kernelSetBounds(machineId, next);
    }

    const info = getWindowInfo(win.id);
    if (info) {
      const prev = info.params.placement as { mode?: string } | undefined;
      const isByDesign =
        prev?.mode === 'centered' ||
        prev?.mode === 'edge' ||
        prev?.mode === 'parent-centered';
      if (!isByDesign) {
        const displays = screen.getAllDisplays();
        const primaryId = screen.getPrimaryDisplay().id;
        const target = ownDisplay(next, displays, primaryId);
        const { relX, relY } = toProportional(next, target);
        info.params.placement = { mode: 'proportional', relX, relY };
        // Drop legacy mirrored flags so a subsequent session save+restore
        // doesn't re-derive a non-proportional Placement from stale
        // primitives.
        delete info.params.center;
        delete info.params.screenEdge;
      }
    }
    return { success: true };
  });

  // ── tile:window:resize ────────────────────────────────────────────
  //
  // Resize the caller's own tile window. Used by tiles that expand/collapse
  // based on content (cmd panel shows results list, HUD widgets adjust to
  // content height, etc.). No capability gate — a tile can always resize
  // its own window (cannot target other windows through this channel).
  registerTileIpc('tile:window:resize', { mode: 'handle' }, (event, args: {
    token: string;
    width: number;
    height: number;
  }, _grant) => {
    const grant = _grant;

    const win = windowFromWebContents(event.sender);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }
    const width = Math.max(1, Math.floor(Number(args.width)));
    const height = Math.max(1, Math.floor(Number(args.height)));
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return { success: false, error: 'Invalid dimensions' };
    }
    const current = win.getBounds();
    const next: Electron.Rectangle = { x: current.x, y: current.y, width, height };
    // Kernel-owned, same route as tile:window:set-bounds (§5 step 7E): the
    // write is the kernel's SetBounds effect through the port. The bounds
    // mirror updates only via the backend's BOUNDS_CHANGED echo.
    const machineId = getWindowIdFor(win);
    if (machineId != null) {
      kernelSetBounds(machineId, next);
    }

    const info = getWindowInfo(win.id);
    if (info) {
      const prev = info.params.placement as { mode?: string } | undefined;
      const isByDesign =
        prev?.mode === 'centered' ||
        prev?.mode === 'edge' ||
        prev?.mode === 'parent-centered';
      if (!isByDesign) {
        const displays = screen.getAllDisplays();
        const primaryId = screen.getPrimaryDisplay().id;
        const target = ownDisplay(next, displays, primaryId);
        const { relX, relY } = toProportional(next, target);
        info.params.placement = { mode: 'proportional', relX, relY };
        // Drop legacy mirrored flags so a subsequent session save+restore
        // doesn't re-derive a non-proportional Placement from stale
        // primitives.
        delete info.params.center;
        delete info.params.screenEdge;
      }
    }
    return { success: true };
  });

  // ── tile:screen:get-primary-display ───────────────────────────────
  //
  // Read-only display metadata. No capability gate — this is equivalent
  // to reading a bundled theme token and tiles use it for initial
  // window placement.
  registerTileIpc('tile:screen:get-primary-display', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    // Token presence still validated so we don't serve callers who
    // never invoked initialize(), but no capability check is performed.
    const grant = _grant;

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
  registerTileIpc('tile:escape:on-escape', { mode: 'on' }, (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
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
  registerTileIpc('tile:commands:unregister', { mode: 'on' }, (event, args: {
    token: string;
    name: string;
  }, _grant) => {
    const grant = _grant;
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
      'cmd:unregister',
      { name: args.name },
    );
  });

  // ── tile:session:save-workspace-snapshot / restore-workspace-snapshot ──
  //
  // Persist/reopen a named workspace's window layout through the general
  // session-snapshot pipeline (`main/session.ts saveSessionSnapshot` /
  // `restoreSessionSnapshot`, keyed by workspace id — the same functions the
  // app's own boot/quit snapshot uses, requirement 1/2 of
  // `specs/workspace-session-snapshot.md`). Used by features/spaces and
  // features/groups. Gated by the `session` capability.
  registerTileIpc('tile:session:save-workspace-snapshot', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkSessionAllowed(grant, 'save-workspace-snapshot');
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:save-workspace-snapshot', check.error, args.token);
      return { success: false, error: check.error };
    }
    if (typeof args.key !== 'string' || !args.key) {
      return { success: false, error: 'key is required' };
    }

    try {
      const { saveSessionSnapshot } = await import('./session.js');
      // A deliberate, user-initiated save: it runs under the test profile the
      // desktop specs drive real workspace switches in (`allowInTestProfile`),
      // and nothing more — the mid-restore guard and the invisible-window
      // filter stay in force, the same as for any production save.
      saveSessionSnapshot('workspace-switch', { key: args.key, allowInTestProfile: true });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // The spaces feature owns "which workspace is active" and reports it here so
  // the app's own ambient saves (autosave, before-quit, window-lifecycle) write
  // the active workspace's row — see `main/session.ts` "Active workspace".
  // `begin-workspace-switch` brackets the save → close → restore sequence of a
  // switch, during which no ambient save may run; `set-active-workspace` names
  // the workspace that is now active and ends the bracket.
  registerTileIpc('tile:session:begin-workspace-switch', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkSessionAllowed(grant, 'begin-workspace-switch');
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:begin-workspace-switch', check.error, args.token);
      return { success: false, error: check.error };
    }
    const { beginWorkspaceSwitch } = await import('./session.js');
    beginWorkspaceSwitch();
    return { success: true };
  });

  registerTileIpc('tile:session:set-active-workspace', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkSessionAllowed(grant, 'set-active-workspace');
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:set-active-workspace', check.error, args.token);
      return { success: false, error: check.error };
    }
    if (typeof args.key !== 'string' || !args.key) {
      return { success: false, error: 'key is required' };
    }
    const { setActiveWorkspaceKey } = await import('./session.js');
    setActiveWorkspaceKey(args.key);
    return { success: true };
  });

  registerTileIpc('tile:session:restore-workspace-snapshot', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
    const check = checkSessionAllowed(grant, 'restore-workspace-snapshot');
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:restore-workspace-snapshot', check.error, args.token);
      return { success: false, error: check.error };
    }
    if (typeof args.key !== 'string' || !args.key) {
      return { success: false, error: 'key is required' };
    }

    try {
      const { restoreSessionSnapshot } = await import('./session.js');
      // `{}` (restoreSession unset) — the general "restore session on
      // launch" preference is a boot-time setting; the user just explicitly
      // asked to enter this workspace, so it always restores. The third
      // argument lets this real, user-initiated restore run under the test
      // profile the desktop specs drive workspace switches in (it bypasses
      // nothing else). `isColdStart` is false: this is a live in-app switch,
      // never the app's own boot — so no crash-recovery dialog either.
      // `isWorkspaceSwitch: true` is what lets `restoreSessionSnapshot` skip
      // an already-open globally-pinned window here without also skipping it
      // on the unrelated interactive "Restore Previous Session" path (which
      // calls this same function with that flag left false).
      const result = await restoreSessionSnapshot({}, undefined, true, false, args.key, true);
      return { success: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // Read a named workspace's saved window bounds/z-order without restoring
  // anything — the narrow substitute for the foreign-settings read
  // features/groups `openGroup()` used to make (see
  // `tile-session-enforcement.ts`'s `get-workspace-snapshot-info` doc for
  // why: `tile:settings:get-foreign` allowlists per-featureId, not per-key,
  // so a `readForeign: ["session"]` grant would also expose the app's own
  // default-workspace snapshot and crash-recovery metadata). The default
  // workspace's own key is refused by `checkSessionAllowed` itself, which is
  // given the key for exactly that rule.
  registerTileIpc('tile:session:get-workspace-snapshot-info', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
    if (typeof args.key !== 'string' || !args.key) {
      return { success: false, error: 'key is required' };
    }
    const check = checkSessionAllowed(grant, 'get-workspace-snapshot-info', { key: args.key });
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:get-workspace-snapshot-info', check.error, args.token);
      return { success: false, error: check.error };
    }

    try {
      const { getWorkspaceSnapshotWindowInfo } = await import('./session.js');
      const windows = getWorkspaceSnapshotWindowInfo(args.key);
      return { success: true, windows: windows ?? [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:session:get-workspace-snapshot-window-count', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
    if (typeof args.key !== 'string' || !args.key) {
      return { success: false, error: 'key is required' };
    }
    const check = checkSessionAllowed(grant, 'get-workspace-snapshot-window-count', { key: args.key });
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:get-workspace-snapshot-window-count', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const { getWorkspaceSnapshotWindowCount } = await import('./session.js');
      return { success: true, count: getWorkspaceSnapshotWindowCount(args.key) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:session:add-window-to-workspace-snapshot', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
    windowId: number;
  }, _grant) => {
    const grant = _grant;
    if (typeof args.key !== 'string' || !args.key) {
      return { success: false, error: 'key is required' };
    }
    if (typeof args.windowId !== 'number') {
      return { success: false, error: 'windowId is required' };
    }
    const check = checkSessionAllowed(grant, 'add-window-to-workspace-snapshot', { key: args.key });
    if (!check.ok) {
      handleViolation(grant, 'session', 'session:add-window-to-workspace-snapshot', check.error, args.token);
      return { success: false, error: check.error };
    }
    try {
      const { addWindowToWorkspaceSnapshot } = await import('./session.js');
      return addWindowToWorkspaceSnapshot(args.key, args.windowId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // ── Network Fetch ──

  registerTileIpc('tile:network:fetch', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
    options?: Record<string, unknown>;
  }, _grant) => {
    const grant = _grant;
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

  // ── AT Protocol DPoP proxy ──
  //
  // Performs the full AT Protocol DPoP request loop in MAIN (DPoP proof
  // signing, DPoP-Nonce retry, 401→refresh→retry) so renderer tiles no
  // longer need `webSecurity:false` to make non-CORS, DPoP-signed XRPC
  // calls. The private DPoP key never crosses IPC — it's read from the
  // persisted Lex session in `feature_settings` (see atproto-session-store.ts).
  //
  // Capability model: gated on the existing `network` capability (Lex
  // already declares it) rather than a brand-new capability — keeping the
  // manifest schema untouched. On TOP of that gate, the proxy enforces its
  // OWN tight atproto host allowlist (user PDS host + token-endpoint host
  // from the session, plus *.bsky.network / *.host.bsky.network /
  // plc.directory) inside `isAtprotoHostAllowed`, so this surface is
  // strictly narrower than the broad `network: ["*"]` the renderer holds.
  //
  // `tile:atproto:request`     — JSON-body XRPC (xrpcGet / xrpcPost).
  // `tile:atproto:upload-blob` — binary-body upload (uploadBlob); base64
  //                              over IPC since structured-clone of large
  //                              Uint8Arrays is the only binary channel.

  const runAtprotoProxy = async (
    grant: CapabilityGrant | null,
    token: string,
    req: AtprotoRequest,
  ): Promise<Record<string, unknown>> => {
    if (!grant || !hasCapability(grant, 'network')) {
      handleViolation(grant, 'network', 'atproto:request', 'network capability not granted', token);
      return { error: 'Network capability not granted' };
    }
    const session = readAtprotoSession();
    if (!session) {
      return { error: 'No AT Protocol session — sign in via Lexicon Studio first' };
    }
    if (!isAtprotoHostAllowed(req.url, session)) {
      let host = req.url;
      try { host = new URL(req.url).hostname; } catch { /* keep raw */ }
      const reason = `atproto host ${host} not allowed for ${grant.tileId}`;
      handleViolation(grant, 'network', 'atproto:request', reason, token);
      return { error: `Host not allowed: ${host}` };
    }
    try {
      const result = await performAtprotoRequest(session, req);
      // Persist a mid-request refresh so the renderer + proxy stay in sync.
      if (result.refreshedSession) {
        try { writeAtprotoSession(result.refreshedSession); }
        catch (e) { DEBUG && console.log('[tile-ipc] atproto session persist failed:', e); }
      }
      // Encode binary bodies as base64 for the IPC return; JSON bodies pass through.
      const body = result.binary
        ? Buffer.from(result.body as Uint8Array).toString('base64')
        : result.body;
      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body,
        binary: result.binary,
        // Signal a refresh happened (no token material — the renderer
        // re-reads its own settings copy if it cares).
        refreshed: !!result.refreshedSession,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  registerTileIpc('tile:atproto:request', { mode: 'handle' }, async (event, args: {
    token: string;
    method: 'GET' | 'POST';
    url: string;
    jsonBody?: unknown;
  }, _grant) => {
    if (args.method !== 'GET' && args.method !== 'POST') {
      return { error: `Unsupported method: ${args.method}` };
    }
    return runAtprotoProxy(_grant, args.token, {
      method: args.method,
      url: args.url,
      jsonBody: args.jsonBody,
    });
  });

  registerTileIpc('tile:atproto:upload-blob', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
    // base64-encoded bytes + content type (binary travels as base64 over IPC).
    dataBase64: string;
    contentType: string;
  }, _grant) => {
    if (typeof args.dataBase64 !== 'string' || typeof args.contentType !== 'string') {
      return { error: 'upload-blob requires dataBase64 + contentType strings' };
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(args.dataBase64, 'base64'));
    } catch {
      return { error: 'Invalid base64 blob data' };
    }
    return runAtprotoProxy(_grant, args.token, {
      method: 'POST',
      url: args.url,
      binaryBody: bytes,
      contentType: args.contentType,
    });
  });

  // ── Filesystem ──

  registerTileIpc('tile:filesystem:read', { mode: 'handle' }, async (event, args: {
    token: string;
    path: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:filesystem:write', { mode: 'handle' }, async (event, args: {
    token: string;
    path: string;
    content: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:theme:info', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
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
  registerTileIpc('tile:theme:get', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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
  registerTileIpc('tile:theme:setColorScheme', { mode: 'handle' }, (event, args: {
    token: string;
    colorScheme: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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
  //   2. The window-state machine's front (the sole focus authority — a
  //      BrowserWindow.getFocusedWindow() fallback used to follow, but the
  //      machine front subsumes it and never returns the chrome overlay)
  //   3. First non-destroyed, non-test-fixture, non-background BrowserWindow
  //      that was not created as modal (by skipping `focusable:false` and
  //      `background.html` URLs). This last branch is the headless-test
  //      fallback — in headless mode all windows have `show:false` so
  //      `isVisible()` is false and no focus events fire.
  registerTileIpc('tile:theme:setWindowColorScheme', { mode: 'handle' }, (event, args: {
    token: string;
    windowId?: number | null;
    colorScheme: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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
      const explicitWin = getLiveWindow(explicitId);
      if (explicitWin) {
        resolvedId = explicitId;
      }
    }

    if (resolvedId === null) {
      const front = getTopmostContentWindowId();
      const frontWin = front != null ? getNativeWindowFor(front) : null;
      if (frontWin) {
        const trackedWin = getLiveWindow(frontWin.id);
        if (trackedWin) {
          resolvedId = frontWin.id;
        }
      }
    }

    if (resolvedId === null) {
      // Headless fallback: find a plausible target by filtering out the
      // test fixture (focusable:false) and the core background renderer
      // (url === peek://app/background.html). Take the highest-numbered
      // matching window as a proxy for "most recently created".
      const candidates = getAllLiveWindows().filter((w) => {
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

    const win = getLiveWindow(resolvedId);
    if (!win) {
      return { success: false, error: 'Window not found' };
    }

    win.webContents.send('tile:theme:changed', { kind: 'window', colorScheme });
    return { success: true, windowId: resolvedId, colorScheme };
  });

  // ── tile:theme:setTheme ────────────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:setTheme` channel.
  // Sets the active theme by id and broadcasts to all windows.
  // Requires trustedBuiltin.
  registerTileIpc('tile:theme:setTheme', { mode: 'handle' }, (event, args: {
    token: string;
    themeId: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:setTheme', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:setTheme' };
    }

    const { themeId } = args;
    if (!setActiveThemeId(themeId)) {
      return { success: false, error: 'Theme not found' };
    }
    tileSetThemeSetting(TILE_THEME_ID_KEY, themeId);

    broadcast('tile:theme:changed', { kind: 'theme', themeId });
    return { success: true, themeId };
  });

  // ── tile:theme:list ────────────────────────────────────────────────
  //
  // Strict counterpart of the legacy `theme:list` channel.
  // Returns metadata for all registered (builtin) themes.
  // Requires trustedBuiltin.
  registerTileIpc('tile:theme:list', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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
  registerTileIpc('tile:theme:getAll', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  // ── tile:theme:pickFolder / validateFolder / add / remove / reload ──
  //
  // Settings UI uses these to install user-supplied themes from disk.
  // trustedBuiltin only — touches filesystem and theme registration.

  registerTileIpc('tile:theme:pickFolder', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:pickFolder', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:pickFolder' };
    }
    try {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      return { success: true, data: { path: result.filePaths[0] } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:theme:validateFolder', { mode: 'handle' }, async (event, args: {
    token: string;
    folderPath?: string;
    path?: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:validateFolder', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:validateFolder' };
    }
    try {
      const themePath = args.folderPath || args.path;
      if (!themePath) return { success: false, error: 'No folder path provided' };
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found in folder' };
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      if (!manifest.id && !manifest.name) {
        return { success: false, error: 'Manifest must have id or name' };
      }

      const variablesFile = manifest.variables || 'variables.css';
      const variablesPath = path.join(themePath, variablesFile.replace(/^\.\//, ''));
      if (!fs.existsSync(variablesPath)) {
        return { success: false, error: `Theme CSS file not found: ${variablesFile}` };
      }

      const validation = validateThemeCSS(variablesPath);
      if (!validation.valid) {
        return {
          success: false,
          error: `Theme CSS missing required variables: ${validation.missing!.join(', ')}`,
        };
      }

      return { success: true, data: { manifest, path: themePath } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:theme:add', { mode: 'handle' }, async (event, args: {
    token: string;
    folderPath?: string;
    path?: string;
    lastError?: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:add', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:add' };
    }
    try {
      const db = getDb();
      const themePath = args.folderPath || args.path;
      if (!themePath) return { success: false, error: 'No folder path provided' };
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found' };
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      const id = manifest.id || manifest.name || `theme_${Date.now()}`;

      const variablesFile = manifest.variables || 'variables.css';
      const cssPath = path.join(themePath, variablesFile.replace(/^\.\//, ''));
      const validation = validateThemeCSS(cssPath);
      if (!validation.valid) {
        return {
          success: false,
          error: `Theme CSS missing required variables: ${validation.missing!.join(', ')}`,
        };
      }

      const existing = db.prepare('SELECT * FROM themes WHERE id = ?').get(id);
      if (existing) {
        return { success: false, error: `Theme ${id} already installed` };
      }

      const lastError = args.lastError || '';
      const lastErrorAt = lastError ? Date.now() : 0;

      db.prepare(`
        INSERT INTO themes (id, name, description, version, author, path, builtin, enabled, installedAt, updatedAt, lastError, lastErrorAt, metadata)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)
      `).run(
        id,
        manifest.name || id,
        manifest.description || '',
        manifest.version || '1.0.0',
        manifest.author || '',
        themePath,
        Date.now(),
        Date.now(),
        lastError,
        lastErrorAt,
        JSON.stringify(manifest),
      );

      registerThemePath(id, themePath);

      return { success: true, data: { id, manifest, path: themePath, lastError: lastError || null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:theme:remove', { mode: 'handle' }, (event, args: {
    token: string;
    themeId?: string;
    id?: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:remove', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:remove' };
    }
    try {
      const db = getDb();
      const themeId = args.themeId || args.id;
      if (!themeId) return { success: false, error: 'No themeId provided' };

      const existing = db.prepare('SELECT * FROM themes WHERE id = ?').get(themeId) as { builtin?: number } | undefined;
      if (!existing) {
        return { success: false, error: `Theme ${themeId} not found` };
      }

      if (existing.builtin === 1) {
        return { success: false, error: 'Cannot remove built-in theme' };
      }

      const activeId = getActiveThemeId();
      if (themeId === activeId) {
        return { success: false, error: 'Cannot remove the active theme. Switch to another theme first.' };
      }

      db.prepare('DELETE FROM themes WHERE id = ?').run(themeId);

      return { success: true, data: { id: themeId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:theme:reload', { mode: 'handle' }, (event, args: {
    token: string;
    themeId?: string;
    id?: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'theme', 'tile:theme:reload', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:theme:reload' };
    }
    try {
      const themeId = args.themeId || args.id;
      if (!themeId) return { success: false, error: 'No themeId provided' };
      const themePath = getThemePath(themeId);
      if (!themePath) {
        return { success: false, error: 'Theme not found' };
      }

      broadcast('theme:reload', { themeId });

      return { success: true, data: { id: themeId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── Settings ──

  registerTileIpc('tile:settings:get', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:settings:set', { mode: 'handle' }, async (event, args: {
    token: string;
    key: string;
    value: unknown;
  }, _grant) => {
    const grant = _grant;
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
  registerTileIpc('tile:settings:get-foreign', { mode: 'handle' }, async (event, args: {
    token: string;
    foreignExtId: string;
    key: string;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:oauth:start-loopback', { mode: 'handle' }, async (event, args: {
    token: string;
    provider?: string;
    callbackPath?: string;
    timeoutMs?: number;
  }, _grant) => {
    const grant = _grant;
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

  registerTileIpc('tile:oauth:await-callback', { mode: 'handle' }, async (event, args: {
    token: string;
    port: number;
  }, _grant) => {
    const grant = _grant;
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
  registerTileIpc('tile:sync:sync-all', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    const grant = _grant;
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
        publish('system', 'sync:pull-completed', {
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

  // ── tile:sync:get-config / set-config / status / pull / push ────────
  //
  // Settings UI consumes these via api.sync.{getConfig,setConfig,
  // getStatus,pull,push}. trustedBuiltin only — sync touches network,
  // server creds, and profile state.

  registerTileIpc('tile:sync:get-config', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'sync', 'tile:sync:get-config', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:sync:get-config' };
    }
    try {
      const config = getSyncConfig();
      return { success: true, data: config };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:sync:set-config', { mode: 'handle' }, (event, args: {
    token: string;
    config: unknown;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'sync', 'tile:sync:set-config', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:sync:set-config' };
    }
    try {
      setSyncConfig(args.config as Parameters<typeof setSyncConfig>[0]);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:sync:status', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'sync', 'tile:sync:status', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:sync:status' };
    }
    try {
      const status = getSyncStatus();
      return { success: true, data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Read-only snapshot of the CURRENT run's progress log (sync.ts's bounded
  // ring buffer). Lets the Settings panel show what already happened when
  // opened mid-run instead of an empty log; live updates arrive separately
  // over the `sync:progress` pubsub topic sync.ts publishes at each stage
  // boundary.
  registerTileIpc('tile:sync:get-log', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'sync', 'tile:sync:get-log', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:sync:get-log' };
    }
    try {
      return { success: true, data: getSyncLog() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:sync:pull', { mode: 'handle' }, async (event, args: {
    token: string;
    since?: number;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'sync', 'tile:sync:pull', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:sync:pull' };
    }
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        return { success: false, error: 'Sync not configured. Set serverUrl and apiKey first.' };
      }

      const since = args.since !== undefined ? args.since : config.lastSyncTime;
      const syncTime = Date.now();

      // Mirrors syncAll()'s pull order — tags, then items, then events — not just
      // pushToServer()'s counterpart below: this handler used to pull items only,
      // silently skipping tags and events despite advancing lastSyncTime as if the
      // whole run had completed. Tag pull before item pull so an incoming item's
      // `tags` array resolves against already-shaped tag rows; event pull after item
      // pull so each event's server itemId has a local item (with syncId) to resolve
      // against.
      const tagPullResult = await pullTagsFromServer(config.serverUrl, config.apiKey, since);
      const result = await pullFromServer(config.serverUrl, config.apiKey, since);
      const eventPullResult = await pullEventsFromServer(config.serverUrl, config.apiKey, since);

      const activeProfile = getActiveProfile();
      updateLastSyncTime(activeProfile.id, syncTime);

      const pulled = tagPullResult.pulled + result.pulled + eventPullResult.pulled;
      if (pulled > 0) {
        publish('system', 'sync:pull-completed', {
          pulled,
          conflicts: result.conflicts,
        });
      }

      return { success: true, data: { pulled, conflicts: result.conflicts } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  registerTileIpc('tile:sync:push', { mode: 'handle' }, async (event, args: {
    token: string;
    since?: number;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'sync', 'tile:sync:push', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:sync:push' };
    }
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        return { success: false, error: 'Sync not configured. Set serverUrl and apiKey first.' };
      }

      const since = args.since !== undefined ? args.since : config.lastSyncTime;
      const syncTime = Date.now();

      // Mirrors syncAll()'s push order — tags, then items, then events. This handler
      // (the Settings "Push to Server" button) used to call pushToServer() alone,
      // silently skipping the tag and event stages while still advancing
      // lastSyncTime as though the push had fully completed. Tag push before item
      // push, event push after item push — same dependency reasons as syncAll()
      // (event push needs the syncId item push just assigned).
      const tagPushResult = await pushTagsToServer(config.serverUrl, config.apiKey);
      const result = await pushToServer(config.serverUrl, config.apiKey, since);
      const eventPushResult = await pushEventsToServer(config.serverUrl, config.apiKey);

      const activeProfile = getActiveProfile();
      updateLastSyncTime(activeProfile.id, syncTime);

      const pushed = tagPushResult.pushed + result.pushed + eventPushResult.pushed;
      return { success: true, data: { pushed, failed: result.failed } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ── tile:sync:list-devices / rename-device / revoke-device /
  //    create-enrolment-code / enrol ─────────────────────────────────
  //
  // Settings UI consumes these via api.sync.{listDevices,renameDevice,
  // revokeDevice,createEnrolmentCode,enrol}. The first four are the Devices
  // panel (account-holder device management, plus its "Add a device" code
  // minting) and run against this install's own configured serverUrl/apiKey.
  // `enrol` is the Sync panel's code-entry alternative to pasting a key — a
  // brand-new device has no apiKey yet, so it takes serverUrl from the caller
  // and needs no config. All trustedBuiltin only, same reasoning as the rest
  // of the sync surface: network + server creds.
  //
  // Every handler here has the same shape — token check, trustedBuiltin
  // check, optional "is sync configured" check, run, wrap errors — so it is
  // written once. A not-configured result carries `notConfigured: true` so
  // the panel can show guidance instead of an error, without a second IPC
  // round trip just to read the config first.

  type SyncSettings = ReturnType<typeof getSyncConfig>;

  function registerTrustedSyncIpc<TArgs extends { token: string }>(
    channel: string,
    options: { requiresConfig: boolean },
    run: (args: TArgs, config: SyncSettings) => Promise<unknown>,
  ): void {
    registerTileIpc(channel, { mode: 'handle' }, async (event, args: TArgs, _grant) => {
      if (!args?.token) return { success: false, error: 'Invalid token' };
      const grant = _grant;
      if (!grant.trustedBuiltin) {
        handleViolation(grant, 'sync', channel, 'trustedBuiltin required', args.token);
        return { success: false, error: `trustedBuiltin required for ${channel}` };
      }
      try {
        const config = getSyncConfig();
        if (options.requiresConfig && (!config.serverUrl || !config.apiKey)) {
          return {
            success: false,
            notConfigured: true,
            error: 'Sync not configured. Set serverUrl and apiKey first.',
          };
        }
        return { success: true, data: await run(args, config) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    });
  }

  registerTrustedSyncIpc<{ token: string }>(
    'tile:sync:list-devices',
    { requiresConfig: true },
    (_args, config) => listDevices(config.serverUrl, config.apiKey),
  );

  registerTrustedSyncIpc<{ token: string; deviceId: string; label: string }>(
    'tile:sync:rename-device',
    { requiresConfig: true },
    (args, config) => renameDevice(config.serverUrl, config.apiKey, args.deviceId, args.label),
  );

  // Revoking the device this install is signed in as is allowed (the server
  // decides — it knows which key made the request) and comes back with
  // `current: true`. The now-dead key is dropped here, in the main process,
  // rather than left for the renderer to clean up: whatever the panel does
  // next, no later sync runs with a key the server will refuse.
  //
  // `current` is set from the requesting key's own device id, independent of
  // whether THIS call performed the revoke — a retry against an
  // already-revoked own device (lost response, two tabs both firing revoke)
  // comes back `{ revoked: false, current: true }`, not `revoked: true`. The
  // local key must still go: the device is revoked server-side either way,
  // and only `current` tells us it's ours. Gating on `result.revoked` too
  // would leave a dead key on disk for exactly the retry case this exists to
  // handle. A different device's revoke (or a failed/errored call, which
  // throws before `result` exists) never has `current: true`.
  registerTrustedSyncIpc<{ token: string; deviceId: string }>(
    'tile:sync:revoke-device',
    { requiresConfig: true },
    async (args, config) => {
      const result = await revokeDevice(config.serverUrl, config.apiKey, args.deviceId);
      if (result.current) {
        clearSyncCredentials();
      }
      return result;
    },
  );

  registerTrustedSyncIpc<{ token: string }>(
    'tile:sync:create-enrolment-code',
    { requiresConfig: true },
    (_args, config) => createEnrolmentCode(config.serverUrl, config.apiKey),
  );

  registerTrustedSyncIpc<{ token: string; serverUrl: string; code: string; label?: string }>(
    'tile:sync:enrol',
    { requiresConfig: false },
    async (args) => {
      if (!args.serverUrl || !args.code) {
        throw new Error('Server URL and code are required');
      }
      return exchangeEnrolmentCode(args.serverUrl, args.code, args.label);
    },
  );

  // ── tile:profiles:* ──────────────────────────────────────────────
  //
  // Settings UI consumes via api.profiles. trustedBuiltin only —
  // admin surface (touches profiles.db, can relaunch app, holds sync
  // creds).

  registerTileIpc('tile:profiles:list', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:list', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:list' };
    }
    try {
      return { success: true, data: listProfiles() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:create', { mode: 'handle' }, (event, args: {
    token: string;
    name: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:create', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:create' };
    }
    try {
      return { success: true, data: createProfile(args.name) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:get', { mode: 'handle' }, (event, args: {
    token: string;
    slug: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:get', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:get' };
    }
    try {
      const profile = getProfileByFolder(args.slug);
      if (!profile) return { success: false, error: 'Profile not found' };
      return { success: true, data: profile };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:delete', { mode: 'handle' }, (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:delete', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:delete' };
    }
    try {
      deleteProfile(args.id);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:getCurrent', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:getCurrent', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:getCurrent' };
    }
    try {
      return { success: true, data: getActiveProfile() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:switch', { mode: 'handle' }, (event, args: {
    token: string;
    slug: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:switch', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:switch' };
    }
    try {
      DEBUG && console.log(`[tile:profiles] Switch requested to profile: ${args.slug}`);
      const currentProfile = getActiveProfile();
      if (currentProfile.folder === args.slug) {
        return { success: true, message: 'Already on this profile' };
      }
      const profile = getProfileByFolder(args.slug);
      if (!profile) return { success: false, error: 'Profile not found' };
      setActiveProfile(args.slug);
      app.relaunch();
      app.quit();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:enableSync', { mode: 'handle' }, (event, args: {
    token: string;
    profileId: string;
    apiKey: string;
    serverProfileSlug: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:enableSync', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:enableSync' };
    }
    try {
      enableSync(args.profileId, args.apiKey, args.serverProfileSlug);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:disableSync', { mode: 'handle' }, (event, args: {
    token: string;
    profileId: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:disableSync', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:disableSync' };
    }
    try {
      disableSync(args.profileId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:getSyncConfig', { mode: 'handle' }, (event, args: {
    token: string;
    profileId: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:getSyncConfig', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:getSyncConfig' };
    }
    try {
      return { success: true, data: getProfileSyncConfig(args.profileId) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:profiles:getPartition', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'profiles', 'tile:profiles:getPartition', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:profiles:getPartition' };
    }
    try {
      const { getPartitionString, getCurrentProfileId } = await import('./session-partition.js');
      const profileId = getCurrentProfileId();
      if (!profileId) return { success: false, error: 'No profile session initialized' };
      const partition = getPartitionString(profileId);
      return { success: true, data: { profileId, partition } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── tile:adblocker:* ────────────────────────────────────────────
  //
  // Settings + page widget consume via api.adblocker.*. trustedBuiltin
  // only — global blocker state + per-site allowlist persisted to
  // feature_settings.
  //
  // Per-site allowlist storage helpers — keep DRY across the four
  // handlers that touch it.

  function _readAdblockerAllowlist(): string[] {
    const db = getDb();
    const row = db.prepare(
      'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get('core', 'adblocker_allowlist') as { value: string } | undefined;
    return row?.value ? JSON.parse(row.value) : [];
  }

  function _writeAdblockerAllowlist(list: string[]): void {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `).run('core_adblocker_allowlist', 'core', 'adblocker_allowlist', JSON.stringify(list), Date.now());
  }

  registerTileIpc('tile:adblocker:getStatus', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:getStatus', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:getStatus' };
    }
    try {
      const { getAdblockerStatus } = await import('./adblocker.js');
      return { success: true, data: getAdblockerStatus() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:enable', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:enable', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:enable' };
    }
    try {
      const { applyAdblockerConfig } = await import('./adblocker.js');
      await applyAdblockerConfig({ enabled: true });
      persistAdBlockerPref(true);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:disable', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:disable', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:disable' };
    }
    try {
      const { disableBlocking } = await import('./adblocker.js');
      disableBlocking();
      persistAdBlockerPref(false);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:getBlockedCount', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:getBlockedCount', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:getBlockedCount' };
    }
    try {
      const { getBlockedCount } = await import('./adblocker.js');
      return { success: true, data: getBlockedCount() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:getAllowlist', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:getAllowlist', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:getAllowlist' };
    }
    try {
      return { success: true, data: _readAdblockerAllowlist() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:isSiteAllowed', { mode: 'handle' }, (event, args: {
    token: string;
    hostname: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:isSiteAllowed', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:isSiteAllowed' };
    }
    try {
      return { success: true, data: _readAdblockerAllowlist().includes(args.hostname) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:allowSite', { mode: 'handle' }, (event, args: {
    token: string;
    hostname: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:allowSite', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:allowSite' };
    }
    try {
      const list = _readAdblockerAllowlist();
      if (!list.includes(args.hostname)) list.push(args.hostname);
      _writeAdblockerAllowlist(list);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:adblocker:disallowSite', { mode: 'handle' }, (event, args: {
    token: string;
    hostname: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'adblocker', 'tile:adblocker:disallowSite', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:adblocker:disallowSite' };
    }
    try {
      const list = _readAdblockerAllowlist().filter(h => h !== args.hostname);
      _writeAdblockerAllowlist(list);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Web Permissions (settings UI) ──
  //
  // Read/clear stored per-origin permission decisions persisted by the web
  // permission handler (see apps/desktop/main/permission-handler.ts +
  // permission-store.ts). All handlers gate on `trustedBuiltin` so only
  // peek-core renderers (settings page) can list/revoke; tile renderers
  // can't snoop or tamper with another tile's stored decisions.

  registerTileIpc('tile:permissions:list', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'permissions', 'tile:permissions:list', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:permissions:list' };
    }
    try {
      const { getDb } = await import('./datastore.js');
      const db = getDb();
      if (!db) return { success: true, data: [] };
      const { listDecisions } = await import('./permission-store.js');
      return { success: true, data: listDecisions(db as unknown as Parameters<typeof listDecisions>[0]) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:permissions:forget', { mode: 'handle' }, async (event, args: {
    token: string;
    origin: string;
    permission: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'permissions', 'tile:permissions:forget', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:permissions:forget' };
    }
    if (!args.origin || !args.permission) {
      return { success: false, error: 'origin and permission required' };
    }
    try {
      const { getDb } = await import('./datastore.js');
      const db = getDb();
      if (!db) return { success: false, error: 'datastore not ready' };
      const { forgetDecision } = await import('./permission-store.js');
      forgetDecision(db as unknown as Parameters<typeof forgetDecision>[0], args.origin, args.permission);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:permissions:forgetAll', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'permissions', 'tile:permissions:forgetAll', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:permissions:forgetAll' };
    }
    try {
      const { getDb } = await import('./datastore.js');
      const db = getDb();
      if (!db) return { success: false, error: 'datastore not ready' };
      const { forgetAllDecisions } = await import('./permission-store.js');
      forgetAllDecisions(db as unknown as Parameters<typeof forgetAllDecisions>[0]);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
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

  registerTileIpc('tile:datastore:get-table', { mode: 'handle' }, async (event, args: {
    token: string;
    table?: string;
    tableName?: string;
  }, _grant) => {    const table = args?.tableName ?? args?.table;
    const check = validateTileDatastoreRequest(args?.token, [table as string]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-table', check.error); return { error: check.error }; }
    try {
      const data = dsGetTable(table as TableName);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-row', { mode: 'handle' }, async (event, args: {
    token: string;
    table?: string;
    tableName?: string;
    rowId: string;
  }, _grant) => {    const table = args?.tableName ?? args?.table;
    const check = validateTileDatastoreRequest(args?.token, [table as string]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-row', check.error); return { error: check.error }; }
    try {
      const data = dsGetRow(table as TableName, args.rowId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:set-row', { mode: 'handle' }, async (event, args: {
    token: string;
    table?: string;
    tableName?: string;
    rowId: string;
    rowData: Record<string, unknown>;
  }, _grant) => {    const table = args?.tableName ?? args?.table;
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

  registerTileIpc('tile:datastore:get', { mode: 'handle' }, async (event, args: {
    token: string;
    table: string;
    key: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, [args?.table]);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get', check.error); return { error: check.error }; }
    try {
      const data = dsGetRow(args.table as TableName, args.key);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:set', { mode: 'handle' }, async (event, args: {
    token: string;
    table: string;
    key: string;
    value: unknown;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, [args?.table]);
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

  registerTileIpc('tile:datastore:query', { mode: 'handle' }, async (event, args: {
    token: string;
    table: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, [args?.table]);
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

  registerTileIpc('tile:datastore:add-item', { mode: 'handle' }, async (event, args: {
    token: string;
    type: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-item', check.error); return { error: check.error }; }
    try {
      // dsAddItem takes ItemType; trust the caller to pass a valid one.
      const result = dsAddItem(args.type as Parameters<typeof dsAddItem>[0], (args.options as Parameters<typeof dsAddItem>[1]) || {});
      publish('system', 'item:created', {
        itemId: result.id,
        itemType: args.type,
        content: (args.options as Record<string, unknown> | undefined)?.content,
      });
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-item', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item', check.error); return { error: check.error }; }
    try {
      const data = dsGetItem(args.id);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:find-url-item', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:find-url-item', check.error); return { error: check.error }; }
    try {
      const data = dsFindUrlItem(args.url);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:update-item', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
    options: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-item', check.error); return { error: check.error }; }
    try {
      const result = dsUpdateItem(args.id, args.options as Parameters<typeof dsUpdateItem>[1]);
      if (result) {
        const db = getDb();
        const item = db.prepare('SELECT type FROM items WHERE id = ?').get(args.id) as { type: string } | undefined;
        publish('system', 'item:updated', {
          itemId: args.id,
          itemType: item?.type,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:delete-item', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-item', check.error); return { error: check.error }; }
    try {
      const db = getDb();
      const item = db.prepare('SELECT type FROM items WHERE id = ?').get(args.id) as { type: string } | undefined;
      const result = dsDeleteItem(args.id);
      if (result) {
        publish('system', 'item:deleted', {
          itemId: args.id,
          itemType: item?.type,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:restore-item', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:restore-item', check.error); return { error: check.error }; }
    try {
      const result = dsRestoreItem(args.id);
      if (result) {
        const item = getDb().prepare('SELECT type FROM items WHERE id = ?').get(args.id) as { type: string } | undefined;
        publish('system', 'item:restored', {
          itemId: args.id,
          itemType: item?.type,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:query-items', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-items', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItems(args.filter as Parameters<typeof dsQueryItems>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Tag operations ──

  registerTileIpc('tile:datastore:get-or-create-tag', { mode: 'handle' }, async (event, args: {
    token: string;
    name: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-or-create-tag', check.error); return { error: check.error }; }
    try {
      const data = dsGetOrCreateTag(args.name);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-tags-by-frecency', { mode: 'handle' }, async (event, args: {
    token: string;
    domain?: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-tags-by-frecency', check.error); return { error: check.error }; }
    try {
      const data = dsGetTagsByFrecency(args.domain);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Item-tag link operations (multi-table) ──

  registerTileIpc('tile:datastore:tag-item', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
    tagId: string;
  }, _grant) => {    // Writes to item_tags, reads/updates tags frequency, reads items implicitly.
    // Require both 'tags' and 'item_tags' to be granted (matching feature manifests).
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:tag-item', check.error); return { error: check.error }; }
    try {
      const result = dsTagItem(args.itemId, args.tagId);
      if (!result.alreadyExists) {
        const db = getDb();
        const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
        const item = db.prepare('SELECT type FROM items WHERE id = ?').get(args.itemId) as { type: string } | undefined;
        publish('system', 'tag:item-added', {
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

  registerTileIpc('tile:datastore:untag-item', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
    tagId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:untag-item', check.error); return { error: check.error }; }
    try {
      const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
      const result = dsUntagItem(args.itemId, args.tagId);
      if (result) {
        publish('system', 'tag:item-removed', {
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

  registerTileIpc('tile:datastore:get-item-tags', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
  }, _grant) => {    // Joins tags × item_tags — require both.
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item-tags', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemTags(args.itemId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-all-item-tags', { mode: 'handle' }, async (_event, args: {
    token: string;
  }, _grant) => {
    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-all-item-tags', check.error); return { error: check.error }; }
    try {
      const data = dsGetAllItemTags();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-items-by-tag', { mode: 'handle' }, async (event, args: {
    token: string;
    tagId: string;
  }, _grant) => {    // Joins items × item_tags — require both.
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

  registerTileIpc('tile:datastore:add-item-event', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsAddItemEvent(args.itemId, args.options as Parameters<typeof dsAddItemEvent>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-item-event', { mode: 'handle' }, async (event, args: {
    token: string;
    eventId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemEvent(args.eventId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:query-item-events', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-item-events', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItemEvents(args.filter as Parameters<typeof dsQueryItemEvents>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-latest-item-event', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-latest-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsGetLatestItemEvent(args.itemId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:count-item-events', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
    filter?: { since?: number; until?: number };
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:count-item-events', check.error); return { error: check.error }; }
    try {
      const data = dsCountItemEvents(args.itemId, args.filter || {});
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:delete-item-event', { mode: 'handle' }, async (event, args: {
    token: string;
    eventId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-item-event', check.error); return { error: check.error }; }
    try {
      const data = dsDeleteItemEvent(args.eventId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:delete-item-events', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_events']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-item-events', check.error); return { error: check.error }; }
    try {
      const data = dsDeleteItemEvents(args.itemId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Additional tag operations ──

  registerTileIpc('tile:datastore:rename-tag', { mode: 'handle' }, async (event, args: {
    token: string;
    tagId: string;
    newName: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:rename-tag', check.error); return { error: check.error }; }
    try {
      const data = dsRenameTag(args.tagId, args.newName);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:update-tag-color', { mode: 'handle' }, async (event, args: {
    token: string;
    tagId: string;
    color: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-tag-color', check.error); return { error: check.error }; }
    try {
      const data = dsUpdateTagColor(args.tagId, args.color);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:delete-tag', { mode: 'handle' }, async (event, args: {
    token: string;
    tagId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:delete-tag', check.error); return { error: check.error }; }
    try {
      const data = dsDeleteTag(args.tagId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Stats (no table restriction) ──

  registerTileIpc('tile:datastore:get-stats', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, []);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-stats', check.error); return { error: check.error }; }
    try {
      const data = dsGetStats();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Additional item operations ──

  registerTileIpc('tile:datastore:hard-delete-item', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:hard-delete-item', check.error); return { error: check.error }; }
    try {
      const data = dsHardDeleteItem(args.id);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:update-item-title', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
    title: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-item-title', check.error); return { error: check.error }; }
    try {
      const data = dsUpdateItemTitle(args.url, args.title);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:update-item-favicon', { mode: 'handle' }, async (event, args: {
    token: string;
    url: string;
    faviconUrl: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:update-item-favicon', check.error); return { error: check.error }; }
    try {
      const data = dsUpdateItemFavicon(args.url, args.faviconUrl);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Visit / history operations (require 'items') ──

  registerTileIpc('tile:datastore:record-item-visit', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:record-item-visit', check.error); return { error: check.error }; }
    try {
      const data = dsRecordItemVisit(args.itemId, args.options as Parameters<typeof dsRecordItemVisit>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-item-visits', { mode: 'handle' }, async (event, args: {
    token: string;
    itemId: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-item-visits', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemVisits(args.itemId, args.filter as Parameters<typeof dsGetItemVisits>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:query-item-visits', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-item-visits', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItemVisits(args.filter as Parameters<typeof dsQueryItemVisits>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-history', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
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

  registerTileIpc('tile:datastore:track-navigation', { mode: 'handle' }, async (event, args: {
    token: string;
    uri: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:track-navigation', check.error); return { error: check.error }; }
    try {
      // Session-restored windows carry params.skipTracking=true. The first
      // navigation after restore (the saved URL re-loading) is not a real
      // user navigation and shouldn't pollute history/frecency. Consume the
      // flag on first call so subsequent user-initiated navigations from
      // the same window are tracked normally.
      const callerWin = windowFromWebContents(event.sender);
      if (callerWin) {
        const info = getWindowInfo(callerWin.id);
        if (info?.params?.skipTracking) {
          info.params.skipTracking = false;
          return { success: true, data: { skipped: true } };
        }
      }
      const data = dsTrackNavigation(args.uri, args.options as Parameters<typeof dsTrackNavigation>[1]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:query-items-by-frecency', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-items-by-frecency', check.error); return { error: check.error }; }
    try {
      const data = dsQueryItemsByFrecency(args.filter as Parameters<typeof dsQueryItemsByFrecency>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── Address compat shims (redirect to items + backward-compat shape) ──

  registerTileIpc('tile:datastore:add-address', { mode: 'handle' }, async (event, args: {
    token: string;
    uri: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
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
      publish('system', 'item:created', {
        itemId: result.id, itemType: 'url', content: normalizedUri,
      });
      return { success: true, data: result, id: result.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-address', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-address', check.error); return { error: check.error }; }
    try {
      const item = dsGetItem(args.id);
      if (!item) return { success: true, data: undefined };
      return { success: true, data: _itemToAddress(item) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:update-address', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
    updates: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
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

  registerTileIpc('tile:datastore:query-addresses', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items']);
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

  registerTileIpc('tile:datastore:add-visit', { mode: 'handle' }, async (event, args: {
    token: string;
    addressId: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_visits']);
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

  registerTileIpc('tile:datastore:query-visits', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['item_visits']);
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

  registerTileIpc('tile:datastore:add-content', { mode: 'handle' }, async (event, args: {
    token: string;
    options?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['content']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:add-content', check.error); return { error: check.error }; }
    try {
      const data = dsAddContent(args.options as Parameters<typeof dsAddContent>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:query-content', { mode: 'handle' }, async (event, args: {
    token: string;
    filter?: Record<string, unknown>;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['content']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:query-content', check.error); return { error: check.error }; }
    try {
      const data = dsQueryContent(args.filter as Parameters<typeof dsQueryContent>[0]);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:tag-address', { mode: 'handle' }, async (event, args: {
    token: string;
    addressId: string;
    tagId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:tag-address', check.error); return { error: check.error }; }
    try {
      const result = dsTagItemAndPublish(args.addressId, args.tagId);
      if (!result.alreadyExists) {
        const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
        publish('system', 'tag:address-added', {
          tagId: args.tagId, tagName: tag?.name, addressId: args.addressId,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:untag-address', { mode: 'handle' }, async (event, args: {
    token: string;
    addressId: string;
    tagId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:untag-address', check.error); return { error: check.error }; }
    try {
      const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(args.tagId) as { name: string } | undefined;
      const result = dsUntagItem(args.addressId, args.tagId);
      if (result) {
        publish('system', 'tag:address-removed', {
          tagId: args.tagId, tagName: tag?.name, addressId: args.addressId,
        });
        publish('system', 'tag:item-removed', {
          tagId: args.tagId, tagName: tag?.name, itemId: args.addressId,
        });
      }
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-address-tags', { mode: 'handle' }, async (event, args: {
    token: string;
    addressId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['tags', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-address-tags', check.error); return { error: check.error }; }
    try {
      const data = dsGetItemTags(args.addressId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-addresses-by-tag', { mode: 'handle' }, async (event, args: {
    token: string;
    tagId: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items', 'item_tags']);
    if ('error' in check) { handleDatastoreViolation(args?.token, 'datastore:get-addresses-by-tag', check.error); return { error: check.error }; }
    try {
      const items = dsGetItemsByTag(args.tagId);
      return { success: true, data: items.map(_itemToAddress) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerTileIpc('tile:datastore:get-untagged-addresses', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {    const check = validateTileDatastoreRequest(args?.token, ['items', 'item_tags']);
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

  // NOTE: bare `feature-*` ipcMain handlers (feature-browse, feature-publish,
  // feature-update, feature-dev, feature-devtools) were deleted in the
  // v1-removal pass. Every caller routes through the strict
  // `tile:features:*` mirrors above, which enforce token + capability gating.
  // See `tile-preload.cts` `api.features` for the renderer surface.

  // ── tile:chrome-extensions:* strict shims ────────────────────────
  //
  // Strict counterparts of the legacy `chrome-ext:*` channels in ipc.ts.
  // All handlers require trustedBuiltin — feature tiles must not be able
  // to enumerate or launch chrome extensions through the tile surface.
  // Wave 3.6d will flip tile-preload.cts to call these channels and
  // remove the legacy `chrome-ext:*` invocations.

  registerTileIpc('tile:chrome-extensions:list', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:chrome-extensions:enable', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:chrome-extensions:disable', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:chrome-extensions:getStatus', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:chrome-extensions:getUiEntries', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:chrome-extensions:openPage', { mode: 'handle' }, async (event, args: {
    token: string;
    id: string;
    type: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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
  registerTileIpc('tile:log:write', { mode: 'on' }, (event, args: {
    token: string;
    args?: unknown[];
    source?: string;
  }, _grant) => {
    if (!args?.token) return;
    const grant = _grant;
    const shortSource = (args.source ?? grant.tileId)
      .replace('peek://app/', '')
      .replace('peek://', '');
    console.log(`[${shortSource}]`, ...(args.args ?? []));
  });

  // ── tile:app:quit ─────────────────────────────────────────────────
  //
  // Strict shim for the legacy `app-quit` channel. Requires trustedBuiltin
  // (only core tiles — cmd, hud, page — may quit the application).
  registerTileIpc('tile:app:quit', { mode: 'on' }, (event, args: {
    token: string;
    source?: string;
  }, _grant) => {
    if (!args?.token) return;
    const grant = _grant;
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
  registerTileIpc('tile:app:restart', { mode: 'on' }, (event, args: {
    token: string;
    source?: string;
  }, _grant) => {
    if (!args?.token) return;
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:restart', 'trustedBuiltin required', args.token);
      return;
    }
    DEBUG && console.log('[tile-ipc] app:restart requested from:', args.source ?? grant.tileId);
    app.relaunch();
    app.quit();
  });

  // ── tile:backup:* strict shims ───────────────────────────────────────
  //
  // Backup create/list/restore handlers. All require trustedBuiltin —
  // settings/diagnostic/page-host tiles consume these.

  registerTileIpc('tile:backup:create', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:backup:list', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:backup:get-config', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  // ── tile:shell:open-path strict shim ────────────────────────────────
  //
  // Strict counterpart of the legacy `shell-open-path` channel.
  // Requires trustedBuiltin — opens a path in the OS file manager.

  registerTileIpc('tile:shell:open-path', { mode: 'handle' }, async (event, args: {
    token: string;
    path: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:app:default-browser-status', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:app:set-default-browser', { mode: 'handle' }, async (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:set-default-browser', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:set-default-browser' };
    }
    wmLog('set-default-browser-requested', { from: event.sender.getURL(), headless: isHeadless() });
    // A headless run is a test or agent run: registering as the default browser
    // changes the machine's setting and raises an OS confirmation prompt.
    if (isHeadless()) {
      return { success: false, error: 'Not available in a headless run.' };
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

  registerTileIpc('tile:app:get-prefs', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:get-prefs', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:get-prefs' };
    }
    return getPrefs();
  });

  // tile:app:cli-helper-path — absolute path to scripts/peek-cli.mjs,
  // resolved correctly for the current packaging (source / asar-unpack
  // / AppImage shadow). Useful for diagnostic display and for callers
  // that want to roll their own invocation; for the actual GNOME-bind
  // command, prefer tile:app:cli-command which formats the full
  // ELECTRON_RUN_AS_NODE invocation. See
  // apps/desktop/main/cli-helper.ts and docs/global-hotkeys-on-wayland.md.
  registerTileIpc('tile:app:cli-helper-path', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:cli-helper-path', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:cli-helper-path' };
    }
    return { success: true, data: { path: resolveCliHelperPath() } };
  });

  // tile:app:cli-command — full shell-ready command users paste into
  // GNOME / KDE / Hyprland custom-shortcut UIs to bind a verb. Wraps
  // ELECTRON_RUN_AS_NODE=1 + bundled Electron + helper script + verb in
  // `sh -c '…'`. See cli-helper.ts::formatCliCommand.
  registerTileIpc('tile:app:cli-command', { mode: 'handle' }, (event, args: {
    token: string;
    verb: string;
    args?: string[];
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'app', 'tile:app:cli-command', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:app:cli-command' };
    }
    if (typeof args.verb !== 'string' || !args.verb) {
      return { success: false, error: 'verb is required' };
    }
    const verbArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    return { success: true, data: { command: formatCliCommand(args.verb, verbArgs) } };
  });

  // ── tile:darkMode:* ──────────────────────────────────────────────
  //
  // Settings UI consumes these via api.darkMode.{get,set} in
  // tile-preload. trustedBuiltin only — dark mode is global app state.

  registerTileIpc('tile:darkMode:get', { mode: 'handle' }, (event, args: {
    token: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'darkMode', 'tile:darkMode:get', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:darkMode:get' };
    }
    const mode = getDarkModeSetting();
    return {
      success: true,
      data: {
        mode,
        // Tier 2 (WebContentsForceDark) requires app restart to take effect.
        tier2Active: app.commandLine.hasSwitch('enable-features') &&
          (app.commandLine.getSwitchValue('enable-features') || '').includes('WebContentsForceDark'),
      },
    };
  });

  registerTileIpc('tile:darkMode:set', { mode: 'handle' }, (event, args: {
    token: string;
    mode: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'darkMode', 'tile:darkMode:set', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:darkMode:set' };
    }
    const mode = args.mode;
    if (!['off', 'system', 'force'].includes(mode)) {
      return { success: false, error: 'Invalid dark mode value. Must be "off", "system", or "force".' };
    }

    const previousMode = getDarkModeSetting();
    setDarkModeSetting(mode);
    applyDarkModeSetting(mode);

    const tier2Changed = (previousMode === 'force') !== (mode === 'force');

    broadcast('darkMode:changed', { mode });

    return { success: true, data: { mode, restartRequired: tier2Changed } };
  });

  // ── tile:nav:* strict shims ──────────────────────────────────────
  //
  // Strict counterparts of the legacy `web-nav-*` channels in ipc.ts.
  // All require trustedBuiltin — only the core background renderer uses these.

  const tileResolveWebWindow = (windowId?: number): BrowserWindow | null => {
    // Caller-supplied ids are ELECTRON ids (renderer surface); the machine's
    // front is a WM WindowId — resolve it to the native window's id first.
    let id: number | null = typeof windowId === 'number' ? windowId : null;
    if (id == null) {
      const front = getTopmostContentWindowId();
      const frontWin = front != null ? getNativeWindowFor(front) : null;
      id = frontWin ? frontWin.id : null;
    }
    if (!id) return null;
    const win = getLiveWindow(id);
    if (!win) return null;
    const winUrl = win.webContents.getURL();
    if (!winUrl.startsWith('http://') && !winUrl.startsWith('https://')) return null;
    return win;
  };

  registerTileIpc('tile:nav:back', { mode: 'handle' }, (event, args: { token: string; windowId?: number }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:nav:forward', { mode: 'handle' }, (event, args: { token: string; windowId?: number }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:nav:reload', { mode: 'handle' }, (event, args: { token: string; windowId?: number }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'nav', 'tile:nav:reload', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:nav:reload' };
    }
    const win = tileResolveWebWindow(args.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    win.webContents.reload();
    return { success: true };
  });

  registerTileIpc('tile:nav:state', { mode: 'handle' }, (event, args: { token: string; windowId?: number }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  // ── tile:session:* strict shims ──────────────────────────────────
  //
  // Strict counterparts of the legacy `session-save`,
  // `session-restore-interactive`, and `window-reopen-last-closed` channels.
  // All require trustedBuiltin.

  registerTileIpc('tile:session:save', { mode: 'handle' }, async (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:session:restore-interactive', { mode: 'handle' }, async (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
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

  registerTileIpc('tile:session:reopen-last-closed', { mode: 'handle' }, (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'session', 'tile:session:reopen-last-closed', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:session:reopen-last-closed' };
    }
    return reopenLastClosedWindow();
  });

  // ── tile:debug:get / tile:debug:set ─────────────────────────────────
  //
  // Read and mutate the runtime debug flags (verbose logging + devtools
  // for new windows). Persistence is wired in main.ts via
  // installDebugFlagsPersistence; this handler only updates in-process
  // state. The change listener registered below broadcasts the new state
  // to all subscribers as `peek:debug:changed`.
  //
  // trustedBuiltin only — the toggles are developer tools, not user-
  // exposed surface. The Settings UI and the features/debug cmd-palette
  // tile both run with trustedBuiltin grants.

  registerTileIpc('tile:debug:get', { mode: 'handle' }, (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'debug', 'tile:debug:get', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:debug:get' };
    }
    return { success: true, state: getDebugFlags() };
  });

  registerTileIpc('tile:debug:set', { mode: 'handle' }, (event, args: {
    token: string;
    verbose?: boolean;
    devtools?: boolean;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'debug', 'tile:debug:set', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:debug:set' };
    }
    if (typeof args.verbose === 'boolean') setDebug(args.verbose);
    if (typeof args.devtools === 'boolean') setDevTools(args.devtools);
    return { success: true, state: getDebugFlags() };
  });

  // Broadcast debug-flag changes so subscribers (Settings UI, the debug
  // cmd-palette tile, anything else interested) re-render without polling.
  // Listener is idempotent at the debug-flag layer — only real flips fire
  // it — so this isn't a write-amp risk.
  onDebugFlagsChange((state) => {
    publish('system', 'peek:debug:changed', state);
  });

  // ── tile:mcp:status / tile:mcp:set-enabled ──────────────────────────
  //
  // Read/write the `mcpServers.peek` entry in ~/.claude/settings.json.
  // Backs the Settings → Diagnostics → "MCP server" toggle. Off by
  // default — the entry only exists after the user opts in.
  //
  // trustedBuiltin only: writing user config files is not a surface
  // exposed to third-party tiles.

  registerTileIpc('tile:mcp:status', { mode: 'handle' }, (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'mcp', 'tile:mcp:status', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:mcp:status' };
    }
    return { success: true, state: getMcpStatus() };
  });

  registerTileIpc('tile:mcp:set-config', { mode: 'handle' }, (event, args: {
    token: string;
    enabled?: boolean;
    profile?: string;
    readonly?: boolean;
    scopeTag?: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'mcp', 'tile:mcp:set-config', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:mcp:set-config' };
    }
    try {
      const patch: { enabled?: boolean; profile?: string; readonly?: boolean; scopeTag?: string } = {};
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
      if (typeof args.profile === 'string') patch.profile = args.profile;
      if (typeof args.readonly === 'boolean') patch.readonly = args.readonly;
      if (typeof args.scopeTag === 'string') patch.scopeTag = args.scopeTag;
      const state = setMcpConfig(patch);
      return { success: true, state };
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? String(err) };
    }
  });

  // ── tile:mcp:list-scoped-projects / scaffold-project / remove-scoped-project / pick-directory ──
  //
  // Backs the Settings → MCP "Project scopes" subsection. Each call is
  // trustedBuiltin only — writing user files is not a third-party surface.

  registerTileIpc('tile:mcp:list-scoped-projects', { mode: 'handle' }, (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'mcp', 'tile:mcp:list-scoped-projects', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:mcp:list-scoped-projects' };
    }
    return { success: true, projects: listScopedProjects() };
  });

  registerTileIpc('tile:mcp:scaffold-project', { mode: 'handle' }, (event, args: {
    token: string;
    dirPath?: string;
    scopeTag?: string;
    profile?: string;
    readonly?: boolean;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'mcp', 'tile:mcp:scaffold-project', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:mcp:scaffold-project' };
    }
    try {
      const result = scaffoldProject({
        dirPath: args.dirPath || '',
        scopeTag: args.scopeTag || '',
        profile: args.profile,
        readonly: args.readonly,
      });
      return result;
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? String(err) };
    }
  });

  registerTileIpc('tile:mcp:remove-scoped-project', { mode: 'handle' }, (event, args: {
    token: string;
    dirPath?: string;
  }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'mcp', 'tile:mcp:remove-scoped-project', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:mcp:remove-scoped-project' };
    }
    try {
      return removeScopedProject(args.dirPath || '');
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? String(err) };
    }
  });

  registerTileIpc('tile:mcp:pick-directory', { mode: 'handle' }, async (event, args: { token: string }, _grant) => {
    if (!args?.token) return { success: false, error: 'Invalid token' };
    const grant = _grant;
    if (!grant.trustedBuiltin) {
      handleViolation(grant, 'mcp', 'tile:mcp:pick-directory', 'trustedBuiltin required', args.token);
      return { success: false, error: 'trustedBuiltin required for tile:mcp:pick-directory' };
    }
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Pick a project directory to scope',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (err) {
      return { success: false, error: (err as Error)?.message ?? String(err) };
    }
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
  broadcast('tile:theme:changed', { kind: 'colorScheme', colorScheme });
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
