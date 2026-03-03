use regex::Regex;
use chrono::Utc;

/// Sanitize reader-mode HTML: strip <style> tags, style/class attributes, script-related content.
/// Readability.js normally strips these, but this is a safety net for the Rust port.
pub fn sanitize_reader_html(html: &str) -> String {
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

/// Normalize a URL by ensuring a trailing slash on bare authority URLs
/// (e.g. "https://example.com" -> "https://example.com/").
/// URLs with an existing path, query, or fragment are left unchanged.
pub fn normalize_url(url: &str) -> String {
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

/// Extract the domain from a URL, stripping the "www." prefix if present.
pub fn extract_domain(url: &str) -> Option<String> {
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

/// Parse hashtags from text content (e.g. "#rust" -> "rust").
pub fn parse_hashtags(content: &str) -> Vec<String> {
    let re = Regex::new(r"#(\w+)").unwrap();
    re.captures_iter(content)
        .map(|cap| cap[1].to_lowercase())
        .collect()
}

/// Calculate frecency score based on frequency of use and recency.
/// Higher score = more frequently and recently used.
pub fn calculate_frecency(frequency: u32, last_used: &str) -> f64 {
    let now = Utc::now();
    let last_used_time = chrono::DateTime::parse_from_rfc3339(last_used)
        .unwrap_or_else(|_| now.into())
        .with_timezone(&Utc);

    let days_since_use = (now - last_used_time).num_days() as f64;
    let decay_factor = 1.0 / (1.0 + days_since_use / 7.0);

    frequency as f64 * 10.0 * decay_factor
}

/// Generate a unique tag ID in format: tag_{timestamp}_{random9}
pub fn generate_tag_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let uuid = uuid::Uuid::new_v4().to_string();
    let random = &uuid[0..9]; // First 9 chars of UUID
    format!("tag_{}_{}", timestamp, random)
}

/// Inject _sync metadata for a new item (save/create).
/// Sets createdBy, createdAt, modifiedBy, modifiedAt.
pub fn inject_sync_metadata_for_save(
    metadata: Option<serde_json::Value>,
    device_id: &str,
) -> serde_json::Value {
    let mut meta = match metadata {
        Some(v) if v.is_object() => v,
        _ => serde_json::json!({}),
    };
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
pub fn inject_sync_metadata_for_update(
    existing_metadata_str: Option<String>,
    device_id: &str,
) -> String {
    let mut meta: serde_json::Value = existing_metadata_str
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

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

/// Check if a string looks like a valid UUID (basic validation).
/// UUID format: 8-4-4-4-12 hex digits with hyphens.
pub fn is_valid_uuid(s: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_reader_html() {
        let html = r#"<div style="color: red" class="foo"><p>Hello</p><style>body{}</style></div>"#;
        let result = sanitize_reader_html(html);
        assert!(!result.contains("style="));
        assert!(!result.contains("class="));
        assert!(!result.contains("<style>"));
        assert!(result.contains("<p>Hello</p>"));
    }

    #[test]
    fn test_sanitize_strips_scripts() {
        let html = r#"<div><script>alert('xss')</script><p>Safe</p></div>"#;
        let result = sanitize_reader_html(html);
        assert!(!result.contains("<script>"));
        assert!(result.contains("<p>Safe</p>"));
    }

    #[test]
    fn test_sanitize_strips_event_handlers() {
        let html = r#"<div onclick="alert('xss')"><p>Content</p></div>"#;
        let result = sanitize_reader_html(html);
        assert!(!result.contains("onclick"));
    }

    #[test]
    fn test_normalize_url_bare_domain() {
        assert_eq!(normalize_url("https://example.com"), "https://example.com/");
        assert_eq!(normalize_url("http://example.com"), "http://example.com/");
    }

    #[test]
    fn test_normalize_url_with_path() {
        assert_eq!(normalize_url("https://example.com/path"), "https://example.com/path");
        assert_eq!(normalize_url("https://example.com/"), "https://example.com/");
    }

    #[test]
    fn test_normalize_url_no_scheme() {
        assert_eq!(normalize_url("example.com"), "example.com");
    }

    #[test]
    fn test_extract_domain() {
        assert_eq!(extract_domain("https://www.example.com/path"), Some("example.com".to_string()));
        assert_eq!(extract_domain("https://example.com"), Some("example.com".to_string()));
        assert_eq!(extract_domain("not a url"), None);
    }

    #[test]
    fn test_parse_hashtags() {
        let result = parse_hashtags("Hello #World #rust programming");
        assert_eq!(result, vec!["world", "rust"]);
    }

    #[test]
    fn test_parse_hashtags_empty() {
        let result = parse_hashtags("no hashtags here");
        assert!(result.is_empty());
    }

    #[test]
    fn test_calculate_frecency() {
        let now = Utc::now().to_rfc3339();
        let score = calculate_frecency(5, &now);
        // frequency 5 * 10.0 * decay(0 days) = 50.0
        assert!((score - 50.0).abs() < 1.0);
    }

    #[test]
    fn test_calculate_frecency_old_date() {
        // 30 days ago should have lower score
        let old = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let score = calculate_frecency(5, &old);
        assert!(score < 50.0);
        assert!(score > 0.0);
    }

    #[test]
    fn test_generate_tag_id() {
        let id = generate_tag_id();
        assert!(id.starts_with("tag_"));
        assert!(id.len() > 20);
    }

    #[test]
    fn test_generate_tag_id_unique() {
        let id1 = generate_tag_id();
        let id2 = generate_tag_id();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_inject_sync_metadata_for_save() {
        let meta = inject_sync_metadata_for_save(None, "device-123");
        let sync = meta.get("_sync").unwrap();
        assert_eq!(sync.get("createdBy").unwrap().as_str().unwrap(), "device-123");
        assert_eq!(sync.get("modifiedBy").unwrap().as_str().unwrap(), "device-123");
        assert!(sync.get("createdAt").unwrap().as_i64().is_some());
    }

    #[test]
    fn test_inject_sync_metadata_for_save_preserves_existing() {
        let existing = serde_json::json!({"title": "Test"});
        let meta = inject_sync_metadata_for_save(Some(existing), "device-123");
        assert_eq!(meta.get("title").unwrap().as_str().unwrap(), "Test");
        assert!(meta.get("_sync").is_some());
    }

    #[test]
    fn test_inject_sync_metadata_for_update() {
        let existing = serde_json::json!({
            "_sync": {
                "createdBy": "device-old",
                "createdAt": 1000
            }
        });
        let result = inject_sync_metadata_for_update(
            Some(serde_json::to_string(&existing).unwrap()),
            "device-new",
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let sync = parsed.get("_sync").unwrap();
        // createdBy preserved
        assert_eq!(sync.get("createdBy").unwrap().as_str().unwrap(), "device-old");
        // modifiedBy updated
        assert_eq!(sync.get("modifiedBy").unwrap().as_str().unwrap(), "device-new");
    }

    #[test]
    fn test_inject_sync_metadata_for_update_backfill() {
        // No existing _sync metadata — should backfill createdBy
        let result = inject_sync_metadata_for_update(None, "device-123");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let sync = parsed.get("_sync").unwrap();
        assert_eq!(sync.get("createdBy").unwrap().as_str().unwrap(), "device-123");
    }

    #[test]
    fn test_is_valid_uuid() {
        assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!is_valid_uuid("not-a-uuid"));
        assert!(!is_valid_uuid("default"));
        assert!(!is_valid_uuid(""));
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000")); // too short
    }
}
