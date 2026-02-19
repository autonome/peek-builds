# Proton Pass Extension: Electron Compatibility Report

**Date**: 2026-02-19
**Proton Pass version**: 1.34.2 (from Chrome Web Store)
**Electron version**: 40.0.0 (Chromium 144)
**Manifest version**: MV3

---

## Status: Partially Working — Critical API Gaps

The Proton Pass extension has been downloaded, extracted, and placed in
`resources/chrome-extensions/proton-pass/`. Electron will load the extension
(it discovers it, registers it, and can show the popup), but **several Chrome
APIs required by Proton Pass are not implemented in Electron**, causing
runtime failures in core functionality.

---

## Extension Profile

| Property | Value |
|----------|-------|
| Size | ~20 MB (includes WASM crypto modules) |
| License | GPLv3 |
| Manifest | V3 (service worker background) |
| Content scripts | orchestrator.js (all frames), webauthn.js (MAIN world) |
| Popup | popup.html |
| Settings | settings.html (options_ui) |
| Offscreen doc | offscreen.html (clipboard operations) |
| WASM modules | 5 files (~2.4 MB) for crypto (argon2, nacl, pqc, pass-core) |

---

## API Compatibility Matrix

### Declared Permissions

| Permission | Electron Support | Impact |
|------------|-----------------|--------|
| `activeTab` | Partial | May work for basic tab access |
| `alarms` | **NOT SUPPORTED** | **CRITICAL** — session management, retry logic, scheduled tasks |
| `offscreen` | **NOT SUPPORTED** | **MODERATE** — clipboard read/write operations |
| `scripting` | Supported | Content script injection works |
| `storage` | `local` only (no `sync`, no `session`) | **HIGH** — extension uses `storage.session` for sensitive data |
| `unlimitedStorage` | Unknown | Storage quota may be limited |
| `webNavigation` | **NOT SUPPORTED** | **HIGH** — page navigation tracking for autofill |
| `webRequest` | Supported | Network request observation works |

### Chrome APIs Used in Code

| API | Usage | Electron Status |
|-----|-------|-----------------|
| `chrome.alarms` | 21 references — session timers, retry scheduling, worker activation | Not implemented |
| `chrome.offscreen` | 9 references — clipboard copy/paste via offscreen document | Not implemented |
| `chrome.webNavigation` | 7 references — page load detection for autofill injection | Not implemented |
| `chrome.webRequest` | 14 references — request monitoring | Supported |
| `chrome.runtime` | Messaging, extension lifecycle | Supported |
| `chrome.storage.session` | Sensitive data (auth tokens, session keys) | **NOT SUPPORTED** — only `storage.local` works |
| `chrome.tabs` | Tab management (via polyfill wrapper) | Partially supported |
| `chrome.action` | Badge text, popup, icon changes | Partially supported |
| `chrome.permissions` | Runtime permission requests | Not documented as supported |

---

## Critical Blockers

### 1. `chrome.alarms` (21 usages)
The extension relies heavily on alarms for:
- Session resume scheduling after auth failures
- Worker activation/reactivation
- Periodic cleanup and sync operations
- Authentication retry with backoff

Without alarms, the extension's service worker lifecycle management breaks
entirely. The service worker will start but cannot schedule any deferred work.

### 2. `chrome.storage.session` (used for auth tokens)
Proton Pass stores sensitive authentication data in `storage.session` (which
is encrypted and cleared when the browser closes). Electron only supports
`storage.local`. This means:
- Auth tokens would need to be stored in `storage.local` (less secure)
- Or authentication simply fails at runtime

### 3. `chrome.webNavigation` (7 usages)
Used to detect page navigations and trigger autofill form detection. Without
this, the extension cannot detect when a user navigates to a login page and
therefore cannot offer autofill suggestions.

### 4. `chrome.offscreen` (9 usages)
Used for clipboard operations (copy/paste passwords). Without this,
copy-to-clipboard functionality breaks. This is a usability issue but not a
complete blocker for login/autofill.

---

## What Will Work

1. **Extension loading** — Electron will load the unpacked extension from the directory
2. **Content script injection** — `orchestrator.js` will inject into pages
3. **Popup UI** — popup.html will render (Peek already has popup window support)
4. **Settings page** — settings.html will render
5. **Service worker** — background.js will start (Electron 40 + Chromium 144 supports MV3 service workers)
6. **WASM crypto** — WebAssembly modules should work with `wasm-unsafe-eval` CSP
7. **Basic messaging** — `chrome.runtime.sendMessage` / `onMessage` works

---

## What Will NOT Work

1. **Session management** — No `chrome.alarms` means no session refresh, no retry logic
2. **Autofill detection** — No `chrome.webNavigation` means no page change detection
3. **Clipboard** — No `chrome.offscreen` means no copy/paste passwords
4. **Secure session storage** — No `chrome.storage.session`
5. **Authentication flow** — Likely broken due to combination of missing alarms + session storage

---

## Possible Remediation Approaches

### Option A: Polyfill Missing APIs (Moderate Effort)
Implement shims for missing APIs in Electron's main process:

1. **`chrome.alarms`** — Implement using Node.js `setTimeout`/`setInterval` with persistent tracking
2. **`chrome.storage.session`** — Map to in-memory storage that clears on app quit
3. **`chrome.webNavigation`** — Listen to Electron's `webContents` navigation events and forward to extension
4. **`chrome.offscreen`** — Implement clipboard access via Electron's `clipboard` module

This would require modifying `backend/electron/chrome-extensions.ts` to inject
these polyfills into the extension's service worker context.

### Option B: Use electron-chrome-extensions Library (Lower Effort)
The [Polypane/electron-chrome-extensions](https://github.com/Polypane/electron-chrome-extensions)
fork provides broader API coverage including many of the missing APIs. This
would replace Electron's built-in `session.loadExtension()` with a more
complete implementation.

### Option C: Build a Custom Proton Pass Integration (High Effort, Best UX)
Instead of loading the browser extension, build a native Electron integration
that uses the Proton Pass API directly. This would provide:
- Native autofill without extension content scripts
- Direct clipboard integration
- Proper secure storage via Electron's safeStorage API

---

## Recommendation

**Option A (polyfills)** is the most pragmatic path. The four missing APIs
have well-defined behavior that can be shimmed:

1. `chrome.alarms` → `setTimeout`/`setInterval` in main process
2. `chrome.storage.session` → In-memory Map, cleared on quit
3. `chrome.webNavigation` → Electron `webContents` event forwarding
4. `chrome.offscreen` → `electron.clipboard` module

This approach keeps the extension unmodified and benefits from upstream
Proton Pass updates.

---

## File Locations

- Extension files: `resources/chrome-extensions/proton-pass/`
- Extension manifest: `resources/chrome-extensions/proton-pass/manifest.json`
- Extension manager: `backend/electron/chrome-extensions.ts`
- Prior research: `notes/research-bundled-web-extensions.md`

## Source

- Chrome Web Store ID: `ghmbeldphafepmbegfdlkpapadhbakde`
- GitHub source: https://github.com/ProtonMail/WebClients/tree/main/applications/pass-extension
