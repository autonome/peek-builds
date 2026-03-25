//! Offline content database index operations for peek-core.
//!
//! Only the DB index (offline_content table) lives here. Filesystem I/O and HTTP
//! fetching stay in lib.rs since they're tied to platform-specific container paths.

use rusqlite::{params, Connection};

/// Get total size of offline content storage in bytes.
pub fn get_offline_storage_size(conn: &Connection) -> Result<u64, String> {
    let total: u64 = conn
        .query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM offline_content",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(total)
}

/// Record that offline content was stored for an item.
pub fn index_offline_content(conn: &Connection, item_id: &str, size_bytes: i64) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO offline_content (item_id, fetched_at, size_bytes) VALUES (?, ?, ?)",
        params![item_id, &now, size_bytes],
    )
    .map_err(|e| format!("Failed to update offline index: {}", e))?;
    Ok(())
}

/// Remove offline content index entry for an item.
pub fn remove_offline_content_index(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM offline_content WHERE item_id = ?",
        params![item_id],
    )
    .map_err(|e| format!("Failed to remove offline index: {}", e))?;
    Ok(())
}

/// Check if offline content exists for a single item.
pub fn has_offline_content(conn: &Connection, item_id: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM offline_content WHERE item_id = ?",
            params![item_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(count > 0)
}

/// Batch check which item IDs have offline content. Returns the set of IDs that do.
pub fn check_offline_content_batch(conn: &Connection, item_ids: &[String]) -> Result<Vec<String>, String> {
    if item_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<&str> = item_ids.iter().map(|_| "?").collect();
    let sql = format!(
        "SELECT item_id FROM offline_content WHERE item_id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql)
        .map_err(|e| format!("Failed to prepare offline content batch query: {}", e))?;
    let params: Vec<&dyn rusqlite::types::ToSql> = item_ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query offline content batch: {}", e))?;
    let mut result = Vec::new();
    for row in rows {
        if let Ok(id) = row {
            result.push(id);
        }
    }
    Ok(result)
}

/// Get the URL for an item (used by reader content and offline features).
pub fn get_item_url(conn: &Connection, item_id: &str) -> Result<Option<String>, String> {
    let url: Option<String> = conn
        .query_row(
            "SELECT url FROM items WHERE id = ? AND deleted_at IS NULL",
            params![item_id],
            |row| row.get(0),
        )
        .ok();
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PeekStore;

    #[test]
    fn test_offline_storage_size_empty() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        assert_eq!(get_offline_storage_size(&conn).unwrap(), 0);
    }

    #[test]
    fn test_index_and_size() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();

        index_offline_content(&conn, "item-1", 1000).unwrap();
        index_offline_content(&conn, "item-2", 2000).unwrap();
        assert_eq!(get_offline_storage_size(&conn).unwrap(), 3000);
    }

    #[test]
    fn test_remove_index() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();

        index_offline_content(&conn, "item-1", 1000).unwrap();
        assert_eq!(get_offline_storage_size(&conn).unwrap(), 1000);

        remove_offline_content_index(&conn, "item-1").unwrap();
        assert_eq!(get_offline_storage_size(&conn).unwrap(), 0);
    }

    #[test]
    fn test_get_item_url() {
        let store = PeekStore::new(":memory:").unwrap();
        store.save_url("https://example.com", &[], None).unwrap();

        let conn = store.conn.lock().unwrap();
        // Find the item we just saved
        let id: String = conn.query_row(
            "SELECT id FROM items WHERE type = 'url' LIMIT 1",
            [],
            |row| row.get(0),
        ).unwrap();

        let url = get_item_url(&conn, &id).unwrap();
        assert_eq!(url, Some("https://example.com/".to_string()));
    }

    #[test]
    fn test_get_item_url_nonexistent() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        let url = get_item_url(&conn, "nonexistent").unwrap();
        assert_eq!(url, None);
    }
}
