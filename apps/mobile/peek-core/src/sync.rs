//! Sync database operations for peek-core.
//!
//! Contains all sync-related DB operations: get/set last_sync, merge server items,
//! get items to push, mark items synced, etc. HTTP transport stays in lib.rs.

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

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
    pub title: String,
    pub domain: String,
    pub favicon: String,
    pub frecency_score: i64,
    /// Raw image bytes from the `blobs` table (image rows only; the local `content`
    /// column holds OCR text for images, not the payload — see `get_items_to_push`).
    pub image_data: Option<Vec<u8>>,
    /// The blob's mime type (image rows only).
    pub image_mime: Option<String>,
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

fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?", params![key], |row| row.get(0))
        .ok()
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        params![key, value],
    )
    .map_err(|e| format!("Failed to set {}: {}", key, e))?;
    Ok(())
}

/// Get the watermark for pulling events from the server.
pub fn get_last_events_pull(conn: &Connection) -> Result<Option<String>, String> {
    Ok(get_setting(conn, "last_events_pull"))
}

/// Set the watermark for pulling events from the server.
pub fn set_last_events_pull(conn: &Connection, timestamp: &str) -> Result<(), String> {
    set_setting(conn, "last_events_pull", timestamp)
}

/// Get the watermark for pulling visits from the server.
pub fn get_last_visits_pull(conn: &Connection) -> Result<Option<String>, String> {
    Ok(get_setting(conn, "last_visits_pull"))
}

/// Set the watermark for pulling visits from the server.
pub fn set_last_visits_pull(conn: &Connection, timestamp: &str) -> Result<(), String> {
    set_setting(conn, "last_visits_pull", timestamp)
}

/// An item event ready to be pushed. `item_id` holds the item's `sync_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushEvent {
    pub id: String,
    pub item_id: String,
    pub content: Option<String>,
    pub value: Option<f64>,
    pub occurred_at: i64,
    pub metadata: serde_json::Value,
    pub created_at: i64,
}

/// An item visit ready to be pushed. `item_id` holds the item's `sync_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushVisit {
    pub id: String,
    pub item_id: String,
    pub timestamp: i64,
    pub duration: i64,
    pub source: String,
    pub source_id: String,
    pub window_type: String,
    pub metadata: serde_json::Value,
    pub scroll_depth: i64,
    pub interacted: i64,
    pub prev_id: Option<String>,
    pub next_id: Option<String>,
}

/// An event as the server returns it; `item_id` is the server item id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    pub id: String,
    pub item_id: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub value: Option<f64>,
    pub occurred_at: i64,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    pub created_at: i64,
}

/// A visit as the server returns it; `item_id` is the server item id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerVisit {
    pub id: String,
    pub item_id: String,
    pub timestamp: i64,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub window_type: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub scroll_depth: Option<i64>,
    #[serde(default)]
    pub interacted: Option<i64>,
    #[serde(default)]
    pub prev_id: Option<String>,
    #[serde(default)]
    pub next_id: Option<String>,
}

/// Result of merging one pulled event or visit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// A row was written (or, for an event, already present).
    Merged,
    /// The row's item is not present locally, or the row is malformed.
    Skipped,
    /// A local visit with an unpushed change was left alone.
    KeptLocal,
}

fn parse_metadata(raw: Option<String>) -> serde_json::Value {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn metadata_to_string(meta: &Option<serde_json::Value>) -> String {
    match meta {
        None | Some(serde_json::Value::Null) => "{}".to_string(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}

fn local_item_id_for_sync_id(conn: &Connection, sync_id: &str) -> Option<String> {
    if sync_id.is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT id FROM items WHERE sync_id = ? LIMIT 1",
        params![sync_id],
        |row| row.get(0),
    )
    .ok()
}

/// Events not yet delivered (`pushedAt = 0`) whose item has a sync id, oldest first.
/// Rows with a non-finite `occurredAt` or `createdAt` are skipped and stay unpushed.
pub fn get_events_to_push(conn: &Connection, limit: usize) -> Result<Vec<PushEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, i.sync_id, e.content, e.value, e.occurredAt, e.metadata, e.createdAt \
             FROM item_events e JOIN items i ON e.itemId = i.id \
             WHERE COALESCE(i.sync_id, '') != '' AND e.pushedAt = 0 \
             ORDER BY e.createdAt ASC",
        )
        .map_err(|e| format!("Failed to prepare events query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, Option<f64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<f64>>(6)?,
            ))
        })
        .map_err(|e| format!("Failed to query events: {}", e))?;

    let mut out = Vec::new();
    for r in rows.filter_map(|r| r.ok()) {
        let (id, item_id, content, value, occurred, metadata, created) = r;
        let (Some(occurred), Some(created)) = (occurred, created) else { continue };
        if !occurred.is_finite() || !created.is_finite() || id.is_empty() {
            continue;
        }
        out.push(PushEvent {
            id,
            item_id,
            content,
            value: value.filter(|v| v.is_finite()),
            occurred_at: occurred as i64,
            metadata: parse_metadata(metadata),
            created_at: created as i64,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Stamp events as delivered.
pub fn mark_events_pushed(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let now = Utc::now().timestamp_millis();
    for id in ids {
        conn.execute("UPDATE item_events SET pushedAt = ? WHERE id = ?", params![now, id])
            .map_err(|e| format!("Failed to mark event pushed: {}", e))?;
    }
    Ok(())
}

/// Insert a pulled event if absent. Skipped when its item is not present locally.
pub fn merge_server_event(conn: &Connection, ev: ServerEvent) -> Result<MergeOutcome, String> {
    let Some(local_id) = local_item_id_for_sync_id(conn, &ev.item_id) else {
        return Ok(MergeOutcome::Skipped);
    };
    if ev.id.is_empty() {
        return Ok(MergeOutcome::Skipped);
    }
    conn.execute(
        "INSERT OR IGNORE INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt, pushedAt) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            ev.id,
            local_id,
            ev.content,
            ev.value,
            ev.occurred_at,
            metadata_to_string(&ev.metadata),
            ev.created_at,
            Utc::now().timestamp_millis()
        ],
    )
    .map_err(|e| format!("Failed to merge event: {}", e))?;
    Ok(MergeOutcome::Merged)
}

/// Visits not yet delivered (`pushed_at = 0`) whose item has a sync id, oldest first.
pub fn get_visits_to_push(conn: &Connection, limit: usize) -> Result<Vec<PushVisit>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT v.id, i.sync_id, v.timestamp, COALESCE(v.duration, 0), COALESCE(v.source, 'direct'), \
             COALESCE(v.source_id, ''), COALESCE(v.window_type, 'main'), v.metadata, \
             COALESCE(v.scroll_depth, 0), COALESCE(v.interacted, 0), v.prev_id, v.next_id \
             FROM item_visits v JOIN items i ON v.item_id = i.id \
             WHERE COALESCE(i.sync_id, '') != '' AND v.pushed_at = 0 \
             ORDER BY v.timestamp ASC, v.id ASC LIMIT ?",
        )
        .map_err(|e| format!("Failed to prepare visits query: {}", e))?;

    let visits = stmt
        .query_map(params![limit as i64], |row| {
            Ok(PushVisit {
                id: row.get(0)?,
                item_id: row.get(1)?,
                timestamp: row.get(2)?,
                duration: row.get(3)?,
                source: row.get(4)?,
                source_id: row.get(5)?,
                window_type: row.get(6)?,
                metadata: parse_metadata(row.get(7)?),
                scroll_depth: row.get(8)?,
                interacted: row.get(9)?,
                prev_id: row.get(10)?,
                next_id: row.get(11)?,
            })
        })
        .map_err(|e| format!("Failed to query visits: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(visits)
}

/// Stamp visits as delivered.
pub fn mark_visits_pushed(conn: &Connection, ids: &[String]) -> Result<(), String> {
    let now = Utc::now().timestamp_millis();
    for id in ids {
        conn.execute("UPDATE item_visits SET pushed_at = ? WHERE id = ?", params![now, id])
            .map_err(|e| format!("Failed to mark visit pushed: {}", e))?;
    }
    Ok(())
}

/// Upsert a pulled visit by id. Does not touch the item's visit count or last-visit time.
/// A local visit with an unpushed change (`pushed_at = 0`) is kept so the push carries it.
pub fn merge_server_visit(conn: &Connection, v: ServerVisit) -> Result<MergeOutcome, String> {
    let Some(local_id) = local_item_id_for_sync_id(conn, &v.item_id) else {
        return Ok(MergeOutcome::Skipped);
    };
    if v.id.is_empty() {
        return Ok(MergeOutcome::Skipped);
    }
    let existing: Option<i64> = conn
        .query_row("SELECT pushed_at FROM item_visits WHERE id = ?", params![v.id], |row| row.get(0))
        .ok();
    if existing == Some(0) {
        return Ok(MergeOutcome::KeptLocal);
    }
    conn.execute(
        "INSERT INTO item_visits (id, item_id, timestamp, duration, source, source_id, window_type, metadata, \
         scroll_depth, interacted, prev_id, next_id, pushed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           item_id = excluded.item_id, timestamp = excluded.timestamp, duration = excluded.duration, \
           source = excluded.source, source_id = excluded.source_id, window_type = excluded.window_type, \
           metadata = excluded.metadata, scroll_depth = excluded.scroll_depth, \
           interacted = excluded.interacted, prev_id = excluded.prev_id, next_id = excluded.next_id, \
           pushed_at = excluded.pushed_at",
        params![
            v.id,
            local_id,
            v.timestamp,
            v.duration.unwrap_or(0),
            v.source.unwrap_or_else(|| "direct".to_string()),
            v.source_id.unwrap_or_default(),
            v.window_type.unwrap_or_else(|| "main".to_string()),
            metadata_to_string(&v.metadata),
            v.scroll_depth.unwrap_or(0),
            v.interacted.unwrap_or(0),
            v.prev_id,
            v.next_id,
            Utc::now().timestamp_millis()
        ],
    )
    .map_err(|e| format!("Failed to merge visit: {}", e))?;
    Ok(MergeOutcome::Merged)
}

/// Item types this client syncs by default. Mobile intentionally pushes only these
/// user-curated types; locally-derived types (entity/series/feed) stay on-device and
/// must never inflate the pending count or get pushed — thousands of unsyncable
/// `entity` rows were the 5000+-pending bug (e9dce12a). Override per-install via the
/// `synced_types` settings row.
pub const DEFAULT_SYNCED_TYPES: [&str; 4] = ["url", "text", "tagset", "image"];

/// The item types the current install should sync: the comma-separated `synced_types`
/// settings row if present and non-empty, else `DEFAULT_SYNCED_TYPES`. This is the
/// client-side "choose what to sync" control; the server stores any type it is sent.
pub fn get_synced_types(conn: &Connection) -> Vec<String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'synced_types'",
            [],
            |row| row.get(0),
        )
        .ok();
    let types: Vec<String> = raw
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if types.is_empty() {
        DEFAULT_SYNCED_TYPES.iter().map(|s| s.to_string()).collect()
    } else {
        types
    }
}

/// Build the WHERE clause + bound params selecting items that still need to be pushed
/// to `target_profile_id` AND whose type is in the synced set. The count and the fetch
/// share this builder so the badge and the actual push set can never drift.
///
/// An item is pending for the bucket if it has never synced, was modified since its
/// last sync, or was last synced to a DIFFERENT bucket (so a rebound profile re-pushes
/// to the new bucket). Parked rows (`sync_error`) and non-synced types are excluded.
///
/// Anonymous `?` placeholders bind in this order: [synced types..., bucket, bucket].
fn pending_for_bucket(synced_types: &[String], target_profile_id: &str) -> (String, Vec<String>) {
    let placeholders = vec!["?"; synced_types.len()].join(", ");
    let where_clause = format!(
        "type IN ({}) AND (\
            (deleted_at IS NULL AND sync_error IS NULL AND (\
                synced_at IS NULL \
                OR updated_at > synced_at \
                OR synced_profile_id IS NULL \
                OR synced_profile_id != ?)) \
            OR (deleted_at IS NOT NULL AND sync_id IS NOT NULL AND sync_id != '' \
                AND synced_at IS NOT NULL AND updated_at > synced_at \
                AND (synced_profile_id IS NULL OR synced_profile_id = ?)))",
        placeholders
    );
    let mut bind: Vec<String> = synced_types.to_vec();
    bind.push(target_profile_id.to_string());
    bind.push(target_profile_id.to_string());
    (where_clause, bind)
}

/// Count items that need to be pushed to the given server bucket (syncable types only).
///
/// `target_profile_id` is the server bucket the current profile syncs to (its
/// `server_profile_id`, or the local profile UUID fallback before registration).
pub fn get_pending_sync_count(conn: &Connection, target_profile_id: &str) -> Result<usize, String> {
    let synced_types = get_synced_types(conn);
    let (where_clause, bind) = pending_for_bucket(&synced_types, target_profile_id);
    let count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM items WHERE {}", where_clause),
            rusqlite::params_from_iter(bind.iter()),
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(count as usize)
}

/// Get items that need to be pushed to `target_profile_id` (syncable types only; never
/// synced, locally modified after their last sync, or last synced to a different bucket).
///
/// Left-joins `blobs` so image rows carry their raw bytes + mime type: an image's local
/// `content` column holds OCR text (set later by vision processing), not the payload —
/// the actual bytes live in `blobs.data`, keyed by `item_id`. Non-image rows have no
/// blob and get `image_data`/`image_mime` of `None`.
pub fn get_items_to_push(conn: &Connection, target_profile_id: &str) -> Result<Vec<PushItem>, String> {
    let synced_types = get_synced_types(conn);
    let (where_clause, bind) = pending_for_bucket(&synced_types, target_profile_id);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT items.id, type, url, content, COALESCE(metadata, ''), updated_at, COALESCE(sync_id, ''), deleted_at, \
             COALESCE(title, ''), COALESCE(domain, ''), COALESCE(favicon, ''), COALESCE(frecency_score, 0), \
             blobs.data, blobs.mime_type \
             FROM items LEFT JOIN blobs ON blobs.item_id = items.id
             WHERE {}",
            where_clause
        ))
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let items: Vec<PushItem> = stmt
        .query_map(rusqlite::params_from_iter(bind.iter()), |row| {
            Ok(PushItem {
                id: row.get(0)?,
                item_type: row.get(1)?,
                url: row.get(2)?,
                content: row.get(3)?,
                metadata: row.get(4)?,
                updated_at: row.get(5)?,
                sync_id: row.get(6)?,
                deleted_at: row.get(7)?,
                title: row.get(8)?,
                domain: row.get(9)?,
                favicon: row.get(10)?,
                frecency_score: row.get(11)?,
                image_data: row.get(12)?,
                image_mime: row.get(13)?,
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

/// Mark an item as synced after a successful push to `server_profile_id`.
/// Records WHICH bucket the item was synced to so a later rebind re-pushes it, and
/// clears any prior `sync_error` (a previously-rejected item that now succeeded).
pub fn mark_item_synced(
    conn: &Connection,
    item_id: &str,
    sync_id: &str,
    server_profile_id: &str,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE items SET sync_id = ?, synced_at = ?, synced_profile_id = ?, sync_error = NULL WHERE id = ?",
        params![sync_id, &now, server_profile_id, item_id],
    )
    .map_err(|e| format!("Failed to mark item synced: {}", e))?;
    Ok(())
}

/// Park an item the server PERMANENTLY rejected (a 4xx that won't change on retry,
/// e.g. validation failure or oversized blob). Recording `error` excludes it from
/// the pending set + count so it stops being re-pushed every sync and stops
/// inflating the "pending" badge. Cleared on a later successful sync (mark_item_synced)
/// or when the item is edited (update_* clear it), so a fixed item retries.
pub fn mark_item_sync_failed(conn: &Connection, item_id: &str, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE items SET sync_error = ? WHERE id = ?",
        params![error, item_id],
    )
    .map_err(|e| format!("Failed to mark item sync-failed: {}", e))?;
    Ok(())
}

/// Count items the server permanently rejected (parked with a `sync_error`). Lets
/// the UI surface "N items couldn't sync" distinctly from the live pending count.
pub fn get_sync_failed_count(conn: &Connection) -> Result<usize, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND sync_error IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(count as usize)
}

/// What the client should do with a single item's push response. Keeping the
/// decision in one pure, unit-tested function means the HTTP loop in lib.rs stays a
/// thin executor and the "won't clear" classification can't silently drift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    /// 2xx with a parseable server id -> mark synced with this id.
    Synced(String),
    /// 409 -> client/app is outdated; stop the batch (do not keep hammering).
    VersionMismatch(String),
    /// Permanent 4xx (validation/size/etc.) -> park the item with this reason.
    Rejected(String),
    /// Transient (network/5xx/408/429, or a 2xx whose body we couldn't parse) ->
    /// leave pending; it is safe to retry (server dedups by syncId).
    Retry(String),
}

/// Classify a push response by HTTP status + body. `parsed_id` is the server item id
/// already extracted from a 2xx body (None if the body could not be parsed).
pub fn classify_push_response(status: u16, body: &str, parsed_id: Option<&str>) -> PushOutcome {
    match status {
        200..=299 => match parsed_id {
            Some(id) if !id.is_empty() => PushOutcome::Synced(id.to_string()),
            // Success status but unusable body (proxy page, missing id). Re-pushing is
            // safe because the server dedups by syncId, so retry rather than guess.
            _ => PushOutcome::Retry(format!("unparseable success body: {}", truncate(body))),
        },
        409 => PushOutcome::VersionMismatch(truncate(body)),
        // Retryable client statuses: request timeout / rate limit.
        408 | 429 => PushOutcome::Retry(format!("status {}: {}", status, truncate(body))),
        // Other 4xx are permanent for this item as-is (won't change on blind retry).
        400..=499 => PushOutcome::Rejected(format!("status {}: {}", status, truncate(body))),
        // 5xx (and anything else) are server-side/transient.
        _ => PushOutcome::Retry(format!("status {}: {}", status, truncate(body))),
    }
}

/// Keep logged/stored server bodies short (char-boundary safe).
fn truncate(s: &str) -> String {
    const MAX: usize = 200;
    if s.chars().count() <= MAX {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(MAX).collect::<String>())
    }
}

/// One-time heal for legacy rows that predate the `synced_profile_id` column.
///
/// Such rows have `synced_at` set but `synced_profile_id` NULL, so they would all
/// look "synced to a different bucket" and re-push. For the PRIMARY (Default)
/// profile we trust that history — its items really were synced to its bucket — so
/// we stamp `server_profile_id` onto them, avoiding a full re-push. Non-primary
/// profiles are deliberately NOT healed: their NULL rows re-push to their correct
/// bucket, which is exactly how we recover from the cross-bucket contamination.
///
/// Idempotent: only touches rows that are already synced and still NULL.
pub fn backfill_synced_profile_id(conn: &Connection, server_profile_id: &str) -> Result<usize, String> {
    let n = conn.execute(
        "UPDATE items SET synced_profile_id = ?1
         WHERE synced_at IS NOT NULL AND synced_profile_id IS NULL",
        params![server_profile_id],
    )
    .map_err(|e| format!("Failed to backfill synced_profile_id: {}", e))?;
    Ok(n)
}

/// Merge a server item into the local database.
/// Returns "pulled", "conflict", or "skipped".
///
/// `synced_profile_id` is the bucket the item was pulled from; every row this writes is
/// stamped with it (alongside `synced_at`) so a pulled item is recorded as already
/// synced to that bucket and does not immediately re-enter the pending set / get pushed
/// back on the next cycle.
pub fn merge_server_item(conn: &Connection, server_item: &ServerItem, synced_profile_id: &str) -> Result<&'static str, String> {
    // Only pull types this client is configured to sync. The server is a shared
    // store that holds every type, but a client that doesn't sync a type must not
    // pull it either — otherwise mobile (url/text/tagset/image by default) would
    // accumulate the desktop's entity/series/feed rows from a shared bucket. Also
    // covers tombstones for non-synced types, which are irrelevant locally.
    let synced_types = get_synced_types(conn);
    if !synced_types.iter().any(|t| t == &server_item.item_type) {
        return Ok("skipped");
    }

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
                "UPDATE items SET synced_at = ?, synced_profile_id = ? WHERE id = ?",
                params![&now, synced_profile_id, &local_id],
            ).map_err(|e| format!("Failed to update synced_at: {}", e))?;
            return Ok("pulled");
        }
        // Soft-delete the local item
        println!("[Rust] Sync: Soft-deleting local item {} from server delete", server_item.id);
        conn.execute(
            "UPDATE items SET deleted_at = ?, updated_at = ?, synced_at = ?, synced_profile_id = ? WHERE id = ?",
            params![&now, &now, &now, synced_profile_id, &local_id],
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
                        "UPDATE items SET deleted_at = NULL, type = ?, url = ?, content = ?, metadata = ?, updated_at = ?, synced_at = ?, synced_profile_id = ?, title = ?, domain = ?, favicon = ?, frecency_score = ? WHERE id = ?",
                        params![
                            item_type, url_val, content_val, &metadata_json,
                            &unix_ms_to_iso(server_item.updated_at), &now, synced_profile_id,
                            &server_item.title, &server_item.domain, &server_item.favicon, server_item.frecency_score,
                            local_id
                        ],
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
                    "UPDATE items SET type = ?, url = ?, content = ?, metadata = ?, updated_at = ?, synced_at = ?, synced_profile_id = ?, title = ?, domain = ?, favicon = ?, frecency_score = ? WHERE id = ?",
                    params![
                        item_type, url_val, content_val, &metadata_json,
                        &unix_ms_to_iso(server_item.updated_at), &now, synced_profile_id,
                        &server_item.title, &server_item.domain, &server_item.favicon, server_item.frecency_score,
                        &local_id
                    ],
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
        "INSERT INTO items (id, type, url, content, metadata, sync_id, synced_at, synced_profile_id, created_at, updated_at, title, domain, favicon, frecency_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            &new_id,
            item_type,
            url_val,
            content_val,
            &metadata_json,
            &server_item.id,
            &now,
            synced_profile_id,
            &unix_ms_to_iso(server_item.created_at),
            &unix_ms_to_iso(server_item.updated_at),
            &server_item.title,
            &server_item.domain,
            &server_item.favicon,
            server_item.frecency_score
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
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 0);
    }

    #[test]
    fn test_get_items_to_push_empty() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        let items = get_items_to_push(&conn, "bucket-a").unwrap();
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
            title: String::new(),
            domain: String::new(),
            favicon: String::new(),
            frecency_score: 0,
        };

        let result = merge_server_item(&conn, &server_item, "bucket-a").unwrap();
        assert_eq!(result, "pulled");

        // Verify item was inserted
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE sync_id = 'server-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);

        // Pulled item is stamped with the bucket it came from, so it is NOT pending
        // for that bucket (it must not re-push straight back).
        let synced_bucket: Option<String> = conn.query_row(
            "SELECT synced_profile_id FROM items WHERE sync_id = 'server-1'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(synced_bucket.as_deref(), Some("bucket-a"));
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 0);

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
            title: String::new(),
            domain: String::new(),
            favicon: String::new(),
            frecency_score: 0,
        };

        let result = merge_server_item(&conn, &server_item, "bucket-a").unwrap();
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
        let items = get_items_to_push(&conn, "bucket-a").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_type, "url");

        let count = get_pending_sync_count(&conn, "bucket-a").unwrap();
        assert_eq!(count, 1);
    }

    /// The push payload for an image row must carry the blob's raw bytes + mime type
    /// (fetched via the `blobs` join), not the local `content` column — that holds
    /// OCR text, which is a different field entirely and must not leak into it.
    /// Non-image rows must come back exactly as before, with no blob attached.
    #[test]
    fn test_items_to_push_carries_blob_for_image_rows() {
        let store = PeekStore::new(":memory:").unwrap();
        let image_bytes = b"fake jpeg bytes".to_vec();
        let image_id = store
            .save_image(&image_bytes, "image/jpeg", &[], None, None, Some(100), Some(200))
            .unwrap();
        store.update_item_content(&image_id, "OCR text from the image").unwrap();
        let url_result = store.save_url("https://example.com", &[], None).unwrap();

        let conn = store.conn.lock().unwrap();
        let mut items = get_items_to_push(&conn, "bucket-a").unwrap();
        assert_eq!(items.len(), 2);
        items.sort_by(|a, b| a.item_type.cmp(&b.item_type));

        let image_item = &items[0];
        assert_eq!(image_item.item_type, "image");
        assert_eq!(image_item.content.as_deref(), Some("OCR text from the image"));
        assert_eq!(image_item.image_data, Some(image_bytes));
        assert_eq!(image_item.image_mime.as_deref(), Some("image/jpeg"));

        let url_item = &items[1];
        assert_eq!(url_item.item_type, "url");
        assert_eq!(url_item.id, url_result.item_id);
        assert_eq!(url_item.image_data, None);
        assert_eq!(url_item.image_mime, None);
    }

    #[test]
    fn test_mark_item_synced() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();

        let conn = store.conn.lock().unwrap();

        // Before marking synced, item should be pending
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 1);

        mark_item_synced(&conn, &result.item_id, "server-id-1", "bucket-a").unwrap();

        // After marking synced to bucket-a, item should no longer be pending for it
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 0);
    }

    /// Repro for the Dev-1-of-7 bug: an item synced to one bucket must be treated
    /// as pending for a DIFFERENT bucket, so a rebound profile re-pushes it.
    #[test]
    fn test_item_synced_to_other_bucket_is_pending_for_new_bucket() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();
        let conn = store.conn.lock().unwrap();

        // Simulate a successful push to bucket-a.
        mark_item_synced(&conn, &result.item_id, "server-id-1", "bucket-a").unwrap();

        // Already synced to bucket-a -> not pending for bucket-a.
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 0);
        assert!(get_items_to_push(&conn, "bucket-a").unwrap().is_empty());

        // But it has never been pushed to bucket-b -> must be pending there.
        assert_eq!(get_pending_sync_count(&conn, "bucket-b").unwrap(), 1);
        assert_eq!(get_items_to_push(&conn, "bucket-b").unwrap().len(), 1);

        // After re-pushing to bucket-b it settles there too.
        mark_item_synced(&conn, &result.item_id, "server-id-1", "bucket-b").unwrap();
        assert_eq!(get_pending_sync_count(&conn, "bucket-b").unwrap(), 0);
    }

    /// The heal: legacy synced rows (synced_profile_id NULL) are stamped for the
    /// primary profile so they don't all re-push.
    #[test]
    fn test_backfill_synced_profile_id_heals_legacy_rows() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();
        let conn = store.conn.lock().unwrap();

        // Legacy state: synced (has synced_at) but no bucket recorded.
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE items SET sync_id = 'server-id-1', synced_at = ?, synced_profile_id = NULL WHERE id = ?",
            params![&now, &result.item_id],
        ).unwrap();

        // Without a recorded bucket it looks pending for the default bucket.
        assert_eq!(get_pending_sync_count(&conn, "default-bucket").unwrap(), 1);

        // Heal: trust the primary profile's history.
        let healed = backfill_synced_profile_id(&conn, "default-bucket").unwrap();
        assert_eq!(healed, 1);

        // Now it is settled for the default bucket (no spurious re-push)...
        assert_eq!(get_pending_sync_count(&conn, "default-bucket").unwrap(), 0);
        // ...but still pending for any other bucket.
        assert_eq!(get_pending_sync_count(&conn, "other-bucket").unwrap(), 1);
    }

    #[test]
    fn test_classify_push_response() {
        use PushOutcome::*;
        // 2xx with a parseable id -> synced.
        assert_eq!(
            classify_push_response(200, "{\"id\":\"x\"}", Some("srv-1")),
            Synced("srv-1".to_string())
        );
        // 2xx but no usable id -> retry (don't guess; server dedups by syncId).
        assert!(matches!(classify_push_response(200, "<html>oops</html>", None), Retry(_)));
        assert!(matches!(classify_push_response(201, "{}", Some("")), Retry(_)));
        // 409 -> version mismatch (stop the batch).
        assert!(matches!(classify_push_response(409, "outdated", None), VersionMismatch(_)));
        // Permanent 4xx -> rejected (park it).
        assert!(matches!(classify_push_response(400, "content required", None), Rejected(_)));
        assert!(matches!(classify_push_response(413, "too big", None), Rejected(_)));
        // Retryable client statuses.
        assert!(matches!(classify_push_response(408, "", None), Retry(_)));
        assert!(matches!(classify_push_response(429, "slow down", None), Retry(_)));
        // 5xx -> retry.
        assert!(matches!(classify_push_response(500, "boom", None), Retry(_)));
        assert!(matches!(classify_push_response(503, "", None), Retry(_)));
    }

    /// A permanently-rejected item is parked: excluded from the pending set + count
    /// (so the badge clears and we stop re-pushing it), and counted as sync-failed.
    #[test]
    fn test_mark_item_sync_failed_parks_item() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();
        let conn = store.conn.lock().unwrap();

        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 1);
        assert_eq!(get_sync_failed_count(&conn).unwrap(), 0);

        mark_item_sync_failed(&conn, &result.item_id, "status 400: content required").unwrap();

        // Parked: no longer pending, no longer in the push set, surfaced as failed.
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 0);
        assert!(get_items_to_push(&conn, "bucket-a").unwrap().is_empty());
        assert_eq!(get_sync_failed_count(&conn).unwrap(), 1);
    }

    /// A later successful sync clears the parked state.
    #[test]
    fn test_mark_item_synced_clears_sync_error() {
        let store = PeekStore::new(":memory:").unwrap();
        let result = store.save_url("https://example.com", &[], None).unwrap();
        let conn = store.conn.lock().unwrap();

        mark_item_sync_failed(&conn, &result.item_id, "status 400: bad").unwrap();
        assert_eq!(get_sync_failed_count(&conn).unwrap(), 1);

        mark_item_synced(&conn, &result.item_id, "server-id-1", "bucket-a").unwrap();
        assert_eq!(get_sync_failed_count(&conn).unwrap(), 0);
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 0);
    }

    /// Insert a never-synced item of an arbitrary type directly (bypassing the
    /// save_* helpers, which only create syncable types).
    fn insert_unsynced_item(conn: &Connection, id: &str, item_type: &str) {
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO items (id, type, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![id, item_type, &now, &now],
        )
        .unwrap();
    }

    /// The 5000+-pending bug (e9dce12a): non-syncable types must be excluded from both
    /// the pending count and the push set, so locally-derived entities never inflate
    /// the badge or get pushed to a server that rejects them.
    #[test]
    fn test_non_synced_types_excluded_from_pending() {
        let store = PeekStore::new(":memory:").unwrap();
        store.save_url("https://example.com", &[], None).unwrap();
        let conn = store.conn.lock().unwrap();
        insert_unsynced_item(&conn, "entity-1", "entity");
        insert_unsynced_item(&conn, "entity-2", "entity");
        insert_unsynced_item(&conn, "feed-1", "feed");

        // Only the url counts; the two entities and the feed are excluded by default.
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 1);
        let to_push = get_items_to_push(&conn, "bucket-a").unwrap();
        assert_eq!(to_push.len(), 1);
        assert_eq!(to_push[0].item_type, "url");
    }

    /// The synced-types set is configurable per install via the `synced_types` setting:
    /// opting entity in makes entities count + push.
    #[test]
    fn test_synced_types_override_opts_in_entities() {
        let store = PeekStore::new(":memory:").unwrap();
        store.save_url("https://example.com", &[], None).unwrap();
        let conn = store.conn.lock().unwrap();
        insert_unsynced_item(&conn, "entity-1", "entity");

        // Default: entity excluded.
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 1);

        // Opt entity in -> now both the url and the entity are pending.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('synced_types', ?)",
            params!["url,text,tagset,image,entity"],
        )
        .unwrap();
        assert_eq!(get_pending_sync_count(&conn, "bucket-a").unwrap(), 2);

        // get_synced_types reflects the override (trimmed, comma-split).
        assert!(get_synced_types(&conn).contains(&"entity".to_string()));
    }

    /// Pull side honors the synced-types set: an entity from the server is skipped
    /// (not merged) when the client doesn't sync entities, so mobile never
    /// accumulates types it would never push. A url is still pulled.
    #[test]
    fn test_merge_skips_non_synced_types() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();

        let entity = ServerItem {
            id: "srv-entity-1".to_string(),
            item_type: "entity".to_string(),
            content: None,
            tags: vec![],
            metadata: None,
            created_at: 1700000000000,
            updated_at: 1700000000000,
            deleted_at: 0,
            title: String::new(),
            domain: String::new(),
            favicon: String::new(),
            frecency_score: 0,
        };
        // Default synced types exclude 'entity' -> skipped, nothing inserted.
        assert_eq!(merge_server_item(&conn, &entity, "bucket-a").unwrap(), "skipped");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "entity must not be pulled into the local DB");

        // A url IS synced -> pulled.
        let url = ServerItem {
            id: "srv-url-1".to_string(),
            item_type: "url".to_string(),
            content: Some("https://example.com".to_string()),
            tags: vec![],
            metadata: None,
            created_at: 1700000000000,
            updated_at: 1700000000000,
            deleted_at: 0,
            title: String::new(),
            domain: String::new(),
            favicon: String::new(),
            frecency_score: 0,
        };
        assert_eq!(merge_server_item(&conn, &url, "bucket-a").unwrap(), "pulled");
        let n2: i64 = conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap();
        assert_eq!(n2, 1);
    }

    fn add_event(conn: &Connection, id: &str, item_id: &str, occurred: &str) {
        conn.execute(
            &format!(
                "INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt) \
                 VALUES (?, ?, 'c', 1.5, {occ}, '{{\"k\":1}}', {occ})",
                occ = occurred
            ),
            params![id, item_id],
        )
        .unwrap();
    }

    fn set_sync_id(conn: &Connection, item_id: &str, sync_id: &str) {
        conn.execute("UPDATE items SET sync_id = ? WHERE id = ?", params![sync_id, item_id])
            .unwrap();
    }

    fn server_visit(id: &str, item_id: &str) -> ServerVisit {
        ServerVisit {
            id: id.to_string(),
            item_id: item_id.to_string(),
            timestamp: 1700000000000,
            duration: Some(5),
            source: None,
            source_id: None,
            window_type: None,
            metadata: Some(serde_json::json!({"a": 1})),
            scroll_depth: Some(10),
            interacted: Some(1),
            prev_id: None,
            next_id: Some("n".to_string()),
        }
    }

    #[test]
    fn test_event_pushable_only_after_item_has_sync_id() {
        let store = PeekStore::new(":memory:").unwrap();
        let item = store.save_url("https://example.com", &[], None).unwrap().item_id;
        let conn = store.conn.lock().unwrap();
        add_event(&conn, "e1", &item, "1000");

        assert!(get_events_to_push(&conn, 10).unwrap().is_empty());

        set_sync_id(&conn, &item, "srv-1");
        let evs = get_events_to_push(&conn, 10).unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].item_id, "srv-1");
        assert_eq!(evs[0].metadata, serde_json::json!({"k": 1}));

        mark_events_pushed(&conn, &["e1".to_string()]).unwrap();
        assert!(get_events_to_push(&conn, 10).unwrap().is_empty());
    }

    #[test]
    fn test_event_with_non_finite_time_is_skipped() {
        let store = PeekStore::new(":memory:").unwrap();
        let item = store.save_url("https://example.com", &[], None).unwrap().item_id;
        let conn = store.conn.lock().unwrap();
        set_sync_id(&conn, &item, "srv-1");
        add_event(&conn, "good", &item, "1000");
        // Recreate the table shape without NOT NULL to hold a NULL time.
        conn.execute_batch(
            "CREATE TABLE ev_bak AS SELECT * FROM item_events; DROP TABLE item_events; \
             CREATE TABLE item_events (id TEXT PRIMARY KEY, itemId TEXT, content TEXT, value REAL, \
             occurredAt INTEGER, metadata TEXT, createdAt INTEGER, pushedAt INTEGER NOT NULL DEFAULT 0); \
             INSERT INTO item_events SELECT * FROM ev_bak; DROP TABLE ev_bak; \
             INSERT INTO item_events (id, itemId, occurredAt, createdAt) VALUES ('bad', (SELECT id FROM items LIMIT 1), NULL, 5);",
        )
        .unwrap();
        let evs = get_events_to_push(&conn, 10).unwrap();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].id, "good");
    }

    #[test]
    fn test_visit_pushable_after_sync_id_and_repushed_after_duration_change() {
        let store = PeekStore::new(":memory:").unwrap();
        let item = store.save_url("https://example.com", &[], None).unwrap().item_id;
        let visit = store.record_visit(&item, "direct", "main").unwrap();
        let conn = store.conn.lock().unwrap();

        assert!(get_visits_to_push(&conn, 10).unwrap().is_empty());

        set_sync_id(&conn, &item, "srv-1");
        assert_eq!(get_visits_to_push(&conn, 10).unwrap().len(), 1);

        mark_visits_pushed(&conn, &[visit.clone()]).unwrap();
        assert!(get_visits_to_push(&conn, 10).unwrap().is_empty());

        crate::items::set_visit_duration(&conn, &visit, 4200).unwrap();
        let again = get_visits_to_push(&conn, 10).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].duration, 4200);
    }

    #[test]
    fn test_visit_push_body_uses_desktop_field_names() {
        let store = PeekStore::new(":memory:").unwrap();
        let item = store.save_url("https://example.com", &[], None).unwrap().item_id;
        store.record_visit(&item, "direct", "main").unwrap();
        let conn = store.conn.lock().unwrap();
        set_sync_id(&conn, &item, "srv-1");

        let visits = get_visits_to_push(&conn, 10).unwrap();
        let v = serde_json::to_value(&visits[0]).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "id", "itemId", "timestamp", "duration", "source", "sourceId", "windowType",
            "metadata", "scrollDepth", "interacted", "prevId", "nextId",
        ] {
            assert!(obj.contains_key(key), "missing {}", key);
        }
        assert_eq!(obj.len(), 12);
        assert_eq!(obj["itemId"], "srv-1");
        assert_eq!(obj["windowType"], "main");

        let e = serde_json::to_value(PushEvent {
            id: "e".into(), item_id: "s".into(), content: None, value: None,
            occurred_at: 1, metadata: serde_json::json!({}), created_at: 2,
        })
        .unwrap();
        assert!(e.get("occurredAt").is_some() && e.get("createdAt").is_some());
    }

    #[test]
    fn test_merge_for_unknown_item_is_skipped() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        let ev = ServerEvent {
            id: "e".into(), item_id: "nope".into(), content: None, value: None,
            occurred_at: 1, metadata: None, created_at: 1,
        };
        assert_eq!(merge_server_event(&conn, ev).unwrap(), MergeOutcome::Skipped);
        assert_eq!(merge_server_visit(&conn, server_visit("v", "nope")).unwrap(), MergeOutcome::Skipped);
    }

    #[test]
    fn test_merged_visit_is_not_pushable_and_leaves_item_totals() {
        let store = PeekStore::new(":memory:").unwrap();
        let item = store.save_url("https://example.com", &[], None).unwrap().item_id;
        let conn = store.conn.lock().unwrap();
        set_sync_id(&conn, &item, "srv-1");
        let before: (i64, Option<String>) = conn
            .query_row("SELECT visit_count, last_visit_at FROM items WHERE id = ?", params![item], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();

        assert_eq!(merge_server_visit(&conn, server_visit("v1", "srv-1")).unwrap(), MergeOutcome::Merged);
        assert_eq!(merge_server_visit(&conn, server_visit("v1", "srv-1")).unwrap(), MergeOutcome::Merged);

        assert!(get_visits_to_push(&conn, 10).unwrap().is_empty());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM item_visits", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let after: (i64, Option<String>) = conn
            .query_row("SELECT visit_count, last_visit_at FROM items WHERE id = ?", params![item], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn test_merging_same_event_twice_leaves_one_row() {
        let store = PeekStore::new(":memory:").unwrap();
        let item = store.save_url("https://example.com", &[], None).unwrap().item_id;
        let conn = store.conn.lock().unwrap();
        set_sync_id(&conn, &item, "srv-1");
        let ev = ServerEvent {
            id: "e1".into(), item_id: "srv-1".into(), content: Some("x".into()), value: Some(2.0),
            occurred_at: 10, metadata: Some(serde_json::json!({"a": 1})), created_at: 11,
        };
        assert_eq!(merge_server_event(&conn, ev.clone()).unwrap(), MergeOutcome::Merged);
        assert_eq!(merge_server_event(&conn, ev).unwrap(), MergeOutcome::Merged);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM item_events", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Pulled events are not pushed back.
        assert!(get_events_to_push(&conn, 10).unwrap().is_empty());
    }

    #[test]
    fn test_pull_watermarks_round_trip() {
        let store = PeekStore::new(":memory:").unwrap();
        let conn = store.conn.lock().unwrap();
        assert_eq!(get_last_events_pull(&conn).unwrap(), None);
        assert_eq!(get_last_visits_pull(&conn).unwrap(), None);
        set_last_events_pull(&conn, "5").unwrap();
        set_last_visits_pull(&conn, "7").unwrap();
        assert_eq!(get_last_events_pull(&conn).unwrap(), Some("5".to_string()));
        assert_eq!(get_last_visits_pull(&conn).unwrap(), Some("7".to_string()));
    }
}
