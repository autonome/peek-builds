//! Automated mobile-client e2e for per-bucket sync routing.
//!
//! This is the coverage that the existing JS suites do NOT provide: the
//! `sync-three-way` test simulates clients with raw HTTP, and `sync-e2e` drives
//! the *desktop* TS client. Neither exercises the real mobile Rust client's
//! per-bucket push gating — the exact logic behind the Dev-1-of-7 bug.
//!
//! Here we boot the real server (apps/server, `node index.js`) against a temp
//! data dir and drive the REAL peek-core surface — `PeekStore::get_items_to_push`,
//! `mark_item_synced`, `get_pending_sync_count` — doing actual HTTP pushes to two
//! server buckets. The thin POST/GET glue mirrors src-tauri's `push_to_server`.
//!
//! The legacy-row backfill heal is a pure-DB operation covered by the unit test
//! `sync::tests::test_backfill_synced_profile_id_heals_legacy_rows`; here we assert
//! its practical effect end-to-end: items already synced to a bucket do NOT
//! re-push to that same bucket (no mass re-push), yet DO push to a new bucket.
//!
//! Marked `#[ignore]` because it spawns node + needs the server installed; run via
//! `yarn test:sync:e2e:mobile` (cargo test ... -- --ignored).

use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

use peek_core::PeekStore;
use serde_json::Value;

const PORT: u16 = 3461;
const API_KEY: &str = "test-e2e-mobile-key";

fn base_url() -> String {
    format!("http://localhost:{}", PORT)
}

/// Kills the server when the test ends, even on a panicking assert.
struct ServerGuard(Child);
impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `curl` one request; returns (http_status, body). peek-core has no HTTP client
/// (it is the lean mobile core), so the test shells out rather than add a dep.
fn curl(method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let url = format!("{}{}", base_url(), path);
    let mut args: Vec<String> = vec![
        "-s".into(),
        "-w".into(),
        "\n%{http_code}".into(),
        "-X".into(),
        method.into(),
        "-H".into(),
        format!("Authorization: Bearer {}", API_KEY),
        "-H".into(),
        "Content-Type: application/json".into(),
    ];
    if let Some(b) = body {
        args.push("-d".into());
        args.push(b.into());
    }
    args.push(url);

    let out = Command::new("curl")
        .args(&args)
        .output()
        .expect("failed to run curl");
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    let split = s.rfind('\n').unwrap_or(0);
    let (body_part, code_part) = s.split_at(split);
    let code: u16 = code_part.trim().parse().unwrap_or(0);
    (code, body_part.to_string())
}

fn json(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or(Value::Null)
}

/// POST /profiles -> the new bucket's UUID.
fn create_bucket(name: &str) -> String {
    let (code, body) = curl("POST", "/profiles", Some(&format!("{{\"name\":\"{}\"}}", name)));
    assert_eq!(code, 200, "create bucket {} failed: {}", name, body);
    json(&body)["profile"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("no profile id in {}", body))
        .to_string()
}

/// Count items the server holds for a bucket.
fn server_count(bucket: &str) -> usize {
    let (code, body) = curl("GET", &format!("/items?profile={}", bucket), None);
    assert_eq!(code, 200, "GET items failed: {}", body);
    json(&body)["items"].as_array().map(|a| a.len()).unwrap_or(0)
}

/// Push every item peek-core considers pending for `bucket`, exactly as
/// src-tauri's push loop does: pick the send id, POST it, then mark it synced to
/// that bucket. Returns how many were pushed.
fn push_pending(store: &PeekStore, bucket: &str) -> usize {
    let items = store.get_items_to_push(bucket).expect("get_items_to_push");
    let mut pushed = 0;
    for item in &items {
        let content = item.url.clone().or_else(|| item.content.clone()).unwrap_or_default();
        let send_id = if item.sync_id.is_empty() { &item.id } else { &item.sync_id };
        let payload = serde_json::json!({
            "type": item.item_type,
            "content": content,
            "tags": [],
            "syncId": send_id,
        });
        let (code, body) = curl(
            "POST",
            &format!("/items?profile={}", bucket),
            Some(&payload.to_string()),
        );
        assert_eq!(code, 200, "POST item failed: {}", body);
        let server_id = json(&body)["id"].as_str().expect("server id").to_string();
        store
            .mark_item_synced(&item.id, &server_id, bucket)
            .expect("mark_item_synced");
        pushed += 1;
    }
    pushed
}

fn start_server(data_dir: &str) -> ServerGuard {
    let server_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../server");
    let child = Command::new("node")
        .arg("index.js")
        .current_dir(server_dir)
        .env("PORT", PORT.to_string())
        .env("DATA_DIR", data_dir)
        .env("API_KEY", API_KEY)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn server (is apps/server installed? `npm install --prefix apps/server`)");
    let guard = ServerGuard(child);

    // Wait for health.
    for _ in 0..50 {
        let (code, _) = curl("GET", "/", None);
        if code == 200 {
            return guard;
        }
        sleep(Duration::from_millis(200));
    }
    panic!("server did not become ready on port {}", PORT);
}

#[test]
#[ignore = "e2e: spawns node server; run via `yarn test:sync:e2e:mobile`"]
fn e2e_per_bucket_routing() {
    let data_dir = tempfile::tempdir().expect("server temp dir");
    let _server = start_server(data_dir.path().to_str().unwrap());

    let bucket_a = create_bucket("Default");
    let bucket_b = create_bucket("Development");
    assert_ne!(bucket_a, bucket_b);

    let db = tempfile::tempdir().expect("db temp dir");
    let db_path = db.path().join("peek.db");
    let store = PeekStore::new(db_path.to_str().unwrap()).expect("PeekStore");

    // Three local items, none synced yet.
    store.save_url("https://e2e.example.com/one", &[], None).unwrap();
    store.save_url("https://e2e.example.com/two", &[], None).unwrap();
    store.save_url("https://e2e.example.com/three", &[], None).unwrap();

    // Push to bucket A.
    assert_eq!(push_pending(&store, &bucket_a), 3, "all 3 should push to A");
    assert_eq!(server_count(&bucket_a), 3, "server bucket A should hold 3");

    // No mass re-push: already synced to A => nothing pending for A.
    assert_eq!(store.get_pending_sync_count(&bucket_a).unwrap(), 0);
    assert!(store.get_items_to_push(&bucket_a).unwrap().is_empty());

    // THE REPRO: rebinding to bucket B, those same items must be pending for B
    // (pre-fix they were skipped because synced_at was already set -> the
    // Dev-1-of-7 bug). All 3 must re-push to the new bucket.
    assert_eq!(
        store.get_pending_sync_count(&bucket_b).unwrap(),
        3,
        "items synced to A must be pending for B"
    );
    assert_eq!(push_pending(&store, &bucket_b), 3, "all 3 should push to B");

    // Buckets are isolated and both now hold the items; B is settled.
    assert_eq!(server_count(&bucket_b), 3, "server bucket B should hold 3");
    assert_eq!(server_count(&bucket_a), 3, "bucket A unchanged (isolation)");
    assert_eq!(store.get_pending_sync_count(&bucket_b).unwrap(), 0, "B settled");
}

/// Push every pending item, classifying each response exactly as src-tauri's loop
/// does (the bug-2 path): synced / parked-on-permanent-4xx / retry. Returns
/// (pushed, rejected, failed).
fn push_classified(store: &PeekStore, bucket: &str) -> (usize, usize, usize) {
    use peek_core::sync::PushOutcome;
    let items = store.get_items_to_push(bucket).expect("get_items_to_push");
    let (mut pushed, mut rejected, mut failed) = (0usize, 0usize, 0usize);
    for item in &items {
        let content = item.url.clone().or_else(|| item.content.clone()).unwrap_or_default();
        let send_id = if item.sync_id.is_empty() { &item.id } else { &item.sync_id };
        let payload = serde_json::json!({
            "type": item.item_type, "content": content, "tags": [], "syncId": send_id,
        });
        let (code, body) = curl(
            "POST",
            &format!("/items?profile={}", bucket),
            Some(&payload.to_string()),
        );
        let parsed_id = json(&body)["id"].as_str().map(|s| s.to_string());
        match peek_core::sync::classify_push_response(code, &body, parsed_id.as_deref()) {
            PushOutcome::Synced(id) => {
                store.mark_item_synced(&item.id, &id, bucket).unwrap();
                pushed += 1;
            }
            PushOutcome::Rejected(reason) => {
                store.mark_item_sync_failed(&item.id, &reason).unwrap();
                rejected += 1;
            }
            PushOutcome::Retry(_) | PushOutcome::VersionMismatch(_) => failed += 1,
        }
    }
    (pushed, rejected, failed)
}

#[test]
#[ignore = "e2e: spawns node server; run via `yarn test:sync:e2e:mobile`"]
fn e2e_poison_item_is_parked() {
    let data_dir = tempfile::tempdir().expect("server temp dir");
    let _server = start_server(data_dir.path().to_str().unwrap());
    let bucket = create_bucket("Default");

    let db = tempfile::tempdir().expect("db temp dir");
    let store = PeekStore::new(db.path().join("peek.db").to_str().unwrap()).expect("PeekStore");

    // One good item + one the server permanently rejects: a text item with empty
    // content -> POST /items returns 400. This is the "won't clear" poison case.
    store.save_url("https://e2e.example.com/ok", &[], None).unwrap();
    store.save_text("", None, None).unwrap();

    let (pushed, rejected, failed) = push_classified(&store, &bucket);
    assert_eq!(pushed, 1, "the good item syncs");
    assert_eq!(rejected, 1, "the empty-content item is rejected and parked");
    assert_eq!(failed, 0, "no transient failures");

    // The good item is on the server; the poison one is not.
    assert_eq!(server_count(&bucket), 1, "server holds only the good item");

    // The fix: the parked item no longer counts as pending (badge clears) and stops
    // being re-pushed; it is surfaced separately as a sync failure instead.
    assert_eq!(store.get_pending_sync_count(&bucket).unwrap(), 0, "pending clears");
    assert!(store.get_items_to_push(&bucket).unwrap().is_empty(), "not re-pushed");
    assert_eq!(store.get_sync_failed_count().unwrap(), 1, "1 item surfaced as failed");

    // A second sync attempt does nothing (no re-hammering the poison item).
    assert_eq!(push_classified(&store, &bucket), (0, 0, 0), "nothing to retry");
}

/// The server must STORE every syncable type, not just url/text/tagset/image — the
/// fix for the 5000+-pending bug (e9dce12a) where entity/series/feed items 400'd
/// forever. Drives the real server directly (no peek-core, which doesn't create
/// entities): a metadata-only entity and a feed both round-trip with a 200 + GET.
#[test]
#[ignore = "e2e: spawns node server; run via `yarn test:sync:e2e:mobile`"]
fn e2e_server_accepts_derived_types() {
    let data_dir = tempfile::tempdir().expect("server temp dir");
    let _server = start_server(data_dir.path().to_str().unwrap());
    let bucket = create_bucket("Default");

    // entity: payload lives in metadata, content is null. Pre-fix this returned 400.
    let entity = r#"{"type":"entity","content":null,"tags":[],"metadata":{"entityType":"person","name":"Ada"},"syncId":"ent-1"}"#;
    let (code, body) = curl("POST", &format!("/items?profile={}", bucket), Some(entity));
    assert_eq!(code, 200, "server should accept an entity now: {}", body);

    // feed: another previously-rejected derived type.
    let feed = r#"{"type":"feed","content":"https://example.com/feed.xml","tags":[],"syncId":"feed-1"}"#;
    let (code, body) = curl("POST", &format!("/items?profile={}", bucket), Some(feed));
    assert_eq!(code, 200, "server should accept a feed now: {}", body);

    // Both are stored and returned on GET.
    assert_eq!(server_count(&bucket), 2, "server holds the entity and the feed");

    // A genuinely-unknown type is still rejected (the allowlist still has teeth).
    let bad = r#"{"type":"nonsense","content":"x","tags":[],"syncId":"bad-1"}"#;
    let (code, _) = curl("POST", &format!("/items?profile={}", bucket), Some(bad));
    assert_eq!(code, 400, "unknown types are still rejected");
}
