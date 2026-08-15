/**
 * Desktop Sync Module
 *
 * Handles bidirectional sync between the desktop app and the server.
 * Uses the unified item types (url, text, tagset, image) across all platforms.
 *
 * Sync Protocol:
 * - Pull: GET /items (or /items/since/:timestamp for incremental)
 * - Push: POST /items for each local item
 * - Conflict resolution: last-write-wins based on updatedAt
 */

import type {
  Item,
  ItemType,
  SyncConfig,
  SyncResult,
  ServerItem,
  Tag,
} from '../types/index.js';
import {
  getDb,
  queryItems,
  addItem,
  updateItem,
  getItemTags,
  getOrCreateTag,
  generateId,
} from './datastore.js';
import { tagItemAndPublish } from './tag-events.js';
import { DEBUG } from './config.js';
import { DATASTORE_VERSION, PROTOCOL_VERSION } from '../version.js';
import {
  getActiveProfile,
  getSyncConfig as getProfileSyncConfig,
  updateLastSyncTime,
  enableSync,
} from './profiles.js';

// ==================== Settings Storage ====================

// Note: Sync configuration is now stored per-profile in profiles.db
// Legacy feature_settings storage is deprecated

/**
 * Get sync configuration for the active profile
 */
export function getSyncConfig(): SyncConfig {
  try {
    const activeProfile = getActiveProfile();
    const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

    if (!profileSyncConfig) {
      // Sync not configured for this profile
      return {
        serverUrl: getServerUrl(),
        apiKey: '',
        lastSyncTime: 0,
        autoSync: getAutoSync(),
      };
    }

    // Construct full sync config from profile data
    return {
      serverUrl: getServerUrl(),
      apiKey: profileSyncConfig.apiKey,
      lastSyncTime: activeProfile.lastSyncAt || 0,
      autoSync: getAutoSync(),
    };
  } catch (error) {
    DEBUG && console.error('[sync] Failed to get sync config:', error);
    return {
      serverUrl: getServerUrl(),
      apiKey: '',
      lastSyncTime: 0,
      autoSync: false,
    };
  }
}

/**
 * Item types the desktop syncs by default: the full set the server stores. Desktop
 * is the source of derived items (entity/series/feed), and the intent is that all of
 * a user's data lives on the server — so unlike mobile (which defaults to only
 * url/text/tagset/image), desktop defaults to syncing everything the server accepts.
 * Kept in sync with the server's SYNCABLE_ITEM_TYPES (apps/server/index.js); 'event'
 * is intentionally excluded because the server does not store it.
 */
const DEFAULT_SYNCED_TYPES = ['url', 'text', 'tagset', 'image', 'series', 'feed', 'entity'];

/**
 * The item types this install should sync. Overridable via the `syncedTypes`
 * feature setting (a JSON array) — the client-side "choose what to sync" control —
 * else DEFAULT_SYNCED_TYPES. An empty/invalid override falls back to the default
 * rather than disabling sync entirely.
 */
function getSyncedTypes(): string[] {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'syncedTypes'
    `).get() as { value: string } | undefined;
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((t) => String(t));
      }
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_SYNCED_TYPES;
}

/**
 * Get server URL from settings or environment
 * Priority: 1. User-configured (feature_settings), 2. Env var, 3. Default
 */
function getServerUrl(): string {
  const db = getDb();

  try {
    // Try to get from feature_settings
    const row = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'serverUrl'
    `).get() as { value: string } | undefined;

    if (row && row.value) {
      // Values in feature_settings are JSON-stringified
      try {
        return JSON.parse(row.value);
      } catch {
        // If parse fails, return as-is (shouldn't happen)
        return row.value;
      }
    }
  } catch (error) {
    // If query fails, fall through to defaults
  }

  // Fall back to env var (empty string means sync disabled)
  return process.env.SYNC_SERVER_URL || '';
}

/**
 * Save server URL to settings
 */
function setServerUrl(url: string): void {
  const db = getDb();

  // Values in feature_settings must be JSON-stringified
  const jsonValue = JSON.stringify(url);

  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'serverUrl', ?, ?)
  `).run(`sync-serverUrl`, jsonValue, Date.now());
}

/**
 * Get autoSync setting from feature_settings
 */
function getAutoSync(): boolean {
  const db = getDb();

  try {
    const row = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'autoSync'
    `).get() as { value: string } | undefined;

    if (row && row.value) {
      try {
        return JSON.parse(row.value) === true;
      } catch {
        return false;
      }
    }
  } catch (error) {
    // If query fails, return default
  }

  return false;
}

/**
 * Save autoSync setting
 */
function setAutoSync(enabled: boolean): void {
  const db = getDb();

  const jsonValue = JSON.stringify(enabled);

  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'autoSync', ?, ?)
  `).run(`sync-autoSync`, jsonValue, Date.now());
}

/**
 * Save sync configuration to active profile
 * Note: This is a compatibility wrapper for the Sync UI.
 * Saves serverUrl (global), apiKey, and serverProfileId (per-profile).
 */
export function setSyncConfig(config: Partial<SyncConfig>): void {
  try {
    const activeProfile = getActiveProfile();

    // Update serverUrl if provided (stored globally in feature_settings)
    if (config.serverUrl !== undefined && config.serverUrl !== '') {
      setServerUrl(config.serverUrl);
      DEBUG && console.log(`[sync] Updated server URL: ${config.serverUrl}`);
    }

    // Update apiKey if provided
    // For now, assume serverProfileId is "default" when set from Sync UI
    // (Users can customize via Profiles UI for advanced per-profile mapping)
    if (config.apiKey !== undefined && config.apiKey !== '') {
      const currentConfig = getProfileSyncConfig(activeProfile.id);
      const serverProfileId = currentConfig?.serverProfileId || 'default';

      // Enable sync with the provided apiKey
      enableSync(activeProfile.id, config.apiKey, serverProfileId);
      DEBUG && console.log(`[sync] Updated sync config for profile ${activeProfile.folder}`);
    }

    // Update lastSyncTime if provided
    if (config.lastSyncTime !== undefined) {
      updateLastSyncTime(activeProfile.id, config.lastSyncTime);
    }

    // Update autoSync if provided
    if (config.autoSync !== undefined) {
      setAutoSync(config.autoSync);
      DEBUG && console.log(`[sync] Updated autoSync: ${config.autoSync}`);
    }
  } catch (error) {
    DEBUG && console.error('[sync] Failed to set sync config:', error);
  }
}

// ==================== Timestamp Conversion ====================

/**
 * Convert Unix milliseconds (desktop) to ISO string (server)
 */
function toISOString(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

/**
 * Convert ISO string or integer timestamp (server) to Unix milliseconds (desktop)
 */
function fromISOString(value: string | number): number {
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

// ==================== Server API Helpers ====================

interface FetchOptions {
  method?: string;
  body?: unknown;
}

/**
 * Make an authenticated request to the sync server.
 * Sends version headers and checks server's response version headers.
 */
async function serverFetch<T>(
  serverUrl: string,
  apiKey: string,
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Peek-Datastore-Version': String(DATASTORE_VERSION),
      'X-Peek-Protocol-Version': String(PROTOCOL_VERSION),
      'X-Peek-Client': 'desktop',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Server error ${response.status}: ${error}`);
  }

  // Check server version headers (if present)
  // If server returns no version headers (rollback/legacy), skip check
  const serverDS = response.headers.get('X-Peek-Datastore-Version');
  const serverProto = response.headers.get('X-Peek-Protocol-Version');

  if (serverDS) {
    const serverDSNum = parseInt(serverDS, 10);
    if (serverDSNum !== DATASTORE_VERSION) {
      throw new Error(
        `Datastore version mismatch: server=${serverDSNum}, client=${DATASTORE_VERSION}. Please update your app.`
      );
    }
  }

  if (serverProto) {
    const serverProtoNum = parseInt(serverProto, 10);
    if (serverProtoNum !== PROTOCOL_VERSION) {
      throw new Error(
        `Protocol version mismatch: server=${serverProtoNum}, client=${PROTOCOL_VERSION}. Please update your app.`
      );
    }
  }

  return response.json() as Promise<T>;
}

// ==================== Pull (Server → Desktop) ====================

interface PullResult {
  pulled: number;
  conflicts: number;
}

/**
 * Pull items from server and merge into local database
 *
 * For each server item:
 * - If not found locally (by syncId): insert with syncId=server.id, syncedAt=server.updatedAt
 * - If found and server newer: update local
 * - If found and local newer: skip (will be pushed later)
 */
export async function pullFromServer(
  serverUrl: string,
  apiKey: string,
  since?: number
): Promise<PullResult> {
  if (!serverUrl) {
    DEBUG && console.log('[sync] No server URL configured, sync disabled');
    return { pulled: 0, conflicts: 0 };
  }

  DEBUG && console.log('[sync] Pulling from server...', since ? `since ${toISOString(since)}` : 'full');

  // Get active profile to determine which server profile to sync with
  const activeProfile = getActiveProfile();
  const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

  if (!profileSyncConfig) {
    throw new Error('Sync not configured for active profile');
  }

  // Fetch items from server with profile parameter
  // Use server profile ID (UUID) - the identifier the server uses for this profile
  let path = '/items';
  if (since && since > 0) {
    path = `/items/since/${toISOString(since)}`;
  }
  path += `?profile=${encodeURIComponent(profileSyncConfig.serverProfileId || activeProfile.id)}`;
  // Always include deleted items so tombstones propagate during sync
  path += '&includeDeleted=true';

  DEBUG && console.log(`[sync] Fetching from: ${serverUrl}${path}`);

  const response = await serverFetch<{ items: ServerItem[] }>(serverUrl, apiKey, path);
  const serverItems = response.items;

  DEBUG && console.log(`[sync] Received ${serverItems.length} items from server`);

  let pulled = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const serverItem of serverItems) {
    const result = mergeServerItem(serverItem);
    if (result === 'pulled') pulled++;
    if (result === 'conflict') conflicts++;
    if (result === 'skipped') skipped++;
  }

  DEBUG && console.log(`[sync] Pull complete: ${pulled} pulled, ${conflicts} conflicts, ${skipped} skipped`);

  // Save server config so resetSyncStateIfServerChanged() knows we've synced with this server
  saveSyncServerConfig(serverUrl);

  return { pulled, conflicts };
}

/**
 * Merge a single server item into the local database
 */
function mergeServerItem(serverItem: ServerItem): 'pulled' | 'conflict' | 'skipped' {
  const db = getDb();

  // Find local item by syncId matching server id (include deleted items)
  const localItem = db.prepare(
    'SELECT * FROM items WHERE syncId = ?'
  ).get(serverItem.id) as Item | undefined;

  const serverUpdatedAt = serverItem.updatedAt;
  const serverDeletedAt = typeof serverItem.deletedAt === 'number' ? serverItem.deletedAt : 0;

  if (serverDeletedAt > 0) {
    // Server says item is deleted
    if (!localItem) return 'skipped'; // No local copy, skip
    if (localItem.deletedAt > 0) {
      // Both deleted — just update syncedAt
      db.prepare('UPDATE items SET syncedAt = ? WHERE id = ?').run(Date.now(), localItem.id);
      return 'pulled';
    }
    // Local is alive, server is deleted — soft-delete locally
    db.prepare('UPDATE items SET deletedAt = ?, updatedAt = ?, syncedAt = ? WHERE id = ?')
      .run(serverDeletedAt, serverDeletedAt, Date.now(), localItem.id);
    return 'pulled';
  }

  if (!localItem) {
    // Item doesn't exist locally - insert it
    DEBUG && console.log(`[sync] Inserting new item from server: ${serverItem.id}`);

    const localId = generateId('item');
    const now = Date.now();
    const metadataJson = serverItem.metadata ? JSON.stringify(serverItem.metadata) : '{}';

    db.prepare(`
      INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt, deletedAt, syncedAt, starred, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      localId,
      serverItem.type,
      serverItem.content || null,
      'text/html', // default mimeType for synced items
      metadataJson,
      serverItem.id,
      serverItem.createdAt,
      serverUpdatedAt,
      now,
      serverItem.starred,
      serverItem.archived
    );

    // Add tags
    syncTagsToItem(localId, serverItem.tags);

    return 'pulled';
  }

  // Handle undelete: local is deleted but server item is active
  if (localItem.deletedAt > 0) {
    if (serverUpdatedAt > localItem.updatedAt) {
      // Server is newer — undelete locally and update content
      DEBUG && console.log(`[sync] Undeleting local item from server: ${serverItem.id}`);
      const now = Date.now();
      const metadataJson = serverItem.metadata ? JSON.stringify(serverItem.metadata) : '{}';
      db.prepare(`
        UPDATE items
        SET content = ?, metadata = ?, deletedAt = 0, updatedAt = ?, syncedAt = ?
        WHERE id = ?
      `).run(serverItem.content || null, metadataJson, serverUpdatedAt, now, localItem.id);
      syncTagsToItem(localItem.id, serverItem.tags);
      return 'pulled';
    }
    // Local delete is newer — conflict, local wins
    DEBUG && console.log(`[sync] Conflict: local delete is newer for ${serverItem.id}, keeping local`);
    return 'conflict';
  }

  // Item exists - check timestamps for conflict resolution
  if (serverUpdatedAt > localItem.updatedAt) {
    // Server is newer - update local
    DEBUG && console.log(`[sync] Updating local item from server: ${serverItem.id}`);

    const now = Date.now();
    const metadataJson = serverItem.metadata ? JSON.stringify(serverItem.metadata) : '{}';
    db.prepare(`
      UPDATE items
      SET content = ?, metadata = ?, updatedAt = ?, syncedAt = ?, starred = ?, archived = ?
      WHERE id = ?
    `).run(serverItem.content || null, metadataJson, serverUpdatedAt, now, serverItem.starred, serverItem.archived, localItem.id);

    // Update tags
    syncTagsToItem(localItem.id, serverItem.tags);

    return 'pulled';
  }

  if (localItem.updatedAt > serverUpdatedAt) {
    // Local is newer - this is a conflict, local wins
    DEBUG && console.log(`[sync] Conflict: local is newer for ${serverItem.id}, keeping local`);
    return 'conflict';
  }

  // Same timestamp - skip
  DEBUG && console.log(`[sync] Skipping item (same timestamp): ${serverItem.id}`);
  return 'skipped';
}

/**
 * Sync tags from server to a local item.
 *
 * This wipes and re-applies tags for the item — bulk enough that we don't
 * bother emitting `tag:item-removed` per removed link (that would be noisy
 * and UIs already refresh on `sync:pull-completed`). We DO publish
 * `tag:item-added` via `tagItemAndPublish` for each new link so reactive
 * UIs (groups, page tags widget) pick up server-originated tags without
 * waiting for a full refresh.
 */
function syncTagsToItem(itemId: string, tagNames: string[]): void {
  const db = getDb();

  // Remove existing tags for this item
  db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(itemId);

  // Add new tags — publish per-add so UIs update reactively
  for (const tagName of tagNames) {
    const { tag } = getOrCreateTag(tagName);
    tagItemAndPublish(itemId, tag.id);
  }
}

// ==================== Push (Desktop → Server) ====================

interface PushResult {
  pushed: number;
  failed: number;
}

/**
 * Push unsynced local items to server
 *
 * Query items where:
 * - syncedAt = 0 (never synced), OR
 * - updatedAt > lastSyncTime (modified since last sync)
 */
export async function pushToServer(
  serverUrl: string,
  apiKey: string,
  lastSyncTime: number
): Promise<PushResult> {
  if (!serverUrl) {
    DEBUG && console.log('[sync] No server URL configured, sync disabled');
    return { pushed: 0, failed: 0 };
  }

  DEBUG && console.log('[sync] Pushing to server...', lastSyncTime > 0 ? `since ${toISOString(lastSyncTime)}` : 'all unsynced');

  const db = getDb();

  // Find items to push
  // Push items that:
  // 1. Have never been synced (syncedAt = 0), OR
  // 2. Have been locally modified after their last sync (updatedAt > syncedAt)
  // This prevents re-pushing items that were just pulled from the server
  let items: Item[];
  if (lastSyncTime > 0) {
    // Incremental: items modified locally after their last sync, or never synced
    // Also include deleted tombstones that need to be pushed
    items = db.prepare(`
      SELECT * FROM items
      WHERE (deletedAt = 0 AND (syncedAt = 0 OR (syncedAt > 0 AND updatedAt > syncedAt)))
         OR (deletedAt > 0 AND syncId != '' AND syncedAt > 0 AND updatedAt > syncedAt)
    `).all() as Item[];
  } else {
    // Full: all items that haven't been synced
    items = db.prepare(`
      SELECT * FROM items
      WHERE deletedAt = 0 AND syncedAt = 0
    `).all() as Item[];
  }

  // Filter out peek:// URLs - they should never be synced to the server
  items = items.filter(item => !item.content?.startsWith('peek://'));

  // Only push types this install is configured to sync. Locally-derived types the
  // user has opted out of (or that the server rejects) must never be pushed — that
  // was the 5000+-pending bug (e9dce12a): unsyncable entity rows re-pushed every sync.
  const syncedTypes = getSyncedTypes();
  items = items.filter(item => syncedTypes.includes(item.type));

  DEBUG && console.log(`[sync] Found ${items.length} items to push`);

  let pushed = 0;
  let failed = 0;

  for (const item of items) {
    try {
      await pushSingleItem(serverUrl, apiKey, item);
      pushed++;
    } catch (error) {
      DEBUG && console.log(`[sync] Failed to push item ${item.id}:`, (error as Error).message);
      failed++;
    }
  }

  DEBUG && console.log(`[sync] Push complete: ${pushed} pushed, ${failed} failed`);

  return { pushed, failed };
}

/**
 * Push a single item to the server
 */
async function pushSingleItem(
  serverUrl: string,
  apiKey: string,
  item: Item
): Promise<void> {
  const db = getDb();

  // Get active profile to determine which server profile to sync with
  const activeProfile = getActiveProfile();
  const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

  if (!profileSyncConfig) {
    throw new Error('Sync not configured for active profile');
  }

  // Get tags for this item
  const tags = getItemTags(item.id);
  const tagNames = tags.map((t: Tag) => t.name);

  // Parse metadata
  let metadata: Record<string, unknown> | null = null;
  if (item.metadata && item.metadata !== '{}') {
    try {
      metadata = JSON.parse(item.metadata);
    } catch {
      // Invalid JSON, skip metadata
    }
  }

  // Build request body
  const body: {
    type: string;
    content?: string | null;
    tags: string[];
    metadata?: Record<string, unknown>;
    sync_id?: string;
    deletedAt?: number;
    starred: number;
    archived: number;
  } = {
    type: item.type,
    content: item.content,
    tags: tagNames,
    sync_id: item.syncId || item.id,  // Use existing syncId or local id
    starred: item.starred,
    archived: item.archived,
  };

  if (metadata) {
    body.metadata = metadata;
  }

  if (item.deletedAt > 0) {
    body.deletedAt = item.deletedAt;
  }

  // POST to server with profile parameter
  // Use server profile ID (UUID) - the identifier the server uses for this profile
  const path = `/items?profile=${encodeURIComponent(profileSyncConfig.serverProfileId || activeProfile.id)}`;
  const response = await serverFetch<{ id: string; created: boolean }>(
    serverUrl,
    apiKey,
    path,
    { method: 'POST', body }
  );

  // Update local item with sync info and set syncedAt to track when we synced
  const now = Date.now();
  db.prepare(`
    UPDATE items SET syncId = ?, syncedAt = ? WHERE id = ?
  `).run(response.id, now, item.id);

  DEBUG && console.log(`[sync] Pushed item ${item.id} → ${response.id}`);
}

// ==================== Server Change Detection ====================

/**
 * Detect if the sync server config has changed and reset per-item sync markers if so.
 * This ensures all items are pushed when a user changes servers or configures sync for the first time.
 */
function resetSyncStateIfServerChanged(serverUrl: string): boolean {
  const db = getDb();
  const activeProfile = getActiveProfile();
  const profileConfig = getProfileSyncConfig(activeProfile.id);
  const currentProfileId = profileConfig?.serverProfileId || '';

  let storedUrl = '';
  let storedProfileId = '';
  try {
    const urlRow = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'lastSyncServerUrl'
    `).get() as { value: string } | undefined;
    if (urlRow?.value) storedUrl = JSON.parse(urlRow.value);
  } catch { /* first sync */ }

  try {
    const pidRow = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'lastSyncProfileId'
    `).get() as { value: string } | undefined;
    if (pidRow?.value) storedProfileId = JSON.parse(pidRow.value);
  } catch { /* first sync */ }

  // First sync — no stored config means we haven't tracked the server yet.
  // Don't reset items that may have been pulled in a prior sync.
  if (!storedUrl && !storedProfileId) {
    return false;
  }

  const urlChanged = storedUrl && storedUrl !== serverUrl;
  const profileChanged = storedProfileId && storedProfileId !== currentProfileId;

  if (urlChanged || profileChanged) {
    DEBUG && console.log(`[sync] Server changed (url: '${storedUrl}' -> '${serverUrl}', profile: '${storedProfileId}' -> '${currentProfileId}') — resetting per-item sync state`);
    db.prepare(`
      UPDATE items SET syncedAt = 0, syncId = '' WHERE deletedAt = 0
    `).run();
    updateLastSyncTime(activeProfile.id, 0);
    return true;
  }

  return false;
}

/**
 * Save current server config so we can detect changes on next sync
 */
function saveSyncServerConfig(serverUrl: string): void {
  const db = getDb();
  const activeProfile = getActiveProfile();
  const profileConfig = getProfileSyncConfig(activeProfile.id);
  const currentProfileId = profileConfig?.serverProfileId || '';

  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'lastSyncServerUrl', ?, ?)
  `).run('sync-lastSyncServerUrl', JSON.stringify(serverUrl), Date.now());

  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'lastSyncProfileId', ?, ?)
  `).run('sync-lastSyncProfileId', JSON.stringify(currentProfileId), Date.now());
}

// ==================== Full Bidirectional Sync ====================

// Module-level error state — surfaced in getSyncStatus so the settings
// UI (and any other consumer) can show a red indicator on failure
// without each caller having to wrap syncAll in try/catch + post the
// error to a separate channel. Set on the throw path in syncAll, cleared
// on the next successful run.
let lastSyncError: string | null = null;
let lastSyncErrorAt = 0;

/**
 * Perform a full bidirectional sync
 *
 * 1. Pull from server (including updates since last sync)
 * 2. Push local changes to server
 * 3. Update lastSyncTime in profile
 */
export async function syncAll(serverUrl: string, apiKey: string): Promise<SyncResult> {
  if (!serverUrl) {
    DEBUG && console.log('[sync] No server URL configured, sync disabled');
    return { pulled: 0, pushed: 0, conflicts: 0, lastSyncTime: 0 };
  }

  // Check if server config changed — reset per-item sync markers if so
  const wasReset = resetSyncStateIfServerChanged(serverUrl);
  if (wasReset) {
    DEBUG && console.log('[sync] Sync state reset due to server config change — all items will be synced');
  }

  const config = getSyncConfig();

  DEBUG && console.log('[sync] Starting full sync...');

  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  try {
    // Pull first (to get any server changes)
    const pullResult = await pullFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled = pullResult.pulled;
    conflicts = pullResult.conflicts;

    // Then push local changes
    const pushResult = await pushToServer(serverUrl, apiKey, config.lastSyncTime);
    pushed = pushResult.pushed;

    // Update last sync time AFTER push completes — using Date.now() ensures
    // the high-water mark is after any server-side timestamps set during push,
    // preventing the next pull from echoing back items we just pushed.
    const syncTime = Date.now();
    const activeProfile = getActiveProfile();
    updateLastSyncTime(activeProfile.id, syncTime);
    saveSyncServerConfig(serverUrl);

    DEBUG && console.log(`[sync] Sync complete: ${pulled} pulled, ${pushed} pushed, ${conflicts} conflicts`);

    // Clear any stale error from a previous failed run.
    lastSyncError = null;
    lastSyncErrorAt = 0;

    return {
      pulled,
      pushed,
      conflicts,
      lastSyncTime: syncTime,
    };
  } catch (error) {
    DEBUG && console.error('[sync] Sync failed:', error);
    lastSyncError = error instanceof Error ? error.message : String(error);
    lastSyncErrorAt = Date.now();
    throw error;
  }
}

// ==================== Status ====================

/**
 * Get current sync status
 */
export function getSyncStatus(): {
  configured: boolean;
  lastSyncTime: number;
  pendingCount: number;
  lastError: string | null;
  lastErrorAt: number;
} {
  const config = getSyncConfig();
  const db = getDb();

  // Count items that need to be synced. Must match the PUSHABLE set exactly, or the
  // badge never reaches 0: same pending logic as push, restricted to the configured
  // synced types, and excluding peek:// URLs (which push also skips). Before the type
  // filter, thousands of unsyncable entity rows kept this count permanently stuck
  // (e9dce12a).
  const syncedTypes = getSyncedTypes();
  const typePlaceholders = syncedTypes.map(() => '?').join(', ');
  const pendingCount = (db.prepare(`
    SELECT COUNT(*) as count FROM items
    WHERE type IN (${typePlaceholders})
      AND (content IS NULL OR content NOT LIKE 'peek://%')
      AND ((deletedAt = 0 AND (syncedAt = 0 OR (syncedAt > 0 AND updatedAt > syncedAt)))
        OR (deletedAt > 0 AND syncId != '' AND syncedAt > 0 AND updatedAt > syncedAt))
  `).get(...syncedTypes) as { count: number }).count;

  return {
    configured: !!(config.serverUrl && config.apiKey),
    lastSyncTime: config.lastSyncTime,
    pendingCount,
    lastError: lastSyncError,
    lastErrorAt: lastSyncErrorAt,
  };
}
