# OAuth Flows in Peek

## Architecture Context

Peek opens each web page in its own frameless BrowserWindow containing a `<webview>` tag.
When a site calls `window.open()` for an OAuth popup, the `setWindowOpenHandler` in
`backend/electron/ipc.ts` intercepts it and creates a completely new, independent
BrowserWindow. This means the popup has no V8-level connection to the opener window.

## What Works

### Redirect-based OAuth (302 chains)
Redirect-based OAuth flows work correctly. When a site initiates OAuth by navigating
(via HTTP 302 redirects) through the identity provider and back, the entire flow happens
within the same webview. The webview's session/cookies are shared across all page windows
via the profile partition, so authentication state persists.

Examples that work out of the box:
- Google OAuth via redirect (most "Sign in with Google" implementations)
- GitHub OAuth via redirect
- Any flow that uses `location.href` or server-side redirects

### Cookies and session sharing
All webview instances share the same Electron session via the profile partition system
(`profiles:getPartition`). This means:
- Login cookies set in one window are available in another
- Session cookies persist across page windows
- Third-party cookie policies from Chromium still apply

## What Does NOT Work (Without Bridge)

### Popup-based OAuth (`window.open` + `postMessage`)
When a site opens an OAuth popup via `window.open()`, Peek's `setWindowOpenHandler`
creates a separate BrowserWindow. This breaks:

1. **`window.opener.postMessage()`** - The popup has no `window.opener` reference because
   the new BrowserWindow has a completely separate V8 context. OAuth providers that send
   the auth token back via `postMessage` to the opener will fail silently.

2. **`window.opener.closed`** - Cannot check if the opener window is still open.

3. **`window.opener.location.href`** - Cannot read the opener's URL for origin checks.

### `sessionStorage` sharing
`sessionStorage` is scoped to a browsing context (tab/window). Since Peek creates
separate BrowserWindows, `sessionStorage` is not shared between the opener and popup.
Some OAuth flows store CSRF tokens or nonces in `sessionStorage` and expect the popup
to read them.

## The Popup-to-Opener IPC Bridge (Level 3)

Peek implements a `window.opener` shim that bridges postMessage across BrowserWindows
using the console-message IPC pattern (same pattern used for webview mouse event bridging).

### How it works:
1. When `setWindowOpenHandler` creates a popup BrowserWindow, it records the
   opener-to-popup relationship in a `Map<popupWindowId, openerWindowId>`.
2. A `window.opener` shim is injected into the popup's webview guest on `dom-ready`.
3. When the popup calls `window.opener.postMessage(data, origin)`, the shim logs a
   special `__PEEK_OPENER_POSTMESSAGE__:{json}` message via `console.log`.
4. The popup's `page.js` picks up the console-message event and sends it via IPC
   (`opener-postmessage`) to the main process.
5. The main process looks up the opener window ID and forwards the message to it.
6. The opener's `page.js` receives the IPC message and dispatches a `MessageEvent`
   into its webview guest via `executeJavaScript`.

### Limitations of the bridge:
- Only `postMessage` is fully functional. `window.opener.close()`, `.closed`, and
  `.location.href` return static/approximate values.
- The bridge uses console.log as a transport, which means the message appears in
  devtools console output (filtered by the `__PEEK_` prefix).
- Timing: there is a small delay (~10-50ms) for the IPC round trip vs native postMessage.
- `sessionStorage` sharing is NOT solved by this bridge.

## Workarounds for Users

If an OAuth popup flow fails:

1. **Copy the URL**: When the popup opens, copy the OAuth URL from the new Peek window's
   navbar (Cmd+L) and open it in a regular browser to complete authentication. Then
   refresh the original page.

2. **Use redirect-based OAuth when available**: Many providers offer both popup and
   redirect flows. Look for a "Sign in" option that navigates the current page rather
   than opening a popup.

3. **Browser fallback**: For sites that heavily depend on popup OAuth (e.g., some
   enterprise SSO flows), open them in a regular browser first to establish the session,
   then visit in Peek where the cookies will often carry over.
