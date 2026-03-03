/**
 * Shared data types used by both the API and backend implementations
 */

// ==================== Datastore Entity Types ====================

export interface Content {
  id: string;
  title: string;
  content: string;
  mimeType: string;
  contentType: string;
  language: string;
  encoding: string;
  tags: string;
  addressRefs: string;
  parentId: string;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  syncPath: string;
  synced: number;
  starred: number;
  archived: number;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
  color: string;
  parentId: string;
  description: string;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  frequency: number;
  lastUsed: number;
  frecencyScore: number;
}

// ==================== Item Types ====================

// Unified types across all platforms (mobile, desktop, server)
// - url: Saved URLs/bookmarks
// - text: Text content/notes
// - tagset: Tag-only items
// - image: Binary images
// - series: Time-series data (numeric or text values over time)
// - feed: External feeds (RSS, ATProto, APIs, logs)
// - entity: Extracted entities (people, places, orgs, events, etc.)
export type ItemType = 'url' | 'text' | 'tagset' | 'image' | 'series' | 'feed' | 'entity';

export interface Item {
  id: string;
  type: ItemType;
  content: string | null;
  mimeType: string;
  metadata: string;
  syncId: string;
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number;
  starred: number;
  archived: number;
  visitCount: number;
  lastVisitAt: number;
  // Local-only columns for URL history unification (not synced)
  frecencyScore: number;
  title: string;
  domain: string;
  favicon: string;
}

// Sync metadata stored inside item metadata._sync
// Used by both desktop and mobile to track which device created/modified items
export interface SyncMetadata {
  createdBy?: string;
  createdAt?: number;
  modifiedBy?: string;
  modifiedAt?: number;
}

// Visit record for item_visits table (local-only, not synced)
export interface ItemVisit {
  id: string;
  itemId: string;
  timestamp: number;
  duration: number;
  source: string;
  sourceId: string;
  windowType: string;
  metadata: string;
  scrollDepth: number;
  interacted: number;
  prevId: string | null;
  nextId: string | null;
}

// Group for organizing items (future-proofing)
export interface ItemGroup {
  id: string;
  name: string;
  description: string;
  type: string;
  query: string;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number;
}

export interface ItemGroupMember {
  id: string;
  groupId: string;
  itemId: string;
  position: number;
  createdAt: number;
}

export interface ItemTag {
  id: string;
  itemId: string;
  tagId: string;
  createdAt: number;
}

export interface Extension {
  id: string;
  name: string;
  description: string;
  version: string;
  path: string;
  backgroundUrl: string;
  settingsUrl: string;
  iconPath: string;
  builtin: number;
  enabled: number;
  status: string;
  installedAt: number;
  updatedAt: number;
  lastErrorAt: number;
  lastError: string;
  metadata: string;
}

export interface ExtensionSetting {
  id: string;
  extensionId: string;
  key: string;
  value: string;
  updatedAt: number;
}

export interface DatastoreStats {
  totalAddresses: number;
  totalVisits: number;
  avgVisitDuration: number;
  totalContent: number;
  syncedContent: number;
  totalItems: number;
  totalTags: number;
  syncedItems: number;
}

// ==================== Filter Types ====================

export interface ContentFilter {
  contentType?: string;
  mimeType?: string;
  synced?: number;
  starred?: number;
  tag?: string;
  sortBy?: 'updated' | 'created';
  limit?: number;
}

export interface ContentOptions {
  title?: string;
  content?: string;
  mimeType?: string;
  contentType?: string;
  language?: string;
  encoding?: string;
  tags?: string;
  addressRefs?: string;
  parentId?: string;
  metadata?: string;
  syncPath?: string;
  synced?: number;
  starred?: number;
  archived?: number;
}

export interface ItemOptions {
  content?: string;
  mimeType?: string;
  metadata?: string;
  syncId?: string;
  starred?: number;
  archived?: number;
  title?: string;
  favicon?: string;
  visitCount?: number;
  lastVisitAt?: number;
  frecencyScore?: number;
}

export interface ItemFilter {
  type?: ItemType;
  starred?: number;
  archived?: number;
  includeDeleted?: boolean;
  limit?: number;
  sortBy?: 'created' | 'updated' | 'frecency' | 'lastVisit' | 'visitCount';
  domain?: string;
  search?: string;
}

export interface ItemVisitFilter {
  itemId?: string;
  source?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface ItemVisitOptions {
  timestamp?: number;
  duration?: number;
  source?: string;
  sourceId?: string;
  windowType?: string;
  metadata?: string;
  scrollDepth?: number;
  interacted?: number;
}

// Event/entry record for series and feeds (item_events table)
// - For series: events are observations (value is numeric or content is text)
// - For feeds: events are entries (content is URL/URI, metadata has title/author/etc)
export interface ItemEvent {
  id: string;
  itemId: string;
  content: string | null;
  value: number | null;
  occurredAt: number;
  metadata: string;
  createdAt: number;
}

export interface ItemEventFilter {
  itemId?: string;
  itemIds?: string[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface ItemEventOptions {
  content?: string;
  value?: number;
  occurredAt?: number;
  metadata?: string;
}

// ==================== Table Names ====================

export type TableName =
  | 'content'
  | 'tags'
  | 'blobs'
  | 'scripts_data'
  | 'feeds'
  | 'extensions'
  | 'extension_settings'
  | 'migrations'
  | 'themes'
  | 'items'
  | 'item_tags'
  | 'item_visits'
  | 'item_events'
  | 'item_groups'
  | 'item_group_members'
  | 'settings';

export const tableNames: TableName[] = [
  'content',
  'tags',
  'blobs',
  'scripts_data',
  'feeds',
  'extensions',
  'extension_settings',
  'migrations',
  'themes',
  'items',
  'item_tags',
  'item_visits',
  'item_events',
  'item_groups',
  'item_group_members',
  'settings'
];

// ==================== Sync Types ====================

export interface SyncConfig {
  serverUrl: string;
  apiKey: string;
  lastSyncTime: number;
  autoSync: boolean;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  lastSyncTime: number;
}

// Server item format (ISO timestamps, different field names)
export interface ServerItem {
  id: string;
  type: ItemType;
  content: string | null;
  metadata?: Record<string, unknown> | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

// ==================== Backup Types ====================

export interface BackupConfig {
  enabled: boolean;
  backupDir: string;
  retentionCount: number;
  lastBackupTime: number;
}

export interface BackupResult {
  success: boolean;
  path?: string;
  error?: string;
}
