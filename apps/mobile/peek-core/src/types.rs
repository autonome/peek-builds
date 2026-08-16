use serde::{Deserialize, Serialize};

// Sync version constants — must match backend/version.ts and backend/server/version.js
// Bump DATASTORE_VERSION when schema changes break sync.
// Bump PROTOCOL_VERSION when request/response shape changes.
// Exact match required — server returns 409 on mismatch.
//
// Raised to 3 to match apps/desktop/version.ts and apps/server/version.js (item
// and tag columns added there). This client does not send any of those newer
// columns, and that's safe: apps/server/db.js saveItem() binds every newer
// column through COALESCE(?, existingColumn), and POST /items defaults absent
// fields to null, so an item pushed without title/domain/favicon/visitCount/
// lastVisitAt/frecencyScore/mimeType/starred/archived leaves the stored values
// untouched rather than nulling them.
pub const DATASTORE_VERSION: u32 = 3;
pub const PROTOCOL_VERSION: u32 = 1;

/// Schema version for tracking compatibility between Rust main app and Swift Share Extension.
/// Increment this when making schema changes that both codepaths must understand.
/// Both Rust and Swift code should use the same version number.
pub const SCHEMA_VERSION: &str = "2";

/// Error type for peek-core operations.
#[derive(Debug, thiserror::Error)]
pub enum PeekError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    General(String),
}

/// Result type alias for peek-core operations.
pub type PeekResult<T> = Result<T, PeekError>;

// Legacy model for backward compatibility (webhook, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedUrl {
    pub id: String,
    pub url: String,
    pub tags: Vec<String>,
    pub saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// Text item for webhook
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedText {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// Tagset item for webhook
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTagset {
    pub id: String,
    pub tags: Vec<String>,
    pub saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// Image item
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedImage {
    pub id: String,
    pub tags: Vec<String>,
    pub saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    // Base64-encoded thumbnail for display (smaller version)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub mime_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagStats {
    pub name: String,
    pub frequency: u32,
    pub last_used: String,
    pub frecency_score: f64,
}

// Webhook payload with all item types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookPayload {
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub urls: Vec<SavedUrl>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub texts: Vec<SavedText>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tagsets: Vec<SavedTagset>,
}

// Old webhook sync result (kept for backward compatibility)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub success: bool,
    pub synced_count: usize,
    pub message: String,
}

// New bidirectional sync result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BidirectionalSyncResult {
    pub success: bool,
    pub pulled: usize,
    pub pushed: usize,
    pub conflicts: usize,
    pub message: String,
}

/// Deserialize a timestamp that may be an integer (Unix ms) or ISO 8601 string.
/// Handles both the new server format (integer) and legacy format (string).
pub fn deserialize_flexible_timestamp<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match &value {
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| serde::de::Error::custom("timestamp number out of i64 range")),
        serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .map_err(|_| serde::de::Error::custom("invalid ISO 8601 timestamp")),
        _ => Err(serde::de::Error::custom("expected number or string for timestamp")),
    }
}

/// Like deserialize_flexible_timestamp, but also handles absent/null fields (defaults to 0).
pub fn deserialize_optional_flexible_timestamp<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match &value {
        serde_json::Value::Null => Ok(0),
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| serde::de::Error::custom("timestamp number out of i64 range")),
        serde_json::Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .map_err(|_| serde::de::Error::custom("invalid ISO 8601 timestamp")),
        _ => Err(serde::de::Error::custom("expected number, string, or null for timestamp")),
    }
}

// Server item format (from GET /items)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub content: Option<String>,
    pub tags: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    #[serde(deserialize_with = "deserialize_flexible_timestamp")]
    pub created_at: i64,
    #[serde(deserialize_with = "deserialize_flexible_timestamp")]
    pub updated_at: i64,
    #[serde(default, deserialize_with = "deserialize_optional_flexible_timestamp")]
    pub deleted_at: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub favicon: String,
    #[serde(default)]
    pub frecency_score: i64,
}

// Server response for GET /items
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerItemsResponse {
    pub items: Vec<ServerItem>,
}

// Server response for POST /items
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCreateResponse {
    pub id: String,
    pub created: bool,
}

// Sync status for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatus {
    pub configured: bool,
    pub last_sync_time: Option<String>,
    pub pending_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_item_deserialize_int_timestamps() {
        let json = r#"{
            "id": "abc",
            "type": "url",
            "content": null,
            "tags": ["test"],
            "metadata": null,
            "createdAt": 1700000000000,
            "updatedAt": 1700000000000
        }"#;
        let item: ServerItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.id, "abc");
        assert_eq!(item.created_at, 1700000000000);
        assert_eq!(item.deleted_at, 0); // default
    }

    #[test]
    fn test_server_item_deserialize_string_timestamps() {
        let json = r#"{
            "id": "abc",
            "type": "url",
            "content": null,
            "tags": [],
            "metadata": null,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
            "deletedAt": null
        }"#;
        let item: ServerItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.id, "abc");
        assert!(item.created_at > 0);
        assert_eq!(item.deleted_at, 0);
    }

    #[test]
    fn test_peek_error_display() {
        let err = PeekError::General("test error".to_string());
        assert_eq!(format!("{}", err), "test error");
    }
}
