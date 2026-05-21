# YouTube Blank White Screen — Diagnosis & Fix Plan

## Summary

Opening `https://youtube.com/watch?v=Z4cS2Ivg2-M` in the Peek Electron app results in a blank white screen. After thorough investigation, the **most likely root cause** is the Ghostery adblocker (`@ghostery/adblocker-electron`) blocking critical YouTube resources. A secondary contributing factor may be `WebContentsForceDark` (if dark mode is set to "force"). There are also several minor issues around permission handling and error visibility.

---

## Architecture Context

The page loading pipeline:

1. `window-open` IPC handler in `ipc.ts` (~line 2000) detects `https://` URL, sets `useCanvas = true`
2. Creates a frameless, transparent `BrowserWindow` with `webviewTag: true`
3. Loads `peek://app/page/index.html?url=<encoded-youtube-url>&x=...&y=...&width=...&height=...`
4. `page.js` runs `initWebview()`:
   - Fetches session partition via `api.profiles.getPartition()` (returns `persist:<profileId>`)
   - Sets `webview.partition = "persist:<profileId>"`
   - Sets `webview.src = targetUrl` (the YouTube URL)
5. The `<webview>` tag in `index.html` (line 358): `<webview id="content" allowpopups></webview>`

**Electron version**: 40.x (Chromium 144) — this is a January 2026 release, well within YouTube's supported Chromium range.

---

## Root Cause Analysis

### 1. CRITICAL: Adblocker Blocking YouTube Resources

**File**: `/Users/dietrich/misc/mpeek/apps/desktop/main/adblocker.ts`

The app uses `@ghostery/adblocker-electron` with `ElectronBlocker.fromPrebuiltAdsAndTracking()` (line 52). This loads EasyList + EasyPrivacy filter lists, which are known to aggressively block YouTube's ad-serving infrastructure.

**The problem**: YouTube's modern SPA architecture loads its video player, UI components, and video streams through URLs that overlap with ad-serving patterns. The Ghostery blocker intercepts requests at the Electron session level (`session.webRequest`), which means it affects the webview's session directly. When critical YouTube JS bundles or API calls are blocked, the page renders as blank white — YouTube's error handling shows nothing rather than a broken page.

**Specifically blocked resources likely include**:
- `googlevideo.com` streaming URLs (may match tracker patterns)
- YouTube's analytics/tracking endpoints that are required for the player to initialize
- `play.google.com` or `accounts.google.com` auth-related requests
- Various `*.doubleclick.net` or `*.googlesyndication.com` requests that YouTube's player JS depends on before rendering

The blocker attaches to the profile session (line 105-106: `getProfileSession()` then `enableBlockingInSession()`), which is the same session the webview uses (set via `webview.partition = "persist:<profileId>"`).

**Evidence**: There are no permission handlers (`setPermissionRequestHandler`, `setPermissionCheckHandler`) configured anywhere in the codebase — the only request interception is the adblocker's `webRequest` hooks.

### 2. MODERATE: WebContentsForceDark May Corrupt YouTube Rendering

**File**: `/Users/dietrich/misc/mpeek/apps/desktop/main/entry.ts` (lines 679-686)

If the user's dark mode setting is `"force"`, the app applies:
```
app.commandLine.appendSwitch('enable-features',
  'WebContentsForceDark:inversion_method/cielab_based/image_behavior/none'
);
```

This Chromium feature inverts colors at the compositing level. YouTube has its own dark mode, and forcing dark mode via Chromium's compositor can cause rendering conflicts — potentially resulting in white-on-white or invisible content. YouTube's custom web components and shadow DOMs may not respond well to forced color inversion.

### 3. MINOR: No User-Agent Override

There is **no** user-agent manipulation anywhere in the codebase for webview content. The default Electron user-agent string is used, which includes `Electron/40.x.x` in the UA string. YouTube does check user agents and sometimes blocks or degrades service for non-standard browsers.

However, Electron 40 / Chromium 144's default UA should be recent enough that YouTube wouldn't outright block it. YouTube's UA detection primarily targets very old Chromium versions or obvious bot strings.

**The default Electron UA looks like**:
```
Mozilla/5.0 (Macintosh; Intel Mac OS X ...) AppleWebKit/537.36 (KHTML, like Gecko) Peek/0.0.1 Chrome/144.0.7559.60 Electron/40.0.0 Safari/537.36
```

The `Electron/40.0.0` token is unusual but YouTube typically doesn't block based on this.

### 4. MINOR: `allowServiceWorkers: false` on the `peek://` Scheme

**File**: `/Users/dietrich/misc/mpeek/apps/desktop/main/protocol.ts` (line 81)

The custom protocol `peek://` has `allowServiceWorkers: false`. However, this only affects pages loaded via the `peek://` scheme — the webview loads `https://youtube.com` which uses its own session and the standard HTTPS scheme. Service workers for YouTube should work normally within the webview's session.

**This is NOT the cause** — confirmed by the fact that `allowServiceWorkers` only applies to the scheme registration, not to the webview's guest content.

### 5. MINOR: Silent Error Swallowing

**File**: `/Users/dietrich/misc/mpeek/app/page/page.js` (lines 897-899)

```javascript
webview.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;  // ERR_ABORTED — normal for SPA navigations
  console.error('[page] Load failed:', e.errorCode, e.errorDescription);
});
```

The error is logged to console but never shown to the user. If YouTube's main frame fails to load, the user sees a blank white screen with no feedback. The `dom-ready` handler (line 903) also sets a white background as default when no page background is detected — masking the failure further.

### 6. NO DRM/Widevine Configuration

There is **no** Widevine CDM (Content Decryption Module) configuration anywhere in the codebase. Standard Electron does NOT include Widevine by default. However:

- YouTube's standard video playback does not require DRM for most content
- DRM is only needed for premium/purchased content and some music videos
- A regular YouTube watch page should play non-DRM content without Widevine
- The blank white screen is happening before video playback even begins (the entire page fails to render), so DRM is not the primary issue

### 7. NO Permission Handlers

There are no `setPermissionRequestHandler` or `setPermissionCheckHandler` calls anywhere in the Electron backend. This means:

- **Media autoplay**: Uses Electron's default behavior (generally allowed)
- **Notifications**: Uses default (generally denied)
- **Geolocation**: Uses default
- **Camera/Microphone**: Uses default (denied unless explicitly allowed)

For basic YouTube video watching, the lack of explicit permission handlers should not cause a blank page. YouTube doesn't require camera/mic/notification permissions for regular video playback.

---

## Fix Plan

### Fix 1: Add YouTube to Adblocker Allowlist (PRIMARY FIX)

Add domain-based exception handling to the adblocker for YouTube and its required domains.

**Option A — Per-site allowlist in adblocker.ts**:
```typescript
const ADBLOCKER_ALLOWLIST = [
  'youtube.com',
  'www.youtube.com',
  'googlevideo.com',
  'ytimg.com',
  'yt3.ggpht.com',
  'accounts.google.com',
];
```

Before enabling the blocker, configure request filtering to skip these domains.

**Option B — Disable adblocker entirely for YouTube domains**:
The `@ghostery/adblocker-electron` package supports custom filtering. Use the `isAllowlisted` callback or a custom filter rule like `@@||youtube.com^` and `@@||googlevideo.com^`.

**Option C — User-facing toggle per site**:
Add a "disable ad blocking for this site" button to the navbar, storing the setting per-domain.

### Fix 2: Improve Error Visibility

Modify `did-fail-load` handler in `page.js` to show a visible error state:

```javascript
webview.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;
  console.error('[page] Load failed:', e.errorCode, e.errorDescription);
  // Show error in navbar or overlay instead of silent white screen
  urlText.value = `Error ${e.errorCode}: ${e.errorDescription}`;
  show({ source: 'shortcut' });
});
```

### Fix 3: Guard Against WebContentsForceDark on Complex Sites

Consider either:
- Not applying `WebContentsForceDark` to webview content (only to peek:// internal pages)
- Adding a per-site override mechanism
- Using CSS `color-scheme` meta tag injection instead

### Fix 4: Set Standard User-Agent on Webview (Low Priority)

If YouTube does begin blocking, set a clean Chrome UA:

```javascript
// In page.js initWebview():
webview.useragent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36`;
```

This strips the `Electron` and `Peek` tokens.

### Fix 5: Add Permission Handlers (Low Priority)

For media-rich sites, add explicit permission handling on the profile session:

```typescript
profileSession.setPermissionRequestHandler((webContents, permission, callback) => {
  const allowedPermissions = ['media', 'mediaKeySystem', 'midi', 'pointerLock', 'fullscreen'];
  callback(allowedPermissions.includes(permission));
});
```

---

## Diagnostic Steps to Confirm

To verify the adblocker theory before implementing fixes:

1. **Quick test**: Temporarily disable the adblocker in settings, restart the app, and try YouTube again
2. **Console logging**: Add `DEBUG=1` and watch for `[adblocker] Blocked:` log lines when loading YouTube
3. **Network inspection**: Open DevTools on the webview guest (right-click the webview in the host page's DevTools, select "Inspect"), check the Network tab for blocked/failed requests
4. **Isolated test**: Create a test that loads YouTube in a webview with a fresh session (no adblocker), confirm it renders

---

## Files Referenced

| File | Role |
|------|------|
| `/Users/dietrich/misc/mpeek/app/page/page.js` | Webview creation, URL loading, error handling |
| `/Users/dietrich/misc/mpeek/app/page/index.html` | Page container with `<webview>` tag |
| `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` | Window-open handler, canvas setup, guest webContents |
| `/Users/dietrich/misc/mpeek/apps/desktop/main/session-partition.ts` | Session/partition setup |
| `/Users/dietrich/misc/mpeek/apps/desktop/main/main.ts` | App initialization, no permission handlers |
| `/Users/dietrich/misc/mpeek/apps/desktop/main/entry.ts` | `WebContentsForceDark` command-line switch |
| `/Users/dietrich/misc/mpeek/apps/desktop/main/protocol.ts` | `peek://` scheme registration (`allowServiceWorkers: false`) |
| `/Users/dietrich/misc/mpeek/apps/desktop/main/adblocker.ts` | Ghostery adblocker — primary suspect |
| `/Users/dietrich/misc/mpeek/package.json` | Electron 40.x / Chromium 144 |
