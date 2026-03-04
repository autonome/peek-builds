/**
 * Peek datastore writer
 *
 * Creates and writes to a Peek-compatible SQLite database,
 * using the same schema as the Peek desktop app.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';

let db: Database.Database | null = null;

/**
 * Generate a unique ID matching Peek's format
 */
function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function now(): number {
  return Date.now();
}

/**
 * Open or create a Peek-compatible database
 */
export function openDatabase(dbPath: string): void {
  const isNew = !existsSync(dbPath);
  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  if (isNew) {
    initializeSchema();
  } else {
    // Verify it has the expected tables
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map(t => t.name));
    if (!tableNames.has('items') || !tableNames.has('tags') || !tableNames.has('item_tags')) {
      initializeSchema();
    }
  }
}

/**
 * Initialize the database with Peek's schema
 */
function initializeSchema(): void {
  if (!db) throw new Error('Database not opened');

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
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
    );
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_syncId ON items(syncId);
    CREATE INDEX IF NOT EXISTS idx_items_deletedAt ON items(deletedAt);
    CREATE INDEX IF NOT EXISTS idx_items_createdAt ON items(createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_items_starred ON items(starred);
    CREATE INDEX IF NOT EXISTS idx_items_lastVisitAt ON items(lastVisitAt);
    CREATE INDEX IF NOT EXISTS idx_items_visitCount ON items(visitCount);
    CREATE INDEX IF NOT EXISTS idx_items_frecencyScore ON items(frecencyScore DESC);
    CREATE INDEX IF NOT EXISTS idx_items_domain ON items(domain);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT,
      color TEXT DEFAULT '#999999',
      parentId TEXT DEFAULT '',
      description TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      createdAt INTEGER,
      updatedAt INTEGER,
      frequency INTEGER DEFAULT 0,
      lastUsed INTEGER DEFAULT 0,
      frecencyScore REAL DEFAULT 0.0
    );
    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
    CREATE INDEX IF NOT EXISTS idx_tags_parentId ON tags(parentId);
    CREATE INDEX IF NOT EXISTS idx_tags_frecencyScore ON tags(frecencyScore DESC);

    CREATE TABLE IF NOT EXISTS item_tags (
      id TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      tagId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_item_tags_itemId ON item_tags(itemId);
    CREATE INDEX IF NOT EXISTS idx_item_tags_tagId ON item_tags(tagId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_item_tags_unique ON item_tags(itemId, tagId);

    CREATE TABLE IF NOT EXISTS item_events (
      id TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      content TEXT,
      value REAL,
      occurredAt INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_item_events_item_time ON item_events(itemId, occurredAt DESC);
    CREATE INDEX IF NOT EXISTS idx_item_events_occurred ON item_events(occurredAt DESC);
  `);
}

/**
 * Check if a URL item already exists in the database
 */
export function itemExistsByUrl(url: string): boolean {
  if (!db) throw new Error('Database not opened');
  const row = db.prepare(
    "SELECT id FROM items WHERE type = 'url' AND content = ? AND deletedAt = 0"
  ).get(url);
  return !!row;
}

/**
 * Create a new item in the database
 */
export function createItem(options: {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  title?: string;
  visitCount?: number;
  lastVisitAt?: number;
}): string {
  if (!db) throw new Error('Database not opened');

  const itemId = generateId('item');
  const timestamp = now();
  const metadataJson = JSON.stringify(options.metadata || {});

  let domain = '';
  if (options.type === 'url' && options.content) {
    try {
      const parsed = new URL(options.content);
      domain = parsed.hostname;
    } catch {
      // not a valid URL
    }
  }

  db.prepare(`
    INSERT INTO items (id, type, content, mimeType, metadata, syncId, createdAt, updatedAt,
                       deletedAt, starred, archived, visitCount, lastVisitAt, frecencyScore,
                       title, domain, favicon)
    VALUES (?, ?, ?, '', ?, '', ?, ?, 0, 0, 0, ?, ?, 0, ?, ?, '')
  `).run(
    itemId,
    options.type,
    options.content,
    metadataJson,
    timestamp,
    timestamp,
    options.visitCount || 0,
    options.lastVisitAt || 0,
    options.title || '',
    domain,
  );

  return itemId;
}

/**
 * Get or create a tag by name (matching Peek's logic)
 */
export function getOrCreateTag(name: string): { tagId: string; created: boolean } {
  if (!db) throw new Error('Database not opened');

  const slug = name.toLowerCase().trim().replace(/\s+/g, '-');
  const existing = db.prepare(
    'SELECT id FROM tags WHERE LOWER(name) = LOWER(?)'
  ).get(name) as { id: string } | undefined;

  if (existing) {
    return { tagId: existing.id, created: false };
  }

  const tagId = generateId('tag');
  const timestamp = now();

  db.prepare(`
    INSERT INTO tags (id, name, slug, color, parentId, description, metadata, createdAt, updatedAt, frequency, lastUsed, frecencyScore)
    VALUES (?, ?, ?, '#999999', '', '', '{}', ?, ?, 0, 0, 0)
  `).run(tagId, name.trim(), slug, timestamp, timestamp);

  return { tagId, created: true };
}

/**
 * Tag an item (create a link in item_tags)
 */
export function tagItem(itemId: string, tagId: string): boolean {
  if (!db) throw new Error('Database not opened');

  // Check if already tagged
  const existing = db.prepare(
    'SELECT id FROM item_tags WHERE itemId = ? AND tagId = ?'
  ).get(itemId, tagId);

  if (existing) return false;

  const linkId = generateId('item_tag');
  const timestamp = now();

  db.prepare(
    'INSERT INTO item_tags (id, itemId, tagId, createdAt) VALUES (?, ?, ?, ?)'
  ).run(linkId, itemId, tagId, timestamp);

  return true;
}

/**
 * Run a function inside a transaction for performance
 */
export function runInTransaction<T>(fn: () => T): T {
  if (!db) throw new Error('Database not opened');
  return db.transaction(fn)();
}

/**
 * Close the database
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
