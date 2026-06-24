use rusqlite::{params, types::ToSql, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

use crate::helpers::{
    inject_sync_metadata_for_save, inject_sync_metadata_for_update,
    normalize_url, parse_hashtags,
};
use crate::tags::{add_tags_to_item, update_item_tags, TagChanges};
use crate::types::{SavedImage, SavedTagset, SavedText, SavedUrl};

/// Result of a save_url operation.
pub struct SaveUrlResult {
    /// The item ID (new or existing).
    pub item_id: String,
    /// Whether this was a new item (true) or an existing one updated (false).
    pub is_new: bool,
}

/// Result of an update operation that modifies tags.
pub struct UpdateResult {
    pub tag_changes: TagChanges,
    /// Item type (e.g. "url", "text", "tagset").
    pub item_type: String,
    /// URL if applicable (for offline content handling).
    pub url: Option<String>,
}

// ============================================================================
// Save operations
// ============================================================================

/// Save or update a URL item. Returns item_id and whether it was new.
pub fn save_url(
    conn: &Connection,
    url: &str,
    tags: &[String],
    metadata: Option<serde_json::Value>,
    device_id: &str,
) -> Result<SaveUrlResult, String> {
    let url = normalize_url(url);
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();

    // Check if URL already exists
    let url_without_slash = url.strip_suffix('/').unwrap_or(&url);
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM items WHERE type = 'url' AND (url = ? OR url = ?) AND deleted_at IS NULL",
            params![&url, &url_without_slash],
            |row| row.get(0),
        )
        .ok();

    let is_new = existing_id.is_none();
    let item_id = if let Some(existing) = existing_id {
        // Update existing item
        let existing_meta_str: Option<String> = conn
            .query_row("SELECT metadata FROM items WHERE id = ?", params![&existing], |row| row.get(0))
            .ok();

        // Merge user-provided metadata fields into existing metadata
        let merged_str = if let Some(new_meta) = &metadata {
            let mut existing_val: serde_json::Value = existing_meta_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let (Some(dst), Some(src)) = (existing_val.as_object_mut(), new_meta.as_object()) {
                for (k, v) in src {
                    if k != "_sync" { dst.insert(k.clone(), v.clone()); }
                }
            }
            Some(serde_json::to_string(&existing_val).unwrap_or_default())
        } else {
            existing_meta_str
        };
        let updated_meta = inject_sync_metadata_for_update(merged_str, device_id);
        conn.execute(
            "UPDATE items SET url = ?, updated_at = ?, metadata = ? WHERE id = ?",
            params![&url, &now, &updated_meta, &existing],
        )
        .map_err(|e| format!("Failed to update item: {}", e))?;

        // Remove old tag associations
        conn.execute("DELETE FROM item_tags WHERE item_id = ?", params![&existing])
            .map_err(|e| format!("Failed to remove old tags: {}", e))?;

        existing
    } else {
        // Insert new url item
        let meta_with_sync = inject_sync_metadata_for_save(metadata, device_id);
        let metadata_json = serde_json::to_string(&meta_with_sync).unwrap_or_default();
        conn.execute(
            "INSERT INTO items (id, type, url, metadata, created_at, updated_at) VALUES (?, 'url', ?, ?, ?, ?)",
            params![&id, &url, &metadata_json, &now, &now],
        )
        .map_err(|e| format!("Failed to insert item: {}", e))?;

        id
    };

    // Add tags
    add_tags_to_item(conn, &item_id, tags)?;

    Ok(SaveUrlResult { item_id, is_new })
}

/// Save a text item with hashtags auto-parsed as tags. Returns item_id.
pub fn save_text(
    conn: &Connection,
    content: &str,
    tags: Option<&[String]>,
    metadata: Option<serde_json::Value>,
    device_id: &str,
) -> Result<String, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let meta_with_sync = inject_sync_metadata_for_save(metadata, device_id);
    let metadata_json = serde_json::to_string(&meta_with_sync).unwrap_or_default();

    // Parse hashtags from content and merge with provided tags
    let mut all_tags = parse_hashtags(content);
    if let Some(extra) = tags {
        for tag in extra {
            let normalized = tag.trim().to_lowercase();
            if !normalized.is_empty() && !all_tags.contains(&normalized) {
                all_tags.push(normalized);
            }
        }
    }

    conn.execute(
        "INSERT INTO items (id, type, content, metadata, created_at, updated_at) VALUES (?, 'text', ?, ?, ?, ?)",
        params![&id, content, &metadata_json, &now, &now],
    )
    .map_err(|e| format!("Failed to insert text item: {}", e))?;

    add_tags_to_item(conn, &id, &all_tags)?;

    Ok(id)
}

/// Save a tagset (tags only, no content). Returns item_id.
pub fn save_tagset(
    conn: &Connection,
    tags: &[String],
    metadata: Option<serde_json::Value>,
    device_id: &str,
) -> Result<String, String> {
    if tags.is_empty() {
        return Err("At least one tag is required for a tagset".to_string());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let meta_with_sync = inject_sync_metadata_for_save(metadata, device_id);
    let metadata_json = serde_json::to_string(&meta_with_sync).unwrap_or_default();

    conn.execute(
        "INSERT INTO items (id, type, metadata, created_at, updated_at) VALUES (?, 'tagset', ?, ?, ?)",
        params![&id, &metadata_json, &now, &now],
    )
    .map_err(|e| format!("Failed to insert tagset item: {}", e))?;

    add_tags_to_item(conn, &id, tags)?;

    Ok(id)
}

/// Save an image with optional tags and metadata. Returns item_id.
/// image_data and thumbnail_data are raw bytes (caller decodes base64).
pub fn save_image(
    conn: &Connection,
    image_bytes: &[u8],
    mime_type: &str,
    tags: &[String],
    metadata: Option<serde_json::Value>,
    thumbnail_bytes: Option<&[u8]>,
    width: Option<u32>,
    height: Option<u32>,
    device_id: &str,
) -> Result<String, String> {
    let size_bytes = image_bytes.len() as i64;

    // Hash thumbnail for dedup — raw image bytes may differ between shares
    // because iOS re-encodes images (HEIC/JPEG variations, EXIF changes).
    // Thumbnail is generated deterministically from decoded pixels at a
    // fixed size and JPEG quality, so same image = same hash.
    let data_hash = match thumbnail_bytes {
        Some(thumb) => format!("{:x}", Sha256::digest(thumb)),
        None => format!("{:x}", Sha256::digest(image_bytes)),
    };

    let existing_item_id: Option<String> = conn
        .query_row(
            "SELECT b.item_id FROM blobs b JOIN items i ON i.id = b.item_id \
             WHERE b.data_hash = ? AND i.type = 'image' AND i.deleted_at IS NULL \
             LIMIT 1",
            params![&data_hash],
            |row| row.get(0),
        )
        .ok();

    if let Some(item_id) = existing_item_id {
        // Update tags and metadata on existing item instead of creating a duplicate
        let now = chrono::Utc::now().to_rfc3339();
        if let Some(meta) = metadata {
            let meta_json = serde_json::to_string(&meta).unwrap_or_default();
            let _ = update_item_metadata(conn, &item_id, &meta_json, device_id);
        }
        update_item_tags(conn, &item_id, tags)?;
        conn.execute(
            "UPDATE items SET updated_at = ? WHERE id = ?",
            params![&now, &item_id],
        )
        .map_err(|e| format!("Failed to update item: {}", e))?;
        return Ok(item_id);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let item_id = uuid::Uuid::new_v4().to_string();
    let blob_id = uuid::Uuid::new_v4().to_string();
    let meta_with_sync = inject_sync_metadata_for_save(metadata, device_id);
    let metadata_json = serde_json::to_string(&meta_with_sync).unwrap_or_default();

    conn.execute(
        "INSERT INTO items (id, type, metadata, created_at, updated_at) VALUES (?, 'image', ?, ?, ?)",
        params![&item_id, &metadata_json, &now, &now],
    )
    .map_err(|e| format!("Failed to insert image item: {}", e))?;

    conn.execute(
        "INSERT INTO blobs (id, item_id, data, mime_type, size_bytes, width, height, thumbnail, data_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![&blob_id, &item_id, image_bytes, mime_type, size_bytes, width, height, thumbnail_bytes, &data_hash, &now],
    )
    .map_err(|e| format!("Failed to insert blob: {}", e))?;

    add_tags_to_item(conn, &item_id, tags)?;

    Ok(item_id)
}

// ============================================================================
// Read operations
// ============================================================================

/// Get all saved URL items (non-deleted), ordered by most recently updated.
pub fn get_saved_urls(conn: &Connection) -> Result<Vec<SavedUrl>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, url, created_at, metadata FROM items WHERE type = 'url' AND deleted_at IS NULL ORDER BY COALESCE(updated_at, created_at) DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows: Vec<(String, String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| format!("Failed to query pages: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut urls: Vec<SavedUrl> = Vec::new();
    for (id, url, created_at, metadata_json) in rows {
        let tags = get_item_tag_names_ordered(conn, &id)?;
        let metadata = metadata_json.and_then(|s| serde_json::from_str(&s).ok());

        urls.push(SavedUrl {
            id,
            url,
            tags,
            saved_at: created_at,
            metadata,
        });
    }

    Ok(urls)
}

/// Get all saved text items (non-deleted), ordered by most recently updated.
pub fn get_saved_texts(conn: &Connection) -> Result<Vec<SavedText>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content, created_at, metadata FROM items WHERE type = 'text' AND deleted_at IS NULL ORDER BY COALESCE(updated_at, created_at) DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows: Vec<(String, String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| format!("Failed to query texts: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut texts: Vec<SavedText> = Vec::new();
    for (id, content, created_at, metadata_json) in rows {
        let tags = get_item_tag_names_ordered(conn, &id)?;
        let metadata = metadata_json.and_then(|s| serde_json::from_str(&s).ok());

        texts.push(SavedText {
            id,
            content,
            tags,
            saved_at: created_at,
            metadata,
        });
    }

    Ok(texts)
}

/// Get all saved tagsets (non-deleted), ordered by most recently updated.
pub fn get_saved_tagsets(conn: &Connection) -> Result<Vec<SavedTagset>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, metadata FROM items WHERE type = 'tagset' AND deleted_at IS NULL ORDER BY COALESCE(updated_at, created_at) DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| format!("Failed to query tagsets: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagsets: Vec<SavedTagset> = Vec::new();
    for (id, created_at, metadata_json) in rows {
        let tags = get_item_tag_names_ordered(conn, &id)?;
        let metadata = metadata_json.and_then(|s| serde_json::from_str(&s).ok());

        tagsets.push(SavedTagset {
            id,
            tags,
            saved_at: created_at,
            metadata,
        });
    }

    Ok(tagsets)
}

/// Get all saved images (non-deleted) with thumbnails, ordered by most recently updated.
pub fn get_saved_images(conn: &Connection) -> Result<Vec<SavedImage>, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.created_at, i.metadata, b.mime_type, b.width, b.height, b.thumbnail, i.content
             FROM items i
             LEFT JOIN blobs b ON b.item_id = i.id
             WHERE i.type = 'image' AND i.deleted_at IS NULL
             ORDER BY COALESCE(i.updated_at, i.created_at) DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows: Vec<(String, String, Option<String>, Option<String>, Option<u32>, Option<u32>, Option<Vec<u8>>, Option<String>)> = stmt
        .query_map([], |row| Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
        )))
        .map_err(|e| format!("Failed to query images: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut images: Vec<SavedImage> = Vec::new();
    for (id, created_at, metadata_json, mime_type, width, height, thumbnail_bytes, content) in rows {
        let tags = get_item_tag_names_ordered(conn, &id)?;
        let metadata = metadata_json.and_then(|s| serde_json::from_str(&s).ok());
        let thumbnail = thumbnail_bytes.map(|b| STANDARD.encode(&b));

        images.push(SavedImage {
            id,
            tags,
            saved_at: created_at,
            metadata,
            content,
            thumbnail,
            mime_type: mime_type.unwrap_or_else(|| "image/jpeg".to_string()),
            width,
            height,
        });
    }

    Ok(images)
}

/// Get full image data by item ID. Returns base64-encoded image.
pub fn get_image_data(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let result: Option<Vec<u8>> = conn
        .query_row(
            "SELECT data FROM blobs WHERE item_id = ?",
            params![id],
            |row| row.get(0),
        )
        .ok();

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    Ok(result.map(|bytes| STANDARD.encode(&bytes)))
}

// ============================================================================
// Update operations
// ============================================================================

/// Update a URL item's url and tags. Returns tag changes for side-effect handling.
pub fn update_url(
    conn: &Connection,
    id: &str,
    url: &str,
    tags: &[String],
    device_id: &str,
) -> Result<TagChanges, String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Verify item exists and is a URL type
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'url' AND deleted_at IS NULL",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Page not found".to_string());
    }

    // Update URL value, timestamp, and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta, device_id);
    conn.execute(
        // sync_error = NULL: editing the item gives a previously-rejected push another try.
        "UPDATE items SET url = ?, updated_at = ?, metadata = ?, sync_error = NULL WHERE id = ?",
        params![url, &now, &updated_meta, id],
    )
    .map_err(|e| format!("Failed to update item: {}", e))?;

    update_item_tags(conn, id, tags)
}

/// Update tags for any item type. Returns UpdateResult with tag changes and item info.
pub fn update_item_tags_command(
    conn: &Connection,
    id: &str,
    tags: &[String],
    device_id: &str,
) -> Result<UpdateResult, String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Get item info
    let item_info: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT type, url FROM items WHERE id = ? AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let (item_type, url) = match item_info {
        Some(info) => info,
        None => return Err("Item not found".to_string()),
    };

    // Update timestamp and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta, device_id);
    conn.execute(
        "UPDATE items SET updated_at = ?, metadata = ? WHERE id = ?",
        params![&now, &updated_meta, id],
    )
    .map_err(|e| format!("Failed to update item: {}", e))?;

    let tag_changes = update_item_tags(conn, id, tags)?;

    Ok(UpdateResult {
        tag_changes,
        item_type,
        url,
    })
}

/// Update a text item's content and tags. Returns final tags list.
pub fn update_text(
    conn: &Connection,
    id: &str,
    content: &str,
    tags: &[String],
    device_id: &str,
) -> Result<Vec<String>, String> {
    let now = chrono::Utc::now().to_rfc3339();

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'text' AND deleted_at IS NULL",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Text not found".to_string());
    }

    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta, device_id);
    conn.execute(
        "UPDATE items SET content = ?, updated_at = ?, metadata = ?, sync_error = NULL WHERE id = ?",
        params![content, &now, &updated_meta, id],
    )
    .map_err(|e| format!("Failed to update text: {}", e))?;

    // Combine UI-provided tags with hashtags parsed from content
    let hashtags = parse_hashtags(content);
    let mut new_tags: Vec<String> = tags.to_vec();
    for ht in hashtags {
        if !new_tags.contains(&ht) {
            new_tags.push(ht);
        }
    }

    update_item_tags(conn, id, &new_tags)?;

    Ok(new_tags)
}

/// Update a tagset's tags. Returns tag changes.
pub fn update_tagset(
    conn: &Connection,
    id: &str,
    tags: &[String],
    device_id: &str,
) -> Result<TagChanges, String> {
    if tags.is_empty() {
        return Err("At least one tag is required for a tagset".to_string());
    }

    let now = chrono::Utc::now().to_rfc3339();

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'tagset' AND deleted_at IS NULL",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Tagset not found".to_string());
    }

    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta, device_id);
    conn.execute(
        "UPDATE items SET updated_at = ?, metadata = ? WHERE id = ?",
        params![&now, &updated_meta, id],
    )
    .map_err(|e| format!("Failed to update tagset: {}", e))?;

    update_item_tags(conn, id, tags)
}

/// Update image tags. Returns tag changes.
pub fn update_image_tags(
    conn: &Connection,
    id: &str,
    tags: &[String],
    device_id: &str,
) -> Result<TagChanges, String> {
    let now = chrono::Utc::now().to_rfc3339();

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'image' AND deleted_at IS NULL",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Image not found".to_string());
    }

    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta, device_id);
    conn.execute(
        "UPDATE items SET updated_at = ?, metadata = ? WHERE id = ?",
        params![&now, &updated_meta, id],
    )
    .map_err(|e| format!("Failed to update image: {}", e))?;

    update_item_tags(conn, id, tags)
}

/// Update item metadata by merging new JSON into existing metadata.
/// Update item content text (e.g. OCR text for images).
pub fn get_item_content(
    conn: &Connection,
    id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT content FROM items WHERE id = ? AND deleted_at IS NULL",
        params![id],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to get item content: {}", e))
}

pub fn update_item_content(
    conn: &Connection,
    id: &str,
    content: &str,
    _device_id: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE items SET content = ?, updated_at = ?, sync_error = NULL WHERE id = ? AND deleted_at IS NULL",
        params![content, &now, id],
    )
    .map_err(|e| format!("Failed to update content: {}", e))?;
    Ok(())
}

pub fn update_item_metadata(
    conn: &Connection,
    id: &str,
    metadata_json: &str,
    device_id: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Get existing metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ? AND deleted_at IS NULL", params![id], |row| row.get(0))
        .map_err(|e| format!("Item not found: {}", e))?;

    // Merge new metadata into existing
    let mut merged: serde_json::Value = existing_meta
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let new_meta: serde_json::Value = serde_json::from_str(metadata_json)
        .map_err(|e| format!("Invalid metadata JSON: {}", e))?;

    if let (Some(merged_obj), Some(new_obj)) = (merged.as_object_mut(), new_meta.as_object()) {
        for (k, v) in new_obj {
            merged_obj.insert(k.clone(), v.clone());
        }
    }

    // Inject sync metadata
    let merged_str = serde_json::to_string(&merged).unwrap_or_default();
    let final_meta = inject_sync_metadata_for_update(Some(merged_str), device_id);

    conn.execute(
        "UPDATE items SET metadata = ?, updated_at = ?, sync_error = NULL WHERE id = ?",
        params![&final_meta, &now, id],
    )
    .map_err(|e| format!("Failed to update metadata: {}", e))?;

    Ok(())
}

// ============================================================================
// Delete operations
// ============================================================================

/// Soft-delete any item by ID (sets deleted_at timestamp).
pub fn delete_item(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?",
        params![&now, &now, id],
    )
    .map_err(|e| format!("Failed to delete item: {}", e))?;
    Ok(())
}

// ============================================================================
// Visit tracking
// ============================================================================

/// Record a visit to an item. Returns the visit ID.
pub fn record_visit(
    conn: &Connection,
    item_id: &str,
    source: &str,
    window_type: &str,
) -> Result<String, String> {
    let visit_id = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    conn.execute(
        "INSERT INTO item_visits (id, item_id, timestamp, source, window_type) VALUES (?, ?, ?, ?, ?)",
        params![&visit_id, item_id, timestamp, source, window_type],
    )
    .map_err(|e| format!("Failed to record visit: {}", e))?;

    Ok(visit_id)
}

/// Find or create a URL item for webview navigation tracking.
/// Tags it with from:history and records a visit. Returns item_id.
pub fn track_navigation(
    conn: &Connection,
    url: &str,
    device_id: &str,
) -> Result<String, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let url = normalize_url(url);

    // Check if this URL already exists
    let url_without_slash = url.strip_suffix('/').unwrap_or(&url);
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM items WHERE type = 'url' AND (url = ? OR url = ?) AND deleted_at IS NULL",
            params![&url, &url_without_slash],
            |row| row.get(0),
        )
        .ok();

    let item_id = if let Some(id) = existing_id {
        conn.execute(
            "UPDATE items SET updated_at = ? WHERE id = ?",
            params![&now, &id],
        ).map_err(|e| format!("Failed to update item: {}", e))?;
        id
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let metadata = inject_sync_metadata_for_save(None, device_id);
        let metadata_json = serde_json::to_string(&metadata).unwrap_or_default();
        conn.execute(
            "INSERT INTO items (id, type, url, metadata, created_at, updated_at) VALUES (?, 'url', ?, ?, ?, ?)",
            params![&id, &url, &metadata_json, &now, &now],
        ).map_err(|e| format!("Failed to insert item: {}", e))?;
        id
    };

    // Ensure from:history tag exists and is linked
    let tag_id = crate::tags::get_or_create_tag(conn, "from:history")?;
    crate::tags::link_tag_to_item(conn, &item_id, &tag_id)?;

    // Record the visit
    record_visit(conn, &item_id, "webview", "embedded")?;

    Ok(item_id)
}

// ============================================================================
// Query operations
// ============================================================================

/// Find an existing URL item by URL. Returns item info with tags if found.
pub fn find_existing_url(conn: &Connection, url: &str) -> Result<Option<SavedUrl>, String> {
    let normalized = normalize_url(url);
    let url_without_slash = normalized.strip_suffix('/').unwrap_or(&normalized);

    let row: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT id, url, created_at FROM items WHERE type = 'url' AND (url = ? OR url = ?) AND deleted_at IS NULL",
            params![&normalized, &url_without_slash],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();

    match row {
        None => Ok(None),
        Some((id, url, created_at)) => {
            let tags = get_item_tag_names_ordered(conn, &id)?;
            Ok(Some(SavedUrl {
                id,
                url: url.unwrap_or_default(),
                tags,
                saved_at: created_at,
                metadata: None,
            }))
        }
    }
}

// ============================================================================
// Paginated SQL-side query
// ============================================================================

/// Keyset pagination cursor: the (saved_at, id) of the last row of the prior page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub saved_at: String,
    pub id: String,
}

/// Arguments for `query_items` — filters/sort/pagination evaluated SQL-side.
/// Field names match what the frontend sends.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueryItemsArgs {
    /// Free-text search; None or empty = no search.
    pub search: Option<String>,
    /// AND filter: item must have ALL of these tag names. Also the "selected" set
    /// that suppresses the archive/auto-hide rules below.
    #[serde(default)]
    pub tags: Vec<String>,
    /// "all" | "page" | "text" | "tagset" | "image". "page" maps to DB 'url'.
    /// "all"/None = no type filter.
    pub item_type: Option<String>,
    /// Configured archive tag name (e.g. "archive").
    #[serde(default)]
    pub archive_tag: String,
    /// Auto-hide tag names (e.g. ["from:history"]).
    #[serde(default)]
    pub auto_hide_tags: Vec<String>,
    /// "newest" | "oldest".
    pub sort: String,
    /// Keyset pagination cursor; None = first page.
    pub cursor: Option<Cursor>,
    /// Page size.
    pub limit: u32,
}

/// A single item row returned by `query_items`. Field names match the
/// frontend's existing item interfaces. `type` is the raw DB value
/// ("url"|"text"|"tagset"|"image") — the frontend maps "url" -> "page" itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemRow {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub url: Option<String>,
    /// FULL content (not a preview).
    pub content: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub tags: Vec<String>,
    /// = created_at.
    pub saved_at: String,
    /// Image rows only (base64 thumbnail); null for non-image rows.
    pub thumbnail: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// Paginated, SQL-side filtered/sorted query over items.
///
/// Mirrors the previous JS-side filter behavior exactly (see field docs on
/// `QueryItemsArgs`). All user values are bound parameters — no string
/// interpolation of search/tag/cursor values.
pub fn query_items(conn: &Connection, args: QueryItemsArgs) -> Result<Vec<ItemRow>, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let search = args
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let has_search = search.is_some();

    // Bound params, in the exact order they appear in the SQL we build below.
    let mut binds: Vec<Box<dyn ToSql>> = Vec::new();

    let mut sql = String::from(
        "SELECT i.id, i.type, i.url, i.content, i.created_at, i.metadata, \
         b.mime_type, b.width, b.height, b.thumbnail \
         FROM items i \
         LEFT JOIN blobs b ON b.item_id = i.id \
         WHERE i.deleted_at IS NULL",
    );

    // type filter
    if let Some(t) = args.item_type.as_deref() {
        if !t.is_empty() && t != "all" {
            let db_type = if t == "page" { "url" } else { t };
            sql.push_str(" AND i.type = ?");
            binds.push(Box::new(db_type.to_string()));
        }
    }

    // search filter
    if let Some(s) = &search {
        sql.push_str(
            " AND ( i.url LIKE '%'||?||'%' \
             OR i.content LIKE '%'||?||'%' \
             OR i.metadata LIKE '%'||?||'%' \
             OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.id \
                WHERE it.item_id = i.id AND t.name LIKE '%'||?||'%') )",
        );
        binds.push(Box::new(s.clone()));
        binds.push(Box::new(s.clone()));
        binds.push(Box::new(s.clone()));
        binds.push(Box::new(s.clone()));
    }

    // tag AND-filter
    if !args.tags.is_empty() {
        let placeholders = vec!["?"; args.tags.len()].join(", ");
        sql.push_str(&format!(
            " AND (SELECT COUNT(DISTINCT t.name) FROM item_tags it JOIN tags t ON it.tag_id = t.id \
             WHERE it.item_id = i.id AND t.name IN ({})) = ?",
            placeholders
        ));
        for tag in &args.tags {
            binds.push(Box::new(tag.clone()));
        }
        binds.push(Box::new(args.tags.len() as i64));
    }

    // archive hide: exclude archive-tagged items unless archive_tag is selected
    if !args.archive_tag.is_empty() && !args.tags.contains(&args.archive_tag) {
        sql.push_str(
            " AND NOT EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.id \
             WHERE it.item_id = i.id AND t.name = ?)",
        );
        binds.push(Box::new(args.archive_tag.clone()));
    }

    // auto-hide: only when there's no active search
    if !has_search {
        for ah in &args.auto_hide_tags {
            if !args.tags.contains(ah) {
                sql.push_str(
                    " AND NOT EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.id \
                     WHERE it.item_id = i.id AND t.name = ?)",
                );
                binds.push(Box::new(ah.clone()));
            }
        }
    }

    // keyset pagination predicate + ordering
    let oldest = args.sort == "oldest";
    if let Some(cur) = &args.cursor {
        if oldest {
            sql.push_str(" AND (i.created_at, i.id) > (?, ?)");
        } else {
            sql.push_str(" AND (i.created_at, i.id) < (?, ?)");
        }
        binds.push(Box::new(cur.saved_at.clone()));
        binds.push(Box::new(cur.id.clone()));
    }

    if oldest {
        sql.push_str(" ORDER BY i.created_at ASC, i.id ASC");
    } else {
        sql.push_str(" ORDER BY i.created_at DESC, i.id DESC");
    }

    sql.push_str(" LIMIT ?");
    binds.push(Box::new(args.limit as i64));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare query_items: {}", e))?;

    let bind_refs: Vec<&dyn ToSql> = binds.iter().map(|b| b.as_ref()).collect();

    let raw_rows: Vec<(
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<Vec<u8>>,
    )> = stmt
        .query_map(bind_refs.as_slice(), |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })
        .map_err(|e| format!("Failed to query items: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut out: Vec<ItemRow> = Vec::with_capacity(raw_rows.len());
    for (id, r#type, url, content, created_at, metadata_json, mime_type, width, height, thumb_bytes) in
        raw_rows
    {
        let tags = get_item_tag_names_ordered(conn, &id)?;
        let metadata = metadata_json.and_then(|s| serde_json::from_str(&s).ok());
        let is_image = r#type == "image";
        let thumbnail = if is_image {
            thumb_bytes.map(|b| STANDARD.encode(&b))
        } else {
            None
        };
        let mime_type = if is_image { mime_type } else { None };
        let width = if is_image { width } else { None };
        let height = if is_image { height } else { None };

        out.push(ItemRow {
            id,
            r#type,
            url,
            content,
            metadata,
            tags,
            saved_at: created_at,
            thumbnail,
            mime_type,
            width,
            height,
        });
    }

    Ok(out)
}

// ============================================================================
// Helper
// ============================================================================

/// Get tag names for an item, ordered alphabetically.
fn get_item_tag_names_ordered(conn: &Connection, item_id: &str) -> Result<Vec<String>, String> {
    let mut tag_stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?
             ORDER BY t.name",
        )
        .map_err(|e| format!("Failed to prepare tag query: {}", e))?;

    let tags: Vec<String> = tag_stmt
        .query_map(params![item_id], |row| row.get(0))
        .map_err(|e| format!("Failed to query tags for item: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::ensure_database_initialized;
    use crate::tags::get_item_tag_names;

    fn setup_db() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        let device_id = ensure_database_initialized(&conn).unwrap();
        (conn, device_id)
    }

    #[test]
    fn test_save_url_new() {
        let (conn, device_id) = setup_db();
        let result = save_url(&conn, "https://example.com", &["tag1".to_string()], None, &device_id).unwrap();
        assert!(result.is_new);
        assert!(!result.item_id.is_empty());
    }

    #[test]
    fn test_save_url_existing() {
        let (conn, device_id) = setup_db();
        let r1 = save_url(&conn, "https://example.com", &["tag1".to_string()], None, &device_id).unwrap();
        let r2 = save_url(&conn, "https://example.com", &["tag2".to_string()], None, &device_id).unwrap();
        assert!(r1.is_new);
        assert!(!r2.is_new);
        assert_eq!(r1.item_id, r2.item_id);
    }

    #[test]
    fn test_save_url_normalizes() {
        let (conn, device_id) = setup_db();
        // Bare domain should get trailing slash
        let r1 = save_url(&conn, "https://example.com", &[], None, &device_id).unwrap();
        // With trailing slash should find the same item
        let r2 = save_url(&conn, "https://example.com/", &[], None, &device_id).unwrap();
        assert_eq!(r1.item_id, r2.item_id);
    }

    #[test]
    fn test_save_text() {
        let (conn, device_id) = setup_db();
        let id = save_text(&conn, "Hello #world", Some(&["extra".to_string()]), None, &device_id).unwrap();
        assert!(!id.is_empty());

        // Should have both "world" (hashtag) and "extra" tags
        let tags = get_item_tag_names(&conn, &id).unwrap();
        assert!(tags.contains("world"));
        assert!(tags.contains("extra"));
    }

    #[test]
    fn test_save_tagset() {
        let (conn, device_id) = setup_db();
        let id = save_tagset(&conn, &["a".to_string(), "b".to_string()], None, &device_id).unwrap();
        assert!(!id.is_empty());

        let tags = get_item_tag_names(&conn, &id).unwrap();
        assert_eq!(tags.len(), 2);
    }

    #[test]
    fn test_save_tagset_empty_fails() {
        let (conn, device_id) = setup_db();
        let result = save_tagset(&conn, &[], None, &device_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_save_image() {
        let (conn, device_id) = setup_db();
        let image_bytes = b"fake image data";
        let id = save_image(&conn, image_bytes, "image/jpeg", &["photo".to_string()], None, None, Some(100), Some(200), &device_id).unwrap();
        assert!(!id.is_empty());

        let images = get_saved_images(&conn).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].width, Some(100));
        assert_eq!(images[0].height, Some(200));
    }

    #[test]
    fn test_get_saved_urls() {
        let (conn, device_id) = setup_db();
        save_url(&conn, "https://a.com", &["tag1".to_string()], None, &device_id).unwrap();
        save_url(&conn, "https://b.com", &["tag2".to_string()], None, &device_id).unwrap();

        let urls = get_saved_urls(&conn).unwrap();
        assert_eq!(urls.len(), 2);
    }

    #[test]
    fn test_delete_item() {
        let (conn, device_id) = setup_db();
        let result = save_url(&conn, "https://example.com", &[], None, &device_id).unwrap();
        delete_item(&conn, &result.item_id).unwrap();

        let urls = get_saved_urls(&conn).unwrap();
        assert_eq!(urls.len(), 0); // Soft-deleted, should not appear
    }

    #[test]
    fn test_update_url() {
        let (conn, device_id) = setup_db();
        let result = save_url(&conn, "https://old.com", &["tag1".to_string()], None, &device_id).unwrap();

        let changes = update_url(&conn, &result.item_id, "https://new.com", &["tag2".to_string()], &device_id).unwrap();
        assert!(changes.tags_added.contains(&"tag2".to_string()));
        assert!(changes.tags_removed.contains(&"tag1".to_string()));
    }

    #[test]
    fn test_update_text() {
        let (conn, device_id) = setup_db();
        let id = save_text(&conn, "original", None, None, &device_id).unwrap();
        let final_tags = update_text(&conn, &id, "updated #newtag", &["manual".to_string()], &device_id).unwrap();
        assert!(final_tags.contains(&"newtag".to_string()));
        assert!(final_tags.contains(&"manual".to_string()));
    }

    /// Editing an item clears a parked sync_error so a fixed item retries.
    #[test]
    fn test_update_clears_sync_error() {
        let (conn, device_id) = setup_db();
        let id = save_text(&conn, "", None, None, &device_id).unwrap();
        // Simulate the server having parked this item (e.g. rejected empty content).
        conn.execute("UPDATE items SET sync_error = 'status 400: bad' WHERE id = ?", params![&id]).unwrap();
        let parked: Option<String> = conn
            .query_row("SELECT sync_error FROM items WHERE id = ?", params![&id], |r| r.get(0))
            .unwrap();
        assert_eq!(parked.as_deref(), Some("status 400: bad"));

        update_text(&conn, &id, "now has content", &[], &device_id).unwrap();

        let after: Option<String> = conn
            .query_row("SELECT sync_error FROM items WHERE id = ?", params![&id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, None, "editing should clear the parked sync_error");
    }

    #[test]
    fn test_record_visit() {
        let (conn, device_id) = setup_db();
        let result = save_url(&conn, "https://example.com", &[], None, &device_id).unwrap();
        let visit_id = record_visit(&conn, &result.item_id, "direct", "main").unwrap();
        assert!(!visit_id.is_empty());
    }

    #[test]
    fn test_track_navigation_new() {
        let (conn, device_id) = setup_db();
        let item_id = track_navigation(&conn, "https://example.com/page", &device_id).unwrap();
        assert!(!item_id.is_empty());

        let tags = get_item_tag_names(&conn, &item_id).unwrap();
        assert!(tags.contains("from:history"));
    }

    #[test]
    fn test_track_navigation_existing() {
        let (conn, device_id) = setup_db();
        let id1 = track_navigation(&conn, "https://example.com/page", &device_id).unwrap();
        let id2 = track_navigation(&conn, "https://example.com/page", &device_id).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_find_existing_url() {
        let (conn, device_id) = setup_db();
        // Not found
        assert!(find_existing_url(&conn, "https://example.com").unwrap().is_none());

        // Save and find
        save_url(&conn, "https://example.com", &["tag1".to_string()], None, &device_id).unwrap();
        let found = find_existing_url(&conn, "https://example.com").unwrap().unwrap();
        assert_eq!(found.url, "https://example.com/");
        assert!(found.tags.contains(&"tag1".to_string()));
    }

    #[test]
    fn test_find_existing_url_normalized() {
        let (conn, device_id) = setup_db();
        save_url(&conn, "https://example.com/", &[], None, &device_id).unwrap();
        // Should find with or without trailing slash
        assert!(find_existing_url(&conn, "https://example.com").unwrap().is_some());
        assert!(find_existing_url(&conn, "https://example.com/").unwrap().is_some());
    }

    #[test]
    fn test_get_image_data() {
        let (conn, device_id) = setup_db();
        let image_bytes = b"test image content";
        let id = save_image(&conn, image_bytes, "image/png", &[], None, None, None, None, &device_id).unwrap();

        let data = get_image_data(&conn, &id).unwrap();
        assert!(data.is_some());
        // Verify round-trip through base64
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let decoded = STANDARD.decode(data.unwrap()).unwrap();
        assert_eq!(decoded, image_bytes);
    }

    #[test]
    fn test_image_has_null_content_by_default() {
        let (conn, device_id) = setup_db();
        let image_bytes = b"image without content";
        let id = save_image(&conn, image_bytes, "image/jpeg", &[], None, None, None, None, &device_id).unwrap();

        // Newly saved images should have NULL content
        let images = get_saved_images(&conn).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].id, id);
        assert!(images[0].content.is_none(), "Newly saved image should have NULL content");

        // Also verify via get_item_content
        let content = get_item_content(&conn, &id).unwrap();
        assert!(content.is_none(), "get_item_content should return None for new image");
    }

    #[test]
    fn test_get_item_content_after_update() {
        let (conn, device_id) = setup_db();
        let image_bytes = b"image for content test";
        let id = save_image(&conn, image_bytes, "image/jpeg", &[], None, None, None, None, &device_id).unwrap();

        // Set content via update_item_content
        update_item_content(&conn, &id, "OCR extracted text from image", &device_id).unwrap();

        // get_item_content should return the content
        let content = get_item_content(&conn, &id).unwrap();
        assert_eq!(content, Some("OCR extracted text from image".to_string()));
    }

    #[test]
    fn test_get_saved_images_returns_content_field() {
        let (conn, device_id) = setup_db();
        let image_bytes = b"image with content";
        let id = save_image(&conn, image_bytes, "image/png", &["photo".to_string()], None, None, Some(640), Some(480), &device_id).unwrap();

        // Initially no content
        let images = get_saved_images(&conn).unwrap();
        assert_eq!(images.len(), 1);
        assert!(images[0].content.is_none());

        // Set content
        update_item_content(&conn, &id, "A description of the image contents", &device_id).unwrap();

        // get_saved_images should now include the content
        let images = get_saved_images(&conn).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].content, Some("A description of the image contents".to_string()));
        // Other fields should still be correct
        assert_eq!(images[0].id, id);
        assert_eq!(images[0].width, Some(640));
        assert_eq!(images[0].height, Some(480));
        assert!(images[0].tags.contains(&"photo".to_string()));
    }
}
