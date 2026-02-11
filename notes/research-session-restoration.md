# Session Tracking and Restoration Design Document

## Executive Summary

This document outlines the architecture for saving and restoring complete application state across Peek restarts, including open windows (URLs, positions, sizes), context/mode state, IZUI session state, extension-specific UI state, and groups. The design leverages Peek's existing infrastructure — the `items` table, `extension_settings` table, `context_history` table, IZUI state coordinator, and window registry — to minimize new schema additions while providing a robust session restore experience.

**Updated**: 2026-02-11 — reflects unified items table, context/modes API, IZUI state system, and existing window bounds persistence.

---

## 1. Current State Analysis

### 1.1 Existing State Persistence

**Currently Persisted:**
- **Extension Settings** (`extension_settings` table): Key-value storage per extension via `api.settings.get()/set()/getKey()/setKey()`
- **Context History** (`context_history` table): Time-series window context tracking (key, value, metadata, windowId, source, timestamp, prevEntryId)
- **Items** (`items` table): Unified data with types: `url`, `text`, `tagset`, `image`, `series`, `feed`, `entity` — replaces legacy addresses/visits
- **Item Visits** (`item_visits` table): Visit tracking with chaining (prevId/nextId), source, duration, scroll depth
- **Window Bounds Persistence** (ALREADY IMPLEMENTED): Per-key window position/size saved to `extension_settings` when `persistWindowState` pref is enabled or `persistState: true` is passed in window open options. Uses `window_state:{key}` row IDs in `extension_settings` with `extensionId: 'window_state'`.
- **Chromium Session**: Browser cookies/cache/localStorage via profile-specific session partitions
- **Active Theme**: Theme preference persisted via `setActiveThemeId()` in `extension_settings`
- **Dark Mode**: 3-tier setting (`off`/`system`/`force`) persisted in `extension_settings` under `core`/`darkMode`
- **Item Groups** (`item_groups` + `item_group_members` tables): Named groups with member items and positions

**NOT Currently Persisted:**
- Open window list with URLs and which windows should reopen on restart
- Window relationships (parent/child, opener)
- IZUI session state (transient/active/overlay)
- Which extension windows were running (beyond the always-loaded builtins)
- Navigation history per window (back/forward stacks beyond what `item_visits` chaining captures)
- Scroll positions within web content
- Window focus state and z-order
- Context key/values for specific windows at shutdown time (context_history records history, but there is no "current snapshot for all windows at quit time")

### 1.2 Window Lifecycle (Current)

**Current Flow:**
1. Background window created, extensions load via pubsub `topic:core:prefs`
2. User opens windows via shortcuts/commands/extensions → stored in in-memory `windowRegistry` (Map of windowId -> {source, params})
3. Window bounds optionally auto-saved on move/resize (debounced 500ms) if window has a `key` and persistence is enabled
4. On app quit: `before-quit` handler runs cleanup, publishes `app:shutdown` via pubsub, closes database, `windowRegistry` discarded
5. **Gap**: No snapshot of open windows (URLs, keys, context) is taken before shutdown. Only individually keyed window bounds survive.

### 1.3 What's Already Working

The `persistWindowState` pref (default: `false`) and per-window `persistState` option already handle **individual window bounds restoration**. When a window with a `key` is reopened (e.g., the groups extension always opens its window with the same key), it restores to its last saved position/size. This means:

- **Phase 1 of the original plan (window bounds) is partially done.** The missing piece is knowing *which* windows to reopen, not *where* to put them.
- The `extension_settings` table is already being used as a general-purpose persistence store (theme, dark mode, window states, per-extension settings).

### 1.4 APIs Available for Session Restore

| API | Location | Relevance |
|-----|----------|-----------|
| `api.context.get/set/watch` | preload.js | Track mode, group membership, custom context per window |
| `api.context.getMode/setMode/watchMode` | preload.js | Convenience methods for the `mode` context key |
| `api.context.getSnapshot(timestamp, keys)` | preload.js | Point-in-time context state (useful for save) |
| `api.context.getWindowsWithValue(key, value)` | preload.js | Find windows in a specific mode/group |
| `api.izui.getState/isTransient/getEffectiveMode` | preload.js | IZUI session state (idle/transient/active/overlay) |
| `api.window.list({includeInternal})` | preload.js | Enumerate all open windows with URLs, titles, params |
| `api.window.getBounds(id)` | preload.js | Get window position/size |
| `api.window.open(url, options)` | preload.js | Open window with key, bounds, mode, modal, overlay, etc. |
| `api.settings.get/set/getKey/setKey` | preload.js | Extension-scoped settings persistence |
| `api.commands.register/list` | preload.js | Command system for session management commands |
| `api.publish/subscribe` | preload.js | PubSub for coordinated shutdown/restore events |
| `getAllWindows()` | main.ts | Main-process access to windowRegistry |
| `getRow/setRow('extension_settings', ...)` | datastore.ts | Direct DB access for session snapshots |
| `addContextEntry/getContextSnapshot` | datastore.ts | Context history read/write from main process |

### 1.5 Existing Shutdown Sequence

The current `before-quit` handler in `entry.ts`:
```
1. cleanupDevExtensions()
2. cleanupAdblocker()
3. stopHotReload()
4. shutdown() → publishes 'app:shutdown' pubsub + closeDatabase()
```

There is already an `app:shutdown` pubsub event published during quit. Extensions could listen for this, but currently none do. The database is closed immediately after the event is published, so extensions have no time to save state via async IPC. This is the key coordination gap.

---

## 2. Revised Architecture

### 2.1 Core Insight: Reuse Existing Tables

The original design proposed 4 new tables (`session_state`, `window_sessions`, `extension_session_state`, `session_metadata`). Given the existing infrastructure, we can achieve the same goals with fewer additions:

| Original Table | Revised Approach |
|---------------|-----------------|
| `session_state` | Single row in `extension_settings` under `extensionId: 'session'`, `key: 'snapshot'` — JSON blob |
| `window_sessions` | Embedded in the session snapshot JSON (array of window descriptors) |
| `extension_session_state` | Extensions already save their own state via `api.settings.set()`. Session restore just needs to reopen windows — extension state is already persisted. |
| `session_metadata` | Single row in `extension_settings` under `extensionId: 'session'`, `key: 'metadata'` |

**New table needed: NONE.** The `extension_settings` table can store everything with the `extensionId: 'session'` namespace.

### 2.2 Session Snapshot Format

Stored as JSON in `extension_settings` with `extensionId: 'session'`, `key: 'snapshot'`:

```json
{
  "version": 1,
  "appVersion": "0.1.0",
  "createdAt": 1707500000000,
  "reason": "before-quit",
  "izuiState": "active",
  "windows": [
    {
      "url": "https://github.com",
      "key": "page-github-com",
      "title": "GitHub",
      "source": "peek://app/background.html",
      "bounds": { "x": 100, "y": 100, "width": 1200, "height": 800 },
      "params": {
        "canvas": true,
        "escapeMode": "navigate",
        "keepLive": true,
        "modal": false
      },
      "context": {
        "mode": "page"
      },
      "zOrder": 0,
      "focused": false
    },
    {
      "url": "peek://groups/index.html",
      "key": "groups-main",
      "title": "Groups",
      "source": "peek://ext/groups/background.js",
      "bounds": { "x": 300, "y": 200, "width": 900, "height": 600 },
      "params": {
        "escapeMode": "navigate"
      },
      "context": {
        "mode": "group",
        "groupId": "abc-123",
        "groupName": "Research"
      },
      "zOrder": 1,
      "focused": true
    }
  ]
}
```

### 2.3 Session Metadata Format

Stored in `extension_settings` with `extensionId: 'session'`, `key: 'metadata'`:

```json
{
  "lastSnapshotAt": 1707500000000,
  "lastRestoreAt": 1707500100000,
  "restoreCount": 5,
  "cleanShutdown": true
}
```

### 2.4 Save Phase

**Triggers:**
1. **Before Shutdown**: In the `before-quit` handler, *before* database close
2. **Autosave**: Optional periodic save (if enabled via pref)
3. **Manual**: Via command palette ("Save Session")

**Save Algorithm (main process):**

```
1. Set cleanShutdown = false in session metadata
2. Iterate getAllWindows() from windowRegistry
3. For each window (skip background, extension-host, modal, destroyed):
   a. Get BrowserWindow bounds via win.getBounds()
   b. Get URL (extract real URL from peek://app/page containers)
   c. Get params from windowRegistry entry
   d. Query context_history for latest context values for this windowId
   e. Build window descriptor
4. Build session snapshot JSON
5. Write to extension_settings: setRow('extension_settings', 'session:snapshot', ...)
6. Set cleanShutdown = true in session metadata
7. Proceed with shutdown (close database, quit)
```

**Critical implementation detail**: The save must happen synchronously in the `before-quit` handler, before `shutdown()` closes the database. Since `better-sqlite3` is synchronous, this is straightforward — no async coordination needed. The save function runs entirely in the main process using `getAllWindows()` and `BrowserWindow` APIs. No IPC round-trips to renderer processes required.

### 2.5 Restore Phase

**Triggered:** App startup, after extensions are loaded (after the `topic:core:prefs` subscription fires and `loadExtensions()` completes in `entry.ts`)

**Algorithm:**

```
1. Check session metadata: was cleanShutdown true?
2. If cleanShutdown = false:
   a. If crashCount > 3, skip restore (clean start)
   b. Otherwise, increment crashCount, offer recovery dialog
3. Load session snapshot from extension_settings
4. Validate snapshot version compatibility
5. Sort windows by zOrder
6. For each window descriptor:
   a. Validate URL is reasonable (has protocol, not empty)
   b. Validate bounds are within current display(s)
   c. Call the window-open IPC path with saved params + bounds
   d. Set context (mode, group) after window is ready
   e. Handle errors: skip window, continue with rest
7. Focus the window that was focused at save time
8. Publish 'session:restored' pubsub event
9. Update metadata: restoreCount++, cleanShutdown = true, crashCount = 0
```

### 2.6 Integration with Existing `persistWindowState`

The existing window bounds persistence and session restore complement each other:

- **`persistWindowState`** = "remember where I put this window" (per-key, survives across sessions)
- **Session restore** = "reopen the windows I had open" (per-session, knows which windows to create)

On restore, the flow is:
1. Session restore creates windows with the bounds from the snapshot
2. If a window has a `key` and `persistWindowState` is enabled, the existing persistence code may override the session bounds with more recent saved bounds
3. This is actually desirable — if the user moved a window after the last autosave, the per-key bounds are more current

### 2.7 User Controls

**New prefs in `config.js` prefsSchema:**
```javascript
"restoreSession": {
  "description": "Restore open windows when app restarts",
  "type": "boolean",
  "default": true
},
"sessionAutosaveInterval": {
  "description": "Periodically save session state (interval in minutes, 0 = disabled)",
  "type": "integer",
  "default": 5
}
```

**Command Palette Commands:**
- `Save Session` — manual snapshot
- `Restore Previous Session` — restore last snapshot (if current session is empty)

**Settings keys** (stored via extension_settings, extensionId: 'session'):
```
session:snapshot     — latest session snapshot JSON
session:metadata     — session metadata JSON
session:autosave     — last autosave snapshot (separate from before-quit)
```

### 2.8 Privacy and Security

**Privacy Considerations:**

1. **Sensitive URLs** (banking, healthcare)
   - Session snapshots only store URLs — no page content, no auth tokens
   - URLs are already stored in the `items` table via history tracking, so session restore adds minimal new privacy exposure
   - Future: URL pattern exclusion list (regex-based, stored in session prefs)

2. **Privacy Mode**
   - Future enhancement: `session:privacy_mode` setting to disable URL recording in snapshots
   - When enabled, session snapshots would only record extension windows (peek:// URLs), not web pages

3. **Storage**
   - Session snapshots are small (a few KB for typical sessions)
   - Keep only last snapshot + last autosave (2 rows total)
   - No separate cleanup needed — `setRow` overwrites existing rows

---

## 3. Implementation Phases

### Phase 1: Save on Quit
- Add `saveSessionSnapshot()` function in a new `backend/electron/session.ts`
- Call it from the `before-quit` handler in `entry.ts`, before `shutdown()`
- Iterate `getAllWindows()`, build snapshot, write to `extension_settings`
- Add `restoreSession` and `sessionAutosaveInterval` prefs to `config.js`
- No new tables needed
- **Tests**: Unit test for snapshot serialization, integration test for save-on-quit

### Phase 2: Restore on Startup (includes context, groups, bounds validation)
- Add `restoreSessionSnapshot()` function in `session.ts`
- Call it after extensions are loaded (in the `subscribe(prefs)` handler in `entry.ts`)
- Restore windows via the existing `window-open` IPC handler path
- **Context/group restoration**: Save per-window context state (mode, groupId, groupName) in snapshot. Restore context after window creation via `addContextEntry()`. Restore group window associations. Integrate with IZUI state: always restore into active mode.
- **Bounds validation**: On restore, validate saved bounds against `screen.getAllDisplays()`. If window center point is not within any active display, discard saved position (keep saved size), let fallback centering handle placement.
- Handle crash detection via `cleanShutdown` flag in metadata
- If `startupFeature` pref is set and session restore is enabled with a valid snapshot, skip `startupFeature`
- **Tests**: Integration test for full save-quit-restart-restore cycle, mode/group state preservation, bounds validation

### Phase 3: Autosave + Commands
- Add periodic autosave timer (default: 5 minutes, configurable via `sessionAutosaveInterval` pref)
- Autosave enabled by default — best mitigation against unforeseen shutdowns (SIGKILL, power loss, crash)
- Register `Save Session` and `Restore Previous Session` commands
- Expose session management in Settings UI
- **Tests**: Timer-based autosave, command execution

### Phase 4: Error Handling and Edge Cases
- Crash detection: `cleanShutdown` flag, crash count, recovery dialog
- Stale URL handling: skip windows that fail to load
- Recovery mode: if >50% of windows fail to restore, offer clean start
- **Tests**: Crash recovery, partial restore

---

## 4. Extension Integration

### 4.1 Shutdown Coordination

Extensions already save their own state via `api.settings.set()` during normal operation. The session restore system does NOT need to coordinate extension state saves at shutdown — it only needs to know which windows to reopen.

However, for extensions that maintain ephemeral in-memory state (e.g., active peek targets, unsaved editor content), a shutdown notification is valuable:

```javascript
// In extension background script
api.subscribe('app:shutdown', async (evt) => {
  // Save any ephemeral state before quit
  // NOTE: This event is already published by the main process.
  // The window for async saves is limited — synchronous saves via
  // api.settings.setKey() are preferred.
  await api.settings.setKey('lastSessionState', {
    activePeekTarget: currentTarget,
    unsavedContent: getUnsavedContent()
  });
});
```

**Important**: The current `app:shutdown` event fires right before `closeDatabase()`, so there is a race condition for async saves. Phase 1 should insert the session save *before* the shutdown event, so the session is captured even if extension saves fail.

### 4.2 Restore Notification

After session restore completes:

```javascript
api.subscribe('session:restored', (evt) => {
  const { windowCount, restoredCount, failedCount } = evt;
  // Extension can re-initialize based on restored windows
});
```

### 4.3 Example: Groups Extension

Groups already persist their configuration via `api.settings.set()`. Session restore would:
1. Reopen the groups window with its saved `key` (bounds restored by existing `persistWindowState`)
2. Set context: `mode: 'group'`, `groupId: 'abc-123'`
3. The groups extension reads its settings on load and picks up where it left off

No special integration needed — groups already persist correctly.

---

## 5. Challenges and Solutions

### 5.1 Canvas Page URL Extraction
**Challenge:** Web pages are wrapped in `peek://app/page/index.html?url=...` containers. The session must save the actual URL, not the container URL.

**Solution:** Already handled — the `window-list` IPC handler extracts real URLs from page containers. The save function should use the same logic.

### 5.2 Window Geometry on Display Change
**Challenge:** Saved position may be off-screen if displays changed between sessions.

**Solution:** On restore, validate bounds against `screen.getAllDisplays()`. If no display contains the window center point, reposition to center of primary display. This mirrors the existing logic in `window-open` that centers windows.

### 5.3 Database Availability at Shutdown
**Challenge:** The `before-quit` handler must save before `closeDatabase()`.

**Solution:** Insert `saveSessionSnapshot()` call before `shutdown()` in the `before-quit` handler. Since `better-sqlite3` is synchronous, the save completes instantly.

### 5.4 Extension Windows vs User Windows
**Challenge:** Extension background windows (peek://ext/groups/background.js) should not be restored as visible windows.

**Solution:** Filter windows in the save phase. Only save windows that:
- Are visible (`win.isVisible()`)
- Are not the background window (`peek://app/background.html`)
- Are not the extension host (`peek://app/extension-host.html`)
- Are not modal (transient UI)

### 5.5 IZUI State on Restore
**Challenge:** Should restored sessions start in active or transient mode?

**Solution:** Always restore into active mode. The user explicitly launched the app (or it auto-launched), so they expect to see their windows. The IZUI coordinator will naturally evaluate the entry mode based on app focus state.

### 5.6 Startup Feature Conflict
**Challenge:** The `startupFeature` pref opens a window on startup (default: settings page). Session restore would also open windows.

**Solution:** If session restore is enabled and a snapshot exists, skip the `startupFeature`. If no snapshot or restore is disabled, fall back to `startupFeature`.

---

## 6. Testing Strategy

### Unit Tests
- Session snapshot serialization/deserialization
- Window filtering (skip background, extension-host, modal)
- URL extraction from canvas containers
- Bounds validation against display geometry
- Crash detection logic (cleanShutdown flag)

### Integration Tests
- Full lifecycle: open windows → quit → restart → windows restored
- Window bounds preserved across save/restore
- Context/mode state preserved across save/restore
- Extension settings survive restart (already works, validate)
- Crash detection when cleanShutdown is false

### E2E Tests (Playwright)
- Open 3 windows, quit, restart → all 3 restored with correct URLs
- Move window, quit, restart → position preserved
- Enable session restore pref, verify it takes effect
- Force-quit → crash recovery dialog shown
- Autosave creates periodic snapshots

### Manual Testing
- Open windows, Cmd+Q, restart → verify restored
- Set custom window position/size → verify bounds preserved
- Open peek (Option+0), save, restart → peek extension reloads correctly
- Kill app with Activity Monitor → crash dialog shown
- Wait for autosave interval → verify snapshot exists in DB

---

## 7. API Reference

### IPC Handlers (new)

```typescript
// Main process functions (not IPC - called directly from before-quit)
saveSessionSnapshot(reason: string): void    // Synchronous, called in before-quit
restoreSessionSnapshot(): Promise<RestoreResult>  // Async, called after extensions load

// IPC handlers (for renderer-initiated actions)
'session:save'              // { reason: 'manual' | 'autosave' }
'session:get-snapshot'      // {} → SessionSnapshot | null
'session:get-metadata'      // {} → SessionMetadata
```

### PubSub Events

```typescript
// Already exists:
'app:shutdown'              // Published before database close

// New:
'session:restored'          // { windowCount, restoredCount, failedCount }
```

### Extension API (via preload.js)

```javascript
// Subscribe to shutdown (already possible via existing pubsub)
app.subscribe('app:shutdown', async (evt) => { ... });

// Subscribe to restore completion (new)
app.subscribe('session:restored', (evt) => { ... });
```

---

## 8. Success Metrics

1. **Correctness**: 100% of test scenarios pass
2. **Completeness**: >95% of windows successfully restore
3. **Performance**: Save <100ms (synchronous SQLite), restore <3s
4. **Storage**: Session snapshot <50KB for typical usage (JSON in one row)
5. **Privacy**: No page content stored, only URLs (already in items table)
6. **Recovery**: Crash recovery works >95% of the time

---

## 9. Future Enhancements

1. Named session snapshots (save/restore specific sessions)
2. Session history (keep last N snapshots for time-travel)
3. Cloud sync of sessions across devices (via existing sync infrastructure)
4. Tab groups / workspaces (save different window sets for different tasks)
5. Per-window scroll position restoration (requires webview integration)
6. Import/export sessions (JSON file)

---

## 10. Key Differences from Original Design

| Aspect | Original (Feb 9) | Revised (Feb 11) |
|--------|------------------|-------------------|
| New tables | 4 (`session_state`, `window_sessions`, `extension_session_state`, `session_metadata`) | 0 — uses existing `extension_settings` |
| Extension state coordination | Complex shutdown handshake with 500ms timeout | Not needed — extensions already persist via `api.settings` |
| Window bounds | New implementation needed | Already implemented via `persistWindowState` pref |
| Schema references | Legacy `addresses`/`visits` tables | Unified `items`/`item_visits` tables |
| Context tracking | Not mentioned | Leverages existing `context_history` table and context API |
| IZUI integration | Not mentioned | Restore respects IZUI state model |
| Implementation complexity | 6 phases over 6 weeks | 5 phases, first 2 much smaller due to existing infrastructure |
| IPC naming | `session:save`, `session:restore`, etc. | Minimal IPC — main save is synchronous in before-quit |

---

## Conclusion

The revised design dramatically simplifies session restoration by building on infrastructure that was added since the original document was written. The unified items table, context history system, IZUI state coordinator, and existing window bounds persistence mean that session restore is primarily about answering one question: "which windows were open?"

The answer is captured as a small JSON snapshot in the existing `extension_settings` table during the synchronous `before-quit` handler. No new tables, no complex async coordination, no extension handshake protocols. Extensions already persist their own state — session restore just needs to reopen their windows.

---

## Meta

- **Author**: Exploration Agent (original), updated by research agent
- **Created**: 2026-02-09
- **Updated**: 2026-02-11
- **Status**: Design/Planning Phase — revised to reflect current codebase
- **Related**: Window management, IZUI state, context API, extension lifecycle, datastore architecture

---

## Display Change Handling

### Current State

There is **no display change handling** in the codebase. The `screen` module from Electron is imported in `backend/electron/ipc.ts` but only used for:

1. `screen.getPrimaryDisplay()` — centering windows on the primary display when no position is specified (line 2105)
2. `screen.getDisplayNearestPoint()` — sizing canvas pages to cover the correct display (line 2162), and sizing popup canvas windows (line 2536)

No listeners are registered for display events (`display-added`, `display-removed`, `display-metrics-changed`). No bounds validation is performed when restoring persisted window state.

### Impact Analysis

When displays change (external monitor connected/disconnected, resolution change, etc.), the following problems occur:

1. **Persisted window positions become stale**: Windows with `persistWindowState` enabled save their position (x, y, width, height) to `extension_settings` via debounced move/resize handlers (ipc.ts lines 2644-2673). When a display is removed and the user re-opens a window, the saved position may reference coordinates that are now off-screen. There is no bounds validation at restore time (ipc.ts lines 2066-2072 — saved x/y are applied directly to `winOptions` without checking if they fall within any active display).

2. **Canvas pages break entirely**: Canvas (page) windows are sized to cover a full display using `screen.getDisplayNearestPoint()` (ipc.ts line 2162). If the display they were placed on is removed, the canvas window remains at the old size/position, which may be entirely off-screen. The canvas is not resized or repositioned to the remaining display.

3. **Centered windows use stale display geometry**: The primary display fallback centering (ipc.ts lines 2104-2111) uses the primary display's work area at window creation time. If the primary display changes (e.g., external monitor was primary, now laptop is primary), new windows may be centered correctly but existing windows remain at their old positions.

4. **The `center: true` option on cmd palette**: The command palette uses `center: true` (background.js line 274 of openPanelWindow), which centers on creation. Since the palette is `keepLive: true`, it is hidden rather than closed. When re-shown, it reappears at its last position — which could be off-screen if the display layout changed since it was first created.

### Electron API Available

Electron's `screen` module (EventEmitter) provides three relevant events:

- **`display-added`** — `(event, newDisplay: Display)` — fired when a new display is connected
- **`display-removed`** — `(event, oldDisplay: Display)` — fired when a display is disconnected
- **`display-metrics-changed`** — `(event, display: Display, changedMetrics: string[])` — fired when bounds, workArea, scaleFactor, or rotation changes on a display. `changedMetrics` is an array of strings like `['bounds', 'workArea']`.

Additional useful methods:
- `screen.getAllDisplays()` — returns array of all connected Display objects
- `screen.getDisplayNearestPoint({x, y})` — returns the display closest to a point
- `screen.getPrimaryDisplay()` — returns the primary display

The `Display` object contains: `id`, `bounds` (full screen rect), `workArea` (usable rect excluding taskbar/dock), `scaleFactor`, `rotation`, `size`, `workAreaSize`.

Note: There was a historical Electron bug where `display-removed` and `display-metrics-changed` were not emitted reliably on some platforms (electron/electron#33414). This appears to be resolved in modern Electron versions (40.x as used in this project).

### Recommendations

#### 1. Add display change event listeners (Phase 1 — immediate value)

Register listeners in `ipc.ts` (or a new `display.ts` module) after app is ready:

```typescript
screen.on('display-removed', (event, oldDisplay) => {
  // Revalidate all visible windows
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    ensureWindowOnScreen(win);
  }
});

screen.on('display-metrics-changed', (event, display, changedMetrics) => {
  if (changedMetrics.includes('bounds') || changedMetrics.includes('workArea')) {
    // Resize canvas pages that cover this display
    revalidateCanvasWindows(display);
    // Revalidate other windows
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      ensureWindowOnScreen(win);
    }
  }
});
```

#### 2. Add bounds validation helper

```typescript
function ensureWindowOnScreen(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  // Check if center point is within any display
  const displays = screen.getAllDisplays();
  const isOnScreen = displays.some(d => {
    const wa = d.workArea;
    return centerX >= wa.x && centerX < wa.x + wa.width &&
           centerY >= wa.y && centerY < wa.y + wa.height;
  });

  if (!isOnScreen) {
    // Move to center of nearest display (by distance from center point)
    const nearest = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
    const wa = nearest.workArea;
    const newX = Math.round(wa.x + (wa.width - bounds.width) / 2);
    const newY = Math.round(wa.y + (wa.height - bounds.height) / 2);
    win.setPosition(newX, newY);
  }
}
```

#### 3. Validate persisted window bounds on restore

In the window-open handler (ipc.ts ~line 2066), after loading saved state, validate that the saved coordinates are within an active display before applying them:

```typescript
if (savedState) {
  // Validate saved position is on a visible display
  const centerX = (savedState.x ?? 0) + ((savedState.width ?? 0) / 2);
  const centerY = (savedState.y ?? 0) + ((savedState.height ?? 0) / 2);
  const displays = screen.getAllDisplays();
  const isOnScreen = displays.some(d => {
    const wa = d.workArea;
    return centerX >= wa.x && centerX < wa.x + wa.width &&
           centerY >= wa.y && centerY < wa.y + wa.height;
  });

  if (isOnScreen) {
    // Apply saved state
    if (savedState.x !== undefined) winOptions.x = savedState.x;
    if (savedState.y !== undefined) winOptions.y = savedState.y;
    if (savedState.width !== undefined) winOptions.width = savedState.width;
    if (savedState.height !== undefined) winOptions.height = savedState.height;
  } else {
    // Discard saved position, keep saved size
    if (savedState.width !== undefined) winOptions.width = savedState.width;
    if (savedState.height !== undefined) winOptions.height = savedState.height;
    // Window will be centered by the fallback logic below
  }
}
```

#### 4. Handle canvas page display changes

Canvas pages sized to a specific display need special handling:

- On `display-removed`: find canvas windows that were sized for the removed display, reattach them to the nearest remaining display (resize canvas to new display dimensions, offset the inner page bounds proportionally)
- On `display-metrics-changed` with bounds/workArea changes: resize the canvas window to match the updated display dimensions
- Publish a `display:changed` pubsub event so page.js can re-read display dimensions and adjust its internal bounds

#### 5. Handle keepLive window repositioning

For `keepLive` windows like the command palette that are hidden and re-shown:
- On re-show (in `closeOrHideWindow`'s inverse — the show path), validate position before making the window visible
- Or listen for `display-removed` and reposition hidden keepLive windows proactively

#### Priority

1. **Bounds validation on restore** (Recommendation 3) — highest impact, easiest to implement, prevents the most common user-facing issue
2. **Display change event listeners** (Recommendations 1+2) — medium effort, handles the live unplug scenario
3. **Canvas page display changes** (Recommendation 4) — most complex, requires coordination between main process and page.js renderer
4. **keepLive window repositioning** (Recommendation 5) — low priority, edge case
