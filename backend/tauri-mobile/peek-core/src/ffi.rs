//! FFI facade for UniFFI-generated Swift/Kotlin bindings.
//!
//! This module exposes a subset of PeekStore's functionality through
//! UniFFI-compatible types and methods. Internal types use serde_json::Value
//! (not UniFFI-compatible), so we define clean FFI records here and convert
//! at the boundary.

use std::sync::Arc;

use crate::items::SaveUrlResult;
use crate::profiles::{self, ProfileConfig, ProfileEntry, SyncSettings};
use crate::types::TagStats;
use crate::PeekStore;

// ============================================================================
// FFI Error — UniFFI requires a proper error enum, not bare String
// ============================================================================

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum FfiError {
    #[error("{msg}")]
    PeekError { msg: String },
}

impl From<String> for FfiError {
    fn from(msg: String) -> Self {
        FfiError::PeekError { msg }
    }
}

// ============================================================================
// FFI Records — plain data types bridged to Swift structs
// ============================================================================

#[derive(uniffi::Record)]
pub struct FfiSaveUrlResult {
    pub item_id: String,
    pub is_new: bool,
}

impl From<SaveUrlResult> for FfiSaveUrlResult {
    fn from(r: SaveUrlResult) -> Self {
        FfiSaveUrlResult {
            item_id: r.item_id,
            is_new: r.is_new,
        }
    }
}

#[derive(uniffi::Record)]
pub struct FfiTagStats {
    pub name: String,
    pub frequency: u32,
    pub last_used: String,
    pub frecency_score: f64,
}

impl From<TagStats> for FfiTagStats {
    fn from(t: TagStats) -> Self {
        FfiTagStats {
            name: t.name,
            frequency: t.frequency,
            last_used: t.last_used,
            frecency_score: t.frecency_score,
        }
    }
}

#[derive(uniffi::Record)]
pub struct FfiProfileEntry {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: String,
    pub server_profile_id: Option<String>,
}

impl From<ProfileEntry> for FfiProfileEntry {
    fn from(p: ProfileEntry) -> Self {
        FfiProfileEntry {
            id: p.id,
            name: p.name,
            created_at: p.created_at,
            last_used_at: p.last_used_at,
            server_profile_id: p.server_profile_id,
        }
    }
}

#[derive(uniffi::Record)]
pub struct FfiSyncSettings {
    pub server_url: String,
    pub api_key: String,
    pub auto_sync: bool,
}

impl From<SyncSettings> for FfiSyncSettings {
    fn from(s: SyncSettings) -> Self {
        FfiSyncSettings {
            server_url: s.server_url,
            api_key: s.api_key,
            auto_sync: s.auto_sync,
        }
    }
}

#[derive(uniffi::Record)]
pub struct FfiProfileConfig {
    pub current_profile_id: String,
    pub profiles: Vec<FfiProfileEntry>,
    pub sync: FfiSyncSettings,
    pub archive_tag: String,
    pub todo_tag: String,
    pub done_tag: String,
    pub readme_tag: String,
    pub read_tag: String,
    pub offline_tag: String,
}

impl From<ProfileConfig> for FfiProfileConfig {
    fn from(c: ProfileConfig) -> Self {
        FfiProfileConfig {
            current_profile_id: c.current_profile_id,
            profiles: c.profiles.into_iter().map(Into::into).collect(),
            sync: c.sync.into(),
            archive_tag: c.archive_tag,
            todo_tag: c.todo_tag,
            done_tag: c.done_tag,
            readme_tag: c.readme_tag,
            read_tag: c.read_tag,
            offline_tag: c.offline_tag,
        }
    }
}

// ============================================================================
// FFI Object — wraps PeekStore for Swift/Kotlin callers
// ============================================================================

#[derive(uniffi::Object)]
pub struct PeekCoreFfi {
    store: PeekStore,
}

#[uniffi::export]
impl PeekCoreFfi {
    /// Open or create a database at the given path.
    #[uniffi::constructor]
    pub fn new(db_path: String) -> Result<Arc<Self>, FfiError> {
        let store = PeekStore::new(&db_path)?;
        Ok(Arc::new(PeekCoreFfi { store }))
    }

    /// Get the device ID for this database.
    pub fn device_id(&self) -> String {
        self.store.device_id().to_string()
    }

    /// Save or update a URL item.
    /// `metadata_json` is an optional JSON string parsed into serde_json::Value.
    pub fn save_url(
        &self,
        url: String,
        tags: Vec<String>,
        metadata_json: Option<String>,
    ) -> Result<FfiSaveUrlResult, FfiError> {
        let metadata = parse_metadata_json(metadata_json)?;
        let result = self.store.save_url(&url, &tags, metadata)?;
        Ok(result.into())
    }

    /// Save a text item. Returns the item ID.
    pub fn save_text(
        &self,
        content: String,
        tags: Option<Vec<String>>,
        metadata_json: Option<String>,
    ) -> Result<String, FfiError> {
        let metadata = parse_metadata_json(metadata_json)?;
        let tag_refs = tags.as_deref();
        self.store.save_text(&content, tag_refs, metadata).map_err(Into::into)
    }

    /// Save an image. Returns the item ID.
    pub fn save_image(
        &self,
        image_bytes: Vec<u8>,
        mime_type: String,
        tags: Vec<String>,
        metadata_json: Option<String>,
        thumbnail_bytes: Option<Vec<u8>>,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<String, FfiError> {
        let metadata = parse_metadata_json(metadata_json)?;
        let thumb_ref = thumbnail_bytes.as_deref();
        self.store.save_image(
            &image_bytes,
            &mime_type,
            &tags,
            metadata,
            thumb_ref,
            width,
            height,
        ).map_err(Into::into)
    }

    /// Get all tags ordered by frecency score.
    pub fn get_tags_by_frecency(&self) -> Result<Vec<FfiTagStats>, FfiError> {
        let tags = self.store.get_tags_by_frecency()?;
        Ok(tags.into_iter().map(Into::into).collect())
    }

    /// Get tags with domain affinity boost for a URL.
    pub fn get_tags_by_frecency_for_url(&self, url: String) -> Result<Vec<FfiTagStats>, FfiError> {
        let tags = self.store.get_tags_by_frecency_for_url(&url)?;
        Ok(tags.into_iter().map(Into::into).collect())
    }
}

// ============================================================================
// Free functions — profile config operations (no database needed)
// ============================================================================

/// Load profile configuration from the given base directory.
#[uniffi::export]
pub fn ffi_load_profile_config(base_path: String) -> FfiProfileConfig {
    let path = std::path::Path::new(&base_path);
    let config = profiles::load_profile_config(path);
    config.into()
}

/// Get the database path for the current profile.
#[uniffi::export]
pub fn ffi_get_db_path_for_profile(base_path: String) -> Result<String, FfiError> {
    let path = std::path::Path::new(&base_path);
    let db_path = profiles::get_db_path_for_profile(path)
        .map_err(|e| FfiError::PeekError { msg: format!("{}", e) })?;
    Ok(db_path.to_string_lossy().into_owned())
}

// ============================================================================
// Internal helpers
// ============================================================================

/// Parse an optional JSON string into an optional serde_json::Value.
fn parse_metadata_json(json: Option<String>) -> Result<Option<serde_json::Value>, FfiError> {
    match json {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => {
            let value: serde_json::Value = serde_json::from_str(&s)
                .map_err(|e| FfiError::PeekError { msg: format!("Invalid metadata JSON: {}", e) })?;
            Ok(Some(value))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ffi_peek_core_new() {
        let store = PeekCoreFfi::new(":memory:".to_string()).unwrap();
        assert!(!store.device_id().is_empty());
    }

    #[test]
    fn test_ffi_save_url() {
        let store = PeekCoreFfi::new(":memory:".to_string()).unwrap();
        let result = store
            .save_url(
                "https://example.com".to_string(),
                vec!["test".to_string()],
                None,
            )
            .unwrap();
        assert!(result.is_new);
        assert!(!result.item_id.is_empty());
    }

    #[test]
    fn test_ffi_save_url_with_metadata() {
        let store = PeekCoreFfi::new(":memory:".to_string()).unwrap();
        let result = store
            .save_url(
                "https://example.com".to_string(),
                vec![],
                Some(r#"{"title": "Example"}"#.to_string()),
            )
            .unwrap();
        assert!(result.is_new);
    }

    #[test]
    fn test_ffi_save_text() {
        let store = PeekCoreFfi::new(":memory:".to_string()).unwrap();
        let id = store
            .save_text("hello world".to_string(), None, None)
            .unwrap();
        assert!(!id.is_empty());
    }

    #[test]
    fn test_ffi_get_tags_by_frecency() {
        let store = PeekCoreFfi::new(":memory:".to_string()).unwrap();
        store
            .save_url(
                "https://a.com".to_string(),
                vec!["alpha".to_string()],
                None,
            )
            .unwrap();
        let tags = store.get_tags_by_frecency().unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "alpha");
    }

    #[test]
    fn test_ffi_load_profile_config() {
        let dir = tempfile::TempDir::new().unwrap();
        let config = ffi_load_profile_config(dir.path().to_string_lossy().into_owned());
        assert!(!config.current_profile_id.is_empty());
        assert!(!config.profiles.is_empty());
    }

    #[test]
    fn test_ffi_get_db_path_for_profile() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = ffi_get_db_path_for_profile(dir.path().to_string_lossy().into_owned()).unwrap();
        assert!(path.contains("peek-"));
        assert!(path.ends_with(".db"));
    }

    #[test]
    fn test_parse_metadata_json_none() {
        assert!(parse_metadata_json(None).unwrap().is_none());
    }

    #[test]
    fn test_parse_metadata_json_empty() {
        assert!(parse_metadata_json(Some(String::new())).unwrap().is_none());
    }

    #[test]
    fn test_parse_metadata_json_valid() {
        let result = parse_metadata_json(Some(r#"{"key": "value"}"#.to_string())).unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn test_parse_metadata_json_invalid() {
        assert!(parse_metadata_json(Some("not json".to_string())).is_err());
    }
}
