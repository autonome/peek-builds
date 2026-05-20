//! Sync database operations for peek-core.
//!
//! Contains all sync-related DB operations: get/set last_sync, merge server items,
//! get items to push, mark items synced, etc. HTTP transport stays in lib.rs.

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::helpers::{calculate_frecency, generate_tag_id};
use crate::types::ServerItem;

/// An item ready to be pushed to the server.
pub struct PushItem {
    pub id: String,
    pub item_type: String,
    pub url: Option<String>,
    pub content: Option<String>,
    pub metadata: String,
    pub updated_at: String,
    pub sync_id: String,
    pub deleted_at: Option<String>,
}

/// Helper to convert ISO string to chrono DateTime<Utc>.
pub fn parse_iso_datetime(iso: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Convert Unix milliseconds to an ISO 8601 string for local DB storage.
pub fn unix_ms_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

/// Convert Unix milliseconds to a DateTime<Utc> for timestamp comparison.
pub fn unix_ms_to_datetime(ms: i64) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::from_timestamp_millis(ms)
}

/// Get the last sync timestamp from the settings table.
pub fn get_last_sync(conn: &Connection) -> Result<Option<String>, String> {
    let last_sync: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_sync'",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok(last_sync)
}

/// Set the last sync timestamp in the settings table.
pub fn set_last_sync(conn: &Connection, timestamp: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_sync', ?)",
        params![timestamp],
    )
    .map_err(|e| format!("Failed to set last_sync: {}", e))?;
    Ok(())
}

/// Count items that need to be pushed to the server.
pub fn get_pending_sync_count(conn: &Connection) -> Result<usize, String> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE (deleted_at IS NULL AND (synced_at IS NULL OR updated_at > synced_at)) OR (deleted_at IS NOT NULL AND sync_id IS NOT NULL AND sync_id != '' AND synced_at IS NOT NULL AND updated_at > synced_at)",
        [],
        |row| row.get(0),
    )
    .unwrap_or(0);
    Ok(count as usize)
}

/// Get items that need to be pushed (never synced or locally modified after their last sync).
pub fn get_items_to_push(conn: &Connection) -> Result<Vec<PushItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, type, url, content, COALESCE(metadata, ''), updated_at, COALESCE(sync_id, ''), deleted_at FROM items
             WHERE (deleted_at IS NULL AND (synced_at IS NULL OR updated_at > synced_at))
             OR (deleted_at IS NOT NULL AND sync_id IS NOT NULL AND sync_id != '' AND synced_at IS NOT NULL AND updated_at > synced_at)"
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let items: Vec<PushItem> = stmt
        .query_map([], |row| {
            Ok(PushItem {
                id: row.get(0)?,
                item_type: row.get(1)?,
                url: row.get(2)?,
                content: row.get(3)?,
                metadata: row.get(4)?,
                updated_at: row.get(5)?,
                sync_id: row.get(6)?,
                deleted_at: row.get(7)?,
            })
        })
        .map_err(|e| format!("Failed to query items: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(items)
}

/// Get tags for an item.
pub fn get_item_tags(conn: &Connection, item_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?
             ORDER BY t.name"
        )
        .map_err(|e| format!("Failed to prepare tag query: {}", e))?;

    let tags: Vec<String> = stmt
        .query_map(params![item_id], |row| row.get(0))
        .map_err(|e| format!("Failed to query tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(tags)
}

/// Mark an item as synced after successful push.
pub fn mark_item_synced(conn: &Connection, item_id: &str, sync_id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE items SET sync_id = ?, synced_at = ? WHERE id = ?",
        params![sync_id, &now, item_id],
    )
    .map_err(|e| format!("Failed to mark item synced: {}", e))?;
    Ok(())
}

/// Merge a server item into the local database.
/// Returns "pulled", "conflict", or "skipped".
pub fn merge_server_item(conn: &Connection, server_item: &ServerItem) -> Result<&'static str, String> {
    let now = Utc::now().to_rfc3339();
    let server_updated = unix_ms_to_datetime(server_item.updated_at)
        .ok_or("Invalid server updated_at timestamp")?;

    // Find local item by sync_id matching server id (include deleted items)
    let local_item: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, updated_at, deleted_at FROM items WHERE sync_id = ?1",
            params![&server_item.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        )
        .ok();

    // Handle server-side deletes
    if server_item.deleted_at > 0 {
        if local_item.is_none() {
            println!("[Rust] Sync: Server deleted item {} but no local copy, skipping", server_item.id);
            return Ok("skipped");
        }
        let (local_id, _local_updated_str, local_deleted_at) = local_item.unwrap();
        if local_deleted_at.is_some() {
            println!("[Rust] Sync: Item {} already deleted locally, updating synced_at", server_item.id);
            conn.execute(
                "UPDATE items SET synced_at = ? WHERE id = ?",
                params![&now, &local_id],
            ).map_err(|e| format!("Failed to update synced_at: {}", e))?;
            return Ok("pulled");
        }
        // Soft-delete the local item
        println!("[Rust] Sync: Soft-deleting local item {} from server delete", server_item.id);
        conn.execute(
            "UPDATE items SET deleted_at = ?, updated_at = ?, synced_at = ? WHERE id = ?",
            params![&now, &now, &now, &local_id],
        ).map_err(|e| format!("Failed to soft-delete item: {}", e))?;
        return Ok("pulled");
    }

    // Handle locally deleted items when server sends a non-deleted update
    if let Some((ref local_id, ref local_updated_str, ref local_deleted_at)) = local_item {
        if local_deleted_at.is_some() {
            let local_updated = parse_iso_datetime(local_updated_str);
            if let Some(local_dt) = local_updated {
                if server_updated > local_dt {
                    // Server is newer - undelete local item and update content
                    println!("[Rust] Sync: Undeleting local item {} - server is newer", server_item.id);

                    let metadata_json = server_item.metadata.as_ref()
                        .map(|m| serde_json::to_string(m).unwrap_or_default());
                    let item_type = &server_item.item_type;
                    let (url_val, content_val): (Option<&str>, Option<&str>) = match item_type.as_str() {
                        "url" | "page" => (server_item.content.as_deref(), None),
                        _ => (None, server_item.content.as_deref()),
                    };

                    conn.execute(
                        "UPDATE items SET deleted_at = NULL, type = ?, url = ?, content = ?, metadata = ?, updated_at = ?, synced_at = ? WHERE id = ?",
                        params![item_type, url_val, content_val, &metadata_json, &unix_ms_to_iso(server_item.updated_at), &now, local_id],
                    ).map_err(|e| format!("Failed to undelete item: {}", e))?;

                    update_item_tags_from_server(conn, local_id, &server_item.tags)?;
                    return Ok("pulled");
                } else {
                    // Local delete is newer - conflict, local wins
                    println!("[Rust] Sync: Conflict - local delete is newer for {}, keeping deleted", server_item.id);
                    return Ok("conflict");
                }
            }
        }
    }

    if let Some((local_id, local_updated_str, _local_deleted_at)) = local_item {
        // Item exists locally - check timestamps for conflict resolution
        let local_updated = parse_iso_datetime(&local_updated_str);

        if let Some(local_dt) = local_updated {
            if server_updated > local_dt {
                // Server is newer - update local
                println!("[Rust] Sync: Updating local item from server: {}", server_item.id);

                let metadata_json = server_item.metadata.as_ref()
                    .map(|m| serde_json::to_string(m).unwrap_or_default());

                let item_type = &server_item.item_type;

                let (url_val, content_val): (Option<&str>, Option<&str>) = match item_type.as_str() {
                    "url" | "page" => (server_item.content.as_deref(), None),
                    _ => (None, server_item.content.as_deref()),
                };

                conn.execute(
                    "UPDATE items SET type = ?, url = ?, content = ?, metadata = ?, updated_at = ?, synced_at = ? WHERE id = ?",
                    params![item_type, url_val, content_val, &metadata_json, &unix_ms_to_iso(server_item.updated_at), &now, &local_id],
                )
                .map_err(|e| format!("Failed to update item: {}", e))?;

                update_item_tags_from_server(conn, &local_id, &server_item.tags)?;

                return Ok("pulled");
            } else if local_dt > server_updated {
                // Local is newer - conflict, local wins
                println!("[Rust] Sync: Conflict - local is newer for {}, keeping local", server_item.id);
                return Ok("conflict");
            }
        }

        // Same timestamp - skip
        return Ok("skipped");
    }

    // Item doesn't exist locally - insert it
    println!("[Rust] Sync: Inserting new item from server: {}", server_item.id);

    let new_id = uuid::Uuid::new_v4().to_string();
    let metadata_json = server_item.metadata.as_ref()
        .map(|m| serde_json::to_string(m).unwrap_or_default());

    let item_type = &server_item.item_type;

    let (url_val, content_val): (Option<&str>, Option<&str>) = match item_type.as_str() {
        "url" | "page" => (server_item.content.as_deref(), None),
        _ => (None, server_item.content.as_deref()),
    };

    conn.execute(
        "INSERT INTO items (id, type, url, content, metadata, sync_id, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            &new_id,
            item_type,
            url_val,
            content_val,
            &metadata_json,
            &server_item.id,
            &now,
            &unix_ms_to_iso(server_item.created_at),
            &unix_ms_to_iso(server_item.updated_at)
        ],
    )
    .map_err(|e| format!("Failed to insert item: {}", e))?;

    // Add tags
    update_item_tags_from_server(conn, &new_id, &server_item.tags)?;

    Ok("pulled")
}

/// Update tags for an item based on server data.
fn update_item_tags_from_server(conn: &Connection, item_id: &str, tag_names: &[String]) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    // Remove existing tags for this item
    conn.execute("DELETE FROM item_tags WHERE item_id = ?", params![item_id])
        .map_err(|e| format!("Failed to remove old tags: {}", e))?;

    // Add new tags
    for tag_name in tag_names {
        // Get or create tag
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(id) => {
                // Update existing tag stats
                let frequency: u32 = conn
                    .query_row("SELECT frequency FROM tags WHERE id = ?", params![&id], |row| row.get(0))
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &id],
                ).ok();

                id
            }
            Err(_) => {
                // Create new tag
                let new_tag_id = generate_tag_id();
                let frecency = calculate_frecency(1, &now);
                conn.execute(
                    "INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt) VALUES (?, ?, 1, ?, ?, ?, ?)",
                    params![&new_tag_id, tag_name, &now, frecency, &now, &now],
                )
                .map_err(|e| format!("Failed to insert tag: {}", e))?;

                new_tag_id
            }
        };

        // Create item-tag association
        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![item_id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PeekStore;

    #[test]
    fn test_parse_iso_datetime() {
        let dt = parse_iso_datetime("2024-01-01T00:00:00Z");
        assert!(dt.is_some());
        assert!(parse_iso_datetime("not a date").is_none());
    }

    #[test]
    fn test_unix_ms_to_iso() {
        let iso = unix_ms_to_iso(1700000000000);
        assert!(iso.contains("2023"));
    }

    #[test]
    fn test_unix_ms_to_datetime() {
        let dt = unix_ms_to_datetime(1700000000000);
        assert!(dt.is_some());
        assert!(unix_ms_to_datetime(0).is_some()); // epoch is valid
    }

    #[test]
    fn test_get_set_last_sync() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();

        assert_eq!(get_last_sync(&conn).unwrap(), None);

        set_last_sync(&conn, "2024-01-01T00:00:00Z").unwrap();
        assert_eq!(get_last_sync(&conn).unwrap(), Some("2024-01-01T00:00:00Z".to_string()));
    }

    #[test]
    fn test_get_pending_sync_count_empty() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        assert_eq!(get_pending_sync_count(&conn).unwrap(), 0);
    }

    #[test]
    fn test_get_items_to_push_empty() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        let items = get_items_to_push(&conn).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn test_get_item_tags_empty() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        let tags = get_item_tags(&conn, "nonexistent").unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn test_merge_server_item_new_insert() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();

        let server_item = ServerItem {
            id: "server-1".to_string(),
            item_type: "url".to_string(),
            content: Some("https://example.com".to_string()),
            tags: vec!["test".to_string()],
            metadata: None,
            created_at: 1700000000000,
            updated_at: 1700000000000,
            deleted_at: 0,
        };

        let result = merge_server_item(&conn, &server_item).unwrap();
        assert_eq!(result, "pulled");

        // Verify item was inserted
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE sync_id = 'server-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);

        // Verify tags
        let local_id: String = conn.query_row(
            "SELECT id FROM items WHERE sync_id = 'server-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        let tags = get_item_tags(&conn, &local_id).unwrap();
        assert_eq!(tags, vec!["test".to_string()]);
    }

    #[test]
    fn test_merge_server_item_server_delete() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();

        // Insert an item first
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO items (id, type, url, sync_id, created_at, updated_at) VALUES ('local-1', 'url', 'https://example.com', 'server-1', ?, ?)",
            params![&now, &now],
        ).unwrap();

        // Server sends delete
        let server_item = ServerItem {
            id: "server-1".to_string(),
            item_type: "url".to_string(),
            content: Some("https://example.com".to_string()),
            tags: vec![],
            metadata: None,
            created_at: 1700000000000,
            updated_at: 1700000000000,
            deleted_at: 1700000001000,
        };

        let result = merge_server_item(&conn, &server_item).unwrap();
        assert_eq!(result, "pulled");

        // Verify item was soft-deleted
        let deleted: Option<String> = conn.query_row(
            "SELECT deleted_at FROM items WHERE id = 'local-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert!(deleted.is_some());
    }

    #[test]
    fn test_items_to_push_after_save() {
        let store = PeekStore::new(":memory:").unwrap();

        // Save an item through PeekStore (which doesn't set synced_at)
        store.save_url("https://example.com", &["test".to_string()], None).unwrap();

        let conn = store.conn.lock().unwrap();
        let items = get_items_to_push(&conn).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_type, "url");

        let count = get_pending_sync_count(&conn).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_mark_item_synced() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();

        let conn = store.conn.lock().unwrap();

        // Before marking synced, item should be pending
        assert_eq!(get_pending_sync_count(&conn).unwrap(), 1);

        mark_item_synced(&conn, &result.item_id, "server-id-1").unwrap();

        // After marking synced, item should no longer be pending
        assert_eq!(get_pending_sync_count(&conn).unwrap(), 0);
    }
}
