use rusqlite::{params, Connection};
use crate::helpers::generate_tag_id;
use crate::types::SCHEMA_VERSION;

/// Initialize the database schema, running all migrations as needed.
/// Takes an open Connection — caller is responsible for opening the DB at the right path.
/// Returns the device_id (generated or loaded from settings).
pub fn ensure_database_initialized(conn: &Connection) -> Result<String, String> {
    // Enable WAL mode for concurrent access from main app and share extension
    if let Err(e) = conn.execute_batch("PRAGMA journal_mode=WAL;") {
        return Err(format!("Failed to set WAL mode: {}", e));
    }

    // Multi-process safety: wait up to 5s if another process holds the lock
    let _ = conn.execute_batch("PRAGMA busy_timeout=5000;");

    // Checkpoint any existing WAL data from other processes (e.g. share extension)
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");

    // Check if we need to migrate from old schema (urls table) to new schema (items table)
    let has_urls_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='urls'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    let has_items_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='items'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if has_urls_table && !has_items_table {
        // Migration needed: urls -> items
        println!("[peek-core] Migrating database from urls to items schema...");
        if let Err(e) = conn.execute_batch(
            "
                -- Create new items table
                CREATE TABLE items (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL DEFAULT 'url',
                    url TEXT,
                    content TEXT,
                    metadata TEXT,
                    sync_id TEXT DEFAULT '',
                    sync_source TEXT DEFAULT '',
                    synced_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );

                -- Migrate data from urls to items
                INSERT INTO items (id, type, url, created_at, updated_at, deleted_at)
                    SELECT id, 'url', url, created_at, updated_at, deleted_at FROM urls;

                -- Create new item_tags table
                CREATE TABLE item_tags (
                    item_id TEXT NOT NULL,
                    tag_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (item_id, tag_id),
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
                    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );

                -- Migrate data from url_tags to item_tags
                INSERT INTO item_tags (item_id, tag_id, created_at)
                    SELECT url_id, tag_id, created_at FROM url_tags;

                -- Drop old tables
                DROP TABLE url_tags;
                DROP TABLE urls;

                -- Create indexes for new tables
                CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
                CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
                CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);
                CREATE INDEX IF NOT EXISTS idx_items_sync_id ON items(sync_id);
                ",
        ) {
            return Err(format!("Failed to migrate database: {}", e));
        }
        println!("[peek-core] Database migration completed successfully");
    } else if !has_items_table {
        // Fresh install: create new schema
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS items (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL DEFAULT 'url' CHECK(type IN ('url', 'text', 'tagset', 'image', 'series', 'feed', 'entity')),
                    url TEXT,
                    content TEXT,
                    metadata TEXT,
                    sync_id TEXT DEFAULT '',
                    sync_source TEXT DEFAULT '',
                    synced_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );

                CREATE TABLE IF NOT EXISTS tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    frequency INTEGER NOT NULL DEFAULT 0,
                    lastUsed TEXT NOT NULL,
                    frecencyScore REAL NOT NULL DEFAULT 0.0,
                    createdAt TEXT NOT NULL,
                    updatedAt TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS item_tags (
                    item_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (item_id, tag_id),
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
                    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS blobs (
                    id TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL,
                    data BLOB NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    thumbnail BLOB,
                    data_hash TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_blobs_hash ON blobs(data_hash);

                CREATE TABLE IF NOT EXISTS item_visits (
                    id TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    duration INTEGER DEFAULT 0,
                    source TEXT DEFAULT 'direct',
                    window_type TEXT DEFAULT 'main',
                    metadata TEXT DEFAULT '{}',
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
                CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
                CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);
                CREATE INDEX IF NOT EXISTS idx_items_sync_id ON items(sync_id);
                CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
                CREATE INDEX IF NOT EXISTS idx_tags_frecency ON tags(frecencyScore DESC);
                CREATE INDEX IF NOT EXISTS idx_blobs_item ON blobs(item_id);
                CREATE INDEX IF NOT EXISTS idx_item_visits_item ON item_visits(item_id);
                CREATE INDEX IF NOT EXISTS idx_item_visits_timestamp ON item_visits(timestamp);

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS offline_content (
                    item_id TEXT PRIMARY KEY,
                    fetched_at TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS item_events (
                    id TEXT PRIMARY KEY NOT NULL,
                    itemId TEXT NOT NULL,
                    content TEXT,
                    value REAL,
                    occurredAt INTEGER NOT NULL,
                    metadata TEXT DEFAULT '{}',
                    createdAt INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_item_events_item_time ON item_events(itemId, occurredAt DESC);
                CREATE INDEX IF NOT EXISTS idx_item_events_occurred ON item_events(occurredAt DESC);
                ",
        ) {
            return Err(format!("Failed to create tables: {}", e));
        }
    }

    // Add metadata column if it doesn't exist (for existing installs)
    let has_metadata_column: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('items') WHERE name='metadata'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_metadata_column {
        println!("[peek-core] Adding metadata column to items table...");
        if let Err(e) = conn.execute("ALTER TABLE items ADD COLUMN metadata TEXT", []) {
            println!("[peek-core] Warning: Failed to add metadata column: {}", e);
            // Not fatal - column may already exist
        }
    }

    // Add sync columns if they don't exist (for existing installs)
    let has_sync_id: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('items') WHERE name='sync_id'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_sync_id {
        println!("[peek-core] Adding sync columns to items table...");
        let _ = conn.execute("ALTER TABLE items ADD COLUMN sync_id TEXT DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE items ADD COLUMN sync_source TEXT DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE items ADD COLUMN synced_at TEXT", []);
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_items_sync_id ON items(sync_id)");
    }

    // Migrate 'page' type items to 'url' (for existing installs with old type name)
    let page_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM items WHERE type = 'page'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if page_count > 0 {
        println!("[peek-core] Migrating {} 'page' items to 'url' type...", page_count);
        if let Err(e) = conn.execute("UPDATE items SET type = 'url' WHERE type = 'page'", []) {
            println!("[peek-core] Warning: Failed to migrate page items: {}", e);
        } else {
            println!("[peek-core] Page to URL migration complete");
        }
    }

    // Migrate tags table columns from snake_case to camelCase
    let has_last_used_snake: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name='last_used'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if has_last_used_snake {
        println!("[peek-core] Migrating tags table columns from snake_case to camelCase...");
        // SQLite 3.25+ supports RENAME COLUMN
        let renames = [
            ("last_used", "lastUsed"),
            ("frecency_score", "frecencyScore"),
            ("created_at", "createdAt"),
            ("updated_at", "updatedAt"),
        ];
        for (old_name, new_name) in renames {
            let sql = format!("ALTER TABLE tags RENAME COLUMN {} TO {}", old_name, new_name);
            if let Err(e) = conn.execute(&sql, []) {
                println!("[peek-core] Warning: Failed to rename column {} to {}: {}", old_name, new_name, e);
            } else {
                println!("[peek-core] Renamed tags.{} to tags.{}", old_name, new_name);
            }
        }
        // Recreate index with new column name
        let _ = conn.execute("DROP INDEX IF EXISTS idx_tags_frecency", []);
        let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_tags_frecency ON tags(frecencyScore DESC)", []);
        println!("[peek-core] Tags table migration complete");
    }

    // Ensure blobs table exists (for existing installs)
    let has_blobs_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='blobs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_blobs_table {
        println!("[peek-core] Creating blobs table for image support...");
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS blobs (
                    id TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL,
                    data BLOB NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    thumbnail BLOB,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_blobs_item ON blobs(item_id);
                ",
        ) {
            println!("[peek-core] Warning: Failed to create blobs table: {}", e);
        }
    }

    // Add data_hash column to blobs for image dedup
    let has_data_hash: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('blobs') WHERE name='data_hash'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_data_hash {
        let _ = conn.execute("ALTER TABLE blobs ADD COLUMN data_hash TEXT", []);
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_blobs_hash ON blobs(data_hash)");
    }

    // Ensure settings table exists (for migration case)
    if let Err(e) = conn.execute_batch(
        "
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
    ) {
        return Err(format!("Failed to ensure settings table: {}", e));
    }

    // Ensure item_visits table exists (for existing installs)
    let has_item_visits_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='item_visits'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_item_visits_table {
        println!("[peek-core] Creating item_visits table for visit tracking...");
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS item_visits (
                    id TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    duration INTEGER DEFAULT 0,
                    source TEXT DEFAULT 'direct',
                    window_type TEXT DEFAULT 'main',
                    metadata TEXT DEFAULT '{}',
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_item_visits_item ON item_visits(item_id);
                CREATE INDEX IF NOT EXISTS idx_item_visits_timestamp ON item_visits(timestamp);
                ",
        ) {
            println!("[peek-core] Warning: Failed to create item_visits table: {}", e);
        }
    }

    // Ensure offline_content index table exists (for offline reading feature)
    let has_offline_content_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='offline_content'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_offline_content_table {
        println!("[peek-core] Creating offline_content table for offline reading...");
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS offline_content (
                    item_id TEXT PRIMARY KEY,
                    fetched_at TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL
                );
                ",
        ) {
            println!("[peek-core] Warning: Failed to create offline_content table: {}", e);
        }
    }

    // Ensure item_events table exists (for existing installs, needed for sync)
    let has_item_events_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='item_events'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_item_events_table {
        println!("[peek-core] Creating item_events table for series/feed events...");
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS item_events (
                    id TEXT PRIMARY KEY NOT NULL,
                    itemId TEXT NOT NULL,
                    content TEXT,
                    value REAL,
                    occurredAt INTEGER NOT NULL,
                    metadata TEXT DEFAULT '{}',
                    createdAt INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_item_events_item_time ON item_events(itemId, occurredAt DESC);
                CREATE INDEX IF NOT EXISTS idx_item_events_occurred ON item_events(occurredAt DESC);
                ",
        ) {
            println!("[peek-core] Warning: Failed to create item_events table: {}", e);
        }
    }

    // Migrate tags.id from INTEGER to TEXT (for existing installs with old schema)
    let tags_has_integer_id: bool = conn
        .query_row(
            "SELECT type FROM pragma_table_info('tags') WHERE name='id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|t| t.to_uppercase() == "INTEGER")
        .unwrap_or(false);

    if tags_has_integer_id {
        println!("[peek-core] Migrating tags.id from INTEGER to TEXT...");

        // Use savepoint for atomic rollback on error
        if let Err(e) = conn.execute("SAVEPOINT before_tag_migration", []) {
            println!("[peek-core] Failed to create savepoint: {}", e);
        } else {
            let migration_result: Result<(), String> = (|| {
                // Step 1: Create temp mapping table
                conn.execute_batch(
                    "CREATE TEMP TABLE tag_id_mapping (
                        old_id INTEGER PRIMARY KEY,
                        new_id TEXT NOT NULL
                    );"
                ).map_err(|e| format!("Failed to create mapping table: {}", e))?;

                // Step 2: Populate mapping with generated TEXT IDs
                let mut stmt = conn.prepare("SELECT id FROM tags")
                    .map_err(|e| format!("Failed to prepare tag select: {}", e))?;
                let old_ids: Vec<i64> = stmt
                    .query_map([], |row| row.get::<_, i64>(0))
                    .map_err(|e| format!("Failed to query tags: {}", e))?
                    .filter_map(|r| r.ok())
                    .collect();
                drop(stmt);

                for old_id in old_ids {
                    let new_id = generate_tag_id();
                    conn.execute(
                        "INSERT INTO tag_id_mapping (old_id, new_id) VALUES (?, ?)",
                        params![old_id, new_id],
                    ).map_err(|e| format!("Failed to insert mapping: {}", e))?;
                }

                // Step 3: Create new tables with TEXT schema
                conn.execute_batch(
                    "CREATE TABLE tags_new (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL UNIQUE,
                        frequency INTEGER NOT NULL DEFAULT 0,
                        lastUsed TEXT NOT NULL,
                        frecencyScore REAL NOT NULL DEFAULT 0.0,
                        createdAt TEXT NOT NULL,
                        updatedAt TEXT NOT NULL
                    );

                    CREATE TABLE item_tags_new (
                        item_id TEXT NOT NULL,
                        tag_id TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        PRIMARY KEY (item_id, tag_id),
                        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
                        FOREIGN KEY (tag_id) REFERENCES tags_new(id) ON DELETE CASCADE
                    );"
                ).map_err(|e| format!("Failed to create new tables: {}", e))?;

                // Step 4: Copy data using mapping
                conn.execute_batch(
                    "INSERT INTO tags_new (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
                    SELECT m.new_id, t.name, t.frequency, t.lastUsed, t.frecencyScore, t.createdAt, t.updatedAt
                    FROM tags t
                    JOIN tag_id_mapping m ON t.id = m.old_id;

                    INSERT INTO item_tags_new (item_id, tag_id, created_at)
                    SELECT it.item_id, m.new_id, it.created_at
                    FROM item_tags it
                    JOIN tag_id_mapping m ON it.tag_id = m.old_id;"
                ).map_err(|e| format!("Failed to copy data: {}", e))?;

                // Step 5: Swap tables
                conn.execute_batch(
                    "DROP TABLE item_tags;
                    DROP TABLE tags;
                    ALTER TABLE tags_new RENAME TO tags;
                    ALTER TABLE item_tags_new RENAME TO item_tags;

                    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
                    CREATE INDEX IF NOT EXISTS idx_tags_frecency ON tags(frecencyScore DESC);"
                ).map_err(|e| format!("Failed to swap tables: {}", e))?;

                // Cleanup temp table
                let _ = conn.execute("DROP TABLE IF EXISTS tag_id_mapping", []);

                Ok(())
            })();

            match migration_result {
                Ok(()) => {
                    let _ = conn.execute("RELEASE SAVEPOINT before_tag_migration", []);
                    println!("[peek-core] Tags INTEGER->TEXT migration completed successfully");
                }
                Err(e) => {
                    println!("[peek-core] Tags migration failed, rolling back: {}", e);
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT before_tag_migration", []);
                    let _ = conn.execute("RELEASE SAVEPOINT before_tag_migration", []);
                }
            }
        }
    }

    // Ensure tags table exists (for fresh install or if migration skipped)
    let has_tags_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tags'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_tags_table {
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    frequency INTEGER NOT NULL DEFAULT 0,
                    lastUsed TEXT NOT NULL,
                    frecencyScore REAL NOT NULL DEFAULT 0.0,
                    createdAt TEXT NOT NULL,
                    updatedAt TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS item_tags (
                    item_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (item_id, tag_id),
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
                    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
                CREATE INDEX IF NOT EXISTS idx_tags_frecency ON tags(frecencyScore DESC);
                ",
        ) {
            return Err(format!("Failed to create tags tables: {}", e));
        }
    }

    // One-time dedup migration: remove duplicate items
    run_dedup_cleanup(conn);

    // Write schema version to settings table for compatibility tracking.
    let _ = conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
        params![SCHEMA_VERSION],
    );

    // Initialize device ID (generate and store if missing)
    let device_id: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'device_id'", [], |row| row.get(0))
        .unwrap_or_default();

    let device_id = if device_id.is_empty() {
        let new_id = uuid::Uuid::new_v4().to_string();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('device_id', ?1)",
            params![&new_id],
        );
        println!("[peek-core] Generated new device ID: {}", new_id);
        new_id
    } else {
        println!("[peek-core] Loaded existing device ID: {}", device_id);
        device_id
    };

    println!("[peek-core] Database initialized successfully (schema version {})", SCHEMA_VERSION);

    Ok(device_id)
}

/// One-time dedup migration: remove duplicate items.
fn run_dedup_cleanup(conn: &Connection) {
    let dedup_done: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'dedup_cleanup_v1'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if dedup_done {
        return;
    }

    println!("[peek-core] Running one-time dedup cleanup...");
    let mut total_removed: i64 = 0;

    // --- Deduplicate url items by (type, url) ---
    {
        let mut dup_stmt = conn
            .prepare(
                "SELECT type, url, COUNT(*) as cnt FROM items \
                 WHERE deleted_at IS NULL AND type = 'url' AND url IS NOT NULL AND url != '' \
                 GROUP BY type, url HAVING cnt > 1",
            )
            .unwrap();
        let dup_groups: Vec<(String, String)> = dup_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        for (item_type, url_val) in &dup_groups {
            let mut item_stmt = conn
                .prepare(
                    "SELECT id, sync_id, updated_at FROM items \
                     WHERE type = ?1 AND url = ?2 AND deleted_at IS NULL \
                     ORDER BY \
                       CASE WHEN sync_id IS NOT NULL AND sync_id != '' THEN 0 ELSE 1 END, \
                       updated_at DESC",
                )
                .unwrap();
            let items: Vec<String> = item_stmt
                .query_map(params![item_type, url_val], |row| row.get::<_, String>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();

            for id in items.iter().skip(1) {
                let _ = conn.execute("DELETE FROM item_tags WHERE item_id = ?1", params![id]);
                let _ = conn.execute("DELETE FROM items WHERE id = ?1", params![id]);
                total_removed += 1;
            }
        }
    }

    // --- Deduplicate text items by (type, content) ---
    {
        let mut dup_stmt = conn
            .prepare(
                "SELECT type, content, COUNT(*) as cnt FROM items \
                 WHERE deleted_at IS NULL AND type = 'text' AND content IS NOT NULL AND content != '' \
                 GROUP BY type, content HAVING cnt > 1",
            )
            .unwrap();
        let dup_groups: Vec<(String, String)> = dup_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        for (item_type, content_val) in &dup_groups {
            let mut item_stmt = conn
                .prepare(
                    "SELECT id, sync_id, updated_at FROM items \
                     WHERE type = ?1 AND content = ?2 AND deleted_at IS NULL \
                     ORDER BY \
                       CASE WHEN sync_id IS NOT NULL AND sync_id != '' THEN 0 ELSE 1 END, \
                       updated_at DESC",
                )
                .unwrap();
            let items: Vec<String> = item_stmt
                .query_map(params![item_type, content_val], |row| row.get::<_, String>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();

            for id in items.iter().skip(1) {
                let _ = conn.execute("DELETE FROM item_tags WHERE item_id = ?1", params![id]);
                let _ = conn.execute("DELETE FROM items WHERE id = ?1", params![id]);
                total_removed += 1;
            }
        }
    }

    // --- Deduplicate tagsets by sorted tag names ---
    {
        let mut ts_stmt = conn
            .prepare(
                "SELECT id, sync_id, updated_at FROM items \
                 WHERE type = 'tagset' AND deleted_at IS NULL",
            )
            .unwrap();
        let tagsets: Vec<(String, String, String)> = ts_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        let mut groups: std::collections::HashMap<String, Vec<(String, String, String)>> =
            std::collections::HashMap::new();

        for (id, sync_id, updated_at) in &tagsets {
            let mut tag_stmt = conn
                .prepare(
                    "SELECT t.name FROM tags t \
                     JOIN item_tags it ON t.id = it.tag_id \
                     WHERE it.item_id = ?1 \
                     ORDER BY t.name",
                )
                .unwrap();
            let tag_names: Vec<String> = tag_stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            let key = tag_names.join("\0");
            groups
                .entry(key)
                .or_default()
                .push((id.clone(), sync_id.clone(), updated_at.clone()));
        }

        for items in groups.values_mut() {
            if items.len() <= 1 {
                continue;
            }

            // Sort: prefer sync_id, then newest updated_at
            items.sort_by(|a, b| {
                let a_has_sync = if !a.1.is_empty() { 0 } else { 1 };
                let b_has_sync = if !b.1.is_empty() { 0 } else { 1 };
                if a_has_sync != b_has_sync {
                    return a_has_sync.cmp(&b_has_sync);
                }
                b.2.cmp(&a.2)
            });

            for item in items.iter().skip(1) {
                let _ = conn.execute("DELETE FROM item_tags WHERE item_id = ?1", params![item.0]);
                let _ = conn.execute("DELETE FROM items WHERE id = ?1", params![item.0]);
                total_removed += 1;
            }
        }
    }

    // Set flag
    let _ = conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('dedup_cleanup_v1', '1')",
        [],
    );

    if total_removed > 0 {
        println!("[peek-core] Dedup cleanup: removed {} duplicate items", total_removed);
    } else {
        println!("[peek-core] Dedup cleanup: no duplicates found");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_memory_db() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn test_fresh_install_creates_all_tables() {
        let conn = open_memory_db();
        let device_id = ensure_database_initialized(&conn).unwrap();
        assert!(!device_id.is_empty());

        // Verify all tables exist
        let tables = ["items", "tags", "item_tags", "blobs", "item_visits",
                       "settings", "offline_content", "item_events"];
        for table in tables {
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{}'", table),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "Table '{}' should exist", table);
        }
    }

    #[test]
    fn test_device_id_persists() {
        let conn = open_memory_db();
        let id1 = ensure_database_initialized(&conn).unwrap();
        // Running again should return same device_id
        let id2 = ensure_database_initialized(&conn).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_schema_version_written() {
        let conn = open_memory_db();
        ensure_database_initialized(&conn).unwrap();

        let version: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'schema_version'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn test_idempotent_initialization() {
        let conn = open_memory_db();
        // Running twice should not error
        ensure_database_initialized(&conn).unwrap();
        ensure_database_initialized(&conn).unwrap();
    }

    #[test]
    fn test_items_table_type_constraint() {
        let conn = open_memory_db();
        ensure_database_initialized(&conn).unwrap();

        // Valid types should work
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO items (id, type, url, created_at, updated_at) VALUES ('1', 'url', 'https://test.com', ?1, ?1)",
            params![&now],
        ).unwrap();

        conn.execute(
            "INSERT INTO items (id, type, content, created_at, updated_at) VALUES ('2', 'text', 'hello', ?1, ?1)",
            params![&now],
        ).unwrap();
    }

    #[test]
    fn test_dedup_runs_once() {
        let conn = open_memory_db();
        ensure_database_initialized(&conn).unwrap();

        // Check dedup flag was set
        let flag: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'dedup_cleanup_v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(flag, 1);
    }
}
