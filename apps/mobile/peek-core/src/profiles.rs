use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use crate::helpers::is_valid_uuid;
use crate::types::PeekResult;

/// Sync configuration (shared across all profiles)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncSettings {
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub auto_sync: bool,
}

/// Profile configuration stored in profiles.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileConfig {
    #[serde(rename = "currentProfileId")]
    pub current_profile_id: String,
    pub profiles: Vec<ProfileEntry>,
    #[serde(default)]
    pub sync: SyncSettings,
    #[serde(default = "default_archive_tag")]
    pub archive_tag: String,
    #[serde(default = "default_todo_tag")]
    pub todo_tag: String,
    #[serde(default = "default_done_tag")]
    pub done_tag: String,
    #[serde(default = "default_readme_tag")]
    pub readme_tag: String,
    #[serde(default = "default_read_tag")]
    pub read_tag: String,
    #[serde(default = "default_offline_tag")]
    pub offline_tag: String,
}

pub fn default_archive_tag() -> String {
    "archive".to_string()
}

pub fn default_todo_tag() -> String {
    "todo".to_string()
}

pub fn default_done_tag() -> String {
    "done".to_string()
}

pub fn default_readme_tag() -> String {
    "readme".to_string()
}

pub fn default_read_tag() -> String {
    "read".to_string()
}

pub fn default_offline_tag() -> String {
    "offline".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastUsed", alias = "lastUsedAt")]
    pub last_used_at: String,
    /// Server profile UUID — maps this local profile to a server-side profile for sync.
    /// When set, sync requests send this ID instead of the local profile ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_profile_id: Option<String>,
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

/// Get the path to profiles.json given a base directory.
pub fn get_profiles_config_path(base_path: &Path) -> PathBuf {
    base_path.join("profiles.json")
}

/// Get the database path for the current profile.
/// Returns the path to peek-{profile_id}.db in the base directory.
pub fn get_db_path_for_profile(base_path: &Path) -> PeekResult<PathBuf> {
    let config = load_profile_config(base_path);
    let profile_id = &config.current_profile_id;

    if !is_valid_uuid(profile_id) {
        println!(
            "[peek-core] WARNING: Invalid profile ID '{}' is not a UUID.",
            profile_id
        );

        let valid_profile_id = if let Some(first_profile) = config.profiles.first() {
            println!("[peek-core] Falling back to first profile: {}", first_profile.id);
            first_profile.id.clone()
        } else {
            println!("[peek-core] No profiles found, creating default profile config");
            let new_config = create_default_profile_config(false);
            save_profile_config(base_path, &new_config);
            new_config.current_profile_id
        };

        let db_name = format!("peek-{}.db", valid_profile_id);
        return Ok(base_path.join(&db_name));
    }

    // Validate that the profile ID exists in the profiles array
    let profile_exists = config.profiles.iter().any(|p| p.id == *profile_id);
    if !profile_exists && !config.profiles.is_empty() {
        println!(
            "[peek-core] WARNING: Profile ID '{}' not found in profiles list. Using first profile.",
            profile_id
        );
        let first_profile = &config.profiles[0];
        let db_name = format!("peek-{}.db", first_profile.id);
        return Ok(base_path.join(&db_name));
    }

    let db_name = format!("peek-{}.db", profile_id);
    let new_db_path = base_path.join(&db_name);

    // Migration: rename old peek.db to the first profile's database
    let old_db_path = base_path.join("peek.db");
    if old_db_path.exists() && !new_db_path.exists() {
        println!("[peek-core] Migrating {} to {}", old_db_path.display(), new_db_path.display());
        if let Err(e) = fs::rename(&old_db_path, &new_db_path) {
            println!("[peek-core] Migration failed: {}. Will use new empty database.", e);
        } else {
            println!("[peek-core] Migration successful");
        }
    }

    println!("[peek-core] Using database: {} (profile id: {})", db_name, profile_id);
    Ok(new_db_path)
}

/// Load profile config from file, creating default if needed.
/// This is the platform-agnostic version — caller provides the base path.
pub fn load_profile_config(base_path: &Path) -> ProfileConfig {
    let config_path = get_profiles_config_path(base_path);
    load_profile_config_from_path(&config_path, base_path)
}

/// Load profile config directly from file path.
fn load_profile_config_from_path(config_path: &Path, base_path: &Path) -> ProfileConfig {
    if config_path.exists() {
        match fs::read_to_string(config_path) {
            Ok(contents) => {
                // First try to parse as new format
                match serde_json::from_str::<ProfileConfig>(&contents) {
                    Ok(config) => {
                        println!("[peek-core] Loaded profile config: current={}", config.current_profile_id);
                        // Check if we need to migrate old slug-based databases
                        migrate_slug_databases_to_uuid(&config, base_path);
                        return config;
                    }
                    Err(e) => {
                        println!("[peek-core] Failed to parse as new format: {}", e);

                        // Try to parse as old format and migrate
                        match serde_json::from_str::<OldProfileConfig>(&contents) {
                            Ok(old_config) => {
                                println!("[peek-core] Found old format profiles.json, migrating...");
                                let new_config = migrate_old_profile_config(old_config, base_path);
                                save_profile_config(base_path, &new_config);
                                return new_config;
                            }
                            Err(e2) => {
                                println!("[peek-core] Failed to parse as old format either: {}", e2);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                println!("[peek-core] Failed to read profiles.json: {}", e);
            }
        }
    }

    // Create default config
    let config = create_default_profile_config(false);
    save_profile_config(base_path, &config);
    config
}

/// Migrate from old slug-based format to new UUID-based format
fn migrate_old_profile_config(old_config: OldProfileConfig, base_path: &Path) -> ProfileConfig {
    println!("[peek-core] Migrating old profile config format to new UUID-based format");

    let now = Utc::now().to_rfc3339();
    let mut new_profiles = Vec::new();
    let mut current_profile_id = String::new();

    for old_profile in &old_config.profiles {
        let new_id = uuid::Uuid::new_v4().to_string();
        println!("[peek-core] Processing profile: {} -> {}", old_profile.slug, new_id);

        // Rename database file from peek-{slug}.db to peek-{uuid}.db
        let old_db_path = base_path.join(format!("peek-{}.db", old_profile.slug));
        let new_db_path = base_path.join(format!("peek-{}.db", new_id));

        if old_db_path.exists() && !new_db_path.exists() {
            println!("[peek-core] Migrating database: {} -> {}", old_db_path.display(), new_db_path.display());
            if let Err(e) = fs::rename(&old_db_path, &new_db_path) {
                println!("[peek-core] Warning: Failed to rename database: {}", e);
            } else {
                // Also rename WAL and SHM files if they exist
                let old_wal = base_path.join(format!("peek-{}.db-wal", old_profile.slug));
                let new_wal = base_path.join(format!("peek-{}.db-wal", new_id));
                if old_wal.exists() {
                    let _ = fs::rename(&old_wal, &new_wal);
                }
                let old_shm = base_path.join(format!("peek-{}.db-shm", old_profile.slug));
                let new_shm = base_path.join(format!("peek-{}.db-shm", new_id));
                if old_shm.exists() {
                    let _ = fs::rename(&old_shm, &new_shm);
                }
                println!("[peek-core] Database migration successful");
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

    // If current profile wasn't found, use first profile
    if current_profile_id.is_empty() {
        if let Some(first) = new_profiles.first() {
            current_profile_id = first.id.clone();
        }
    }

    // Try to migrate sync settings from old database
    let sync = migrate_sync_settings_from_db(base_path, &old_config.current);

    println!("[peek-core] Migration complete: {} profiles, current={}", new_profiles.len(), current_profile_id);

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
fn migrate_sync_settings_from_db(base_path: &Path, old_current_slug: &str) -> SyncSettings {
    let old_db_path = base_path.join(format!("peek-{}.db", old_current_slug));

    // The database might have already been renamed, so also check for peek.db as fallback
    let db_path = if old_db_path.exists() {
        Some(old_db_path)
    } else {
        let legacy_path = base_path.join("peek.db");
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
                println!("[peek-core] Migrated sync settings from old database");
                return SyncSettings {
                    server_url,
                    api_key,
                    auto_sync: auto_sync == "1" || auto_sync == "true",
                };
            }
        }
    }

    SyncSettings::default()
}

/// Migrate old slug-based databases to UUID-based names
fn migrate_slug_databases_to_uuid(config: &ProfileConfig, base_path: &Path) {
    // Map profile names to their expected old slugs
    let slug_mappings = [
        ("Default", "default"),
        ("Development", "dev"),
    ];

    let mut needs_sync_migration = config.sync.server_url.is_empty() && config.sync.api_key.is_empty();
    let mut migrated_sync = SyncSettings::default();

    for profile in &config.profiles {
        let old_slug = slug_mappings.iter()
            .find(|(name, _)| *name == profile.name)
            .map(|(_, slug)| *slug);

        if let Some(slug) = old_slug {
            let old_db_path = base_path.join(format!("peek-{}.db", slug));
            let new_db_path = base_path.join(format!("peek-{}.db", profile.id));

            if old_db_path.exists() {
                let old_size = fs::metadata(&old_db_path).map(|m| m.len()).unwrap_or(0);
                let new_size = fs::metadata(&new_db_path).map(|m| m.len()).unwrap_or(0);

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
                    println!("[peek-core] Migrating slug database: {} -> {}", old_db_path.display(), new_db_path.display());

                    if new_db_path.exists() {
                        let _ = fs::remove_file(&new_db_path);
                        let _ = fs::remove_file(base_path.join(format!("peek-{}.db-wal", profile.id)));
                        let _ = fs::remove_file(base_path.join(format!("peek-{}.db-shm", profile.id)));
                    }

                    if let Err(e) = fs::rename(&old_db_path, &new_db_path) {
                        println!("[peek-core] Warning: Failed to rename database: {}", e);
                    } else {
                        println!("[peek-core] Successfully migrated database");
                        let old_wal = base_path.join(format!("peek-{}.db-wal", slug));
                        let new_wal = base_path.join(format!("peek-{}.db-wal", profile.id));
                        if old_wal.exists() {
                            let _ = fs::rename(&old_wal, &new_wal);
                        }
                        let old_shm = base_path.join(format!("peek-{}.db-shm", slug));
                        let new_shm = base_path.join(format!("peek-{}.db-shm", profile.id));
                        if old_shm.exists() {
                            let _ = fs::rename(&old_shm, &new_shm);
                        }
                    }
                }
            }

            // Also check the current UUID database for sync settings
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
        save_profile_config(base_path, &updated_config);
        println!("[peek-core] Migrated sync settings to profiles.json");
    }
}

/// Create default profile config.
/// `is_production` determines which profile is active by default.
pub fn create_default_profile_config(is_production: bool) -> ProfileConfig {
    let now = Utc::now().to_rfc3339();
    let default_id = uuid::Uuid::new_v4().to_string();
    let dev_id = uuid::Uuid::new_v4().to_string();

    let current_id = if is_production { default_id.clone() } else { dev_id.clone() };

    println!("[peek-core] Creating default profile config with profile id: {} (production: {})", current_id, is_production);

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

/// Save profile config to file.
pub fn save_profile_config(base_path: &Path, config: &ProfileConfig) -> bool {
    let config_path = get_profiles_config_path(base_path);

    match serde_json::to_string_pretty(config) {
        Ok(json) => {
            match fs::write(&config_path, json) {
                Ok(_) => {
                    println!("[peek-core] Saved profile config");
                    true
                }
                Err(e) => {
                    println!("[peek-core] Failed to write profiles.json: {}", e);
                    false
                }
            }
        }
        Err(e) => {
            println!("[peek-core] Failed to serialize profile config: {}", e);
            false
        }
    }
}

/// Append profile parameter to a URL.
/// Sends the server profile UUID if configured, otherwise falls back to local profile UUID.
pub fn append_profile_to_url(url: &str, config: &ProfileConfig) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_default_profile_config() {
        let config = create_default_profile_config(false);
        assert_eq!(config.profiles.len(), 2);
        assert_eq!(config.profiles[0].name, "Default");
        assert_eq!(config.profiles[1].name, "Development");
        // Dev build should default to Development profile
        assert_eq!(config.current_profile_id, config.profiles[1].id);
    }

    #[test]
    fn test_create_default_profile_config_production() {
        let config = create_default_profile_config(true);
        // Production build should default to Default profile
        assert_eq!(config.current_profile_id, config.profiles[0].id);
    }

    #[test]
    fn test_save_and_load_profile_config() {
        let dir = TempDir::new().unwrap();
        let config = create_default_profile_config(false);
        save_profile_config(dir.path(), &config);

        let loaded = load_profile_config(dir.path());
        assert_eq!(loaded.current_profile_id, config.current_profile_id);
        assert_eq!(loaded.profiles.len(), config.profiles.len());
    }

    #[test]
    fn test_get_db_path_for_profile() {
        let dir = TempDir::new().unwrap();
        let config = create_default_profile_config(false);
        save_profile_config(dir.path(), &config);

        let db_path = get_db_path_for_profile(dir.path()).unwrap();
        let expected = format!("peek-{}.db", config.current_profile_id);
        assert!(db_path.to_str().unwrap().ends_with(&expected));
    }

    #[test]
    fn test_append_profile_to_url() {
        let config = create_default_profile_config(false);
        let result = append_profile_to_url("https://api.example.com/items", &config).unwrap();
        assert!(result.contains("profile="));
        assert!(result.contains("?profile="));
    }

    #[test]
    fn test_append_profile_to_url_with_query() {
        let config = create_default_profile_config(false);
        let result = append_profile_to_url("https://api.example.com/items?foo=bar", &config).unwrap();
        assert!(result.contains("&profile="));
    }

    #[test]
    fn test_load_creates_default_when_missing() {
        let dir = TempDir::new().unwrap();
        let config = load_profile_config(dir.path());
        assert!(!config.current_profile_id.is_empty());
        assert!(!config.profiles.is_empty());
        // Should have saved the config
        assert!(get_profiles_config_path(dir.path()).exists());
    }

    #[test]
    fn test_default_tag_values() {
        let config = create_default_profile_config(false);
        assert_eq!(config.archive_tag, "archive");
        assert_eq!(config.todo_tag, "todo");
        assert_eq!(config.done_tag, "done");
        assert_eq!(config.readme_tag, "readme");
        assert_eq!(config.read_tag, "read");
        assert_eq!(config.offline_tag, "offline");
    }
}
