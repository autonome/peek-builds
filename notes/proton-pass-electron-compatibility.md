# Proton Pass Extension: Electron Integration

**Date**: 2026-03-18 (updated from 2026-02-19)
**Proton Pass version**: 1.34.2 (from Chrome Web Store)
**Electron version**: 40.0.0 (Chromium 144)
**Manifest version**: MV3

---

## Status: Working — Enabled by Default

Proton Pass is installed at `chrome-extensions/proton-pass/` and enabled by default. All previously identified API blockers have been resolved via polyfills. Passkey/WebAuthn support is enabled via main-world script injection.

---

## Extension Profile

| Property | Value |
|----------|-------|
| Size | ~20 MB (includes WASM crypto modules) |
| License | GPLv3 |
| Manifest | V3 (service worker background) |
| Content scripts | orchestrator.js (all frames, ISOLATED world), webauthn.js (MAIN world) |
| Popup | popup.html |
| Settings | settings.html (options_ui) |
| Offscreen doc | offscreen.html (clipboard operations) |
| WASM modules | 5 files (~2.4 MB) for crypto (argon2, nacl, pqc, pass-core) |

---

## How It Works

### Extension loading
- `backend/electron/chrome-extensions.ts` discovers extensions in `chrome-extensions/`
- Extensions are loaded via `session.loadExtension()` into the profile session
- The profile session is the same session used by page webviews, so content scripts inject correctly
- Proton Pass was removed from `DISABLED_BY_DEFAULT` — it loads automatically

### Content script injection
- `orchestrator.js` injects into all frames in the ISOLATED world (Electron handles this natively)
- This script manages form detection, autofill icon injection, and communication with the service worker
- The autofill icons in form fields work because orchestrator.js runs in the isolated world and can manipulate the page DOM

### Passkey/WebAuthn support
- `webauthn.js` needs to run in the MAIN world to override `navigator.credentials.create()` and `.get()`
- **Electron ignores `"world": "MAIN"` in manifest content scripts** — this is a known limitation
- **Solution**: `backend/electron/entry.ts` reads `webauthn.js` at startup, then injects it via `webContents.executeJavaScript()` on `dom-ready` for http/https webviews
- `executeJavaScript()` runs in the main world, so the `navigator.credentials` overrides are visible to page scripts
- Injection is conditional: only runs when `isChromeExtensionLoaded('proton-pass')` returns true
- Timing: `dom-ready` is sufficient because WebAuthn calls happen on user interaction (button clicks), not at page load
- Communication chain: webauthn.js (MAIN world) → orchestrator.js (ISOLATED world) via `window.postMessage` → service worker via `chrome.runtime.sendMessage`
- Falls back to native WebAuthn if Proton Pass orchestrator isn't connected (5s timeout)

### Chrome API polyfills
All previously missing APIs are now polyfilled in `backend/electron/chrome-api-polyfills/`:

| API | Polyfill | How |
|-----|----------|-----|
| `chrome.alarms` | `alarms.js` | Node.js `setTimeout`/`setInterval` with persistent tracking |
| `chrome.storage.session` | `storage-session.js` | In-memory storage, cleared on app quit |
| `chrome.webNavigation` | `webnavigation.js` | Electron `webContents` navigation events forwarded to extension |
| `chrome.offscreen` | `offscreen.js` | Electron `clipboard` module for copy/paste |
| `chrome.permissions` | `permissions.js` | All permissions granted via `setPermissionCheckHandler` |

Polyfills are injected via `webContents.executeJavaScript()` on `dom-ready` (line ~344 of `chrome-extensions.ts`).

---

## Known Limitations

1. **MAIN world content scripts**: Only `webauthn.js` needs this, and it's handled by the manual injection in `entry.ts`. If future Chrome extensions need MAIN world scripts, the same pattern can be applied.

2. **Native WebAuthn**: Electron on macOS does not support the native `navigator.credentials` API. This doesn't matter for Proton Pass because it handles passkeys entirely within the extension — it doesn't need the browser's native implementation.

3. **User must log in**: Proton Pass requires authentication via Proton account. The popup (`popup.html`) is accessible via Peek's extension UI infrastructure.

4. **WASM CSP**: The extension's CSP includes `'wasm-unsafe-eval'` for its crypto modules. This works in Electron.

---

## Files

| File | Purpose |
|------|---------|
| `chrome-extensions/proton-pass/` | Unpacked extension files |
| `backend/electron/chrome-extensions.ts` | Extension loading, polyfill injection, enabled/disabled config |
| `backend/electron/chrome-api-polyfills/` | Chrome API polyfills (alarms, storage.session, webNavigation, offscreen, permissions) |
| `backend/electron/entry.ts` | WebAuthn main-world injection via `executeJavaScript()` |
| `notes/proton-pass-electron-compatibility.md` | This document |
