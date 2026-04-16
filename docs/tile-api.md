# Tile API Reference (Phase 4 — strict surface only)

This document lists the API surfaces available to v2 tiles after Phase 4 shim removal.
All surfaces are injected via `contextBridge.exposeInMainWorld('app', api)` from
`backend/electron/tile-preload.ts`. Deprecated v1-compat shims are gone; calling any
removed name throws `Error('[tile-preload] ... removed in Phase 4; use ...')`.

---

## Always-available (no capability required)

| Surface | Description |
|---|---|
| `api.version` | Tile preload version string (`'2.0.0'`) |
| `api.getTileId()` | Returns the tile's id string |
| `api.getTileEntry()` | Returns the tile entry filename |
| `api.initialize()` | Validates capability token; must be called first. Returns `{ capabilities }` |
| `api.onShutdown(cb)` | Register a shutdown callback |
| `api.scopes` | `{ SELF: 2, GLOBAL: 3 }` |
| `api.screen.getPrimaryDisplay()` | Read-only display info |
| `api.escape.onEscape(cb)` | Register ESC handler; return `{ handled: true }` to suppress default |
| `api.log(...args)` | Log to main-process renderer-log handler |

---

## Capability-gated surfaces

### `pubsub` capability

```json
"pubsub": { "topics": ["..."], "scope": "global" }
```

| Surface | Description |
|---|---|
| `api.pubsub.publish(topic, data, scope?)` | Publish an event |
| `api.pubsub.subscribe(topic, cb, scope?)` | Subscribe; returns unsubscribe fn |

**Removed:** `api.publish` / `api.subscribe` top-level aliases (Phase 4).

---

### `commands` capability

```json
"commands": true
```

| Surface | Description |
|---|---|
| `api.commands.register(name, handler)` | Register a command handler |
| `api.commands.register({ name, description, execute, ... })` | v1-compatible full-object form |
| `api.commands.unregister(name)` | Unregister a command |

---

### `window` capability

```json
"window": true | { "create": true, "query": true, "manage": true, "urls": ["peek://..."] }
```

| Surface | Gate | Description |
|---|---|---|
| `api.window.open(url, options?)` | `create` | Open a new window |
| `api.window.close(id?)` | `manage` or self | Close a window |
| `api.window.getInfo()` | `query` | Get current window info |
| `api.window.list()` | `query` | List open windows |
| `api.window.exists(id)` | `manage` | Check if window is open |
| `api.window.show(id)` | `manage` | Show a window |
| `api.window.hide(id)` | `manage` | Hide a window |
| `api.window.center(id?)` | `manage` | Center window on display |
| `api.window.centerAll()` | `manage` | Center all visible windows |
| `api.window.maximize(id?)` | `manage` | Toggle maximize |
| `api.window.fullscreen(id?)` | `manage` | Toggle fullscreen |
| `api.window.setIgnoreMouseEvents(id, ignore, opts?)` | `manage` | Click-through toggle |
| `api.window.setVisibleOnAllWorkspaces(id, visible, opts?)` | `manage` | Pin across Spaces |
| `api.window.getFocusedVisibleWindowId()` | `query` | Last-focused visible window id |
| `api.window.setOverlayFocusTarget(targetWindowId)` | `manage` | Set overlay focus target |

**Removed:** `api.closeWindow(id?)` top-level alias (Phase 4).

---

### `datastore` capability

```json
"datastore": { "tables": ["items", "tags", "item_tags", "item_events"] }
```

Strict key-value scoped storage:

| Surface | Description |
|---|---|
| `api.datastore.get(table, key)` | Get a value |
| `api.datastore.set(table, key, value)` | Set a value |
| `api.datastore.query(table, filter?)` | Query rows |
| `api.datastore.extractPageContent(url)` | Extract DOM content from live webContents |

**Removed:** All 30+ v1-compat helpers (`addItem`, `getItem`, `tagItem`, `addAddress`, etc.) — Phase 4. Hard-fail stubs remain to surface unmigrated callers.

---

### `settings` capability

```json
"settings": true | { "readForeign": ["other-tile-id", "*"] }
```

| Surface | Description |
|---|---|
| `api.settings.get(key)` | Get a setting value |
| `api.settings.set(key, value)` | Set a setting value |
| `api.settings.getExtKey(extId, key)` | Cross-tile read (requires `settings.readForeign`) |

**Removed:** `api.settings.getKey` / `api.settings.setKey` (Phase 4). `api.settings.getExtKey` v1-compat fallback removed; strict path only.

---

### `shortcuts` capability

```json
"shortcuts": true | { "keys": ["Option+S", ...] }
```

| Surface | Description |
|---|---|
| `api.shortcuts.register(shortcut, cb, options?)` | Register a keyboard shortcut |
| `api.shortcuts.unregister(shortcut, options?)` | Unregister a shortcut |

**Phase 4:** v1-compat fallback removed. Manifest must declare `shortcuts` capability; throws if not declared.

---

### `context` capability

```json
"context": true | { "read": ["key"], "write": ["key"], "modes": true, "queryWindows": true }
```

| Surface | Gate | Description |
|---|---|---|
| `api.context.get(key, windowId?)` | `read` allowlist | Read a context value |
| `api.context.set(key, value, meta?, windowId?)` | `write` allowlist | Write a context value |
| `api.context.history(key, limit?)` | `read` | Read context history |
| `api.context.snapshot(windowId?)` | any context cap | Full context snapshot |
| `api.context.windowsWithValue(key, value)` | `queryWindows` | Windows matching value |
| `api.context.windowsInSpace(spaceId)` | `queryWindows` | Windows in a space |

---

### `filesystem` capability

```json
"filesystem": { "read": ["/allowed/path/"], "write": ["/allowed/path/"] }
```

| Surface | Description |
|---|---|
| `api.filesystem.read(path)` | Read a file |
| `api.filesystem.write(path, content)` | Write a file |

---

### `dialogs` capability

```json
"dialogs": true | { "types": ["save", "open"] }
```

| Surface | Description |
|---|---|
| `api.dialogs.save(content, options?)` | Show save dialog |
| `api.dialogs.open()` | Show open dialog |

**Removed:** `api.files.open/save/readFromPath/writeToPath` (Phase 4) — hard-fail stubs.

---

### `network` capability

```json
"network": { "domains": ["https://api.example.com"] }
```

| Surface | Description |
|---|---|
| `api.network.fetch(url, options?)` | Domain-gated HTTP fetch |

---

### `theme` capability

```json
"theme": true
```

| Surface | Description |
|---|---|
| `api.theme.getInfo()` | Get current theme |
| `api.theme.onChange(cb)` | Subscribe to theme changes |

---

### `oauth` capability

```json
"oauth": true | { "providers": ["youtube", "*"] }
```

| Surface | Description |
|---|---|
| `api.oauth.startLoopback(options?)` | Start OAuth loopback server |
| `api.oauth.awaitCallback(port)` | Await OAuth callback |

---

### `sync` capability (builtin only)

```json
"sync": true
```

| Surface | Description |
|---|---|
| `api.sync.syncAll()` | Trigger full sync |

---

### `features` capability

```json
"features": true | { "read": true, "install": true, "manage": true, "update": true, "dev": true, "publish": true, "devtools": true, "browse": true, "sources": ["atproto"] }
```

See `tile-features-strict.test.ts` for full gate matrix.

---

### `izui` capability

```json
"izui": true
```

| Surface | Description |
|---|---|
| `api.izui.isTransient()` | Is this window transient |
| `api.izui.getEffectiveMode()` | Current IZUI mode |
| `api.izui.getState()` | IZUI state object |
| `api.izui.getPreOverlayFocusTarget()` | Pre-overlay focus target |
| `api.izui.closeSelf()` | Close this overlay |

---

### `session` capability

```json
"session": true
```

| Surface | Description |
|---|---|
| `api.session.saveSpaceWorkspaces()` | Persist space window layouts |

---

## Removed v1-compat surfaces (Phase 4)

These names exist on `window.app` but throw `Error('[tile-preload] ... removed in Phase 4; use ...')`:

- `api.publish` → use `api.pubsub.publish`
- `api.subscribe` → use `api.pubsub.subscribe`
- `api.closeWindow` → use `api.window.close()`
- `api.modes.*` → was unused; no replacement
- `api.files.open/save/readFromPath/writeToPath` → use `api.dialogs.*` / `api.filesystem.*`
- `api.settings.getKey/setKey` → use `api.settings.get/set`
- `api.datastore.addItem/getItem/tagItem/...` (30+ methods) → hard-fail stubs
