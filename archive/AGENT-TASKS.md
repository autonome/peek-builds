# Open Tasks for Next Agent

## Task 1: iOS Webview — Set User-Agent to Fix Site Rejection

**Status:** Research complete, implementation needed

**Problem:** Inline webviews in the Tauri iOS app are rejected by YouTube, Reddit, and other sites. Wikipedia works fine.

**Root cause:** WKWebView's default User-Agent string is missing `Version/X.X` and `Safari/604.1` tokens that Safari includes. Sites server-side detect this absence and reject the webview.

**Solution:** Set `customUserAgent` on the inline WKWebView to match Safari's UA:

```
Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1
```

This is exactly what Firefox iOS, Brave iOS, Chrome iOS, and DuckDuckGo all do (all iOS browsers use WKWebView under the hood).

**Implementation options (ranked):**
1. **Tauri config:** `tauri.conf.json` supports `userAgent` per window — but may only apply to main window, not child webviews
2. **Tauri iOS Swift plugin:** Create a plugin with `load(webview:)` hook to set `customUserAgent` on inline WKWebView instances
3. **Wry's Rust API:** `WebViewBuilder::with_user_agent()` if creating webviews from Rust

**Additional settings needed on inline WKWebView:**
- `allowsInlineMediaPlayback = true` (for video on YouTube/Reddit)
- Don't register `WKScriptMessageHandler` on the content webview (or inject JS to clean up `window.webkit.messageHandlers`)

**Full research:** See research output at `/private/tmp/claude-501/-Users-dietrich-misc-mpeek-tmp-release-7140/tasks/aacd54a.output`

---

## Task 2: Notes with URLs — Open as Web Pages

**Status:** Not started

**Problem:** Note-type items containing URLs should be openable as web pages, using the same inline webview mechanism that URL-type items use.

**Implementation:** The mobile app frontend is in `backend/tauri-mobile/src/App.tsx`. Find how URL-type items trigger web page viewing and apply the same approach to note items that contain URLs.

---

## Build Notes Discovered

### Stale Rust Cache (CRITICAL)
- Changing `Cargo.toml` features (e.g., removing `custom-protocol`) does NOT invalidate the Tauri dependency's build cache
- `build-ios.sh --force` only recompiles the app crate, not dependencies
- **Must run `npm run clean:rust:full`** (from `backend/tauri-mobile/`) to clear dependency caches when changing features
- Symptom: blank white page in simulator (loads bundled assets instead of devUrl)
- Verify fix: check that `/target/aarch64-apple-ios-sim/debug/build/tauri-*/out/checked_features` does NOT contain `custom-protocol` for dev builds

### Dev Session Race Condition
- `dev-ios-sim.sh` launches the app BEFORE starting vite → WKWebView gets connection refused → blank page
- Workaround: run `npm run sim:launch` to relaunch after vite is up
- Should be fixed: start vite first, wait for ready, then launch app
