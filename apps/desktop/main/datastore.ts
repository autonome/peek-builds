/**
 * Electron backend - SQLite datastore
 *
 * Simple module with database functions for Electron's main process.
 * Uses better-sqlite3 for synchronous SQLite access.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  TableName,
  Content,
  Tag,
  DatastoreStats,
  ContentFilter,
  ContentOptions,
  Item,
  ItemTag,
  ItemType,
  ItemOptions,
  ItemFilter,
  ItemVisit,
  ItemVisitFilter,
  ItemVisitOptions,
  ItemEvent,
  ItemEventFilter,
  ItemEventOptions,
} from '../types/index.js';
import { tableNames } from '../types/index.js';
import { DEBUG } from './config.js';
import { DATASTORE_VERSION } from '../version.js';
import { addDeviceMetadata } from './device.js';
import { publish, getSystemAddress } from './pubsub.js';

// Load canonical schema for validation
// Path is relative to compiled JS in apps/desktop/dist/main/
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA = JSON.parse(
  readFileSync(join(__dirname, '../../../../packages/schema/v1.json'), 'utf-8')
);
const REQUIRED_SYNC_COLUMNS: Record<string, string[]> = SCHEMA.validation.required_sync_columns;

// Flag: set to true if stored datastore version > code version (downgrade detected)
let syncDisabledDueToVersionMismatch = false;

// SQL Schema
// NOTE: addresses, visits, and address_tags tables have been removed.
// Data has been migrated to items/item_visits/item_tags.
// Existing databases will have these tables dropped by dropLegacyAddressTables().
const createTableStatements = `
  CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT 'Untitled',
    content TEXT DEFAULT '',
    mimeType TEXT DEFAULT 'text/plain',
    contentType TEXT DEFAULT 'plain',
    language TEXT DEFAULT '',
    encoding TEXT DEFAULT 'utf-8',
    tags TEXT DEFAULT '',
    addressRefs TEXT DEFAULT '',
    parentId TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER,
    updatedAt INTEGER,
    syncPath TEXT DEFAULT '',
    synced INTEGER DEFAULT 0,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_content_contentType ON content(contentType);
  CREATE INDEX IF NOT EXISTS idx_content_mimeType ON content(mimeType);
  CREATE INDEX IF NOT EXISTS idx_content_synced ON content(synced);
  CREATE INDEX IF NOT EXISTS idx_content_updatedAt ON content(updatedAt);

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT,
    color TEXT DEFAULT '#999999',
    parentId TEXT DEFAULT '',
    description TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER,
    updatedAt INTEGER,
    frequency INTEGER DEFAULT 0,
    lastUsed INTEGER DEFAULT 0,
    frecencyScore INTEGER DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_unique ON tags(name);
  CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
  CREATE INDEX IF NOT EXISTS idx_tags_parentId ON tags(parentId);
  CREATE INDEX IF NOT EXISTS idx_tags_frecencyScore ON tags(frecencyScore);

  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    filename TEXT,
    mimeType TEXT,
    mediaType TEXT,
    size INTEGER,
    hash TEXT,
    extension TEXT,
    path TEXT,
    addressId TEXT DEFAULT '',
    contentId TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    duration INTEGER DEFAULT 0,
    thumbnail TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_blobs_mediaType ON blobs(mediaType);
  CREATE INDEX IF NOT EXISTS idx_blobs_mimeType ON blobs(mimeType);
  CREATE INDEX IF NOT EXISTS idx_blobs_addressId ON blobs(addressId);
  CREATE INDEX IF NOT EXISTS idx_blobs_contentId ON blobs(contentId);

  CREATE TABLE IF NOT EXISTS scripts_data (
    id TEXT PRIMARY KEY,
    scriptId TEXT,
    scriptName TEXT,
    addressId TEXT,
    selector TEXT,
    content TEXT,
    contentType TEXT DEFAULT 'text',
    metadata TEXT DEFAULT '{}',
    extractedAt INTEGER,
    previousValue TEXT DEFAULT '',
    changed INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_scripts_data_scriptId ON scripts_data(scriptId);
  CREATE INDEX IF NOT EXISTS idx_scripts_data_addressId ON scripts_data(addressId);
  CREATE INDEX IF NOT EXISTS idx_scripts_data_changed ON scripts_data(changed);

  CREATE TABLE IF NOT EXISTS feeds (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT DEFAULT '',
    type TEXT,
    query TEXT DEFAULT '',
    schedule TEXT DEFAULT '',
    source TEXT DEFAULT 'internal',
    tags TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER,
    updatedAt INTEGER,
    lastFetchedAt INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_feeds_type ON feeds(type);
  CREATE INDEX IF NOT EXISTS idx_feeds_enabled ON feeds(enabled);

  CREATE TABLE IF NOT EXISTS feature_settings (
    id TEXT PRIMARY KEY,
    featureId TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updatedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feature_settings_featureId ON feature_settings(featureId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_settings_unique ON feature_settings(featureId, key);

  CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    completedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT DEFAULT '',
    version TEXT DEFAULT '1.0.0',
    author TEXT DEFAULT '',
    path TEXT,
    builtin INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    installedAt INTEGER,
    updatedAt INTEGER,
    lastError TEXT DEFAULT '',
    lastErrorAt INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_themes_enabled ON themes(enabled);
  CREATE INDEX IF NOT EXISTS idx_themes_builtin ON themes(builtin);

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('url', 'text', 'tagset', 'image', 'series', 'feed', 'entity', 'event')),
    content TEXT,
    mimeType TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    syncId TEXT DEFAULT '',
    syncedAt INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    deletedAt INTEGER DEFAULT 0,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    visitCount INTEGER DEFAULT 0,
    lastVisitAt INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
  CREATE INDEX IF NOT EXISTS idx_items_syncId ON items(syncId);
  CREATE INDEX IF NOT EXISTS idx_items_deletedAt ON items(deletedAt);
  CREATE INDEX IF NOT EXISTS idx_items_createdAt ON items(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_items_starred ON items(starred);

  CREATE TABLE IF NOT EXISTS item_tags (
    id TEXT PRIMARY KEY,
    itemId TEXT NOT NULL,
    tagId TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_item_tags_itemId ON item_tags(itemId);
  CREATE INDEX IF NOT EXISTS idx_item_tags_tagId ON item_tags(tagId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_tags_unique ON item_tags(itemId, tagId);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS item_visits (
    id TEXT PRIMARY KEY,
    itemId TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    duration INTEGER DEFAULT 0,
    source TEXT DEFAULT 'direct',
    sourceId TEXT DEFAULT '',
    windowType TEXT DEFAULT 'main',
    metadata TEXT DEFAULT '{}',
    scrollDepth INTEGER DEFAULT 0,
    interacted INTEGER DEFAULT 0,
    prevId TEXT DEFAULT NULL,
    nextId TEXT DEFAULT NULL,
    FOREIGN KEY(itemId) REFERENCES items(id)
  );
  CREATE INDEX IF NOT EXISTS idx_item_visits_itemId ON item_visits(itemId);
  CREATE INDEX IF NOT EXISTS idx_item_visits_timestamp ON item_visits(timestamp);
  CREATE INDEX IF NOT EXISTS idx_item_visits_prevId ON item_visits(prevId);
  CREATE INDEX IF NOT EXISTS idx_item_visits_nextId ON item_visits(nextId);

  CREATE TABLE IF NOT EXISTS item_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT DEFAULT 'manual',
    query TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    deletedAt INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_item_groups_type ON item_groups(type);
  CREATE INDEX IF NOT EXISTS idx_item_groups_deletedAt ON item_groups(deletedAt);

  CREATE TABLE IF NOT EXISTS item_group_members (
    id TEXT PRIMARY KEY,
    groupId TEXT NOT NULL,
    itemId TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(groupId) REFERENCES item_groups(id),
    FOREIGN KEY(itemId) REFERENCES items(id)
  );
  CREATE INDEX IF NOT EXISTS idx_item_group_members_groupId ON item_group_members(groupId);
  CREATE INDEX IF NOT EXISTS idx_item_group_members_itemId ON item_group_members(itemId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_item_group_members_unique ON item_group_members(groupId, itemId);

  CREATE TABLE IF NOT EXISTS item_events (
    id TEXT PRIMARY KEY,
    itemId TEXT NOT NULL,
    content TEXT,
    value REAL,
    occurredAt INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(itemId) REFERENCES items(id)
  );
  CREATE INDEX IF NOT EXISTS idx_item_events_item_time ON item_events(itemId, occurredAt DESC);
  CREATE INDEX IF NOT EXISTS idx_item_events_occurred ON item_events(occurredAt DESC);

  CREATE TABLE IF NOT EXISTS features_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    featureId TEXT NOT NULL,
    event TEXT NOT NULL,
    version TEXT,
    sourceType TEXT,
    sourceUri TEXT,
    publisher TEXT,
    capabilities TEXT DEFAULT '{}',
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_features_history_feature ON features_history(featureId);
  CREATE INDEX IF NOT EXISTS idx_features_history_time ON features_history(timestamp DESC);

  -- manifest_cache: parsed manifest declarations per installed feature.
  -- Authoritative source for static declarations (commands, nouns,
  -- shortcuts, lazyEvents, capability grant) that cmd panel / shortcut
  -- registry / lazyEvents interceptor read at boot. Writes happen only
  -- at install/update time + boot-time manifest discovery. Distinct
  -- from registry.json (install metadata) — see
  -- apps/desktop/main/feature-registry.ts for that.
  -- See docs/tile-lifecycle-fsm.md.
  CREATE TABLE IF NOT EXISTS manifest_cache (
    featureId TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    manifest TEXT NOT NULL,         -- parsed manifest JSON
    commands TEXT,                  -- JSON array of declared commands
    nouns TEXT,                     -- JSON array of declared nouns (metadata only; handlers live in tile)
    shortcuts TEXT,                 -- JSON array of shortcut bindings
    capabilities TEXT,              -- resolved capability grant JSON
    lazyEvents TEXT,                -- JSON array of {topic, command} entries
    updatedAt INTEGER NOT NULL,
    disabledAt INTEGER              -- null = enabled
  );
  CREATE INDEX IF NOT EXISTS idx_manifest_cache_disabled ON manifest_cache(disabledAt);

  -- rules: declarative event-dispatch subscribers. Each row binds an
  -- event topic + match predicate to a script (executed lazily on match).
  -- Drives the rule engine that lets features participate in event
  -- pipelines without staying resident. See peek MCP plan 3d7d9239.
  -- Mirrors packages/schema/v1.json — keep the two definitions in sync (this
  -- file is hand-maintained, not generated; the generated SQL lives at
  -- packages/schema/generated/sqlite-full.sql for documentation only).
  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY NOT NULL,
    featureId TEXT NOT NULL,
    topic TEXT NOT NULL,
    match TEXT DEFAULT '{}',
    scriptId TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    display TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    source TEXT NOT NULL CHECK(source IN ('manifest', 'user', 'runtime')),
    ordering INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rules_topic ON rules(topic);
  CREATE INDEX IF NOT EXISTS idx_rules_featureId ON rules(featureId);
  CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);
  CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);

  CREATE TABLE IF NOT EXISTS lazy_wake_shortcuts (
    ownerTileId TEXT NOT NULL,
    accelerator TEXT NOT NULL,
    wakeTopic TEXT NOT NULL,
    wakeArgs TEXT DEFAULT '[]',
    PRIMARY KEY (ownerTileId, accelerator)
  );
  CREATE INDEX IF NOT EXISTS idx_lazy_wake_shortcuts_owner ON lazy_wake_shortcuts(ownerTileId);

  CREATE TABLE IF NOT EXISTS lazy_wake_declared (
    ownerTileId TEXT PRIMARY KEY
  );
`;

// Module state
let db: Database.Database | null = null;

// ==================== Schema Validation ====================

/**
 * Validate that the database has all required sync columns from the canonical schema.
 * Called after migrations to ensure schema consistency across all backends.
 */
function validateSyncSchema(): void {
  if (!db) throw new Error('Database not initialized');

  const missing: string[] = [];

  for (const [table, cols] of Object.entries(REQUIRED_SYNC_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const actual = new Set(rows.map(c => c.name));
    for (const col of cols) {
      if (!actual.has(col)) {
        missing.push(`${table}.${col}`);
      }
    }
  }

  if (missing.length > 0) {
    // Log actual schema state for debugging
    for (const table of Object.keys(REQUIRED_SYNC_COLUMNS)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all();
      console.error(`[schema] ${table} actual columns: ${(actual as { name: string }[]).map(c => c.name).join(', ')}`);
    }
    throw new Error(
      `[schema] Required sync columns missing: ${missing.join(', ')}. ` +
      `Database may need migration. See packages/schema/v1.json for canonical schema.`
    );
  }

  DEBUG && console.log('main', 'schema validation passed');
}

// ==================== Lifecycle ====================

export function initDatabase(dbPath: string): Database.Database {
  DEBUG && console.log('main', 'initializing database at:', dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(createTableStatements);

  migrateTinyBaseData();
  migrateSyncColumns();
  migrateItemTypes();
  migrateItemVisitColumns();
  migrateAddressesToItems();
  migrateVisitChaining();
  migrateDeduplicateItems();
  migrateItemFrecencyColumns();
  migrateAllAddressesToItems();
  migrateVisitsToItemVisits();
  migrateTagsLastUsedColumn();
  migrateContextHistory();
  migrateEntityType();
  migrateEventType();
  migrateLoadingTitles();
  migrateStandalonePriceEntities();
  migrateStandaloneDateEntities();
  migrateNoisyDateEntities();
  migrateUnformattedPhoneEntities();
  migrateLowQualityEntities();
  migrateInvalidPersonEntities();
  migrateInvalidPlaceEntities();
  migrateTagNavigationHistory();
  migrateExtensionSettingsToFeatureSettings();
  migrateItemThumbnailColumn();
  migrateTagsUniqueIndex();
  dropLegacyAddressTables();

  // Validate schema against canonical definition
  validateSyncSchema();

  // Check and write datastore version
  checkAndWriteDatastoreVersion();

  DEBUG && console.log('main', 'database initialized successfully');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    DEBUG && console.log('main', 'database closed');
  }
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

// ==================== Helpers ====================

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function now(): number {
  return Date.now();
}

export function parseUrl(uri: string): { protocol: string; domain: string; path: string } {
  try {
    const url = new URL(uri);
    return {
      protocol: url.protocol.replace(':', ''),
      domain: url.hostname,
      path: url.pathname + url.search + url.hash,
    };
  } catch {
    return {
      protocol: 'unknown',
      domain: uri,
      path: '',
    };
  }
}

export function normalizeUrl(uri: string): string {
  if (!uri) return uri;

  try {
    const url = new URL(uri);

    // Remove trailing slash from path (except for root)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // Remove default ports
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }

    // Sort query parameters for consistency
    if (url.search) {
      const params = new URLSearchParams(url.search);
      const sortedParams = new URLSearchParams([...params.entries()].sort());
      url.search = sortedParams.toString();
    }

    return url.toString();
  } catch {
    return uri;
  }
}

export function isValidTable(tableName: string): tableName is TableName {
  return (tableNames as readonly string[]).includes(tableName);
}

export function calculateFrecency(frequency: number, lastUsed: number): number {
  const currentTime = Date.now();
  const daysSinceUse = (currentTime - lastUsed) / (1000 * 60 * 60 * 24);
  const decayFactor = 1 / (1 + daysSinceUse / 7);
  return Math.round(frequency * 10 * decayFactor);
}

// ==================== Migration ====================

function migrateTinyBaseData(): void {
  if (!db) return;

  // Check if tinybase table exists
  const tinybaseExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tinybase'`)
    .get();

  if (!tinybaseExists) {
    return;
  }

  // Check if addresses table exists (may not exist if user never had the old schema)
  const addressesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'`).get();
  if (!addressesExists) {
    return;
  }

  // Check if we already migrated
  const existingData = db.prepare('SELECT COUNT(*) as count FROM addresses').get() as { count: number };
  if (existingData.count > 0) {
    DEBUG && console.log('main', 'TinyBase data already migrated, skipping');
    return;
  }

  DEBUG && console.log('main', 'Migrating TinyBase data to direct tables...');

  try {
    const tinybaseRow = db.prepare('SELECT * FROM tinybase').get() as Record<string, unknown> | undefined;
    if (!tinybaseRow) {
      DEBUG && console.log('main', 'No TinyBase data found');
      return;
    }

    const rawData = Object.values(tinybaseRow)[1] as string;
    if (!rawData) {
      DEBUG && console.log('main', 'TinyBase data is empty');
      return;
    }

    const [tables] = JSON.parse(rawData) as [Record<string, Record<string, Record<string, unknown>>>];
    if (!tables) {
      DEBUG && console.log('main', 'No tables in TinyBase data');
      return;
    }

    const tablesToMigrate = [
      'addresses', 'visits', 'tags', 'address_tags', 'feature_settings',
      'extensions', 'content', 'blobs', 'scripts_data', 'feeds',
    ];

    for (const tableName of tablesToMigrate) {
      const tableData = tables[tableName];
      if (!tableData || typeof tableData !== 'object') continue;

      const entries = Object.entries(tableData);
      if (entries.length === 0) continue;

      DEBUG && console.log('main', `  Migrating ${entries.length} rows from ${tableName}`);

      for (const [id, row] of entries) {
        try {
          const fullRow = { id, ...row } as Record<string, unknown>;
          const columns = Object.keys(fullRow);
          const placeholders = columns.map(() => '?').join(', ');
          const values = columns.map((col) => fullRow[col]);

          db.prepare(
            `INSERT OR IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`
          ).run(...values);
        } catch (err) {
          console.error('main', `  Error migrating row ${id} in ${tableName}:`, (err as Error).message);
        }
      }
    }

    db.exec('DROP TABLE IF EXISTS tinybase');
    DEBUG && console.log('main', 'TinyBase migration complete, removed tinybase table');
  } catch (error) {
    console.error('main', 'TinyBase migration failed:', (error as Error).message);
  }
}

/**
 * Add sync columns to existing tables for cross-device sync support
 */
function migrateSyncColumns(): void {
  if (!db) return;

  const tablesToMigrate = ['content', 'tags', 'items'];

  for (const table of tablesToMigrate) {
    // Check if syncId column already exists
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const hasSyncId = columns.some(col => col.name === 'syncId');

    if (!hasSyncId) {
      DEBUG && console.log('main', `Adding sync columns to ${table}`);
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN syncId TEXT DEFAULT ''`);
      } catch (error) {
        // Column might already exist in some edge cases
        DEBUG && console.log('main', `Sync columns migration for ${table}:`, (error as Error).message);
      }
    }
  }
}

/**
 * Helper to detect if content looks like a URL
 */
function isUrlLike(content: string | null): boolean {
  if (!content) return false;
  try {
    const url = new URL(content);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Migrate item types from old 'note' to new 'url'/'text' types
 * Also adds syncedAt column if missing and ensures CHECK constraint includes 'url'
 */
function migrateItemTypes(): void {
  if (!db) return;

  // Check if items table exists
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='items'`
  ).get();

  if (!tableExists) return;

  // Check columns and constraint
  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  const hasSyncedAt = columns.some(col => col.name === 'syncedAt');

  // Add syncedAt column if missing
  if (!hasSyncedAt) {
    DEBUG && console.log('main', 'Adding syncedAt column to items table');
    try {
      db.exec(`ALTER TABLE items ADD COLUMN syncedAt INTEGER DEFAULT 0`);
    } catch (error) {
      DEBUG && console.log('main', `syncedAt column migration:`, (error as Error).message);
    }
  }

  // Check if CHECK constraint allows 'url' type by looking at the table schema
  const tableSchema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='items'`
  ).get() as { sql: string } | undefined;

  const needsConstraintUpdate = tableSchema && !tableSchema.sql.includes("'url'");

  // Check if we have any 'note' type items that need migration
  const noteItems = db.prepare(`SELECT id, content FROM items WHERE type = 'note'`).all() as { id: string; content: string | null }[];

  // Recreate table if CHECK constraint needs update OR if there are 'note' items
  if (needsConstraintUpdate || noteItems.length > 0) {
    DEBUG && console.log('main', `Migrating items table: constraint update=${needsConstraintUpdate}, note items=${noteItems.length}`);

    // Disable FK enforcement during table recreation — other tables
    // (item_visits, item_group_members, item_events) reference items(id)
    // and DROP TABLE would fail with FOREIGN KEY constraint errors.
    db.pragma('foreign_keys = OFF');

    try {
      // Clean up any leftover temp table from a previous failed migration attempt
      db.exec(`DROP TABLE IF EXISTS items_new`);

      // SQLite doesn't allow modifying CHECK constraints, so we need to recreate the table
      db.exec(`
        CREATE TABLE IF NOT EXISTS items_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('url', 'text', 'tagset', 'image', 'series', 'feed', 'entity')),
          content TEXT,
          mimeType TEXT DEFAULT '',
          metadata TEXT DEFAULT '{}',
          syncId TEXT DEFAULT '',
          syncedAt INTEGER DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          deletedAt INTEGER DEFAULT 0,
          starred INTEGER DEFAULT 0,
          archived INTEGER DEFAULT 0,
          visitCount INTEGER DEFAULT 0,
          lastVisitAt INTEGER DEFAULT 0
        )
      `);

      // Copy data, converting 'note' type
      const allItems = db.prepare(`SELECT * FROM items`).all() as Array<Record<string, unknown>>;
      const insertStmt = db.prepare(`
        INSERT INTO items_new (id, type, content, mimeType, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt, starred, archived, visitCount, lastVisitAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of allItems) {
        let newType = item.type as string;
        if (newType === 'note') {
          newType = isUrlLike(item.content as string | null) ? 'url' : 'text';
        }
        insertStmt.run(
          item.id,
          newType,
          item.content,
          item.mimeType || '',
          item.metadata || '{}',
          item.syncId || '',
          item.syncedAt || 0,
          item.createdAt,
          item.updatedAt,
          item.deletedAt || 0,
          item.starred || 0,
          item.archived || 0,
          item.visitCount || 0,
          item.lastVisitAt || 0
        );
      }

      db.exec(`DROP TABLE items`);
      db.exec(`ALTER TABLE items_new RENAME TO items`);

      // Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
        CREATE INDEX IF NOT EXISTS idx_items_syncId ON items(syncId);
        CREATE INDEX IF NOT EXISTS idx_items_deletedAt ON items(deletedAt);
        CREATE INDEX IF NOT EXISTS idx_items_createdAt ON items(createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_items_starred ON items(starred);
        CREATE INDEX IF NOT EXISTS idx_items_lastVisitAt ON items(lastVisitAt);
        CREATE INDEX IF NOT EXISTS idx_items_visitCount ON items(visitCount);
      `);

      DEBUG && console.log('main', 'Items table migration complete');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

/**
 * Add visit tracking columns to items table for existing databases
 */
function migrateItemVisitColumns(): void {
  if (!db) return;

  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  const hasVisitCount = columns.some(col => col.name === 'visitCount');

  if (!hasVisitCount) {
    DEBUG && console.log('main', 'Adding visit columns to items table');
    try {
      db.exec(`ALTER TABLE items ADD COLUMN visitCount INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE items ADD COLUMN lastVisitAt INTEGER DEFAULT 0`);
    } catch (error) {
      DEBUG && console.log('main', `Visit columns migration for items:`, (error as Error).message);
    }
  }

  // Always ensure indexes exist (handles both new and migrated tables)
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_lastVisitAt ON items(lastVisitAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_visitCount ON items(visitCount)`);
  } catch (error) {
    DEBUG && console.log('main', `Visit indexes for items:`, (error as Error).message);
  }
}

// Legacy types used only by migration functions (tables are dropped after migration)
interface LegacyAddress {
  id: string; uri: string; protocol: string; domain: string; path: string;
  title: string; mimeType: string; favicon: string; description: string;
  tags: string; metadata: string; createdAt: number; updatedAt: number;
  lastVisitAt: number; visitCount: number; starred: number; archived: number;
}
interface LegacyVisit {
  id: string; addressId: string; timestamp: number; duration: number;
  source: string; sourceId: string; windowType: string; metadata: string;
  scrollDepth: number; interacted: number; prevId: string | null; nextId: string | null;
}
interface LegacyAddressTag {
  id: string; addressId: string; tagId: string; createdAt: number;
}

/**
 * Migrate tagged addresses from addresses/address_tags to items/item_tags
 * This ensures old tagged data is visible in the new Tags UI
 */
function migrateAddressesToItems(): void {
  if (!db) return;

  const MIGRATION_ID = 'addresses_to_items_v1';

  // Check if already migrated
  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') {
    DEBUG && console.log('main', 'Addresses to items migration already complete');
    return;
  }

  // Skip if legacy tables don't exist (fresh install)
  const addressesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'`).get();
  if (!addressesExists) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    return;
  }

  // Get all addresses that have tags
  const taggedAddresses = db.prepare(`
    SELECT DISTINCT a.* FROM addresses a
    INNER JOIN address_tags at ON a.id = at.addressId
  `).all() as LegacyAddress[];

  if (taggedAddresses.length === 0) {
    // Mark as complete even if no data to migrate
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    DEBUG && console.log('main', 'No tagged addresses to migrate');
    return;
  }

  DEBUG && console.log('main', `Migrating ${taggedAddresses.length} tagged addresses to items table`);

  let migratedCount = 0;

  for (const addr of taggedAddresses) {
    // Check if item with this URL already exists
    const existingItem = db.prepare('SELECT * FROM items WHERE type = ? AND content = ? AND deletedAt = 0').get('url', addr.uri) as Item | undefined;

    let itemId: string;

    if (existingItem) {
      // Use existing item
      itemId = existingItem.id;
    } else {
      // Create new item for this URL
      itemId = generateId('item');
      const timestamp = now();

      // Build metadata from address
      const metadata: Record<string, unknown> = {};
      if (addr.title) metadata.title = addr.title;
      if (addr.description) metadata.description = addr.description;
      if (addr.favicon) metadata.favicon = addr.favicon;
      if (addr.metadata) {
        try {
          const addrMeta = typeof addr.metadata === 'string' ? JSON.parse(addr.metadata) : addr.metadata;
          Object.assign(metadata, addrMeta);
        } catch {
          // Ignore invalid JSON
        }
      }

      db.prepare(`
        INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt, deletedAt, starred, archived, visitCount, lastVisitAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        itemId,
        'url',
        addr.uri,
        addr.mimeType || 'text/html',
        JSON.stringify(metadata),
        '',
        addr.createdAt || timestamp,
        addr.updatedAt || timestamp,
        addr.starred || 0,
        addr.archived || 0,
        addr.visitCount || 0,
        addr.lastVisitAt || 0
      );

      migratedCount++;
    }

    // Copy tag associations
    const addrTags = db.prepare('SELECT * FROM address_tags WHERE addressId = ?').all(addr.id) as LegacyAddressTag[];

    for (const at of addrTags) {
      // Check if item-tag link already exists
      const existingLink = db.prepare('SELECT * FROM item_tags WHERE itemId = ? AND tagId = ?').get(itemId, at.tagId);
      if (!existingLink) {
        const linkId = generateId('item_tag');
        db.prepare('INSERT INTO item_tags (id, itemId, tagId, createdAt) VALUES (?, ?, ?, ?)').run(
          linkId,
          itemId,
          at.tagId,
          at.createdAt || now()
        );
      }
    }
  }

  // Mark migration as complete
  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  DEBUG && console.log('main', `Migrated ${migratedCount} addresses to items, copied tag associations`);
}

/**
 * Add prevId/nextId columns to visits table for history chaining
 */
function migrateVisitChaining(): void {
  if (!db) return;

  // Skip if legacy visits table doesn't exist (fresh install)
  const visitsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='visits'`).get();
  if (!visitsExists) return;

  const columns = db.prepare(`PRAGMA table_info(visits)`).all() as { name: string }[];
  const hasPrevId = columns.some(col => col.name === 'prevId');

  if (!hasPrevId) {
    DEBUG && console.log('main', 'Adding chaining columns to visits table');
    try {
      db.exec(`ALTER TABLE visits ADD COLUMN prevId TEXT DEFAULT NULL`);
      db.exec(`ALTER TABLE visits ADD COLUMN nextId TEXT DEFAULT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_prevId ON visits(prevId)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_nextId ON visits(nextId)`);

      // Backfill existing visits with chaining
      const visits = db.prepare('SELECT id FROM visits ORDER BY timestamp ASC').all() as { id: string }[];
      if (visits.length > 1) {
        const updatePrev = db.prepare('UPDATE visits SET prevId = ? WHERE id = ?');
        const updateNext = db.prepare('UPDATE visits SET nextId = ? WHERE id = ?');
        const backfill = db.transaction(() => {
          for (let i = 1; i < visits.length; i++) {
            updatePrev.run(visits[i - 1].id, visits[i].id);
            updateNext.run(visits[i].id, visits[i - 1].id);
          }
        });
        backfill();
        DEBUG && console.log('main', `Backfilled chaining for ${visits.length} visits`);
      }
    } catch (error) {
      DEBUG && console.log('main', `Visit chaining migration:`, (error as Error).message);
    }
  }

  // Ensure indexes exist even if columns were added previously
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_prevId ON visits(prevId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_nextId ON visits(nextId)`);
  } catch (error) {
    DEBUG && console.log('main', `Visit chaining indexes:`, (error as Error).message);
  }
}

/**
 * One-time deduplication of items.
 * Removes duplicate url/text items (same type+content) and duplicate tagsets (same sorted tag names).
 * Keeps the item with the most recent updatedAt; prefers items with a syncId.
 */
function migrateDeduplicateItems(): void {
  if (!db) return;

  // Check if already done
  const flag = db.prepare('SELECT value FROM settings WHERE key = ?').get('dedup_cleanup_v1') as { value: string } | undefined;
  if (flag) return;

  DEBUG && console.log('main', 'Running one-time dedup cleanup...');
  let totalRemoved = 0;

  // --- Deduplicate url/text items by (type, content) ---
  const dupGroups = db.prepare(`
    SELECT type, content, COUNT(*) as cnt
    FROM items
    WHERE deletedAt = 0 AND type IN ('url', 'text') AND content IS NOT NULL AND content != ''
    GROUP BY type, content
    HAVING cnt > 1
  `).all() as { type: string; content: string; cnt: number }[];

  for (const group of dupGroups) {
    const items = db.prepare(`
      SELECT id, syncId, updatedAt
      FROM items
      WHERE type = ? AND content = ? AND deletedAt = 0
      ORDER BY
        CASE WHEN syncId IS NOT NULL AND syncId != '' THEN 0 ELSE 1 END,
        updatedAt DESC
    `).all(group.type, group.content) as { id: string; syncId: string; updatedAt: number }[];

    for (let i = 1; i < items.length; i++) {
      db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(items[i].id);
      db.prepare('DELETE FROM items WHERE id = ?').run(items[i].id);
      totalRemoved++;
    }
  }

  // --- Deduplicate tagsets by sorted tag names ---
  const tagsets = db.prepare(`
    SELECT id, syncId, updatedAt
    FROM items
    WHERE type = 'tagset' AND deletedAt = 0
  `).all() as { id: string; syncId: string; updatedAt: number }[];

  const tagsetGroups = new Map<string, { id: string; syncId: string; updatedAt: number }[]>();
  for (const ts of tagsets) {
    const tagNames = (db.prepare(`
      SELECT t.name FROM tags t
      JOIN item_tags it ON t.id = it.tagId
      WHERE it.itemId = ?
      ORDER BY t.name
    `).all(ts.id) as { name: string }[]).map(t => t.name).join('\0');

    if (!tagsetGroups.has(tagNames)) {
      tagsetGroups.set(tagNames, []);
    }
    tagsetGroups.get(tagNames)!.push(ts);
  }

  for (const [, items] of tagsetGroups) {
    if (items.length <= 1) continue;

    items.sort((a, b) => {
      const aHasSync = a.syncId && a.syncId !== '' ? 0 : 1;
      const bHasSync = b.syncId && b.syncId !== '' ? 0 : 1;
      if (aHasSync !== bHasSync) return aHasSync - bHasSync;
      return b.updatedAt - a.updatedAt;
    });

    for (let i = 1; i < items.length; i++) {
      db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(items[i].id);
      db.prepare('DELETE FROM items WHERE id = ?').run(items[i].id);
      totalRemoved++;
    }
  }

  // Set flag so this doesn't run again
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('dedup_cleanup_v1', '1');

  if (totalRemoved > 0) {
    console.log(`[dedup] Removed ${totalRemoved} duplicate items`);
  } else {
    DEBUG && console.log('main', 'Dedup cleanup: no duplicates found');
  }
}

/**
 * Add frecencyScore, title, domain, favicon columns to items table for URL history unification.
 * These columns are local-only (not synced) and support frecency-based sorting.
 */
function migrateItemFrecencyColumns(): void {
  if (!db) return;

  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  const hasFrecencyScore = columns.some(col => col.name === 'frecencyScore');

  if (!hasFrecencyScore) {
    DEBUG && console.log('main', 'Adding frecency columns to items table');
    try {
      db.exec(`ALTER TABLE items ADD COLUMN frecencyScore INTEGER DEFAULT 0`);
      db.exec(`ALTER TABLE items ADD COLUMN title TEXT DEFAULT ''`);
      db.exec(`ALTER TABLE items ADD COLUMN domain TEXT DEFAULT ''`);
      db.exec(`ALTER TABLE items ADD COLUMN favicon TEXT DEFAULT ''`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_frecencyScore ON items(frecencyScore DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_domain ON items(domain)`);
    } catch (error) {
      DEBUG && console.log('main', `Item frecency columns migration:`, (error as Error).message);
    }
  }

  // Always ensure indexes exist
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_frecencyScore ON items(frecencyScore DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_domain ON items(domain)`);
  } catch (error) {
    DEBUG && console.log('main', `Item frecency indexes:`, (error as Error).message);
  }
}

/**
 * Calculate frecency score for an item based on visit history.
 * Uses a time-decay algorithm where recent visits contribute more.
 * NOTE: Shared copy lives in app/lib/frecency.js for frontend/Tauri use.
 */
/**
 * Visit source weights. "typed" = user typed URL (strongest intent).
 * "direct" treated as typed for backwards compat.
 */
const VISIT_WEIGHTS: Record<string, number> = {
  interacted: 2,
  typed: 3,
  bookmark: 1.5,
  direct: 3,
  default: 1
};

export function calculateItemFrecency(visits: Array<{ timestamp: number; interacted: number; source: string }>, totalVisitCount?: number): number {
  const SAMPLE_CAP = 20;
  const GRACE_PERIOD_DAYS = 3;
  const HALF_LIFE = 7;

  const sample = visits.length > SAMPLE_CAP ? visits.slice(0, SAMPLE_CAP) : visits;
  const total = totalVisitCount || visits.length;

  let score = 0;
  for (const visit of sample) {
    const rawAgeDays = (Date.now() - visit.timestamp) / (1000 * 60 * 60 * 24);
    const ageDays = Math.max(0, rawAgeDays - GRACE_PERIOD_DAYS);
    const decay = 1 / (1 + Math.pow(ageDays / HALF_LIFE, 0.5));
    const weight = visit.interacted ? VISIT_WEIGHTS.interacted : (VISIT_WEIGHTS[visit.source] || VISIT_WEIGHTS.default);
    score += weight * decay;
  }

  if (sample.length < total && sample.length > 0) {
    score = score * total / sample.length;
  }

  return Math.round(score * 10);
}

/**
 * Migrate ALL addresses to items (not just tagged ones).
 * This extends the earlier migrateAddressesToItems() which only migrated tagged addresses.
 * Creates items for all addresses and tracks address.id → item.id mapping for visit migration.
 */
function migrateAllAddressesToItems(): void {
  if (!db) return;

  const MIGRATION_ID = 'all_addresses_to_items_v1';

  // Check if already migrated
  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') {
    DEBUG && console.log('main', 'All addresses to items migration already complete');
    return;
  }

  // Skip if legacy tables don't exist (fresh install)
  const addressesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'`).get();
  if (!addressesExists) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    return;
  }

  // Get ALL addresses (not just tagged ones)
  const allAddresses = db.prepare('SELECT * FROM addresses').all() as LegacyAddress[];

  if (allAddresses.length === 0) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    DEBUG && console.log('main', 'No addresses to migrate');
    return;
  }

  DEBUG && console.log('main', `Migrating ${allAddresses.length} addresses to items table`);

  let createdCount = 0;
  let mergedCount = 0;

  // Build address.id → item.id mapping for visit migration
  const addressToItemMap: Record<string, string> = {};

  for (const addr of allAddresses) {
    // Check if item with this URL already exists
    const existingItem = db.prepare('SELECT * FROM items WHERE type = ? AND content = ? AND deletedAt = 0').get('url', addr.uri) as Item | undefined;

    if (existingItem) {
      // Map to existing item, merge metadata
      addressToItemMap[addr.id] = existingItem.id;

      // Merge metadata: combine address metadata with item metadata
      let itemMeta: Record<string, unknown> = {};
      try {
        itemMeta = typeof existingItem.metadata === 'string' ? JSON.parse(existingItem.metadata) : existingItem.metadata || {};
      } catch { /* ignore */ }

      // Update with address data if item is missing it
      const updates: string[] = [];
      const values: unknown[] = [];

      if (!itemMeta.title && addr.title) {
        itemMeta.title = addr.title;
      }
      if (!itemMeta.favicon && addr.favicon) {
        itemMeta.favicon = addr.favicon;
      }

      // Also set the denormalized columns
      if (addr.title) {
        updates.push('title = ?');
        values.push(addr.title);
      }
      if (addr.domain) {
        updates.push('domain = ?');
        values.push(addr.domain);
      }
      if (addr.favicon) {
        updates.push('favicon = ?');
        values.push(addr.favicon);
      }

      // Merge visit stats (take max)
      if ((addr.visitCount || 0) > (existingItem.visitCount || 0)) {
        updates.push('visitCount = ?');
        values.push(addr.visitCount);
      }
      if ((addr.lastVisitAt || 0) > (existingItem.lastVisitAt || 0)) {
        updates.push('lastVisitAt = ?');
        values.push(addr.lastVisitAt);
      }
      if (addr.starred && !existingItem.starred) {
        updates.push('starred = ?');
        values.push(1);
      }

      if (updates.length > 0) {
        updates.push('metadata = ?');
        values.push(JSON.stringify(itemMeta));
        updates.push('updatedAt = ?');
        values.push(now());
        values.push(existingItem.id);

        db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      mergedCount++;
    } else {
      // Create new item for this URL
      const itemId = generateId('item');
      const timestamp = now();
      addressToItemMap[addr.id] = itemId;

      // Build metadata from address
      const metadata: Record<string, unknown> = {};
      if (addr.title) metadata.title = addr.title;
      if (addr.description) metadata.description = addr.description;
      if (addr.favicon) metadata.favicon = addr.favicon;
      if (addr.metadata) {
        try {
          const addrMeta = typeof addr.metadata === 'string' ? JSON.parse(addr.metadata) : addr.metadata;
          Object.assign(metadata, addrMeta);
        } catch { /* ignore invalid JSON */ }
      }

      db.prepare(`
        INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt, deletedAt, starred, archived, visitCount, lastVisitAt, frecencyScore, title, domain, favicon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        itemId,
        'url',
        addr.uri,
        addr.mimeType || 'text/html',
        JSON.stringify(metadata),
        '',
        addr.createdAt || timestamp,
        addr.updatedAt || timestamp,
        addr.starred || 0,
        addr.archived || 0,
        addr.visitCount || 0,
        addr.lastVisitAt || 0,
        addr.title || '',
        addr.domain || '',
        addr.favicon || ''
      );

      createdCount++;

      // Copy tag associations from address_tags to item_tags
      const addrTags = db.prepare('SELECT * FROM address_tags WHERE addressId = ?').all(addr.id) as LegacyAddressTag[];
      for (const at of addrTags) {
        const existingLink = db.prepare('SELECT * FROM item_tags WHERE itemId = ? AND tagId = ?').get(itemId, at.tagId);
        if (!existingLink) {
          const linkId = generateId('item_tag');
          db.prepare('INSERT INTO item_tags (id, itemId, tagId, createdAt) VALUES (?, ?, ?, ?)').run(
            linkId,
            itemId,
            at.tagId,
            at.createdAt || now()
          );
        }
      }
    }
  }

  // Store the mapping for visit migration
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('address_to_item_map', JSON.stringify(addressToItemMap));

  // Mark migration as complete
  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  DEBUG && console.log('main', `Migrated addresses to items: ${createdCount} created, ${mergedCount} merged`);
}

/**
 * Migrate visits from visits table to item_visits table.
 * Uses the address_to_item_map created by migrateAllAddressesToItems().
 * Preserves visit chaining (prevId/nextId).
 */
function migrateVisitsToItemVisits(): void {
  if (!db) return;

  const MIGRATION_ID = 'visits_to_item_visits_v1';

  // Check if already migrated
  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') {
    DEBUG && console.log('main', 'Visits to item_visits migration already complete');
    return;
  }

  // Skip if legacy tables don't exist (fresh install)
  const visitsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='visits'`).get();
  if (!visitsExists) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    return;
  }

  // Load address → item mapping
  const mapRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('address_to_item_map') as { value: string } | undefined;
  if (!mapRow) {
    DEBUG && console.log('main', 'No address_to_item_map found, skipping visit migration');
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    return;
  }

  const addressToItemMap: Record<string, string> = JSON.parse(mapRow.value);

  // Get all visits
  const allVisits = db.prepare('SELECT * FROM visits ORDER BY timestamp ASC').all() as LegacyVisit[];

  if (allVisits.length === 0) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    DEBUG && console.log('main', 'No visits to migrate');
    return;
  }

  DEBUG && console.log('main', `Migrating ${allVisits.length} visits to item_visits table`);

  // Build old visit.id → new item_visit.id mapping for chaining
  const visitIdMap: Record<string, string> = {};
  let migratedCount = 0;
  let skippedCount = 0;

  // First pass: create all item_visits without chaining
  for (const visit of allVisits) {
    const itemId = addressToItemMap[visit.addressId];
    if (!itemId) {
      // Address wasn't migrated (shouldn't happen, but handle gracefully)
      skippedCount++;
      continue;
    }

    // Check if this visit was already migrated
    const existingItemVisit = db.prepare('SELECT id FROM item_visits WHERE timestamp = ? AND itemId = ?').get(visit.timestamp, itemId);
    if (existingItemVisit) {
      visitIdMap[visit.id] = (existingItemVisit as { id: string }).id;
      continue;
    }

    const itemVisitId = generateId('item_visit');
    visitIdMap[visit.id] = itemVisitId;

    db.prepare(`
      INSERT INTO item_visits (id, itemId, timestamp, duration, source, sourceId, windowType, metadata, scrollDepth, interacted, prevId, nextId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      itemVisitId,
      itemId,
      visit.timestamp,
      visit.duration || 0,
      visit.source || 'direct',
      visit.sourceId || '',
      visit.windowType || 'main',
      visit.metadata || '{}',
      visit.scrollDepth || 0,
      visit.interacted || 0
    );

    migratedCount++;
  }

  // Second pass: update chaining (prevId/nextId)
  for (const visit of allVisits) {
    const newVisitId = visitIdMap[visit.id];
    if (!newVisitId) continue;

    const newPrevId = visit.prevId ? visitIdMap[visit.prevId] : null;
    const newNextId = visit.nextId ? visitIdMap[visit.nextId] : null;

    if (newPrevId || newNextId) {
      db.prepare('UPDATE item_visits SET prevId = ?, nextId = ? WHERE id = ?').run(
        newPrevId || null,
        newNextId || null,
        newVisitId
      );
    }
  }

  // Calculate initial frecency scores for all URL items
  const urlItems = db.prepare('SELECT id FROM items WHERE type = ? AND deletedAt = 0').all('url') as { id: string }[];
  for (const item of urlItems) {
    const visits = db.prepare('SELECT timestamp, interacted, source FROM item_visits WHERE itemId = ?').all(item.id) as Array<{ timestamp: number; interacted: number; source: string }>;
    const frecencyScore = calculateItemFrecency(visits);
    db.prepare('UPDATE items SET frecencyScore = ? WHERE id = ?').run(frecencyScore, item.id);
  }

  // Mark migration as complete
  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  DEBUG && console.log('main', `Migrated ${migratedCount} visits to item_visits, skipped ${skippedCount}, calculated frecency for ${urlItems.length} items`);
}

/**
 * Rename lastUsedAt column to lastUsed in tags table for schema consistency.
 * Some databases may have been created with lastUsedAt instead of lastUsed.
 */
function migrateTagsLastUsedColumn(): void {
  if (!db) return;

  // Check if tags table has lastUsedAt column (old name)
  const columns = db.prepare(`PRAGMA table_info(tags)`).all() as { name: string }[];
  const hasLastUsedAt = columns.some(col => col.name === 'lastUsedAt');
  const hasLastUsed = columns.some(col => col.name === 'lastUsed');

  if (hasLastUsedAt && !hasLastUsed) {
    DEBUG && console.log('main', 'Renaming tags.lastUsedAt to tags.lastUsed');
    try {
      // SQLite 3.25.0+ supports ALTER TABLE RENAME COLUMN
      db.exec(`ALTER TABLE tags RENAME COLUMN lastUsedAt TO lastUsed`);
      DEBUG && console.log('main', 'Successfully renamed lastUsedAt to lastUsed');
    } catch (error) {
      // Fallback: create new column and copy data (for older SQLite versions)
      DEBUG && console.log('main', 'Rename failed, trying fallback migration:', (error as Error).message);
      try {
        db.exec(`ALTER TABLE tags ADD COLUMN lastUsed INTEGER DEFAULT 0`);
        db.exec(`UPDATE tags SET lastUsed = lastUsedAt`);
        DEBUG && console.log('main', 'Fallback migration complete (lastUsedAt data copied to lastUsed)');
      } catch (fallbackError) {
        DEBUG && console.log('main', 'Fallback migration failed:', (fallbackError as Error).message);
      }
    }
  } else if (!hasLastUsed) {
    // Neither column exists, add lastUsed
    DEBUG && console.log('main', 'Adding missing lastUsed column to tags');
    try {
      db.exec(`ALTER TABLE tags ADD COLUMN lastUsed INTEGER DEFAULT 0`);
    } catch (error) {
      DEBUG && console.log('main', 'Failed to add lastUsed column:', (error as Error).message);
    }
  }
}

// ==================== Context History Migration ====================

/**
 * Migrate: Create context_history table for storing context changes
 * This table enables time-series visualization and correlation with visits
 */
function migrateContextHistory(): void {
  if (!db) return;

  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='context_history'`).all();
  if (tables.length === 0) {
    DEBUG && console.log('main', 'Creating context_history table');
    db.exec(`
      CREATE TABLE context_history (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT,
        metadata TEXT DEFAULT '{}',
        windowId INTEGER,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        prevEntryId TEXT DEFAULT NULL
      );
      CREATE INDEX idx_context_history_key ON context_history(key);
      CREATE INDEX idx_context_history_timestamp ON context_history(timestamp);
      CREATE INDEX idx_context_history_key_timestamp ON context_history(key, timestamp);
      CREATE INDEX idx_context_history_windowId ON context_history(windowId);
    `);
    DEBUG && console.log('main', 'context_history table created');
  }
}

/**
 * Add 'entity' to items type CHECK constraint for existing databases.
 * Also creates indexes for entity queries (entity type, wikidata QID, event source URL).
 */
function migrateEntityType(): void {
  if (!db) return;

  // Check if items table exists
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='items'`
  ).get();
  if (!tableExists) return;

  // Check if CHECK constraint already includes 'entity'
  const tableSchema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='items'`
  ).get() as { sql: string } | undefined;

  if (!tableSchema) return;

  const needsConstraintUpdate = !tableSchema.sql.includes("'entity'");

  if (needsConstraintUpdate) {
    DEBUG && console.log('main', 'Adding entity type to items CHECK constraint');

    // Get current columns to build the new table
    const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
    const columnNames = columns.map(c => c.name);

    // Disable FK enforcement during table recreation — other tables
    // (item_visits, item_group_members, item_events) reference items(id)
    // and DROP TABLE would fail with FOREIGN KEY constraint errors.
    db.pragma('foreign_keys = OFF');

    try {
      // Clean up any leftover temp table from a previous failed migration attempt
      db.exec(`DROP TABLE IF EXISTS items_entity_mig`);

      // Recreate table with updated CHECK constraint
      db.exec(`
        CREATE TABLE IF NOT EXISTS items_entity_mig (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('url', 'text', 'tagset', 'image', 'series', 'feed', 'entity')),
          content TEXT,
          mimeType TEXT DEFAULT '',
          metadata TEXT DEFAULT '{}',
          syncId TEXT DEFAULT '',
          syncedAt INTEGER DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          deletedAt INTEGER DEFAULT 0,
          starred INTEGER DEFAULT 0,
          archived INTEGER DEFAULT 0,
          visitCount INTEGER DEFAULT 0,
          lastVisitAt INTEGER DEFAULT 0,
          frecencyScore INTEGER DEFAULT 0,
          title TEXT DEFAULT '',
          domain TEXT DEFAULT '',
          favicon TEXT DEFAULT ''
        )
      `);

      // Build column list for INSERT - only include columns that exist in both tables
      const migColumns = ['id', 'type', 'content', 'mimeType', 'metadata', 'syncId', 'syncedAt',
        'createdAt', 'updatedAt', 'deletedAt', 'starred', 'archived', 'visitCount', 'lastVisitAt',
        'frecencyScore', 'title', 'domain', 'favicon'];
      const existingCols = migColumns.filter(c => columnNames.includes(c));
      const colList = existingCols.join(', ');

      db.exec(`INSERT INTO items_entity_mig (${colList}) SELECT ${colList} FROM items`);
      db.exec(`DROP TABLE items`);
      db.exec(`ALTER TABLE items_entity_mig RENAME TO items`);

      // Recreate standard indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
        CREATE INDEX IF NOT EXISTS idx_items_syncId ON items(syncId);
        CREATE INDEX IF NOT EXISTS idx_items_deletedAt ON items(deletedAt);
        CREATE INDEX IF NOT EXISTS idx_items_createdAt ON items(createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_items_starred ON items(starred);
        CREATE INDEX IF NOT EXISTS idx_items_lastVisitAt ON items(lastVisitAt);
        CREATE INDEX IF NOT EXISTS idx_items_visitCount ON items(visitCount);
        CREATE INDEX IF NOT EXISTS idx_items_frecencyScore ON items(frecencyScore DESC);
        CREATE INDEX IF NOT EXISTS idx_items_domain ON items(domain);
      `);

      DEBUG && console.log('main', 'Entity type migration complete');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Always ensure entity-specific indexes exist
  try {
    // Fast lookup by entity type within entities
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_entity_type
      ON items((json_extract(metadata, '$.entityType')))
      WHERE type = 'entity'`);

    // Fast Wikidata QID lookup
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_wikidata
      ON items((json_extract(metadata, '$.wikidata')))
      WHERE type = 'entity' AND json_extract(metadata, '$.wikidata') IS NOT NULL`);

    // item_events by source URL (find all entities on a page)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_item_events_content
      ON item_events(content)
      WHERE content LIKE 'http%'`);
  } catch (error) {
    DEBUG && console.log('main', `Entity indexes:`, (error as Error).message);
  }
}

/**
 * Add 'event' to items type CHECK constraint for existing databases.
 * Mirrors migrateEntityType — SQLite can't ALTER a CHECK, so we recreate.
 */
function migrateEventType(): void {
  if (!db) return;

  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='items'`
  ).get();
  if (!tableExists) return;

  const tableSchema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='items'`
  ).get() as { sql: string } | undefined;
  if (!tableSchema) return;

  if (tableSchema.sql.includes("'event'")) return;

  DEBUG && console.log('main', "Adding 'event' to items CHECK constraint");

  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  const columnNames = columns.map(c => c.name);

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`DROP TABLE IF EXISTS items_event_mig`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS items_event_mig (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('url', 'text', 'tagset', 'image', 'series', 'feed', 'entity', 'event')),
        content TEXT,
        mimeType TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        syncId TEXT DEFAULT '',
        syncedAt INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        deletedAt INTEGER DEFAULT 0,
        starred INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        visitCount INTEGER DEFAULT 0,
        lastVisitAt INTEGER DEFAULT 0,
        frecencyScore INTEGER DEFAULT 0,
        title TEXT DEFAULT '',
        domain TEXT DEFAULT '',
        favicon TEXT DEFAULT '',
        thumbnail TEXT DEFAULT ''
      )
    `);

    const migColumns = ['id', 'type', 'content', 'mimeType', 'metadata', 'syncId', 'syncedAt',
      'createdAt', 'updatedAt', 'deletedAt', 'starred', 'archived', 'visitCount', 'lastVisitAt',
      'frecencyScore', 'title', 'domain', 'favicon', 'thumbnail'];
    const existingCols = migColumns.filter(c => columnNames.includes(c));
    const colList = existingCols.join(', ');

    db.exec(`INSERT INTO items_event_mig (${colList}) SELECT ${colList} FROM items`);
    db.exec(`DROP TABLE items`);
    db.exec(`ALTER TABLE items_event_mig RENAME TO items`);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
      CREATE INDEX IF NOT EXISTS idx_items_syncId ON items(syncId);
      CREATE INDEX IF NOT EXISTS idx_items_deletedAt ON items(deletedAt);
      CREATE INDEX IF NOT EXISTS idx_items_createdAt ON items(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_items_starred ON items(starred);
      CREATE INDEX IF NOT EXISTS idx_items_lastVisitAt ON items(lastVisitAt);
      CREATE INDEX IF NOT EXISTS idx_items_visitCount ON items(visitCount);
      CREATE INDEX IF NOT EXISTS idx_items_frecencyScore ON items(frecencyScore DESC);
      CREATE INDEX IF NOT EXISTS idx_items_domain ON items(domain);
    `);

    DEBUG && console.log('main', 'Event type migration complete');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Local cosmetic backfill: replace stuck "Loading..." titles on URL
 * items with the URL hostname. Captures items whose page never reported
 * a real title (fetch failed, page omitted <title>, etc.); the entities
 * flow does this on the fly for new items, but already-stored rows
 * would otherwise stay title-less indefinitely.
 *
 * Runs every boot (no migrations-table marker) because cross-backend
 * sync (Tauri desktop / tauri-mobile, which do not run this) can
 * re-push "Loading..." rows that need to be re-fixed locally. The
 * WHERE clause is selective, so the per-boot cost is a small scan.
 *
 * Does NOT bump `updatedAt`: the backfill is intentionally local and
 * non-propagating. If another device has a real title for the same
 * row, that device's higher updatedAt will win on the next sync,
 * overwriting our hostname placeholder. If we bumped updatedAt, we'd
 * push our hostname over their real title.
 *
 * Exported (rather than module-private) so a node test can drive it
 * against an in-memory sqlite without booting Electron.
 */
export function migrateLoadingTitles(database: Database.Database | null = db): void {
  if (!database) return;

  try {
    const stuck = database.prepare(
      `SELECT id, content, domain FROM items
       WHERE type = 'url' AND deletedAt = 0 AND (title = 'Loading...' OR title IS NULL OR title = '')`
    ).all() as { id: string; content: string | null; domain: string | null }[];

    let backfilled = 0;
    const update = database.prepare('UPDATE items SET title = ? WHERE id = ?');
    for (const row of stuck) {
      let hostname = row.domain || '';
      if (!hostname && row.content) {
        try { hostname = new URL(row.content).hostname; } catch { /* skip */ }
      }
      if (hostname) {
        update.run(hostname, row.id);
        backfilled++;
      }
    }

    DEBUG && console.log('main', `Loading-title backfill: scanned ${stuck.length}, backfilled ${backfilled}`);
  } catch (error) {
    DEBUG && console.log('main', `Loading-title backfill error:`, (error as Error).message);
  }
}

/**
 * Remove standalone price entities that lack product context.
 * Before the extractor was improved (2026-02-11), price entities were created
 * without an attributes.product field, producing noisy standalone prices like "$9.99".
 * The updated extractor always associates prices with a product name.
 * This migration hard-deletes price entities missing the product attribute.
 */
function migrateStandalonePriceEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'remove_standalone_price_entities_v1';

  // Check if already migrated
  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') {
    DEBUG && console.log('main', 'Standalone price entity migration already complete');
    return;
  }

  // Find all entity items where entityType is 'price' and attributes.product is missing
  const priceEntities = db.prepare(`
    SELECT id FROM items
    WHERE type = 'entity'
      AND deletedAt = 0
      AND json_extract(metadata, '$.entityType') = 'price'
      AND (json_extract(metadata, '$.attributes.product') IS NULL
        OR json_extract(metadata, '$.attributes.product') = '')
  `).all() as { id: string }[];

  if (priceEntities.length === 0) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    DEBUG && console.log('main', 'No standalone price entities to remove');
    return;
  }

  DEBUG && console.log('main', `Removing ${priceEntities.length} standalone price entities without product context`);

  let removedCount = 0;
  for (const entity of priceEntities) {
    try {
      // Delete associated item_events (observations)
      db.prepare('DELETE FROM item_events WHERE itemId = ?').run(entity.id);
      // Delete associated item_tags
      db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(entity.id);
      // Hard-delete the item itself
      db.prepare('DELETE FROM items WHERE id = ?').run(entity.id);
      removedCount++;
    } catch (error) {
      console.error(`Failed to remove standalone price entity ${entity.id}:`, error);
    }
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  DEBUG && console.log('main', `Removed ${removedCount} standalone price entities`);
}

/**
 * Remove standalone date entities that lack contextual labels.
 * Before the extractor was improved (2026-02-13), date entities were created
 * without an attributes.context field, producing noisy standalone dates like "Feb 15, 2026".
 * The updated extractor always associates dates with a meaningful label (event, deadline, etc.).
 * This migration hard-deletes date entities missing the context attribute.
 */
function migrateStandaloneDateEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'remove_standalone_date_entities_v1';

  // Check if already migrated
  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') {
    DEBUG && console.log('main', 'Standalone date entity migration already complete');
    return;
  }

  // Find all entity items where entityType is 'date' and attributes.context is missing
  const dateEntities = db.prepare(`
    SELECT id FROM items
    WHERE type = 'entity'
      AND deletedAt = 0
      AND json_extract(metadata, '$.entityType') = 'date'
      AND (json_extract(metadata, '$.attributes.context') IS NULL
        OR json_extract(metadata, '$.attributes.context') = '')
  `).all() as { id: string }[];

  if (dateEntities.length === 0) {
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    DEBUG && console.log('main', 'No standalone date entities to remove');
    return;
  }

  DEBUG && console.log('main', `Removing ${dateEntities.length} standalone date entities without context`);

  let removedCount = 0;
  for (const entity of dateEntities) {
    try {
      // Delete associated item_events (observations)
      db.prepare('DELETE FROM item_events WHERE itemId = ?').run(entity.id);
      // Delete associated item_tags
      db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(entity.id);
      // Hard-delete the item itself
      db.prepare('DELETE FROM items WHERE id = ?').run(entity.id);
      removedCount++;
    } catch (error) {
      console.error(`Failed to remove standalone date entity ${entity.id}:`, error);
    }
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  DEBUG && console.log('main', `Removed ${removedCount} standalone date entities`);
}

/**
 * Remove noisy date entities whose context looks like filesystem/directory-listing noise.
 * Catches: context ending with "/" (directory names), single-word short contexts (identifiers),
 * and filenames (word.ext).
 */
function migrateNoisyDateEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'remove_noisy_date_entities_v1';

  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') return;

  // Find date entities with context that looks like filesystem/directory noise
  const noisyDates = db.prepare(`
    SELECT id, json_extract(metadata, '$.attributes.context') as context FROM items
    WHERE type = 'entity'
      AND deletedAt = 0
      AND json_extract(metadata, '$.entityType') = 'date'
      AND json_extract(metadata, '$.attributes.context') IS NOT NULL
  `).all() as { id: string; context: string }[];

  let removedCount = 0;
  for (const entity of noisyDates) {
    const ctx = entity.context || '';
    const isNoisy =
      ctx.endsWith('/') ||                            // directory name
      /^[\w.-]+\.\w{1,5}$/.test(ctx) ||              // filename
      (!/\s/.test(ctx) && ctx.length < 15);           // short single token
    if (!isNoisy) continue;

    try {
      db.prepare('DELETE FROM item_events WHERE itemId = ?').run(entity.id);
      db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(entity.id);
      db.prepare('DELETE FROM items WHERE id = ?').run(entity.id);
      removedCount++;
    } catch (error) {
      console.error(`Failed to remove noisy date entity ${entity.id}:`, error);
    }
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  if (removedCount > 0) {
    console.log(`[datastore] Removed ${removedCount} noisy date entities (directory listings, filenames, etc.)`);
  }
}

/**
 * Remove phone entities that are bare digit sequences (no formatting).
 * Real phone numbers have dashes, dots, spaces, parens, or + prefix.
 */
function migrateUnformattedPhoneEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'remove_unformatted_phone_entities_v1';

  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') return;

  const phoneEntities = db.prepare(`
    SELECT id, content FROM items
    WHERE type = 'entity'
      AND deletedAt = 0
      AND json_extract(metadata, '$.entityType') = 'phone'
  `).all() as { id: string; content: string }[];

  let removedCount = 0;
  for (const entity of phoneEntities) {
    const name = entity.content || '';
    // If the entity name is purely digits, it's not a real phone number
    if (/^\d+$/.test(name.trim())) {
      try {
        db.prepare('DELETE FROM item_events WHERE itemId = ?').run(entity.id);
        db.prepare('DELETE FROM item_tags WHERE itemId = ?').run(entity.id);
        db.prepare('DELETE FROM items WHERE id = ?').run(entity.id);
        removedCount++;
      } catch (error) {
        console.error(`Failed to remove unformatted phone entity ${entity.id}:`, error);
      }
    }
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  if (removedCount > 0) {
    console.log(`[datastore] Removed ${removedCount} unformatted phone entities (bare digit sequences)`);
  }
}

/**
 * Remove low-quality entities that were stored before quality filters were added.
 * Applies retroactively: blocklisted names, low-confidence addresses, automated emails,
 * sparse JSON-LD entities (name-only persons/orgs), and events without dates.
 */
function migrateLowQualityEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'remove_low_quality_entities_v5';

  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') return;

  // Blocklist of generic names (must match entity-matcher.js BLOCKLIST)
  const blocklist = new Set([
    'event', 'article', 'person', 'organization', 'product', 'news',
    'home', 'about', 'contact', 'menu', 'search', 'loading', 'unknown',
    'untitled', 'none', 'n/a', 'tbd', 'lorem ipsum', 'test', 'example',
    'admin', 'user', 'guest', 'anonymous', 'null', 'undefined',
    'website', 'page', 'site', 'blog', 'shop', 'store', 'app',
    'privacy policy', 'terms of service', 'cookie policy', 'subscribe',
    'sign in', 'sign up', 'log in', 'register', 'learn more', 'read more',
    'click here', 'view more', 'see more', 'show more', 'load more',
    'main page', 'front page', 'index', 'welcome', 'dashboard', 'feed',
    'homepage', 'start page', 'new tab',
  ]);

  const blockedEmailPrefixes = [
    'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
    'notification', 'notifications', 'automated', 'mailer-daemon', 'postmaster',
    'webmaster', 'hostmaster', 'abuse', 'bounce', 'auto', 'daemon',
  ];

  const allEntities = db.prepare(`
    SELECT id, content, metadata FROM items
    WHERE type = 'entity' AND deletedAt = 0
  `).all() as { id: string; content: string; metadata: string }[];

  let removedCount = 0;
  const removeEntity = (id: string) => {
    try {
      db!.prepare('DELETE FROM item_events WHERE itemId = ?').run(id);
      db!.prepare('DELETE FROM item_tags WHERE itemId = ?').run(id);
      db!.prepare('DELETE FROM items WHERE id = ?').run(id);
      removedCount++;
    } catch (error) {
      console.error(`Failed to remove entity ${id}:`, error);
    }
  };

  for (const entity of allEntities) {
    const name = (entity.content || '').trim();
    const nameLower = name.toLowerCase();
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(entity.metadata || '{}'); } catch { /* skip */ }
    const entityType = meta.entityType as string || '';
    const attrs = (meta.attributes || {}) as Record<string, unknown>;
    const confidence = (meta.confidence as number) || 0;

    // 1. Blocklisted names
    if (blocklist.has(nameLower)) { removeEntity(entity.id); continue; }

    // 2. Too short (< 4 chars catches abbreviations like "LOC", "WI", "Ed", "Se") or all numbers
    if (name.length < 4 || /^\d+$/.test(name)) { removeEntity(entity.id); continue; }

    // 3. All punctuation/symbols
    if (/^[\d\s.,;:!?$%/\-@#&*()[\]{}|\\<>]+$/.test(name)) { removeEntity(entity.id); continue; }

    // 4. Automated emails
    if (entityType === 'email') {
      const localPart = nameLower.split('@')[0] || '';
      if (blockedEmailPrefixes.some(p => localPart === p || localPart.startsWith(p + '+'))) {
        removeEntity(entity.id);
        continue;
      }
    }

    // 5. All regex-extracted places, prices, and dates — these extractors are too noisy.
    // Places match random numbered text, prices match currency codes in non-price contexts
    // (e.g. "2025 AUD" as a price), dates pull surrounding garbage text as "context".
    if ((entityType === 'place' || entityType === 'price' || entityType === 'date') && meta.extractor === 'regex') {
      removeEntity(entity.id);
      continue;
    }

    // 6. JSON-LD persons/orgs with only a name (no other meaningful attributes)
    if ((meta.extractor === 'json-ld') && (entityType === 'person' || entityType === 'organization')) {
      const meaningfulFields = Object.values(attrs).filter(v =>
        v && (typeof v === 'string' ? (v as string).trim().length > 0 : true)
      ).length;
      if (meaningfulFields < 1) {
        removeEntity(entity.id);
        continue;
      }
    }

    // 7. Events without start date (from JSON-LD)
    if (entityType === 'event' && (meta.extractor === 'json-ld') && !attrs.startDate) {
      removeEntity(entity.id);
      continue;
    }

    // 8. Products without price or description (from JSON-LD)
    if (entityType === 'product' && (meta.extractor === 'json-ld') && !attrs.price && !attrs.description) {
      removeEntity(entity.id);
      continue;
    }

    // 9. Single-word "person" entities from OpenGraph — these are site/org names, not people
    if (entityType === 'person' && meta.extractor === 'opengraph' && !name.includes(' ')) {
      removeEntity(entity.id);
      continue;
    }
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  if (removedCount > 0) {
    console.log(`[datastore] Removed ${removedCount} low-quality entities (blocklist, automated emails, sparse structured data)`);
  }
}

/**
 * Validate existing person entities using name heuristics and a local name database.
 * Removes person entities that fail validation:
 * - CamelCase brand names stored as persons (e.g., "IndieWeb")
 * - Single-word persons not in the common first names database
 * - Names with org suffixes stored as persons
 * - Re-types obvious organizations that were misclassified as persons
 *
 * See docs/entity-validation-research.md for the full framework design.
 */
function migrateInvalidPersonEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'validate_person_entities_v1';

  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') return;

  // Load the name database synchronously for the migration context
  let namesData: { firstNames: string[]; surnames: string[] };
  try {
    const namesPath = join(__dirname, '../../features/entities/data/names.json');
    namesData = JSON.parse(readFileSync(namesPath, 'utf-8'));
  } catch (error) {
    console.warn('[datastore] Could not load names.json for person entity migration, skipping:', (error as Error).message);
    db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
    return;
  }

  const firstNames = new Set(namesData.firstNames.map(n => n.toLowerCase()));
  const surnames = new Set(namesData.surnames.map(n => n.toLowerCase()));

  // CamelCase pattern: single word with internal uppercase (IndieWeb, YouTube, GitHub)
  const camelCasePattern = /^[A-Z][a-z]+(?:[A-Z][a-z]*)+$/;

  // Org suffixes
  const orgSuffixPattern = /\b(Inc|LLC|Ltd|Corp|Corporation|Foundation|Association|Institute|University|Museum|Academy|Society)\b\.?/i;

  // "The X" pattern
  const thePattern = /^The\s+/;

  // ALL_CAPS
  const allCapsPattern = /^[A-Z]{2,}$/;

  // Honorific prefix
  const honorificPattern = /^(Mr|Mrs|Ms|Miss|Dr|Prof|Professor|Sir|Dame|Lady|Lord|Rev|Reverend)\b\.?\s/i;

  // URL/path-like
  const urlLikePattern = /^(https?:\/\/|www\.|\/)/i;
  const pathLikePattern = /[/\\]|\.(?:com|org|net|edu|gov|io|html|php)\b/i;

  const personEntities = db.prepare(`
    SELECT id, content, metadata FROM items
    WHERE type = 'entity'
      AND deletedAt = 0
      AND json_extract(metadata, '$.entityType') = 'person'
  `).all() as { id: string; content: string; metadata: string }[];

  let removedCount = 0;
  let retypedCount = 0;

  const removeEntity = (id: string) => {
    try {
      db!.prepare('DELETE FROM item_events WHERE itemId = ?').run(id);
      db!.prepare('DELETE FROM item_tags WHERE itemId = ?').run(id);
      db!.prepare('DELETE FROM items WHERE id = ?').run(id);
      removedCount++;
    } catch (error) {
      console.error(`Failed to remove invalid person entity ${id}:`, error);
    }
  };

  const retypeToOrg = (id: string, metadata: string) => {
    try {
      const meta = JSON.parse(metadata || '{}');
      meta.entityType = 'organization';
      meta.confidence = (meta.confidence || 0.5) * 0.8;
      meta.retypedFrom = 'person';
      meta.retypedReason = 'name validation migration';
      db!.prepare('UPDATE items SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);

      // Update tags: remove entity:person tag, add entity:organization tag
      const personTag = db!.prepare(`SELECT id FROM tags WHERE name = 'entity:person'`).get() as { id: string } | undefined;
      const orgTag = db!.prepare(`SELECT id FROM tags WHERE name = 'entity:organization'`).get() as { id: string } | undefined;
      if (personTag) {
        db!.prepare('DELETE FROM item_tags WHERE itemId = ? AND tagId = ?').run(id, personTag.id);
      }
      if (orgTag) {
        db!.prepare('INSERT OR IGNORE INTO item_tags (itemId, tagId) VALUES (?, ?)').run(id, orgTag.id);
      }
      retypedCount++;
    } catch (error) {
      console.error(`Failed to retype person entity ${id} to org:`, error);
    }
  };

  for (const entity of personEntities) {
    const name = (entity.content || '').trim();
    const words = name.split(/\s+/);

    // URL/path-like → remove
    if (urlLikePattern.test(name) || pathLikePattern.test(name)) {
      removeEntity(entity.id);
      continue;
    }

    // Has honorific → keep (strong person signal)
    if (honorificPattern.test(name)) continue;

    // CamelCase single word → retype to org (e.g., "IndieWeb", "YouTube")
    if (words.length === 1 && camelCasePattern.test(name)) {
      retypeToOrg(entity.id, entity.metadata);
      continue;
    }

    // ALL_CAPS single word → remove (abbreviation, not person)
    if (words.length === 1 && allCapsPattern.test(name)) {
      removeEntity(entity.id);
      continue;
    }

    // Org suffix → retype to org
    if (orgSuffixPattern.test(name)) {
      retypeToOrg(entity.id, entity.metadata);
      continue;
    }

    // "The X" pattern → retype to org
    if (thePattern.test(name) && words.length >= 2) {
      retypeToOrg(entity.id, entity.metadata);
      continue;
    }

    // Single word: only keep if it is a known first name
    if (words.length === 1) {
      const lower = name.toLowerCase();
      if (!firstNames.has(lower)) {
        removeEntity(entity.id);
        continue;
      }
      // Known first name mononym (Madonna, Jesus) — keep
      continue;
    }

    // Multi-word with leading CamelCase → retype to org
    if (camelCasePattern.test(words[0])) {
      retypeToOrg(entity.id, entity.metadata);
      continue;
    }

    // Multi-word: keep (two-word names are plausible persons even without DB match)
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  if (removedCount > 0 || retypedCount > 0) {
    console.log(`[datastore] Person entity validation: removed ${removedCount}, retyped ${retypedCount} to organization`);
  }
}

/**
 * Remove false-positive place entities from the regex extractor.
 * Previously ADDRESS_RE was too loose (case-insensitive, allowed zero-length
 * words) and matched strings like "16 yarn test" as street addresses.
 * Re-validates regex-extracted places against the tightened ADDRESS_RE.
 * Non-regex places (from structured data, microformats) are left untouched.
 */
function migrateInvalidPlaceEntities(): void {
  if (!db) return;

  const MIGRATION_ID = 'validate_place_entities_v1';

  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') return;

  // Tightened ADDRESS_RE: case-sensitive suffixes, 2+ char words, mandatory whitespace
  const validAddressPattern = /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]+\s+){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Trail|Trl|Parkway|Pkwy|Highway|Hwy)\.?\b/;

  const regexPlaceEntities = db.prepare(`
    SELECT id, content, metadata FROM items
    WHERE type = 'entity'
      AND deletedAt = 0
      AND json_extract(metadata, '$.entityType') = 'place'
      AND json_extract(metadata, '$.extractor') = 'regex'
  `).all() as { id: string; content: string; metadata: string }[];

  let removedCount = 0;

  for (const entity of regexPlaceEntities) {
    const name = (entity.content || '').trim();

    // Keep if it matches the tightened address pattern
    if (validAddressPattern.test(name)) continue;

    // Doesn't match — remove as false positive from old loose regex
    try {
      db!.prepare('DELETE FROM item_events WHERE itemId = ?').run(entity.id);
      db!.prepare('DELETE FROM item_tags WHERE itemId = ?').run(entity.id);
      db!.prepare('DELETE FROM items WHERE id = ?').run(entity.id);
      removedCount++;
    } catch (error) {
      console.error(`Failed to remove invalid place entity ${entity.id}:`, error);
    }
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
  if (removedCount > 0) {
    console.log(`[datastore] Place entity validation: removed ${removedCount} false-positive regex-extracted place entities`);
  }
}

/**
 * Drop legacy address/visit/address_tags tables.
 * Data was already migrated to items/item_visits/item_tags by earlier migrations.
 */
/**
 * Tag existing URL items that have visits but no tags with 'from:history'.
 * These are navigation-tracked URLs that were created before we started
 * auto-tagging them. Items with user-added tags are left alone.
 */
function migrateTagNavigationHistory(): void {
  if (!db) return;

  const MIGRATION_ID = 'tag_navigation_history_v1';

  const migrationRecord = db.prepare('SELECT * FROM migrations WHERE id = ?').get(MIGRATION_ID) as { status: string } | undefined;
  if (migrationRecord && migrationRecord.status === 'complete') {
    return;
  }

  // Find URL items that have visits (navigation-tracked) but no tags at all
  const untaggedNavItems = db.prepare(`
    SELECT DISTINCT i.id FROM items i
    INNER JOIN item_visits iv ON i.id = iv.itemId
    LEFT JOIN item_tags it ON i.id = it.itemId
    WHERE i.type = 'url' AND i.deletedAt = 0 AND it.itemId IS NULL
  `).all() as { id: string }[];

  if (untaggedNavItems.length > 0) {
    const timestamp = now();
    // Get or create the from:history tag
    const historyTagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get('from:history') as { id: string } | undefined;
    let historyTagId: string;
    if (historyTagRow) {
      historyTagId = historyTagRow.id;
    } else {
      historyTagId = generateId('tag');
      db.prepare(
        'INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt) VALUES (?, ?, 0, ?, 0, ?, ?)'
      ).run(historyTagId, 'from:history', timestamp, timestamp, timestamp);
    }

    const insertStmt = db.prepare('INSERT OR IGNORE INTO item_tags (itemId, tagId, createdAt) VALUES (?, ?, ?)');
    for (const { id } of untaggedNavItems) {
      insertStmt.run(id, historyTagId, timestamp);
    }

    DEBUG && console.log('main', `Tagged ${untaggedNavItems.length} navigation URLs with from:history`);
  }

  db.prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)').run(MIGRATION_ID, 'complete', Date.now());
}

function dropLegacyAddressTables(): void {
  if (!db) return;

  // Check if addresses table still exists
  const addressesExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='addresses'`
  ).get();

  if (!addressesExists) return;

  DEBUG && console.log('main', 'Dropping legacy addresses/visits/address_tags tables');

  try {
    db.exec(`
      DROP TABLE IF EXISTS address_tags;
      DROP TABLE IF EXISTS visits;
      DROP TABLE IF EXISTS addresses;
    `);
    DEBUG && console.log('main', 'Legacy tables dropped successfully');
  } catch (error) {
    console.error('Failed to drop legacy tables:', error);
  }
}

// ==================== Rename extension_settings -> feature_settings ====================

function migrateExtensionSettingsToFeatureSettings(): void {
  if (!db) return;

  // Check if old table exists
  const oldTableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='extension_settings'`
  ).get();

  if (!oldTableExists) return;

  DEBUG && console.log('main', 'Migrating extension_settings -> feature_settings');

  try {
    // Copy data from old table to new table (created by CREATE TABLE IF NOT EXISTS above)
    db.exec(`
      INSERT OR IGNORE INTO feature_settings (id, featureId, key, value, updatedAt)
      SELECT id, extensionId, key, value, updatedAt FROM extension_settings;
    `);
    // Drop old table and its indexes
    db.exec(`DROP TABLE IF EXISTS extension_settings`);
    DEBUG && console.log('main', 'extension_settings -> feature_settings migration complete');
  } catch (error) {
    console.error('Failed to migrate extension_settings:', error);
  }
}

/**
 * Add thumbnail column to items table for page screenshot thumbnails.
 * Stores the SHA-256 hash of the normalized URL, used as filename in thumbnails dir.
 */
function migrateItemThumbnailColumn(): void {
  if (!db) return;

  const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
  const hasThumbnail = columns.some(col => col.name === 'thumbnail');

  if (!hasThumbnail) {
    DEBUG && console.log('main', 'Adding thumbnail column to items table');
    try {
      db.exec(`ALTER TABLE items ADD COLUMN thumbnail TEXT DEFAULT ''`);
    } catch (error) {
      DEBUG && console.log('main', `Item thumbnail column migration:`, (error as Error).message);
    }
  }
}

/**
 * Ensure tags.name has a UNIQUE index (idx_tags_name_unique) and drop the
 * superseded plain idx_tags_name.
 *
 * Background: idx_tags_name_unique was added to the CREATE TABLE DDL in
 * commit 01392807. Existing databases created before that won't have it
 * (CREATE INDEX IF NOT EXISTS only runs when the table is first created).
 * The unique index covers every query the plain idx_tags_name served, so the
 * plain index is now redundant — this migration also drops it.
 *
 * Before creating the unique index we deduplicate tags.name. If duplicate
 * rows exist (e.g. from a bug in an older code path), SQLite would reject
 * the CREATE UNIQUE INDEX. The canonical row is the one with the lowest id
 * (earliest creation). item_tags references pointing at duplicate rows are
 * rewritten to the canonical row's id, then the duplicate tag rows are
 * deleted.
 *
 * Throws on failure. A schema without idx_tags_name_unique breaks every
 * ON CONFLICT(name) upsert in the tag code path, so silently continuing
 * would just defer the crash to user-visible tagging operations.
 */
function migrateTagsUniqueIndex(): void {
  if (!db) return;

  // Fast-path: unique index already exists. Still attempt the plain-index
  // drop in case a previous run created the unique index but the DDL still
  // had the plain index at the time.
  const existing = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tags_name_unique'`
  ).get();
  if (existing) {
    db.exec(`DROP INDEX IF EXISTS idx_tags_name`);
    return;
  }

  DEBUG && console.log('main', 'migrateTagsUniqueIndex: index missing, deduplicating tags.name');

  // Capture db as a non-null local for use inside transaction closures.
  const d = db;

  // Find all name groups that have more than one row.
  const dupeGroups = d.prepare(`
    SELECT name, MIN(id) AS canonicalId
    FROM tags
    GROUP BY name
    HAVING COUNT(*) > 1
  `).all() as { name: string; canonicalId: string }[];

  if (dupeGroups.length > 0) {
    DEBUG && console.log('main', `migrateTagsUniqueIndex: ${dupeGroups.length} duplicate tag name(s) found, deduplicating`);

    const dedupeTransaction = d.transaction(() => {
      for (const { name, canonicalId } of dupeGroups) {
        // Get all duplicate ids (everything except the canonical row).
        const dupeRows = d.prepare(
          `SELECT id FROM tags WHERE name = ? AND id != ?`
        ).all(name, canonicalId) as { id: string }[];

        for (const { id: dupeId } of dupeRows) {
          // Rewrite item_tags refs from dupeId -> canonicalId.
          // item_tags has UNIQUE(itemId, tagId) so an UPDATE could collide
          // when an item already has both the dupe and canonical tag.
          // Strategy: delete the row that would collide, then update the rest.
          d.prepare(`
            DELETE FROM item_tags
            WHERE tagId = ?
            AND itemId IN (
              SELECT itemId FROM item_tags WHERE tagId = ?
            )
          `).run(dupeId, canonicalId);

          // Now update the remaining refs safely.
          d.prepare(
            `UPDATE item_tags SET tagId = ? WHERE tagId = ?`
          ).run(canonicalId, dupeId);

          // Delete the duplicate tag row.
          d.prepare(`DELETE FROM tags WHERE id = ?`).run(dupeId);
        }
      }
    });

    dedupeTransaction();
    DEBUG && console.log('main', 'migrateTagsUniqueIndex: deduplication complete');
  }

  // Create the UNIQUE index — safe because there are no duplicate names —
  // and drop the now-redundant plain idx_tags_name.
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_unique ON tags(name)`);
  d.exec(`DROP INDEX IF EXISTS idx_tags_name`);
  DEBUG && console.log('main', 'migrateTagsUniqueIndex: idx_tags_name_unique created, idx_tags_name dropped');
}

/**
 * Update the thumbnail hash of a URL item.
 * Matches by normalized URL content, following the updateItemFavicon pattern.
 */
export function updateItemThumbnail(url: string, hash: string): boolean {
  const normalizedUri = normalizeUrl(url);
  const d = getDb();

  // Phase 1: Try exact normalized URL match
  let existing = d.prepare(
    'SELECT id, thumbnail FROM items WHERE type = ? AND content = ? AND deletedAt = 0'
  ).get('url', normalizedUri) as { id: string; thumbnail: string | null } | undefined;

  // Phase 2: If no match, try with raw URL
  if (!existing && url !== normalizedUri) {
    existing = d.prepare(
      'SELECT id, thumbnail FROM items WHERE type = ? AND content = ? AND deletedAt = 0'
    ).get('url', url) as { id: string; thumbnail: string | null } | undefined;
  }

  if (!existing) return false;

  d.prepare('UPDATE items SET thumbnail = ?, updatedAt = ? WHERE id = ?')
    .run(hash, Date.now(), existing.id);
  return true;
}

/**
 * Get all thumbnail hashes from non-deleted items.
 * Used by cleanup to determine which thumbnails are still referenced.
 */
export function getActiveThumbnailHashes(): Set<string> {
  const d = getDb();
  const rows = d.prepare(
    `SELECT thumbnail FROM items WHERE thumbnail != '' AND thumbnail IS NOT NULL AND deletedAt = 0`
  ).all() as { thumbnail: string }[];
  return new Set(rows.map(r => r.thumbnail));
}

// ==================== Context History Operations ====================

export interface ContextEntry {
  id: string;
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  windowId: number | null;
  source: string;
  timestamp: number;
  prevEntryId: string | null;
}

export interface ContextHistoryFilter {
  key?: string;
  windowId?: number | null;
  since?: number;
  until?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

// In-memory context state per window
// Map<windowId, Map<key, ContextEntry>>
const windowContextState = new Map<number | null, Map<string, ContextEntry>>();

/**
 * Get context state map for a window
 */
function getContextStateMap(windowId: number | null): Map<string, ContextEntry> {
  if (!windowContextState.has(windowId)) {
    windowContextState.set(windowId, new Map());
  }
  return windowContextState.get(windowId)!;
}

/**
 * Add a context entry to history
 */
export function addContextEntry(
  key: string,
  value: unknown,
  options: {
    metadata?: Record<string, unknown>;
    windowId?: number | null;
    source?: string;
  } = {}
): { id: string; prevEntryId: string | null } {
  const {
    metadata = {},
    windowId = null,
    source = ''
  } = options;

  const entryId = generateId('ctx');
  const timestamp = now();

  // Get previous entry ID for chaining
  const stateMap = getContextStateMap(windowId);
  const prevEntry = stateMap.get(key);
  const prevEntryId = prevEntry?.id ?? null;

  // Serialize value as JSON
  const valueJson = JSON.stringify(value);
  const metadataJson = JSON.stringify(metadata);

  // Insert into database (if initialized - may not be during tests)
  if (db) {
    db.prepare(`
      INSERT INTO context_history (id, key, value, metadata, windowId, source, timestamp, prevEntryId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entryId, key, valueJson, metadataJson, windowId, source, timestamp, prevEntryId);
  }

  // Update in-memory state
  const entry: ContextEntry = {
    id: entryId,
    key,
    value,
    metadata,
    windowId,
    source,
    timestamp,
    prevEntryId
  };
  stateMap.set(key, entry);

  DEBUG && console.log('main', `context entry added: ${key}=${JSON.stringify(value)} for window ${windowId}`);

  return { id: entryId, prevEntryId };
}

/**
 * Get current context value for a key
 */
export function getContextEntry(key: string, windowId: number | null = null): ContextEntry | null {
  const stateMap = getContextStateMap(windowId);
  return stateMap.get(key) ?? null;
}

/**
 * Query context history
 */
export function queryContextHistory(filter: ContextHistoryFilter = {}): ContextEntry[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.key) {
    conditions.push('key = ?');
    values.push(filter.key);
  }
  if (filter.windowId !== undefined) {
    if (filter.windowId === null) {
      conditions.push('windowId IS NULL');
    } else {
      conditions.push('windowId = ?');
      values.push(filter.windowId);
    }
  }
  if (filter.since) {
    conditions.push('timestamp >= ?');
    values.push(filter.since);
  }
  if (filter.until) {
    conditions.push('timestamp <= ?');
    values.push(filter.until);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = filter.order === 'asc' ? 'ASC' : 'DESC';
  const limit = filter.limit ? `LIMIT ${filter.limit}` : '';

  const rows = getDb().prepare(`
    SELECT * FROM context_history ${whereClause}
    ORDER BY timestamp ${orderBy} ${limit}
  `).all(...values) as Array<{
    id: string;
    key: string;
    value: string;
    metadata: string;
    windowId: number | null;
    source: string;
    timestamp: number;
    prevEntryId: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    key: row.key,
    value: JSON.parse(row.value),
    metadata: JSON.parse(row.metadata || '{}'),
    windowId: row.windowId,
    source: row.source,
    timestamp: row.timestamp,
    prevEntryId: row.prevEntryId
  }));
}

/**
 * Get context snapshot at a point in time
 * Returns the most recent entry for each key before the given timestamp
 */
export function getContextSnapshot(
  timestamp: number,
  keys: string[] = []
): Record<string, ContextEntry> {
  let keyFilter = '';
  const values: unknown[] = [timestamp];

  if (keys.length > 0) {
    keyFilter = `AND key IN (${keys.map(() => '?').join(', ')})`;
    values.push(...keys);
  }

  // Use a subquery to get the max timestamp for each key before the target time
  const rows = getDb().prepare(`
    SELECT ch.*
    FROM context_history ch
    INNER JOIN (
      SELECT key, windowId, MAX(timestamp) as maxTs
      FROM context_history
      WHERE timestamp <= ? ${keyFilter}
      GROUP BY key, windowId
    ) latest ON ch.key = latest.key
      AND (ch.windowId = latest.windowId OR (ch.windowId IS NULL AND latest.windowId IS NULL))
      AND ch.timestamp = latest.maxTs
  `).all(...values) as Array<{
    id: string;
    key: string;
    value: string;
    metadata: string;
    windowId: number | null;
    source: string;
    timestamp: number;
    prevEntryId: string | null;
  }>;

  const snapshot: Record<string, ContextEntry> = {};
  for (const row of rows) {
    snapshot[row.key] = {
      id: row.id,
      key: row.key,
      value: JSON.parse(row.value),
      metadata: JSON.parse(row.metadata || '{}'),
      windowId: row.windowId,
      source: row.source,
      timestamp: row.timestamp,
      prevEntryId: row.prevEntryId
    };
  }

  return snapshot;
}

/**
 * Clean up context state when a window closes
 */
export function cleanupWindowContext(windowId: number): void {
  windowContextState.delete(windowId);
  DEBUG && console.log('main', `context state cleaned up for window ${windowId}`);
}

/**
 * Get all windows with a specific context value
 */
export function getWindowsWithContextValue(key: string, value: unknown): number[] {
  const windowIds: number[] = [];
  for (const [windowId, stateMap] of windowContextState) {
    if (windowId === null) continue;
    const entry = stateMap.get(key);
    if (entry && JSON.stringify(entry.value) === JSON.stringify(value)) {
      windowIds.push(windowId);
    }
  }
  return windowIds;
}

/**
 * Get all windows matching a context predicate
 */
export function getWindowsMatchingContext(
  key: string,
  predicate: (entry: ContextEntry) => boolean
): number[] {
  const windowIds: number[] = [];
  for (const [windowId, stateMap] of windowContextState) {
    if (windowId === null) continue;
    const entry = stateMap.get(key);
    if (entry && predicate(entry)) {
      windowIds.push(windowId);
    }
  }
  return windowIds;
}

// ==================== Mode Helpers (Context-based replacements for modes.ts) ====================

export type MajorModeId = 'page' | 'space' | 'default';

/**
 * Detect the appropriate major mode based on URL
 */
export function detectModeFromUrl(url: string): MajorModeId {
  if (!url) return 'default';

  // Groups extension UI manages its own mode explicitly via setMode():
  // 'group' when viewing a specific group's addresses, 'default' on the
  // groups list. Auto-detecting from URL caused the screen border to
  // appear just from opening the groups browser.

  // Web pages
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return 'page';
  }

  return 'default';
}

/**
 * Update mode for navigation - sets context based on URL
 */
export function updateModeForNavigation(windowId: number, url: string): void {
  const detectedMode = detectModeFromUrl(url);
  const currentEntry = getContextEntry('mode', windowId);

  // Don't override space/group mode with page mode — they persist through navigation
  if (
    (currentEntry?.value === 'space' || currentEntry?.value === 'group') &&
    detectedMode === 'page'
  ) {
    DEBUG && console.log('main', `Preserving ${currentEntry.value} mode for window ${windowId} during navigation`);
    return;
  }

  if (!currentEntry || currentEntry.value !== detectedMode) {
    addContextEntry('mode', detectedMode, {
      windowId,
      source: 'navigation',
      metadata: { url }
    });
  }
}

/**
 * Check if mode conditions are satisfied for a window
 * Used by shortcuts system for mode-conditional shortcuts
 */
export function checkModeConditions(
  windowId: number,
  requiredMajorMode?: MajorModeId
): boolean {
  const entry = getContextEntry('mode', windowId);
  const currentMode = entry?.value as MajorModeId | undefined;

  // No mode state = default mode
  if (!currentMode) {
    return !requiredMajorMode || requiredMajorMode === 'default';
  }

  // Check major mode
  if (requiredMajorMode && currentMode !== requiredMajorMode) {
    return false;
  }

  return true;
}

// ==================== Version Check ====================

/**
 * Check stored datastore version against code version.
 * - If stored > code: old binary running against newer schema — disable sync
 * - If stored < code: upgrade — update stored version
 * - If stored == code or no stored version: write current version
 */
function checkAndWriteDatastoreVersion(): void {
  if (!db) return;

  const row = db.prepare(`
    SELECT value FROM feature_settings
    WHERE featureId = 'system' AND key = 'datastore_version'
  `).get() as { value: string } | undefined;

  if (row) {
    let storedVersion: number;
    try {
      storedVersion = parseInt(JSON.parse(row.value), 10);
    } catch {
      storedVersion = parseInt(row.value, 10);
    }

    if (storedVersion > DATASTORE_VERSION) {
      // Downgrade detected: stored version is newer than code
      console.error(
        `[datastore] DATASTORE VERSION MISMATCH: stored=${storedVersion}, code=${DATASTORE_VERSION}. ` +
        `This binary is older than the database schema. Sync will be disabled to prevent data corruption.`
      );
      syncDisabledDueToVersionMismatch = true;
      return;
    }

    if (storedVersion < DATASTORE_VERSION) {
      // Upgrade: update stored version
      DEBUG && console.log('main', `Upgrading datastore version: ${storedVersion} → ${DATASTORE_VERSION}`);
    }
  }

  // Write current version
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'system', 'datastore_version', ?, ?)
  `).run('system-datastore_version', JSON.stringify(DATASTORE_VERSION), Date.now());

  syncDisabledDueToVersionMismatch = false;
}

/**
 * Returns true if sync should be disabled due to a datastore version mismatch
 * (old binary running against a database migrated by a newer version).
 */
export function isSyncDisabledDueToVersion(): boolean {
  return syncDisabledDueToVersionMismatch;
}

// ==================== Lazy-wake shortcuts ====================
//
// A lazy tile's renderer isn't running at boot, so it can't register
// its user-configured global hotkeys itself. The main process replays
// them from this table at startup (see feature-shortcut-registrar.ts).
//
// The stored values are OPAQUE to the datastore — `accelerator`,
// `wakeTopic`, and `wakeArgs` are interpreted only by the registrar and
// the feature's renderer once woken. `wakeArgs` is a JSON array string.
//
// Snapshot semantics: `setWakeShortcuts` REPLACES all rows for the tile
// (delete-then-insert in one transaction), so the table always reflects
// the tile's latest declared set with no stale rows.

/** A persisted lazy-wake shortcut row (values opaque to the datastore). */
export interface WakeShortcut {
  /** Accelerator string (e.g. 'Alt+0', 'CommandOrControl+Shift+W'). */
  accelerator: string;
  /** Pubsub topic published when the accelerator fires. */
  wakeTopic: string;
  /** Arguments delivered with the wake publish. */
  wakeArgs: unknown[];
}

interface WakeShortcutRow {
  ownerTileId: string;
  accelerator: string;
  wakeTopic: string;
  wakeArgs: string;
}

function parseWakeArgs(s: string): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Replace ALL persisted wake shortcuts for a tile with `list` (snapshot
 * semantics): existing rows for `ownerTileId` are deleted, then the new
 * list is inserted. An empty `list` clears the tile's rows entirely.
 */
export function setWakeShortcuts(ownerTileId: string, list: WakeShortcut[]): void {
  const d = getDb();
  const tx = d.transaction((rows: WakeShortcut[]) => {
    d.prepare('DELETE FROM lazy_wake_shortcuts WHERE ownerTileId = ?').run(ownerTileId);
    const insert = d.prepare(
      'INSERT OR REPLACE INTO lazy_wake_shortcuts (ownerTileId, accelerator, wakeTopic, wakeArgs) VALUES (?, ?, ?, ?)'
    );
    for (const sc of rows) {
      insert.run(
        ownerTileId,
        sc.accelerator,
        sc.wakeTopic,
        JSON.stringify(Array.isArray(sc.wakeArgs) ? sc.wakeArgs : [])
      );
    }
    // Mark this tile as having explicitly declared its wake set — even when
    // `rows` is empty. Boot-replay uses this to distinguish "declared
    // empty" (the user cleared all hotkeys → register NOTHING) from "never
    // declared" (a fresh profile → fall back to the manifest defaults).
    d.prepare('INSERT OR IGNORE INTO lazy_wake_declared (ownerTileId) VALUES (?)').run(ownerTileId);
  });
  tx(list);
}

/**
 * Whether `ownerTileId` has ever explicitly declared its wake-shortcut set
 * (i.e. `setWakeShortcuts` was called for it at least once, possibly with an
 * empty list). Lets boot-replay tell "declared empty → register nothing"
 * apart from "never declared → use the manifest's static defaults".
 */
export function hasDeclaredWakeShortcuts(ownerTileId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM lazy_wake_declared WHERE ownerTileId = ?')
    .get(ownerTileId);
  return row != null;
}

/** Get the persisted wake shortcuts for a single tile. */
export function getWakeShortcuts(ownerTileId: string): WakeShortcut[] {
  const rows = getDb()
    .prepare('SELECT ownerTileId, accelerator, wakeTopic, wakeArgs FROM lazy_wake_shortcuts WHERE ownerTileId = ?')
    .all(ownerTileId) as WakeShortcutRow[];
  return rows.map((r) => ({
    accelerator: r.accelerator,
    wakeTopic: r.wakeTopic,
    wakeArgs: parseWakeArgs(r.wakeArgs),
  }));
}

/**
 * Get every persisted wake shortcut, grouped by owner tile. Used at boot
 * to replay all tiles' user-configured hotkeys in one pass.
 */
export function getAllWakeShortcuts(): Map<string, WakeShortcut[]> {
  const rows = getDb()
    .prepare('SELECT ownerTileId, accelerator, wakeTopic, wakeArgs FROM lazy_wake_shortcuts')
    .all() as WakeShortcutRow[];
  const byTile = new Map<string, WakeShortcut[]>();
  for (const r of rows) {
    const list = byTile.get(r.ownerTileId) ?? [];
    list.push({
      accelerator: r.accelerator,
      wakeTopic: r.wakeTopic,
      wakeArgs: parseWakeArgs(r.wakeArgs),
    });
    byTile.set(r.ownerTileId, list);
  }
  return byTile;
}

/**
 * Whether `featureId` has ANY saved row in `feature_settings` (i.e. the user
 * has configured this feature at least once). Used by the boot-time wake-
 * shortcut backfill: a settings-derived lazy feature that has saved settings
 * but has never declared its wake set (`hasDeclaredWakeShortcuts` false) is a
 * MIGRATED profile from before the lazy-wake system — its real, settings-
 * derived hotkeys were never persisted, so only the manifest defaults register
 * at boot. The backfill wakes such a tile once so it can declare. A fresh
 * profile (no rows) is left alone: manifest defaults + the first hotkey press
 * bootstrap it without an eager boot.
 */
export function hasFeatureSettings(featureId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM feature_settings WHERE featureId = ? LIMIT 1')
    .get(featureId);
  return row != null;
}

// ==================== Window Load Tracking (delegates to items system) ====================

/**
 * Track a window load: delegates to trackNavigation for the items system.
 * Kept as a convenience wrapper with backward-compatible return shape.
 */
export function trackWindowLoad(uri: string, options: {
  source?: string;
  sourceId?: string;
  windowType?: string;
  title?: string;
} = {}): { visitId: string; addressId: string; itemId: string; created: boolean } {
  const navResult = trackNavigation(uri, {
    source: options.source,
    sourceId: options.sourceId,
    windowType: options.windowType,
    title: options.title,
  });

  return { visitId: navResult.visitId, addressId: navResult.itemId, itemId: navResult.itemId, created: navResult.created };
}

// ==================== Content Operations ====================

export function addContent(options: ContentOptions = {}): { id: string } {
  const contentId = generateId('content');
  const timestamp = now();

  getDb().prepare(`
    INSERT INTO content (id, title, content, mimeType, contentType, language, encoding, tags, addressRefs, parentId, metadata, createdAt, updatedAt, syncPath, synced, starred, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contentId,
    options.title || 'Untitled',
    options.content || '',
    options.mimeType || 'text/plain',
    options.contentType || 'plain',
    options.language || '',
    options.encoding || 'utf-8',
    options.tags || '',
    options.addressRefs || '',
    options.parentId || '',
    options.metadata || '{}',
    timestamp,
    timestamp,
    options.syncPath || '',
    options.synced || 0,
    options.starred || 0,
    options.archived || 0
  );

  return { id: contentId };
}

export function queryContent(filter: ContentFilter = {}): Content[] {
  let sql = 'SELECT * FROM content WHERE 1=1';
  const params: (string | number)[] = [];

  if (filter.contentType) {
    sql += ' AND contentType = ?';
    params.push(filter.contentType);
  }
  if (filter.mimeType) {
    sql += ' AND mimeType = ?';
    params.push(filter.mimeType);
  }
  if (filter.synced !== undefined) {
    sql += ' AND synced = ?';
    params.push(filter.synced);
  }
  if (filter.starred !== undefined) {
    sql += ' AND starred = ?';
    params.push(filter.starred);
  }
  if (filter.tag) {
    sql += ' AND tags LIKE ?';
    params.push(`%${filter.tag}%`);
  }

  const sortMap: Record<string, string> = {
    updated: 'updatedAt DESC',
    created: 'createdAt DESC'
  };
  sql += ` ORDER BY ${sortMap[filter.sortBy || ''] || 'updatedAt DESC'}`;

  if (filter.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  return getDb().prepare(sql).all(...params) as Content[];
}

// ==================== Tag Operations ====================

export function getOrCreateTag(name: string): { tag: Tag; created: boolean } {
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-');
  const timestamp = now();

  const existingTag = getDb().prepare('SELECT * FROM tags WHERE LOWER(name) = LOWER(?)').get(name) as Tag | undefined;
  if (existingTag) {
    return { tag: existingTag, created: false };
  }

  const tagId = generateId('tag');
  getDb().prepare(`
    INSERT INTO tags (id, name, slug, color, parentId, description, metadata, createdAt, updatedAt, frequency, lastUsed, frecencyScore)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tagId, name.trim(), slug, '#999999', '', '', '{}', timestamp, timestamp, 0, 0, 0);

  const newTag = getDb().prepare('SELECT * FROM tags WHERE id = ?').get(tagId) as Tag;

  // Emit tag:created so any caller (legacy ipc, strict tile handlers, direct
  // imports) triggers downstream UI refreshes (groups, tags page, etc.).
  try {
    publish(getSystemAddress(), 'tag:created', {
      tagId: newTag.id,
      name: newTag.name,
      // Back-compat alias used by existing listeners
      tagName: newTag.name,
    });
    if (DEBUG) console.log('[datastore] tag:created', newTag.id, newTag.name);
  } catch (err) {
    if (DEBUG) console.warn('[datastore] failed to publish tag:created', err);
  }

  return { tag: newTag, created: true };
}

export function renameTag(id: string, newName: string): Tag | null {
  const slug = newName.toLowerCase().trim().replace(/\s+/g, '-');
  const timestamp = now();

  // Capture old name for the event payload before mutating.
  const existing = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string } | undefined;

  const result = getDb().prepare(
    'UPDATE tags SET name = ?, slug = ?, updatedAt = ? WHERE id = ?'
  ).run(newName.trim(), slug, timestamp, id);
  if (result.changes === 0) return null;

  const updated = getDb().prepare('SELECT * FROM tags WHERE id = ?').get(id) as Tag;

  try {
    publish(getSystemAddress(), 'tag:renamed', {
      tagId: id,
      oldName: existing?.name,
      newName: updated.name,
    });
    if (DEBUG) console.log('[datastore] tag:renamed', id, existing?.name, '->', updated.name);
  } catch (err) {
    if (DEBUG) console.warn('[datastore] failed to publish tag:renamed', err);
  }

  return updated;
}

export function updateTagColor(id: string, color: string): Tag | null {
  const timestamp = now();
  const result = getDb().prepare(
    'UPDATE tags SET color = ?, updatedAt = ? WHERE id = ?'
  ).run(color, timestamp, id);
  if (result.changes === 0) return null;

  const updated = getDb().prepare('SELECT * FROM tags WHERE id = ?').get(id) as Tag;

  try {
    publish(getSystemAddress(), 'tag:color-changed', {
      tagId: id,
      color,
    });
    if (DEBUG) console.log('[datastore] tag:color-changed', id, color);
  } catch (err) {
    if (DEBUG) console.warn('[datastore] failed to publish tag:color-changed', err);
  }

  return updated;
}

export function deleteTag(id: string): boolean {
  const db = getDb();

  // Look up name before deleting so event consumers (groups, etc.) can
  // identify the orphaned tag.
  const existing = db.prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string } | undefined;

  db.prepare('DELETE FROM item_tags WHERE tagId = ?').run(id);
  const result = db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  const deleted = result.changes > 0;

  if (deleted) {
    try {
      publish(getSystemAddress(), 'tag:deleted', {
        tagId: id,
        name: existing?.name,
        // Back-compat alias
        tagName: existing?.name,
      });
      if (DEBUG) console.log('[datastore] tag:deleted', id, existing?.name);
    } catch (err) {
      if (DEBUG) console.warn('[datastore] failed to publish tag:deleted', err);
    }
  }

  return deleted;
}

export function getTagsByFrecency(domain?: string): Tag[] {
  let tags = getDb().prepare('SELECT * FROM tags').all() as Tag[];

  // Recalculate frecency scores
  tags = tags.map(tag => ({
    ...tag,
    frecencyScore: calculateFrecency(tag.frequency || 0, tag.lastUsed || 0)
  }));

  // If domain provided, boost tags used on same-domain items
  if (domain) {
    const domainTagIds = new Set(
      (getDb().prepare(`
        SELECT DISTINCT it.tagId FROM item_tags it
        JOIN items i ON it.itemId = i.id
        WHERE i.domain = ? AND i.deletedAt = 0
      `).all(domain) as { tagId: string }[]).map(row => row.tagId)
    );

    tags = tags.map(tag => ({
      ...tag,
      frecencyScore: domainTagIds.has(tag.id) ? tag.frecencyScore * 2 : tag.frecencyScore
    }));
  }

  tags.sort((a, b) => b.frecencyScore - a.frecencyScore);
  return tags;
}

// ==================== Generic Table Operations ====================

export function getTable(tableName: TableName): Record<string, Record<string, unknown>> {
  const rows = getDb().prepare(`SELECT * FROM ${tableName}`).all() as Array<{ id: string } & Record<string, unknown>>;
  const table: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    table[row.id] = row;
  }
  return table;
}

export function setRow(tableName: TableName, rowId: string, rowData: Record<string, unknown>): void {
  const row: Record<string, unknown> = { id: rowId, ...rowData };
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map(col => row[col]);

  getDb().prepare(`INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
}

export function getRow(tableName: TableName, rowId: string): Record<string, unknown> | null {
  const result = getDb().prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(rowId);
  return (result as Record<string, unknown>) || null;
}

export function getStats(): DatastoreStats {
  const d = getDb();

  // Helper to safely count rows (returns 0 if table doesn't exist or query fails)
  const safeCount = (sql: string): number => {
    try {
      return (d.prepare(sql).get() as { count: number }).count;
    } catch {
      return 0;
    }
  };

  const safeAvg = (sql: string): number => {
    try {
      return (d.prepare(sql).get() as { avg: number | null }).avg || 0;
    } catch {
      return 0;
    }
  };

  return {
    totalAddresses: safeCount('SELECT COUNT(*) as count FROM items WHERE type = \'url\' AND deletedAt = 0'),
    totalVisits: safeCount('SELECT COUNT(*) as count FROM item_visits'),
    avgVisitDuration: safeAvg('SELECT AVG(duration) as avg FROM item_visits'),
    totalContent: safeCount('SELECT COUNT(*) as count FROM content'),
    syncedContent: safeCount('SELECT COUNT(*) as count FROM content WHERE synced = 1'),
    totalItems: safeCount('SELECT COUNT(*) as count FROM items'),
    totalTags: safeCount('SELECT COUNT(*) as count FROM tags'),
    syncedItems: safeCount('SELECT COUNT(*) as count FROM items WHERE syncedAt > 0'),
  };
}

// ==================== Item Operations (mobile-style lightweight content) ====================

/**
 * Add a new item (note, tagset, or image)
 */
export function addItem(type: ItemType, options: ItemOptions = {}): { id: string } {
  const itemId = generateId('item');
  const timestamp = now();

  // Parse existing metadata and add device tracking
  let metadata: Record<string, unknown> = {};
  if (options.metadata) {
    try {
      metadata = typeof options.metadata === 'string'
        ? JSON.parse(options.metadata)
        : options.metadata;
    } catch {
      // Invalid JSON, start fresh
    }
  }

  // Add device metadata (user-created items only, not sync pulls)
  metadata = addDeviceMetadata(metadata, true);

  const metadataJson = JSON.stringify(metadata);

  // Extract title and domain for URL-type items
  let title = '';
  let domain = '';
  if (type === 'url' && options.content) {
    try {
      const parsed = new URL(options.content);
      domain = parsed.hostname;
    } catch { /* not a valid URL */ }
    if (metadata.title) {
      title = String(metadata.title);
    }
  }

  getDb().prepare(`
    INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt, deletedAt, starred, archived, title, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    itemId,
    type,
    options.content ?? null,
    options.mimeType || '',
    metadataJson,
    options.syncId || '',
    timestamp,
    timestamp,
    options.starred || 0,
    options.archived || 0,
    title,
    domain
  );

  // Sync inline hashtags as tags for text items
  if (type === 'text' && options.content) {
    syncContentHashtags(itemId, options.content as string);
  }

  return { id: itemId };
}

/**
 * Get an item by ID
 */
export function getItem(itemId: string): Item | null {
  const result = getDb().prepare('SELECT * FROM items WHERE id = ? AND deletedAt = 0').get(itemId);
  return (result as Item) || null;
}

/**
 * Find a URL item by normalizing the input URL and matching item.content
 * exactly. Items are stored with `content` already normalized (via
 * `normalizeUrl`) so the lookup is a single equality check after we
 * normalize the input. Returns null when no item matches — callers that
 * want create-if-missing semantics should layer that on top.
 *
 * Single canonical entry point for "the item for this URL" — fixes the
 * recurring class of bug where one caller does fuzzy/exact matching on
 * the raw URL while another caller stored the normalized form, producing
 * duplicate items for the same logical URL.
 */
export function findUrlItem(url: string): Item | null {
  if (!url) return null;
  const normalized = normalizeUrl(url);
  const result = getDb()
    .prepare('SELECT * FROM items WHERE type = ? AND content = ? AND deletedAt = 0')
    .get('url', normalized);
  return (result as Item) || null;
}

/**
 * Extract inline hashtags from text content and add them as tags on the item.
 * Only adds — never removes (can't distinguish manual tags from hashtag-derived).
 */
function syncContentHashtags(itemId: string, content: string): void {
  if (!content) return;

  const matches = content.match(/(?:^|\s)#([^\s#]+)/g);
  if (!matches) return;

  const tagNames = [...new Set(matches.map(m => m.trim().slice(1)))];
  if (tagNames.length === 0) return;

  // Get current tags to avoid redundant writes
  const currentTags = getItemTags(itemId);
  const currentTagNames = new Set(currentTags.map(t => t.name));

  for (const name of tagNames) {
    if (!currentTagNames.has(name)) {
      const { tag } = getOrCreateTag(name);
      const { alreadyExists } = tagItem(itemId, tag.id);
      if (!alreadyExists) {
        try {
          const item = getDb().prepare('SELECT type FROM items WHERE id = ?').get(itemId) as { type: string } | undefined;
          publish(getSystemAddress(), 'tag:item-added', {
            tagId: tag.id,
            tagName: tag.name,
            itemId,
            itemType: item?.type,
          });
        } catch (err) {
          if (DEBUG) console.warn('[datastore] failed to publish tag:item-added (hashtag)', err);
        }
      }
    }
  }
}

/**
 * Update an existing item
 */
export function updateItem(itemId: string, options: ItemOptions): boolean {
  const timestamp = now();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (options.content !== undefined) {
    updates.push('content = ?');
    values.push(options.content);
  }
  if (options.mimeType !== undefined) {
    updates.push('mimeType = ?');
    values.push(options.mimeType);
  }
  if (options.metadata !== undefined) {
    // Get existing item to merge metadata
    const existingItem = getItem(itemId);
    let metadata: Record<string, unknown> = {};

    // Parse existing metadata
    if (existingItem && existingItem.metadata) {
      try {
        metadata = typeof existingItem.metadata === 'string'
          ? JSON.parse(existingItem.metadata)
          : existingItem.metadata;
      } catch {
        // Invalid JSON, start fresh
      }
    }

    // Parse new metadata
    let newMetadata: Record<string, unknown> = {};
    if (options.metadata) {
      try {
        newMetadata = typeof options.metadata === 'string'
          ? JSON.parse(options.metadata)
          : options.metadata;
      } catch {
        // Invalid JSON, use empty object
      }
    }

    // Merge: new metadata overwrites existing, except _sync which is merged
    metadata = { ...metadata, ...newMetadata };

    // Add device metadata for modification
    metadata = addDeviceMetadata(metadata, false);

    updates.push('metadata = ?');
    values.push(JSON.stringify(metadata));
  }
  if (options.syncId !== undefined) {
    updates.push('syncId = ?');
    values.push(options.syncId);
  }
  if (options.starred !== undefined) {
    updates.push('starred = ?');
    values.push(options.starred);
  }
  if (options.archived !== undefined) {
    updates.push('archived = ?');
    values.push(options.archived);
  }
  if (options.title !== undefined) {
    updates.push('title = ?');
    values.push(options.title);
  }
  if (options.favicon !== undefined) {
    updates.push('favicon = ?');
    values.push(options.favicon);
  }
  if (options.visitCount !== undefined) {
    updates.push('visitCount = ?');
    values.push(options.visitCount);
  }
  if (options.lastVisitAt !== undefined) {
    updates.push('lastVisitAt = ?');
    values.push(options.lastVisitAt);
  }
  if (options.frecencyScore !== undefined) {
    updates.push('frecencyScore = ?');
    values.push(options.frecencyScore);
  }

  if (updates.length === 0) return false;

  updates.push('updatedAt = ?');
  values.push(timestamp);
  values.push(itemId);

  const result = getDb().prepare(
    `UPDATE items SET ${updates.join(', ')} WHERE id = ? AND deletedAt = 0`
  ).run(...values);

  // Sync inline hashtags as tags for text items when content changes
  if (result.changes > 0 && options.content !== undefined) {
    const item = getItem(itemId);
    if (item && item.type === 'text') {
      syncContentHashtags(itemId, options.content as string);
    }
  }

  return result.changes > 0;
}

/**
 * Update the title of a URL item if it's currently empty or "Loading..."
 * Used by page.js when the real page title becomes available.
 */
export function updateItemTitle(url: string, title: string): boolean {
  const normalizedUri = normalizeUrl(url);
  const d = getDb();

  // Phase 1: Try exact normalized URL match
  let existing = d.prepare(
    'SELECT id, title FROM items WHERE type = ? AND content = ? AND deletedAt = 0'
  ).get('url', normalizedUri) as { id: string; title: string } | undefined;

  // Phase 2: If no match, try with raw URL (handles cases where normalizeUrl differs)
  if (!existing && url !== normalizedUri) {
    existing = d.prepare(
      'SELECT id, title FROM items WHERE type = ? AND content = ? AND deletedAt = 0'
    ).get('url', url) as { id: string; title: string } | undefined;
  }

  // Phase 3: If still no match, try domain-based lookup for the most recent item
  // missing a title. Handles redirect scenarios (http->https, www->non-www).
  if (!existing) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname;
      existing = d.prepare(
        `SELECT id, title FROM items WHERE type = ? AND domain = ? AND deletedAt = 0
         AND (title = '' OR title IS NULL OR title = 'Loading...')
         ORDER BY updatedAt DESC LIMIT 1`
      ).get('url', domain) as { id: string; title: string } | undefined;
    } catch { /* invalid URL, skip phase 3 */ }
  }

  if (!existing) return false;

  if (!existing.title || existing.title === 'Loading...') {
    d.prepare('UPDATE items SET title = ?, updatedAt = ? WHERE id = ?')
      .run(title, Date.now(), existing.id);
    return true;
  }
  return false;
}

/**
 * Update the favicon of a URL item if it's currently empty.
 * Used by page-favicon-updated handlers and entity enrichment.
 */
export function updateItemFavicon(url: string, faviconUrl: string): boolean {
  const normalizedUri = normalizeUrl(url);
  const d = getDb();

  // Phase 1: Try exact normalized URL match
  let existing = d.prepare(
    'SELECT id, favicon FROM items WHERE type = ? AND content = ? AND deletedAt = 0'
  ).get('url', normalizedUri) as { id: string; favicon: string | null } | undefined;

  // Phase 2: If no match, try with raw URL
  if (!existing && url !== normalizedUri) {
    existing = d.prepare(
      'SELECT id, favicon FROM items WHERE type = ? AND content = ? AND deletedAt = 0'
    ).get('url', url) as { id: string; favicon: string | null } | undefined;
  }

  // Phase 3: Domain-based lookup for the most recent item missing a favicon
  if (!existing) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname;
      existing = d.prepare(
        `SELECT id, favicon FROM items WHERE type = ? AND domain = ? AND deletedAt = 0
         AND (favicon = '' OR favicon IS NULL)
         ORDER BY updatedAt DESC LIMIT 1`
      ).get('url', domain) as { id: string; favicon: string | null } | undefined;
    } catch { /* invalid URL, skip phase 3 */ }
  }

  if (!existing) return false;

  if (!existing.favicon) {
    d.prepare('UPDATE items SET favicon = ?, updatedAt = ? WHERE id = ?')
      .run(faviconUrl, Date.now(), existing.id);
    return true;
  }
  return false;
}

/**
 * Soft delete an item (sets deletedAt timestamp)
 */
export function deleteItem(itemId: string): boolean {
  const timestamp = now();
  const result = getDb().prepare(
    'UPDATE items SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt = 0'
  ).run(timestamp, timestamp, itemId);
  return result.changes > 0;
}

/**
 * Permanently delete an item and its tags
 */
export function hardDeleteItem(itemId: string): boolean {
  getDb().prepare('DELETE FROM item_tags WHERE itemId = ?').run(itemId);
  const result = getDb().prepare('DELETE FROM items WHERE id = ?').run(itemId);
  return result.changes > 0;
}

/**
 * Merge a server item into local database during sync pull.
 *
 * This function is used ONLY for sync operations and bypasses addItem/updateItem
 * to preserve server metadata (including _sync.createdBy, _sync.modifiedBy) without
 * adding local device metadata.
 *
 * @param serverItem - Item from server with all metadata
 * @returns Object with localId and action taken ('inserted' | 'updated' | 'skipped')
 */
export function mergeServerItem(serverItem: {
  id: string;
  type: string;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}): { localId: string; action: 'inserted' | 'updated' | 'skipped' } {
  const db = getDb();

  // Find local item by syncId
  const localItem = db.prepare(
    'SELECT * FROM items WHERE syncId = ?'
  ).get(serverItem.id) as Item | undefined;

  const serverUpdatedAt = serverItem.updatedAt;
  const timestamp = Date.now();
  const metadataJson = serverItem.metadata ? JSON.stringify(serverItem.metadata) : '{}';

  // Item doesn't exist locally - insert it
  if (!localItem) {
    const localId = generateId('item');

    db.prepare(`
      INSERT INTO items (
        id, type, content, metadata, syncId, syncedAt,
        createdAt, updatedAt, deletedAt, starred, archived
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(
      localId,
      serverItem.type,
      serverItem.content || null,
      metadataJson,
      serverItem.id,
      timestamp,
      serverItem.createdAt,
      serverUpdatedAt,
      serverItem.deletedAt || 0
    );

    return { localId, action: 'inserted' };
  }

  // Item exists - check if server is newer
  if (serverUpdatedAt > localItem.updatedAt) {
    // Server is newer - update local
    db.prepare(`
      UPDATE items
      SET content = ?, metadata = ?, updatedAt = ?, syncedAt = ?, deletedAt = ?
      WHERE id = ?
    `).run(
      serverItem.content || null,
      metadataJson,
      serverUpdatedAt,
      timestamp,
      serverItem.deletedAt || 0,
      localItem.id
    );

    return { localId: localItem.id, action: 'updated' };
  }

  // Local is same or newer - skip
  return { localId: localItem.id, action: 'skipped' };
}

/**
 * Query items with optional filters
 */
export function queryItems(filter: ItemFilter = {}): Item[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  // By default, exclude soft-deleted items
  if (!filter.includeDeleted) {
    conditions.push('deletedAt = 0');
  }

  if (filter.type) {
    conditions.push('type = ?');
    values.push(filter.type);
  }
  if (filter.starred !== undefined) {
    conditions.push('starred = ?');
    values.push(filter.starred);
  }
  if (filter.archived !== undefined) {
    conditions.push('archived = ?');
    values.push(filter.archived);
  }
  if (filter.domain) {
    conditions.push('domain = ?');
    values.push(filter.domain);
  }
  if (filter.search) {
    // Search in content (URL), title, and domain
    conditions.push('(content LIKE ? OR title LIKE ? OR domain LIKE ?)');
    const searchPattern = `%${filter.search}%`;
    values.push(searchPattern, searchPattern, searchPattern);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Support multiple sort options
  let orderBy: string;
  switch (filter.sortBy) {
    case 'frecency':
      orderBy = 'starred DESC, frecencyScore DESC, lastVisitAt DESC';
      break;
    case 'lastVisit':
      orderBy = 'lastVisitAt DESC';
      break;
    case 'visitCount':
      orderBy = 'visitCount DESC';
      break;
    case 'updated':
      orderBy = 'updatedAt DESC';
      break;
    case 'created':
    default:
      orderBy = 'createdAt DESC';
  }

  const limit = filter.limit ? `LIMIT ${filter.limit}` : '';

  const rows = getDb().prepare(
    `SELECT * FROM items ${whereClause} ORDER BY ${orderBy} ${limit}`
  ).all(...values) as Item[];

  // Snippet mode: truncate text-item bodies before sending across IPC.
  // URL/entity/image/etc. items keep full content (it's a short URL or ID).
  // 300 chars is enough for title extraction and embedded-URL detection on cards.
  if (filter.contentMode === 'snippet') {
    const SNIPPET_LEN = 300;
    return rows.map(item => {
      if (item.type === 'text' && item.content != null && item.content.length > SNIPPET_LEN) {
        return { ...item, content: item.content.substring(0, SNIPPET_LEN) };
      }
      return item;
    });
  }

  return rows;
}

// ==================== Item-Tag Operations ====================

/**
 * Tag an item
 */
export function tagItem(itemId: string, tagId: string): { link: ItemTag; alreadyExists: boolean } {
  const timestamp = now();

  const existingLink = getDb().prepare(
    'SELECT * FROM item_tags WHERE itemId = ? AND tagId = ?'
  ).get(itemId, tagId) as ItemTag | undefined;

  if (existingLink) {
    return { link: existingLink, alreadyExists: true };
  }

  const linkId = generateId('item_tag');
  getDb().prepare(
    'INSERT INTO item_tags (id, itemId, tagId, createdAt) VALUES (?, ?, ?, ?)'
  ).run(linkId, itemId, tagId, timestamp);

  // Update tag frequency and frecency
  const tag = getDb().prepare('SELECT * FROM tags WHERE id = ?').get(tagId) as Tag | undefined;
  if (tag) {
    const newFrequency = (tag.frequency || 0) + 1;
    const frecencyScore = calculateFrecency(newFrequency, timestamp);
    getDb().prepare(
      'UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?'
    ).run(newFrequency, timestamp, frecencyScore, timestamp, tagId);
  }

  const newLink = getDb().prepare('SELECT * FROM item_tags WHERE id = ?').get(linkId) as ItemTag;
  return { link: newLink, alreadyExists: false };
}

/**
 * Remove a tag from an item
 */
export function untagItem(itemId: string, tagId: string): boolean {
  const result = getDb().prepare(
    'DELETE FROM item_tags WHERE itemId = ? AND tagId = ?'
  ).run(itemId, tagId);
  return result.changes > 0;
}

/**
 * Get all tags for an item
 */
export function getItemTags(itemId: string): Tag[] {
  return getDb().prepare(`
    SELECT t.* FROM tags t
    JOIN item_tags it ON t.id = it.tagId
    WHERE it.itemId = ?
  `).all(itemId) as Tag[];
}

/**
 * Bulk: get tags for every item in one query. Returns a map keyed by itemId.
 * Items with no tags are absent from the map.
 */
export function getAllItemTags(): Record<string, Tag[]> {
  const rows = getDb().prepare(`
    SELECT it.itemId AS _itemId, t.* FROM tags t
    JOIN item_tags it ON t.id = it.tagId
  `).all() as Array<Tag & { _itemId: string }>;
  const result: Record<string, Tag[]> = {};
  for (const row of rows) {
    const { _itemId, ...tag } = row;
    if (!result[_itemId]) result[_itemId] = [];
    result[_itemId].push(tag as Tag);
  }
  return result;
}

/**
 * Get all items with a specific tag
 */
export function getItemsByTag(tagId: string): Item[] {
  return getDb().prepare(`
    SELECT i.* FROM items i
    JOIN item_tags it ON i.id = it.itemId
    WHERE it.tagId = ? AND i.deletedAt = 0
  `).all(tagId) as Item[];
}

// ==================== Item Visit Operations ====================

/**
 * Record a visit to an item. Updates visit stats and frecency score.
 */
export function recordItemVisit(itemId: string, options: ItemVisitOptions = {}): { id: string } {
  const visitId = generateId('item_visit');
  const timestamp = options.timestamp || now();
  const d = getDb();

  // Find the most recent item visit for chaining
  const prevVisit = d.prepare('SELECT id FROM item_visits ORDER BY timestamp DESC LIMIT 1').get() as { id: string } | undefined;
  const prevId = prevVisit ? prevVisit.id : null;

  d.prepare(`
    INSERT INTO item_visits (id, itemId, timestamp, duration, source, sourceId, windowType, metadata, scrollDepth, interacted, prevId, nextId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    visitId,
    itemId,
    timestamp,
    options.duration || 0,
    options.source || 'direct',
    options.sourceId || '',
    options.windowType || 'main',
    options.metadata || '{}',
    options.scrollDepth || 0,
    options.interacted || 0,
    prevId
  );

  // Update nextId on the previous visit
  if (prevId) {
    d.prepare('UPDATE item_visits SET nextId = ? WHERE id = ?').run(visitId, prevId);
  }

  // Update item visit stats and recalculate frecency
  updateItemVisitStats(itemId);

  return { id: visitId };
}

/**
 * Get visits for an item with optional filters
 */
export function getItemVisits(itemId: string, filter: ItemVisitFilter = {}): ItemVisit[] {
  let sql = 'SELECT * FROM item_visits WHERE itemId = ?';
  const params: (string | number)[] = [itemId];

  if (filter.source) {
    sql += ' AND source = ?';
    params.push(filter.source);
  }
  if (filter.since) {
    sql += ' AND timestamp >= ?';
    params.push(filter.since);
  }
  if (filter.until) {
    sql += ' AND timestamp <= ?';
    params.push(filter.until);
  }

  sql += ' ORDER BY timestamp DESC';

  if (filter.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  return getDb().prepare(sql).all(...params) as ItemVisit[];
}

/**
 * Query item visits across all items
 */
export function queryItemVisits(filter: ItemVisitFilter = {}): ItemVisit[] {
  let sql = 'SELECT * FROM item_visits WHERE 1=1';
  const params: (string | number)[] = [];

  if (filter.itemId) {
    sql += ' AND itemId = ?';
    params.push(filter.itemId);
  }
  if (filter.source) {
    sql += ' AND source = ?';
    params.push(filter.source);
  }
  if (filter.since) {
    sql += ' AND timestamp >= ?';
    params.push(filter.since);
  }
  if (filter.until) {
    sql += ' AND timestamp <= ?';
    params.push(filter.until);
  }

  sql += ' ORDER BY timestamp DESC';

  if (filter.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  return getDb().prepare(sql).all(...params) as ItemVisit[];
}

/**
 * Update visit count, lastVisitAt, and frecency score for an item
 */
export function updateItemVisitStats(itemId: string): void {
  const d = getDb();
  const timestamp = now();

  // Get total visit count and last 20 visits (most recent first) for frecency sampling
  const countResult = d.prepare('SELECT COUNT(*) as cnt FROM item_visits WHERE itemId = ?').get(itemId) as { cnt: number };
  const visitCount = countResult.cnt;
  const visits = d.prepare('SELECT timestamp, interacted, source FROM item_visits WHERE itemId = ? ORDER BY timestamp DESC LIMIT 20').all(itemId) as Array<{ timestamp: number; interacted: number; source: string }>;

  const lastVisitAt = visits.length > 0 ? visits[0].timestamp : 0;
  const frecencyScore = calculateItemFrecency(visits, visitCount);

  d.prepare('UPDATE items SET visitCount = ?, lastVisitAt = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?').run(
    visitCount,
    lastVisitAt,
    frecencyScore,
    timestamp,
    itemId
  );
}

/**
 * Unified entry point for tracking navigation.
 * Finds or creates an item for the URL, then records a visit.
 * This is the main API for tracking page loads.
 */
export function trackNavigation(uri: string, options: {
  source?: string;
  sourceId?: string;
  windowType?: string;
  title?: string;
  favicon?: string;
  interacted?: number;
} = {}): { visitId: string; itemId: string; created: boolean } {
  const normalizedUri = normalizeUrl(uri);
  const parsed = parseUrl(normalizedUri);
  const d = getDb();
  let created = false;

  // Find existing item by URL
  const existing = d.prepare('SELECT id FROM items WHERE type = ? AND content = ? AND deletedAt = 0').get('url', normalizedUri) as { id: string } | undefined;

  let itemId: string;
  if (existing) {
    itemId = existing.id;
    // Update title/favicon if provided and item is missing them
    const updates: string[] = [];
    const values: unknown[] = [];

    if (options.title) {
      updates.push('title = CASE WHEN title = \'\' OR title IS NULL OR title = \'Loading...\' THEN ? ELSE title END');
      values.push(options.title);
    }
    if (options.favicon) {
      updates.push('favicon = CASE WHEN favicon = \'\' OR favicon IS NULL THEN ? ELSE favicon END');
      values.push(options.favicon);
    }

    if (updates.length > 0) {
      values.push(itemId);
      d.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  } else {
    // Create new item for this URL
    itemId = generateId('item');
    const timestamp = now();
    created = true;

    const metadata: Record<string, unknown> = {};
    if (options.title) metadata.title = options.title;
    if (options.favicon) metadata.favicon = options.favicon;

    d.prepare(`
      INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt, deletedAt, starred, archived, visitCount, lastVisitAt, frecencyScore, title, domain, favicon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?)
    `).run(
      itemId,
      'url',
      normalizedUri,
      'text/html',
      JSON.stringify(metadata),
      '',
      timestamp,
      timestamp,
      options.title || '',
      parsed.domain,
      options.favicon || ''
    );

    // Tag navigation-created items as history so they're hidden from default views
    const { tag: historyTag } = getOrCreateTag('from:history');
    const { alreadyExists } = tagItem(itemId, historyTag.id);
    if (!alreadyExists) {
      try {
        publish(getSystemAddress(), 'tag:item-added', {
          tagId: historyTag.id,
          tagName: historyTag.name,
          itemId,
          itemType: 'url',
        });
      } catch (err) {
        if (DEBUG) console.warn('[datastore] failed to publish tag:item-added (history)', err);
      }
    }
  }

  // Record the visit
  const visit = recordItemVisit(itemId, {
    source: options.source || 'window',
    sourceId: options.sourceId || '',
    windowType: options.windowType || 'main',
    interacted: options.interacted || 0,
  });

  return { visitId: visit.id, itemId, created };
}

/**
 * Query items by frecency, optimized for history/omnibox use cases.
 * Returns URL items sorted by frecency score.
 */
export function queryItemsByFrecency(filter: {
  search?: string;
  domain?: string;
  limit?: number;
  since?: number;
} = {}): Item[] {
  const conditions: string[] = ['type = ?', 'deletedAt = 0'];
  const values: unknown[] = ['url'];

  if (filter.search) {
    conditions.push('(content LIKE ? OR title LIKE ? OR domain LIKE ?)');
    const searchPattern = `%${filter.search}%`;
    values.push(searchPattern, searchPattern, searchPattern);
  }
  if (filter.domain) {
    conditions.push('domain = ?');
    values.push(filter.domain);
  }
  if (filter.since) {
    conditions.push('lastVisitAt >= ?');
    values.push(filter.since);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = filter.limit ? `LIMIT ${filter.limit}` : 'LIMIT 50';

  return getDb().prepare(
    `SELECT * FROM items ${whereClause} ORDER BY starred DESC, frecencyScore DESC, lastVisitAt DESC ${limit}`
  ).all(...values) as Item[];
}

// ==================== Item Events (Series & Feeds) ====================

/**
 * Add an event/entry to a series or feed item
 */
export function addItemEvent(itemId: string, options: ItemEventOptions = {}): { id: string } {
  const eventId = generateId('event');
  const timestamp = now();

  getDb().prepare(`
    INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    itemId,
    options.content ?? null,
    options.value ?? null,
    options.occurredAt ?? timestamp,
    options.metadata || '{}',
    timestamp
  );

  return { id: eventId };
}

/**
 * Get an event by ID
 */
export function getItemEvent(eventId: string): ItemEvent | null {
  const result = getDb().prepare('SELECT * FROM item_events WHERE id = ?').get(eventId);
  return (result as ItemEvent) || null;
}

/**
 * Query events for a series or feed
 */
export function queryItemEvents(filter: ItemEventFilter = {}): ItemEvent[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.itemId) {
    conditions.push('itemId = ?');
    values.push(filter.itemId);
  }
  if (filter.itemIds && filter.itemIds.length > 0) {
    const placeholders = filter.itemIds.map(() => '?').join(', ');
    conditions.push(`itemId IN (${placeholders})`);
    values.push(...filter.itemIds);
  }
  if (filter.since) {
    conditions.push('occurredAt >= ?');
    values.push(filter.since);
  }
  if (filter.until) {
    conditions.push('occurredAt <= ?');
    values.push(filter.until);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = filter.order === 'asc' ? 'ASC' : 'DESC';
  const limit = filter.limit ? `LIMIT ${filter.limit}` : '';
  const offset = filter.offset ? `OFFSET ${filter.offset}` : '';

  return getDb().prepare(
    `SELECT * FROM item_events ${whereClause} ORDER BY occurredAt ${order} ${limit} ${offset}`
  ).all(...values) as ItemEvent[];
}

/**
 * Delete an event by ID
 */
export function deleteItemEvent(eventId: string): boolean {
  const result = getDb().prepare('DELETE FROM item_events WHERE id = ?').run(eventId);
  return result.changes > 0;
}

/**
 * Delete all events for an item (used when deleting a series or feed)
 */
export function deleteItemEvents(itemId: string): number {
  const result = getDb().prepare('DELETE FROM item_events WHERE itemId = ?').run(itemId);
  return result.changes;
}

/**
 * Get the latest event for a series or feed
 */
export function getLatestItemEvent(itemId: string): ItemEvent | null {
  const result = getDb().prepare(
    'SELECT * FROM item_events WHERE itemId = ? ORDER BY occurredAt DESC LIMIT 1'
  ).get(itemId);
  return (result as ItemEvent) || null;
}

/**
 * Count events for a series or feed
 */
export function countItemEvents(itemId: string, filter: { since?: number; until?: number } = {}): number {
  const conditions: string[] = ['itemId = ?'];
  const values: unknown[] = [itemId];

  if (filter.since) {
    conditions.push('occurredAt >= ?');
    values.push(filter.since);
  }
  if (filter.until) {
    conditions.push('occurredAt <= ?');
    values.push(filter.until);
  }

  const result = getDb().prepare(
    `SELECT COUNT(*) as count FROM item_events WHERE ${conditions.join(' AND ')}`
  ).get(...values) as { count: number };

  return result.count;
}
