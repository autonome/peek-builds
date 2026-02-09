# Session Tracking and Restoration Design Document

## Executive Summary

This document outlines a comprehensive architecture for saving and restoring complete application state across Peek restarts, including open windows (URLs, positions, sizes), groups state, active pages/tabs, peek configurations, and extension-specific UI state. The system leverages Peek's existing datastore infrastructure with new session state persistence tables and coordination mechanisms.

---

## 1. Current State Analysis

### 1.1 Existing State Persistence

**Currently Persisted:**
- **Extension Settings** (`extension_settings` table): Key-value storage per extension via `api.settings.get()/set()`
- **Context History** (`context_history` table): Time-series window context tracking (mode, metadata, timestamps)
- **Chromium Session**: Browser cookies/cache/localStorage via profile-specific sessions
- **Active Theme**: Theme preference persisted via `setActiveThemeId()`

**NOT Currently Persisted:**
- Open window list with URLs, positions, and sizes
- Window focus state and z-order
- Window relationships (parent/child modals)
- Extension session contexts (active peeks, active groups)
- Navigation history per window (back/forward stacks)
- Scroll positions within content

### 1.2 Window Lifecycle

**Current Flow:**
1. Background window created and extensions load
2. User opens windows via shortcuts/commands → stored in in-memory `windowRegistry` only
3. On app quit: `before-quit` handler runs cleanup, `windowRegistry` discarded
4. **Gap**: No save point before shutdown

### 1.3 Extension State Management

**Current Pattern:**
- Extensions load settings on init: `await api.settings.get()`
- Extensions save changes individually: `await api.settings.set()`
- No coordinated shutdown sequence
- No recovery for partially-saved state

---

## 2. Proposed Architecture

### 2.1 Core Components

**1. Session State Manager** (`backend/electron/session.ts`)
- Coordinates session save/restore
- Manages autosave timer
- Handles version compatibility
- Implements recovery logic

**2. New Database Tables**
- `session_state`: Complete session snapshots (versioned)
- `window_sessions`: Per-window metadata
- `extension_session_state`: Extension-specific state
- `session_metadata`: Restore tracking & crash detection

**3. Enhanced Shutdown Sequence**
- New pubsub event: `app:before-shutdown`
- Extensions get 500ms to save state
- Window state captured
- Session snapshot created before exit

**4. Startup Restore Phase**
- Runs after extensions load
- Validates session compatibility
- Restores windows with error recovery
- Handles crash detection

### 2.2 Database Schema

**`session_state` table:**
```sql
id TEXT PRIMARY KEY              -- UUID
profileId TEXT NOT NULL          -- Profile folder
name TEXT                        -- 'autosave', 'before-quit', or user-provided
state TEXT NOT NULL             -- JSON blob of session state
version INTEGER NOT NULL         -- Schema version for compatibility
appVersion TEXT                  -- App version that created this
createdAt INTEGER NOT NULL       -- When snapshot taken
restoredAt INTEGER              -- When/if restored (NULL if never)
metadata TEXT DEFAULT '{}'       -- Crash/recovery metadata
```

**`window_sessions` table:**
```sql
id TEXT PRIMARY KEY
sessionId TEXT NOT NULL FK
windowId INTEGER
address TEXT NOT NULL            -- URL
title TEXT                       -- Page title
width, height INTEGER
x, y INTEGER
zOrder INTEGER                   -- Stacking order
visible INTEGER (0/1)
modal INTEGER (0/1)
parentWindowId INTEGER           -- For child windows
params TEXT DEFAULT '{}'         -- Full BrowserWindow params
contextState TEXT               -- JSON of window context
```

**`extension_session_state` table:**
```sql
id TEXT PRIMARY KEY
sessionId TEXT NOT NULL FK
extensionId TEXT NOT NULL
state TEXT NOT NULL              -- JSON blob (extension-specific)
version INTEGER                  -- Extension schema version
```

**`session_metadata` table:**
```sql
profileId TEXT PRIMARY KEY       -- One row per profile
lastSessionId TEXT FK
lastRestoreAt INTEGER
restoreCount INTEGER DEFAULT 0
crashCount INTEGER DEFAULT 0
cleanShutdown INTEGER DEFAULT 1  -- 0 if unclean exit detected
```

### 2.3 Save Phase

**Triggers:**
1. **Autosave**: Every 5 minutes (if enabled)
2. **Before Shutdown**: On `app.on('before-quit')`
3. **Manual Snapshot**: Via Settings UI

**Save Algorithm:**

```
1. Gather all visible windows from windowRegistry
2. Get bounds/visibility/focus state for each
3. Publish 'app:before-shutdown' pubsub event
4. Wait 500ms for extensions to save state
5. Query all extension_settings entries
6. Capture per-window context state
7. Create session JSON blob
8. Insert into session_state table
9. Create corresponding window_sessions entries
10. Insert extension_session_state entries
11. Update session_metadata
12. Cleanup old autosaves (keep last 3)
```

**Critical Path:**
- Triggered in `before-quit` handler to ensure capture before windows close
- Timeout if extensions don't respond (500ms max wait)
- Continues even if extension state save fails

### 2.4 Restore Phase

**Triggered:** App startup, after extensions loaded

**Algorithm:**

```
1. Check session_metadata for crash detection
2. If cleanShutdown=0, show "Recover from crash?" dialog
3. Load last session (or selected snapshot)
4. Validate session version compatibility
5. Sort windows by zOrder
6. For each window:
   a. Validate URL accessibility
   b. Restore with saved params + bounds
   c. Handle restore failures gracefully (skip window)
   d. Restore context state (mode, group, etc.)
7. Restore focused window
8. Send 'session:restore' event to each extension
9. Update session_metadata: restoreCount++, cleanShutdown=1
10. Return restore report (restored/failed/skipped counts)
```

**Error Recovery:**
- Invalid URLs: Warn and skip (don't fail entire restore)
- Bounds out-of-display: Move to center of primary display
- Missing extension: Skip that extension's state
- Corrupted JSON: Try previous session, else clean start

### 2.5 User Controls

**Settings UI Section:**

```
Session Management
├─ [x] Restore session on startup
├─ [x] Autosave session (interval: [___] minutes)
├─ [Save Current Session...] button
│   └─ Session name: [Research Project ________]
│       [Create Snapshot] button
├─ [Restore from Snapshot...] button
│   └─ List of named sessions with dates
├─ [Clear all session data] button (with confirmation)
└─ Privacy
   ├─ [ ] Privacy mode (don't save any URLs)
   ├─ [ ] Skip private/incognito windows
   └─ URL patterns to exclude: [_________________________]
```

**Settings Keys** (stored in extension_settings):
```javascript
session:restore_enabled = true
session:autosave_enabled = true
session:autosave_interval = 300000  // milliseconds
session:privacy_mode = false
session:save_private_windows = false
session:url_patterns_to_skip = ['https://bank\..*', ...]
```

### 2.6 Privacy and Security

**Privacy Considerations:**

1. **Sensitive URLs** (banking, healthcare)
   - Privacy Mode setting: skip all window content
   - URL pattern blacklist: regex-based exclusion
   - User informed in settings that auth cookies auto-restore

2. **Incognito Windows**
   - Track window.webPreferences.sandbox flag
   - Skip restoring private windows on next launch
   - Option: `session:save_private_windows` setting

3. **Expiration**
   - Optional: auto-delete sessions older than N days
   - Setting: `session:expires_after` (0=never)

---

## 3. Implementation Phases

### Phase 1: Core Tables & Save (Week 1)
- Add `session_state`, `window_sessions`, `extension_session_state`, `session_metadata` tables
- Implement `backend/electron/session.ts` with `saveSession()` function
- Add `before-quit` handler in `entry.ts`
- IPC handlers for session operations
- Unit tests for save logic

### Phase 2: Shutdown Coordination (Week 2)
- Implement `app:before-shutdown` pubsub event
- Autosave timer in background window
- Extension lifecycle hooks documentation
- Integration tests for shutdown sequence

### Phase 3: Restore on Startup (Week 3)
- Implement `restoreSession()` function
- Add restore phase to app startup
- Error recovery for invalid URLs, missing windows
- Crash detection and recovery dialog
- Integration tests

### Phase 4: Settings UI (Week 4)
- Add Session Settings section to settings.js
- "Save Current Session" dialog
- "Restore from Snapshot" UI with list
- Privacy settings controls
- E2E tests for settings persistence

### Phase 5: Error Handling (Week 5)
- Crash detection via `cleanShutdown` flag
- Corrupted session fallback (try previous version)
- Session cleanup job (keep last N autosaves)
- Recovery mode (if >50% restore fails, show offer for clean start)

### Phase 6: Extension Integration (Week 6)
- Document `app:before-shutdown` for extensions
- Update peeks extension: save active peek state
- Update groups extension: save active group context
- Update slides extension: save slide state
- Tests for multi-extension state coordination

---

## 4. Extension Integration

### 4.1 Extension Shutdown Hook

Extensions receive this event ~500ms before app quit:

```javascript
// In extension background script
api.subscribe('app:before-shutdown', async (evt) => {
  // Save extension state
  const state = {
    prefs: currentSettings.prefs,
    items: currentSettings.items,
    activeItem: currentActiveItem
  };

  await api.settings.set(state);
  // Extension should complete within ~400ms
});
```

### 4.2 Session Restore Hook

Sent to extension after app starts (if restoring):

```javascript
api.subscribe('session:restore', (evt) => {
  const { version, data } = evt.state;
  if (version === 1) {
    // Restore from v1 format
    currentSettings = data;
    reInitializeUI();
  }
});
```

### 4.3 Example: Peeks Extension

**Before shutdown:**
```javascript
// Save current peek configurations
await api.settings.set({
  prefs: { shortcutKeyPrefix: 'Option+' },
  items: [
    { enabled: true, keyNum: 0, address: 'https://github.com' },
    { enabled: true, keyNum: 1, address: 'https://news.ycombinator.com' }
  ]
});
```

**On restore:**
```javascript
api.subscribe('session:restore', (evt) => {
  const { items } = evt.state.data;
  // Re-initialize shortcuts with restored peek items
  initItems(currentSettings.prefs, items);
});
```

---

## 5. Challenges and Solutions

### 5.1 URL Validity
**Challenge:** Saved URLs may become invalid (deleted peeks, localhost, etc.)

**Solution:**
- Implement `isUrlAccessible()` to validate protocol handlers
- Skip invalid URLs with warning (don't fail entire restore)
- Offer user choice: delete from session or retry

### 5.2 Window Geometry
**Challenge:** Saved position may be off-screen if displays changed

**Solution:**
- Validate bounds against current display on restore
- If out-of-bounds, move to center of primary display
- Store display info in metadata for debugging

### 5.3 Crash Detection
**Challenge:** How to detect unclean exits?

**Solution:**
- `session_metadata.cleanShutdown` flag (set to 1 before quit)
- On startup, if 0: show crash recovery dialog
- After 3+ crashes, disable auto-restore

### 5.4 Extension Version Mismatch
**Challenge:** Extension state saved with v1, app now has v2

**Solution:**
- Extensions declare compatible state versions
- Session includes extension version info
- Run migration if version < current
- Skip if version > current

### 5.5 Large Session State
**Challenge:** Session snapshots could get large

**Solution:**
- Compress if >100KB
- Keep only last 3 autosaves
- Limit to 50MB per session
- Don't save if >100MB

### 5.6 Parent Window Closure
**Challenge:** Modal child window persists after parent closes

**Solution:**
- Restore parent before children (track parentWindowId)
- If parent restore fails, skip orphaned children
- Offer user choice: adopt to primary window

---

## 6. Testing Strategy

### Unit Tests
- Session save/restore with 1-5 windows
- Context state preservation
- Extension state merging
- Version compatibility
- URL validation
- Corrupted session recovery

### Integration Tests
- Full lifecycle: save → quit → restart → restore
- Multi-extension coordination during shutdown
- Autosave timer (mocked)
- Privacy settings enforcement
- Crash detection
- Settings persistence

### E2E Tests (Playwright)
- Open 5 windows, save, restart → all restored
- Graceful quit saves session
- Force-quit triggers crash recovery
- Named snapshot restore works
- Privacy mode hides URLs
- Extension state survives restart

### Manual Testing
- Open windows, quit with Cmd+Q, restart → verify restored
- Set custom window size/position → verify bounds preserved
- Open peek (Option+0), save, restart → peek restored
- Kill app with force-quit → crash dialog shown
- Enable privacy mode, open github.com, restart → URL not in DB
- Wait 2+ minutes with autosave enabled → verify multiple autosaves created

---

## 7. API Reference

### IPC Handlers

```typescript
// Renderer → Main
'session:save'                    // { reason, name? }
'session:restore'                 // { sessionId? }
'session:list'                    // {} → SessionMetadata[]
'session:delete'                  // { sessionId }
'session:get-settings'            // {}
'session:update-settings'         // { restoreEnabled, autosaveEnabled, ... }

// Main → Renderer (pubsub)
'app:before-shutdown'             // { reason: string }
'session:restore-complete'        // { restored, failed, skipped }
```

### Extension API

```javascript
// Listen for shutdown
window.app.subscribe('app:before-shutdown', async (evt) => { ... });

// Listen for restore
window.app.subscribe('session:restore', (evt) => { ... });
```

---

## 8. Success Metrics

1. **Correctness**: 100% of test scenarios pass
2. **Completeness**: >95% of windows successfully restore
3. **Performance**: Save <2s, restore <5s
4. **Storage**: Session DB stays <100MB
5. **Privacy**: Privacy mode hides all URLs
6. **Recovery**: Crash recovery works >95%

---

## 9. Future Enhancements

1. Incremental snapshots (save only diffs)
2. Cloud sync of sessions across devices
3. Session merging (combine multiple sessions)
4. Time-travel history of past sessions
5. Mobile → desktop session sync
6. Pre-defined session templates
7. Collaborative session sharing

---

## Conclusion

This comprehensive session tracking system builds on Peek's existing datastore and extension architecture. Key innovations:

1. **Coordinated Shutdown**: `app:before-shutdown` event ensures all extensions save atomically
2. **Graceful Degradation**: Invalid windows skipped, other windows still restored
3. **Crash Recovery**: Detects unclean exits and offers recovery
4. **Privacy-First**: Settings for URL patterns, privacy mode, incognito handling
5. **Extension Agnostic**: Each extension manages own state format/versioning

The phased implementation prioritizes core functionality first, with error handling and advanced features following. By leveraging the existing context_history table and extension_settings infrastructure, implementation effort is minimized while providing a browser-like session restore experience tailored to Peek's multi-window, multi-extension architecture.

---

## Meta

- **Author**: Exploration Agent
- **Date**: 2026-02-09
- **Status**: Design/Planning Phase
- **Related**: Window management, extension lifecycle, datastore architecture
