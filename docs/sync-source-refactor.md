# Sync Source Refactor: Replace syncSource with Device IDs

Research doc — Feb 2026

## Problem

`syncSource` is overloaded with two jobs:

1. **Origin tracking** — where did this item come from?
2. **Sync gating** — should this item be pushed to the server?

This causes several issues:

- Items imported from browser history/tabs/bookmarks are silently excluded from sync (by convention, not by design)
- Items pulled from the server lose their original source (overwritten with `'server'`)
- The empty-string convention (`syncSource = ''` means "eligible for push") is implicit and fragile
- Desktop navigation-tracked URLs sync with `syncSource = ''`, same as manual saves — making them indistinguishable on other devices

The fix: **everything syncs**, using the deterministic timestamp-based algorithm we already have. Device IDs (already partially implemented) become the source-of-truth for item origin.

## Current State

### syncSource values in the wild

| Value | Set by | Meaning | Syncs? |
|-------|--------|---------|--------|
| `''` (empty) | Default on item creation | Locally created, never synced | Yes (first push) |
| `'server'` | Sync pull/push | Came from or was pushed to server | Only if modified after last sync |
| `'history'` | Browser extension | Imported from browser history | Yes (empty string check passes*) |
| `'tab'` | Browser extension | Imported from open tabs | Yes* |
| `'bookmark'` | Browser extension | Imported from bookmarks | Yes* |

*Note: Extension imports have non-empty syncSource but `syncedAt = 0`, so they match the push query on incremental sync (`syncSource = '' OR (syncedAt > 0 AND updatedAt > syncedAt)`) — the first condition fails, the second fails too since `syncedAt = 0`. On full sync, only `syncSource = ''` items are pushed. So **extension imports are effectively blocked from syncing**, which was the intent but is encoded implicitly.

### Where syncSource is read/written

**Sync algorithm (push filtering):**
- `backend/electron/sync.ts:515-525` — WHERE clause filters by `syncSource = ''`
- `sync/sync.js:102-107` — Same filter in unified sync engine
- `backend/tauri/src-tauri/src/sync.rs:634-665` — Same filter in Tauri desktop

**Set on push (marks as synced):**
- `backend/electron/sync.ts:619-620` — `syncSource = 'server'` after push
- `sync/sync.js:162-166` — Same
- `backend/tauri/src-tauri/src/sync.rs:799-800` — Same

**Set on pull (marks origin as server):**
- `backend/electron/sync.ts:393-394` — `syncSource = 'server'` on new items from server
- `sync/sync.js:399-400` — Same
- `backend/tauri/src-tauri/src/sync.rs:521-522` — Same

**Reset on server change:**
- `backend/electron/sync.ts:667-668` — Resets all to `syncSource = ''`
- `sync/sync.js:277-282` — Same

**Browser extension (sets import source):**
- `backend/extension/history.js:119` — `syncSource = 'history'`
- `backend/extension/tabs.js:138` — `syncSource = 'tab'`
- `backend/extension/bookmarks.js:84` — `syncSource = 'bookmark'`

**Datastore (gates device metadata):**
- `backend/electron/datastore.ts:2322-2324` — Skips `addDeviceMetadata()` if `syncSource` is present
- `backend/electron/datastore.ts:2404-2406` — Same for updates

**Sync status UI:**
- `backend/electron/sync.ts:773-775` — Counts pending items using syncSource filter
- Extension stats pages count items by syncSource value

### Device ID (already partially implemented)

`backend/electron/device.ts` generates device IDs and adds them to item metadata:

```
metadata._sync = {
  createdBy: "desktop-550e8400-e29b-41d4-a716-446655440000",
  createdAt: 1767023561234,
  modifiedBy: "desktop-550e8400-e29b-41d4-a716-446655440000",
  modifiedAt: 1767023561234
}
```

This metadata **survives sync** (it's inside the JSON blob), unlike `syncSource` which gets overwritten.

### Browser import classifications

Already stored redundantly — **removing syncSource loses nothing**:

- **Tags**: `from:history`, `from:tab`, `from:bookmark` — auto-applied on import
- **Metadata JSON**: Rich browser-specific data (visit counts, tab properties, bookmark dates)

## Changes

### 1. Remove syncSource from sync algorithm

**Push query** — replace syncSource filter with timestamp-based:

Before:
```sql
WHERE (deletedAt = 0 AND (syncSource = '' OR (syncedAt > 0 AND updatedAt > syncedAt)))
```

After:
```sql
WHERE (deletedAt = 0 AND (syncedAt = 0 OR updatedAt > syncedAt))
```

This means: push items that have never been synced (`syncedAt = 0`) or that were modified since last sync. No reference to syncSource.

**After push** — only update `syncId` and `syncedAt`, stop setting `syncSource`:

Before:
```sql
UPDATE items SET syncId = ?, syncSource = 'server', syncedAt = ? WHERE id = ?
```

After:
```sql
UPDATE items SET syncId = ?, syncedAt = ? WHERE id = ?
```

**On pull** — stop setting `syncSource = 'server'` on new items. Device metadata (`_sync.createdBy`) already tracks origin.

**On server change** — reset `syncedAt = 0` to force full re-sync. No need to touch syncSource.

**Files to update:**
- `backend/electron/sync.ts` — lines 393, 515-525, 619-620, 667-668, 773-775
- `sync/sync.js` — lines 102-107, 162-166, 277-282, 399-400
- `backend/tauri/src-tauri/src/sync.rs` — lines 521-522, 634-665, 799-800, 894

### 2. Stop setting syncSource on item creation

**Browser extension** — remove `syncSource` param from `addItem()` calls:
- `backend/extension/history.js:119` — remove `syncSource: 'history'`
- `backend/extension/tabs.js:138` — remove `syncSource: 'tab'`
- `backend/extension/bookmarks.js:84` — remove `syncSource: 'bookmark'`

Classifications are already preserved in tags (`from:*`) and metadata JSON.

**Datastore** — remove syncSource gating on device metadata:
- `backend/electron/datastore.ts:2322-2324` — always call `addDeviceMetadata()`, not just when `!options.syncSource`
- `backend/electron/datastore.ts:2404-2406` — same for updates

### 3. Device ID prefix removal

Device IDs currently use platform prefixes: `"desktop-{uuid}"` (Electron), `"extension-{uuid}"` (browser extension). These prefixes are **not used in any conditional logic** — verified by codebase-wide search. No code checks `startsWith('desktop')` or parses the prefix.

**Change:** Generate plain UUIDs going forward. Platform/type info belongs in the devices table.

**Migration:** On startup, detect prefixed device IDs and strip the prefix:

```
"desktop-550e8400-e29b-41d4-a716-446655440000" → "550e8400-e29b-41d4-a716-446655440000"
```

This requires updating:
1. The stored device ID in `extension_settings`
2. All `metadata._sync.createdBy` and `metadata._sync.modifiedBy` references in existing items

**Detection logic:** Check if device ID matches `/{prefix}-[0-9a-f]{8}-/` pattern. Known prefixes: `desktop-`, `extension-`. Strip prefix, keep UUID.

**One exception:** `backend/extension/environment.js:29` checks `parsed.startsWith('extension-')` for the extension device ID. This needs updating to handle both old prefixed and new plain UUID formats during the transition period.

**Files to update:**
- `backend/electron/device.ts:46` — `crypto.randomUUID()` (remove `desktop-` prefix)
- `backend/extension/environment.js` — update `startsWith('extension-')` check
- Add migration in `backend/electron/datastore.ts` (startup)
- Add migration in `backend/extension/` (startup)

### 4. New `devices` table

Replace the ad-hoc `extension_settings` K/V storage with a proper table.

```sql
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,           -- Plain UUID
    name TEXT DEFAULT '',          -- User-friendly: hostname, "iPhone", etc.
    platform TEXT NOT NULL,        -- 'electron', 'tauri', 'tauri-mobile', 'extension', 'server'
    metadata TEXT DEFAULT '{}',    -- JSON: OS, arch, app version, backend type, capabilities
    createdAt INTEGER NOT NULL,    -- First registration
    lastSeenAt INTEGER NOT NULL    -- Last activity (updated on sync, app launch, etc.)
);
```

**All clients register on startup.** Server nodes also register (even though they don't originate items today, they may in the future — e.g., server-side feed fetching).

**The `metadata._sync.createdBy` / `modifiedBy` fields** reference `devices.id` (plain UUID).

**Synced table:** The devices table itself should sync across all nodes so every client knows about every device. This enables UI like "saved from MacBook" or "last synced from iPhone".

**Schema location:** Add to `schema/v1.json` (or v2 if we version it).

### 5. Mobile filtering (separate task)

Once syncSource cleanup is done and device IDs are reliable, mobile can filter the default list view:

- Items with `metadata._sync.createdBy` matching a device where `platform = 'electron'` AND tagged `from:history` or created by navigation tracking → hide from default list, show in search
- This is a frontend-only change on mobile (no schema changes needed)

## Migration & Backward Compatibility

### syncSource column

**Keep the column** in the schema — removing it would break older clients. Just stop reading/writing it in new code. It becomes a no-op legacy field.

### Existing items

No data migration needed for sync to work. The new push query (`syncedAt = 0 OR updatedAt > syncedAt`) handles all existing items correctly:
- Items with `syncSource = ''` and `syncedAt = 0` → pushed (same as before)
- Items with `syncSource = 'server'` and `syncedAt > 0` → only pushed if modified (same as before)
- Items with `syncSource = 'history'` and `syncedAt = 0` → now pushed (new — these were previously blocked)

The last point means browser imports will start syncing after this change. This is the desired behavior ("everything syncs").

### Device ID migration

Run on startup before any sync operations:

1. Read current device ID from `extension_settings`
2. If it matches `{prefix}-{uuid}` pattern, strip the prefix
3. Update `extension_settings` with the plain UUID
4. Scan items table: `UPDATE items SET metadata = replace(metadata, old_device_id, new_device_id) WHERE metadata LIKE '%' || old_device_id || '%'`
5. Register in new `devices` table

### Rollback safety

If needed, the old sync algorithm still works — it just won't push browser imports (same as today). The syncSource column is preserved, so reverting the push query is a one-line change.

## Prod Impact

- **Low risk**: The sync algorithm change is additive (more items sync, none stop syncing)
- **Browser imports will start syncing**: This is intentional but may surprise users who had large history imports. Consider a one-time notification or a toggle.
- **No breaking API changes**: Server doesn't use syncSource for anything — it stores and returns it, that's all
- **Device ID migration is local-only**: Each client migrates its own stored ID on startup. No server coordination needed.
