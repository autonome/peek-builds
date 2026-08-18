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
import { publish, getSystemAddress } from './pubsub.js';

// ==================== Sync Progress Log ====================
//
// Observability for the Settings sync panel: a full syncAll() run against a
// large dataset is a single opaque "Syncing…" button press today, with
// nothing shown until it either completes or throws. This gives a live
// status line and a per-run log without touching what syncAll() actually
// does — every call below is additive logging around the existing stages.

/** The six sync stages plus the overall run, matching syncAll()'s own
 * ordering (tag pull, item pull, event pull, tag push, item push, event
 * push). */
export type SyncStage =
  | 'run'
  | 'pull-tags' | 'pull-items' | 'pull-events'
  | 'push-tags' | 'push-items' | 'push-events';

export type SyncProgressPhase = 'start' | 'progress' | 'finish' | 'error' | 'dropped';

export interface SyncProgressEntry {
  ts: number;
  stage: SyncStage;
  phase: SyncProgressPhase;
  message: string;
}

// Ring buffer of the CURRENT run's progress entries. A few hundred is
// enough to hold every stage boundary plus the throttled item-push
// progress entries for a run, without growing unbounded across an
// 11k-item push — see logSyncProgress()'s trim below.
const SYNC_LOG_MAX_ENTRIES = 300;
let syncLog: SyncProgressEntry[] = [];

/** Drop the current run's log. Called once, at the start of syncAll() —
 * NOT by the standalone pull/push stage functions, which can also run
 * outside syncAll() (the Settings "Pull"/"Push" buttons) and shouldn't
 * blow away a log an open panel is mid-way through showing. */
function resetSyncLog(): void {
  syncLog = [];
}

/**
 * Record one entry in the current run's log, and publish it live so an
 * open Settings panel updates in real time. `publish()` is a no-op when
 * nothing is subscribed (pubsub.ts `deliver()` iterates an empty
 * subscriber set and returns) — a sync run never waits on, or even checks
 * for, a renderer being open.
 */
function logSyncProgress(stage: SyncStage, phase: SyncProgressPhase, message: string): void {
  const entry: SyncProgressEntry = { ts: Date.now(), stage, phase, message };
  syncLog.push(entry);
  if (syncLog.length > SYNC_LOG_MAX_ENTRIES) {
    syncLog.splice(0, syncLog.length - SYNC_LOG_MAX_ENTRIES);
  }
  publish(getSystemAddress(), 'sync:progress', entry);
}

/**
 * Snapshot of the current run's progress log. `tile:sync:get-log` (see
 * tile-ipc.ts) reads this so the Settings panel can render what already
 * happened when opened mid-run, rather than starting from an empty log.
 * Returns a copy — callers must not mutate the live buffer.
 */
export function getSyncLog(): SyncProgressEntry[] {
  return syncLog.slice();
}

/** @internal Test hook: append an entry through the exact same
 * bounded-buffer + publish path logSyncProgress() uses, without needing a
 * real sync stage to run — lets tests exercise ring-buffer trimming at
 * production scale without thousands of network round trips. */
export function __logSyncProgressForTest(stage: SyncStage, phase: SyncProgressPhase, message: string): void {
  logSyncProgress(stage, phase, message);
}

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
  timeoutMs?: number;
}

// Default per-request budget. A hung single write (item push, tag push, event
// chunk) should still fail fast, so every call keeps this unless it opts into
// a larger one below.
const DEFAULT_FETCH_TIMEOUT_MS = 15000;

// The items/tags/events `since` pulls each return the WHOLE profile as one
// unpaginated JSON body — measured at ~10MB / ~600ms from a fast link, but
// long enough over a slow one to blow past the default budget. Those pulls
// also run first in syncAll(), before any push, so a too-tight timeout here
// doesn't just fail one request — it aborts the entire sync before anything
// ever gets pushed. Give bulk pulls this much larger budget instead of
// raising the default everywhere.
const BULK_PULL_TIMEOUT_MS = 120000;

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Peek-Datastore-Version': String(DATASTORE_VERSION),
        'X-Peek-Protocol-Version': String(PROTOCOL_VERSION),
        'X-Peek-Client': 'desktop',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // AbortSignal.timeout() rejects with a bare DOMException — "The operation
    // was aborted due to timeout" — that says nothing about which request
    // died. Name the path and the budget it exceeded so a timeout is legible
    // wherever it surfaces (getSyncStatus().lastError, the Settings error line).
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }

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

  const response = await serverFetch<{ items: ServerItem[] }>(serverUrl, apiKey, path, {
    timeoutMs: BULK_PULL_TIMEOUT_MS,
  });
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

// Item push is one sequential HTTP request per item — ~11k requests on a
// full re-push. Logging every one would flood the log/pubsub channel, so
// progress is throttled to whichever of these fires first: this many items
// done, or this much time elapsed since the last progress entry. The time
// bound matters as much as the count bound here — a slow link can take
// far longer than ITEM_PUSH_PROGRESS_INTERVAL_MS to move
// ITEM_PUSH_PROGRESS_EVERY items, and the live status line must still move.
const ITEM_PUSH_PROGRESS_EVERY = 100;
const ITEM_PUSH_PROGRESS_INTERVAL_MS = 3000;

// Shared by this section and the event-push section below (pushEventsToServer's
// dropped-row and rejected-chunk summaries): a per-row try/catch that only counts
// failures (the shape both item push and event push use) tells the user nothing
// about WHY, but logging one entry per failure doesn't scale — a full re-push can
// fail thousands of items, and a down server fails every one of them with the
// SAME message. Group by message instead, one line per distinct reason, so a
// systemic failure is one line and a handful of one-off failures are still legible
// individually.
//
// Capped at 20 distinct reasons: enough to surface every common cause in one
// screen of the (already-scrollable) sync log without a validation bug that
// produces a different message per row turning the log into the failure list
// itself. Reasons past the cap collapse into a single "N more" tail instead of
// vanishing silently.
const PUSH_FAILURE_REASONS_MAX = 20;
// Ids are listed only for a small group — past this, the id list is as
// unreadable as one line per failure would have been, and the log's job here is
// to say WHY a class of failure happened, not to enumerate every row. A full
// re-push can still fail thousands of items with the same reason, so the cap
// has to hold even then — but a handful of failures (the case a user actually
// chases down, e.g. one malformed item blocking every future run) is exactly
// where the ids matter most, and 20 of them is still a readable log entry.
const PUSH_FAILURE_IDS_MAX = 20;

/**
 * Turn a reason -> ids map into one summary line per distinct reason, most
 * common first, capped per PUSH_FAILURE_REASONS_MAX/_IDS_MAX above. `noun`
 * only affects wording ('item', 'event'); ids are always the row's own id —
 * never content or values, since this ends up in the Settings sync log.
 */
function groupFailuresByReason(idsByReason: Map<string, string[]>, noun: string): string[] {
  const sorted = [...idsByReason.entries()].sort((a, b) => b[1].length - a[1].length);
  const shown = sorted.slice(0, PUSH_FAILURE_REASONS_MAX);
  const lines = shown.map(([reason, ids]) => {
    const idPart = ids.length <= PUSH_FAILURE_IDS_MAX ? ` (${ids.join(', ')})` : '';
    return `${ids.length} ${noun}(s): ${reason}${idPart}`;
  });
  const rest = sorted.slice(PUSH_FAILURE_REASONS_MAX);
  if (rest.length > 0) {
    const restCount = rest.reduce((sum, [, ids]) => sum + ids.length, 0);
    lines.push(`...and ${rest.length} more distinct error(s) (${restCount} more ${noun}(s))`);
  }
  return lines;
}

/**
 * A message shaped `Server error <status>: <body>` (serverFetch's own error
 * throw, above) with a 4xx status means the server looked at this exact row
 * and rejected it — resending the same body next run cannot change that
 * outcome. Anything else (a timeout, a network error, a 5xx) means the
 * server or the link was unavailable, which is exactly the kind of failure
 * an unchanged retry can clear on its own.
 */
function isPermanentPushFailure(message: string): boolean {
  const match = message.match(/^Server error (\d)\d\d:/);
  return match !== null && match[1] === '4';
}

/**
 * Split a reason -> ids map into the permanent (isPermanentPushFailure()
 * above) and transient reasons within it, so pushToServer() and
 * pushEventsToServer() can log the two classes as separate lines — same
 * grouping, different wording — without duplicating the accumulation loop
 * per class.
 */
function partitionByPermanence(idsByReason: Map<string, string[]>): {
  permanent: Map<string, string[]>;
  transient: Map<string, string[]>;
} {
  const permanent = new Map<string, string[]>();
  const transient = new Map<string, string[]>();
  for (const [reason, ids] of idsByReason) {
    (isPermanentPushFailure(reason) ? permanent : transient).set(reason, ids);
  }
  return { permanent, transient };
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
  // Reason (error message) -> ids of every item that failed with it — see
  // groupFailuresByReason() above for why this is grouped rather than logged
  // per failure.
  const failuresByReason = new Map<string, string[]>();

  // Throttle state for the item-push progress line — see
  // ITEM_PUSH_PROGRESS_EVERY/_INTERVAL_MS above.
  let lastProgressCount = 0;
  let lastProgressAt = Date.now();

  for (const item of items) {
    try {
      await pushSingleItem(serverUrl, apiKey, item);
      pushed++;
    } catch (error) {
      const message = (error as Error).message;
      DEBUG && console.log(`[sync] Failed to push item ${item.id}:`, message);
      failed++;
      const ids = failuresByReason.get(message);
      if (ids) {
        ids.push(item.id);
      } else {
        failuresByReason.set(message, [item.id]);
      }
    }

    const done = pushed + failed;
    const now = Date.now();
    if (
      done - lastProgressCount >= ITEM_PUSH_PROGRESS_EVERY ||
      now - lastProgressAt >= ITEM_PUSH_PROGRESS_INTERVAL_MS
    ) {
      logSyncProgress('push-items', 'progress', `Pushing items — ${done} / ${items.length}`);
      lastProgressCount = done;
      lastProgressAt = now;
    }
  }

  // Always emit one final progress entry with the true final count, even
  // when the run ends inside a throttle window that would otherwise have
  // suppressed it — the live status line must never be left showing a
  // stale count after the loop is actually done.
  if (items.length > 0) {
    logSyncProgress('push-items', 'progress', `Pushing items — ${pushed + failed} / ${items.length}`);
  }

  // Surfaced in the Settings sync log — "Pushed N item(s), M failed" (logged
  // by syncAll() from this function's return value) says HOW MANY, not why;
  // these lines say why, grouped so a systemic failure (every item hitting
  // the same server error) reads as one line, not thousands. Split by
  // isPermanentPushFailure() so a 400 (this item, as-sent, will never be
  // accepted — retrying it every run is wasted work) reads differently from
  // a timeout/5xx (the next run can simply succeed).
  if (failuresByReason.size > 0) {
    const { permanent, transient } = partitionByPermanence(failuresByReason);
    for (const line of groupFailuresByReason(permanent, 'item')) {
      logSyncProgress('push-items', 'error', `Item push rejected, will not succeed until the item changes — ${line}`);
    }
    for (const line of groupFailuresByReason(transient, 'item')) {
      logSyncProgress('push-items', 'error', `Item push failed, will retry next run — ${line}`);
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
// per-row syncedAt/syncId column here. Push stamps its own per-row column
// instead, `pushedAt` (0 = never delivered), rather than reading the profile's
// shared item watermark (`lastSyncAt`): that watermark advances at the end of
// every run that doesn't throw, including one where an item's push failed, and
// events have no other per-row marker to fall back on the way items do with
// their own `syncedAt`.
//
// A single global event watermark was the previous design, and is why this one
// exists. It had to be held below the oldest event of ANY item still lacking a
// syncId, so that events were not stranded when their parent item finally
// synced. But an item the server permanently rejects — or one of a type that is
// never synced at all — never earns a syncId, so it pinned the watermark
// indefinitely and every run re-pushed the whole event tail behind it (24,000
// events per run, measured live). With a per-row stamp, an event whose parent
// cannot sync strands exactly itself, and is picked up whenever that parent
// does sync.
//
// `pushedAt` is declared `"sync": false` in packages/schema/v1.json: it is local
// bookkeeping, never sent on the wire, and the server has no such column — so it
// needs no datastore version bump. datastore.ts migrateEventPushedAtColumn()
// adds the column and backfills it from the retired watermark.
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
  // Count of events dropped from THIS run's batch because their chunk's
  // serverFetch failed (network error, non-2xx, etc.) — NOT malformed rows
  // dropped before ever being sent (those are logged, not counted here; see
  // pushEventsToServer()'s doc comment). Mirrors pushToServer()'s own
  // `failed` field — same "isolate and count, don't abort" shape, applied to
  // whole chunks instead of individual items.
  failed: number;
}

interface EventPullResult {
  pulled: number;
}

/**
 * Stamp `pushedAt` on the events the server has just accepted. Called once per
 * delivered chunk rather than once at the end, so a later chunk failing cannot
 * un-record an earlier one that already landed.
 */
function markEventsPushed(eventIds: string[]): void {
  if (eventIds.length === 0) return;
  const db = getDb();
  const placeholders = eventIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE item_events SET pushedAt = ? WHERE id IN (${placeholders})
  `).run(Date.now(), ...eventIds);
}

/**
 * Push local item_events whose parent item has already been synced (has a
 * non-empty syncId — see module comment above) and that have never been
 * delivered (`pushedAt = 0`).
 *
 * Only the events a chunk actually delivered are stamped, so each of the three
 * ways an event can miss a run — its parent item not synced yet, its row dropped
 * as malformed, its chunk rejected — leaves that event, and only that event,
 * eligible for the next run. Re-pushing an already-delivered event is a no-op
 * (the server INSERT OR IGNOREs on id), so erring toward sending more than
 * strictly necessary is always safe here; erring toward sending less is not.
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

  // No time bound, deliberately: an event stays eligible until it has actually
  // been delivered, which is what `pushedAt = 0` says. An event created during
  // this function's own network round-trip is simply not in this result set, so
  // nothing stamps it and the next run picks it up — the race a time-based
  // watermark had to be computed around does not arise.
  const rows = db.prepare(`
    SELECT e.id as id, e.content as content, e.value as value, e.occurredAt as occurredAt,
      e.metadata as metadata, e.createdAt as createdAt, i.syncId as itemSyncId
    FROM item_events e
    JOIN items i ON e.itemId = i.id
    WHERE i.syncId != '' AND e.pushedAt = 0
    ORDER BY e.createdAt ASC
  `).all() as Array<{
    id: string;
    content: string | null;
    value: number | null;
    occurredAt: number;
    metadata: string;
    createdAt: number;
    itemSyncId: string;
  }>;

  DEBUG && console.log(`[sync] Found ${rows.length} events to push`);

  // A malformed row (a missing id/itemId, or an occurredAt/createdAt that isn't a
  // finite number — e.g. the NaN an unparseable RSS <pubDate> produces, which binds
  // as NULL) would otherwise ride along in a batch and get the WHOLE request 400'd
  // by the server's own per-event validation (apps/server/index.js POST /events),
  // poisoning every subsequent run since the batch never changes. Drop it before it
  // ever reaches the request, and log it loudly — a silently dropped event is worse
  // than a loud one, since nothing else will ever point at the bad row.
  const validRows: typeof rows = [];
  const droppedRows: typeof rows = [];
  // Reason (which specific field was bad) -> ids of every row dropped for it —
  // grouped for the same reason pushToServer() groups item failures (see
  // groupFailuresByReason() above): a bad batch can drop far more rows than a
  // one-line-per-row log could stay readable through.
  const droppedByReason = new Map<string, string[]>();
  for (const row of rows) {
    const badFields: string[] = [];
    if (!row.id) badFields.push('missing id');
    if (!row.itemSyncId) badFields.push('missing itemId');
    if (!Number.isFinite(row.occurredAt)) badFields.push('non-numeric occurredAt');
    if (!Number.isFinite(row.createdAt)) badFields.push('non-numeric createdAt');
    if (badFields.length > 0) {
      droppedRows.push(row);
      const reason = badFields.join(', ');
      const id = row.id || '(no id)';
      const ids = droppedByReason.get(reason);
      if (ids) {
        ids.push(id);
      } else {
        droppedByReason.set(reason, [id]);
      }
    } else {
      validRows.push(row);
    }
  }
  if (droppedRows.length > 0) {
    console.log(`[sync] Dropped ${droppedRows.length} malformed event(s) from push`);
    // Surfaced in the Settings sync log too, one line per distinct bad field —
    // a silently dropped event is exactly what the user needs to see, not
    // just what DEBUG logging sees.
    for (const line of groupFailuresByReason(droppedByReason, 'event')) {
      logSyncProgress('push-events', 'dropped', `Dropped malformed event(s) — ${line}`);
    }
  }

  // A dropped row needs no bookkeeping to stay repairable: it is simply never
  // stamped, so it is back in the next run's batch, and every run after that,
  // until whatever made it malformed is fixed.

  let pushed = 0;
  let failed = 0;
  // Reason (the server's own error message for the chunk) -> ids of every
  // event in a chunk that failed with it — see groupFailuresByReason() above.
  const chunkFailuresByReason = new Map<string, string[]>();
  // How much work this stage is about to do, before it starts doing it — a
  // stage that logs nothing between its start and finish lines reads as a hang,
  // and this one used to have tens of thousands of events to get through.
  const chunkCount = Math.ceil(validRows.length / MAX_EVENTS_PER_PUSH);
  if (validRows.length > 0) {
    logSyncProgress(
      'push-events',
      'progress',
      `Pushing ${validRows.length} event(s) in ${chunkCount} batch(es) of up to ${MAX_EVENTS_PER_PUSH}`
    );
  }
  // Each batch is one sequential request that can sit for the full fetch
  // timeout, so a stage covering tens of thousands of events can run for
  // minutes with nothing to show for it. Emit a line per batch boundary,
  // throttled the same way item push is (ITEM_PUSH_PROGRESS_INTERVAL_MS) so a
  // fast run doesn't turn the log into one line per batch.
  let lastEventProgressAt = Date.now();
  for (let i = 0; i < validRows.length; i += MAX_EVENTS_PER_PUSH) {
    const batch = validRows.slice(i, i + MAX_EVENTS_PER_PUSH);
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
    try {
      const response = await serverFetch<{ received: number; saved: number }>(
        serverUrl,
        apiKey,
        path,
        { method: 'POST', body: { events } }
      );
      pushed += response.saved;
      // Stamp what the server took, before any later chunk can fail. A 2xx means
      // the whole batch was accepted; `saved` counts only the rows it actually
      // inserted, since an id the server already holds is ignored, not rejected.
      markEventsPushed(batch.map((row) => row.id));
    } catch (error) {
      // One failing chunk must not abandon the remaining chunks — each chunk is an
      // independent request, so a transient failure on chunk N has no bearing on
      // whether chunk N+1 will succeed. The failed chunk's events are left
      // unstamped, so they are eligible again on the next run.
      const message = (error as Error).message;
      DEBUG && console.log(
        `[sync] Event push chunk failed (${batch.length} events), will retry next run:`,
        message
      );
      failed += batch.length;
      const ids = chunkFailuresByReason.get(message);
      const batchIds = batch.map((row) => row.id);
      if (ids) {
        ids.push(...batchIds);
      } else {
        chunkFailuresByReason.set(message, batchIds);
      }
    }

    const doneRows = Math.min(i + MAX_EVENTS_PER_PUSH, validRows.length);
    const now = Date.now();
    if (doneRows === validRows.length || now - lastEventProgressAt >= ITEM_PUSH_PROGRESS_INTERVAL_MS) {
      logSyncProgress(
        'push-events',
        'progress',
        `Pushing events — ${doneRows} / ${validRows.length}`
      );
      lastEventProgressAt = now;
    }
  }

  // Surfaced in the Settings sync log — grouped by the server's own error
  // message so N chunks failing for the SAME reason (e.g. the server down for
  // the whole run) collapse into one line instead of one per chunk. Events in
  // a failed chunk are not lost — being unstamped is what keeps them eligible,
  // and they are retried unchanged regardless of which class this is (see
  // isPermanentPushFailure()); only the wording below tells the two apart, so a
  // 400 doesn't read as if next run will help.
  if (chunkFailuresByReason.size > 0) {
    const { permanent, transient } = partitionByPermanence(chunkFailuresByReason);
    for (const line of groupFailuresByReason(permanent, 'event')) {
      logSyncProgress('push-events', 'error', `Event chunk(s) rejected, will not succeed until the events change — ${line}`);
    }
    for (const line of groupFailuresByReason(transient, 'event')) {
      logSyncProgress('push-events', 'error', `Event chunk(s) rejected, will retry next run — ${line}`);
    }
  }

  // Nothing to reconcile at the end of the run: events whose parent item has no
  // syncId were excluded by the query above and were never stamped, so they are
  // eligible again next run and stay that way until their item syncs. That
  // includes an item that can NEVER sync — a permanently rejected one, a type
  // outside getSyncedTypes(), a `peek://` item filtered by pushToServer() — which
  // under the old global watermark held back every event in the datastore behind
  // it.
  DEBUG && console.log(`[sync] Event push complete: ${pushed} saved, ${failed} failed`);

  return { pushed, failed };
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

  const response = await serverFetch<{ events: ServerEvent[] }>(serverUrl, apiKey, path, {
    timeoutMs: BULK_PULL_TIMEOUT_MS,
  });
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
// a new one) — push tracks its OWN watermark, for the same reason item_events
// records delivery per row (see the event module comment above): the
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
 * 'lastSyncServerUrl' / 'lastSyncProfileId' / 'lastSyncDatastoreVersion' —
 * see the module comment above for why sharing
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
  // comment. `- 1`: the next run's query is a strict `updatedAt > watermark`, so
  // the watermark must sit BEFORE captureTime, not AT it, or a tag updated in
  // the same millisecond captureTime was read would never be sent.
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

  const response = await serverFetch<{ tags: ServerTag[] }>(serverUrl, apiKey, path, {
    timeoutMs: BULK_PULL_TIMEOUT_MS,
  });
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
 * — same trigger shape ("start over"), but NOT the same scope of reset: see `clearSyncId`.
 *
 * `clearSyncId` decides whether `syncId` — the item's record of which SERVER row it
 * corresponds to — is wiped along with `syncedAt`, or left alone:
 * - Server/profile change (`clearSyncId: true`): a different server has different row
 *   ids, so the old syncId means nothing there and must go. The next push has nothing
 *   to match and INSERTs fresh rows, which is correct — there is nothing on the new
 *   server to UPDATE yet.
 * - Datastore-version bump (`clearSyncId: false`): same server, same row ids — the
 *   version bump only makes what was last pushed stale, not the row identity. Clearing
 *   syncId here was the bug: the server's saveItem() (db.js) matches a pushed item ONLY
 *   by row id or the stored syncId, with no content fallback, so a re-push with syncId
 *   blanked sends the desktop's own local id instead — which matches nothing for an item
 *   that originated elsewhere (pushed by another device, or pulled down from the server)
 *   — and the server inserts a duplicate row rather than updating the existing one.
 *   Clearing `syncedAt` alone is enough to force the re-push; the row identity doesn't
 *   need to move.
 */
function resetPerItemSyncState(profileId: string, clearSyncId: boolean): void {
  const db = getDb();
  if (clearSyncId) {
    db.prepare(`
      UPDATE items SET syncedAt = 0, syncId = '' WHERE deletedAt = 0
    `).run();
  } else {
    db.prepare(`
      UPDATE items SET syncedAt = 0 WHERE deletedAt = 0
    `).run();
  }
  updateLastSyncTime(profileId, 0);

  // Event push state: cleared either way, so every event re-pushes. A
  // datastore-version bump can add required_sync_columns to item_events the same
  // way it can to items/tags, and the event-push query only sends rows that have
  // never been delivered — an event already pushed under the OLD schema would
  // otherwise stay out of that set forever. Same reasoning as the tag watermark
  // below. (The retired global watermark also had to be reset to undo its own
  // blocked-scan interaction with a syncId wipe; per-row stamps have no such
  // coupling, since clearing syncId doesn't change what was already delivered.)
  db.prepare(`UPDATE item_events SET pushedAt = 0`).run();

  // Tags have no "blocked" window — a tag isn't gated on any other entity's sync state
  // the way an event is gated on its parent item's syncId — but the same "start over"
  // applies for the schema-catch-up reason above: the tag-push query only re-sends rows
  // changed since the last tag push, so without this reset every tag already on the
  // server would keep whatever metadata shape the OLD version last sent, forever.
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
    // A different server has different row ids — the old syncId is meaningless there.
    resetPerItemSyncState(activeProfile.id, true);
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
 * in packages/schema/v1.json this version bump accompanies). This triggers the same
 * "start over" recovery resetSyncStateIfServerChanged() has, off a different signal —
 * the client's OWN previously-recorded DATASTORE_VERSION, not the server's — but NOT
 * the same scope: it is still the same server, so the item's `syncId` (which SERVER row
 * it is) stays valid and must be kept, not cleared (see resetPerItemSyncState()'s
 * `clearSyncId` doc comment — clearing it here was the duplicate-row bug: the server
 * can only match a re-push by row id or syncId, so a re-push carrying neither matches
 * nothing and inserts a second row for any item that originated elsewhere). It runs
 * independent of (and before) serverFetch()'s header check, which only refuses sync
 * outright on a live mismatch against the server's reported version — it can't
 * retroactively resend items that synced before this code existed.
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
    // Same server, same row ids — only what was last pushed is stale, so keep syncId.
    resetPerItemSyncState(activeProfile.id, false);
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

  // Reset the progress log for THIS run — see resetSyncLog()'s doc comment
  // for why this lives here rather than in the individual stage functions.
  resetSyncLog();
  logSyncProgress('run', 'start', 'Sync started');

  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  try {
    // Tag pull runs BEFORE item pull: an incoming item that references a tag
    // (by name, via its `tags` array) must find that tag already shaped
    // locally — slug/color/parentId/description/metadata — rather than only
    // the bare row getOrCreateTag() would otherwise create on demand.
    logSyncProgress('pull-tags', 'start', 'Pulling tags…');
    const tagPullResult = await pullTagsFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled = tagPullResult.pulled;
    logSyncProgress('pull-tags', 'finish', `Pulled ${tagPullResult.pulled} tag(s)`);

    // Pull items (to get any server changes)
    logSyncProgress('pull-items', 'start', 'Pulling items…');
    const pullResult = await pullFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled += pullResult.pulled;
    conflicts = pullResult.conflicts;
    logSyncProgress('pull-items', 'finish', `Pulled ${pullResult.pulled} item(s), ${pullResult.conflicts} conflict(s)`);

    // Event pull runs AFTER item pull: it resolves each event's server itemId
    // against a local item's syncId, so any item newly pulled above must
    // already exist locally before its events can be addressed.
    logSyncProgress('pull-events', 'start', 'Pulling events…');
    const eventPullResult = await pullEventsFromServer(serverUrl, apiKey, config.lastSyncTime);
    pulled += eventPullResult.pulled;
    logSyncProgress('pull-events', 'finish', `Pulled ${eventPullResult.pulled} event(s)`);

    // Tag push runs BEFORE item push for the same reason pull runs it first:
    // pushSingleItem() sends tag NAMES only, so ordering doesn't create a
    // dependency the way events depend on their parent item's syncId — this
    // is about the server shaping tag rows correctly (metadata attached)
    // before whichever device the tags travel to actually pulls them back.
    logSyncProgress('push-tags', 'start', 'Pushing tags…');
    const tagPushResult = await pushTagsToServer(serverUrl, apiKey);
    pushed = tagPushResult.pushed;
    logSyncProgress('push-tags', 'finish', `Pushed ${tagPushResult.pushed} tag(s)`);

    // Then push local item changes
    logSyncProgress('push-items', 'start', 'Pushing items…');
    const pushResult = await pushToServer(serverUrl, apiKey, config.lastSyncTime);
    pushed += pushResult.pushed;
    logSyncProgress('push-items', 'finish', `Pushed ${pushResult.pushed} item(s), ${pushResult.failed} failed`);

    // Event push runs AFTER item push for the same reason: a locally-created
    // item needs the syncId its own push just assigned before its events can
    // be pushed. Unlike items, it does not take config.lastSyncTime — it
    // records delivery per event, in item_events.pushedAt (see
    // pushEventsToServer()'s doc comment for why a shared watermark is unsafe
    // for events).
    //
    // Isolated in its own try/catch, unlike every stage above: it is the LAST
    // stage, so letting it throw out to the outer catch would skip
    // updateLastSyncTime()/saveSyncServerConfig() below and strand the
    // watermarks the tag/item pushes above already earned — the exact
    // "one bad stage poisons a run that otherwise made real progress" failure
    // this guards against. pushEventsToServer() itself already isolates a
    // single failing chunk (see its doc comment); this catches anything that
    // still escapes it and records it as a stage failure instead.
    let eventPushError: string | null = null;
    logSyncProgress('push-events', 'start', 'Pushing events…');
    try {
      const eventPushResult = await pushEventsToServer(serverUrl, apiKey);
      pushed += eventPushResult.pushed;
      // A non-zero `failed` means at least one chunk was rejected — isolated
      // internally (the events stay eligible for the next run), but still a
      // real failure the user should be able to see, not silent progress.
      if (eventPushResult.failed > 0) {
        eventPushError = `${eventPushResult.failed} event(s) failed to push`;
      }
      logSyncProgress('push-events', 'finish', `Pushed ${eventPushResult.pushed} event(s), ${eventPushResult.failed} failed`);
    } catch (error) {
      eventPushError = error instanceof Error ? error.message : String(error);
      DEBUG && console.error('[sync] Event push stage failed, rest of sync still recorded:', error);
      logSyncProgress('push-events', 'error', `Event push stage failed: ${eventPushError}`);
    }

    // Update last sync time AFTER push completes — using Date.now() ensures
    // the high-water mark is after any server-side timestamps set during push,
    // preventing the next pull from echoing back items we just pushed. Runs
    // regardless of eventPushError — items and tags having landed is real
    // progress and must be recorded even when the event stage failed.
    const syncTime = Date.now();
    const activeProfile = getActiveProfile();
    updateLastSyncTime(activeProfile.id, syncTime);
    saveSyncServerConfig(serverUrl);

    DEBUG && console.log(`[sync] Sync complete: ${pulled} pulled, ${pushed} pushed, ${conflicts} conflicts`);

    if (eventPushError) {
      lastSyncError = eventPushError;
      lastSyncErrorAt = Date.now();
    } else {
      // Clear any stale error from a previous failed run.
      lastSyncError = null;
      lastSyncErrorAt = 0;
    }

    logSyncProgress('run', 'finish', `Sync complete: ${pulled} pulled, ${pushed} pushed, ${conflicts} conflicts`);

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
    logSyncProgress('run', 'error', `Sync failed: ${lastSyncError}`);
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
