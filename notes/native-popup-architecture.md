# Native Popup Support - Architecture Research

## Why the Current Model Breaks

Peek's single-window model opens each web page in its own frameless BrowserWindow
containing a `<webview>` tag. When a site calls `window.open()`, Peek intercepts it
in `setWindowOpenHandler` and creates a completely new BrowserWindow. This provides
excellent isolation but breaks the browser's native popup model:

1. **No V8 link**: Each BrowserWindow has its own renderer process and V8 context.
   The popup's `window.opener` is `null` because there is no shared JavaScript heap
   between the opener and popup BrowserWindows.

2. **No shared renderer process**: In a regular browser, a popup opened via
   `window.open()` shares a renderer process with the opener (same-origin popups).
   This enables synchronous cross-window access (`opener.document`, `opener.someVar`).
   Electron's BrowserWindow model does not support this.

3. **No browsing context group**: Browsers maintain a "browsing context group" that
   links opener and popup windows. Electron's webview tag and BrowserWindow don't
   participate in this grouping.

## What Native Popup Support Would Require

### Option A: Parent/Child BrowserWindow Relationship

Use Electron's `parent` option when creating the popup BrowserWindow:

```javascript
const popup = new BrowserWindow({
  parent: openerWindow,
  // ...
});
```

This establishes a parent-child relationship at the OS window level, but does NOT
create a V8 link. `window.opener` would still be `null`. Benefits are limited to
window lifecycle management (child closes when parent closes).

**Verdict**: Insufficient. Does not solve the core problem.

### Option B: Shared Renderer Process via `webContents.setWindowOpenHandler` + `action: 'allow'`

Instead of denying the popup and creating our own BrowserWindow, allow Electron to
create the popup window natively:

```javascript
guestWebContents.setWindowOpenHandler(({ url }) => {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      frame: false,
      // Peek's styling options
    }
  };
});
```

This would let Electron/Chromium create the popup with a proper `window.opener` link.
However:
- We lose control over the window's page container (no navbar, no webview wrapping)
- The popup would be a raw BrowserWindow, not a Peek page container
- Resize, drag, and other Peek chrome would be missing
- The popup would not be tracked in Peek's window manager or IZUI system
- Cannot set profile partition on the popup's webContents

**Verdict**: Could work for OAuth popups specifically, but requires significant
integration work to make the raw popup feel like a Peek window.

### Option C: MessageChannel API

Use Electron's `MessageChannelMain` to establish a direct communication channel
between the opener and popup BrowserWindows:

```javascript
const { port1, port2 } = new MessageChannelMain();
openerWindow.webContents.postMessage('port', null, [port1]);
popupWindow.webContents.postMessage('port', null, [port2]);
```

This enables bidirectional messaging without console.log bridging. However:
- The ports are on the BrowserWindow's host webContents, not the webview guest
- Still need to bridge from port -> host page.js -> webview guest
- Does not provide `window.opener` natively; still requires a shim
- Eliminates the console.log hack but adds MessageChannel complexity

**Verdict**: Cleaner transport than console.log but same fundamental architecture.

### Option D: Webview-to-Webview IPC via Main Process (Current Approach, Enhanced)

The current IPC bridge approach (Level 3/4 in the implementation) is architecturally
the simplest. Enhancements for native-level fidelity:

- Use `ipcRenderer.sendToHost()` from preload scripts inside webview guests
  (requires custom preload for webview guests, which Peek currently doesn't use)
- Establish bidirectional channels with unique IDs per popup relationship
- Implement `window.opener` as a full Proxy that tunnels all property access

**Verdict**: Most pragmatic. Covers 95% of real-world OAuth flows.

## Estimated Effort

| Approach | Effort | Coverage | Risk |
|----------|--------|----------|------|
| Option A (parent/child) | 1 day | 5% | Low |
| Option B (allow popup) | 2-3 weeks | 90% | High - breaks Peek UX model |
| Option C (MessageChannel) | 1 week | 70% | Medium |
| Option D (IPC bridge, enhanced) | 3-5 days | 85% | Low |

**Recommended path**: Continue with Option D (IPC bridge). The current Level 3/4
implementation covers the critical `postMessage` path that 95% of OAuth flows use.
For the remaining 5% (synchronous cross-window DOM access), there is no solution
short of Option B which fundamentally conflicts with Peek's isolation model.

## Trade-offs vs Current Isolation Model

### What we gain from isolation:
- Each page runs in its own renderer process (crash isolation)
- Pages cannot access each other's DOM (security)
- Clean window lifecycle management (each window is independent)
- Consistent Peek chrome (navbar, resize, drag) on every page
- Profile-based session isolation

### What we lose from isolation:
- `window.opener` is null (breaks popup OAuth)
- `sessionStorage` not shared (breaks some CSRF flows)
- `window.open()` return value is null in the opener (can't call `popup.close()`)
- Cross-window synchronous JS access impossible

### Alternative: Tab-Based UI for OAuth-Heavy Workflows

For users who frequently use sites with popup OAuth (Google Workspace, Microsoft 365,
GitHub), a tab-based mode could group related pages into a single BrowserWindow with
multiple webview tags. This would still not provide `window.opener` natively (separate
webview tags are separate renderer processes), but could enable:

- Shared `sessionStorage` via synthetic bridging at the host level
- Tighter popup lifecycle management
- Visual grouping of related auth flows

This is a significant UX departure from Peek's current model and would require
extensive design work. Estimated effort: 4-6 weeks.

## Conclusion

The IPC bridge approach (Levels 3-4) is the right solution for the foreseeable future.
It solves the most common OAuth failure mode (`postMessage` routing) with minimal
architectural changes. A native popup solution would require either:
1. Allowing Electron to create raw popup windows (Option B) at the cost of Peek's
   consistent UX, or
2. Implementing a tab-based UI mode, which is a multi-week project with significant
   design implications.

Neither is justified when the IPC bridge covers the vast majority of real-world cases.
