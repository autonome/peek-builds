# syncSource Migration Test Plan

## Background

The `syncSource` column was removed from desktop and server schemas as part of the sync refactor. Device metadata now lives inside the item's `metadata` JSON field as `_sync: {createdBy, createdAt, modifiedBy, modifiedAt}` with raw UUIDs (no prefixes).

### Current State by Platform

| Platform | syncSource Status | Details |
|----------|------------------|---------|
| Desktop Electron (`backend/electron/`) | Removed from schema + code | No `syncSource` in generated schema or sync code |
| Server (`backend/server/`) | Removed from schema + code | No `syncSource` in db.js or index.js |
| Unified sync module (`sync/sync.js`) | **STILL USES IT** | Push filter, post-push update, pending count all reference `syncSource` |
| iOS mobile (`backend/tauri-mobile/`) | Still has `sync_source` | Actively used for push filtering, merge, post-push |
| Tauri Desktop (`backend/tauri/`) | Still has `sync_source` | Item struct, column access, sync operations |
| Browser Extension (`backend/extension/`) | Clean | No references |

## Issues Found During Investigation

### Critical: `sync/sync.js` not refactored

The unified sync module still actively uses `syncSource`:
- `sync.js:102,107` — push filter: `i.syncSource === ''`
- `sync.js:165` — sets `syncSource: 'server'` after push
- `sync.js:217` — pending count: `i.syncSource === ''`
- `sync.js:279` — server change reset: `syncSource: ''`
- `better-sqlite3.js:34` — adapter schema includes `syncSource TEXT DEFAULT ''`

If this module is used against a DB without `syncSource`, the `i.syncSource === ''` filter evaluates `undefined === ''` → `false`, causing all items to be excluded from push.

### Stale test assertion

`backend/server/test.js:620` asserts `syncSource` column exists:
```js
assert.ok(columnNames.includes("syncSource"))
```
This will fail with the current schema.

### Behavioral change: extension-origin items

Items with `syncSource = 'history'|'tab'|'bookmark'` from the browser extension previously had `syncedAt = 0` and were excluded from push by the old `syncSource !== ''` guard. After migration, `syncedAt = 0` means "never synced, should push" under the new algorithm → these items will be pushed on first sync after upgrade. This is intentional per the refactor design.

## Migration Behavior

### Desktop (Electron)

- **Schema creation**: `CREATE TABLE items` does NOT include `syncSource`
- **Migration**: `migrateSyncColumns` only adds `syncId` — does NOT add or remove `syncSource`
- **Table rebuild** (`migrateItemTypes`): If CHECK constraint update triggers, table is rebuilt WITHOUT `syncSource` → column silently dropped
- **If no rebuild triggers**: `syncSource` persists as orphaned column
- **SELECT * queries**: Return `syncSource` if it exists, but TypeScript `Item` interface ignores it

### Server

- **Schema creation**: No `syncSource` in CREATE TABLE
- **Column renames**: Maps `sync_id`→`syncId`, `synced_at`→`syncedAt`, etc. — NO mapping for `sync_source`/`syncSource`
- **Table rebuild** (`rebuildTableIfNeeded`): If triggered by pending renames, target schema excludes `syncSource` → dropped
- **If no rebuild triggers**: `syncSource` persists as orphaned column
- **Queries**: Use explicit column lists (not SELECT *) → orphaned column is harmless
- **Validation**: `validateSchema()` checks `REQUIRED_SYNC_COLUMNS` from `schema/v1.json` — extra columns ignored

### iOS Mobile

No changes. Still uses `sync_source` for push filtering, merge operations, and post-push updates. iOS has its own local DB schema — not affected by desktop/server refactor.

## Test Scenarios

### Scenario 1: Server DB with snake_case schema (full migration path)

**Setup:** Create DB with old snake_case schema including `sync_source`:
```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT, metadata TEXT,
  sync_id TEXT DEFAULT '', sync_source TEXT DEFAULT '',
  synced_at INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted_at INTEGER DEFAULT 0
);
```

Seed items:
- Item A: `sync_source = ''`, `synced_at = 0` (local, never synced)
- Item B: `sync_source = 'server'`, `synced_at = 1000`, `sync_id = 'remote-1'` (pulled from server)
- Item C: `sync_source = 'server'`, `synced_at = 1000`, `sync_id = 'remote-2'`, `deleted_at = 5000` (soft-deleted synced item)

**Expected:**
- `rebuildTableIfNeeded` triggers (snake→camelCase renames pending)
- All snake_case columns renamed; `sync_source` dropped (not in target schema)
- `PRAGMA table_info(items)` does NOT contain `syncSource` or `sync_source`
- All data preserved with correct values
- `validateSchema()` passes

### Scenario 2: Server DB with camelCase schema + orphaned `syncSource` (no rebuild)

**Setup:** DB already has camelCase columns but also has `syncSource`:
```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('url','text','tagset','image')),
  content TEXT, metadata TEXT, syncId TEXT DEFAULT '', syncSource TEXT DEFAULT '',
  syncedAt INTEGER DEFAULT 0, createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL, deletedAt INTEGER DEFAULT 0
);
```

**Expected:**
- `rebuildTableIfNeeded` does NOT trigger (no pending renames)
- `syncSource` column persists (orphaned but harmless)
- `validateSchema()` passes (extra columns ignored)
- All operations (saveItem, getItems, getItemsSince) work correctly

### Scenario 3: Items with various `syncSource` values survive migration

**Setup:** Scenario 1 DB with additional items:
- Item D: `sync_source = 'history'`, `synced_at = 0` (extension import)
- Item E: `sync_source = 'bookmark'`, `synced_at = 0` (extension import)
- Item F: `sync_source = 'tab'`, `synced_at = 0` (extension import)

**Expected:**
- All items survive migration with correct data
- Under new push algorithm (`syncedAt = 0` → push), items D/E/F become eligible for push
- `getItems` returns all non-deleted items

### Scenario 4: Server receives items WITHOUT `syncSource` from refactored desktop

**Setup:** Fresh server DB (no `syncSource`). Simulate desktop push: `POST /items` with `{ type, content, tags, sync_id, metadata }` (no `syncSource`).

**Expected:**
- `saveItem` succeeds without errors
- Item stored with all fields
- `getItems` returns item correctly

### Scenario 5: `_sync` metadata preserved through migration

**Setup:** Items where `metadata` JSON contains:
```json
{"_sync": {"createdBy": "abc-uuid", "createdAt": 1000, "modifiedBy": "abc-uuid", "modifiedAt": 2000}, "title": "Example"}
```

**Expected:**
- `metadata` column value preserved as-is through table rebuild
- `JSON.parse(item.metadata)._sync.createdBy === 'abc-uuid'`

### Scenario 6: Desktop table rebuild drops `syncSource`

**Note:** Requires Electron environment. Manual test or future unit test.

**Setup:** Desktop DB with old CHECK constraint (`type IN ('note','text','tagset')`) and `syncSource` column, with a 'note' type item.

**Expected:**
- `migrateItemTypes` triggers table rebuild
- New table does NOT include `syncSource` → column dropped
- Data copied correctly

### Scenario 7: Fix stale server test assertion

`backend/server/test.js:620` asserts `syncSource` exists. Update to assert it does NOT exist, or remove the assertion.

## Implementation

### Primary: `backend/server/test-migration.js`

Node.js test file using `node:test` (matches existing `backend/server/test.js` pattern):
- Uses `better-sqlite3` directly to create legacy DBs in temp directories
- Calls `db.js` `initializeSchema` to trigger migrations
- Verifies schema (`PRAGMA table_info`) and data post-migration
- Self-cleaning via `fs.rmSync`

Run: `node --test backend/server/test-migration.js`

### Secondary: Fix `backend/server/test.js`

Update or remove the stale `syncSource` assertion at line 620.

### Future: Refactor `sync/sync.js`

The unified sync module needs the same refactor as desktop/server — replace `syncSource` filtering with timestamp-based filtering. This is a separate task.

## Files to Modify

| File | Change |
|------|--------|
| `backend/server/test-migration.js` | New file — migration simulation tests (Scenarios 1-5) |
| `backend/server/test.js` | Fix stale `syncSource` assertion (Scenario 7) |
| `sync/sync.js` | Future — refactor to remove `syncSource` references |

---
