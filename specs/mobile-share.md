---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src/App.css, apps/mobile/src-tauri/src/lib.rs, apps/mobile/peek-core/src/offline.rs, apps/mobile/peek-core/src/lib.rs, apps/mobile/src-tauri/gen/android/app/src/main/java/com/dietrich/peek_mobile/MainActivity.kt]
depends-on: [mobile-header-and-quick-add]
---

# Mobile share: cache the page for items shared with the offline tag, share items out, report failed Android shares

Peek items `8dcc17de` (tagging offline in the share UI does not save the offline copy), `cfebb22a` (share an item out through the OS share sheet), `ccaae421` (Android share failures are silent).

## Problems

1. A URL shared into Peek and tagged `offline` in the share flow shows the tag but has no cached page. Applying the tag from inside the app does cache it.
2. Sharing only goes inward. An item cannot be sent out to another app.
3. When an Android share into Peek fails inside the Kotlin helpers, the app opens with nothing saved and nothing said.

## What the code does now

- Offline fetch: "offline" means the cached-page feature. The `offline` tag is configurable (`offline_tag` in the profile config, default "offline"). In-app tagging triggers `fetch_and_store_offline_content` from `src-tauri/src/lib.rs save_url`, and from the tag-update commands when the offline tag is added. The iOS share extension (`src-tauri/gen/apple/Peek/ShareViewController.swift`, `PeekCoreManager.saveUrl`) writes straight into the core database with its tags and never calls those commands, so no fetch happens. The Android share has no tag UI. Its drain in `App.tsx` (`handleIncoming`) calls `save_url` with `tags: []`. A frontend effect only checks cache status (`check_offline_content_batch`) for items already in the loaded list. It never fetches. `fetch_offline_content(item_id, url)` is the existing command, and `offlineFetchingIds` tracks in-flight fetches in the UI.
- Share-out: there is no share plugin (`package.json` has only the opener and store plugins; `Cargo.toml` has `tauri-plugin-opener`). Cards (`renderUrlItem`, `renderTextItem`, `renderImageItem`/`CardFooter` area) have `card-action-btn` buttons such as "Open in Safari". `get_image_data` supplies image bytes (the fullscreen viewer uses it).
- Android share-in: `MainActivity.kt handleShareIntent()` calls `appendText` and `appendImage`. Both catch `Exception` and only call `Log.e`. `appendImage` also returns silently when `contentResolver.openInputStream` returns null. They write the queue under `filesDir/.peek` (`pending_shares.txt`, `pending_share_images/`). `lib.rs pop_pending_shares` and `pop_pending_image_shares` drain it, resolving the folder with `get_container_path()`. `App.tsx` drains on mount and on `tauri://focus`.

## Decisions

- Offline fetch fix is app-side, not in the share extension (a share extension has tight memory and time limits). Add a Rust command `fetch_missing_offline_content` in `src-tauri/src/lib.rs` that asks the core for items with the offline tag and no `offline_content` row (new core query in `peek-core/src/offline.rs`, exposed from the core `lib.rs`), then fetches up to 10 per call, one after another, skipping silently on failure. `App.tsx` calls it on mount and on `tauri://focus`, alongside the share drain. Side effect: items whose earlier fetch failed are retried on later foregrounds, capped at 10 per call.
- Share-out ladder. First try `navigator.share` with feature detection (`navigator.canShare({ files })` for images), which iOS WKWebView supports. The Android System WebView may not expose it. If it is missing on Android, add a small `@JavascriptInterface` in `MainActivity.kt` that opens an `ACTION_SEND` chooser (a text/URL payload, and for images a file granted through an app FileProvider with `FLAG_GRANT_READ_URI_PERMISSION`). Record which path each platform used under `**Result**`. No new Tauri plugin dependency is added without approval.
- A URL item shares its URL, a text item its text, an image item the image file. The control is a share `card-action-btn` in each card's action row, so the editor is not needed.
- Android share failures: on a caught exception in `appendText` or `appendImage`, and on the null-stream return in `appendImage`, append one line `kind<TAB>reason` to `filesDir/.peek/pending_share_errors.txt` (`kind` is `text` or `image`; reason is `e.message` or "could not open the shared file"). Remove any partial blob and `.mime` file for that share. New command `pop_pending_share_errors` in `lib.rs` (same pattern as `pop_pending_shares`: read, delete, return lines). `App.tsx` drains it in the same `drain()` function and shows `showToast("Share failed: <reason>", "error")` per entry. Registered in the `invoke_handler` list. A successful share writes nothing, so it gets no error toast.
- The `READ_MEDIA_IMAGES` question is a finding, not a change. Record under `**Result**` whether real senders (Chrome, Gallery, Photos) hit the error path. Make no permission change.

## What changes

- `lib.rs` (`fetch_missing_offline_content`, `pop_pending_share_errors`, handler registration), `peek-core/src/offline.rs` plus the core `lib.rs` store method (the missing-content query), `MainActivity.kt` (error markers, and the share bridge if needed), `App.tsx` (the calls on mount and focus, the error drain and toast, share buttons and handler), `App.css` (button icon if needed).

## Tests to change

`peek-core/src/offline.rs` tests: the missing-content query returns an offline-tagged URL item with no cache row. It does not return one with a row. It does not return a non-URL item or a soft-deleted one.

## Verify

Worker runs and records:
1. `yarn mobile:build` succeeds.
2. `cargo test --manifest-path apps/mobile/peek-core/Cargo.toml` reports `0 failed`. Rust tests run only from the standing mobile workspace (`apps/mobile/CLAUDE.md`). If the worker is elsewhere, record "cargo test not run".
3. The Kotlin and `src-tauri` changes are not compiled on Linux. Record "needs Android and iOS build" under `**Result**`.

Manual check (no automated UI test). The worker cannot run it. Record under `**Result**` as awaiting a manual check by the account holder. A physical device gives a real share sheet and real senders.
1. `yarn mobile:ios:sim:run` (or `yarn mobile:android:dev`). In a browser, share an article URL into Peek and apply the `offline` tag before saving (iOS share extension). Wait for the save, then put the device in airplane mode and open the item's offline reader. Expected: cached article text, matching an item saved in-app with the same tag.
2. `yarn mobile:ios:device:run` on an iPhone, or `yarn mobile:android:dev` on an Android device. Share a URL item, a text item and an image item to another app (Messages, a notes app). Expected: the share sheet opens each time and the receiver gets the URL, the text and the image, not a placeholder.
3. Android only: share an image from a real third-party app (Chrome, Gallery or Photos). Note whether it saves. This answers the permission question.
4. Android only: force a failure (a sender that does not grant read permission on the URI, or a revoked grant). Expected: an error toast names the reason.
5. Android only: share plain text. Expected: the normal save toast and no error toast.

Note: `apps/mobile/CLAUDE.md` says a synthetic `adb am start` with a `content://media` URI fails with SecurityException even though real apps work. Do not conclude the image share is broken from a synthetic adb test.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Run one command per Bash call.
