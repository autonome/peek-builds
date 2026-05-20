# Android Build Support Plan

Comprehensive plan for adding Android build support to the Peek mobile app, which currently builds only for iOS via Tauri 2.x.

> **Status (2026-05-19): much of this plan is implemented; sections below describe a historical starting point rather than current code.** Verified done at audit time:
>
> - Phase 1.1 (cfg-gate iOS FFI) — every caller of `webview_plugin_*`, `get_*_path`, `is_app_store_build` in `src-tauri/src/lib.rs` is `#[cfg(target_os = "ios")]` guarded, with `#[cfg(not(target_os = "ios"))]` fallbacks. No linker errors expected.
> - Phase 1.2 (Android storage fallback) — `get_container_path()` in `lib.rs` has a non-iOS branch using HOME/data dir.
> - Phase 1.3 (`build.rs` ios-only Objective-C compile) — already conditional on `target.contains("ios")`.
> - Phase 1.4 (Cargo.toml `cdylib`) — `crate-type = ["staticlib", "cdylib", "rlib"]` already in place.
> - Phase 1.6 / Phase 5 (build scripts) — `build-android.sh`, `dev-android.sh`, `build-android-release.sh`, `dev-both.sh` all exist, with BUILD_NUMBER flow, custom-protocol via `TAURI_ANDROID_FEATURES`, and emulator auto-boot.
> - Modern toolchain in place: Gradle 8.14.3, AGP 8.11.0, Kotlin 1.9.25, compileSdk 36, NDK auto-discovered (currently 27.0.x).
>
> Open gaps (real, not stale): Phase 4 (Android share target — no `ACTION_SEND` intent filter), cross-workspace `.so` cache parallel to `scripts/ios-cache.sh`, and any drift that surfaces from the actual `npx tauri android build --debug` attempt. Treat the section bodies below as historical reference, not a current to-do list.

---

## Table of Contents

1. [Current iOS Architecture Summary](#current-ios-architecture-summary)
2. [Prerequisites and Setup](#prerequisites-and-setup)
3. [Phase 1: Basic Android Build](#phase-1-basic-android-build)
4. [Phase 2: Platform Abstraction Layer](#phase-2-platform-abstraction-layer)
5. [Phase 3: Native Android WebView Plugin](#phase-3-native-android-webview-plugin)
6. [Phase 4: Android Share Target](#phase-4-android-share-target)
7. [Phase 5: Build Scripts and CI](#phase-5-build-scripts-and-ci)
8. [Feature Parity Checklist](#feature-parity-checklist)
9. [Risk Assessment](#risk-assessment)

---

## Current iOS Architecture Summary

### Build Pipeline

The iOS build is a multi-stage process that bypasses `cargo tauri build` (which fails on iOS due to Swift FFI symbol linking):

1. **Frontend**: Vite builds React app to `dist/`
2. **Rust**: `cargo build --lib --target aarch64-apple-ios-sim --features custom-protocol` produces `libpeek_save_lib.a`
3. **Xcode**: Links `libapp.a` (renamed Rust lib) with Swift sources, resolving FFI symbols at final link time
4. **Deploy**: `xcrun simctl install` (simulator) or `xcodebuild -sdk iphoneos` (device)

Key scripts:
- `build-ios.sh` -- simulator debug build (target: `aarch64-apple-ios-sim`)
- `build-release.sh` -- device release build (target: `aarch64-apple-ios`)
- `dev-ios-sim.sh` -- full dev loop with HMR

### Platform-Specific Code in Rust (`lib.rs`, 6322 lines)

**iOS FFI extern declarations (lines 56-63):**
```rust
#[cfg(target_os = "ios")]
extern "C" {
    fn webview_plugin_open(url: *const c_char, item_id: *const c_char) -> bool;
    fn webview_plugin_close();
    fn webview_plugin_open_inline(url: *const c_char, top_offset: f64, item_id: *const c_char) -> bool;
    fn webview_plugin_open_inline_html(html: *const c_char, top_offset: f64, base_url: *const c_char) -> bool;
    fn webview_plugin_close_inline();
}
```

**iOS-only native bridge extern declarations (lines 328-334):**
```rust
extern "C" {
    fn get_app_group_container_path() -> *const c_char;
    fn get_documents_path() -> *const c_char;
    fn get_icloud_documents_path() -> *const c_char;
    fn get_system_is_dark_mode() -> i32;
    fn is_app_store_build() -> i32;
}
```
These are NOT `#[cfg(target_os = "ios")]` guarded -- they will cause linker errors on Android.

**`#[cfg(target_os = "ios")]` blocks appear in these Tauri commands:**
- `open_native_webview` (line 2901)
- `close_native_webview` (line 2931)
- `open_inline_webview` (line 2945)
- `close_inline_webview` (line 2970)
- `open_inline_webview_html` (line 3099)

All have `#[cfg(not(target_os = "ios"))]` fallback blocks that are no-ops.

**FFI functions exported from Rust to Swift (no cfg guard):**
- `track_webview_navigation` (line 68) -- `#[no_mangle] pub extern "C"`
- `track_navigation_free` (line 88) -- `#[no_mangle] pub extern "C"`

### Native iOS Layer

| File | Purpose | Lines |
|------|---------|-------|
| `AppGroupBridge.m` | Objective-C bridge for App Group, Documents, iCloud paths, dark mode detection, App Store build detection | 113 |
| `WebviewPlugin.swift` | WKWebView controller (modal + inline), navigation tracking via Rust FFI | 397 |
| `ShareViewController.swift` | Full share extension with its own SQLite DB (GRDB), sync, UI | ~2500+ |
| `main.mm` | C++ entry point calling `ffi::start_app()` | 7 |
| `bindings.h` | Header declaring `start_app()` | 8 |

### Cargo.toml

```toml
[lib]
name = "peek_save_lib"
crate-type = ["staticlib", "rlib"]

[dependencies]
tauri = { version = "2", features = [] }
rusqlite = { version = "0.32", features = ["bundled"] }
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
# ... other deps

[build-dependencies]
tauri-build = { version = "2", features = [] }
cc = "1.0"

[features]
custom-protocol = ["tauri/custom-protocol"]
```

### `build.rs`

Currently compiles `AppGroupBridge.m` only for iOS targets:
```rust
fn main() {
    let target = std::env::var("TARGET").unwrap();
    if target.contains("ios") {
        cc::Build::new()
            .file("AppGroupBridge.m")
            .compile("app_group_bridge");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    tauri_build::build()
}
```

### `tauri.conf.json`

```json
{
  "identifier": "com.dietrich.peek-mobile",
  "bundle": {
    "iOS": {
      "developmentTeam": "TXZTDLL5LC"
    }
  }
}
```

No `android` section exists yet.

---

## Prerequisites and Setup

### Required Software

1. **Android Studio** (latest stable, Arctic Fox or newer)
2. **Android SDK** (API level 24+ for Tauri 2.x minimum, recommend targeting API 34+)
3. **Android NDK** (version 28+ recommended for 16KB page alignment requirement for Google Play)
4. **Rust Android targets**:
   ```bash
   rustup target add aarch64-linux-android
   rustup target add armv7-linux-androideabi
   rustup target add i686-linux-android
   rustup target add x86_64-linux-android
   ```
5. **JDK 17+** (required by modern Gradle)
6. **Tauri CLI** (already installed: `@tauri-apps/cli` ^2.10.0)

### Environment Variables

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/<version>"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

### Initialization Command

```bash
cd apps/mobile
npx tauri android init
```

This generates `src-tauri/gen/android/` with:
- Gradle project structure (`build.gradle.kts`, `settings.gradle`)
- `app/src/main/` with `AndroidManifest.xml`
- Kotlin main activity extending Tauri's `TauriActivity`
- `app/src/main/jniLibs/` directory for native `.so` libraries

**Complexity: LOW** -- Tauri handles most of the scaffolding.

---

## Phase 1: Basic Android Build

**Goal:** Get a minimal build that compiles and launches on Android, even without native webview or share features.

### 1.1 Platform-Guard the Native Bridge FFI

The biggest blocker: `extern "C"` declarations for iOS-only functions (`get_app_group_container_path`, `get_documents_path`, etc.) are NOT guarded by `#[cfg(target_os = "ios")]`. They will cause linker errors on Android immediately.

**Changes to `lib.rs`:**

```rust
// Wrap iOS-only extern blocks
#[cfg(target_os = "ios")]
extern "C" {
    fn get_app_group_container_path() -> *const c_char;
    fn get_documents_path() -> *const c_char;
    fn get_icloud_documents_path() -> *const c_char;
    fn get_system_is_dark_mode() -> i32;
    fn is_app_store_build() -> i32;
}
```

Then every function that calls these (`get_container_path()`, `get_docs_path()`, `get_icloud_path()`, `is_production_build()`, `restore_from_documents()`, `backup_app_group_to_documents()`) must either:
- Be wrapped in `#[cfg(target_os = "ios")]` with Android alternatives, OR
- Use a platform abstraction trait

**Complexity: MEDIUM** -- These functions are called pervasively throughout the 6300-line lib.rs. Approximately 15-20 call sites need modification.

### 1.2 Android Storage Path Implementation

iOS uses App Group containers for shared storage between app and extension. Android equivalent:

```rust
#[cfg(target_os = "android")]
fn get_container_path() -> Option<PathBuf> {
    // On Android, use the app's internal files directory
    // Tauri provides this via the PathResolver API, or via JNI
    // Simplest approach: use std::env for the app data dir
    // Android apps get: /data/data/<package>/files/
    dirs::data_dir().or_else(|| {
        std::env::var("HOME").ok().map(PathBuf::from)
    })
}
```

However, the cleanest approach is to use **Tauri's path resolver** (`app.path().app_data_dir()`), which would require refactoring `get_container_path()` to accept an `AppHandle` parameter. This is a moderate refactor since the function is called from many places, including static contexts.

**Alternative**: Use JNI to call Android's `Context.getFilesDir()` from Rust, similar to how `AppGroupBridge.m` calls iOS Foundation APIs.

**Complexity: MEDIUM-HIGH** -- Storage path resolution touches the entire data layer.

### 1.3 Update `build.rs`

```rust
fn main() {
    let target = std::env::var("TARGET").unwrap();
    if target.contains("ios") {
        cc::Build::new()
            .file("AppGroupBridge.m")
            .compile("app_group_bridge");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    // Android: no Objective-C compilation needed
    // JNI bridge is handled by Tauri's Android runtime

    tauri_build::build()
}
```

**Complexity: LOW** -- Already conditional, just needs Android to be a no-op path.

### 1.4 Update `Cargo.toml`

```toml
[lib]
name = "peek_save_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
#                          ^^^^^^^ needed for Android .so output
```

Android requires `cdylib` (dynamic library) instead of iOS's `staticlib`.

**Complexity: LOW**

### 1.5 Update `tauri.conf.json`

Add Android bundle configuration:

```json
{
  "bundle": {
    "iOS": {
      "developmentTeam": "TXZTDLL5LC"
    },
    "android": {
      "minSdkVersion": 24
    }
  }
}
```

**Complexity: LOW**

### 1.6 Create `build-android.sh`

New build script analogous to `build-ios.sh`:

```bash
#!/bin/bash
# Build Rust library for Android (debug)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building frontend..."
npm run build

echo "Building for Android..."
cd "$SCRIPT_DIR"
npx tauri android build --debug
# Or for specific target:
# cargo build --lib --target aarch64-linux-android --features custom-protocol
```

However, unlike iOS where we bypass `cargo tauri build` due to Swift FFI linking, on Android the standard `tauri android build` / `tauri android dev` commands may work since Android uses JNI (dynamic linking via `cdylib`) rather than static linking with native source compilation at Xcode link time.

**Recommended approach:** Try `npx tauri android dev` and `npx tauri android build` first. Only create custom build scripts if the standard Tauri commands have issues.

**Complexity: LOW-MEDIUM**

---

## Phase 2: Platform Abstraction Layer

**Goal:** Refactor iOS-specific code into a clean platform abstraction so iOS and Android share the same Tauri command implementations.

### 2.1 Storage Abstraction

Create a platform module:

```rust
// In lib.rs or a new platform.rs module

#[cfg(target_os = "ios")]
mod platform {
    use std::path::PathBuf;
    use std::ffi::CStr;
    use std::os::raw::c_char;

    extern "C" {
        fn get_app_group_container_path() -> *const c_char;
        fn get_documents_path() -> *const c_char;
        fn get_icloud_documents_path() -> *const c_char;
        fn get_system_is_dark_mode() -> i32;
        fn is_app_store_build() -> i32;
    }

    pub fn get_container_path() -> Option<PathBuf> { /* existing iOS impl */ }
    pub fn get_docs_path() -> Option<PathBuf> { /* existing iOS impl */ }
    pub fn is_dark_mode() -> bool { /* existing iOS impl */ }
    pub fn is_production_build() -> bool { /* existing iOS impl */ }
}

#[cfg(target_os = "android")]
mod platform {
    use std::path::PathBuf;

    pub fn get_container_path() -> Option<PathBuf> {
        // Android: use app-specific internal storage
        // /data/data/com.dietrich.peek-mobile/files/
        std::env::var("HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                // Fallback: Tauri sets TMPDIR or similar env vars
                Some(PathBuf::from("/data/data/com.dietrich.peek-mobile/files"))
            })
    }

    pub fn get_docs_path() -> Option<PathBuf> {
        // Android: external files dir for user-accessible files
        // /storage/emulated/0/Android/data/com.dietrich.peek-mobile/files/
        get_container_path()
    }

    pub fn is_dark_mode() -> bool {
        // Will need JNI call to Android's Configuration.uiMode
        // Or use Tauri's theme detection plugin
        false // placeholder
    }

    pub fn is_production_build() -> bool {
        // Check BuildConfig.DEBUG via JNI or compile-time flag
        !cfg!(debug_assertions)
    }
}
```

Then replace all calls to the old functions with `platform::get_container_path()`, etc.

**Complexity: HIGH** -- This is the largest refactoring task. The `get_container_path()` function is called from:
- `get_profiles_config_path()`
- `get_db_path()`
- `load_profile_config_from_file()`
- `save_profile_config()`
- `migrate_old_profile_config()`
- `restore_from_documents()`
- `backup_app_group_to_documents()`
- `open_inline_webview_html()` (for offline content)
- Multiple sync and offline content functions

### 2.2 Dark Mode Detection

iOS: Calls `get_system_is_dark_mode()` via Objective-C bridge.
Android: Needs JNI call or Tauri plugin.

Options:
1. **JNI from Rust**: Call `Resources.getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK`
2. **Tauri plugin**: Use `tauri-plugin-os` or a custom plugin that exposes theme info
3. **JavaScript-side detection**: `window.matchMedia('(prefers-color-scheme: dark)')` -- simplest, move detection to frontend

**Recommendation:** Move dark mode detection to the frontend. The Rust `is_dark_mode` command is only used by the frontend anyway.

**Complexity: LOW** (if moved to frontend)

### 2.3 Backup/Restore System

iOS-specific features that need Android equivalents:
- `backup_app_group_to_documents()` -- backs up to Documents folder visible in Finder
- `restore_from_documents()` -- restores from `.restore` files

**Android equivalent:**
- Use `Environment.getExternalStoragePublicDirectory()` or scoped storage for backups
- Or implement backup via Android's Auto Backup / `BackupAgent`
- Simpler: Use the app's external files directory (`Context.getExternalFilesDir()`) which is visible via USB file transfer

**Complexity: MEDIUM** -- Conceptually similar, but Android scoped storage adds complexity.

---

## Phase 3: Native Android WebView Plugin

**Goal:** Replicate the iOS `WebviewPlugin.swift` functionality on Android.

### iOS WebView Features to Replicate

1. **Modal webview** (`webview_plugin_open`): Opens a URL in a sheet-style WKWebView with back/forward/share buttons
2. **Inline webview** (`webview_plugin_open_inline`): Adds a WKWebView as a subview at a given top offset
3. **Inline HTML webview** (`webview_plugin_open_inline_html`): Loads HTML string (for offline reader mode)
4. **Navigation tracking**: Calls back into Rust via `track_webview_navigation` FFI when user navigates
5. **Close functions**: Dismisses modal or removes inline webview

### Android Implementation Options

**Option A: Tauri Plugin with Kotlin (Recommended)**

Create a Tauri plugin that exposes the webview functionality:

```
plugins/
  webview-plugin/
    android/
      src/main/kotlin/com/dietrich/peek/WebviewPlugin.kt
    src/
      lib.rs  (Rust plugin interface)
```

The Kotlin side would use Android's `WebView` class:

```kotlin
class WebviewPlugin(private val activity: Activity) {
    private var currentWebView: WebView? = null

    fun openModal(url: String, itemId: String): Boolean {
        // Create a Dialog or new Activity with a WebView
        val dialog = Dialog(activity, android.R.style.Theme_NoTitleBar_Fullscreen)
        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = TrackingWebViewClient(itemId)
        webView.loadUrl(url)
        dialog.setContentView(webView)
        dialog.show()
        return true
    }

    fun openInline(url: String, topOffset: Double, itemId: String): Boolean {
        // Add WebView as a child view to the root layout
        // Position it below topOffset using layout params
        // ...
        return true
    }

    fun openInlineHtml(html: String, topOffset: Double, baseUrl: String): Boolean {
        // webView.loadDataWithBaseURL(baseUrl, html, "text/html", "UTF-8", null)
        return true
    }
}
```

**Option B: JNI from Rust (Complex, Not Recommended)**

Calling Android APIs directly from Rust via JNI is possible but extremely verbose and fragile. The Tauri plugin approach is cleaner.

**Option C: Use Existing Tauri Plugin**

Check if `tauri-plugin-webview` or similar community plugins exist. As of Tauri 2.x, there is no official inline webview plugin for Android. Custom implementation needed.

### Navigation Tracking on Android

On iOS, the Swift WebviewPlugin calls `track_webview_navigation` via C FFI (`@_silgen_name`). On Android, the Kotlin plugin would invoke the Tauri command system:

```kotlin
inner class TrackingWebViewClient(private val itemId: String) : WebViewClient() {
    override fun onPageFinished(view: WebView, url: String) {
        // Call Rust via Tauri's invoke system
        // Or use JNI to call track_webview_navigation directly
    }
}
```

The cleanest approach: expose `track_webview_navigation` as a Tauri command (it already has the logic), then call it from Kotlin through Tauri's plugin bridge.

**Complexity: HIGH** -- This is the most complex native feature. The inline webview (adding a native view on top of the Tauri webview at a specific offset) is particularly tricky on Android due to how Android handles view hierarchy differently from iOS.

---

## Phase 4: Android Share Target

**Goal:** Replicate the iOS Share Extension on Android.

### iOS Share Extension Overview

The iOS share extension (`ShareViewController.swift`, ~2500 lines) is a **standalone process** with:
- Its own SQLite database connection (via GRDB library)
- Full schema management and migrations
- Profile configuration support (reads `profiles.json` from App Group)
- Sync capability (pushes to server immediately after save)
- Rich UI with tag input, recent tags, item type detection
- Shared storage via App Group container

### Android Equivalent: Share Target Activity

Android uses `<intent-filter>` declarations in `AndroidManifest.xml`:

```xml
<activity
    android:name=".ShareReceiverActivity"
    android:label="Peek"
    android:theme="@style/Theme.Transparent"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="text/plain" />
    </intent-filter>
    <intent-filter>
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="image/*" />
    </intent-filter>
</activity>
```

### Architecture Decision: Separate Activity vs In-App Handling

**Option A: Separate Kotlin Activity (Matches iOS Architecture)**

Create a standalone `ShareReceiverActivity.kt` that:
- Runs in the app's process (unlike iOS extension which is separate)
- Opens SQLite database directly (via Rust FFI or Android's SQLite API)
- Shows a quick save UI
- Syncs if configured

Advantage: Can share the Rust database code via JNI.
Disadvantage: Complex Kotlin UI development.

**Option B: Deep Link to Tauri WebView (Simpler)**

The share activity receives the intent, extracts the URL/text, then deep-links into the Tauri app with the data as a query parameter. The frontend handles the save UI.

```kotlin
class ShareReceiverActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = intent
        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
        // Launch main app with shared data
        val launchIntent = Intent(this, TauriActivity::class.java)
        launchIntent.putExtra("shared_url", sharedText)
        startActivity(launchIntent)
        finish()
    }
}
```

Advantage: Much simpler, reuses existing frontend UI.
Disadvantage: Slower (launches full app), no offline save capability.

**Recommendation:** Start with Option B for initial release, then iterate to Option A for feature parity with iOS.

### Database Sharing

On iOS, the App Group container allows both the main app and the share extension to access the same SQLite database. On Android, since the share activity runs in the same process as the main app, this is simpler -- they share the same file system and can use the same database path.

**Complexity: MEDIUM** (Option B) / **VERY HIGH** (Option A with full parity)

---

## Phase 5: Build Scripts and CI

### New Scripts for `package.json`

```json
{
  "scripts": {
    "dev:android": "./dev-android.sh",
    "build:android": "./build-android.sh",
    "build:android:release": "./build-android-release.sh",
    "clean:android": "cd src-tauri && rm -rf target/aarch64-linux-android target/armv7-linux-androideabi target/i686-linux-android target/x86_64-linux-android 2>/dev/null; echo 'Android build cache cleaned'"
  }
}
```

### `dev-android.sh`

```bash
#!/bin/bash
# Start Android emulator dev environment with HMR
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Build frontend
npm run build

# Start Tauri Android dev (handles emulator, HMR, etc.)
npx tauri android dev
```

### `build-android.sh` (Debug)

```bash
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

npm run build
npx tauri android build --debug
```

### `build-android-release.sh`

```bash
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

npm run build

# Build APK/AAB for release
npx tauri android build --apk
# Or for App Bundle: npx tauri android build --aab
```

**Complexity: LOW** -- Tauri's Android toolchain is more integrated than the iOS one.

---

## Feature Parity Checklist

| Feature | iOS Status | Android Plan | Complexity | Phase |
|---------|-----------|-------------|------------|-------|
| Core app (save URLs, tags, search) | Done | Works via Tauri webview (no native code needed) | LOW | 1 |
| SQLite database | Done (rusqlite bundled) | Same Rust code, different storage path | MEDIUM | 1 |
| Profile management | Done | Same Rust code once storage abstracted | MEDIUM | 2 |
| Sync (bidirectional) | Done | Same Rust code (reqwest works on Android) | LOW | 1 |
| Dark mode detection | Done (ObjC bridge) | Move to frontend JS | LOW | 2 |
| Modal native webview | Done (WKWebView) | Android WebView via Tauri plugin | HIGH | 3 |
| Inline native webview | Done (WKWebView subview) | Android WebView overlay | HIGH | 3 |
| Offline reader mode | Done (inline HTML webview) | Android WebView `loadDataWithBaseURL` | MEDIUM | 3 |
| Navigation tracking in webview | Done (Swift-to-Rust FFI) | Kotlin-to-Rust via Tauri plugin bridge | MEDIUM | 3 |
| Share extension (full UI) | Done (2500-line Swift) | Share target activity (deep link first) | MEDIUM-HIGH | 4 |
| Share extension (direct DB save) | Done | Kotlin activity with JNI to Rust | VERY HIGH | 4+ |
| App Group shared storage | Done (iOS App Group) | Not needed (same process on Android) | N/A | -- |
| iCloud backup | Done | Google Drive backup (separate feature) | HIGH | Future |
| Documents backup (Finder) | Done | USB file transfer via external storage | MEDIUM | 2 |
| App Store build detection | Done | BuildConfig.DEBUG check | LOW | 2 |
| Custom URL scheme | Not impl | Intent filters | LOW | 4 |
| HMR dev workflow | Done (dev-ios-sim.sh) | `tauri android dev` (built-in) | LOW | 1 |
| Build caching | Done (ios-cache.sh) | Gradle handles caching natively | N/A | -- |

---

## Risk Assessment

### High Risk

1. **Storage path refactoring** -- The `get_container_path()` function is deeply embedded throughout lib.rs. Changing its signature or behavior could introduce subtle bugs in database access, profile management, and offline content. Requires thorough testing.

2. **Inline native webview on Android** -- Adding a native Android `WebView` on top of Tauri's own `WebView` at a precise pixel offset is architecturally complex. May need Tauri plugin system changes or a different UX approach on Android (e.g., using a bottom sheet instead of inline overlay).

3. **rusqlite bundled SQLite on Android** -- The `bundled` feature compiles SQLite from source. Cross-compiling C code for Android targets can have NDK version compatibility issues. Test early.

### Medium Risk

4. **reqwest + rustls-tls on Android** -- Network requests via reqwest with rustls should work on Android, but certificate handling may differ. Test HTTPS connections to the sync server on Android early.

5. **Share extension feature parity** -- The iOS share extension is extremely feature-rich (2500+ lines). Achieving full parity on Android will take significant effort. The deep-link approach (Phase 4, Option B) provides a faster but less polished path.

### Low Risk

6. **Frontend code** -- The React frontend is platform-agnostic. It runs in a WebView on both platforms. No changes expected.

7. **Tauri command system** -- All `#[tauri::command]` functions work identically on iOS and Android once the platform abstraction layer is in place.

---

## Recommended Implementation Order

### Sprint 1 (1-2 weeks): Minimal Viable Android Build
- Run `npx tauri android init`
- Add `#[cfg(target_os = "ios")]` guards to all native bridge extern declarations
- Create minimal `#[cfg(target_os = "android")]` storage path implementation
- Update `Cargo.toml` crate-type to include `cdylib`
- Update `build.rs` to skip Objective-C compilation on Android
- Get the app launching on Android emulator with basic functionality (save, list, search)
- Create `build-android.sh` and `dev-android.sh`

### Sprint 2 (1-2 weeks): Platform Abstraction
- Extract `platform` module with iOS/Android implementations
- Refactor all `get_container_path()` call sites
- Implement Android dark mode detection (frontend-based)
- Implement Android backup mechanism
- Test sync functionality on Android

### Sprint 3 (2-3 weeks): Native WebView Plugin
- Create Tauri plugin project structure for webview
- Implement modal webview (Android Dialog + WebView)
- Implement inline webview (FrameLayout overlay)
- Implement offline reader HTML rendering
- Wire up navigation tracking

### Sprint 4 (1-2 weeks): Share Target
- Add intent filter to AndroidManifest.xml
- Create `ShareReceiverActivity.kt` (deep-link approach)
- Test share from Chrome, other apps
- Optional: upgrade to full standalone share UI

### Sprint 5 (1 week): Polish and CI
- Add Android build to CI pipeline
- Code signing setup for Google Play
- Test on multiple Android versions (API 24-34)
- Performance testing and optimization

**Total estimated timeline: 6-10 weeks** for a single developer, depending on depth of native webview implementation.

---

## References

- [Tauri 2.x Prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri Android Development](https://v2.tauri.app/develop/)
- [Tauri Google Play Distribution](https://v2.tauri.app/distribute/google-play/)
- [Tauri Mobile Plugin Development](https://v2.tauri.app/develop/plugins/develop-mobile/)
- [Tauri Android Code Signing](https://v2.tauri.app/distribute/sign/android/)
- [Android Intents and Intent Filters](https://developer.android.com/guide/components/intents-filters)
- [Tauri Android Architecture (DeepWiki)](https://deepwiki.com/tauri-apps/tauri/7.3-android-development-and-build)
