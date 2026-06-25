use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "ios")]
use std::ffi::CStr;
#[cfg(target_os = "ios")]
use std::os::raw::c_char;
use std::path::PathBuf;
use std::fs;
use std::sync::RwLock;
use reqwest;
use regex::Regex;
use tauri::Manager;

use peek_core::{PeekStore, SavedUrl, SavedText, SavedTagset, SavedImage, TagStats, ServerItemsResponse, ServerCreateResponse, SyncStatus, QueryItemsArgs, ItemRow, Cursor};

/// Global PeekStore instance. Uses RwLock to support re-init on profile switch.
static STORE: RwLock<Option<std::sync::Arc<PeekStore>>> = RwLock::new(None);

/// Get the global PeekStore, initializing it if needed.
fn get_store() -> Result<std::sync::Arc<PeekStore>, String> {
    // Fast path: already initialized
    {
        let read = STORE.read().map_err(|e| format!("Lock error: {}", e))?;
        if let Some(ref store) = *read {
            return Ok(store.clone());
        }
    }
    // Slow path: initialize
    let mut write = STORE.write().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(ref store) = *write {
        return Ok(store.clone());
    }
    let db_path = get_db_path().ok_or("Failed to get database path")?;
    let store = std::sync::Arc::new(PeekStore::new(db_path.to_str().ok_or("Invalid database path")?)?);
    *write = Some(store.clone());
    Ok(store)
}

// Simple logging - println! works in debug builds and Xcode console
fn ios_log(msg: &str) {
    println!("[Peek] {}", msg);
}

/// Sanitize reader-mode HTML: strip <style> tags, style/class attributes, script-related content.
/// Readability.js normally strips these, but this is a safety net for the Rust port.
fn sanitize_reader_html(html: &str) -> String {
    // Strip <style>...</style> tags (including multiline)
    let re_style = Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
    let result = re_style.replace_all(html, "");

    // Strip <script>...</script> tags
    let re_script = Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
    let result = re_script.replace_all(&result, "");

    // Strip <noscript>...</noscript> tags
    let re_noscript = Regex::new(r"(?is)<noscript[^>]*>.*?</noscript>").unwrap();
    let result = re_noscript.replace_all(&result, "");

    // Strip style="" attributes
    let re_style_attr = Regex::new(r#"(?i)\s+style\s*=\s*"[^"]*""#).unwrap();
    let result = re_style_attr.replace_all(&result, "");
    let re_style_attr2 = Regex::new(r#"(?i)\s+style\s*=\s*'[^']*'"#).unwrap();
    let result = re_style_attr2.replace_all(&result, "");

    // Strip class="" attributes
    let re_class_attr = Regex::new(r#"(?i)\s+class\s*=\s*"[^"]*""#).unwrap();
    let result = re_class_attr.replace_all(&result, "");
    let re_class_attr2 = Regex::new(r#"(?i)\s+class\s*=\s*'[^']*'"#).unwrap();
    let result = re_class_attr2.replace_all(&result, "");

    // Strip event handler attributes (onclick, onerror, onload, etc.)
    let re_events = Regex::new(r#"(?i)\s+on\w+\s*=\s*"[^"]*""#).unwrap();
    let result = re_events.replace_all(&result, "");
    let re_events2 = Regex::new(r#"(?i)\s+on\w+\s*=\s*'[^']*'"#).unwrap();
    let result = re_events2.replace_all(&result, "");

    result.into_owned()
}

// FFI declarations for native webview on iOS
// These symbols are provided by Swift code (WebviewPlugin.swift) at Xcode link time.
#[cfg(target_os = "ios")]
extern "C" {
    fn webview_plugin_open(url: *const std::ffi::c_char, item_id: *const std::ffi::c_char) -> bool;
    fn webview_plugin_close();
    fn webview_plugin_open_inline(url: *const std::ffi::c_char, top_offset: f64, item_id: *const std::ffi::c_char) -> bool;
    fn webview_plugin_open_inline_html(html: *const std::ffi::c_char, top_offset: f64, base_url: *const std::ffi::c_char) -> bool;
    fn webview_plugin_close_inline();
}

/// FFI function called by Swift when the user navigates to a new URL in the webview.
/// Creates or finds a URL item, tags it with from:history, and records a visit.
/// Returns the item ID as a C string (caller must free with track_navigation_free).
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn track_webview_navigation(url_ptr: *const c_char, source_item_id_ptr: *const c_char) -> *mut c_char {
    let url = unsafe { CStr::from_ptr(url_ptr) }.to_string_lossy().to_string();
    let source_item_id = unsafe { CStr::from_ptr(source_item_id_ptr) }.to_string_lossy().to_string();

    println!("[Rust] track_webview_navigation called: url={}, source_item_id={}", url, source_item_id);

    let result = match track_navigation_inner(&url, &source_item_id) {
        Ok(item_id) => item_id,
        Err(e) => {
            println!("[Rust] track_webview_navigation error: {}", e);
            String::new()
        }
    };

    std::ffi::CString::new(result).unwrap_or_default().into_raw()
}

/// Free the C string returned by track_webview_navigation
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn track_navigation_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { let _ = std::ffi::CString::from_raw(ptr); }
    }
}

/// Inner implementation for track_navigation — delegates to PeekStore
fn track_navigation_inner(url: &str, _source_item_id: &str) -> Result<String, String> {
    let store = get_store()?;
    store.track_navigation(url)
}

// Types imported from peek_core: SavedUrl, SavedText, SavedTagset, SavedImage, TagStats,
// ServerItem, ServerItemsResponse, ServerCreateResponse, SyncStatus, PushItem,
// DATASTORE_VERSION, PROTOCOL_VERSION, WebhookPayload, SyncResult, BidirectionalSyncResult
use peek_core::{WebhookPayload, SyncResult, BidirectionalSyncResult, DATASTORE_VERSION, PROTOCOL_VERSION};

// App Group bridge - just need the container path now
#[cfg(target_os = "ios")]
extern "C" {
    fn get_app_group_container_path() -> *const c_char;
    fn get_documents_path() -> *const c_char;
    fn get_icloud_documents_path() -> *const c_char;
    fn get_system_is_dark_mode() -> i32;
    fn is_app_store_build() -> i32;
}

/// Check if this is an App Store/TestFlight build (has receipt) vs Xcode install
#[cfg(target_os = "ios")]
fn is_production_build() -> bool {
    unsafe { is_app_store_build() == 1 }
}

#[cfg(not(target_os = "ios"))]
fn is_production_build() -> bool {
    false
}

// ============================================================================
// Profile Management System
// ============================================================================

fn default_sync_interval_minutes() -> u32 {
    30
}

/// Sync configuration (shared across all profiles)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SyncSettings {
    #[serde(default)]
    server_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    auto_sync: bool,
    #[serde(default = "default_sync_interval_minutes")]
    sync_interval_minutes: u32,
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
    #[serde(default = "default_todo_tag")]
    todo_tag: String,
    #[serde(default = "default_done_tag")]
    done_tag: String,
    #[serde(default = "default_readme_tag")]
    readme_tag: String,
    #[serde(default = "default_read_tag")]
    read_tag: String,
    #[serde(default = "default_offline_tag")]
    offline_tag: String,
}

fn default_archive_tag() -> String {
    "archive".to_string()
}

fn default_todo_tag() -> String {
    "todo".to_string()
}

fn default_done_tag() -> String {
    "done".to_string()
}

fn default_readme_tag() -> String {
    "readme".to_string()
}

fn default_read_tag() -> String {
    "read".to_string()
}

fn default_offline_tag() -> String {
    "offline".to_string()
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
#[cfg(target_os = "ios")]
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

#[cfg(not(target_os = "ios"))]
fn get_container_path() -> Option<PathBuf> {
    // On Android, use the app's files directory via HOME env or a reasonable default
    let base = std::env::var("HOME")
        .unwrap_or_else(|_| "/data/data/com.dietrich.peek_mobile/files".to_string());
    let path = PathBuf::from(base).join(".peek");
    if let Err(e) = std::fs::create_dir_all(&path) {
        println!("[Rust] Failed to create container dir: {}", e);
    }
    Some(path)
}

/// Get the Documents directory path (visible in Finder via File Sharing)
#[cfg(target_os = "ios")]
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

#[cfg(not(target_os = "ios"))]
fn get_docs_path() -> Option<PathBuf> {
    None
}

/// Get the iCloud Documents directory path (synced across devices)
/// Returns None if iCloud is not available (user not signed in or capability not enabled)
#[cfg(target_os = "ios")]
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

#[cfg(not(target_os = "ios"))]
fn get_icloud_path() -> Option<PathBuf> {
    None
}

/// Restore data from Documents folder to App Group container
/// Drag files named *.restore via Finder, app will restore on next launch
/// e.g., profiles.json.restore -> profiles.json in App Group
#[cfg(target_os = "ios")]
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
#[cfg(target_os = "ios")]
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
        todo_tag: default_todo_tag(),
        done_tag: default_done_tag(),
        readme_tag: default_readme_tag(),
        read_tag: default_read_tag(),
        offline_tag: default_offline_tag(),
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
                        sync_interval_minutes: 30,
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
                                sync_interval_minutes: 30,
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
                            sync_interval_minutes: 30,
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
        todo_tag: default_todo_tag(),
        done_tag: default_done_tag(),
        readme_tag: default_readme_tag(),
        read_tag: default_read_tag(),
        offline_tag: default_offline_tag(),
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

/// The server bucket the current profile syncs to: its `server_profile_id`, or the
/// local profile UUID as a pre-registration fallback. Mirrors the id that
/// `append_profile_to_url` puts on the wire, so per-bucket sync state lines up with
/// where items actually land.
fn current_target_profile_id() -> String {
    let config = load_profile_config();
    config
        .profiles
        .iter()
        .find(|p| p.id == config.current_profile_id)
        .and_then(|p| p.server_profile_id.clone())
        .unwrap_or_else(|| config.current_profile_id.clone())
}

/// Whether the current profile is the PRIMARY (first / "Default") one. That profile
/// is bound to the pre-existing server "default" bucket (see
/// ensure_profiles_registered), so its legacy sync history is trustworthy and gets
/// healed in place; non-primary profiles are left to re-push to their own buckets.
fn current_profile_is_primary() -> bool {
    let config = load_profile_config();
    config
        .profiles
        .first()
        .map(|p| p.id == config.current_profile_id)
        .unwrap_or(false)
}

/// One-time heal of legacy rows that predate the synced_profile_id column. Runs only
/// for the primary profile (its items really were synced to the default bucket), so
/// it stamps their bucket instead of forcing a full re-push. Cheap + idempotent:
/// after the first run there are no NULL synced rows left to touch.
fn heal_synced_profile_ids(store: &PeekStore) {
    if !current_profile_is_primary() {
        return;
    }
    let target = current_target_profile_id();
    match store.backfill_synced_profile_id(&target) {
        Ok(n) if n > 0 => println!(
            "[Rust] Healed synced_profile_id for {} legacy primary-profile items -> {}",
            n, target
        ),
        Ok(_) => {}
        Err(e) => println!("[Rust] synced_profile_id heal failed (non-fatal): {}", e),
    }
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

// ensure_database_initialized() moved to peek-core::schema

// get_device_id, inject_sync_metadata_for_save, inject_sync_metadata_for_update
// moved to peek-core::helpers (Phase 2). Sync code will use PeekStore in Phase 3.

#[tauri::command]
async fn get_device_id_command() -> Result<String, String> {
    let store = get_store()?;
    Ok(store.device_id().to_string())
}

// get_connection, calculate_frecency, generate_tag_id moved to peek-core

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
    // Data-leak fix: never send a `?profile=` request before the local profile is
    // bound to a distinct server profile. On failure, ABORT this push (don't fall
    // back to the local UUID). Fire-and-forget, so we just log and return.
    if let Err(e) = ensure_profiles_registered().await {
        println!("[Rust] Skipping webhook push (profile registration failed): {}", e);
        return;
    }

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
    // Data-leak fix: see push_url_to_webhook. Abort on registration failure.
    if let Err(e) = ensure_profiles_registered().await {
        println!("[Rust] Skipping webhook push (profile registration failed): {}", e);
        return;
    }

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
    // Data-leak fix: see push_url_to_webhook. Abort on registration failure.
    if let Err(e) = ensure_profiles_registered().await {
        println!("[Rust] Skipping webhook push (profile registration failed): {}", e);
        return;
    }

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
    let container_path = get_container_path()
        .ok_or_else(|| "Failed to get container path".to_string())?;

    let mut files = Vec::new();
    files.push(format!("Container: {}", container_path.display()));

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

// normalize_url moved to peek-core::helpers

#[tauri::command]
async fn save_url(url: String, tags: Vec<String>, metadata: Option<serde_json::Value>) -> Result<(), String> {
    println!("[Rust] save_url called with url: {}, tags: {:?}", url, tags);

    let store = get_store()?;
    let result = store.save_url(&url, &tags, metadata)?;

    println!("[Rust] Page saved successfully");

    // Handle offline tag — fetch content if the offline tag was included
    let config = load_profile_config();
    if tags.contains(&config.offline_tag) {
        let item_id = result.item_id.clone();
        let fetch_url = url.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = fetch_and_store_offline_content(&item_id, &fetch_url).await {
                println!("[Rust] Failed to fetch offline content: {}", e);
            }
        });
    }

    // Trigger auto-sync if enabled (fire and forget)
    tauri::async_runtime::spawn(async move {
        trigger_auto_sync_if_enabled().await;
    });

    Ok(())
}

// extract_domain moved to peek-core::helpers

#[tauri::command]
async fn get_tags_by_frecency() -> Result<Vec<TagStats>, String> {
    let store = get_store()?;
    store.get_tags_by_frecency()
}

/// Get tags sorted by frecency with domain affinity boost
#[tauri::command]
async fn get_tags_by_frecency_for_url(url: String) -> Result<Vec<TagStats>, String> {
    let store = get_store()?;
    store.get_tags_by_frecency_for_url(&url)
}

/// Get saved pages (URLs)
#[tauri::command]
async fn get_saved_urls() -> Result<Vec<SavedUrl>, String> {
    let store = get_store()?;
    store.get_saved_urls()
}

/// Paginated, SQL-side filtered/sorted query over items.
///
/// Frontend invokes with camelCase keys (Tauri converts to snake_case params):
///   invoke('query_items', {
///     search, tags, itemType, archiveTag, autoHideTags, sort, cursor, limit
///   })
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn query_items(
    search: Option<String>,
    tags: Vec<String>,
    item_type: Option<String>,
    archive_tag: String,
    auto_hide_tags: Vec<String>,
    sort: String,
    cursor: Option<Cursor>,
    limit: u32,
) -> Result<Vec<ItemRow>, String> {
    let store = get_store()?;
    store.query_items(QueryItemsArgs {
        search,
        tags,
        item_type,
        archive_tag,
        auto_hide_tags,
        sort,
        cursor,
        limit,
    })
}

/// Delete any item by ID (works for pages, texts, tagsets, images)
#[tauri::command]
async fn delete_url(id: String) -> Result<(), String> {
    println!("[Rust] delete_url/delete_item called for id: {}", id);
    let store = get_store()?;
    store.delete_item(&id)?;
    println!("[Rust] Item soft-deleted successfully");
    Ok(())
}

/// Record a visit to an item (URL opened in browser or webview)
#[tauri::command]
async fn record_visit(item_id: String, source: String, window_type: String) -> Result<String, String> {
    println!("[Rust] record_visit called for item_id: {}, source: {}, window_type: {}", item_id, source, window_type);
    let store = get_store()?;
    let visit_id = store.record_visit(&item_id, &source, &window_type)?;
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
async fn open_inline_webview(url: String, top_offset: f64, item_id: Option<String>) -> Result<(), String> {
    println!("[Rust] open_inline_webview called for url: {}, top_offset: {}, item_id: {:?}", url, top_offset, item_id);

    #[cfg(target_os = "ios")]
    {
        use std::ffi::CString;
        let url_cstr = CString::new(url.as_str()).map_err(|e| format!("Invalid URL string: {}", e))?;
        let item_id_str = item_id.unwrap_or_default();
        let item_id_cstr = CString::new(item_id_str.as_str()).map_err(|e| format!("Invalid item_id string: {}", e))?;

        let result = unsafe { webview_plugin_open_inline(url_cstr.as_ptr(), top_offset, item_id_cstr.as_ptr()) };
        if result {
            Ok(())
        } else {
            Err("Failed to open inline webview".to_string())
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (url, top_offset, item_id);
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

/// Open offline reader-mode HTML in inline native WKWebView
#[tauri::command]
async fn open_inline_webview_html(item_id: String, top_offset: f64) -> Result<(), String> {
    println!("[Rust] open_inline_webview_html called for item_id: {}, top_offset: {}", item_id, top_offset);

    // Look up the original URL for this item (needed for resolving relative image/link URLs)
    let store = get_store()?;
    let original_url = store.get_item_url(&item_id)?;

    // Read the offline content and metadata
    let container = get_container_path()
        .ok_or_else(|| "No container path".to_string())?;
    let offline_dir = container.join("offline").join(&item_id);
    let content_path = offline_dir.join("content.html");
    if !content_path.exists() {
        return Err("No offline content available".to_string());
    }
    let html = fs::read_to_string(&content_path)
        .map_err(|e| format!("Failed to read offline content: {}", e))?;

    // Load article metadata if available
    let meta_path = offline_dir.join("meta.json");
    let meta: serde_json::Value = if meta_path.exists() {
        let meta_str = fs::read_to_string(&meta_path).unwrap_or_default();
        serde_json::from_str(&meta_str).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let title = meta["title"].as_str().unwrap_or("");
    let byline = meta["byline"].as_str().unwrap_or("");
    let dir = meta["dir"].as_str().unwrap_or("");

    // Extract domain from URL for header
    let domain = original_url.as_ref()
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // Build <base> tag so relative image/link URLs resolve against the original page
    let base_tag = if let Some(ref url) = original_url {
        format!(r#"<base href="{}">"#, url.replace('"', "&quot;"))
    } else {
        String::new()
    };

    // Dir attribute for RTL support
    let dir_attr = if !dir.is_empty() {
        format!(r#" dir="{}""#, dir)
    } else {
        String::new()
    };

    // Build header section
    let header_html = if !title.is_empty() || !domain.is_empty() {
        let domain_link = if let Some(ref url) = original_url {
            format!(r#"<a class="domain" href="{}">{}</a>"#, url.replace('"', "&quot;"), domain)
        } else {
            String::new()
        };
        let byline_html = if !byline.is_empty() {
            format!(r#"<div class="credits">{}</div>"#, byline)
        } else {
            String::new()
        };
        format!(r#"<div class="header">{}<h1>{}</h1>{}</div>"#,
            domain_link, title, byline_html)
    } else {
        String::new()
    };

    // Load reader CSS: check container/offline/reader.css first (user-editable),
    // fall back to compiled-in default from src/reader.css
    let reader_css = {
        let default_css = include_str!("../../src/reader.css");
        if let Some(ref container) = Some(container.clone()) {
            let custom_css_path = container.join("offline").join("reader.css");
            if custom_css_path.exists() {
                fs::read_to_string(&custom_css_path).unwrap_or_else(|_| default_css.to_string())
            } else {
                // Write default CSS to container so it can be edited without recompiling
                let offline_dir = container.join("offline");
                let _ = fs::create_dir_all(&offline_dir);
                let _ = fs::write(&custom_css_path, default_css);
                default_css.to_string()
            }
        } else {
            default_css.to_string()
        }
    };

    // Build reader mode HTML with external-ish CSS
    let styled_html = format!(r#"<!DOCTYPE html>
<html{dir_attr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
{base_tag}
<style>
{reader_css}
</style>
</head>
<body>
<div class="container">
{header_html}
<div class="reader-content">
{html}
</div>
</div>
</body>
</html>"#,
    dir_attr = dir_attr,
    base_tag = base_tag,
    reader_css = reader_css,
    header_html = header_html,
    html = html);

    #[cfg(target_os = "ios")]
    {
        use std::ffi::CString;
        let html_cstr = CString::new(styled_html).map_err(|e| format!("Invalid HTML content: {}", e))?;
        let base_url_str = original_url.unwrap_or_default();
        let base_url_cstr = CString::new(base_url_str.as_str()).map_err(|e| format!("Invalid base URL: {}", e))?;
        let result = unsafe { webview_plugin_open_inline_html(html_cstr.as_ptr(), top_offset, base_url_cstr.as_ptr()) };
        if result {
            Ok(())
        } else {
            Err("Failed to open inline HTML webview".to_string())
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (item_id, top_offset, styled_html);
        Ok(())
    }
}

/// Update a page (URL) item
#[tauri::command]
async fn update_url(id: String, url: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_url called for id: {}, url: {}, tags: {:?}", id, url, tags);

    let store = get_store()?;
    let changes = store.update_url(&id, &url, &tags)?;

    println!("[Rust] Page updated successfully");

    // Push to webhook (fire and forget)
    let saved_url = SavedUrl {
        id: id.clone(),
        url: url.clone(),
        tags: tags.clone(),
        saved_at: Utc::now().to_rfc3339(),
        metadata: None,
    };
    tauri::async_runtime::spawn(async move {
        push_url_to_webhook(saved_url).await;
    });

    // Handle offline tag changes
    let config = load_profile_config();
    let offline_tag_name = config.offline_tag;

    if changes.tags_added.contains(&offline_tag_name) {
        let item_id = id.clone();
        let fetch_url = url.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = fetch_and_store_offline_content(&item_id, &fetch_url).await {
                println!("[Rust] Failed to fetch offline content: {}", e);
            }
        });
    } else if changes.tags_removed.contains(&offline_tag_name) {
        let _ = remove_offline_content(&id);
    }

    Ok(())
}

/// Update tags for any item type
#[tauri::command]
async fn update_url_tags(id: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_url_tags called for id: {}, tags: {:?}", id, tags);

    let store = get_store()?;
    let result = store.update_item_tags(&id, &tags)?;

    println!("[Rust] Item tags updated successfully");

    // Push to webhook (fire and forget) - only for page types
    if result.item_type == "page" {
        if let Some(ref url) = result.url {
            let saved_url = SavedUrl {
                id: id.clone(),
                url: url.clone(),
                tags: tags.clone(),
                saved_at: Utc::now().to_rfc3339(),
                metadata: None,
            };
            tauri::async_runtime::spawn(async move {
                push_url_to_webhook(saved_url).await;
            });
        }
    }

    // Handle offline tag changes
    let config = load_profile_config();
    let offline_tag = config.offline_tag;

    if result.tag_changes.tags_added.contains(&offline_tag) {
        if let Some(url) = result.url {
            let item_id = id.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = fetch_and_store_offline_content(&item_id, &url).await {
                    println!("[Rust] Failed to fetch offline content: {}", e);
                }
            });
        }
    } else if result.tag_changes.tags_removed.contains(&offline_tag) {
        let _ = remove_offline_content(&id);
    }

    Ok(())
}

/// Save a text item with hashtags auto-parsed as tags
#[tauri::command]
async fn save_text(content: String, tags: Option<Vec<String>>, metadata: Option<serde_json::Value>) -> Result<(), String> {
    println!("[Rust] save_text called with content: {}", &content[..content.len().min(50)]);

    let store = get_store()?;
    let tag_slice = tags.as_deref();
    store.save_text(&content, tag_slice, metadata)?;

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

    let store = get_store()?;
    store.save_tagset(&tags, metadata)?;

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
    let store = get_store()?;
    store.get_saved_texts()
}

/// Get all saved tagsets
#[tauri::command]
async fn get_saved_tagsets() -> Result<Vec<SavedTagset>, String> {
    let store = get_store()?;
    store.get_saved_tagsets()
}

/// Update a text item
#[tauri::command]
async fn update_text(id: String, content: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_text called for id: {}, tags: {:?}", id, tags);

    let store = get_store()?;
    let final_tags = store.update_text(&id, &content, &tags)?;

    println!("[Rust] Text updated successfully");

    // Push to webhook
    let saved_text = SavedText {
        id,
        content,
        tags: final_tags,
        saved_at: Utc::now().to_rfc3339(),
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

    let store = get_store()?;
    store.update_tagset(&id, &tags)?;

    println!("[Rust] Tagset updated successfully");

    // Push to webhook
    let saved_tagset = SavedTagset {
        id,
        tags,
        saved_at: Utc::now().to_rfc3339(),
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

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let image_bytes = STANDARD.decode(&image_data)
        .map_err(|e| format!("Failed to decode image data: {}", e))?;
    let thumbnail_bytes: Option<Vec<u8>> = thumbnail_data
        .map(|t| STANDARD.decode(&t))
        .transpose()
        .map_err(|e| format!("Failed to decode thumbnail: {}", e))?;

    let store = get_store()?;
    let item_id = store.save_image(
        &image_bytes, &mime_type, &tags, metadata,
        thumbnail_bytes.as_deref(), width, height,
    )?;

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
    let store = get_store()?;
    store.get_saved_images()
}

/// Get full image data by item ID (returns base64-encoded image)
#[tauri::command]
async fn get_image_data(id: String) -> Result<Option<String>, String> {
    let store = get_store()?;
    store.get_image_data(&id)
}

/// Save a captured image from camera (simplified interface)
#[tauri::command]
async fn save_captured_image(
    image_data: String,
    mime_type: String,
    tags: Vec<String>,
) -> Result<String, String> {
    println!("[Rust] save_captured_image called, mime_type: {}, tags: {:?}", mime_type, tags);
    save_image(image_data.clone(), mime_type, tags, None, Some(image_data), None, None).await
}

/// Update image tags
#[tauri::command]
async fn update_image_tags(id: String, tags: Vec<String>) -> Result<(), String> {
    println!("[Rust] update_image_tags called for id: {}, tags: {:?}", id, tags);
    let store = get_store()?;
    store.update_image_tags(&id, &tags)?;
    println!("[Rust] Image tags updated successfully");
    Ok(())
}

#[tauri::command]
fn is_dark_mode() -> bool {
    #[cfg(target_os = "ios")]
    {
        unsafe { get_system_is_dark_mode() != 0 }
    }
    #[cfg(target_os = "linux")]
    {
        // GNOME/Phosh: org.gnome.desktop.interface color-scheme is the
        // canonical signal. Value is 'default' | 'prefer-dark' | 'prefer-light'.
        std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "color-scheme"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("prefer-dark"))
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "ios", target_os = "linux")))]
    {
        false
    }
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
fn get_sync_interval() -> Result<u32, String> {
    let config = load_profile_config();
    let minutes = config.sync.sync_interval_minutes;
    Ok(if minutes == 0 { 30 } else { minutes })
}

#[tauri::command]
fn set_sync_interval(minutes: u32) -> Result<(), String> {
    let mut config = load_profile_config();
    config.sync.sync_interval_minutes = if minutes == 0 { 30 } else { minutes };
    if !save_profile_config(&config) {
        return Err("Failed to save sync interval setting".to_string());
    }
    println!("[Rust] Sync interval set to: {} minutes", minutes);
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

#[tauri::command]
fn get_todo_tags() -> Result<(String, String), String> {
    let config = load_profile_config();
    Ok((config.todo_tag, config.done_tag))
}

#[tauri::command]
fn set_todo_tags(todo_tag: String, done_tag: String) -> Result<(), String> {
    let mut config = load_profile_config();
    config.todo_tag = todo_tag;
    config.done_tag = done_tag;
    if !save_profile_config(&config) {
        return Err("Failed to save todo tags".to_string());
    }
    Ok(())
}

#[tauri::command]
fn get_reading_tags() -> Result<(String, String), String> {
    let config = load_profile_config();
    Ok((config.readme_tag, config.read_tag))
}

#[tauri::command]
fn set_reading_tags(readme_tag: String, read_tag: String) -> Result<(), String> {
    let mut config = load_profile_config();
    config.readme_tag = readme_tag;
    config.read_tag = read_tag;
    if !save_profile_config(&config) {
        return Err("Failed to save reading tags".to_string());
    }
    Ok(())
}

#[tauri::command]
fn get_offline_tag() -> Result<String, String> {
    let config = load_profile_config();
    Ok(config.offline_tag)
}

#[tauri::command]
fn set_offline_tag(tag: String) -> Result<(), String> {
    let mut config = load_profile_config();
    config.offline_tag = tag;
    if !save_profile_config(&config) {
        return Err("Failed to save offline tag".to_string());
    }
    Ok(())
}

/// Get total size of offline content storage in bytes
#[tauri::command]
fn get_offline_storage_size() -> Result<u64, String> {
    let store = get_store()?;
    store.get_offline_storage_size()
}

/// Fetch URL content, extract reader-mode HTML, and store to filesystem
#[tauri::command]
async fn fetch_offline_content(item_id: String, url: String) -> Result<(), String> {
    fetch_and_store_offline_content(&item_id, &url).await
}

/// Delete stored offline content for an item
#[tauri::command]
fn delete_offline_content(item_id: String) -> Result<(), String> {
    remove_offline_content(&item_id)
}

/// Check if offline content exists for a single item
#[tauri::command]
fn has_offline_content(item_id: String) -> Result<bool, String> {
    let store = get_store()?;
    store.has_offline_content(&item_id)
}

/// Batch check which item IDs have offline content downloaded
#[tauri::command]
fn check_offline_content_batch(item_ids: Vec<String>) -> Result<Vec<String>, String> {
    let store = get_store()?;
    store.check_offline_content_batch(&item_ids)
}

/// Retrieve stored offline content HTML for display
#[tauri::command]
fn get_offline_content(item_id: String) -> Result<Option<String>, String> {
    let container = get_container_path()
        .ok_or_else(|| "No container path".to_string())?;
    let content_path = container.join("offline").join(&item_id).join("content.html");
    if content_path.exists() {
        let content = fs::read_to_string(&content_path)
            .map_err(|e| format!("Failed to read offline content: {}", e))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

/// Retrieve offline reader content + metadata for frontend HTML assembly
#[tauri::command]
fn get_reader_content(item_id: String) -> Result<serde_json::Value, String> {
    let store = get_store()?;
    let original_url = store.get_item_url(&item_id)?;

    let container = get_container_path()
        .ok_or_else(|| "No container path".to_string())?;
    let offline_dir = container.join("offline").join(&item_id);
    let content_path = offline_dir.join("content.html");
    if !content_path.exists() {
        return Err("No offline content available".to_string());
    }
    let html = fs::read_to_string(&content_path)
        .map_err(|e| format!("Failed to read offline content: {}", e))?;

    // Load article metadata if available
    let meta_path = offline_dir.join("meta.json");
    let meta: serde_json::Value = if meta_path.exists() {
        let meta_str = fs::read_to_string(&meta_path).unwrap_or_default();
        serde_json::from_str(&meta_str).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let title = meta["title"].as_str().unwrap_or("").to_string();
    let byline = meta["byline"].as_str().unwrap_or("").to_string();
    let dir = meta["dir"].as_str().unwrap_or("").to_string();

    // Extract domain from URL
    let domain = original_url.as_ref()
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    Ok(serde_json::json!({
        "html": html,
        "title": title,
        "byline": byline,
        "dir": dir,
        "domain": domain,
        "url": original_url.unwrap_or_default()
    }))
}

/// Display pre-built HTML in the inline native WKWebView
#[tauri::command]
async fn show_inline_html(html: String, top_offset: f64, base_url: String) -> Result<(), String> {
    println!("[Rust] show_inline_html called, top_offset: {}, base_url: {}", top_offset, base_url);

    #[cfg(target_os = "ios")]
    {
        use std::ffi::CString;
        let html_cstr = CString::new(html).map_err(|e| format!("Invalid HTML content: {}", e))?;
        let base_url_cstr = CString::new(base_url.as_str()).map_err(|e| format!("Invalid base URL: {}", e))?;
        let result = unsafe { webview_plugin_open_inline_html(html_cstr.as_ptr(), top_offset, base_url_cstr.as_ptr()) };
        if result {
            Ok(())
        } else {
            Err("Failed to open inline HTML webview".to_string())
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (html, top_offset, base_url);
        Ok(())
    }
}

/// Fetch a URL, extract reader-mode content, and store to the offline directory
async fn fetch_and_store_offline_content(item_id: &str, url: &str) -> Result<(), String> {
    println!("[Rust] Fetching offline content for item {} from {}", item_id, url);

    // Fetch the HTML
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client.get(url)
        .header("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let html = response.text().await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Extract reader-mode content using readability-rust (Mozilla Readability.js port)
    let mut parser = readability_rust::Readability::new(&html, None)
        .map_err(|e| format!("Failed to parse HTML: {}", e))?;
    let article = parser.parse()
        .ok_or_else(|| "Readability could not extract article content".to_string())?;

    let content = article.content
        .ok_or_else(|| "Readability extracted no content from page".to_string())?;

    // Sanitize: strip any remaining <style> tags, style/class attributes as safety net
    let content = sanitize_reader_html(&content);

    // Store to filesystem
    let container = get_container_path()
        .ok_or_else(|| "No container path".to_string())?;
    let offline_dir = container.join("offline").join(item_id);
    fs::create_dir_all(&offline_dir)
        .map_err(|e| format!("Failed to create offline directory: {}", e))?;

    let content_path = offline_dir.join("content.html");
    let size_bytes = content.len() as i64;
    fs::write(&content_path, &content)
        .map_err(|e| format!("Failed to write offline content: {}", e))?;

    // Store article metadata (title, byline, etc.) for reader template
    let meta = serde_json::json!({
        "title": article.title,
        "byline": article.byline,
        "site_name": article.site_name,
        "excerpt": article.excerpt,
        "lang": article.lang,
        "dir": article.dir,
    });
    let meta_path = offline_dir.join("meta.json");
    fs::write(&meta_path, meta.to_string())
        .map_err(|e| format!("Failed to write offline metadata: {}", e))?;

    // Update index in SQLite
    let store = get_store()?;
    store.index_offline_content(item_id, size_bytes)?;

    println!("[Rust] Stored offline content for item {}: {} bytes", item_id, size_bytes);
    Ok(())
}

/// Remove offline content files and index entry for an item
fn remove_offline_content(item_id: &str) -> Result<(), String> {
    println!("[Rust] Removing offline content for item {}", item_id);

    // Remove from filesystem
    if let Some(container) = get_container_path() {
        let offline_dir = container.join("offline").join(item_id);
        if offline_dir.exists() {
            fs::remove_dir_all(&offline_dir)
                .map_err(|e| format!("Failed to remove offline directory: {}", e))?;
        }
    }

    // Remove from index
    if let Ok(store) = get_store() {
        let _ = store.remove_offline_content_index(item_id);
    }

    Ok(())
}

/// Check if auto-sync is enabled
fn is_auto_sync_enabled() -> bool {
    load_profile_config().sync.auto_sync
}

/// Whether `server_url` points at a local (loopback) host.
fn is_local_server_url(server_url: &str) -> bool {
    let u = server_url.to_ascii_lowercase();
    u.contains("localhost")
        || u.contains("127.0.0.1")
        || u.contains("[::1]")
        || u.contains("0.0.0.0")
}

/// Dev/prod separation guard (security 5bb925ff): in a DEBUG build (sim / dev /
/// test), refuse to AUTO-sync to a non-local server unless explicitly opted in
/// via PEEK_ALLOW_REMOTE_SYNC. This structurally stops a debug build that
/// inherited a prod `profiles.json` from silently syncing to production — the
/// 2026-06-24 rogue-sim incident. Release builds are unaffected, and MANUAL
/// sync (an explicit user action) is never blocked.
fn remote_auto_sync_blocked_in_debug(server_url: &str) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    if is_local_server_url(server_url) {
        return false;
    }
    !matches!(
        std::env::var("PEEK_ALLOW_REMOTE_SYNC").ok().as_deref(),
        Some("1") | Some("true")
    )
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

    if remote_auto_sync_blocked_in_debug(&config.sync.server_url) {
        println!(
            "[Rust] Auto-sync: BLOCKED — debug build will not auto-sync to remote server '{}'. \
             Set PEEK_ALLOW_REMOTE_SYNC=1 to allow, or use a localhost server.",
            config.sync.server_url
        );
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

    // Data-leak fix: bind every local profile to a distinct server profile before
    // sending any `?profile=` request. Aborts (returns Err) on failure rather than
    // falling back to the local UUID. Idempotent / no-op once bound.
    ensure_profiles_registered().await?;

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
        let store = get_store()?;
        let now = Utc::now().to_rfc3339();
        let _ = store.set_last_sync(&now);

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
    let store = get_store()?;
    store.get_last_sync()
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

/// Clear database cache to force re-initialization on profile switch.
/// Drops the old PeekStore; next get_store() creates a new one for the new profile.
fn clear_db_cache() {
    if let Ok(mut guard) = STORE.write() {
        guard.take(); // Drop old PeekStore
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
    let store = get_store()?;
    let last_sync = store.get_last_sync()?;

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

    drop(store); // Release Arc before async call

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

// ==================== Server Profile Registration ====================
//
// HIGH-severity sync data-leak fix (client half).
//
// Sync config (server_url, api_key) is GLOBAL but the app has multiple LOCAL
// profiles, each its own peek-<localUUID>.db. The per-profile discriminator
// sent to the server is `?profile=<id>` (see append_profile_to_url). Historically
// every local profile had server_profile_id = null, so the client sent the LOCAL
// profile UUID — an id the server never registered. The server then (mis)routed
// all of them into its "default" bucket, cross-contaminating profiles.
//
// The fix: before the first push/pull of a sync, perform a one-time, idempotent
// registration that binds each local profile to a DISTINCT server profile and
// records it in server_profile_id:
//   * The FIRST local profile (production / "Default") is bound to the EXISTING
//     server "default" bucket so its already-synced data is preserved.
//   * Every OTHER local profile gets a freshly POSTed server profile (isolated
//     bucket).
// If registration cannot complete (network/HTTP failure, or no server "default"
// bucket to bind the first profile to), we ABORT the sync rather than fall back
// to sending the local UUID — that fallback is precisely the bug.
//
// NOTE (deploy ordering): the SERVER de-fallback (stop silently routing unknown
// profile ids to "default") must ship BEFORE this client change is relied upon.

/// A single profile as returned by the server's `/profiles` endpoints.
#[derive(Debug, Deserialize)]
struct ServerProfile {
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
}

/// Response shape of `GET /profiles`.
#[derive(Debug, Deserialize)]
struct ServerProfilesResponse {
    #[serde(default)]
    profiles: Vec<ServerProfile>,
}

/// Response shape of `POST /profiles`.
#[derive(Debug, Deserialize)]
struct ServerCreateProfileResponse {
    profile: ServerProfile,
}

/// Pick the server profile that the FIRST (production / "Default") local profile
/// should bind to: the pre-existing "default" bucket. Matches slug == "default"
/// first, then falls back to name == "Default". Returns None if the server has no
/// such bucket (caller must ABORT — never create a new one for Default, that would
/// orphan the real server data).
fn find_server_default<'a>(profiles: &'a [ServerProfile]) -> Option<&'a ServerProfile> {
    profiles
        .iter()
        .find(|p| p.slug == "default")
        .or_else(|| profiles.iter().find(|p| p.name == "Default"))
}

/// Ensure every local profile is bound to a DISTINCT server profile via
/// server_profile_id. Idempotent and safe to call before every sync: if all
/// local profiles already carry a server_profile_id, it returns immediately
/// without any network call.
///
/// Binding rules (see module comment above):
///   * profiles[0] (production / "Default") -> EXISTING server "default" bucket
///     (slug == "default", fallback name == "Default"). Never creates a new
///     bucket for it (that would orphan the real server data).
///   * every other profile -> a freshly POSTed server profile.
///
/// On ANY failure (network, non-2xx, missing server default for the first
/// profile) returns Err so the caller ABORTS the sync. We never fall back to the
/// local UUID — that is the data-leak bug.
async fn ensure_profiles_registered() -> Result<(), String> {
    let config = load_profile_config();

    // Cheap fast path: nothing to do if every profile is already bound.
    if config.profiles.iter().all(|p| p.server_profile_id.is_some()) {
        return Ok(());
    }

    let server_url = config.sync.server_url.trim_end_matches('/').to_string();
    if server_url.is_empty() {
        return Err("No server URL configured".to_string());
    }
    let api_key = if config.sync.api_key.is_empty() {
        None
    } else {
        Some(config.sync.api_key.clone())
    };

    let client = reqwest::Client::new();

    // Helper to attach the same Bearer auth the rest of sync uses.
    let auth = |req: reqwest::RequestBuilder| -> reqwest::RequestBuilder {
        if let Some(ref key) = api_key {
            if !key.is_empty() {
                return req.header("Authorization", format!("Bearer {}", key));
            }
        }
        req
    };

    // 1. Fetch the server's existing profiles (needed to bind the first/Default
    //    profile to the pre-existing "default" bucket).
    let list_url = format!("{}/profiles", server_url);
    let resp = auth(client.get(&list_url))
        .send()
        .await
        .map_err(|e| format!("Profile registration failed (GET /profiles): {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Profile registration failed: GET /profiles returned {}: {}",
            status, body
        ));
    }
    let server_profiles: ServerProfilesResponse = resp
        .json()
        .await
        .map_err(|e| format!("Profile registration failed parsing /profiles: {}", e))?;

    // Work on a mutable copy; only persist if something changed.
    let mut updated = config.clone();
    let mut changed = false;

    for (idx, profile) in updated.profiles.iter_mut().enumerate() {
        // Never overwrite an existing binding.
        if profile.server_profile_id.is_some() {
            continue;
        }

        if idx == 0 {
            // First (production / Default) profile: bind to the EXISTING server
            // "default" bucket so its already-synced data is preserved. Do NOT
            // create a new bucket here.
            let default_match = find_server_default(&server_profiles.profiles);

            match default_match {
                Some(p) => {
                    println!(
                        "[Rust] Profile registration: binding local '{}' ({}) -> existing server default {}",
                        profile.name, profile.id, p.id
                    );
                    profile.server_profile_id = Some(p.id.clone());
                    changed = true;
                }
                None => {
                    // Abort rather than risk creating/binding wrong; the existing
                    // server "default" bucket is where this profile's data lives.
                    return Err(format!(
                        "Profile registration aborted: server has no 'default' profile to bind local '{}' to",
                        profile.name
                    ));
                }
            }
        } else {
            // Every other profile: POST a fresh, isolated server bucket.
            let create_url = format!("{}/profiles", server_url);
            let body = serde_json::json!({ "name": profile.name });
            let resp = auth(client.post(&create_url).json(&body))
                .send()
                .await
                .map_err(|e| {
                    format!(
                        "Profile registration failed (POST /profiles for '{}'): {}",
                        profile.name, e
                    )
                })?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "Profile registration failed: POST /profiles for '{}' returned {}: {}",
                    profile.name, status, text
                ));
            }
            let created: ServerCreateProfileResponse = resp.json().await.map_err(|e| {
                format!(
                    "Profile registration failed parsing POST /profiles for '{}': {}",
                    profile.name, e
                )
            })?;
            println!(
                "[Rust] Profile registration: created server bucket {} for local '{}' ({})",
                created.profile.id, profile.name, profile.id
            );
            profile.server_profile_id = Some(created.profile.id);
            changed = true;
        }
    }

    if changed {
        // Persist + refresh the cached config so the subsequent
        // append_profile_to_url reads the new server_profile_id values.
        if !save_profile_config(&updated) {
            return Err("Profile registration: failed to persist profiles.json".to_string());
        }
    }

    Ok(())
}

// ==================== Bidirectional Sync ====================

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

/// Pull items from server and merge into local database
#[tauri::command]
async fn pull_from_server() -> Result<BidirectionalSyncResult, String> {
    println!("[Rust] pull_from_server called");

    // Data-leak fix: bind every local profile to a distinct server profile before
    // sending any `?profile=` request. Aborts (returns Err) on failure rather than
    // falling back to the local UUID. Idempotent / no-op once bound.
    ensure_profiles_registered().await?;

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
    let store = get_store()?;
    let last_sync = store.get_last_sync()?;
    // Bucket these items are being pulled from; merge stamps it as their synced bucket
    // so pulled items aren't immediately treated as pending and pushed straight back.
    let target_profile_id = current_target_profile_id();

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

    // Ask the server for only the types this client syncs, so it never ships types
    // we'd merge-skip anyway (e.g. the desktop's thousands of entities). merge_server_item
    // still enforces the same set locally — this is the bandwidth optimization, not the
    // correctness guarantee. Older servers ignore the unknown param and return everything,
    // which the merge filter then handles, so this is safe against a not-yet-deployed server.
    let synced_types = store.get_synced_types().unwrap_or_default();
    let items_url = if synced_types.is_empty() {
        items_url
    } else {
        format!("{}&types={}", items_url, synced_types.join(","))
    };

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
    let mut pulled = 0;
    let mut conflicts = 0;

    let offline_tag = config.offline_tag.clone();

    for server_item in &server_response.items {
        match store.merge_server_item(server_item, &target_profile_id)? {
            "pulled" => {
                pulled += 1;
                // Fetch offline content for pulled items that have the offline tag
                if server_item.tags.contains(&offline_tag) {
                    if let Some(ref url) = server_item.content {
                        if !url.is_empty() && server_item.item_type == "url" {
                            let item_id = server_item.id.clone();
                            let fetch_url = url.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = fetch_and_store_offline_content(&item_id, &fetch_url).await {
                                    println!("[Rust] Failed to fetch offline content for synced item: {}", e);
                                }
                            });
                        }
                    }
                }
            }
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

    // Data-leak fix: bind every local profile to a distinct server profile before
    // sending any `?profile=` request. Aborts (returns Err) on failure rather than
    // falling back to the local UUID. Idempotent / no-op once bound.
    ensure_profiles_registered().await?;

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

    let store = get_store()?;
    let target_profile_id = current_target_profile_id();

    // Heal legacy rows for the primary profile before computing the push set, so
    // already-synced Default items don't all look unsynced for the default bucket.
    heal_synced_profile_ids(&store);

    // Get items to push to the current bucket (per-item, per-bucket sync state).
    let items = store.get_items_to_push(&target_profile_id)?;
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
    let mut rejected = 0;

    for item in &items {
        // Get tags for this item
        let tags = store.get_item_tags(&item.id)?;

        // Determine content based on type
        let content = match item.item_type.as_str() {
            "url" | "page" => item.url.clone(),
            _ => item.content.clone(),
        };

        // Map "page" type to "url" for server
        let server_type = if item.item_type == "page" { "url" } else { &item.item_type };

        // Parse metadata
        let metadata: Option<serde_json::Value> = if !item.metadata.is_empty() {
            serde_json::from_str(&item.metadata).ok()
        } else {
            None
        };

        // Use server ID (sync_id) when available for dedup, otherwise local ID for first push
        let sync_id_to_send = if !item.sync_id.is_empty() { &item.sync_id } else { &item.id };

        // Build request body
        let mut body = serde_json::json!({
            "type": server_type,
            "content": content,
            "tags": tags,
            "metadata": metadata,
            "syncId": sync_id_to_send,
        });

        // Include deletedAt if the item was soft-deleted locally
        if let Some(ref deleted_at_str) = item.deleted_at {
            if let Some(dt) = peek_core::sync::parse_iso_datetime(deleted_at_str) {
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
                let status = response.status().as_u16();
                let body_text = response.text().await.unwrap_or_default();
                // Pull the server id out of a 2xx body so the classifier can confirm a sync.
                let parsed_id = serde_json::from_str::<ServerCreateResponse>(&body_text)
                    .ok()
                    .map(|r| r.id);
                match peek_core::sync::classify_push_response(status, &body_text, parsed_id.as_deref()) {
                    peek_core::sync::PushOutcome::Synced(server_id) => {
                        let _ = store.mark_item_synced(&item.id, &server_id, &target_profile_id);
                        println!("[Rust] Pushed item {} -> {}", item.id, server_id);
                        pushed += 1;
                    }
                    peek_core::sync::PushOutcome::Rejected(reason) => {
                        // Permanent 4xx: park the item so it stops re-pushing and stops
                        // counting as pending (the "never clears" bug). Cleared on edit/success.
                        println!("[Rust] Server rejected item {} (parked): {}", item.id, reason);
                        let _ = store.mark_item_sync_failed(&item.id, &reason);
                        rejected += 1;
                    }
                    peek_core::sync::PushOutcome::VersionMismatch(reason) => {
                        // App is outdated — stop the whole sync; all items would 409.
                        return Err(format!("Version mismatch — please update the app. {}", reason));
                    }
                    peek_core::sync::PushOutcome::Retry(reason) => {
                        // Transient (network/5xx/unparseable 2xx): leave pending, try next sync.
                        println!("[Rust] Push of item {} will retry: {}", item.id, reason);
                        failed += 1;
                    }
                }
            }
            Err(e) => {
                println!("[Rust] Failed to push item {}: {}", item.id, e);
                failed += 1;
            }
        }
    }

    println!("[Rust] Push complete: {} pushed, {} failed, {} rejected", pushed, failed, rejected);

    let mut message = format!("Pushed {} items", pushed);
    if failed > 0 {
        message.push_str(&format!(", {} failed", failed));
    }
    if rejected > 0 {
        message.push_str(&format!(", {} rejected", rejected));
    }

    Ok(BidirectionalSyncResult {
        // Rejected items are parked + surfaced separately (get_sync_failed_count), so they
        // don't fail the sync; only transient failures do.
        success: failed == 0,
        pulled: 0,
        pushed,
        conflicts: 0,
        message,
    })
}

/// Full bidirectional sync: push then pull
#[tauri::command]
/// Internal sync_all implementation (called by both command and auto-sync)
async fn sync_all_internal() -> Result<BidirectionalSyncResult, String> {
    // Push first (send local changes to server before pulling)
    let push_result = push_to_server().await?;

    // Then pull (get merged state from server)
    let pull_result = pull_from_server().await?;

    // Update last sync time
    let store = get_store()?;
    let now = Utc::now().to_rfc3339();
    let _ = store.set_last_sync(&now);

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
    let store = get_store()?;

    // Check if configured (from profiles.json)
    let config = load_profile_config();
    let configured = !config.sync.server_url.is_empty() && !config.sync.api_key.is_empty();

    // Get last sync time and pending count from PeekStore. Heal first so the count
    // reflects the per-bucket sync state (not a transient "everything pending").
    heal_synced_profile_ids(&store);
    let last_sync_time = store.get_last_sync()?;
    let pending_count = store.get_pending_sync_count(&current_target_profile_id())?;

    Ok(SyncStatus {
        configured,
        last_sync_time,
        pending_count,
    })
}

/// Drain any share intents queued to disk by the Android side (MainActivity writes
/// ACTION_SEND payloads to <container>/pending_shares.txt, one per line). The file
/// outlives the app process, so cold-launch shares are picked up here deterministically
/// on the frontend's first call. Frontend calls this on mount and on tauri://focus.
#[tauri::command]
fn pop_pending_shares() -> Result<Vec<String>, String> {
    let container = get_container_path().ok_or("no container path")?;
    let path = container.join("pending_shares.txt");
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("read pending_shares failed: {}", e))?;
    // Delete first so a crash mid-save doesn't replay the same items forever. The
    // tradeoff is dropping items if save_url/save_text below fails; acceptable for v1.
    if let Err(e) = std::fs::remove_file(&path) {
        println!("[Rust] pop_pending_shares: failed to delete {}: {}", path.display(), e);
    }
    let entries: Vec<String> = content
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !entries.is_empty() {
        println!("[Rust] pop_pending_shares: drained {} entries", entries.len());
    }
    Ok(entries)
}

#[derive(Serialize)]
struct PendingImageShare {
    #[serde(rename = "imageData")]
    image_data: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

/// Drain image shares queued by Android MainActivity. Each entry is a sibling pair
/// in <container>/pending_share_images/: <stem>.bin holds raw bytes, <stem>.mime
/// holds the mime type. Bytes are base64-encoded for serialization through tauri.
/// Files are deleted after collection.
#[tauri::command]
fn pop_pending_image_shares() -> Result<Vec<PendingImageShare>, String> {
    let container = get_container_path().ok_or("no container path")?;
    let dir = container.join("pending_share_images");
    if !dir.exists() {
        return Ok(vec![]);
    }
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let mut entries: Vec<PendingImageShare> = vec![];
    let mut cleanup: Vec<PathBuf> = vec![];
    let read = std::fs::read_dir(&dir).map_err(|e| format!("read_dir failed: {}", e))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("dir entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("bin") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mime_path = dir.join(format!("{}.mime", stem));
        let mime = std::fs::read_to_string(&mime_path)
            .unwrap_or_else(|_| "image/jpeg".to_string())
            .trim()
            .to_string();
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                println!("[Rust] pop_pending_image_shares: read {} failed: {}", path.display(), e);
                continue;
            }
        };
        entries.push(PendingImageShare {
            image_data: STANDARD.encode(&bytes),
            mime_type: mime,
        });
        cleanup.push(path);
        cleanup.push(mime_path);
    }
    for p in cleanup {
        if let Err(e) = std::fs::remove_file(&p) {
            println!("[Rust] pop_pending_image_shares: failed to delete {}: {}", p.display(), e);
        }
    }
    if !entries.is_empty() {
        println!("[Rust] pop_pending_image_shares: drained {} images", entries.len());
    }
    Ok(entries)
}

/// Write the embedded build id + a launch timestamp to Documents/build-id.txt so
/// an external verifier can confirm the running app == the build just produced.
/// The id comes from PEEK_BUILD_ID, baked in at Rust compile time (see build.rs);
/// on a stale-cache build the id is whatever was last compiled, which is exactly
/// how this catches a silently-stale embedded bundle. (See peek-device-verify.)
#[cfg(target_os = "ios")]
fn write_build_id_marker() {
    let docs = match get_docs_path() {
        Some(p) => p,
        None => return,
    };
    let build_id = env!("PEEK_BUILD_ID");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let contents = format!("{}\n{}\n", build_id, ts);
    if fs::write(docs.join("build-id.txt"), contents).is_ok() {
        ios_log(&format!("Build id marker written: {}", build_id));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // RESTORE: Check for *.restore files in Documents and copy to App Group (iOS only)
    #[cfg(target_os = "ios")]
    restore_from_documents();

    // BACKUP: Copy App Group data to Documents for recovery via Finder File Sharing (iOS only)
    #[cfg(target_os = "ios")]
    backup_app_group_to_documents();

    // BUILD MARKER: write the embedded build id so an external verifier can
    // confirm the running app is the build that was just made (see the
    // peek-device-verify skill). Pull with `devicectl ... copy from
    // --source Documents/build-id.txt`.
    #[cfg(target_os = "ios")]
    write_build_id_marker();

    // Check for auto-sync environment variable (used by e2e tests)
    let auto_sync_on_launch = std::env::var("PEEK_AUTO_SYNC")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |_app| {
            // Eagerly initialize database on app start (runs migrations including dedup)
            // This ensures one-time migrations run even if the frontend hasn't loaded yet
            match get_store() {
                Ok(_) => println!("[Rust] Database initialized on startup"),
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

            // Linux/Phosh: requesting fullscreen via tauri.conf at window create
            // time causes a left-shifted layout on Phosh (xdg_toplevel.set_fullscreen
            // issued before the surface is configured). Delay the request until after
            // the window is up.
            #[cfg(target_os = "linux")]
            {
                if let Some(win) = _app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        let _ = win.set_fullscreen(true);
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Page (URL) commands
            save_url,
            get_saved_urls,
            query_items,
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
            get_sync_interval,
            set_sync_interval,
            get_archive_tag,
            set_archive_tag,
            get_todo_tags,
            set_todo_tags,
            get_reading_tags,
            set_reading_tags,
            get_offline_tag,
            set_offline_tag,
            get_offline_storage_size,
            fetch_offline_content,
            delete_offline_content,
            get_offline_content,
            has_offline_content,
            check_offline_content_batch,
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
            open_inline_webview_html,
            close_inline_webview,
            get_reader_content,
            show_inline_html,
            // Android share target
            pop_pending_shares,
            pop_pending_image_shares
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};
    use chrono::Utc;
    use super::{
        find_server_default, is_valid_uuid, ProfileConfig, ProfileEntry, ServerProfile,
        ServerProfilesResponse, SyncSettings,
    };
    use peek_core::generate_tag_id;

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
                synced_profile_id TEXT,
                sync_error TEXT,
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
            "INSERT INTO items (id, type, url, sync_id, synced_at, created_at, updated_at) VALUES (?, 'url', ?, ?, ?, ?, ?)",
            params![&id, "https://sync-test.com", "remote-123", &now, &now, &now],
        )
        .expect("Failed to insert item with sync columns");

        // Retrieve and verify
        let (sync_id, synced_at): (String, String) = conn
            .query_row(
                "SELECT sync_id, synced_at FROM items WHERE id = ?",
                params![&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("Failed to query sync columns");

        assert_eq!(sync_id, "remote-123", "sync_id should be saved");
        assert_eq!(synced_at, now, "synced_at should be saved");
    }

    #[test]
    fn test_is_local_server_url() {
        assert!(super::is_local_server_url("http://localhost:3000"));
        assert!(super::is_local_server_url("http://127.0.0.1:3000"));
        assert!(super::is_local_server_url("http://[::1]:3000"));
        assert!(super::is_local_server_url("http://0.0.0.0:8080"));
        assert!(!super::is_local_server_url("https://peek-node.up.railway.app"));
        assert!(!super::is_local_server_url("https://example.com"));
    }

    #[test]
    fn test_remote_auto_sync_blocked_in_debug() {
        // Runs under `cargo test`, where debug_assertions is true.
        // A local server is always allowed regardless of the env opt-in.
        std::env::remove_var("PEEK_ALLOW_REMOTE_SYNC");
        assert!(!super::remote_auto_sync_blocked_in_debug("http://localhost:3000"));

        // A remote server is blocked unless explicitly opted in.
        assert!(super::remote_auto_sync_blocked_in_debug("https://peek-node.up.railway.app"));

        std::env::set_var("PEEK_ALLOW_REMOTE_SYNC", "1");
        assert!(!super::remote_auto_sync_blocked_in_debug("https://peek-node.up.railway.app"));

        std::env::remove_var("PEEK_ALLOW_REMOTE_SYNC");
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
            todo_tag: "todo".to_string(),
            done_tag: "done".to_string(),
            readme_tag: "readme".to_string(),
            read_tag: "read".to_string(),
            offline_tag: "offline".to_string(),
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

    // ---- Server profile registration (sync data-leak fix) ----

    fn sp(id: &str, slug: &str, name: &str) -> ServerProfile {
        ServerProfile {
            id: id.to_string(),
            slug: slug.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn test_find_server_default_by_slug() {
        // The Default/production local profile binds to the EXISTING server
        // "default" bucket (matched by slug) so its data is preserved.
        let profiles = vec![
            sp("id-work", "work", "Work"),
            sp("id-default", "default", "Some Other Name"),
        ];
        let found = find_server_default(&profiles).expect("default bucket should match");
        assert_eq!(found.id, "id-default");
    }

    #[test]
    fn test_find_server_default_name_fallback() {
        // Fallback to name == "Default" when no slug == "default" exists.
        let profiles = vec![
            sp("id-a", "personal", "Personal"),
            sp("id-b", "renamed-slug", "Default"),
        ];
        let found = find_server_default(&profiles).expect("Default by name should match");
        assert_eq!(found.id, "id-b");
    }

    #[test]
    fn test_find_server_default_slug_wins_over_name() {
        // slug == "default" takes precedence over name == "Default".
        let profiles = vec![
            sp("id-name", "renamed", "Default"),
            sp("id-slug", "default", "Not Default Name"),
        ];
        let found = find_server_default(&profiles).expect("slug should win");
        assert_eq!(found.id, "id-slug");
    }

    #[test]
    fn test_find_server_default_none_aborts() {
        // No server default => None => caller ABORTS (never creates a new bucket
        // for Default, which would orphan real server data).
        let profiles = vec![sp("id-a", "work", "Work"), sp("id-b", "personal", "Personal")];
        assert!(find_server_default(&profiles).is_none());
    }

    #[test]
    fn test_server_profiles_response_parses() {
        // Mirrors the real GET /profiles body shape.
        let json = r#"{ "profiles": [
            { "id": "uuid-1", "user_id": "u", "slug": "default", "name": "Default" },
            { "id": "uuid-2", "user_id": "u", "slug": "dev", "name": "Development" }
        ] }"#;
        let resp: ServerProfilesResponse =
            serde_json::from_str(json).expect("should parse /profiles");
        assert_eq!(resp.profiles.len(), 2);
        let found = find_server_default(&resp.profiles).expect("default present");
        assert_eq!(found.id, "uuid-1");
    }
}
