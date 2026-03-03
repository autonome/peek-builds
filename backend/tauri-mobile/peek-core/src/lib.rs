//! peek-core: Shared database and business logic for Peek.
//!
//! This crate contains all database schema management, item CRUD operations,
//! tag management, sync logic, and profile configuration. It is designed to be
//! used by both the Tauri desktop/mobile app (via direct Cargo dependency) and
//! the iOS Share Extension (via UniFFI-generated Swift bindings).
//!
//! # Architecture
//!
//! - `PeekStore` is the main entry point — construct with a database path.
//! - All database operations go through PeekStore methods.
//! - No platform-specific code (no iOS FFI, no Tauri dependency).
//! - UniFFI annotations enable Swift and Kotlin binding generation.

pub mod ffi;
pub mod helpers;
pub mod items;
pub mod offline;
pub mod profiles;
pub mod schema;
pub mod sync;
pub mod tags;
pub mod types;

use rusqlite::Connection;
use std::sync::Mutex;

pub use helpers::*;
pub use items::{SaveUrlResult, UpdateResult};
pub use profiles::{
    ProfileConfig, ProfileEntry, SyncSettings,
    append_profile_to_url, create_default_profile_config,
    get_db_path_for_profile, get_profiles_config_path,
    load_profile_config, save_profile_config,
};
pub use sync::PushItem;
pub use tags::TagChanges;
pub use types::*;

uniffi::include_scaffolding!("peek_core");

/// The main API surface for peek-core.
/// Wraps a SQLite database connection and provides all business logic operations.
///
/// Construct with `PeekStore::new(db_path)` — the caller determines the database path
/// (e.g. App Group container on iOS, profile directory on desktop).
pub struct PeekStore {
    conn: Mutex<Connection>,
    device_id: String,
    db_path: String,
}

impl PeekStore {
    /// Open or create a database at the given path.
    /// Runs all schema migrations and returns a ready-to-use store.
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        let device_id = schema::ensure_database_initialized(&conn)?;

        Ok(PeekStore {
            conn: Mutex::new(conn),
            device_id,
            db_path: db_path.to_string(),
        })
    }

    /// Get the device ID (raw UUID) for this database.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Get the database path.
    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    // ========================================================================
    // Item CRUD
    // ========================================================================

    /// Save or update a URL item. Returns item_id and whether it was new.
    pub fn save_url(&self, url: &str, tags: &[String], metadata: Option<serde_json::Value>) -> Result<SaveUrlResult, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::save_url(&conn, url, tags, metadata, &self.device_id)
    }

    /// Save a text item with hashtags auto-parsed as tags. Returns item_id.
    pub fn save_text(&self, content: &str, tags: Option<&[String]>, metadata: Option<serde_json::Value>) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::save_text(&conn, content, tags, metadata, &self.device_id)
    }

    /// Save a tagset (tags only). Returns item_id.
    pub fn save_tagset(&self, tags: &[String], metadata: Option<serde_json::Value>) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::save_tagset(&conn, tags, metadata, &self.device_id)
    }

    /// Save an image. image_bytes and thumbnail_bytes are raw (caller decodes base64).
    pub fn save_image(
        &self,
        image_bytes: &[u8],
        mime_type: &str,
        tags: &[String],
        metadata: Option<serde_json::Value>,
        thumbnail_bytes: Option<&[u8]>,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::save_image(&conn, image_bytes, mime_type, tags, metadata, thumbnail_bytes, width, height, &self.device_id)
    }

    /// Get all saved URL items.
    pub fn get_saved_urls(&self) -> Result<Vec<SavedUrl>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::get_saved_urls(&conn)
    }

    /// Get all saved text items.
    pub fn get_saved_texts(&self) -> Result<Vec<SavedText>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::get_saved_texts(&conn)
    }

    /// Get all saved tagsets.
    pub fn get_saved_tagsets(&self) -> Result<Vec<SavedTagset>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::get_saved_tagsets(&conn)
    }

    /// Get all saved images (with thumbnails).
    pub fn get_saved_images(&self) -> Result<Vec<SavedImage>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::get_saved_images(&conn)
    }

    /// Get full image data by item ID. Returns base64-encoded image.
    pub fn get_image_data(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::get_image_data(&conn, id)
    }

    /// Update a URL item's url and tags.
    pub fn update_url(&self, id: &str, url: &str, tags: &[String]) -> Result<TagChanges, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::update_url(&conn, id, url, tags, &self.device_id)
    }

    /// Update tags for any item type.
    pub fn update_item_tags(&self, id: &str, tags: &[String]) -> Result<UpdateResult, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::update_item_tags_command(&conn, id, tags, &self.device_id)
    }

    /// Update a text item's content and tags.
    pub fn update_text(&self, id: &str, content: &str, tags: &[String]) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::update_text(&conn, id, content, tags, &self.device_id)
    }

    /// Update a tagset's tags.
    pub fn update_tagset(&self, id: &str, tags: &[String]) -> Result<TagChanges, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::update_tagset(&conn, id, tags, &self.device_id)
    }

    /// Update image tags.
    pub fn update_image_tags(&self, id: &str, tags: &[String]) -> Result<TagChanges, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::update_image_tags(&conn, id, tags, &self.device_id)
    }

    /// Soft-delete any item by ID.
    pub fn delete_item(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::delete_item(&conn, id)
    }

    /// Record a visit to an item. Returns the visit ID.
    pub fn record_visit(&self, item_id: &str, source: &str, window_type: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::record_visit(&conn, item_id, source, window_type)
    }

    /// Track webview navigation (find/create URL item, tag from:history, record visit).
    pub fn track_navigation(&self, url: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        items::track_navigation(&conn, url, &self.device_id)
    }

    // ========================================================================
    // Tags
    // ========================================================================

    /// Get all tags ordered by frecency score.
    pub fn get_tags_by_frecency(&self) -> Result<Vec<TagStats>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        tags::get_tags_by_frecency(&conn)
    }

    /// Get tags with domain affinity boost for a URL.
    pub fn get_tags_by_frecency_for_url(&self, url: &str) -> Result<Vec<TagStats>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        tags::get_tags_by_frecency_for_url(&conn, url)
    }

    // ========================================================================
    // Sync
    // ========================================================================

    /// Get the last sync timestamp.
    pub fn get_last_sync(&self) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::get_last_sync(&conn)
    }

    /// Set the last sync timestamp.
    pub fn set_last_sync(&self, timestamp: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::set_last_sync(&conn, timestamp)
    }

    /// Count items that need to be pushed to the server.
    pub fn get_pending_sync_count(&self) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::get_pending_sync_count(&conn)
    }

    /// Get items that need to be pushed to the server.
    pub fn get_items_to_push(&self) -> Result<Vec<PushItem>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::get_items_to_push(&conn)
    }

    /// Get tags for a specific item.
    pub fn get_item_tags(&self, item_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::get_item_tags(&conn, item_id)
    }

    /// Mark an item as synced after successful push.
    pub fn mark_item_synced(&self, item_id: &str, sync_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::mark_item_synced(&conn, item_id, sync_id)
    }

    /// Merge a server item into the local database.
    /// Returns "pulled", "conflict", or "skipped".
    pub fn merge_server_item(&self, server_item: &ServerItem) -> Result<&'static str, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        sync::merge_server_item(&conn, server_item)
    }

    // ========================================================================
    // Offline content index
    // ========================================================================

    /// Get total size of offline content storage in bytes.
    pub fn get_offline_storage_size(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        offline::get_offline_storage_size(&conn)
    }

    /// Record that offline content was stored for an item.
    pub fn index_offline_content(&self, item_id: &str, size_bytes: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        offline::index_offline_content(&conn, item_id, size_bytes)
    }

    /// Remove offline content index entry for an item.
    pub fn remove_offline_content_index(&self, item_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        offline::remove_offline_content_index(&conn, item_id)
    }

    /// Get the URL for an item (used by reader content and offline features).
    pub fn get_item_url(&self, item_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        offline::get_item_url(&conn, item_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_peek_store_new_in_memory() {
        let store = PeekStore::new(":memory:").unwrap();
        assert!(!store.device_id().is_empty());
    }

    #[test]
    fn test_peek_store_new_with_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let store = PeekStore::new(db_path.to_str().unwrap()).unwrap();
        assert!(!store.device_id().is_empty());
        assert!(db_path.exists());
    }

    #[test]
    fn test_peek_store_save_and_get_url() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &["test".to_string()], None).unwrap();
        assert!(result.is_new);

        let urls = store.get_saved_urls().unwrap();
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].url, "https://example.com/");
        assert!(urls[0].tags.contains(&"test".to_string()));
    }

    #[test]
    fn test_peek_store_save_and_delete() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();
        store.delete_item(&result.item_id).unwrap();

        let urls = store.get_saved_urls().unwrap();
        assert_eq!(urls.len(), 0);
    }

    #[test]
    fn test_peek_store_tags_by_frecency() {
        let store = PeekStore::new(":memory:").unwrap();
        store.save_url("https://a.com", &["alpha".to_string()], None).unwrap();
        store.save_url("https://b.com", &["beta".to_string(), "alpha".to_string()], None).unwrap();

        let tags = store.get_tags_by_frecency().unwrap();
        assert_eq!(tags.len(), 2);
        // alpha used twice, should be first
        assert_eq!(tags[0].name, "alpha");
    }

    #[test]
    fn test_peek_store_device_id_stable() {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let path_str = db_path.to_str().unwrap();

        let store1 = PeekStore::new(path_str).unwrap();
        let id1 = store1.device_id().to_string();
        drop(store1);

        let store2 = PeekStore::new(path_str).unwrap();
        let id2 = store2.device_id().to_string();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_helpers_accessible() {
        assert_eq!(normalize_url("https://example.com"), "https://example.com/");
        assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn test_types_accessible() {
        assert_eq!(DATASTORE_VERSION, 1);
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(SCHEMA_VERSION, "2");
    }
}
