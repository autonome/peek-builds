# Safari Web Extension Plan

## Why Safari Web Extension (not Action Extension)

- Action Extensions appear in the same share sheet — confusing duplication with existing Share Extension
- Safari Web Extensions get a **toolbar button** in Safari's address bar — one tap to save
- Content scripts can access page DOM (metadata, selected text, article content)
- Native messaging to Swift code via `SafariWebExtensionHandler` — can use PeekCore.xcframework same as Share Extension
- Context menu support (iOS 16+) for long-press actions
- Background script can save silently without presenting a modal UI

**Keep the Share Extension** — it works from any app (Mail, Messages, etc.), not just Safari.

## Phases

### Phase 1: Quick Save via Toolbar Button (medium)

- Peek icon in Safari toolbar
- Tap: page saved instantly with auto-extracted metadata (title, URL, OG tags, favicon)
- Popup confirms save, shows tag chips, allows editing
- If URL exists, shows "Already saved" with existing tags

### Phase 2: Text Highlight Save (small)

- Select text, tap toolbar button → saves as text item with source URL
- `window.getSelection().toString()` in content script
- Reuses `PeekCoreManager.saveText()`

### Phase 3: Rich Metadata Extraction (small)

- Content script extracts: JSON-LD, microformats, Open Graph, Twitter cards, meta tags
- Same extraction logic as desktop `extensions/entities/` pipeline
- Stored as item metadata

### Phase 4: Article Content Save (medium)

- Bundle lightweight Readability.js (~50KB) in content script
- Save cleaned article HTML/text for offline reading
- Requires new PeekCore API for article content storage

## Technical Architecture

### Extension point

`com.apple.Safari.web-extension` with Manifest V3 (supported Safari 16.4+, Peek targets iOS 16.0+).

### Data flow

```
User taps toolbar icon
  → popup.html loads
  → popup.js messages content.js: "extract metadata"
  → content.js reads DOM (title, meta, OG tags, selection)
  → content.js responds with metadata
  → popup.js messages background.js: "save this"
  → background.js calls browser.runtime.sendNativeMessage()
  → SafariWebExtensionHandler.swift receives in native code
  → PeekCoreManager.saveUrl(url:tags:metadata:)
  → Response back to popup.js: "saved" / "already exists"
```

### New files

```
gen/apple/
  PeekSafari/
    SafariWebExtensionHandler.swift   # Native message handler, uses PeekCore
    Info.plist
    PeekSafari.entitlements           # App Group entitlement
    Resources/
      manifest.json
      background.js
      content.js
      popup.html / popup.js / popup.css
      images/icon-48.png, icon-96.png, icon-128.png
  Shared/
    PeekCoreManager.swift             # Extracted from ShareViewController, shared by both extensions
```

### project.yml target

```yaml
PeekSafari:
  type: app-extension
  platform: iOS
  sources:
    - path: PeekSafari
    - path: Shared/PeekCoreManager.swift
    - path: Peek/peek_core.swift
  info:
    path: PeekSafari/Info.plist
    properties:
      CFBundleDisplayName: Peek for Safari
      CFBundleIdentifier: com.dietrich.peek-mobile.safari
      NSExtension:
        NSExtensionPointIdentifier: com.apple.Safari.web-extension
        NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler"
  entitlements:
    path: PeekSafari/PeekSafari.entitlements
    properties:
      com.apple.security.application-groups:
        - group.com.dietrich.peek-mobile
  settings:
    base:
      PRODUCT_BUNDLE_IDENTIFIER: com.dietrich.peek-mobile.safari
      DEVELOPMENT_TEAM: TXZTDLL5LC
      IPHONEOS_DEPLOYMENT_TARGET: 16.0
  dependencies:
    - framework: ../../../peek-core/PeekCore.xcframework
```

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "Peek for Safari",
  "version": "1.0",
  "permissions": ["nativeMessaging", "activeTab"],
  "background": { "service_worker": "background.js" },
  "action": {
    "default_popup": "popup.html",
    "default_icon": { "48": "images/icon-48.png", "96": "images/icon-96.png" }
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }]
}
```

## Shared Code Strategy

Extract `PeekCoreManager` (~120 lines) from `ShareViewController.swift` into `Shared/PeekCoreManager.swift`. Both Share Extension and Safari Web Extension targets compile it. Both share the same App Group and PeekCore.xcframework.

## Risks

| Risk | Mitigation |
|------|-----------|
| 6MB memory limit on iOS Safari extensions | Keep content.js minimal; lazy-load Readability only when needed |
| User must manually enable in Settings > Safari > Extensions | Add onboarding screen in main app |
| PeekCore.xcframework in extension binary | Already used by Share Extension without issues |

## Sources

- [Apple: Creating a Safari Web Extension](https://developer.apple.com/documentation/safariservices/creating-a-safari-web-extension)
- [Apple: Messaging between the app and JavaScript in a Safari web extension](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
- [WWDC21: Meet Safari Web Extensions on iOS](https://developer.apple.com/videos/play/wwdc2021/10104/)
- [Apple: Action Extension Programming Guide](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Action.html)
