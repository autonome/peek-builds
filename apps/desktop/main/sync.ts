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
  ServerEvent,
  ServerTag,
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
      INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt, deletedAt, syncedAt, starred, archived, title, domain, favicon, visitCount, lastVisitAt, frecencyScore)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      localId,
      serverItem.type,
      serverItem.content || null,
      serverItem.mimeType || '',
      metadataJson,
      serverItem.id,
      serverItem.createdAt,
      serverUpdatedAt,
      now,
      serverItem.starred,
      serverItem.archived,
      serverItem.title || '',
      serverItem.domain || '',
      serverItem.favicon || '',
      serverItem.visitCount || 0,
      serverItem.lastVisitAt || 0,
      serverItem.frecencyScore || 0
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
      SET content = ?, metadata = ?, updatedAt = ?, syncedAt = ?, starred = ?, archived = ?,
        title = ?, domain = ?, favicon = ?, visitCount = ?, lastVisitAt = ?, frecencyScore = ?, mimeType = ?
      WHERE id = ?
    `).run(
      serverItem.content || null, metadataJson, serverUpdatedAt, now, serverItem.starred, serverItem.archived,
      serverItem.title || '', serverItem.domain || '', serverItem.favicon || '',
      serverItem.visitCount || 0, serverItem.lastVisitAt || 0, serverItem.frecencyScore || 0,
      serverItem.mimeType || '', localItem.id
    );

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
    title: string;
    domain: string;
    favicon: string;
    visitCount: number;
    lastVisitAt: number;
    frecencyScore: number;
    mimeType: string;
    createdAt: number;
  } = {
    type: item.type,
    content: item.content,
    tags: tagNames,
    sync_id: item.syncId || item.id,  // Use existing syncId or local id
    starred: item.starred,
    archived: item.archived,
    title: item.title,
    domain: item.domain,
    favicon: item.favicon,
    visitCount: item.visitCount,
    lastVisitAt: item.lastVisitAt,
    frecencyScore: item.frecencyScore,
    mimeType: item.mimeType,
    // Honored by the server on INSERT only — preserves the item's original creation
    // date. updatedAt stays server-stamped (see mergeServerItem() conflict resolution).
    createdAt: item.createdAt,
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

// ==================== Event Sync (item_events: series/feed observations) ====================
//
// item_events are append-only immutable facts, unlike items — there is no
// content to merge and no last-write-wins conflict to resolve, so there is no
// per-row syncedAt/syncId column here. There is still no per-row column: push
// tracks its OWN watermark (feature_settings key 'lastEventPushAt', alongside
// the existing 'lastSyncServerUrl' / 'lastSyncProfileId' / 'lastSyncDatastoreVersion'
// keys), separate from the profile's shared item watermark (`lastSyncAt`) —
// see getEventPushWatermark()/saveEventPushWatermark() below for why sharing
// it is unsafe. packages/schema/v1.json's required_sync_columns for
// item_events omits both syncId and syncedAt, so this still adds no datastore
// schema column, and no bump across the backends the fidelity test gates.
//
// Identity is the event's own id, shared verbatim with the server (no syncId
// indirection): a push is idempotent purely because the server INSERT OR
// IGNOREs on that primary key (db.js saveEvents()), and a pull's merge is the
// same insert-if-absent on the local table (mergeServerEvent() below) — so a
// sync run can never duplicate an event, and merging a batch does not depend
// on what order it arrives in.
//
// `itemId` on the wire is always the SERVER's item id, translated from/to the
// local item id via that item's `syncId` column — which is why event push/pull
// run AFTER item push/pull in syncAll(): an item needs its syncId set (whether
// from this run's own push, or an earlier pull) before its events can be
// addressed.
//
// Deletion is NOT synced: a locally hard-deleted event
// (tile:datastore:delete-item-event) will reappear on the next pull if the
// server still has it. Adding a tombstone column was rejected as premature —
// item_events has no deletedAt in packages/schema/v1.json and none of the
// required_sync_columns backends carry one; this is a named, accepted gap for
// this phase, not an oversight.

// Cap per push request well under the server's own MAX_EVENTS_PER_PUSH so a
// large batch chunks into multiple requests instead of one oversized body.
const MAX_EVENTS_PER_PUSH = 500;

interface EventPushResult {
  pushed: number;
}

interface EventPullResult {
  pulled: number;
}

/**
 * Read the event-push watermark: events with createdAt at or below this value
 * are either already durably pushed, or were deliberately left out of the
 * "already pushed" bucket because their parent item still has no syncId (see
 * saveEventPushWatermark() for why that second case matters). Tracked
 * separately from the profile's `lastSyncAt` (the shared item watermark) in
 * `feature_settings`, alongside 'lastSyncServerUrl' / 'lastSyncProfileId' /
 * 'lastSyncDatastoreVersion'.
 *
 * It CANNOT share `lastSyncAt`: that watermark advances to `Date.now()` at
 * the end of every syncAll() run that doesn't throw — including a run where
 * one item's push failed but pushToServer()'s own per-item try/catch let the
 * run finish anyway (this is normal, expected behavior for items, which track
 * their own per-row `syncedAt` and so don't care that the shared watermark
 * moved on). Events have no such per-row marker; if push read the shared
 * watermark, the failed item's events would be excluded from that run (its
 * syncId is still empty) and then, on every later run, ALSO excluded by a
 * watermark now sitting past their createdAt — stranding them permanently the
 * moment the item's own push finally does succeed.
 */
function getEventPushWatermark(): number {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'lastEventPushAt'
    `).get() as { value: string } | undefined;
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // fall through to default
  }
  return 0;
}

/**
 * Persist the event-push watermark. See getEventPushWatermark() for what it
 * means; pushEventsToServer() is the only caller, and computes it so it never
 * advances past an event that was not actually delivered this run.
 */
function saveEventPushWatermark(timestamp: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'lastEventPushAt', ?, ?)
  `).run('sync-lastEventPushAt', JSON.stringify(timestamp), Date.now());
}

/**
 * Push local item_events whose parent item has already been synced (has a
 * non-empty syncId — see module comment above) and that haven't been pushed
 * yet, per the dedicated event-push watermark (getEventPushWatermark()).
 *
 * Events whose parent item isn't synced yet are excluded from THIS run's
 * batch, but — unlike a naive shared-watermark design — the watermark this
 * function saves afterward never advances past the oldest of them, so they
 * remain eligible on every future run until their item's own push finally
 * succeeds (see getEventPushWatermark()'s doc comment for the failure mode
 * this avoids). Re-pushing an already-delivered event is a no-op (the server
 * INSERT OR IGNOREs on id), so erring toward sending more than strictly
 * necessary is always safe here; erring toward sending less is not.
 */
export async function pushEventsToServer(
  serverUrl: string,
  apiKey: string
): Promise<EventPushResult> {
  const db = getDb();
  const activeProfile = getActiveProfile();
  const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

  if (!profileSyncConfig) {
    throw new Error('Sync not configured for active profile');
  }

  const watermark = getEventPushWatermark();

  // Captured BEFORE the SELECT below runs, not after the push completes: an
  // event created during this function's own network round-trip (after the
  // SELECT already ran, so it can't be in this run's batch) must still stay
  // eligible for the NEXT run rather than being skipped by a watermark that
  // advanced past it despite it never actually being sent.
  const captureTime = Date.now();

  const rows = db.prepare(`
    SELECT e.id as id, e.content as content, e.value as value, e.occurredAt as occurredAt,
      e.metadata as metadata, e.createdAt as createdAt, i.syncId as itemSyncId
    FROM item_events e
    JOIN items i ON e.itemId = i.id
    WHERE i.syncId != '' AND e.createdAt > ?
    ORDER BY e.createdAt ASC
  `).all(watermark) as Array<{
    id: string;
    content: string | null;
    value: number | null;
    occurredAt: number;
    metadata: string;
    createdAt: number;
    itemSyncId: string;
  }>;

  DEBUG && console.log(`[sync] Found ${rows.length} events to push`);

  let pushed = 0;
  for (let i = 0; i < rows.length; i += MAX_EVENTS_PER_PUSH) {
    const batch = rows.slice(i, i + MAX_EVENTS_PER_PUSH);
    const events = batch.map((row) => {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata && row.metadata !== '{}') {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          // Invalid JSON, omit metadata
        }
      }
      return {
        id: row.id,
        itemId: row.itemSyncId,
        content: row.content,
        value: row.value,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
        ...(metadata ? { metadata } : {}),
      };
    });

    const path = `/events?profile=${encodeURIComponent(profileSyncConfig.serverProfileId || activeProfile.id)}`;
    const response = await serverFetch<{ received: number; saved: number }>(
      serverUrl,
      apiKey,
      path,
      { method: 'POST', body: { events } }
    );
    pushed += response.saved;
  }

  // Events whose parent item still has no syncId were excluded from the
  // query above and were NOT pushed — no time bound here, deliberately: this
  // must catch events blocked from an earlier run too (e.g. right after a
  // server/datastore-version reset clears every item's syncId at once), not
  // just ones newer than the watermark this run started with. The watermark
  // must never advance past the oldest of them.
  const blocked = db.prepare(`
    SELECT MIN(e.createdAt) as minCreatedAt
    FROM item_events e
    JOIN items i ON e.itemId = i.id
    WHERE i.syncId = ''
  `).get() as { minCreatedAt: number | null };

  // `- 1`: the query above (and next run's) is a strict `createdAt > watermark`,
  // so the watermark itself must sit BEFORE captureTime, not AT it — otherwise
  // an event whose createdAt lands on the exact same millisecond as
  // captureTime (very possible: captureTime is read microseconds before this
  // point, well under the 1ms Date.now() resolution) would fail the next
  // run's `>` check despite never having been sent, the same stranding this
  // watermark exists to prevent. Symmetric with the blocked-event term below.
  let newWatermark = captureTime - 1;
  if (blocked.minCreatedAt !== null && blocked.minCreatedAt !== undefined) {
    newWatermark = Math.min(newWatermark, blocked.minCreatedAt - 1);
  }
  saveEventPushWatermark(newWatermark);

  DEBUG && console.log(`[sync] Event push complete: ${pushed} saved, watermark -> ${newWatermark}`);

  return { pushed };
}

/**
 * Pull events the server has recorded since `since`, merging each into the
 * local item_events table. See module comment: merge is a pure
 * insert-if-absent keyed on the event's own id, so it is safe regardless of
 * arrival order.
 */
export async function pullEventsFromServer(
  serverUrl: string,
  apiKey: string,
  since?: number
): Promise<EventPullResult> {
  const activeProfile = getActiveProfile();
  const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

  if (!profileSyncConfig) {
    throw new Error('Sync not configured for active profile');
  }

  const timestamp = since && since > 0 ? since : 0;
  let path = `/events/since/${timestamp}`;
  path += `?profile=${encodeURIComponent(profileSyncConfig.serverProfileId || activeProfile.id)}`;

  const response = await serverFetch<{ events: ServerEvent[] }>(serverUrl, apiKey, path);
  const serverEvents = response.events;

  DEBUG && console.log(`[sync] Received ${serverEvents.length} events from server`);

  let pulled = 0;
  for (const serverEvent of serverEvents) {
    if (mergeServerEvent(serverEvent)) pulled++;
  }

  DEBUG && console.log(`[sync] Event pull complete: ${pulled} pulled`);

  return { pulled };
}

/**
 * Merge one server event into the local item_events table. Returns true if a
 * new row was inserted, false if it was already present locally or its
 * parent item hasn't been synced locally yet (that event will merge on a
 * later run once the parent item exists locally with a matching syncId).
 */
function mergeServerEvent(serverEvent: ServerEvent): boolean {
  const db = getDb();

  const localItem = db.prepare('SELECT id FROM items WHERE syncId = ?').get(serverEvent.itemId) as
    | { id: string }
    | undefined;
  if (!localItem) {
    DEBUG && console.log(`[sync] Skipping event ${serverEvent.id}: parent item ${serverEvent.itemId} not found locally`);
    return false;
  }

  const metadataJson = serverEvent.metadata ? JSON.stringify(serverEvent.metadata) : '{}';
  const result = db.prepare(`
    INSERT OR IGNORE INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverEvent.id,
    localItem.id,
    serverEvent.content,
    serverEvent.value,
    serverEvent.occurredAt,
    metadataJson,
    serverEvent.createdAt
  );

  return result.changes > 0;
}

// ==================== Tag Sync (tag metadata: slug/color/parentId/description/metadata) ====================
//
// Tag ROWS themselves are not what this section syncs — a tag row is created
// implicitly by pushSingleItem()'s `tags` array, the same way it always has been
// (the server upserts one by name in getOrCreateTagWithConn()). What never made
// it across before is the metadata on that row: slug, color, parentId,
// description, metadata. Those are still no per-row syncedAt/syncId column on the
// local `tags` table (packages/schema/v1.json's required_sync_columns for tags
// does list them now, but as sync:true columns already present on the table, not
// a new one) — push tracks its OWN watermark, the same pattern item_events uses
// and for the same reason (see getEventPushWatermark()'s doc comment above): the
// shared `lastSyncAt` watermark advances even when one item's push failed
// (pushToServer()'s own per-item try/catch lets the run finish anyway), and tags
// have no per-row marker to fall back on the way items do with their own
// `syncedAt`. A dedicated 'lastTagPushAt' feature-settings key avoids the same
// stranding failure mode events would have hit.
//
// Identity on the wire is the tag's own `name`, not a syncId — introducing a
// second identity would give the same server row two sources of truth that must
// reconcile, and the server already treats name as canonical for tag rows
// derived from item pushes. Consequence accepted, not fixed: renaming a tag on
// one device creates a second tag rather than renaming the first (see
// docs/sync-coverage-gaps.md §3).
//
// The local `parentId` column (a local tag id) never travels as an id — on the
// wire it travels under the same field name, `parentId`, but holding the
// parent tag's NAME instead, since name is the identity (don't mistake the
// wire field for a foreign key). A pull resolves the wire `parentId` back to
// a local tag id in a SECOND pass over the pulled batch (resolveTagParent()),
// after every tag in the batch has already been upserted in the first pass
// (mergeServerTag()) — so a parent arriving after its child in the same pull
// still ends up linked; a single-pass merge would depend on arrival order.
//
// Unlike item_events, there is no "parent not synced yet" blocking condition to
// track here: a tag isn't gated on any other entity's sync state the way an
// event is gated on its parent item's syncId, so pushTagsToServer()'s watermark
// logic is the simpler half of the event pattern — no separate "blocked" scan.

// Cap per push request well under the server's own MAX_TAGS_PER_PUSH so a large
// tag set chunks into multiple requests instead of one oversized body.
const MAX_TAGS_PER_PUSH = 500;

interface TagPushResult {
  pushed: number;
}

interface TagPullResult {
  pulled: number;
}

/**
 * Read the tag-push watermark: tags with updatedAt at or below this value are
 * already durably pushed. Tracked separately from the profile's `lastSyncAt`
 * (the shared item watermark) in `feature_settings`, alongside
 * 'lastEventPushAt' / 'lastSyncServerUrl' / 'lastSyncProfileId' /
 * 'lastSyncDatastoreVersion' — see the module comment above for why sharing
 * `lastSyncAt` is unsafe for a table with no per-row syncedAt of its own.
 */
function getTagPushWatermark(): number {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'lastTagPushAt'
    `).get() as { value: string } | undefined;
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // fall through to default
  }
  return 0;
}

/**
 * Persist the tag-push watermark. See getTagPushWatermark() for what it means;
 * pushTagsToServer() is the only caller, and only calls this after every tag in
 * the batch has been confirmed pushed — see pushTagsToServer()'s doc comment.
 */
function saveTagPushWatermark(timestamp: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'lastTagPushAt', ?, ?)
  `).run('sync-lastTagPushAt', JSON.stringify(timestamp), Date.now());
}

/**
 * Push local tags whose metadata (slug/color/parentId/description/metadata)
 * changed since the last tag push, per the dedicated tag-push watermark
 * (getTagPushWatermark()). The local `parentId` — a local tag id — is resolved
 * to the parent's `name` before it goes on the wire (still under the key
 * `parentId`, but holding a name), since name is the identity (see module
 * comment above).
 *
 * The watermark only advances once every chunk in this run has been confirmed
 * pushed: if any `serverFetch` call throws, this function throws too, and
 * saveTagPushWatermark() below is never reached — the watermark stays exactly
 * where it was, so every tag from this run (including ones a prior chunk in the
 * same run already delivered) is retried on the next push. Re-pushing a tag is
 * idempotent (the server upserts by name — db.js saveTags()), so retrying a
 * tag that already landed is harmless; leaving a genuinely-failed one stranded
 * past a watermark that moved on anyway is not.
 */
export async function pushTagsToServer(
  serverUrl: string,
  apiKey: string
): Promise<TagPushResult> {
  const db = getDb();
  const activeProfile = getActiveProfile();
  const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

  if (!profileSyncConfig) {
    throw new Error('Sync not configured for active profile');
  }

  const watermark = getTagPushWatermark();

  // Captured BEFORE the SELECT below runs, not after the push completes — same
  // reasoning as pushEventsToServer()'s captureTime: a tag edited during this
  // function's own network round-trip must stay eligible for the NEXT run
  // rather than being skipped by a watermark that advanced past it despite it
  // never actually being sent.
  const captureTime = Date.now();

  const rows = db.prepare(`
    SELECT id, name, slug, color, parentId, description, metadata, createdAt, updatedAt
    FROM tags
    WHERE updatedAt > ?
    ORDER BY updatedAt ASC
  `).all(watermark) as Array<{
    id: string;
    name: string;
    slug: string | null;
    color: string | null;
    parentId: string;
    description: string | null;
    metadata: string;
    createdAt: number;
    updatedAt: number;
  }>;

  DEBUG && console.log(`[sync] Found ${rows.length} tags to push`);

  let pushed = 0;
  for (let i = 0; i < rows.length; i += MAX_TAGS_PER_PUSH) {
    const batch = rows.slice(i, i + MAX_TAGS_PER_PUSH);
    const tags = batch.map((row) => {
      // row.parentId is a local tag id — resolve it to the parent's name, the
      // identity the wire format uses (module comment above). The resolved
      // name still goes out under the wire key `parentId`, matching the
      // server column of the same name (also a name, not a row id).
      let parentName: string | null = null;
      if (row.parentId) {
        const parent = db.prepare('SELECT name FROM tags WHERE id = ?').get(row.parentId) as
          | { name: string }
          | undefined;
        parentName = parent ? parent.name : null;
      }

      let metadata: Record<string, unknown> | undefined;
      if (row.metadata && row.metadata !== '{}') {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          // Invalid JSON, omit metadata
        }
      }

      return {
        name: row.name,
        slug: row.slug || '',
        color: row.color || '',
        parentId: parentName,
        description: row.description || '',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(metadata ? { metadata } : {}),
      };
    });

    const path = `/tags?profile=${encodeURIComponent(profileSyncConfig.serverProfileId || activeProfile.id)}`;
    const response = await serverFetch<{ received: number; saved: number }>(
      serverUrl,
      apiKey,
      path,
      { method: 'POST', body: { tags } }
    );
    pushed += response.saved;
  }

  // Reached only if every chunk above succeeded — see this function's doc
  // comment. `- 1`: symmetric with pushEventsToServer()'s newWatermark — the
  // next run's query is a strict `updatedAt > watermark`, so the watermark
  // must sit BEFORE captureTime, not AT it.
  const newWatermark = captureTime - 1;
  saveTagPushWatermark(newWatermark);

  DEBUG && console.log(`[sync] Tag push complete: ${pushed} saved, watermark -> ${newWatermark}`);

  return { pushed };
}

/**
 * Pull tag metadata the server has recorded since `since`, merging each into
 * the local `tags` table. Two passes over the pulled batch, per the module
 * comment above:
 *
 * 1. mergeServerTag() upserts every incoming tag by name with local `parentId`
 *    left untouched (a brand-new local row gets '').
 * 2. resolveTagParent() resolves each incoming tag's wire `parentId` (a NAME,
 *    not a row id) to a local tag id and sets local `parentId` — but only for
 *    tags pass 1 actually applied (new, or server-newer), so last-write-wins
 *    governs the parent link the same way it governs the rest of the row.
 *
 * Splitting into two passes means a parent arriving after its child in the
 * same pull still ends up linked; a single-pass merge would depend on arrival
 * order. After both passes, breakTagParentCycles() walks the ancestor chain of
 * every tag this pull touched and deterministically breaks any cycle it finds.
 */
export async function pullTagsFromServer(
  serverUrl: string,
  apiKey: string,
  since?: number
): Promise<TagPullResult> {
  const activeProfile = getActiveProfile();
  const profileSyncConfig = getProfileSyncConfig(activeProfile.id);

  if (!profileSyncConfig) {
    throw new Error('Sync not configured for active profile');
  }

  const timestamp = since && since > 0 ? since : 0;
  let path = `/tags/since/${timestamp}`;
  path += `?profile=${encodeURIComponent(profileSyncConfig.serverProfileId || activeProfile.id)}`;

  const response = await serverFetch<{ tags: ServerTag[] }>(serverUrl, apiKey, path);
  const serverTags = response.tags;

  DEBUG && console.log(`[sync] Received ${serverTags.length} tags from server`);

  let pulled = 0;
  const applied: ServerTag[] = [];
  for (const serverTag of serverTags) {
    if (mergeServerTag(serverTag)) {
      pulled++;
      applied.push(serverTag);
    }
  }

  for (const serverTag of applied) {
    resolveTagParent(serverTag);
  }

  breakTagParentCycles(applied.map((t) => t.name));

  DEBUG && console.log(`[sync] Tag pull complete: ${pulled} pulled`);

  return { pulled };
}

/**
 * Pass 1 of pullTagsFromServer(): upsert one server tag into the local `tags`
 * table by name, last-write-wins on `updatedAt` (matching mergeServerItem()) —
 * server newer applies, local newer keeps local, equal skips. `parentId` is
 * deliberately left alone here (untouched on update, '' on insert); pass 2
 * (resolveTagParent()) sets it once every tag in the batch is guaranteed to
 * exist locally. Returns true if the server version was applied (inserted or
 * updated), false if the local row was kept.
 */
function mergeServerTag(serverTag: ServerTag): boolean {
  const db = getDb();

  const local = db.prepare('SELECT * FROM tags WHERE name = ?').get(serverTag.name) as Tag | undefined;
  const metadataJson = serverTag.metadata ? JSON.stringify(serverTag.metadata) : '{}';

  if (!local) {
    const tagId = generateId('tag');
    db.prepare(`
      INSERT INTO tags (id, name, slug, color, parentId, description, metadata, createdAt, updatedAt, frequency, lastUsed, frecencyScore)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 0, 0, 0)
    `).run(
      tagId,
      serverTag.name,
      serverTag.slug || '',
      serverTag.color || '#999999',
      serverTag.description || '',
      metadataJson,
      serverTag.createdAt,
      serverTag.updatedAt
    );
    return true;
  }

  if (serverTag.updatedAt > local.updatedAt) {
    db.prepare(`
      UPDATE tags SET slug = ?, color = ?, description = ?, metadata = ?, updatedAt = ? WHERE id = ?
    `).run(
      serverTag.slug || '',
      serverTag.color || '#999999',
      serverTag.description || '',
      metadataJson,
      serverTag.updatedAt,
      local.id
    );
    return true;
  }

  // local.updatedAt >= serverTag.updatedAt: local wins on newer, and ties skip.
  return false;
}

/**
 * Pass 2 of pullTagsFromServer(): resolve one server tag's wire `parentId`
 * (a NAME, not a row id) to a local tag id and set local `parentId` on the
 * (already-upserted, by pass 1) local row of the same name. A wire `parentId`
 * the local database doesn't recognize (not part of this pull, and never
 * synced before) leaves local `parentId` untouched rather than silently
 * dropping the link — it will resolve on a later pull once that parent tag
 * exists locally.
 */
function resolveTagParent(serverTag: ServerTag): void {
  const db = getDb();

  const local = db.prepare('SELECT id, parentId FROM tags WHERE name = ?').get(serverTag.name) as
    | { id: string; parentId: string }
    | undefined;
  if (!local) return; // pass 1 just upserted this — should not happen

  if (!serverTag.parentId) {
    if (local.parentId !== '') {
      db.prepare('UPDATE tags SET parentId = ? WHERE id = ?').run('', local.id);
    }
    return;
  }

  const parent = db.prepare('SELECT id FROM tags WHERE name = ?').get(serverTag.parentId) as
    | { id: string }
    | undefined;
  if (!parent) return;

  if (local.parentId !== parent.id) {
    db.prepare('UPDATE tags SET parentId = ? WHERE id = ?').run(parent.id, local.id);
  }
}

/**
 * Walk the ancestor chain of each named tag (post pass-2, so `parentId` is
 * current) and deterministically break any cycle found: the tag IN the cycle
 * with the newest `updatedAt` has its `parentId` cleared, ties broken by lower
 * `id` — a pure function of data already on every device, so two devices that
 * pull the same cycle-forming input break the same link, not whichever one
 * happened to walk it first.
 */
function breakTagParentCycles(touchedNames: string[]): void {
  const db = getDb();

  for (const name of touchedNames) {
    const start = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: string } | undefined;
    if (!start) continue;

    const path: string[] = [];
    let currentId: string | null = start.id;

    while (currentId) {
      if (path.includes(currentId)) {
        const cycleIds = path.slice(path.indexOf(currentId));
        breakCycle(db, cycleIds);
        break;
      }
      path.push(currentId);
      const row = db.prepare('SELECT parentId FROM tags WHERE id = ?').get(currentId) as
        | { parentId: string }
        | undefined;
      currentId = row && row.parentId ? row.parentId : null;
    }
  }
}

function breakCycle(db: ReturnType<typeof getDb>, cycleIds: string[]): void {
  const candidates = cycleIds.map((id) =>
    db.prepare('SELECT id, name, updatedAt FROM tags WHERE id = ?').get(id) as {
      id: string;
      name: string;
      updatedAt: number;
    }
  );
  // Newest updatedAt is selected for the break; ties go to the lower id, so
  // every device picks the same tag regardless of which order it walked in.
  candidates.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const toBreak = candidates[0];
  db.prepare('UPDATE tags SET parentId = ? WHERE id = ?').run('', toBreak.id);
  DEBUG && console.log(`[sync] Broke tag parent cycle: cleared parentId on '${toBreak.name}' (${toBreak.id})`);
}

// ==================== Server Change Detection ====================

/**
 * Clear per-item sync markers so the next push resends every live item, and reset the
 * profile's high-water mark so the next pull re-fetches everything the server has.
 * Shared by resetSyncStateIfServerChanged() and resetSyncStateIfDatastoreVersionChanged()
 * — same recovery, different trigger.
 */
function resetPerItemSyncState(profileId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE items SET syncedAt = 0, syncId = '' WHERE deletedAt = 0
  `).run();
  updateLastSyncTime(profileId, 0);

  // Clearing every item's syncId above means pushEventsToServer()'s own
  // "blocked" scan (WHERE i.syncId = '') would — for exactly one run —
  // see every item as newly blocked and pull the event watermark back to
  // cover them. But that scan only protects events whose parent is STILL
  // blocked at the moment it runs; an item that regains its syncId from
  // THIS SAME run's own item push (pushToServer always runs immediately
  // before pushEventsToServer) looks already-resolved by the time the scan
  // runs, so events excluded by an already-advanced watermark from BEFORE
  // this reset would never be rescued. Reset the event watermark to 0
  // explicitly, the same "start over" the item watermark above gets.
  saveEventPushWatermark(0);

  // Tags have no such "blocked" window — a tag isn't gated on any other
  // entity's sync state the way an event is gated on its parent item's syncId
  // — but the same "start over" applies for the same underlying reason: the
  // tag-push query only re-sends rows changed since the last tag push, so
  // without this reset every tag already on the server would keep whatever
  // metadata shape the OLD version last sent, forever.
  saveTagPushWatermark(0);
}

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
    resetPerItemSyncState(activeProfile.id);
    return true;
  }

  return false;
}

/**
 * Detect if this client is syncing for the first time since DATASTORE_VERSION last
 * changed, and reset per-item sync markers if so.
 *
 * pushToServer() only ever selects rows where syncedAt = 0 or updatedAt > syncedAt —
 * an item already synced under the old schema stays out of that set forever, so it
 * would never re-push the columns a DATASTORE_VERSION bump just added (the re-push
 * problem: see docs/sync-coverage-gaps.md §1, and the required_sync_columns addition
 * in packages/schema/v1.json this version bump accompanies). This reuses the exact
 * recovery resetSyncStateIfServerChanged() already has for "start over" — it just
 * triggers off a different signal: the client's OWN previously-recorded
 * DATASTORE_VERSION, not the server's. It runs independent of (and before)
 * serverFetch()'s header check, which only refuses sync outright on a live mismatch
 * against the server's reported version — it can't retroactively resend items that
 * synced before this code existed.
 */
function resetSyncStateIfDatastoreVersionChanged(): boolean {
  const db = getDb();
  const activeProfile = getActiveProfile();

  let storedVersion = 0;
  let hasSyncedBefore = false;
  try {
    const versionRow = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'lastSyncDatastoreVersion'
    `).get() as { value: string } | undefined;
    if (versionRow?.value) storedVersion = JSON.parse(versionRow.value);
  } catch { /* never recorded */ }

  try {
    const urlRow = db.prepare(`
      SELECT value FROM feature_settings
      WHERE featureId = 'sync' AND key = 'lastSyncServerUrl'
    `).get() as { value: string } | undefined;
    hasSyncedBefore = !!urlRow?.value;
  } catch { /* never synced */ }

  // No stored version and no sync history — a brand-new profile has nothing pushed
  // yet to miss the new columns. Just start tracking from here.
  if (storedVersion === 0 && !hasSyncedBefore) {
    saveSyncDatastoreVersion();
    return false;
  }

  if (storedVersion !== DATASTORE_VERSION) {
    DEBUG && console.log(`[sync] Datastore version changed (${storedVersion || '(untracked)'} -> ${DATASTORE_VERSION}) — resetting per-item sync state`);
    resetPerItemSyncState(activeProfile.id);
    saveSyncDatastoreVersion();
    return true;
  }

  return false;
}

/**
 * Save the current DATASTORE_VERSION so resetSyncStateIfDatastoreVersionChanged() can
 * detect the next bump.
 */
function saveSyncDatastoreVersion(): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'sync', 'lastSyncDatastoreVersion', ?, ?)
  `).run('sync-lastSyncDatastoreVersion', JSON.stringify(DATASTORE_VERSION), Date.now());
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

  // Check if server config or DATASTORE_VERSION changed — reset per-item sync markers
  // if so. Both run unconditionally (not short-circuited) since each also persists its
  // own tracked value regardless of whether it triggered a reset.
  const serverChanged = resetSyncStateIfServerChanged(serverUrl);
  const versionChanged = resetSyncStateIfDatastoreVersionChanged();
  const wasReset = serverChanged || versionChanged;
  if (wasReset) {
    DEBUG && console.log('[sync] Sync state reset due to server or datastore version change — all items will be synced');
  }

  const config = getSyncConfig();

  DEBUG && console.log('[sync] Starting full sync...');

  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  try {
    // Tag pull runs BEFORE item pull: an incoming item that references a tag
    // (by name, via its `tags` array) must find that tag already shaped
    // locally — slug/color/parentId/description/metadata — rather than only
    // the bare row getOrCreateTag() would otherwise create on demand.
    const tagPullResult = await pullTagsFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled = tagPullResult.pulled;

    // Pull items (to get any server changes)
    const pullResult = await pullFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled += pullResult.pulled;
    conflicts = pullResult.conflicts;

    // Event pull runs AFTER item pull: it resolves each event's server itemId
    // against a local item's syncId, so any item newly pulled above must
    // already exist locally before its events can be addressed.
    const eventPullResult = await pullEventsFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled += eventPullResult.pulled;

    // Tag push runs BEFORE item push for the same reason pull runs it first:
    // pushSingleItem() sends tag NAMES only, so ordering doesn't create a
    // dependency the way events depend on their parent item's syncId — this
    // is about the server shaping tag rows correctly (metadata attached)
    // before whichever device the tags travel to actually pulls them back.
    const tagPushResult = await pushTagsToServer(serverUrl, apiKey);
    pushed = tagPushResult.pushed;

    // Then push local item changes
    const pushResult = await pushToServer(serverUrl, apiKey, config.lastSyncTime);
    pushed += pushResult.pushed;

    // Event push runs AFTER item push for the same reason: a locally-created
    // item needs the syncId its own push just assigned before its events can
    // be pushed. Unlike items, it does not take config.lastSyncTime — it
    // tracks its own watermark (see pushEventsToServer()'s doc comment for
    // why the shared one is unsafe for events).
    const eventPushResult = await pushEventsToServer(serverUrl, apiKey);
    pushed += eventPushResult.pushed;

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
