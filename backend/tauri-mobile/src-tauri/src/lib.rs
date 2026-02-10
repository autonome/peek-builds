use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::fs;
use std::sync::{OnceLock, RwLock};
use reqwest;
use regex::Regex;
use tauri::Manager;

// Simple logging - println! works in debug builds and Xcode console
fn ios_log(msg: &str) {
    println!("[Peek] {}", msg);
}

// FFI declarations for native webview on iOS
// These symbols are provided by Swift code (WebviewPlugin.swift) at Xcode link time.
#[cfg(target_os = "ios")]
extern "C" {
    fn webview_plugin_open(url: *const std::ffi::c_char, item_id: *const std::ffi::c_char) -> bool;
    fn webview_plugin_close();
    fn webview_plugin_open_inline(url: *const std::ffi::c_char, top_offset: f64) -> bool;
    fn webview_plugin_close_inline();
}

// Sync version constants — must match backend/version.ts and backend/server/version.js
// Bump DATASTORE_VERSION when schema changes break sync.
// Bump PROTOCOL_VERSION when request/response shape changes.
// Exact match required — server returns 409 on mismatch.
const DATASTORE_VERSION: u32 = 1;
const PROTOCOL_VERSION: u32 = 1;

// Legacy model for backward compatibility (webhook, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedUrl {
    id: String,
    url: String,
    tags: Vec<String>,
    saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

// Text item for webhook
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedText {
    id: String,
    content: String,
    tags: Vec<String>,
    saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

// Tagset item for webhook
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedTagset {
    id: String,
    tags: Vec<String>,
    saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
}

// Image item
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedImage {
    id: String,
    tags: Vec<String>,
    saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<serde_json::Value>,
    // Base64-encoded thumbnail for display (smaller version)
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail: Option<String>,
    mime_type: String,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TagStats {
    name: String,
    frequency: u32,
    last_used: String,
    frecency_score: f64,
}

// Webhook payload with all item types
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WebhookPayload {
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    urls: Vec<SavedUrl>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    texts: Vec<SavedText>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    tagsets: Vec<SavedTagset>,
}

// Old webhook sync result (kept for backward compatibility)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncResult {
    success: bool,
    synced_count: usize,
    message: String,
}

// New bidirectional sync result
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BidirectionalSyncResult {
    success: bool,
    pulled: usize,
    pushed: usize,
    conflicts: usize,
    message: String,
}

/// Deserialize a timestamp that may be an integer (Unix ms) or ISO 8601 string.
/// Handles both the new server format (integer) and legacy format (string).
fn deserialize_flexible_timestamp<'de, D>(deserializer: D) -> Result<i64, D::Error>
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
fn deserialize_optional_flexible_timestamp<'de, D>(deserializer: D) -> Result<i64, D::Error>
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
struct ServerItem {
    id: String,
    #[serde(rename = "type")]
    item_type: String,
    content: Option<String>,
    tags: Vec<String>,
    metadata: Option<serde_json::Value>,
    #[serde(deserialize_with = "deserialize_flexible_timestamp")]
    created_at: i64,
    #[serde(deserialize_with = "deserialize_flexible_timestamp")]
    updated_at: i64,
    #[serde(default, deserialize_with = "deserialize_optional_flexible_timestamp")]
    deleted_at: i64,
}

// Server response for GET /items
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerItemsResponse {
    items: Vec<ServerItem>,
}

// Server response for POST /items
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServerCreateResponse {
    id: String,
    created: bool,
}

// Sync status for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncStatus {
    configured: bool,
    last_sync_time: Option<String>,
    pending_count: usize,
}

// App Group bridge - just need the container path now
extern "C" {
    fn get_app_group_container_path() -> *const c_char;
    fn get_documents_path() -> *const c_char;
    fn get_icloud_documents_path() -> *const c_char;
    fn get_system_is_dark_mode() -> i32;
    fn is_app_store_build() -> i32;
}

/// Check if this is an App Store/TestFlight build (has receipt) vs Xcode install
fn is_production_build() -> bool {
    unsafe { is_app_store_build() == 1 }
}

// ============================================================================
// Profile Management System
// ============================================================================

/// Sync configuration (shared across all profiles)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SyncSettings {
    #[serde(default)]
    server_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    auto_sync: bool,
}

/// Profile configuration stored in profiles.json
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileConfig {
    #[serde(rename = "currentProfileId")]
    current_profile_id: String,
    profiles: Vec<ProfileEntry>,
    #[serde(default)]
    sync: SyncSettings,
    #[serde(default = "default_archive_tag")]
    archive_tag: String,
}

fn default_archive_tag() -> String {
    "archive".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileEntry {
    id: String,
    name: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "lastUsed", alias = "lastUsedAt")]
    last_used_at: String,
    /// Server profile UUID — maps this local profile to a server-side profile for sync.
    /// When set, sync requests send this ID instead of the local profile ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    server_profile_id: Option<String>,
}

/// Cached profile config to avoid repeated file reads
static PROFILE_CONFIG: RwLock<Option<ProfileConfig>> = RwLock::new(None);

/// Get the App Group container path
fn get_container_path() -> Option<PathBuf> {
    unsafe {
        let c_str = get_app_group_container_path();
        if c_str.is_null() {
            println!("[Rust] Failed to get App Group container path");
            return None;
        }
        let path_str = CStr::from_ptr(c_str).to_string_lossy().to_string();
        libc::free(c_str as *mut libc::c_void);
        Some(PathBuf::from(path_str))
    }
}

/// Get the Documents directory path (visible in Finder via File Sharing)
fn get_docs_path() -> Option<PathBuf> {
    unsafe {
        let c_str = get_documents_path();
        if c_str.is_null() {
            ios_log("Failed to get Documents path");
            return None;
        }
        let path_str = CStr::from_ptr(c_str).to_string_lossy().to_string();
        libc::free(c_str as *mut libc::c_void);
        Some(PathBuf::from(path_str))
    }
}

/// Get the iCloud Documents directory path (synced across devices)
/// Returns None if iCloud is not available (user not signed in or capability not enabled)
fn get_icloud_path() -> Option<PathBuf> {
    unsafe {
        let c_str = get_icloud_documents_path();
        if c_str.is_null() {
            ios_log("iCloud not available");
            return None;
        }
        let path_str = CStr::from_ptr(c_str).to_string_lossy().to_string();
        libc::free(c_str as *mut libc::c_void);
        ios_log(&format!("iCloud path: {}", path_str));
        Some(PathBuf::from(path_str))
    }
}

/// Restore data from Documents folder to App Group container
/// Drag files named *.restore via Finder, app will restore on next launch
/// e.g., profiles.json.restore -> profiles.json in App Group
fn restore_from_documents() {
    let docs = match get_docs_path() {
        Some(p) => p,
        None => return,
    };

    let container = match get_container_path() {
        Some(p) => p,
        None => return,
    };

    // Look for any files ending in .restore
    let entries = match fs::read_dir(&docs) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut restored = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        if filename.ends_with(".restore") {
            // Strip .restore suffix to get real filename
            let real_name = &filename[..filename.len() - 8]; // remove ".restore"
            let dest = container.join(real_name);

            ios_log(&format!("=== Restoring {} ===", real_name));

            match fs::copy(&path, &dest) {
                Ok(bytes) => {
                    ios_log(&format!("Restored {} ({} bytes)", real_name, bytes));
                    restored += 1;
                    // Delete the .restore file after successful copy
                    let _ = fs::remove_file(&path);
                }
                Err(e) => {
                    ios_log(&format!("Failed to restore {}: {}", real_name, e));
                }
            }
        }
    }

    if restored > 0 {
        ios_log(&format!("=== Restore complete: {} files ===", restored));
    }
}

/// Backup App Group data to Documents folder (visible in Finder)
/// This runs on every startup to ensure data is always recoverable
fn backup_app_group_to_documents() {
    ios_log("=== Starting backup to Documents ===");

    let container = match get_container_path() {
        Some(p) => p,
        None => {
            ios_log("No container path - skipping backup");
            return;
        }
    };

    let docs = match get_docs_path() {
        Some(p) => p,
        None => {
            ios_log("No documents path - skipping backup");
            return;
        }
    };

    // Create backup directory with timestamp
    let timestamp = Utc::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let backup_dir = docs.join("Backups").join(&timestamp);

    if let Err(e) = fs::create_dir_all(&backup_dir) {
        ios_log(&format!("Failed to create backup dir: {}", e));
        return;
    }

    ios_log(&format!("Backup dir: {}", backup_dir.display()));

    // Copy all files from App Group to backup
    let mut copied = 0;
    if let Ok(entries) = fs::read_dir(&container) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let filename = path.file_name().unwrap_or_default();
                let dest = backup_dir.join(filename);
                match fs::copy(&path, &dest) {
                    Ok(bytes) => {
                        ios_log(&format!("Copied {} ({} bytes)", filename.to_string_lossy(), bytes));
                        copied += 1;
                    }
                    Err(e) => {
                        ios_log(&format!("Failed to copy {}: {}", filename.to_string_lossy(), e));
                    }
                }
            }
        }
    }

    ios_log(&format!("=== Backup complete: {} files ===", copied));

    // Also copy to a "latest" folder for easy access
    let latest_dir = docs.join("Backups").join("latest");
    let _ = fs::remove_dir_all(&latest_dir); // Remove old latest
    if let Err(e) = fs::create_dir_all(&latest_dir) {
        ios_log(&format!("Failed to create latest dir: {}", e));
        return;
    }

    if let Ok(entries) = fs::read_dir(&container) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let filename = path.file_name().unwrap_or_default();
                let dest = latest_dir.join(filename);
                let _ = fs::copy(&path, &dest);
            }
        }
    }

    // Cleanup old backups - keep only last 5
    if let Ok(entries) = fs::read_dir(docs.join("Backups")) {
        let mut dirs: Vec<_> = entries
            .flatten()
            .filter(|e| e.path().is_dir() && e.file_name() != "latest")
            .collect();

        // Sort by name (timestamp format ensures chronological order)
        dirs.sort_by_key(|e| e.file_name());

        // Remove oldest if more than 5
        while dirs.len() > 5 {
            if let Some(oldest) = dirs.first() {
                ios_log(&format!("Removing old backup: {}", oldest.file_name().to_string_lossy()));
                let _ = fs::remove_dir_all(oldest.path());
                dirs.remove(0);
            }
        }
    }
}

/// Get the path to profiles.json
fn get_profiles_config_path() -> Option<PathBuf> {
    get_container_path().map(|p| p.join("profiles.json"))
}

/// Load profile config from file, creating default if needed
fn load_profile_config() -> ProfileConfig {
    // Check cache first (fast path with read lock)
    if let Ok(guard) = PROFILE_CONFIG.read() {
        if let Some(ref config) = *guard {
            return config.clone();
        }
    }

    // Cache miss - load from file OUTSIDE the lock to avoid deadlock
    // (load_profile_config_from_file may call save_profile_config which also needs the lock)
    let config = load_profile_config_from_file();

    // Now acquire write lock just to update cache
    if let Ok(mut guard) = PROFILE_CONFIG.write() {
        // Double-check: another thread might have populated cache while we loaded
        // If so, use their version for consistency
        if let Some(ref cached) = *guard {
            return cached.clone();
        }
        *guard = Some(config.clone());
    }

    config
}

/// Old format profile entry (for migration)
#[derive(Debug, Clone, Deserialize)]
struct OldProfileEntry {
    slug: String,
    name: String,
}

/// Old format profile config (for migration)
#[derive(Debug, Clone, Deserialize)]
struct OldProfileConfig {
    current: String,
    profiles: Vec<OldProfileEntry>,
}

/// Migrate from old slug-based format to new UUID-based format
fn migrate_old_profile_config(old_config: OldProfileConfig) -> ProfileConfig {
    println!("[Rust] Migrating old profile config format to new UUID-based format");
    println!("[Rust] Old config: current={}, profiles={:?}", old_config.current, old_config.profiles.iter().map(|p| &p.slug).collect::<Vec<_>>());

    let container_path = get_container_path();
    let now = Utc::now().to_rfc3339();

    // List all files in container for debugging
    if let Some(ref container) = container_path {
        println!("[Rust] Container path: {}", container.display());
        if let Ok(entries) = fs::read_dir(container) {
            println!("[Rust] Container files:");
            for entry in entries.flatten() {
                println!("[Rust]   - {}", entry.file_name().to_string_lossy());
            }
        }
    }

    let mut new_profiles = Vec::new();
    let mut current_profile_id = String::new();

    for old_profile in &old_config.profiles {
        let new_id = uuid::Uuid::new_v4().to_string();
        println!("[Rust] Processing profile: {} -> {}", old_profile.slug, new_id);

        // Rename database file from peek-{slug}.db to peek-{uuid}.db
        if let Some(ref container) = container_path {
            let old_db_path = container.join(format!("peek-{}.db", old_profile.slug));
            let new_db_path = container.join(format!("peek-{}.db", new_id));

            println!("[Rust] Looking for old DB: {} (exists: {})", old_db_path.display(), old_db_path.exists());

            if old_db_path.exists() && !new_db_path.exists() {
                println!("[Rust] Migrating database: {} -> {}", old_db_path.display(), new_db_path.display());
                if let Err(e) = fs::rename(&old_db_path, &new_db_path) {
                    println!("[Rust] Warning: Failed to rename database: {}", e);
                } else {
                    // Also rename WAL and SHM files if they exist
                    let old_wal = container.join(format!("peek-{}.db-wal", old_profile.slug));
                    let new_wal = container.join(format!("peek-{}.db-wal", new_id));
                    if old_wal.exists() {
                        let _ = fs::rename(&old_wal, &new_wal);
                    }
                    let old_shm = container.join(format!("peek-{}.db-shm", old_profile.slug));
                    let new_shm = container.join(format!("peek-{}.db-shm", new_id));
                    if old_shm.exists() {
                        let _ = fs::rename(&old_shm, &new_shm);
                    }
                    println!("[Rust] Database migration successful");
                }
            }
        }

        // If this was the current profile, remember its new ID
        if old_profile.slug == old_config.current {
            current_profile_id = new_id.clone();
        }

        new_profiles.push(ProfileEntry {
            id: new_id,
            name: old_profile.name.clone(),
            created_at: now.clone(),
            last_used_at: now.clone(),
            server_profile_id: None,
        });
    }

    // If current profile wasn't found, use first profile or create based on build type
    if current_profile_id.is_empty() {
        if let Some(first) = new_profiles.first() {
            current_profile_id = first.id.clone();
        }
    }

    // Try to migrate sync settings from old database
    let sync = migrate_sync_settings_from_db(&container_path, &old_config.current);

    println!("[Rust] Migration complete: {} profiles, current={}", new_profiles.len(), current_profile_id);

    ProfileConfig {
        current_profile_id,
        profiles: new_profiles,
        sync,
        archive_tag: default_archive_tag(),
    }
}

/// Migrate sync settings from old per-profile database to shared config
fn migrate_sync_settings_from_db(container_path: &Option<PathBuf>, old_current_slug: &str) -> SyncSettings {
    // Try to read sync settings from the old current profile's database
    if let Some(ref container) = container_path {
        let old_db_path = container.join(format!("peek-{}.db", old_current_slug));

        // The database might have already been renamed, so also check for peek.db as fallback
        let db_path = if old_db_path.exists() {
            Some(old_db_path)
        } else {
            let legacy_path = container.join("peek.db");
            if legacy_path.exists() { Some(legacy_path) } else { None }
        };

        if let Some(path) = db_path {
            if let Ok(conn) = Connection::open(&path) {
                let server_url: String = conn
                    .query_row("SELECT value FROM settings WHERE key = 'webhook_url'", [], |row| row.get(0))
                    .unwrap_or_default();
                let api_key: String = conn
                    .query_row("SELECT value FROM settings WHERE key = 'webhook_api_key'", [], |row| row.get(0))
                    .unwrap_or_default();
                let auto_sync: String = conn
                    .query_row("SELECT value FROM settings WHERE key = 'auto_sync'", [], |row| row.get(0))
                    .unwrap_or_default();

                if !server_url.is_empty() || !api_key.is_empty() {
                    println!("[Rust] Migrated sync settings from old database");
                    return SyncSettings {
                        server_url,
                        api_key,
                        auto_sync: auto_sync == "1" || auto_sync == "true",
                    };
                }
            }
        }
    }

    SyncSettings::default()
}

/// Load profile config directly from file (bypasses cache)
fn load_profile_config_from_file() -> ProfileConfig {
    // DEBUG: List all files in App Group container (uses NSLog on iOS for release visibility)
    if let Some(container) = get_container_path() {
        ios_log("=== App Group Container Contents ===");
        ios_log(&format!("Container path: {}", container.display()));
        if let Ok(entries) = fs::read_dir(&container) {
            for entry in entries.flatten() {
                let path = entry.path();
                let metadata = fs::metadata(&path).ok();
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = metadata.as_ref()
                    .and_then(|m| m.modified().ok())
                    .map(|t| format!("{:?}", t))
                    .unwrap_or_else(|| "unknown".to_string());
                ios_log(&format!("- {} (size: {} bytes, modified: {})",
                    path.file_name().unwrap_or_default().to_string_lossy(),
                    size,
                    modified));
            }
        }
        ios_log("=== End Container Contents ===");
    }

    let config_path = match get_profiles_config_path() {
        Some(p) => p,
        None => {
            ios_log("No config path available, creating default config");
            return create_default_profile_config();
        }
    };

    ios_log(&format!("Loading profile config from: {} (exists: {})", config_path.display(), config_path.exists()));

    // DEBUG: Print raw profiles.json contents
    if config_path.exists() {
        if let Ok(raw_contents) = fs::read_to_string(&config_path) {
            ios_log("=== Raw profiles.json ===");
            ios_log(&raw_contents);
            ios_log("=== End profiles.json ===");
        }
    }

    if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(contents) => {
                // First try to parse as new format
                match serde_json::from_str::<ProfileConfig>(&contents) {
                    Ok(mut config) => {
                        println!("[Rust] Loaded profile config: current={}", config.current_profile_id);
                        // Check if we need to migrate old slug-based databases
                        migrate_slug_databases_to_uuid(&config);
                        // Apply test profile override or ensure dev profile
                        apply_profile_override(&mut config);
                        return config;
                    }
                    Err(e) => {
                        println!("[Rust] Failed to parse as new format: {}", e);

                        // Try to parse as old format and migrate
                        match serde_json::from_str::<OldProfileConfig>(&contents) {
                            Ok(old_config) => {
                                println!("[Rust] Found old format profiles.json, migrating...");
                                let mut new_config = migrate_old_profile_config(old_config);
                                // Apply test profile override or ensure dev profile
                                apply_profile_override(&mut new_config);
                                save_profile_config(&new_config);
                                return new_config;
                            }
                            Err(e2) => {
                                println!("[Rust] Failed to parse as old format either: {}", e2);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                println!("[Rust] Failed to read profiles.json: {}", e);
            }
        }
    }

    // Create default config
    let mut config = create_default_profile_config();
    apply_profile_override(&mut config);
    save_profile_config(&config);
    config
}

/// Migrate old slug-based databases to UUID-based names
/// This handles the case where profiles.json was already migrated but databases weren't renamed
/// Also migrates sync settings from database if not already set in profiles.json
fn migrate_slug_databases_to_uuid(config: &ProfileConfig) {
    let container_path = match get_container_path() {
        Some(p) => p,
        None => return,
    };

    // Map profile names to their expected old slugs
    let slug_mappings = [
        ("Default", "default"),
        ("Development", "dev"),
    ];

    let mut needs_sync_migration = config.sync.server_url.is_empty() && config.sync.api_key.is_empty();
    let mut migrated_sync = SyncSettings::default();

    for profile in &config.profiles {
        // Find the old slug for this profile name
        let old_slug = slug_mappings.iter()
            .find(|(name, _)| *name == profile.name)
            .map(|(_, slug)| *slug);

        if let Some(slug) = old_slug {
            let old_db_path = container_path.join(format!("peek-{}.db", slug));
            let new_db_path = container_path.join(format!("peek-{}.db", profile.id));

            // Check if old database exists and new one doesn't have the data
            if old_db_path.exists() {
                let old_size = fs::metadata(&old_db_path).map(|m| m.len()).unwrap_or(0);
                let new_size = fs::metadata(&new_db_path).map(|m| m.len()).unwrap_or(0);

                println!("[Rust] Checking migration: {} ({}b) vs {} ({}b)",
                    old_db_path.display(), old_size, new_db_path.display(), new_size);

                // Try to migrate sync settings from old database before renaming
                if needs_sync_migration {
                    if let Ok(conn) = Connection::open(&old_db_path) {
                        let server_url: String = conn
                            .query_row("SELECT value FROM settings WHERE key = 'webhook_url'", [], |row| row.get(0))
                            .unwrap_or_default();
                        let api_key: String = conn
                            .query_row("SELECT value FROM settings WHERE key = 'webhook_api_key'", [], |row| row.get(0))
                            .unwrap_or_default();
                        let auto_sync: String = conn
                            .query_row("SELECT value FROM settings WHERE key = 'auto_sync'", [], |row| row.get(0))
                            .unwrap_or_default();

                        if !server_url.is_empty() || !api_key.is_empty() {
                            println!("[Rust] Found sync settings in old database: {}", old_db_path.display());
                            migrated_sync = SyncSettings {
                                server_url,
                                api_key,
                                auto_sync: auto_sync == "1" || auto_sync == "true",
                            };
                            needs_sync_migration = false;
                        }
                    }
                }

                // If old database is larger (has more data), use it instead
                if old_size > new_size {
                    println!("[Rust] Migrating slug database: {} -> {}", old_db_path.display(), new_db_path.display());

                    // Remove the empty new database if it exists
                    if new_db_path.exists() {
                        let _ = fs::remove_file(&new_db_path);
                        // Also remove WAL/SHM for new db
                        let _ = fs::remove_file(container_path.join(format!("peek-{}.db-wal", profile.id)));
                        let _ = fs::remove_file(container_path.join(format!("peek-{}.db-shm", profile.id)));
                    }

                    // Rename old database to new UUID name
                    if let Err(e) = fs::rename(&old_db_path, &new_db_path) {
                        println!("[Rust] Warning: Failed to rename database: {}", e);
                    } else {
                        println!("[Rust] Successfully migrated database");
                        // Also rename WAL and SHM files
                        let old_wal = container_path.join(format!("peek-{}.db-wal", slug));
                        let new_wal = container_path.join(format!("peek-{}.db-wal", profile.id));
                        if old_wal.exists() {
                            let _ = fs::rename(&old_wal, &new_wal);
                        }
                        let old_shm = container_path.join(format!("peek-{}.db-shm", slug));
                        let new_shm = container_path.join(format!("peek-{}.db-shm", profile.id));
                        if old_shm.exists() {
                            let _ = fs::rename(&old_shm, &new_shm);
                        }
                    }
                }
            }

            // Also check the current UUID database for sync settings (in case db was already migrated)
            if needs_sync_migration && new_db_path.exists() {
                if let Ok(conn) = Connection::open(&new_db_path) {
                    let server_url: String = conn
                        .query_row("SELECT value FROM settings WHERE key = 'webhook_url'", [], |row| row.get(0))
                        .unwrap_or_default();
                    let api_key: String = conn
                        .query_row("SELECT value FROM settings WHERE key = 'webhook_api_key'", [], |row| row.get(0))
                        .unwrap_or_default();
                    let auto_sync: String = conn
                        .query_row("SELECT value FROM settings WHERE key = 'auto_sync'", [], |row| row.get(0))
                        .unwrap_or_default();

                    if !server_url.is_empty() || !api_key.is_empty() {
                        println!("[Rust] Found sync settings in UUID database: {}", new_db_path.display());
                        migrated_sync = SyncSettings {
                            server_url,
                            api_key,
                            auto_sync: auto_sync == "1" || auto_sync == "true",
                        };
                        needs_sync_migration = false;
                    }
                }
            }
        }
    }

    // If we found sync settings, update the config
    if !migrated_sync.server_url.is_empty() || !migrated_sync.api_key.is_empty() {
        let mut updated_config = config.clone();
        updated_config.sync = migrated_sync;
        save_profile_config(&updated_config);
        // Update cache
        if let Ok(mut guard) = PROFILE_CONFIG.write() {
            *guard = Some(updated_config);
        }
        println!("[Rust] Migrated sync settings to profiles.json");
    }
}

/// Apply PEEK_PROFILE_ID env var override for e2e testing.
/// When set, skips ensure_dev_profile_in_dev_build() and forces the active profile ID.
fn apply_profile_override(config: &mut ProfileConfig) {
    match std::env::var("PEEK_PROFILE_ID") {
        Ok(ref id) if is_valid_uuid(id) => {
            println!("[Rust] PEEK_PROFILE_ID override: {}", id);
            config.current_profile_id = id.clone();
        }
        _ => {
            ensure_dev_profile_in_dev_build(config);
        }
    }
}

/// Ensure Development profile exists in dev builds
/// This handles the case where a production profiles.json was left behind (e.g., from TestFlight)
/// and we're now running a development build that should have the Development profile available
fn ensure_dev_profile_in_dev_build(config: &mut ProfileConfig) {
    // Only applies to development builds
    if is_production_build() {
        return;
    }

    // Check if Development profile already exists
    let has_dev = config.profiles.iter().any(|p| p.name == "Development");
    if has_dev {
        // Development profile exists - respect user's current profile choice
        // (don't force switch, just ensure it's available)
        return;
    }

    // Need to add Development profile
    println!("[Rust] Dev build: adding missing Development profile");
    let now = Utc::now().to_rfc3339();
    let dev_id = uuid::Uuid::new_v4().to_string();

    config.profiles.push(ProfileEntry {
        id: dev_id.clone(),
        name: "Development".to_string(),
        created_at: now.clone(),
        last_used_at: now,
        server_profile_id: None,
    });

    // Switch to the new Development profile (only on first add)
    config.current_profile_id = dev_id;
    save_profile_config(config);
    println!("[Rust] Dev build: now using Development profile");
}

/// Create default profile config based on build type
fn create_default_profile_config() -> ProfileConfig {
    let now = Utc::now().to_rfc3339();
    let default_id = uuid::Uuid::new_v4().to_string();
    let dev_id = uuid::Uuid::new_v4().to_string();

    // Determine which profile should be current based on build type
    let is_production = is_production_build();
    let current_id = if is_production { default_id.clone() } else { dev_id.clone() };

    println!("[Rust] Creating default profile config with profile id: {} (production: {})", current_id, is_production);

    ProfileConfig {
        current_profile_id: current_id,
        profiles: vec![
            ProfileEntry {
                id: default_id,
                name: "Default".to_string(),
                created_at: now.clone(),
                last_used_at: now.clone(),
                server_profile_id: None,
            },
            ProfileEntry {
                id: dev_id,
                name: "Development".to_string(),
                created_at: now.clone(),
                last_used_at: now,
                server_profile_id: None,
            },
        ],
        sync: SyncSettings::default(),
        archive_tag: default_archive_tag(),
    }
}

/// Save profile config to file
fn save_profile_config(config: &ProfileConfig) -> bool {
    let config_path = match get_profiles_config_path() {
        Some(p) => p,
        None => return false,
    };

    match serde_json::to_string_pretty(config) {
        Ok(json) => {
            match fs::write(&config_path, json) {
                Ok(_) => {
                    println!("[Rust] Saved profile config");
                    // Update cache
                    if let Ok(mut guard) = PROFILE_CONFIG.write() {
                        *guard = Some(config.clone());
                    }
                    true
                }
                Err(e) => {
                    println!("[Rust] Failed to write profiles.json: {}", e);
                    false
                }
            }
        }
        Err(e) => {
            println!("[Rust] Failed to serialize profile config: {}", e);
            false
        }
    }
}

/// Append profile parameter to a URL
/// Sends the server profile UUID if configured, otherwise falls back to local profile UUID
fn append_profile_to_url(url: &str) -> Result<String, String> {
    let config = load_profile_config();
    let current_profile = config.profiles
        .iter()
        .find(|p| p.id == config.current_profile_id);

    // Use server_profile_id if set, otherwise fall back to local profile ID
    let profile_id = current_profile
        .and_then(|p| p.server_profile_id.clone())
        .unwrap_or_else(|| config.current_profile_id.clone());

    let separator = if url.contains('?') { "&" } else { "?" };
    Ok(format!("{}{}profile={}", url, separator, profile_id))
}

/// Check if a string looks like a valid UUID (basic validation)
fn is_valid_uuid(s: &str) -> bool {
    // UUID format: 8-4-4-4-12 hex digits with hyphens
    if s.len() != 36 {
        return false;
    }
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let expected_lens = [8, 4, 4, 4, 12];
    for (part, expected_len) in parts.iter().zip(expected_lens.iter()) {
        if part.len() != *expected_len || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
    }
    true
}

fn get_db_path() -> Option<PathBuf> {
    let container_path = get_container_path()?;

    // Use profile ID from config file for database selection
    // This allows user to switch profiles and see different data
    let config = load_profile_config();
    let profile_id = &config.current_profile_id;

    // Validate profile ID is a proper UUID to prevent accidental data migration
    // Invalid IDs like "default" would create peek-default.db and move data there
    if !is_valid_uuid(profile_id) {
        ios_log(&format!(
            "WARNING: Invalid profile ID '{}' is not a UUID. Using first profile or creating default.",
            profile_id
        ));

        // Try to use the first profile in the list, or create and save a new default config
        let valid_profile_id = if let Some(first_profile) = config.profiles.first() {
            ios_log(&format!("Falling back to first profile: {}", first_profile.id));
            first_profile.id.clone()
        } else {
            // No profiles exist - create a full default config and save it
            // This ensures the database UUID is saved to profiles.json (no orphaned DBs)
            ios_log("No profiles found, creating and saving default profile config");
            let mut new_config = create_default_profile_config();
            apply_profile_override(&mut new_config);
            save_profile_config(&new_config);
            // Update cache
            if let Ok(mut guard) = PROFILE_CONFIG.write() {
                *guard = Some(new_config.clone());
            }
            ios_log(&format!("Created new profile config with current ID: {}", new_config.current_profile_id));
            new_config.current_profile_id
        };

        let db_name = format!("peek-{}.db", valid_profile_id);
        let db_path = container_path.join(&db_name);

        // Check if we need to migrate from old peek.db (only for valid UUIDs)
        let old_db_path = container_path.join("peek.db");
        if old_db_path.exists() && !db_path.exists() {
            println!("[Rust] Migrating {} to {}", old_db_path.display(), db_path.display());
            if let Err(e) = fs::rename(&old_db_path, &db_path) {
                println!("[Rust] Migration failed: {}. Will use new empty database.", e);
            } else {
                println!("[Rust] Migration successful");
            }
        }

        println!("[Rust] Using database: {} (corrected profile id: {})", db_name, valid_profile_id);
        return Some(db_path);
    }

    // Also validate that the profile ID exists in the profiles array
    let profile_exists = config.profiles.iter().any(|p| p.id == *profile_id);
    if !profile_exists && !config.profiles.is_empty() {
        ios_log(&format!(
            "WARNING: Profile ID '{}' not found in profiles list. Using first profile.",
            profile_id
        ));
        let first_profile = &config.profiles[0];
        let db_name = format!("peek-{}.db", first_profile.id);
        println!("[Rust] Using database: {} (fallback to first profile)", db_name);
        return Some(container_path.join(&db_name));
    }

    let db_name = format!("peek-{}.db", profile_id);
    let new_db_path = container_path.join(&db_name);

    // Migration: rename old peek.db to the first profile's database
    // This runs once when upgrading from old single-database version
    // Only run if the profile ID is a valid UUID (prevents accidental data moves)
    let old_db_path = container_path.join("peek.db");
    if old_db_path.exists() && !new_db_path.exists() {
        println!("[Rust] Migrating {} to {}", old_db_path.display(), new_db_path.display());
        if let Err(e) = fs::rename(&old_db_path, &new_db_path) {
            println!("[Rust] Migration failed: {}. Will use new empty database.", e);
        } else {
            println!("[Rust] Migration successful");
        }
    }

    println!("[Rust] Using database: {} (profile id: {})", db_name, profile_id);
    Some(new_db_path)
}

static DB_INITIALIZED: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
static DEVICE_ID: OnceLock<String> = OnceLock::new();

/// Schema version for tracking compatibility between Rust main app and Swift Share Extension.
/// Increment this when making schema changes that both codepaths must understand.
/// Both Rust and Swift code should use the same version number.
const SCHEMA_VERSION: &str = "2";

fn ensure_database_initialized() -> Result<(), String> {
    let mut initialized = DB_INITIALIZED.lock()
        .map_err(|e| format!("Failed to lock DB_INITIALIZED: {}", e))?;
    if *initialized {
        return Ok(());
    }

    let db_path = get_db_path()
        .ok_or_else(|| "Failed to get database path".to_string())?;

    println!("[Rust] Initializing database at: {:?}", db_path);

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    // Enable WAL mode for concurrent access from main app and share extension
    if let Err(e) = conn.execute_batch("PRAGMA journal_mode=WAL;") {
        return Err(format!("Failed to set WAL mode: {}", e));
    }

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
        println!("[Rust] Migrating database from urls to items schema...");
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
        println!("[Rust] Database migration completed successfully");
    } else if !has_items_table {
        // Fresh install: create new schema
        if let Err(e) = conn.execute_batch(
            "
                CREATE TABLE IF NOT EXISTS items (
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
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
                );

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
        println!("[Rust] Adding metadata column to items table...");
        if let Err(e) = conn.execute("ALTER TABLE items ADD COLUMN metadata TEXT", []) {
            println!("[Rust] Warning: Failed to add metadata column: {}", e);
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
        println!("[Rust] Adding sync columns to items table...");
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
        println!("[Rust] Migrating {} 'page' items to 'url' type...", page_count);
        if let Err(e) = conn.execute("UPDATE items SET type = 'url' WHERE type = 'page'", []) {
            println!("[Rust] Warning: Failed to migrate page items: {}", e);
        } else {
            println!("[Rust] Page to URL migration complete");
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
        ios_log("Migrating tags table columns from snake_case to camelCase...");
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
                ios_log(&format!("Warning: Failed to rename column {} to {}: {}", old_name, new_name, e));
            } else {
                ios_log(&format!("Renamed tags.{} to tags.{}", old_name, new_name));
            }
        }
        // Recreate index with new column name
        let _ = conn.execute("DROP INDEX IF EXISTS idx_tags_frecency", []);
        let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_tags_frecency ON tags(frecencyScore DESC)", []);
        ios_log("Tags table migration complete");
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
        println!("[Rust] Creating blobs table for image support...");
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
            println!("[Rust] Warning: Failed to create blobs table: {}", e);
        }
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
        println!("[Rust] Creating item_visits table for visit tracking...");
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
            println!("[Rust] Warning: Failed to create item_visits table: {}", e);
        }
    }

    // Migrate tags.id from INTEGER to TEXT (for existing installs with old schema)
    // Check if tags table exists and has INTEGER id column
    let tags_has_integer_id: bool = conn
        .query_row(
            "SELECT type FROM pragma_table_info('tags') WHERE name='id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|t| t.to_uppercase() == "INTEGER")
        .unwrap_or(false);

    if tags_has_integer_id {
        ios_log("Migrating tags.id from INTEGER to TEXT...");

        // Use savepoint for atomic rollback on error
        if let Err(e) = conn.execute("SAVEPOINT before_tag_migration", []) {
            ios_log(&format!("Failed to create savepoint: {}", e));
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
                    ios_log("Tags INTEGER→TEXT migration completed successfully");
                }
                Err(e) => {
                    ios_log(&format!("Tags migration failed, rolling back: {}", e));
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
    let dedup_done: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'dedup_cleanup_v1'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !dedup_done {
        println!("[Rust] Running one-time dedup cleanup...");
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
            println!("[Rust] Dedup cleanup: removed {} duplicate items", total_removed);
        } else {
            println!("[Rust] Dedup cleanup: no duplicates found");
        }
    }

    // Write schema version to settings table for compatibility tracking.
    // This allows detecting mismatches between Rust main app and Swift Share Extension.
    let _ = conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
        params![SCHEMA_VERSION],
    );

    // Check for schema version mismatch (Swift Share Extension may have written a different version)
    if let Ok(existing_version) = conn.query_row::<String, _, _>(
        "SELECT value FROM settings WHERE key = 'schema_version_swift'",
        [],
        |row| row.get(0),
    ) {
        if existing_version != SCHEMA_VERSION {
            println!(
                "[Rust] WARNING: Schema version mismatch! Rust: {}, Swift: {}",
                SCHEMA_VERSION, existing_version
            );
        }
    }

    // Initialize device ID (generate and store if missing)
    let device_id: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'device_id'", [], |row| row.get(0))
        .unwrap_or_default();

    if device_id.is_empty() {
        let new_id = uuid::Uuid::new_v4().to_string();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('device_id', ?1)",
            params![&new_id],
        );
        println!("[Rust] Generated new device ID: {}", new_id);
        let _ = DEVICE_ID.set(new_id);
    } else {
        println!("[Rust] Loaded existing device ID: {}", device_id);
        let _ = DEVICE_ID.set(device_id);
    }

    println!("[Rust] Database initialized successfully (schema version {})", SCHEMA_VERSION);

    *initialized = true;
    Ok(())
}

/// Get the device ID (raw UUID, no prefix). Cached in OnceLock after first DB read.
fn get_device_id() -> &'static str {
    DEVICE_ID.get().map(|s| s.as_str()).unwrap_or("unknown")
}

/// Inject _sync metadata for a new item (save/create).
/// Sets createdBy, createdAt, modifiedBy, modifiedAt.
fn inject_sync_metadata_for_save(metadata: Option<serde_json::Value>) -> serde_json::Value {
    let mut meta = match metadata {
        Some(v) if v.is_object() => v,
        _ => serde_json::json!({}),
    };
    let device_id = get_device_id();
    let timestamp = chrono::Utc::now().timestamp_millis();
    meta.as_object_mut().unwrap().insert("_sync".to_string(), serde_json::json!({
        "createdBy": device_id,
        "createdAt": timestamp,
        "modifiedBy": device_id,
        "modifiedAt": timestamp,
    }));
    meta
}

/// Inject _sync metadata for an update to an existing item.
/// Preserves createdBy/createdAt, updates modifiedBy/modifiedAt.
fn inject_sync_metadata_for_update(existing_metadata_str: Option<String>) -> String {
    let mut meta: serde_json::Value = existing_metadata_str
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let device_id = get_device_id();
    let timestamp = chrono::Utc::now().timestamp_millis();

    let obj = meta.as_object_mut().unwrap();

    let existing_sync = obj.get("_sync").cloned();
    let mut sync = existing_sync
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    // Backfill createdBy if missing (items predating this feature)
    if !sync.contains_key("createdBy") {
        sync.insert("createdBy".to_string(), serde_json::json!(device_id));
        sync.insert("createdAt".to_string(), serde_json::json!(timestamp));
    }

    sync.insert("modifiedBy".to_string(), serde_json::json!(device_id));
    sync.insert("modifiedAt".to_string(), serde_json::json!(timestamp));

    obj.insert("_sync".to_string(), serde_json::Value::Object(sync));

    serde_json::to_string(&meta).unwrap_or_default()
}

#[tauri::command]
async fn get_device_id_command() -> Result<String, String> {
    ensure_database_initialized()?;
    Ok(get_device_id().to_string())
}

fn get_connection() -> Result<Connection, String> {
    // Ensure tables exist (only runs once)
    ensure_database_initialized()?;

    // Open a fresh connection for thread safety
    let db_path = get_db_path().ok_or("Failed to get database path")?;
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    // Set WAL mode on this connection too
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;

    Ok(conn)
}

// Parse hashtags from text content
fn parse_hashtags(content: &str) -> Vec<String> {
    let re = Regex::new(r"#(\w+)").unwrap();
    re.captures_iter(content)
        .map(|cap| cap[1].to_lowercase())
        .collect()
}

// Calculate frecency score
fn calculate_frecency(frequency: u32, last_used: &str) -> f64 {
    let now = Utc::now();
    let last_used_time = chrono::DateTime::parse_from_rfc3339(last_used)
        .unwrap_or_else(|_| now.into())
        .with_timezone(&Utc);

    let days_since_use = (now - last_used_time).num_days() as f64;
    let decay_factor = 1.0 / (1.0 + days_since_use / 7.0);

    frequency as f64 * 10.0 * decay_factor
}

// Generate a unique tag ID in format: tag_{timestamp}_{random9}
fn generate_tag_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let uuid = uuid::Uuid::new_v4().to_string();
    let random = &uuid[0..9]; // First 9 chars of UUID
    format!("tag_{}_{}", timestamp, random)
}

// Helper to get webhook config
fn get_webhook_config() -> (Option<String>, Option<String>) {
    let config = load_profile_config();
    let url = if config.sync.server_url.is_empty() {
        None
    } else {
        Some(config.sync.server_url)
    };
    let key = if config.sync.api_key.is_empty() {
        None
    } else {
        Some(config.sync.api_key)
    };
    (url, key)
}

// Helper function to push a single URL to webhook (fire and forget)
async fn push_url_to_webhook(saved_url: SavedUrl) {
    let (webhook_url, api_key) = get_webhook_config();

    if let Some(base_url) = webhook_url {
        if !base_url.is_empty() {
            // Append profile to webhook URL
            let url = match append_profile_to_url(&base_url) {
                Ok(u) => u,
                Err(e) => {
                    println!("[Rust] Failed to append profile to URL: {}", e);
                    return;
                }
            };
            println!("[Rust] Pushing URL to webhook: {}", saved_url.url);
            let client = reqwest::Client::new();
            let payload = WebhookPayload {
                urls: vec![saved_url],
                texts: vec![],
                tagsets: vec![],
            };

            let mut request = client.post(&url).json(&payload);

            if let Some(key) = api_key {
                if !key.is_empty() {
                    request = request.header("Authorization", format!("Bearer {}", key));
                }
            }

            match request.send().await {
                Ok(response) => {
                    if response.status().is_success() {
                        println!("[Rust] Webhook push successful");
                    } else {
                        println!("[Rust] Webhook returned error: {}", response.status());
                    }
                }
                Err(e) => {
                    println!("[Rust] Failed to push to webhook: {}", e);
                }
            }
        }
    }
}

// Helper function to push a single text to webhook (fire and forget)
async fn push_text_to_webhook(saved_text: SavedText) {
    let (webhook_url, api_key) = get_webhook_config();

    if let Some(base_url) = webhook_url {
        if !base_url.is_empty() {
            // Append profile to webhook URL
            let url = match append_profile_to_url(&base_url) {
                Ok(u) => u,
                Err(e) => {
                    println!("[Rust] Failed to append profile to URL: {}", e);
                    return;
                }
            };
            println!("[Rust] Pushing text to webhook");
            let client = reqwest::Client::new();
            let payload = WebhookPayload {
                urls: vec![],
                texts: vec![saved_text],
                tagsets: vec![],
            };

            let mut request = client.post(&url).json(&payload);

            if let Some(key) = api_key {
                if !key.is_empty() {
                    request = request.header("Authorization", format!("Bearer {}", key));
                }
            }

            match request.send().await {
                Ok(response) => {
                    if response.status().is_success() {
                        println!("[Rust] Webhook push successful");
                    } else {
                        println!("[Rust] Webhook returned error: {}", response.status());
                    }
                }
                Err(e) => {
                    println!("[Rust] Failed to push to webhook: {}", e);
                }
            }
        }
    }
}

// Helper function to push a single tagset to webhook (fire and forget)
async fn push_tagset_to_webhook(saved_tagset: SavedTagset) {
    let (webhook_url, api_key) = get_webhook_config();

    if let Some(base_url) = webhook_url {
        if !base_url.is_empty() {
            // Append profile to webhook URL
            let url = match append_profile_to_url(&base_url) {
                Ok(u) => u,
                Err(e) => {
                    println!("[Rust] Failed to append profile to URL: {}", e);
                    return;
                }
            };
            println!("[Rust] Pushing tagset to webhook");
            let client = reqwest::Client::new();
            let payload = WebhookPayload {
                urls: vec![],
                texts: vec![],
                tagsets: vec![saved_tagset],
            };

            let mut request = client.post(&url).json(&payload);

            if let Some(key) = api_key {
                if !key.is_empty() {
                    request = request.header("Authorization", format!("Bearer {}", key));
                }
            }

            match request.send().await {
                Ok(response) => {
                    if response.status().is_success() {
                        println!("[Rust] Webhook push successful");
                    } else {
                        println!("[Rust] Webhook returned error: {}", response.status());
                    }
                }
                Err(e) => {
                    println!("[Rust] Failed to push to webhook: {}", e);
                }
            }
        }
    }
}

// Commands
#[tauri::command]
fn get_shared_url() -> Result<Option<String>, String> {
    // Deprecated - kept for compatibility
    Ok(None)
}

#[tauri::command]
fn debug_list_container_files() -> Result<Vec<String>, String> {
    unsafe {
        let c_str = get_app_group_container_path();
        if c_str.is_null() {
            return Err("Failed to get App Group container path".to_string());
        }
        let path_str = CStr::from_ptr(c_str).to_string_lossy().to_string();
        libc::free(c_str as *mut libc::c_void);

        let container_path = PathBuf::from(&path_str);

        let mut files = Vec::new();
        files.push(format!("Container: {}", path_str));

        // List all files including hidden ones
        if let Ok(entries) = std::fs::read_dir(&container_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                let metadata = std::fs::metadata(&path);
                let size = metadata.map(|m| m.len()).unwrap_or(0);
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                files.push(format!("{} ({} bytes)", name, size));
            }
        }

        // Also check for WAL and SHM files
        let wal_path = container_path.join("peek.db-wal");
        let shm_path = container_path.join("peek.db-shm");
        if wal_path.exists() {
            let size = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
            files.push(format!("peek.db-wal ({} bytes)", size));
        }
        if shm_path.exists() {
            let size = std::fs::metadata(&shm_path).map(|m| m.len()).unwrap_or(0);
            files.push(format!("peek.db-shm ({} bytes)", size));
        }

        // Check Library folder for other databases
        let lib_path = container_path.join("Library");
        if lib_path.exists() {
            files.push("--- Library folder: ---".to_string());
            if let Ok(entries) = std::fs::read_dir(&lib_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let metadata = std::fs::metadata(&path);
                    let size = metadata.map(|m| m.len()).unwrap_or(0);
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    files.push(format!("  {} ({} bytes)", name, size));
                }
            }
        }

        Ok(files)
    }
}

#[tauri::command]
fn debug_profiles_json() -> Result<String, String> {
    let config_path = match get_profiles_config_path() {
        Some(p) => p,
        None => return Err("No config path".to_string()),
    };

    let mut result = format!("Path: {}\nExists: {}\n", config_path.display(), config_path.exists());

    if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(contents) => {
                result.push_str(&format!("Content:\n{}", contents));
            }
            Err(e) => {
                result.push_str(&format!("Read error: {}", e));
            }
        }
    }

    Ok(result)
}

#[tauri::command]
fn debug_settings_table() -> Result<String, String> {
    let db_path = get_db_path().ok_or("Failed to get database path")?;
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    let mut result = format!("DB: {:?}\n\nSettings table:\n", db_path);

    // Check if settings table exists
    let has_settings: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) > 0;

    if !has_settings {
        result.push_str("Settings table does not exist!");
        return Ok(result);
    }

    // Get all settings
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;

    for row in rows {
        if let Ok((key, value)) = row {
            let display_value = if key.contains("api_key") || key.contains("key") {
                format!("{}...", &value.chars().take(8).collect::<String>())
            } else {
                value
            };
            result.push_str(&format!("{} = {}\n", key, display_value));
        }
    }

    Ok(result)
}

#[tauri::command]
fn debug_query_database() -> Result<String, String> {
    let db_path = get_db_path().ok_or("Failed to get database path")?;
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    let mut info = Vec::new();
    info.push(format!("DB: {:?}", db_path));

    // List all tables
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    info.push(format!("Tables: {:?}", tables));

    // Count items in each relevant table (including old schema)
    for table in &["items", "urls", "texts", "tagsets", "tags", "addresses", "visits", "content"] {
        let count: Result<i64, _> = conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", table),
            [],
            |row| row.get(0),
        );
        match count {
            Ok(c) => info.push(format!("{}: {} rows", table, c)),
            Err(_) => info.push(format!("{}: (not found)", table)),
        }
    }

    // Check for deleted items
    let deleted_count: Result<i64, _> = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE deleted = 1",
        [],
        |row| row.get(0),
    );
    match deleted_count {
        Ok(c) => info.push(format!("deleted: {}", c)),
        Err(_) => {}
    }

    // Check distinct device_ids
    let device_ids: Result<Vec<String>, _> = conn
        .prepare("SELECT DISTINCT device_id FROM items WHERE device_id IS NOT NULL")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        });
    match device_ids {
        Ok(ids) => info.push(format!("device_ids: {:?}", ids)),
        Err(_) => info.push("device_id: (no column)".to_string()),
    }

    // Get current device_id from settings
    let current_device: Result<String, _> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'device_id'",
        [],
        |row| row.get(0),
    );
    match current_device {
        Ok(id) => info.push(format!("current device: {}", id)),
        Err(_) => info.push("current device: (not set)".to_string()),
    }

    // Sample first few items if any exist
    let sample: Result<Vec<String>, _> = conn
        .prepare("SELECT id, type, content, device_id FROM items LIMIT 3")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| {
                let id: String = row.get(0)?;
                let item_type: String = row.get(1)?;
                let content: String = row.get::<_, String>(2).unwrap_or_default();
                let device: String = row.get::<_, String>(3).unwrap_or_default();
                Ok(format!("{}:{}:{:.20}...(dev:{})", id, item_type, content, device))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        });
    match sample {
        Ok(items) if !items.is_empty() => info.push(format!("sample: {:?}", items)),
        _ => {}
    }

    Ok(info.join(" | "))
}

#[tauri::command]
fn debug_export_database(app: tauri::AppHandle) -> Result<String, String> {
    let db_path = get_db_path().ok_or("Failed to get database path")?;
    let data = std::fs::read(&db_path).map_err(|e| format!("Failed to read database: {}", e))?;

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let encoded = STANDARD.encode(&data);

    let mut export_locations = Vec::new();

    // Try iCloud first (syncs across devices automatically)
    if let Some(icloud_path) = get_icloud_path() {
        let icloud_db = icloud_path.join("peek-export.db");
        let icloud_b64 = icloud_path.join("peek-export.b64");

        if let Err(e) = std::fs::write(&icloud_db, &data) {
            ios_log(&format!("Failed to write to iCloud: {}", e));
        } else {
            let _ = std::fs::write(&icloud_b64, &encoded);
            export_locations.push("iCloud".to_string());
            ios_log(&format!("Exported to iCloud: {}", icloud_db.display()));
        }
    }

    // Always export to app data as backup (accessible via Finder File Sharing)
    let app_data = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let export_db = app_data.join("peek-export.db");
    std::fs::write(&export_db, &data)
        .map_err(|e| format!("Failed to write database: {}", e))?;

    let export_b64 = app_data.join("peek-export.b64");
    std::fs::write(&export_b64, &encoded)
        .map_err(|e| format!("Failed to write base64: {}", e))?;

    export_locations.push("app data".to_string());

    let locations = export_locations.join(" + ");
    Ok(format!("Exported {} bytes to {}", data.len(), locations))
}

/// Normalize a URL by ensuring a trailing slash on bare authority URLs
/// (e.g. "https://example.com" -> "https://example.com/").
/// URLs with an existing path, query, or fragment are left unchanged.
fn normalize_url(url: &str) -> String {
    // Parse with url crate if available, otherwise simple heuristic:
    // If after stripping scheme + authority there's no path, add trailing slash
    if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        // rest is like "example.com" or "example.com/" or "example.com/path"
        if !rest.contains('/') {
            // Bare domain with no path at all -> add trailing slash
            return format!("{}/", url);
        }
    }
    url.to_string()
}

#[tauri::command]
async fn save_url(url: String, tags: Vec<String>, metadata: Option<serde_json::Value>) -> Result<(), String> {
    let url = normalize_url(&url);
    println!("[Rust] save_url called with url: {}, tags: {:?}, metadata: {:?}", url, tags, metadata);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();

    // Check if URL already exists (as a page type)
    // Check both normalized and without trailing slash to match legacy data
    let url_without_slash = url.strip_suffix('/').unwrap_or(&url);
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM items WHERE type = 'url' AND (url = ? OR url = ?) AND deleted_at IS NULL",
            params![&url, &url_without_slash],
            |row| row.get(0),
        )
        .ok();

    let item_id = if let Some(existing) = existing_id {
        // Update existing item (normalize URL + update metadata)
        // Read existing metadata, merge user-provided fields, then inject sync update
        let existing_meta_str: Option<String> = conn
            .query_row("SELECT metadata FROM items WHERE id = ?", params![&existing], |row| row.get(0))
            .ok();
        // Merge user-provided metadata fields into existing metadata
        let merged_str = if let Some(new_meta) = &metadata {
            let mut existing: serde_json::Value = existing_meta_str
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let (Some(dst), Some(src)) = (existing.as_object_mut(), new_meta.as_object()) {
                for (k, v) in src {
                    if k != "_sync" { dst.insert(k.clone(), v.clone()); }
                }
            }
            Some(serde_json::to_string(&existing).unwrap_or_default())
        } else {
            existing_meta_str
        };
        let updated_meta = inject_sync_metadata_for_update(merged_str);
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
        // IMPORTANT: Use 'url' type to match Swift's ItemType.page.rawValue = "url"
        let meta_with_sync = inject_sync_metadata_for_save(metadata);
        let metadata_json = serde_json::to_string(&meta_with_sync).unwrap_or_default();
        conn.execute(
            "INSERT INTO items (id, type, url, metadata, created_at, updated_at) VALUES (?, 'url', ?, ?, ?, ?)",
            params![&id, &url, &metadata_json, &now, &now],
        )
        .map_err(|e| format!("Failed to insert item: {}", e))?;

        id
    };

    // Add tags
    for tag_name in &tags {
        // Get or create tag
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(id) => {
                // Update existing tag stats
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

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
            params![&item_id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Page saved successfully");

    // Trigger auto-sync if enabled (fire and forget)
    tauri::async_runtime::spawn(async move {
        trigger_auto_sync_if_enabled().await;
    });

    Ok(())
}

/// Extract domain from URL, removing www. prefix if present
fn extract_domain(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| {
            if h.starts_with("www.") {
                h[4..].to_string()
            } else {
                h.to_string()
            }
        }))
}

#[tauri::command]
async fn get_tags_by_frecency() -> Result<Vec<TagStats>, String> {
    let conn = get_connection()?;

    let mut stmt = conn
        .prepare("SELECT name, frequency, lastUsed, frecencyScore FROM tags ORDER BY frecencyScore DESC")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let tags: Vec<TagStats> = stmt
        .query_map([], |row| {
            Ok(TagStats {
                name: row.get(0)?,
                frequency: row.get(1)?,
                last_used: row.get(2)?,
                frecency_score: row.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(tags)
}

/// Get tags sorted by frecency with domain affinity boost
/// Tags used on URLs from the same domain get a 2x score multiplier
#[tauri::command]
async fn get_tags_by_frecency_for_url(url: String) -> Result<Vec<TagStats>, String> {
    let domain = match extract_domain(&url) {
        Some(d) => d,
        None => return get_tags_by_frecency().await, // Fall back to regular frecency
    };

    let conn = get_connection()?;

    // Get all tags with their IDs
    let mut stmt = conn
        .prepare("SELECT id, name, frequency, lastUsed, frecencyScore FROM tags")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let tags_with_ids: Vec<(String, TagStats)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                TagStats {
                    name: row.get(1)?,
                    frequency: row.get(2)?,
                    last_used: row.get(3)?,
                    frecency_score: row.get(4)?,
                },
            ))
        })
        .map_err(|e| format!("Failed to query tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Get tag IDs used on URLs with the same domain
    let domain_pattern = format!("%://{}/%", domain);
    let domain_pattern_root = format!("%://{}", domain);
    let www_domain_pattern = format!("%://www.{}/%", domain);
    let www_domain_pattern_root = format!("%://www.{}", domain);

    let mut domain_stmt = conn
        .prepare(
            "SELECT DISTINCT it.tag_id
             FROM item_tags it
             JOIN items i ON it.item_id = i.id
             WHERE i.deleted_at IS NULL AND i.type = 'url'
               AND (i.url LIKE ?1 OR i.url LIKE ?2 OR i.url LIKE ?3 OR i.url LIKE ?4)",
        )
        .map_err(|e| format!("Failed to prepare domain query: {}", e))?;

    let domain_tag_ids: std::collections::HashSet<String> = domain_stmt
        .query_map(
            params![&domain_pattern, &domain_pattern_root, &www_domain_pattern, &www_domain_pattern_root],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query domain tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Apply 2x multiplier to tags used on same-domain URLs and sort
    let mut boosted_tags: Vec<TagStats> = tags_with_ids
        .into_iter()
        .map(|(id, mut tag)| {
            if domain_tag_ids.contains(&id) {
                tag.frecency_score *= 2.0;
            }
            tag
        })
        .collect();

    boosted_tags.sort_by(|a, b| b.frecency_score.partial_cmp(&a.frecency_score).unwrap_or(std::cmp::Ordering::Equal));

    Ok(boosted_tags)
}

/// Get saved pages (URLs) - backward compatible, returns only page type items
#[tauri::command]
async fn get_saved_urls() -> Result<Vec<SavedUrl>, String> {
    let conn = get_connection()?;

    // Get all non-deleted pages (type='page')
    let mut stmt = conn
        .prepare(
            "SELECT id, url, created_at, metadata FROM items WHERE type = 'url' AND deleted_at IS NULL ORDER BY COALESCE(updated_at, created_at) DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let url_rows: Vec<(String, String, String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(|e| format!("Failed to query pages: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Get tags for each item
    let mut urls: Vec<SavedUrl> = Vec::new();
    for (id, url, created_at, metadata_json) in url_rows {
        let mut tag_stmt = conn
            .prepare(
                "SELECT t.name FROM tags t
                 JOIN item_tags it ON t.id = it.tag_id
                 WHERE it.item_id = ?
                 ORDER BY t.name",
            )
            .map_err(|e| format!("Failed to prepare tag query: {}", e))?;

        let tags: Vec<String> = tag_stmt
            .query_map(params![&id], |row| row.get(0))
            .map_err(|e| format!("Failed to query tags for item: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

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

/// Delete any item by ID (works for pages, texts, tagsets)
#[tauri::command]
async fn delete_url(id: String) -> Result<(), String> {
    println!("[Rust] delete_url/delete_item called for id: {}", id);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();

    // Soft delete: set deleted_at timestamp
    // This prevents sync from re-creating the item when pulling from server
    conn.execute(
        "UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?",
        params![&now, &now, &id],
    )
    .map_err(|e| format!("Failed to delete item: {}", e))?;

    println!("[Rust] Item soft-deleted successfully");
    Ok(())
}

/// Record a visit to an item (URL opened in browser or webview)
#[tauri::command]
async fn record_visit(item_id: String, source: String, window_type: String) -> Result<String, String> {
    println!("[Rust] record_visit called for item_id: {}, source: {}, window_type: {}", item_id, source, window_type);

    let conn = get_connection()?;
    let visit_id = uuid::Uuid::new_v4().to_string();
    let timestamp = Utc::now().timestamp_millis();

    conn.execute(
        "INSERT INTO item_visits (id, item_id, timestamp, source, window_type) VALUES (?, ?, ?, ?, ?)",
        params![&visit_id, &item_id, timestamp, &source, &window_type],
    )
    .map_err(|e| format!("Failed to record visit: {}", e))?;

    println!("[Rust] Visit recorded successfully: {}", visit_id);
    Ok(visit_id)
}

/// Open a URL in the native webview (iOS only)
#[tauri::command]
async fn open_native_webview(url: String, item_id: String) -> Result<(), String> {
    println!("[Rust] open_native_webview called for url: {}, item_id: {}", url, item_id);

    #[cfg(target_os = "ios")]
    {
        use std::ffi::CString;
        let url_cstr = CString::new(url.as_str()).map_err(|e| format!("Invalid URL string: {}", e))?;
        let item_id_cstr = CString::new(item_id.as_str()).map_err(|e| format!("Invalid item_id string: {}", e))?;

        println!("[Rust] Calling Swift webview_plugin_open...");
        let result = unsafe { webview_plugin_open(url_cstr.as_ptr(), item_id_cstr.as_ptr()) };
        println!("[Rust] Swift returned: {}", result);

        if result {
            Ok(())
        } else {
            Err("Failed to open native webview".to_string())
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        println!("[Rust] Not iOS - webview not supported");
        let _ = (url, item_id);
        Ok(())
    }
}

/// Close the native webview (iOS only)
#[tauri::command]
async fn close_native_webview() -> Result<(), String> {
    println!("[Rust] close_native_webview called");

    #[cfg(target_os = "ios")]
    {
        unsafe { webview_plugin_close() };
        println!("[Rust] Swift webview_plugin_close called");
    }

    Ok(())
}

/// Open a URL in an inline native WKWebView (added as subview, not modal)
#[tauri::command]
async fn open_inline_webview(url: String, top_offset: f64) -> Result<(), String> {
    println!("[Rust] open_inline_webview called for url: {}, top_offset: {}", url, top_offset);

    #[cfg(target_os = "ios")]
    {
        use std::ffi::CString;
        let url_cstr = CString::new(url.as_str()).map_err(|e| format!("Invalid URL string: {}", e))?;

        let result = unsafe { webview_plugin_open_inline(url_cstr.as_ptr(), top_offset) };
        if result {
            Ok(())
        } else {
            Err("Failed to open inline webview".to_string())
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (url, top_offset);
        Ok(())
    }
}

/// Close the inline native WKWebView
#[tauri::command]
async fn close_inline_webview() -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        unsafe { webview_plugin_close_inline() };
    }
    Ok(())
}

/// Update a page (URL) item - backward compatible
#[tauri::command]
async fn update_url(id: String, url: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_url called for id: {}, url: {}, tags: {:?}", id, url, tags);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();

    // Verify item exists and is a page
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'url' AND deleted_at IS NULL",
            params![&id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Page not found".to_string());
    }

    // Update URL value, timestamp, and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![&id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta);
    conn.execute(
        "UPDATE items SET url = ?, updated_at = ?, metadata = ? WHERE id = ?",
        params![&url, &now, &updated_meta, &id],
    )
    .map_err(|e| format!("Failed to update item: {}", e))?;

    // Get existing tags for this item
    let mut existing_tag_stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?",
        )
        .map_err(|e| format!("Failed to prepare existing tags query: {}", e))?;

    let existing_tags: std::collections::HashSet<String> = existing_tag_stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|e| format!("Failed to query existing tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let new_tags_set: std::collections::HashSet<String> = tags.iter().cloned().collect();

    // Determine which tags are being added vs removed
    let tags_to_add: Vec<&String> = new_tags_set.difference(&existing_tags).collect();
    let tags_to_remove: Vec<&String> = existing_tags.difference(&new_tags_set).collect();

    // Remove only the tags that were actually removed
    for tag_name in &tags_to_remove {
        conn.execute(
            "DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![&id, tag_name],
        )
        .map_err(|e| format!("Failed to remove tag association: {}", e))?;
    }

    // Add only the tags that are new to this item
    for tag_name in &tags_to_add {
        // Get or create tag
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                // Update existing tag stats
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
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
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Page updated successfully");

    // Push to webhook (fire and forget)
    let saved_url = SavedUrl {
        id,
        url,
        tags,
        saved_at: now,
        metadata: None,
    };
    tauri::async_runtime::spawn(async move {
        push_url_to_webhook(saved_url).await;
    });

    Ok(())
}

/// Update tags for any item (legacy function - kept for backward compatibility)
#[tauri::command]
async fn update_url_tags(id: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_url_tags called for id: {}, tags: {:?}", id, tags);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();

    // Verify item exists
    let item_info: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT type, url FROM items WHERE id = ? AND deleted_at IS NULL",
            params![&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let (item_type, url_opt) = match item_info {
        Some(info) => info,
        None => return Err("Item not found".to_string()),
    };

    // Get existing tags for this item
    let mut existing_tag_stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?",
        )
        .map_err(|e| format!("Failed to prepare existing tags query: {}", e))?;

    let existing_tags: std::collections::HashSet<String> = existing_tag_stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|e| format!("Failed to query existing tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let new_tags_set: std::collections::HashSet<String> = tags.iter().cloned().collect();

    // Determine which tags are being added vs removed
    let tags_to_add: Vec<&String> = new_tags_set.difference(&existing_tags).collect();
    let tags_to_remove: Vec<&String> = existing_tags.difference(&new_tags_set).collect();

    // Update item's updated_at timestamp and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![&id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta);
    conn.execute(
        "UPDATE items SET updated_at = ?, metadata = ? WHERE id = ?",
        params![&now, &updated_meta, &id],
    )
    .map_err(|e| format!("Failed to update item: {}", e))?;

    // Remove only the tags that were actually removed
    for tag_name in &tags_to_remove {
        conn.execute(
            "DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![&id, tag_name],
        )
        .map_err(|e| format!("Failed to remove tag association: {}", e))?;
    }

    // Add only the tags that are new to this item
    for tag_name in &tags_to_add {
        // Get or create tag
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                // Update existing tag stats
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
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
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Item tags updated successfully");

    // Push to webhook (fire and forget) - only for page types
    if item_type == "page" {
        if let Some(url) = url_opt {
            let saved_url = SavedUrl {
                id,
                url,
                tags,
                saved_at: now,
                metadata: None,
            };
            tauri::async_runtime::spawn(async move {
                push_url_to_webhook(saved_url).await;
            });
        }
    }

    Ok(())
}

/// Save a text item with hashtags auto-parsed as tags
#[tauri::command]
async fn save_text(content: String, tags: Option<Vec<String>>, metadata: Option<serde_json::Value>) -> Result<(), String> {
    println!("[Rust] save_text called with content: {}", &content[..content.len().min(50)]);
    println!("[Rust] save_text received tags: {:?}", tags);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let meta_with_sync = inject_sync_metadata_for_save(metadata);
    let metadata_json: Option<String> = Some(serde_json::to_string(&meta_with_sync).unwrap_or_default());

    // Parse hashtags from content and merge with provided tags
    let mut all_tags = parse_hashtags(&content);
    if let Some(extra) = tags {
        for tag in extra {
            let normalized = tag.trim().to_lowercase();
            if !normalized.is_empty() && !all_tags.contains(&normalized) {
                all_tags.push(normalized);
            }
        }
    }
    println!("[Rust] Final tags (parsed + provided): {:?}", all_tags);

    // Insert text item
    conn.execute(
        "INSERT INTO items (id, type, content, metadata, created_at, updated_at) VALUES (?, 'text', ?, ?, ?, ?)",
        params![&id, &content, &metadata_json, &now, &now],
    )
    .map_err(|e| format!("Failed to insert text item: {}", e))?;

    // Add tags
    for tag_name in &all_tags {
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
            }
            Err(_) => {
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

        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Text saved successfully");

    // Trigger auto-sync if enabled (fire and forget)
    tauri::async_runtime::spawn(async move {
        trigger_auto_sync_if_enabled().await;
    });

    Ok(())
}

/// Save a tagset (tags only, no content)
#[tauri::command]
async fn save_tagset(tags: Vec<String>, metadata: Option<serde_json::Value>) -> Result<(), String> {
    println!("[Rust] save_tagset called with tags: {:?}", tags);

    if tags.is_empty() {
        return Err("At least one tag is required for a tagset".to_string());
    }

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let meta_with_sync = inject_sync_metadata_for_save(metadata);
    let metadata_json: Option<String> = Some(serde_json::to_string(&meta_with_sync).unwrap_or_default());

    // Insert tagset item
    conn.execute(
        "INSERT INTO items (id, type, metadata, created_at, updated_at) VALUES (?, 'tagset', ?, ?, ?)",
        params![&id, &metadata_json, &now, &now],
    )
    .map_err(|e| format!("Failed to insert tagset item: {}", e))?;

    // Add tags
    for tag_name in &tags {
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
            }
            Err(_) => {
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

        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Tagset saved successfully");

    // Trigger auto-sync if enabled (fire and forget)
    tauri::async_runtime::spawn(async move {
        trigger_auto_sync_if_enabled().await;
    });

    Ok(())
}

/// Get all saved text items
#[tauri::command]
async fn get_saved_texts() -> Result<Vec<SavedText>, String> {
    let conn = get_connection()?;

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
        let mut tag_stmt = conn
            .prepare(
                "SELECT t.name FROM tags t
                 JOIN item_tags it ON t.id = it.tag_id
                 WHERE it.item_id = ?
                 ORDER BY t.name",
            )
            .map_err(|e| format!("Failed to prepare tag query: {}", e))?;

        let tags: Vec<String> = tag_stmt
            .query_map(params![&id], |row| row.get(0))
            .map_err(|e| format!("Failed to query tags: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

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

/// Get all saved tagsets
#[tauri::command]
async fn get_saved_tagsets() -> Result<Vec<SavedTagset>, String> {
    let conn = get_connection()?;

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
        let mut tag_stmt = conn
            .prepare(
                "SELECT t.name FROM tags t
                 JOIN item_tags it ON t.id = it.tag_id
                 WHERE it.item_id = ?
                 ORDER BY t.name",
            )
            .map_err(|e| format!("Failed to prepare tag query: {}", e))?;

        let tags: Vec<String> = tag_stmt
            .query_map(params![&id], |row| row.get(0))
            .map_err(|e| format!("Failed to query tags: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

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

/// Update a text item
#[tauri::command]
async fn update_text(id: String, content: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_text called for id: {}, tags: {:?}", id, tags);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();

    // Verify item exists and is a text type
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'text' AND deleted_at IS NULL",
            params![&id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Text not found".to_string());
    }

    // Update content, timestamp, and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![&id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta);
    conn.execute(
        "UPDATE items SET content = ?, updated_at = ?, metadata = ? WHERE id = ?",
        params![&content, &now, &updated_meta, &id],
    )
    .map_err(|e| format!("Failed to update text: {}", e))?;

    // Combine UI-provided tags with hashtags parsed from content
    let hashtags = parse_hashtags(&content);
    let mut new_tags_set: std::collections::HashSet<String> = tags.into_iter().collect();
    new_tags_set.extend(hashtags);

    // Get existing tags
    let mut existing_tag_stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?",
        )
        .map_err(|e| format!("Failed to prepare existing tags query: {}", e))?;

    let existing_tags: std::collections::HashSet<String> = existing_tag_stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|e| format!("Failed to query existing tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let tags_to_add: Vec<&String> = new_tags_set.difference(&existing_tags).collect();
    let tags_to_remove: Vec<&String> = existing_tags.difference(&new_tags_set).collect();

    // Remove old tags
    for tag_name in &tags_to_remove {
        conn.execute(
            "DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![&id, tag_name],
        )
        .map_err(|e| format!("Failed to remove tag: {}", e))?;
    }

    // Add new tags
    for tag_name in &tags_to_add {
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
            }
            Err(_) => {
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

        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Text updated successfully");

    // Push to webhook
    let final_tags: Vec<String> = new_tags_set.into_iter().collect();
    let saved_text = SavedText {
        id,
        content,
        tags: final_tags,
        saved_at: now,
        metadata: None,
    };
    tauri::async_runtime::spawn(async move {
        push_text_to_webhook(saved_text).await;
    });

    Ok(())
}

/// Update a tagset's tags
#[tauri::command]
async fn update_tagset(id: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_tagset called for id: {}, tags: {:?}", id, tags);

    if tags.is_empty() {
        return Err("At least one tag is required for a tagset".to_string());
    }

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();

    // Verify item exists and is a tagset type
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'tagset' AND deleted_at IS NULL",
            params![&id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Tagset not found".to_string());
    }

    // Update timestamp and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![&id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta);
    conn.execute(
        "UPDATE items SET updated_at = ?, metadata = ? WHERE id = ?",
        params![&now, &updated_meta, &id],
    )
    .map_err(|e| format!("Failed to update tagset: {}", e))?;

    // Get existing tags
    let mut existing_tag_stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?",
        )
        .map_err(|e| format!("Failed to prepare existing tags query: {}", e))?;

    let existing_tags: std::collections::HashSet<String> = existing_tag_stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|e| format!("Failed to query existing tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let new_tags_set: std::collections::HashSet<String> = tags.iter().cloned().collect();
    let tags_to_add: Vec<&String> = new_tags_set.difference(&existing_tags).collect();
    let tags_to_remove: Vec<&String> = existing_tags.difference(&new_tags_set).collect();

    // Remove old tags
    for tag_name in &tags_to_remove {
        conn.execute(
            "DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![&id, tag_name],
        )
        .map_err(|e| format!("Failed to remove tag: {}", e))?;
    }

    // Add new tags
    for tag_name in &tags_to_add {
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
            }
            Err(_) => {
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

        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Tagset updated successfully");

    // Push to webhook
    let saved_tagset = SavedTagset {
        id,
        tags,
        saved_at: now,
        metadata: None,
    };
    tauri::async_runtime::spawn(async move {
        push_tagset_to_webhook(saved_tagset).await;
    });

    Ok(())
}

/// Save an image with optional tags and metadata
/// image_data is base64-encoded image bytes
/// thumbnail_data is optional base64-encoded thumbnail
#[tauri::command]
async fn save_image(
    image_data: String,
    mime_type: String,
    tags: Vec<String>,
    metadata: Option<serde_json::Value>,
    thumbnail_data: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<String, String> {
    println!("[Rust] save_image called, mime_type: {}, tags: {:?}", mime_type, tags);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    let item_id = uuid::Uuid::new_v4().to_string();
    let blob_id = uuid::Uuid::new_v4().to_string();
    let meta_with_sync = inject_sync_metadata_for_save(metadata);
    let metadata_json: Option<String> = Some(serde_json::to_string(&meta_with_sync).unwrap_or_default());

    // Decode base64 image data
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let image_bytes = STANDARD.decode(&image_data)
        .map_err(|e| format!("Failed to decode image data: {}", e))?;
    let size_bytes = image_bytes.len() as i64;

    let thumbnail_bytes: Option<Vec<u8>> = thumbnail_data
        .map(|t| STANDARD.decode(&t))
        .transpose()
        .map_err(|e| format!("Failed to decode thumbnail: {}", e))?;

    // Insert image item
    conn.execute(
        "INSERT INTO items (id, type, metadata, created_at, updated_at) VALUES (?, 'image', ?, ?, ?)",
        params![&item_id, &metadata_json, &now, &now],
    )
    .map_err(|e| format!("Failed to insert image item: {}", e))?;

    // Insert blob data
    conn.execute(
        "INSERT INTO blobs (id, item_id, data, mime_type, size_bytes, width, height, thumbnail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![&blob_id, &item_id, &image_bytes, &mime_type, size_bytes, width, height, &thumbnail_bytes, &now],
    )
    .map_err(|e| format!("Failed to insert blob: {}", e))?;

    // Add tags
    for tag_name in &tags {
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
            }
            Err(_) => {
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

        conn.execute(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&item_id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Image saved successfully with id: {}", item_id);

    // Trigger auto-sync if enabled (fire and forget)
    tauri::async_runtime::spawn(async move {
        trigger_auto_sync_if_enabled().await;
    });

    Ok(item_id)
}

/// Get all saved images (returns metadata and thumbnails, not full image data)
#[tauri::command]
async fn get_saved_images() -> Result<Vec<SavedImage>, String> {
    let conn = get_connection()?;

    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.created_at, i.metadata, b.mime_type, b.width, b.height, b.thumbnail
             FROM items i
             LEFT JOIN blobs b ON b.item_id = i.id
             WHERE i.type = 'image' AND i.deleted_at IS NULL
             ORDER BY COALESCE(i.updated_at, i.created_at) DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let rows: Vec<(String, String, Option<String>, Option<String>, Option<u32>, Option<u32>, Option<Vec<u8>>)> = stmt
        .query_map([], |row| Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        )))
        .map_err(|e| format!("Failed to query images: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut images: Vec<SavedImage> = Vec::new();
    for (id, created_at, metadata_json, mime_type, width, height, thumbnail_bytes) in rows {
        let mut tag_stmt = conn
            .prepare(
                "SELECT t.name FROM tags t
                 JOIN item_tags it ON t.id = it.tag_id
                 WHERE it.item_id = ?
                 ORDER BY t.name",
            )
            .map_err(|e| format!("Failed to prepare tag query: {}", e))?;

        let tags: Vec<String> = tag_stmt
            .query_map(params![&id], |row| row.get(0))
            .map_err(|e| format!("Failed to query tags: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        let metadata = metadata_json.and_then(|s| serde_json::from_str(&s).ok());
        let thumbnail = thumbnail_bytes.map(|b| STANDARD.encode(&b));

        images.push(SavedImage {
            id,
            tags,
            saved_at: created_at,
            metadata,
            thumbnail,
            mime_type: mime_type.unwrap_or_else(|| "image/jpeg".to_string()),
            width,
            height,
        });
    }

    Ok(images)
}

/// Get full image data by item ID (returns base64-encoded image)
#[tauri::command]
async fn get_image_data(id: String) -> Result<Option<String>, String> {
    let conn = get_connection()?;

    let result: Option<Vec<u8>> = conn
        .query_row(
            "SELECT data FROM blobs WHERE item_id = ?",
            params![&id],
            |row| row.get(0),
        )
        .ok();

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    Ok(result.map(|bytes| STANDARD.encode(&bytes)))
}

/// Save a captured image from camera (simplified interface)
/// image_data is base64-encoded image bytes (without data URL prefix)
#[tauri::command]
async fn save_captured_image(
    image_data: String,
    mime_type: String,
    tags: Vec<String>,
) -> Result<String, String> {
    println!("[Rust] save_captured_image called, mime_type: {}, tags: {:?}", mime_type, tags);

    // Use the image data as its own thumbnail for display
    // (camera images are typically already reasonably sized)
    save_image(image_data.clone(), mime_type, tags, None, Some(image_data), None, None).await
}

/// Update image tags
#[tauri::command]
async fn update_image_tags(id: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_image_tags called for id: {}, tags: {:?}", id, tags);

    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();

    // Verify item exists and is an image type
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM items WHERE id = ? AND type = 'image' AND deleted_at IS NULL",
            params![&id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if !exists {
        return Err("Image not found".to_string());
    }

    // Update timestamp and sync metadata
    let existing_meta: Option<String> = conn
        .query_row("SELECT metadata FROM items WHERE id = ?", params![&id], |row| row.get(0))
        .ok();
    let updated_meta = inject_sync_metadata_for_update(existing_meta);
    conn.execute(
        "UPDATE items SET updated_at = ?, metadata = ? WHERE id = ?",
        params![&now, &updated_meta, &id],
    )
    .map_err(|e| format!("Failed to update image: {}", e))?;

    // Get existing tags
    let mut existing_tag_stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?",
        )
        .map_err(|e| format!("Failed to prepare existing tags query: {}", e))?;

    let existing_tags: std::collections::HashSet<String> = existing_tag_stmt
        .query_map(params![&id], |row| row.get(0))
        .map_err(|e| format!("Failed to query existing tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let new_tags_set: std::collections::HashSet<String> = tags.iter().cloned().collect();
    let tags_to_add: Vec<&String> = new_tags_set.difference(&existing_tags).collect();
    let tags_to_remove: Vec<&String> = existing_tags.difference(&new_tags_set).collect();

    // Remove old tags
    for tag_name in &tags_to_remove {
        conn.execute(
            "DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![&id, tag_name],
        )
        .map_err(|e| format!("Failed to remove tag: {}", e))?;
    }

    // Add new tags
    for tag_name in &tags_to_add {
        let tag_id: String = match conn.query_row(
            "SELECT id FROM tags WHERE name = ?",
            params![tag_name],
            |row| row.get(0),
        ) {
            Ok(existing_id) => {
                let frequency: u32 = conn
                    .query_row(
                        "SELECT frequency FROM tags WHERE id = ?",
                        params![&existing_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                let new_frequency = frequency + 1;
                let frecency = calculate_frecency(new_frequency, &now);

                conn.execute(
                    "UPDATE tags SET frequency = ?, lastUsed = ?, frecencyScore = ?, updatedAt = ? WHERE id = ?",
                    params![new_frequency, &now, frecency, &now, &existing_id],
                )
                .map_err(|e| format!("Failed to update tag: {}", e))?;

                existing_id
            }
            Err(_) => {
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

        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![&id, tag_id, &now],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    println!("[Rust] Image tags updated successfully");
    Ok(())
}

#[tauri::command]
fn is_dark_mode() -> bool {
    unsafe { get_system_is_dark_mode() != 0 }
}

#[tauri::command]
fn quit_app() {
    println!("[Rust] Quitting app for profile switch");
    std::process::exit(0);
}

#[tauri::command]
async fn get_webhook_url() -> Result<Option<String>, String> {
    let config = load_profile_config();
    if config.sync.server_url.is_empty() {
        Ok(None)
    } else {
        Ok(Some(config.sync.server_url))
    }
}

#[tauri::command]
async fn get_webhook_api_key() -> Result<Option<String>, String> {
    let config = load_profile_config();
    if config.sync.api_key.is_empty() {
        Ok(None)
    } else {
        Ok(Some(config.sync.api_key))
    }
}

#[tauri::command]
async fn set_webhook_api_key(key: String) -> Result<(), String> {
    println!("[Rust] set_webhook_api_key called");
    let mut config = load_profile_config();
    config.sync.api_key = key;
    if !save_profile_config(&config) {
        return Err("Failed to save API key".to_string());
    }
    println!("[Rust] API key saved successfully");
    Ok(())
}

#[tauri::command]
async fn set_webhook_url(url: String) -> Result<(), String> {
    println!("[Rust] set_webhook_url called with url: {}", url);
    let mut config = load_profile_config();
    config.sync.server_url = url;
    if !save_profile_config(&config) {
        return Err("Failed to save webhook URL".to_string());
    }
    println!("[Rust] Webhook URL saved successfully");
    Ok(())
}

#[tauri::command]
fn get_auto_sync() -> Result<bool, String> {
    let config = load_profile_config();
    Ok(config.sync.auto_sync)
}

#[tauri::command]
fn set_auto_sync(enabled: bool) -> Result<(), String> {
    let mut config = load_profile_config();
    config.sync.auto_sync = enabled;
    if !save_profile_config(&config) {
        return Err("Failed to save auto-sync setting".to_string());
    }
    println!("[Rust] Auto-sync set to: {}", enabled);
    Ok(())
}

#[tauri::command]
fn get_archive_tag() -> Result<String, String> {
    Ok(load_profile_config().archive_tag)
}

#[tauri::command]
fn set_archive_tag(tag: String) -> Result<(), String> {
    let mut config = load_profile_config();
    config.archive_tag = tag;
    if !save_profile_config(&config) {
        return Err("Failed to save archive tag".to_string());
    }
    Ok(())
}

/// Check if auto-sync is enabled
fn is_auto_sync_enabled() -> bool {
    load_profile_config().sync.auto_sync
}

/// Trigger sync if auto-sync is enabled and webhook is configured
async fn trigger_auto_sync_if_enabled() {
    if !is_auto_sync_enabled() {
        return;
    }

    // Check if webhook is configured (from profiles.json)
    let config = load_profile_config();
    if config.sync.server_url.is_empty() {
        println!("[Rust] Auto-sync: skipping, no webhook configured");
        return;
    }

    println!("[Rust] Auto-sync: triggering sync after save");
    // Use sync_all for bidirectional sync
    match sync_all_internal().await {
        Ok(result) => {
            println!("[Rust] Auto-sync completed: pulled={}, pushed={}", result.pulled, result.pushed);
        }
        Err(e) => {
            println!("[Rust] Auto-sync failed: {}", e);
        }
    }
}

#[tauri::command]
async fn sync_to_webhook() -> Result<SyncResult, String> {
    println!("[Rust] sync_to_webhook called");

    // Get webhook URL and API key from profiles.json
    let config = load_profile_config();
    let base_webhook_url = &config.sync.server_url;

    if base_webhook_url.is_empty() {
        return Err("No webhook URL configured".to_string());
    }

    // Append profile to webhook URL
    let webhook_url = append_profile_to_url(base_webhook_url)?;

    let api_key = if config.sync.api_key.is_empty() {
        None
    } else {
        Some(config.sync.api_key.clone())
    };

    // Get all items (reuse existing logic)
    let urls = get_saved_urls().await?;
    let texts = get_saved_texts().await?;
    let tagsets = get_saved_tagsets().await?;

    let total_count = urls.len() + texts.len() + tagsets.len();

    if total_count == 0 {
        return Ok(SyncResult {
            success: true,
            synced_count: 0,
            message: "No items to sync".to_string(),
        });
    }

    // Create payload with all item types
    let payload = WebhookPayload { urls, texts, tagsets };

    // Send to webhook
    let client = reqwest::Client::new();
    let mut request = client.post(&webhook_url).json(&payload);

    // Add Authorization header if API key is configured
    if let Some(key) = api_key {
        if !key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", key));
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to send webhook request: {}", e))?;

    if response.status().is_success() {
        // Update last sync time
        let conn = get_connection()?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_sync', ?)",
            params![&now],
        )
        .ok();

        println!("[Rust] Webhook sync successful, synced {} items", total_count);
        Ok(SyncResult {
            success: true,
            synced_count: total_count,
            message: format!("Successfully synced {} items", total_count),
        })
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("Webhook returned error {}: {}", status, body))
    }
}

#[tauri::command]
fn get_last_sync() -> Result<Option<String>, String> {
    let conn = get_connection()?;
    let last_sync: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_sync'",
            [],
            |row| row.get(0),
        )
        .ok();
    Ok(last_sync)
}

/// Profile info returned to the UI
#[derive(Debug, Serialize, Deserialize)]
struct ProfileInfo {
    #[serde(rename = "currentProfileId")]
    current_profile_id: String,
    #[serde(rename = "isProductionBuild")]
    is_production_build: bool,
    profiles: Vec<ProfileEntry>,
    sync: SyncSettings,
}

/// Get current profile information including all available profiles
#[tauri::command]
fn get_profile_info() -> Result<ProfileInfo, String> {
    let config = load_profile_config();

    Ok(ProfileInfo {
        current_profile_id: config.current_profile_id.clone(),
        is_production_build: is_production_build(),
        profiles: config.profiles,
        sync: config.sync,
    })
}

/// Switch to a different profile
/// This changes both local database and sync target
/// Returns updated profile info
#[tauri::command]
fn set_profile(profile_id: String) -> Result<ProfileInfo, String> {
    let mut config = load_profile_config();

    // Verify profile exists
    let profile = config.profiles.iter().find(|p| p.id == profile_id);
    if profile.is_none() {
        return Err(format!("Profile '{}' does not exist", profile_id));
    }

    // Update last_used_at for the profile being switched to
    let now = Utc::now().to_rfc3339();
    for p in &mut config.profiles {
        if p.id == profile_id {
            p.last_used_at = now.clone();
        }
    }

    // Update current profile
    config.current_profile_id = profile_id.clone();
    if !save_profile_config(&config) {
        return Err("Failed to save profile config".to_string());
    }

    println!("[Rust] Switched to profile: {}", profile_id);

    // Clear the database connection cache so next access uses new profile's DB
    // Note: This requires the app to re-initialize database on next access
    clear_db_cache();

    get_profile_info()
}

/// Create a new profile
#[tauri::command]
fn create_profile(name: String) -> Result<ProfileInfo, String> {
    let mut config = load_profile_config();

    if name.trim().is_empty() {
        return Err("Profile name cannot be empty".to_string());
    }

    // Check for duplicate name (case-insensitive)
    if config.profiles.iter().any(|p| p.name.to_lowercase() == name.to_lowercase()) {
        return Err(format!("Profile '{}' already exists", name));
    }

    // Generate UUID for new profile
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    // Add new profile
    config.profiles.push(ProfileEntry {
        id: id.clone(),
        name: name.clone(),
        created_at: now.clone(),
        last_used_at: now,
        server_profile_id: None,
    });

    if !save_profile_config(&config) {
        return Err("Failed to save profile config".to_string());
    }

    println!("[Rust] Created profile: {} (id: {})", name, id);
    get_profile_info()
}

/// Delete a profile (cannot delete current profile or the last remaining profile)
#[tauri::command]
fn delete_profile(profile_id: String) -> Result<ProfileInfo, String> {
    let mut config = load_profile_config();

    // Cannot delete current profile
    if config.current_profile_id == profile_id {
        return Err("Cannot delete the current profile. Switch to another profile first.".to_string());
    }

    // Cannot delete if it's the last profile
    if config.profiles.len() <= 1 {
        return Err("Cannot delete the last profile".to_string());
    }

    // Remove profile
    let original_len = config.profiles.len();
    config.profiles.retain(|p| p.id != profile_id);

    if config.profiles.len() == original_len {
        return Err(format!("Profile '{}' not found", profile_id));
    }

    if !save_profile_config(&config) {
        return Err("Failed to save profile config".to_string());
    }

    // Note: We don't delete the database file - user can manually remove it
    println!("[Rust] Deleted profile: {}", profile_id);
    get_profile_info()
}

/// Swap databases between two profiles (one-time migration helper)
#[tauri::command]
fn swap_profile_databases(profile_id_a: String, profile_id_b: String) -> Result<String, String> {
    let container_path = get_container_path().ok_or("Failed to get container path")?;

    let db_a = container_path.join(format!("peek-{}.db", profile_id_a));
    let db_b = container_path.join(format!("peek-{}.db", profile_id_b));
    let db_temp = container_path.join("peek-swap-temp.db");

    if !db_a.exists() {
        return Err(format!("Database A not found: {}", db_a.display()));
    }
    if !db_b.exists() {
        return Err(format!("Database B not found: {}", db_b.display()));
    }

    // Swap: A -> temp, B -> A, temp -> B
    fs::rename(&db_a, &db_temp).map_err(|e| format!("Failed to move A to temp: {}", e))?;
    fs::rename(&db_b, &db_a).map_err(|e| format!("Failed to move B to A: {}", e))?;
    fs::rename(&db_temp, &db_b).map_err(|e| format!("Failed to move temp to B: {}", e))?;

    // Also swap WAL files if they exist
    let wal_a = container_path.join(format!("peek-{}.db-wal", profile_id_a));
    let wal_b = container_path.join(format!("peek-{}.db-wal", profile_id_b));
    let wal_temp = container_path.join("peek-swap-temp.db-wal");
    if wal_a.exists() && wal_b.exists() {
        let _ = fs::rename(&wal_a, &wal_temp);
        let _ = fs::rename(&wal_b, &wal_a);
        let _ = fs::rename(&wal_temp, &wal_b);
    }

    // Also swap SHM files if they exist
    let shm_a = container_path.join(format!("peek-{}.db-shm", profile_id_a));
    let shm_b = container_path.join(format!("peek-{}.db-shm", profile_id_b));
    let shm_temp = container_path.join("peek-swap-temp.db-shm");
    if shm_a.exists() && shm_b.exists() {
        let _ = fs::rename(&shm_a, &shm_temp);
        let _ = fs::rename(&shm_b, &shm_a);
        let _ = fs::rename(&shm_temp, &shm_b);
    }

    Ok(format!("Swapped databases. Restart app to see changes."))
}

/// Reset to first profile (typically Default or Development based on build)
#[tauri::command]
fn reset_profile_to_default() -> Result<ProfileInfo, String> {
    let config = load_profile_config();
    if let Some(first_profile) = config.profiles.first() {
        set_profile(first_profile.id.clone())
    } else {
        Err("No profiles available".to_string())
    }
}

/// Clear database cache to force re-initialization on profile switch
fn clear_db_cache() {
    if let Ok(mut initialized) = DB_INITIALIZED.lock() {
        *initialized = false;
    }
    println!("[Rust] Database cache cleared, will re-initialize on next access");
}

#[tauri::command]
async fn auto_sync_if_needed() -> Result<Option<SyncResult>, String> {
    // Check if webhook URL is configured (from profiles.json)
    let config = load_profile_config();
    if config.sync.server_url.is_empty() {
        return Ok(None); // No webhook configured, nothing to do
    }

    // Check last sync time (still in database as it's per-profile data)
    let conn = get_connection()?;
    let last_sync: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_sync'",
            [],
            |row| row.get(0),
        )
        .ok();

    let should_sync = match last_sync {
        None => true, // Never synced
        Some(last_sync_str) => {
            if let Ok(last_sync_time) = chrono::DateTime::parse_from_rfc3339(&last_sync_str) {
                let now = Utc::now();
                let hours_since_sync = (now - last_sync_time.with_timezone(&Utc)).num_hours();
                hours_since_sync >= 24
            } else {
                true // Invalid date, sync anyway
            }
        }
    };

    drop(conn); // Close connection before async call

    if should_sync {
        println!("[Rust] Auto-sync: syncing (>24h since last sync)");
        match sync_to_webhook().await {
            Ok(result) => Ok(Some(result)),
            Err(e) => {
                println!("[Rust] Auto-sync failed: {}", e);
                Ok(None) // Don't propagate error, just skip
            }
        }
    } else {
        println!("[Rust] Auto-sync: skipping (synced within 24h)");
        Ok(None)
    }
}

// ==================== Bidirectional Sync ====================

/// Helper to convert ISO string to chrono DateTime
fn parse_iso_datetime(iso: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Convert Unix milliseconds to an ISO 8601 string for local DB storage.
fn unix_ms_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

/// Convert Unix milliseconds to a DateTime<Utc> for timestamp comparison.
fn unix_ms_to_datetime(ms: i64) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::from_timestamp_millis(ms)
}

/// Check server version headers in a response.
/// If the server includes version headers that don't match ours, return an error.
/// If the server includes no version headers (legacy), skip the check.
fn check_response_version_headers(headers: &reqwest::header::HeaderMap) -> Result<(), String> {
    if let Some(ds) = headers.get("X-Peek-Datastore-Version") {
        if let Ok(ds_str) = ds.to_str() {
            if let Ok(ds_num) = ds_str.parse::<u32>() {
                if ds_num != DATASTORE_VERSION {
                    return Err(format!(
                        "Datastore version mismatch: server={}, client={}. Please update the app.",
                        ds_num, DATASTORE_VERSION
                    ));
                }
            }
        }
    }
    if let Some(proto) = headers.get("X-Peek-Protocol-Version") {
        if let Ok(proto_str) = proto.to_str() {
            if let Ok(proto_num) = proto_str.parse::<u32>() {
                if proto_num != PROTOCOL_VERSION {
                    return Err(format!(
                        "Protocol version mismatch: server={}, client={}. Please update the app.",
                        proto_num, PROTOCOL_VERSION
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Get items that need to be pushed (never synced or locally modified after their last sync)
fn get_items_to_push(conn: &Connection) -> Result<Vec<(String, String, Option<String>, Option<String>, String, String, String, Option<String>)>, String> {
    // Returns: (id, type, url, content, metadata, updated_at, sync_id, deleted_at)
    // Push items that:
    // 1. Have never been synced (sync_source = '' or NULL), OR
    // 2. Have been locally modified after their last sync (updated_at > synced_at)
    // 3. Have been soft-deleted locally with a sync_id (need to propagate delete to server)
    // This prevents re-pushing items that were just pulled from the server
    let mut stmt = conn
        .prepare(
            "SELECT id, type, url, content, COALESCE(metadata, ''), updated_at, COALESCE(sync_id, ''), deleted_at FROM items
             WHERE (deleted_at IS NULL AND (sync_source = '' OR sync_source IS NULL OR (synced_at IS NOT NULL AND updated_at > synced_at)))
             OR (deleted_at IS NOT NULL AND sync_id IS NOT NULL AND sync_id != '' AND synced_at IS NOT NULL AND updated_at > synced_at)"
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let items: Vec<(String, String, Option<String>, Option<String>, String, String, String, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?))
        })
        .map_err(|e| format!("Failed to query items: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(items)
}

/// Get tags for an item
fn get_item_tags(conn: &Connection, item_id: &str) -> Result<Vec<String>, String> {
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

/// Merge a server item into the local database
fn merge_server_item(conn: &Connection, server_item: &ServerItem) -> Result<&'static str, String> {
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
            // No local item to delete
            println!("[Rust] Sync: Server deleted item {} but no local copy, skipping", server_item.id);
            return Ok("skipped");
        }
        let (local_id, _local_updated_str, local_deleted_at) = local_item.unwrap();
        if local_deleted_at.is_some() {
            // Already deleted locally, just update synced_at
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
            // Local item is deleted but server has it alive - compare timestamps
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

                // Map server type to local type (server uses "url", mobile may have used "page")
                let item_type = &server_item.item_type;

                // Determine content field based on type
                let (url_val, content_val): (Option<&str>, Option<&str>) = match item_type.as_str() {
                    "url" | "page" => (server_item.content.as_deref(), None),
                    _ => (None, server_item.content.as_deref()),
                };

                conn.execute(
                    "UPDATE items SET type = ?, url = ?, content = ?, metadata = ?, updated_at = ?, synced_at = ? WHERE id = ?",
                    params![item_type, url_val, content_val, &metadata_json, &unix_ms_to_iso(server_item.updated_at), &now, &local_id],
                )
                .map_err(|e| format!("Failed to update item: {}", e))?;

                // Update tags
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

    // Map server type to local type
    let item_type = &server_item.item_type;

    // Determine content field based on type
    let (url_val, content_val): (Option<&str>, Option<&str>) = match item_type.as_str() {
        "url" | "page" => (server_item.content.as_deref(), None),
        _ => (None, server_item.content.as_deref()),
    };

    conn.execute(
        "INSERT INTO items (id, type, url, content, metadata, sync_id, sync_source, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'server', ?, ?, ?)",
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

/// Update tags for an item based on server data
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

/// Pull items from server and merge into local database
#[tauri::command]
async fn pull_from_server() -> Result<BidirectionalSyncResult, String> {
    println!("[Rust] pull_from_server called");

    // Get server URL and API key from profiles.json
    let config = load_profile_config();
    let server_url = &config.sync.server_url;

    if server_url.is_empty() {
        return Err("No server URL configured".to_string());
    }

    let api_key = if config.sync.api_key.is_empty() {
        None
    } else {
        Some(config.sync.api_key.clone())
    };

    // Get last sync time from database (per-profile data)
    let conn = get_connection()?;
    let last_sync: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_sync'",
            [],
            |row| row.get(0),
        )
        .ok();

    drop(conn); // Close connection before async call

    // Build request URL with profile parameter
    let base_url = if let Some(ref sync_time) = last_sync {
        // Incremental sync - get items since last sync
        format!("{}/items/since/{}", server_url.trim_end_matches('/'), sync_time)
    } else {
        // Full sync - get all items
        format!("{}/items", server_url.trim_end_matches('/'))
    };
    let items_url = append_profile_to_url(&base_url)?;
    // Always include deleted items so tombstones propagate during sync
    let items_url = format!("{}&includeDeleted=true", items_url);

    println!("[Rust] Pulling from: {}", items_url);

    // Fetch items from server
    let client = reqwest::Client::new();
    let mut request = client.get(&items_url)
        .header("X-Peek-Datastore-Version", DATASTORE_VERSION.to_string())
        .header("X-Peek-Protocol-Version", PROTOCOL_VERSION.to_string())
        .header("X-Peek-Client", "mobile");

    if let Some(key) = &api_key {
        if !key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", key));
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch from server: {}", e))?;

    if response.status().as_u16() == 409 {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Version mismatch — please update the app. {}", body));
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Server returned error {}: {}", status, body));
    }

    // Check server version headers in response (defensive, server already 409s on mismatch)
    check_response_version_headers(response.headers())?;

    let server_response: ServerItemsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse server response: {}", e))?;

    println!("[Rust] Received {} items from server", server_response.items.len());

    // Merge items into local database
    let conn = get_connection()?;
    let mut pulled = 0;
    let mut conflicts = 0;

    for server_item in &server_response.items {
        match merge_server_item(&conn, server_item)? {
            "pulled" => pulled += 1,
            "conflict" => conflicts += 1,
            _ => {}
        }
    }

    println!("[Rust] Pull complete: {} pulled, {} conflicts", pulled, conflicts);

    Ok(BidirectionalSyncResult {
        success: true,
        pulled,
        pushed: 0,
        conflicts,
        message: format!("Pulled {} items, {} conflicts", pulled, conflicts),
    })
}

/// Push local items to server using POST /items
#[tauri::command]
async fn push_to_server() -> Result<BidirectionalSyncResult, String> {
    println!("[Rust] push_to_server called");

    // Get server URL and API key from profiles.json
    let config = load_profile_config();
    let server_url = &config.sync.server_url;

    if server_url.is_empty() {
        return Err("No server URL configured".to_string());
    }

    let api_key = if config.sync.api_key.is_empty() {
        None
    } else {
        Some(config.sync.api_key.clone())
    };

    let conn = get_connection()?;

    // Get items to push (uses per-item synced_at, not global last_sync)
    let items = get_items_to_push(&conn)?;
    println!("[Rust] Found {} items to push", items.len());

    if items.is_empty() {
        return Ok(BidirectionalSyncResult {
            success: true,
            pulled: 0,
            pushed: 0,
            conflicts: 0,
            message: "No items to push".to_string(),
        });
    }

    let client = reqwest::Client::new();
    let base_post_url = format!("{}/items", server_url.trim_end_matches('/'));
    let post_url = append_profile_to_url(&base_post_url)?;
    let mut pushed = 0;
    let mut failed = 0;

    for (item_id, item_type, url_opt, content_opt, metadata_str, _updated_at, sync_id, deleted_at_opt) in &items {
        // Get tags for this item
        let tags = get_item_tags(&conn, item_id)?;

        // Determine content based on type
        let content = match item_type.as_str() {
            "url" | "page" => url_opt.clone(),
            _ => content_opt.clone(),
        };

        // Map "page" type to "url" for server
        let server_type = if item_type == "page" { "url" } else { item_type };

        // Parse metadata
        let metadata: Option<serde_json::Value> = if !metadata_str.is_empty() {
            serde_json::from_str(metadata_str).ok()
        } else {
            None
        };

        // Use server ID (sync_id) when available for dedup, otherwise local ID for first push
        let sync_id_to_send = if !sync_id.is_empty() { sync_id } else { item_id };

        // Build request body
        let mut body = serde_json::json!({
            "type": server_type,
            "content": content,
            "tags": tags,
            "metadata": metadata,
            "syncId": sync_id_to_send,
        });

        // Include deletedAt if the item was soft-deleted locally
        if let Some(ref deleted_at_str) = deleted_at_opt {
            if let Some(dt) = parse_iso_datetime(deleted_at_str) {
                body["deletedAt"] = serde_json::json!(dt.timestamp_millis());
            }
        }

        let mut request = client.post(&post_url).json(&body)
            .header("X-Peek-Datastore-Version", DATASTORE_VERSION.to_string())
            .header("X-Peek-Protocol-Version", PROTOCOL_VERSION.to_string())
            .header("X-Peek-Client", "mobile");

        if let Some(key) = &api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        match request.send().await {
            Ok(response) => {
                if response.status().as_u16() == 409 {
                    let body_text = response.text().await.unwrap_or_default();
                    return Err(format!("Version mismatch — please update the app. {}", body_text));
                }
                if response.status().is_success() {
                    // Parse response to get server ID
                    if let Ok(create_response) = response.json::<ServerCreateResponse>().await {
                        // Update local item with sync info
                        let now = Utc::now().to_rfc3339();
                        conn.execute(
                            "UPDATE items SET sync_id = ?, sync_source = 'server', synced_at = ? WHERE id = ?",
                            params![&create_response.id, &now, item_id],
                        ).ok();

                        println!("[Rust] Pushed item {} -> {}", item_id, create_response.id);
                        pushed += 1;
                    } else {
                        failed += 1;
                    }
                } else {
                    let status = response.status();
                    println!("[Rust] Failed to push item {}: {}", item_id, status);
                    failed += 1;
                }
            }
            Err(e) => {
                println!("[Rust] Failed to push item {}: {}", item_id, e);
                failed += 1;
            }
        }
    }

    println!("[Rust] Push complete: {} pushed, {} failed", pushed, failed);

    Ok(BidirectionalSyncResult {
        success: failed == 0,
        pulled: 0,
        pushed,
        conflicts: 0,
        message: if failed > 0 {
            format!("Pushed {} items, {} failed", pushed, failed)
        } else {
            format!("Pushed {} items", pushed)
        },
    })
}

/// Full bidirectional sync: pull then push
#[tauri::command]
/// Internal sync_all implementation (called by both command and auto-sync)
async fn sync_all_internal() -> Result<BidirectionalSyncResult, String> {
    // Pull first
    let pull_result = pull_from_server().await?;

    // Then push
    let push_result = push_to_server().await?;

    // Update last sync time
    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_sync', ?)",
        params![&now],
    ).ok();

    let total_pulled = pull_result.pulled;
    let total_pushed = push_result.pushed;
    let total_conflicts = pull_result.conflicts;

    println!("[Rust] Sync complete: {} pulled, {} pushed, {} conflicts", total_pulled, total_pushed, total_conflicts);

    Ok(BidirectionalSyncResult {
        success: true,
        pulled: total_pulled,
        pushed: total_pushed,
        conflicts: total_conflicts,
        message: format!("Synced: {} pulled, {} pushed", total_pulled, total_pushed),
    })
}

#[tauri::command]
async fn sync_all() -> Result<BidirectionalSyncResult, String> {
    println!("[Rust] sync_all called");
    sync_all_internal().await
}

/// Get current sync status
#[tauri::command]
fn get_sync_status() -> Result<SyncStatus, String> {
    let conn = get_connection()?;

    // Check if configured (from profiles.json)
    let config = load_profile_config();
    let configured = !config.sync.server_url.is_empty() && !config.sync.api_key.is_empty();

    // Get last sync time (per-profile data)
    let last_sync_time: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'last_sync'",
            [],
            |row| row.get(0),
        )
        .ok();

    // Count pending items (never synced, locally modified after last sync, or locally deleted needing push)
    let pending_count: usize = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE (deleted_at IS NULL AND (sync_source = '' OR sync_source IS NULL OR (synced_at IS NOT NULL AND updated_at > synced_at))) OR (deleted_at IS NOT NULL AND sync_id IS NOT NULL AND sync_id != '' AND synced_at IS NOT NULL AND updated_at > synced_at)",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0) as usize;

    Ok(SyncStatus {
        configured,
        last_sync_time,
        pending_count,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // RESTORE: Check for *.restore files in Documents and copy to App Group
    restore_from_documents();

    // BACKUP: Copy App Group data to Documents for recovery via Finder File Sharing
    backup_app_group_to_documents();

    // Check for auto-sync environment variable (used by e2e tests)
    let auto_sync_on_launch = std::env::var("PEEK_AUTO_SYNC")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |_app| {
            // Eagerly initialize database on app start (runs migrations including dedup)
            // This ensures one-time migrations run even if the frontend hasn't loaded yet
            match ensure_database_initialized() {
                Ok(()) => println!("[Rust] Database initialized on startup"),
                Err(e) => println!("[Rust] WARNING: Database init on startup failed: {}", e),
            }

            if auto_sync_on_launch {
                println!("[Rust] PEEK_AUTO_SYNC enabled - triggering sync on launch");
                // Spawn async task to sync after app is ready
                tauri::async_runtime::spawn(async move {
                    // Small delay to let app UI settle before syncing
                    std::thread::sleep(std::time::Duration::from_secs(2));

                    // Check if sync is configured before attempting
                    let config = load_profile_config();
                    if config.sync.server_url.is_empty() || config.sync.api_key.is_empty() {
                        println!("[Rust] PEEK_AUTO_SYNC: Sync not configured, skipping");
                        return;
                    }

                    println!("[Rust] PEEK_AUTO_SYNC: Starting automatic sync...");
                    match sync_all_internal().await {
                        Ok(result) => {
                            println!("[Rust] PEEK_AUTO_SYNC: Sync complete - {} pulled, {} pushed",
                                result.pulled, result.pushed);
                        }
                        Err(e) => {
                            println!("[Rust] PEEK_AUTO_SYNC: Sync failed - {}", e);
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Page (URL) commands
            save_url,
            get_saved_urls,
            update_url,
            update_url_tags,
            delete_url,
            record_visit,
            open_native_webview,
            close_native_webview,
            // Text commands
            save_text,
            get_saved_texts,
            update_text,
            // Tagset commands
            save_tagset,
            get_saved_tagsets,
            update_tagset,
            // Image commands
            save_image,
            save_captured_image,
            get_saved_images,
            get_image_data,
            update_image_tags,
            // Tag commands
            get_tags_by_frecency,
            get_tags_by_frecency_for_url,
            // Device
            get_device_id_command,
            // Settings and sync
            is_dark_mode,
            get_webhook_url,
            set_webhook_url,
            get_webhook_api_key,
            set_webhook_api_key,
            get_auto_sync,
            set_auto_sync,
            get_archive_tag,
            set_archive_tag,
            sync_to_webhook,
            get_last_sync,
            auto_sync_if_needed,
            // Profile management
            get_profile_info,
            set_profile,
            create_profile,
            delete_profile,
            reset_profile_to_default,
            quit_app,
            // Bidirectional sync
            pull_from_server,
            push_to_server,
            sync_all,
            get_sync_status,
            // Legacy/deprecated
            get_shared_url,
            // Debug
            debug_list_container_files,
            debug_profiles_json,
            debug_settings_table,
            debug_query_database,
            debug_export_database,
            swap_profile_databases,
            // Inline webview
            open_inline_webview,
            close_inline_webview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};
    use chrono::Utc;
    use super::{is_valid_uuid, generate_tag_id, ProfileConfig, ProfileEntry, SyncSettings};

    /// Create the database schema for testing (unified model with sync columns)
    fn create_test_schema(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS items (
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

            CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
            CREATE INDEX IF NOT EXISTS idx_items_sync_id ON items(sync_id);

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
        )
        .expect("Failed to create test schema");
    }

    /// Save a text item with tags (core logic extracted for testing)
    fn save_text_with_tags(conn: &Connection, content: &str, tags: &[String]) -> String {
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();

        // Insert text item
        conn.execute(
            "INSERT INTO items (id, type, content, created_at, updated_at) VALUES (?, 'text', ?, ?, ?)",
            params![&id, content, &now, &now],
        )
        .expect("Failed to insert text item");

        // Add tags
        for tag_name in tags {
            let normalized = tag_name.trim().to_lowercase();
            if normalized.is_empty() {
                continue;
            }

            let tag_id: String = match conn.query_row(
                "SELECT id FROM tags WHERE name = ?",
                params![&normalized],
                |row| row.get(0),
            ) {
                Ok(existing_id) => existing_id,
                Err(_) => {
                    let new_tag_id = generate_tag_id();
                    conn.execute(
                        "INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt) VALUES (?, ?, 1, ?, 10.0, ?, ?)",
                        params![&new_tag_id, &normalized, &now, &now, &now],
                    )
                    .expect("Failed to insert tag");
                    new_tag_id
                }
            };

            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
                params![&id, tag_id, &now],
            )
            .expect("Failed to link tag");
        }

        id
    }

    /// Get tags for an item from the database
    fn get_item_tags(conn: &Connection, item_id: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT t.name FROM tags t
                 JOIN item_tags it ON t.id = it.tag_id
                 WHERE it.item_id = ?
                 ORDER BY t.name",
            )
            .expect("Failed to prepare query");

        stmt.query_map(params![item_id], |row| row.get(0))
            .expect("Failed to query tags")
            .filter_map(|r| r.ok())
            .collect()
    }

    #[test]
    fn test_save_text_with_tags() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Save a text item with tags (simulates quick-add with tag buttons)
        let tags = vec!["work".to_string(), "important".to_string()];
        let item_id = save_text_with_tags(&conn, "This is a test note", &tags);

        // Verify the item was saved
        let content: String = conn
            .query_row(
                "SELECT content FROM items WHERE id = ?",
                params![&item_id],
                |row| row.get(0),
            )
            .expect("Failed to find saved item");
        assert_eq!(content, "This is a test note");

        // Verify tags were saved and linked
        let saved_tags = get_item_tags(&conn, &item_id);
        assert_eq!(saved_tags.len(), 2, "Expected 2 tags, got {:?}", saved_tags);
        assert!(saved_tags.contains(&"work".to_string()), "Missing 'work' tag");
        assert!(saved_tags.contains(&"important".to_string()), "Missing 'important' tag");
    }

    #[test]
    fn test_save_text_with_hashtags_and_button_tags() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Simulate content with hashtags plus additional button-selected tags
        // The real save_text parses hashtags and merges with provided tags
        let content_hashtags = vec!["hashtag1".to_string()];
        let button_tags = vec!["button-tag".to_string()];
        let mut all_tags = content_hashtags;
        all_tags.extend(button_tags);

        let item_id = save_text_with_tags(&conn, "Note with #hashtag1", &all_tags);

        let saved_tags = get_item_tags(&conn, &item_id);
        assert_eq!(saved_tags.len(), 2, "Expected 2 tags (hashtag + button), got {:?}", saved_tags);
        assert!(saved_tags.contains(&"hashtag1".to_string()), "Missing hashtag");
        assert!(saved_tags.contains(&"button-tag".to_string()), "Missing button tag");
    }

    #[test]
    fn test_save_text_empty_tags() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Save without any tags
        let item_id = save_text_with_tags(&conn, "Note without tags", &[]);

        let saved_tags = get_item_tags(&conn, &item_id);
        assert!(saved_tags.is_empty(), "Expected no tags, got {:?}", saved_tags);
    }

    #[test]
    fn test_tag_normalization() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Tags should be normalized (lowercase, trimmed)
        let tags = vec!["  UPPERCASE  ".to_string(), "MixedCase".to_string()];
        let item_id = save_text_with_tags(&conn, "Test normalization", &tags);

        let saved_tags = get_item_tags(&conn, &item_id);
        assert!(saved_tags.contains(&"uppercase".to_string()), "Tag should be lowercase");
        assert!(saved_tags.contains(&"mixedcase".to_string()), "Tag should be lowercase");
    }

    // === Unified Item Type Tests ===

    /// Save a URL item (tests url type)
    fn save_url_item(conn: &Connection, url: &str) -> String {
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO items (id, type, url, created_at, updated_at) VALUES (?, 'url', ?, ?, ?)",
            params![&id, url, &now, &now],
        )
        .expect("Failed to insert url item");

        id
    }

    /// Save a tagset item (tests tagset type)
    fn save_tagset_item(conn: &Connection, tags: &[String]) -> String {
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO items (id, type, created_at, updated_at) VALUES (?, 'tagset', ?, ?)",
            params![&id, &now, &now],
        )
        .expect("Failed to insert tagset item");

        // Add tags
        for tag_name in tags {
            let normalized = tag_name.trim().to_lowercase();
            if normalized.is_empty() {
                continue;
            }

            let tag_id: String = match conn.query_row(
                "SELECT id FROM tags WHERE name = ?",
                params![&normalized],
                |row| row.get(0),
            ) {
                Ok(existing_id) => existing_id,
                Err(_) => {
                    let new_tag_id = generate_tag_id();
                    conn.execute(
                        "INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt) VALUES (?, ?, 1, ?, 10.0, ?, ?)",
                        params![&new_tag_id, &normalized, &now, &now, &now],
                    )
                    .expect("Failed to insert tag");
                    new_tag_id
                }
            };

            conn.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
                params![&id, tag_id, &now],
            )
            .expect("Failed to link tag");
        }

        id
    }

    #[test]
    fn test_unified_item_types() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Create items of each type
        let url_id = save_url_item(&conn, "https://example.com");
        let text_id = save_text_with_tags(&conn, "My note", &[]);
        let tagset_id = save_tagset_item(&conn, &["tag1".to_string(), "tag2".to_string()]);

        // Verify url type
        let url_type: String = conn
            .query_row("SELECT type FROM items WHERE id = ?", params![&url_id], |row| row.get(0))
            .expect("Failed to query url type");
        assert_eq!(url_type, "url", "URL item should have type 'url'");

        // Verify text type
        let text_type: String = conn
            .query_row("SELECT type FROM items WHERE id = ?", params![&text_id], |row| row.get(0))
            .expect("Failed to query text type");
        assert_eq!(text_type, "text", "Text item should have type 'text'");

        // Verify tagset type
        let tagset_type: String = conn
            .query_row("SELECT type FROM items WHERE id = ?", params![&tagset_id], |row| row.get(0))
            .expect("Failed to query tagset type");
        assert_eq!(tagset_type, "tagset", "Tagset item should have type 'tagset'");
    }

    #[test]
    fn test_sync_columns_exist() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Verify sync columns exist by inserting an item with sync values
        let now = Utc::now().to_rfc3339();
        let id = uuid::Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO items (id, type, url, sync_id, sync_source, synced_at, created_at, updated_at) VALUES (?, 'url', ?, ?, ?, ?, ?, ?)",
            params![&id, "https://sync-test.com", "remote-123", "server", &now, &now, &now],
        )
        .expect("Failed to insert item with sync columns");

        // Retrieve and verify
        let (sync_id, sync_source, synced_at): (String, String, String) = conn
            .query_row(
                "SELECT sync_id, sync_source, synced_at FROM items WHERE id = ?",
                params![&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("Failed to query sync columns");

        assert_eq!(sync_id, "remote-123", "sync_id should be saved");
        assert_eq!(sync_source, "server", "sync_source should be saved");
        assert_eq!(synced_at, now, "synced_at should be saved");
    }

    #[test]
    fn test_sync_id_index() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Verify the sync_id index exists
        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_items_sync_id'",
                [],
                |row| row.get(0),
            )
            .expect("Failed to query index");

        assert_eq!(index_count, 1, "idx_items_sync_id index should exist");
    }

    #[test]
    fn test_filter_items_by_type() {
        let conn = Connection::open_in_memory().expect("Failed to create in-memory database");
        create_test_schema(&conn);

        // Create items of different types
        save_url_item(&conn, "https://example1.com");
        save_url_item(&conn, "https://example2.com");
        save_text_with_tags(&conn, "Note 1", &[]);
        save_tagset_item(&conn, &["tag".to_string()]);

        // Count by type
        let url_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE type = 'url'", [], |row| row.get(0))
            .expect("Failed to count urls");
        let text_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE type = 'text'", [], |row| row.get(0))
            .expect("Failed to count texts");
        let tagset_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM items WHERE type = 'tagset'", [], |row| row.get(0))
            .expect("Failed to count tagsets");

        assert_eq!(url_count, 2, "Should have 2 url items");
        assert_eq!(text_count, 1, "Should have 1 text item");
        assert_eq!(tagset_count, 1, "Should have 1 tagset item");
    }

    // ========================================================================
    // Profile Management Tests
    // ========================================================================

    #[test]
    fn test_is_valid_uuid_accepts_valid_uuids() {
        // Standard UUID v4 format
        assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_valid_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8"));
        assert!(is_valid_uuid("f47ac10b-58cc-4372-a567-0e02b2c3d479"));

        // All lowercase hex
        assert!(is_valid_uuid("abcdef01-2345-6789-abcd-ef0123456789"));

        // All uppercase hex (should also be valid)
        assert!(is_valid_uuid("ABCDEF01-2345-6789-ABCD-EF0123456789"));

        // Mixed case
        assert!(is_valid_uuid("AbCdEf01-2345-6789-aBcD-eF0123456789"));
    }

    #[test]
    fn test_is_valid_uuid_rejects_invalid_strings() {
        // Literal string "default" - the main case we're protecting against
        assert!(!is_valid_uuid("default"));

        // Empty string
        assert!(!is_valid_uuid(""));

        // Too short
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716"));

        // Too long
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-446655440000-extra"));

        // Wrong segment lengths (should be 8-4-4-4-12)
        assert!(!is_valid_uuid("550e840-e29b-41d4-a716-446655440000"));  // first segment too short
        assert!(!is_valid_uuid("550e8400-e29-41d4-a716-446655440000")); // second segment too short
        assert!(!is_valid_uuid("550e8400-e29b-41d-a716-446655440000")); // third segment too short
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a71-446655440000")); // fourth segment too short
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000"));  // fifth segment too short

        // Wrong number of segments
        assert!(!is_valid_uuid("550e8400-e29b-41d4-446655440000"));     // only 4 segments
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-4466-440000")); // 6 segments

        // Non-hex characters
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000g")); // 'g' is not hex
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000!")); // special char
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-4466554 0000")); // space

        // No hyphens
        assert!(!is_valid_uuid("550e8400e29b41d4a716446655440000"));

        // Wrong delimiters
        assert!(!is_valid_uuid("550e8400_e29b_41d4_a716_446655440000"));
        assert!(!is_valid_uuid("550e8400:e29b:41d4:a716:446655440000"));

        // Profile slug names (what we're protecting against)
        assert!(!is_valid_uuid("personal"));
        assert!(!is_valid_uuid("work"));
        assert!(!is_valid_uuid("test-profile"));
    }

    #[test]
    fn test_profile_config_serialization() {
        let config = ProfileConfig {
            current_profile_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            profiles: vec![
                ProfileEntry {
                    id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
                    name: "Personal".to_string(),
                    created_at: "2024-01-01T00:00:00Z".to_string(),
                    last_used_at: "2024-01-01T00:00:00Z".to_string(),
                    server_profile_id: None,
                },
            ],
            sync: SyncSettings::default(),
            archive_tag: "archive".to_string(),
        };

        // Serialize to JSON
        let json = serde_json::to_string(&config).expect("Failed to serialize config");

        // Verify key fields are present
        assert!(json.contains("currentProfileId"), "JSON should use camelCase for currentProfileId");
        assert!(json.contains("550e8400-e29b-41d4-a716-446655440000"));
        assert!(json.contains("Personal"));

        // Deserialize back
        let parsed: ProfileConfig = serde_json::from_str(&json).expect("Failed to deserialize config");
        assert_eq!(parsed.current_profile_id, config.current_profile_id);
        assert_eq!(parsed.profiles.len(), 1);
        assert_eq!(parsed.profiles[0].name, "Personal");
    }

    #[test]
    fn test_profile_config_with_empty_profiles() {
        let json = r#"{
            "currentProfileId": "some-invalid-id",
            "profiles": [],
            "sync": {}
        }"#;

        let config: ProfileConfig = serde_json::from_str(json).expect("Failed to parse config");

        // Should parse, but currentProfileId is invalid and profiles is empty
        assert_eq!(config.current_profile_id, "some-invalid-id");
        assert!(config.profiles.is_empty());

        // Validation should fail for this profile ID
        assert!(!is_valid_uuid(&config.current_profile_id));
    }

    #[test]
    fn test_profile_config_missing_current_profile_in_list() {
        // Config where currentProfileId doesn't match any profile in the list
        let json = r#"{
            "currentProfileId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "profiles": [
                {
                    "id": "11111111-2222-3333-4444-555555555555",
                    "name": "Profile A",
                    "createdAt": "2024-01-01T00:00:00Z",
                    "lastUsedAt": "2024-01-01T00:00:00Z"
                }
            ],
            "sync": {}
        }"#;

        let config: ProfileConfig = serde_json::from_str(json).expect("Failed to parse config");

        // currentProfileId is a valid UUID but doesn't exist in profiles
        assert!(is_valid_uuid(&config.current_profile_id));
        assert!(!config.profiles.iter().any(|p| p.id == config.current_profile_id));

        // In get_db_path(), this should fall back to the first profile
        assert_eq!(config.profiles[0].id, "11111111-2222-3333-4444-555555555555");
    }

    #[test]
    fn test_generate_tag_id_format() {
        // Generate several IDs and verify format
        for _ in 0..10 {
            let tag_id = generate_tag_id();

            // Should start with "tag_"
            assert!(tag_id.starts_with("tag_"), "Tag ID should start with 'tag_': {}", tag_id);

            // Should have format: tag_{timestamp}_{random9}
            let parts: Vec<&str> = tag_id.split('_').collect();
            assert_eq!(parts.len(), 3, "Tag ID should have 3 parts: {}", tag_id);
            assert_eq!(parts[0], "tag");

            // Timestamp part should be numeric
            assert!(parts[1].chars().all(|c: char| c.is_ascii_digit()),
                "Timestamp should be numeric: {}", parts[1]);

            // Random part should be 9 chars
            assert_eq!(parts[2].len(), 9, "Random part should be 9 chars: {}", parts[2]);
        }
    }

    #[test]
    fn test_generate_tag_id_uniqueness() {
        use std::collections::HashSet;

        // Generate 100 IDs and verify they're all unique
        let mut ids: HashSet<String> = HashSet::new();
        for _ in 0..100 {
            let id = generate_tag_id();
            assert!(ids.insert(id.clone()), "Duplicate tag ID generated: {}", id);
        }

        assert_eq!(ids.len(), 100, "Should have 100 unique IDs");
    }

    #[test]
    fn test_sync_settings_default() {
        let settings = SyncSettings::default();

        assert!(settings.server_url.is_empty());
        assert!(settings.api_key.is_empty());
        assert!(!settings.auto_sync);
    }

    #[test]
    fn test_profile_entry_optional_fields() {
        // Profile with only required fields
        let json = r#"{
            "id": "11111111-2222-3333-4444-555555555555",
            "name": "Minimal Profile",
            "createdAt": "2024-01-01T00:00:00Z",
            "lastUsedAt": "2024-01-01T00:00:00Z"
        }"#;

        let profile: ProfileEntry = serde_json::from_str(json).expect("Failed to parse profile");

        assert_eq!(profile.id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(profile.name, "Minimal Profile");
        assert!(profile.server_profile_id.is_none());
    }

    #[test]
    fn test_profile_entry_with_server_profile() {
        // Profile with server profile ID configured
        let json = r#"{
            "id": "11111111-2222-3333-4444-555555555555",
            "name": "Synced Profile",
            "createdAt": "2024-01-01T00:00:00Z",
            "lastUsedAt": "2024-01-01T00:00:00Z",
            "server_profile_id": "remote-profile-uuid"
        }"#;

        let profile: ProfileEntry = serde_json::from_str(json).expect("Failed to parse profile");

        assert_eq!(profile.id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(profile.name, "Synced Profile");
        assert_eq!(profile.server_profile_id, Some("remote-profile-uuid".to_string()));
    }

    #[test]
    fn test_sync_settings_with_values() {
        // Full sync settings
        let json = r#"{
            "server_url": "https://sync.example.com",
            "api_key": "secret-key-123",
            "auto_sync": true
        }"#;

        let settings: SyncSettings = serde_json::from_str(json).expect("Failed to parse settings");

        assert_eq!(settings.server_url, "https://sync.example.com");
        assert_eq!(settings.api_key, "secret-key-123");
        assert!(settings.auto_sync);
    }
}
