# iOS Webview Research: Inline vs Popup

Status: **Research Complete** | Priority: Active

## Overview

Currently iOS Peek opens pages in a fullscreen modal webview. This research explores more integrated UX patterns, specifically bottom sheet presentation.

## Current Implementation

**File:** `backend/tauri-mobile/src-tauri/gen/apple/Sources/peek-save/WebviewPlugin.swift`

- Presentation: `modalPresentationStyle = .fullScreen`
- Navigation: `UINavigationController` wrapping `EmbeddedWebViewController`
- Dismissal: "Done" button or back gesture
- WKWebView with inline media, back/forward gestures enabled

**Invocation Flow:**
```
React (App.tsx) → invoke("open_native_webview")
  → Rust FFI (lib.rs) → webview_plugin_open()
  → Swift presents UINavigationController
```

---

## Recommended: Bottom Sheet (Phase 1)

```
┌─────────────────────────┐
│  Main List (Pages)      │  ← Still visible
│ ┌─────────────────────┐ │
│ │ Save Article        │ │
│ └─────────────────────┘ │
├─────────────────────────┤  ← Drag handle
│  Webview Content        │
│  (swipe up to expand)   │
└─────────────────────────┘
```

### Implementation (~20 lines Swift)

```swift
// Replace .fullScreen with:
navController.modalPresentationStyle = .pageSheet

if #available(iOS 15, *) {
    navController.sheetPresentationController?.detents = [.medium, .large]
    navController.sheetPresentationController?.prefersScrollingExpandsWhenScrolledToEdge = true
    navController.sheetPresentationController?.preferredCornerRadius = 12
}
```

### Benefits
- Users see list underneath (context preserved)
- Swipe up to expand, down to dismiss
- Keyboard auto-avoidance built-in
- Natural iOS 15+ pattern (Maps, Stocks, Twitter)

---

## Phase 2: Browser Controls in Toolbar

Add Safari-style controls within the sheet:

```
┌─────────────────────────┐
│  Webview Content        │
├─────────────────────────┤
│ ◀ ▶ 🔄 ⎚ Share         │  ← Toolbar
└─────────────────────────┘
```

- Move navbar controls to permanent toolbar
- Show in all sheet states (medium/large)
- Bind to webview navigation state

**Complexity:** Medium (~1 day)

---

## Technical Considerations

### WKWebView vs SFSafariViewController

| Aspect | WKWebView | SFSafariViewController |
|--------|-----------|------------------------|
| Customization | Full control | Limited |
| Integration | Easy to embed | Fullscreen only |
| Memory | ~30-50MB | Lightweight (shared) |
| JavaScript | Full access | Sandboxed |
| **Best for** | In-app previews | External links |

**Recommendation:** Keep WKWebView for embedded views (control, visit tracking)

### Memory Management

- Single WKWebView instance: ~30-50MB peak
- Auto-release on dismiss via `currentWebViewController = nil`
- No change needed for bottom sheet (still single instance)

### Keyboard Handling

Bottom sheet auto-avoids keyboard with:
```swift
sheetPresentationController?.prefersScrollingExpandsWhenScrolledToEdge = true
```

### Safe Area / Notch

Always use `safeAreaLayoutGuide`:
```swift
webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
```

---

## Other Patterns Considered

| Pattern | Complexity | Notes |
|---------|------------|-------|
| Bottom sheet | Low | Recommended for Phase 1 |
| Drawer panel | Medium | Good for side-by-side |
| Split view (iPad) | High | Deferred |

### App Examples

- **Maps**: Bottom sheet with progressive disclosure
- **Slack**: Drawer for thread previews
- **Twitter/X**: Sheet that expands to fullscreen
- **Notes**: Inline preview → expand to webview

---

## Files

| File | Purpose |
|------|---------|
| `backend/tauri-mobile/src-tauri/gen/apple/Sources/peek-save/WebviewPlugin.swift` | Swift webview presentation |
| `backend/tauri-mobile/src/App.tsx` | React integration (lines 2435-2449) |
| `backend/tauri-mobile/src-tauri/src/lib.rs` | Rust FFI bridge (lines 2539-2575) |

---

## Implementation Timeline

- **Phase 1** (2-3 hrs): Bottom sheet with medium/large detents
- **Phase 2** (1 day): Browser controls in toolbar
