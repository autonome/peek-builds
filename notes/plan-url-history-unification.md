# Implementation Plan: URL/History Unification

## Status: COMPLETED (Feb 11, 2026)

All 6 phases implemented and committed:
- `475e97fe` Phase 1: Remove dual-write
- `f8beaef1` Phase 2: Redirect renderer address API calls to items
- `67483a8a` Phase 3: IPC compatibility layer
- `bca71da1` Phase 4: Update tests
- `7ee8e9cb` Phase 5: Update Tauri backend
- `6f90f258` Phase 6: Cleanup — drop tables, remove dead code and types

Results: 231 unit tests pass, 155 electron tests pass (0 regressions). Actual effort: ~2-3 hours, not 4 weeks — data migration was already done by existing migrations.

---

## 1. Current State Audit (pre-implementation)

The codebase has two parallel data models that have been partially unified through migrations already applied.

### 1.1 Tables in the addresses/visits system

**`addresses` table** (datastore.ts line 57-76)
Columns: `id`, `uri`, `protocol`, `domain`, `path`, `title`, `mimeType`, `favicon`, `description`, `tags`, `metadata`, `createdAt`, `updatedAt`, `lastVisitAt`, `visitCount`, `starred`, `archived`

**`visits` table** (line 83-94)
Columns: `id`, `addressId`, `timestamp`, `duration`, `source`, `sourceId`, `windowType`, `metadata`, `scrollDepth`, `interacted`, `prevId`, `nextId`

**`address_tags` table** (line 142-150)
Columns: `id`, `addressId`, `tagId`, `createdAt`

### 1.2 Tables in the items system

**`items` table** (line 267-282, frecency columns added by migration at line 1030-1057)
Columns: `id`, `type`, `content`, `mimeType`, `metadata`, `syncId`, `syncedAt`, `createdAt`, `updatedAt`, `deletedAt`, `starred`, `archived`, `visitCount`, `lastVisitAt`, `frecencyScore`, `title`, `domain`, `favicon`

**`item_visits` table** (line 304-322)
Columns: `id`, `itemId`, `timestamp`, `duration`, `source`, `sourceId`, `windowType`, `metadata`, `scrollDepth`, `interacted`, `prevId`, `nextId`

**`item_tags` table** (line 289-297), **`item_events`** (line 351-362), **`item_groups`** (line 324-335), **`item_group_members`** (line 338-349)

### 1.3 Existing Migrations Already Applied

1. **`migrateAddressesToItems()`** (line 790-889) — Migrates TAGGED addresses to items
2. **`migrateAllAddressesToItems()`** (line 1080-1237) — Migrates ALL addresses to items
3. **`migrateVisitsToItemVisits()`** (line 1244-1348) — Migrates all visits using address-to-item mapping
4. **`migrateItemFrecencyColumns()`** (line 1030-1057) — Adds frecency columns to items

**Data is already migrated.** Work is purely code elimination.

### 1.4 Functions Operating on addresses/visits (OLD system)

All in `backend/electron/datastore.ts`:

| Function | Line | Purpose |
|----------|------|---------|
| `addAddress()` | 1918 | Creates address record |
| `getAddress()` | 1950 | Get address by ID |
| `updateAddress()` | 1954 | Update address fields |
| `queryAddresses()` | 1967 | Query addresses with filters |
| `addVisit()` | 2005 | Record visit + update address stats + update matching items |
| `queryVisits()` | 2054 | Query visits table |
| `trackWindowLoad()` | 2119 | Dual-writes to BOTH systems |
| `getHistory()` | 2160 | Joins visits with addresses |
| `tagAddress()` | 2288 | Tags an address |
| `untagAddress()` | 2312 | Untags an address |
| `getAddressTags()` | 2346 | Gets tags for an address |
| `getAddressesByTag()` | 2354 | Gets addresses with a specific tag |
| `getUntaggedAddresses()` | 2362 | Gets addresses without tags |
| `queryAddressesCompat()` | 3179 | Compatibility wrapper (never called) |

### 1.5 Functions Operating on items (NEW system)

| Function | Line | Purpose |
|----------|------|---------|
| `addItem()` | 2432 | Creates item with device metadata |
| `getItem()` | 2490 | Get item by ID |
| `updateItem()` | 2498 | Update item with metadata merge |
| `deleteItem()` | 2577 | Soft delete |
| `trackNavigation()` | 2937 | Find-or-create item + record visit (also writes to legacy visits at line 3009-3018) |
| `recordItemVisit()` | 2808 | Records visit in item_visits + updates frecency |
| `queryItems()` | 2675 | Query items with filters |
| `queryItemsByFrecency()` | 3027 | Query URL items by frecency score |
| `tagItem()` | 2741 | Tags an item |
| `untagItem()` | 2774 | Untags an item |
| `getItemTags()` | 2784 | Gets tags for an item |
| `getItemsByTag()` | 2795 | Gets items with a specific tag |
| `getItemVisits()` | 2848 | Gets visits for an item |
| `queryItemVisits()` | 2878 | Query all item visits |

### 1.6 Dual-Write Points (Critical)

1. **`trackWindowLoad()`** (line 2119-2155) — calls `trackNavigation()` for items, then ALSO calls `addAddress()` + `addVisit()` for addresses
2. **`trackNavigation()`** (line 2937-3021) — writes to items/item_visits, then at line 3009-3018 ALSO calls `addVisit()` on matching address
3. **`addVisit()`** (line 2005-2052) — updates addresses stats, then at line 2042-2049 ALSO updates matching items

### 1.7 Call Sites for Address APIs (Renderer Side)

- **`app/datastore/history.js`** — Uses `queryAddresses()`, `addAddress()`, `addVisit()`, `queryVisits()`, `getAddress()`
- **`app/index.js`** (lines 345, 369) — Theme persist commands use `queryAddresses({})` and `updateAddress()`
- **`tests/desktop/smoke.spec.ts`** — Extensive use of `addAddress`, `tagAddress`, `getAddressTags`, etc.

### 1.8 Already on Items System

- `features/editor/`, `features/tags/`, `features/groups/`, `features/cmd/commands/history.js`
- `features/feeds/`, `features/entities/`, `app/page/page.js`
- `backend/electron/sync.ts`, `backend/extension/` (browser extension)
- `schema/v1.json` — Canonical schema defines ONLY the new system

---

## 2. Schema Design

**No schema changes needed.** The items table already has all relevant address columns mapped:
- `uri` → `content`
- `domain`, `title`, `favicon`, `mimeType` → same columns on items
- `description` → stored in items.metadata JSON
- `tags` (comma string) → superseded by item_tags junction table
- `protocol`, `path` → derivable from `content` URL parsing
- `item_visits` has identical columns to `visits` (just `itemId` instead of `addressId`)

---

## 3. Migration Plan

### Phase 1: Remove Dual-Write (Backend)

**Files:** `backend/electron/datastore.ts`

1. **`trackNavigation()`** (line 2937-3021): Remove lines 3009-3018 (legacy visits write)
2. **`trackWindowLoad()`** (line 2119-2155): Remove lines 2133-2153 (legacy addresses/visits). Just call `trackNavigation()` and return.
3. **`addVisit()`** (line 2005-2052): Remove lines 2042-2049 (cross-update to items)

**Testing:** `yarn test:electron:bg` — all tests should pass since new code reads from items.

### Phase 2: Redirect Renderer Address API Calls to Items

**Files:**

1. **`app/datastore/history.js`** — Rewrite to use `queryItems({ type: 'url' })`, `trackNavigation()`, `queryItemVisits()` instead of address APIs
2. **`app/index.js`** (lines 335-380) — Theme persist: use `queryItems({ type: 'url' })` and `updateItem()`
3. **`app/windows.js`** (line 3, 17) — Ensure `maybeTrackNavigation()` works with new API

### Phase 3: IPC Compatibility Layer (parallel with Phase 2)

**Files:** `backend/electron/ipc.ts`

Redirect address IPC handlers to delegate to item operations:
- `datastore-add-address` → `addItem('url', ...)`
- `datastore-query-addresses` → `queryItems({ type: 'url' })` + transform
- `datastore-tag-address` → `tagItem()`
- etc.

### Phase 4: Update Tests (depends on Phase 2+3)

**Files:** `tests/desktop/smoke.spec.ts`

Rewrite all address API usage to item APIs:
- `addAddress(uri, opts)` → `addItem('url', { content: uri, ... })`
- `tagAddress(addressId, tagId)` → `tagItem(itemId, tagId)`
- etc.

### Phase 5: Update Tauri Backend (parallel with Phase 4)

**Files:** `backend/tauri/src-tauri/src/datastore.rs`, `commands/datastore.rs`, `lib.rs`, `preload.js`, `src/preload.ts`

Remove all address/visits/address_tags schema, functions, and command registrations.

### Phase 6: Cleanup — Drop Old Tables (depends on ALL above)

**Files:** `backend/electron/datastore.ts`, `ipc.ts`, `preload.js`, `backend/electron/index.ts`, `backend/types/index.ts`, `app/datastore/history.js`, `main.ts`

- Remove all address/visits/address_tags table creation, CRUD functions, IPC handlers, preload APIs, type definitions
- Add migration: `DROP TABLE IF EXISTS address_tags; DROP TABLE IF EXISTS visits; DROP TABLE IF EXISTS addresses;`
- Keep migration IDs in the settings table so they don't re-run

---

## 4. Risk Assessment

**Data loss:** MITIGATED — migrations already copied all data. Run a one-time re-sync before dropping tables.

**Rollback:** Non-destructive until Phase 6. Old tables exist with original data through Phases 1-5.

**Tests masking issues:** Phase 3 redirect layer could give false positives. Phase 4 rewrites tests to use item APIs directly.

---

## 5. Dependency Map

```
Phase 1 (Remove dual-write)
    |
    v
Phase 2 (Redirect renderer)  <--parallel-->  Phase 3 (IPC compat)
    |                                              |
    v                                              v
Phase 4 (Update tests)  <--parallel-->  Phase 5 (Tauri backend)
    |                                              |
    v                                              v
Phase 6 (Cleanup — drop tables, remove dead code)
```

## 6. Estimated Effort

- Phase 1: 1-2 hours (small code removal)
- Phase 2: 2-4 hours (rewrite history.js, update index.js)
- Phase 3: 2-4 hours (IPC handler rewiring)
- Phase 4: 4-8 hours (extensive test rewriting)
- Phase 5: 4-6 hours (Rust code removal)
- Phase 6: 2-4 hours (code cleanup, table drops)

**Total: 2-3 days** (not 4 weeks — data migration and schema work is already done)
