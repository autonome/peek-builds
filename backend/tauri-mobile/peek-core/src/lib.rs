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

pub mod helpers;
pub mod profiles;
pub mod schema;
pub mod types;

use rusqlite::Connection;
use std::sync::Mutex;

pub use helpers::*;
pub use profiles::{
    ProfileConfig, ProfileEntry, SyncSettings,
    append_profile_to_url, create_default_profile_config,
    get_db_path_for_profile, get_profiles_config_path,
    load_profile_config, save_profile_config,
};
pub use types::*;

uniffi::include_scaffolding!("peek_core");

/// The main API surface for peek-core.
/// Wraps a SQLite database connection and provides all business logic operations.
///
/// Construct with `PeekStore::new(db_path)` — the caller determines the database path
/// (e.g. App Group container on iOS, profile directory on desktop).
pub struct PeekStore {
    #[allow(dead_code)] // Used in Phase 2 (item CRUD methods)
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

    // Re-export tests from sub-modules to verify integration
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
