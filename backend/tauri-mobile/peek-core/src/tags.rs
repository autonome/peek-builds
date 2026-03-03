use rusqlite::{params, Connection};
use std::collections::HashSet;

use crate::helpers::{calculate_frecency, generate_tag_id, extract_domain};
use crate::types::TagStats;

/// Get or create a tag by name. Returns the tag ID.
/// Updates frequency and frecency if the tag already exists.
pub fn get_or_create_tag(conn: &Connection, tag_name: &str) -> Result<String, String> {
    let now = chrono::Utc::now().to_rfc3339();

    match conn.query_row(
        "SELECT id FROM tags WHERE name = ?",
        params![tag_name],
        |row| row.get::<_, String>(0),
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

            Ok(id)
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

            Ok(new_tag_id)
        }
    }
}

/// Link a tag to an item. Ignores if association already exists.
pub fn link_tag_to_item(conn: &Connection, item_id: &str, tag_id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
        params![item_id, tag_id, &now],
    )
    .map_err(|e| format!("Failed to link tag: {}", e))?;
    Ok(())
}

/// Add multiple tags to an item (get_or_create + link for each).
pub fn add_tags_to_item(conn: &Connection, item_id: &str, tag_names: &[String]) -> Result<(), String> {
    for tag_name in tag_names {
        let tag_id = get_or_create_tag(conn, tag_name)?;
        link_tag_to_item(conn, item_id, &tag_id)?;
    }
    Ok(())
}

/// Get the current tag names for an item.
pub fn get_item_tag_names(conn: &Connection, item_id: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name FROM tags t
             JOIN item_tags it ON t.id = it.tag_id
             WHERE it.item_id = ?",
        )
        .map_err(|e| format!("Failed to prepare existing tags query: {}", e))?;

    let tags: HashSet<String> = stmt
        .query_map(params![item_id], |row| row.get(0))
        .map_err(|e| format!("Failed to query existing tags: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(tags)
}

/// Result of a tag update operation — reports which tags were added/removed.
#[derive(Debug, Clone)]
pub struct TagChanges {
    pub tags_added: Vec<String>,
    pub tags_removed: Vec<String>,
}

/// Update tags for an item: compute diff, remove old, add new.
/// Returns the tags that were added and removed (for side-effect handling).
pub fn update_item_tags(conn: &Connection, item_id: &str, new_tags: &[String]) -> Result<TagChanges, String> {
    let existing_tags = get_item_tag_names(conn, item_id)?;
    let new_tags_set: HashSet<String> = new_tags.iter().cloned().collect();

    let tags_to_add: Vec<String> = new_tags_set.difference(&existing_tags).cloned().collect();
    let tags_to_remove: Vec<String> = existing_tags.difference(&new_tags_set).cloned().collect();

    // Remove tags that were removed
    for tag_name in &tags_to_remove {
        conn.execute(
            "DELETE FROM item_tags WHERE item_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            params![item_id, tag_name],
        )
        .map_err(|e| format!("Failed to remove tag association: {}", e))?;
    }

    // Add tags that are new
    for tag_name in &tags_to_add {
        let tag_id = get_or_create_tag(conn, tag_name)?;
        conn.execute(
            "INSERT INTO item_tags (item_id, tag_id, created_at) VALUES (?, ?, ?)",
            params![item_id, &tag_id, &chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Failed to link tag: {}", e))?;
    }

    Ok(TagChanges {
        tags_added: tags_to_add,
        tags_removed: tags_to_remove,
    })
}

/// Get all tags ordered by frecency score (descending).
pub fn get_tags_by_frecency(conn: &Connection) -> Result<Vec<TagStats>, String> {
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

/// Get tags sorted by frecency with domain affinity boost.
/// Tags used on URLs from the same domain get a 2x score multiplier.
pub fn get_tags_by_frecency_for_url(conn: &Connection, url: &str) -> Result<Vec<TagStats>, String> {
    let domain = match extract_domain(url) {
        Some(d) => d,
        None => return get_tags_by_frecency(conn),
    };

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

    let domain_tag_ids: HashSet<String> = domain_stmt
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::ensure_database_initialized;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_database_initialized(&conn).unwrap();
        conn
    }

    #[test]
    fn test_get_or_create_tag_new() {
        let conn = setup_db();
        let id = get_or_create_tag(&conn, "test-tag").unwrap();
        assert!(id.starts_with("tag_"));

        // Verify it exists
        let name: String = conn
            .query_row("SELECT name FROM tags WHERE id = ?", params![&id], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "test-tag");
    }

    #[test]
    fn test_get_or_create_tag_existing() {
        let conn = setup_db();
        let id1 = get_or_create_tag(&conn, "test-tag").unwrap();
        let id2 = get_or_create_tag(&conn, "test-tag").unwrap();
        assert_eq!(id1, id2);

        // Frequency should be 2
        let freq: u32 = conn
            .query_row("SELECT frequency FROM tags WHERE id = ?", params![&id1], |row| row.get(0))
            .unwrap();
        assert_eq!(freq, 2);
    }

    #[test]
    fn test_add_tags_to_item() {
        let conn = setup_db();
        let now = chrono::Utc::now().to_rfc3339();

        // Create an item
        conn.execute(
            "INSERT INTO items (id, type, url, created_at, updated_at) VALUES ('item1', 'url', 'https://test.com', ?1, ?1)",
            params![&now],
        ).unwrap();

        add_tags_to_item(&conn, "item1", &["tag1".to_string(), "tag2".to_string()]).unwrap();

        let tags = get_item_tag_names(&conn, "item1").unwrap();
        assert!(tags.contains("tag1"));
        assert!(tags.contains("tag2"));
        assert_eq!(tags.len(), 2);
    }

    #[test]
    fn test_update_item_tags() {
        let conn = setup_db();
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO items (id, type, url, created_at, updated_at) VALUES ('item1', 'url', 'https://test.com', ?1, ?1)",
            params![&now],
        ).unwrap();

        // Start with tag1, tag2
        add_tags_to_item(&conn, "item1", &["tag1".to_string(), "tag2".to_string()]).unwrap();

        // Update to tag2, tag3 (removes tag1, adds tag3)
        let changes = update_item_tags(&conn, "item1", &["tag2".to_string(), "tag3".to_string()]).unwrap();
        assert!(changes.tags_added.contains(&"tag3".to_string()));
        assert!(changes.tags_removed.contains(&"tag1".to_string()));
        assert!(!changes.tags_added.contains(&"tag2".to_string())); // unchanged

        let tags = get_item_tag_names(&conn, "item1").unwrap();
        assert!(tags.contains("tag2"));
        assert!(tags.contains("tag3"));
        assert!(!tags.contains("tag1"));
    }

    #[test]
    fn test_get_tags_by_frecency() {
        let conn = setup_db();
        get_or_create_tag(&conn, "alpha").unwrap();
        get_or_create_tag(&conn, "beta").unwrap();
        // Call beta again to boost its frecency
        get_or_create_tag(&conn, "beta").unwrap();

        let tags = get_tags_by_frecency(&conn).unwrap();
        assert_eq!(tags.len(), 2);
        // beta should be first (higher frecency)
        assert_eq!(tags[0].name, "beta");
        assert_eq!(tags[1].name, "alpha");
    }

    #[test]
    fn test_get_tags_by_frecency_for_url() {
        let conn = setup_db();
        let now = chrono::Utc::now().to_rfc3339();

        // Create two items on same domain
        conn.execute(
            "INSERT INTO items (id, type, url, created_at, updated_at) VALUES ('item1', 'url', 'https://example.com/page1', ?1, ?1)",
            params![&now],
        ).unwrap();

        // Add domain-specific tag
        add_tags_to_item(&conn, "item1", &["domain-tag".to_string()]).unwrap();

        // Add a generic tag (not domain-specific)
        get_or_create_tag(&conn, "generic").unwrap();

        let tags = get_tags_by_frecency_for_url(&conn, "https://example.com/page2").unwrap();
        assert_eq!(tags.len(), 2);
        // domain-tag should be boosted (2x) and appear first
        assert_eq!(tags[0].name, "domain-tag");
    }
}
