# Plan: Trimming v1-compat API Surface in `tile-preload.ts`

## 0. Context and Scope

The overnight audit added v1-compat shims to `backend/electron/tile-preload.ts` so that 26+ migrated features keep working. The shims are a **superset** of the strict capability-gated surface and bypass enforcement: they delegate directly to the legacy `datastore-*`, `registershortcut`, `file-save-dialog`, `context-get`, and `modes:*` handlers in `backend/electron/ipc.ts`, which do not check `CapabilityGrant`.

Strict handlers in `backend/electron/tile-ipc.ts` (`tile:datastore:*`, `tile:settings:*`, `tile:theme:*`, `tile:filesystem:*`, `tile:network:fetch`, `tile:window:*`) already call `getGrantForToken(args.token)` and check `hasCapability`, `hasDatastoreTable`, `isNetworkDomainAllowed`, etc. The shims bypass all of that.

### Scope surprise: partial-shim gaps

While auditing, three calls used by features are **not** in the tile-preload shim:

- `api.context.setMode(...)` / `watchMode` / `getWindowsInSpace` / `getMode` — used by `groups`, `editor`, `spaces`. Shim has `context.get/set/history/snapshot/windowsWithValue/windowsInSpace` but NOT `setMode`.
- `api.ipc.invoke(...)` — used by `features-manager` for `feature-registry:*`. Not exposed in tile-preload.
- Extended `api.window.*`: `list`, `getFocusedVisibleWindowId`, `exists`, `show`, `hide`, `resize`, `setTitle`, `setOverlayFocusTarget`. Not in tile-preload `api.window` (which only has `open/close/getInfo`).
- `api.debug` — referenced by 34 feature files.
- `api.settings.getExtKey(extId, key)` — used by groups/tags/entities for cross-tile reads.

**These are genuine missing surfaces.** The trimming plan covers both "add strict version + remove shim" and "add missing surface, then strict-gate it".

---

## 1. Shim Inventory

| # | Shim | Usage | Files | Strict equivalent | Capability | Effort |
|---|------|---:|---:|---|---|---|
| 1 | `api.subscribe(topic, cb, scope?)` | 198 | 71 | `api.pubsub.subscribe` | `pubsub` | trivial |
| 2 | `api.publish(topic, data, scope?)` | 147 | 58 | `api.pubsub.publish` | `pubsub` | trivial |
| 3 | `api.datastore.*` (30+ methods) | 144 | 19 | **none** (`tile:datastore:*` unimplemented) | `datastore` + tables allowlist | **complex** |
| 4 | `api.shortcuts.register/unregister` | 24 | 10 | none (legacy `registershortcut`) | `shortcuts` | moderate |
| 5 | `api.files.open/save/readFromPath/writeToPath` | 7 | 3 | `api.filesystem.read/write` (exists, gated); dialogs NOT covered | `filesystem` + new `files.dialogs`? | moderate |
| 6 | `api.modes.*` | 0 | 0 | none | context/modes | **unused — delete** |
| 7 | `api.context.get/set/history/snapshot/windowsWithValue/windowsInSpace` | ~8 + ~15 NON-shimmed | ~7 | none | `context` (new) | complex |
| 8 | `api.closeWindow(id?)` | 0 | 0 | `api.window.close()` | `window.manage` | **unused — delete** |
| 9 | `api.settings.getKey/setKey` | ~10 | 5 | `api.settings.get/set` | `settings` | trivial |
| 10 | `api.settings.getExtKey` | ~8 | 5 | none (cross-tile read) | new `settings.readForeign`? | moderate / recommend removal |

### Missing surfaces (separate track)

| # | Missing surface | Usage | Action |
|---|-----|---:|---|
| 11 | `api.context.setMode/watchMode/getWindowsInSpace/getMode` | ~13 sites | Add to strict, then gate |
| 12 | `api.ipc.invoke` | 39 sites (features-manager) | Replace with strict `api.features.*` |
| 13 | Extended `api.window.*` | ~15 sites | Add strict variants under `window.query` / `window.manage` sub-caps |
| 14 | `api.debug` | 34 files | Expose unconditionally (read DEBUG from config) |
| 15 | `api.scopes.SELF/GLOBAL` | ~145 refs | Already in tile-preload. Keep. |

---

## 2. Strict-mode API Additions

### 2.1 `tile:datastore:*` — the big one

Legacy handlers do **zero** capability checks. New strict handlers must:
1. `getGrantForToken(args.token)`
2. `hasCapability(grant, 'datastore')`
3. Per-op table check `hasDatastoreTable(grant, table)`. Mapping:
   - items: addItem/getItem/updateItem/queryItems/deleteItem/hardDeleteItem
   - tags: getOrCreateTag/renameTag/deleteTag/updateTagColor
   - item_tags: tagItem/untagItem/getItemTags/getItemsByTag (also reads items+tags)
   - item_events: addItemEvent/queryItemEvents/etc
   - arbitrary table (from `getTable/setRow/getRow`): check against allowlist
4. Delegate to datastore.ts functions directly (not legacy IPC).

New handler names: `tile:datastore:add-item`, `tile:datastore:get-item`, `tile:datastore:tag-item`, etc. — parallel to existing v1 names. In preload, `api.datastore.*` stays API-stable but routes through strict IPC.

### 2.2 `api.subscribe/publish` aliases

Already resolve to `api.pubsub.*`. Trim: grep-sweep feature code, rewrite, delete top-level aliases. Cosmetic.

### 2.3 `api.shortcuts.*` strict version

Build `tile:shortcuts:register/unregister`. Validate token + `shortcuts` capability. Optionally add per-key allowlist via `capabilities.shortcuts.keys: string[]`.

### 2.4 `api.files.*` dialogs — new mini-capability

Extend `FilesystemCapability` with `dialogs?: boolean`. Only `editor` and `files` need it.

### 2.5 `api.context.*` — new top-level capability

Add to `TileCapabilities`:
```ts
context?: {
  read?: string[];      // Keys tile can read
  write?: string[];     // Keys tile can write
  modes?: boolean;      // Allow mode management
  queryWindows?: boolean;  // Allow windowsInSpace, windowsWithValue
};
```

Used by groups, editor, spaces, entities, hud.

### 2.6 `api.settings.getKey/setKey` — wrapper

Pure wrapper. Keep both or migrate to `api.settings.get/set`. Trivial.

### 2.7 `api.settings.getExtKey` — recommend removal

Cross-tile reads are a security boundary. Recommend replacing with pubsub broadcasts.

### 2.8 `api.ipc.invoke` — features-manager only

Design strict `api.features.*` with new `features` capability, restricted to builtin tiles.

### 2.9 Extended `api.window.*`

Strict wrappers: `tile:window:list`, `:exists`, `:show`, `:hide`, `:resize`, `:setTitle`, `:getFocusedVisibleWindowId`, `:setOverlayFocusTarget`. Gate by `window.query` / `window.manage`.

### 2.10 `api.debug`

Expose unconditionally from config. No capability.

---

## 3. Capability Mapping (manifest diffs)

| Feature | Current caps | Required additions |
|---|---|---|
| `tags` | pubsub, datastore[items, tags, item_tags, item_events], window, commands, shortcuts, settings | — |
| `groups` | same | **+context:{read:['mode'], write:['mode'], modes:true, queryWindows:true}** |
| `editor` | pubsub, datastore, window, commands, shortcuts, settings | **+filesystem.dialogs:true**, **+context:{read/write:['mode'], modes:true}** |
| `spaces` | (verify) | **+context** |
| `features-manager` | pubsub, commands, shortcuts | **+features:true** (new builtin-only cap) |
| `lex` | pubsub, settings | — |
| `hud` | pubsub, settings, shortcuts | **+context:{read:['mode']}** |
| `entities` | (verify) | **+context:{read/write:['entities']}** |
| Others | various | Verify via audit script |

**Action:** write `scripts/audit-tile-caps.js` that reads every manifest + feature code, greps for `api.X` calls, produces pre/post diff.

---

## 4. Phased Migration

### Phase 1 — Inventory and tooling (1-2 days)

1. Audit script `scripts/audit-tile-caps.js`
2. Usage matrix `docs/tile-preload-trimming-matrix.md`
3. Capability-violation detector: log once per (tile, shim) pair — drives evidence

### Phase 2 — Strict-mode API additions (3-5 days)

Order: biggest surface first.
1. Datastore strict IPC
2. Context capability (extend TileCapabilities, add handlers, add api.context.*)
3. Shortcuts strict
4. Window strict extensions
5. Features strict (features-manager only)
6. Dialogs
7. Settings cleanup

### Phase 3 — Per-feature migration (2-4 weeks)

**Round 1 (trivial):** sync, widget-demo, helpdocs, websearch, mcp-server, dropzone, timers

**Round 2 (moderate):** tag-actions, peeks, lists, pagestream, slides, scripts, windows, feeds, search, tags, sheets, example

**Round 3 (complex — new capabilities):** entities, hud, spaces, groups, editor, lex, wonderwall, features-manager

**Per-feature PR checklist:**
- Update manifest capabilities
- Sweep feature code replacing shim calls
- Run test suite
- Manual smoke test
- Grep for remaining shim references
- Capability-violation log zero entries

### Phase 4 — Remove shims ✓ COMPLETE (Apr 2026)

Gate: 48-hour zero-violation burn-in.
1. ✓ Delete shim blocks from tile-preload.ts
2. ✓ Add hard-fail runtime assertions for removed names
3. ✓ Remove v1-compat violation logger (wrapCompat/wrapCompatObject/compatSeen)
4. ✓ Remove v1 legacy fallback branches from all feature background.html files (22 files)
5. ✓ Update docs

**Shims removed:**
- `api.publish` / `api.subscribe` top-level aliases → hard-fail (use `api.pubsub.*`)
- `api.datastore.*` v1-compat helpers (30+ methods) → hard-fail stubs (strict `get/set/query/extractPageContent` remain)
- `api.shortcuts` v1-compat fallback → strict-only, throws if no capability declared
- `api.files.*` → hard-fail (use `api.dialogs.*` and `api.filesystem.*`)
- `api.modes.*` → hard-fail (was zero-usage)
- `api.closeWindow` top-level → hard-fail (use `api.window.close()`)
- `api.settings.getKey/setKey` → hard-fail (use `api.settings.get/set`)
- `api.settings.getExtKey` v1-compat fallback → strict-only, throws if no `settings.readForeign` declared

**Feature HTMLs cleaned (22 files):**
editor, entities, example, features-manager, files, groups, helpdocs, lex,
mcp-server, pagestream, pagewidgets-sample, peeks, scripts, search, sheets,
slides, tag-actions, tags, timers, websearch, widget-demo, windows, wonderwall

**Remaining call sites found in non-scope code:**
- `pagewidgets-sample/background.js`: still uses `api.publish/subscribe` directly (not in task scope — HTML cleaned)
- `files/background.js`: uses `api.files.open/save` (migrated to throw; feature JS needs update separately)
- `groups/background.js`: uses `api.settings.getExtKey` (has `settings.readForeign` declared → strict path works)
- `tags/home.js`, `features-manager/publish.js`: use `api.settings.getExtKey` (need capability check)

### Phase 5 — Lock down ✓ COMPLETE (Apr 2026)

1. ✓ `TILE_STRICT=true` env var — throws instead of warns on capability violations
2. ✓ Capability-violation events → `tile:capability-violation` pubsub topic (GLOBAL scope, rate-limited 5s)
3. ✓ Static `window.app` typings in `backend/electron/tile-api.d.ts`

**Deliverables:**
- `backend/electron/config.ts` — added `TILE_STRICT` flag
- `backend/electron/tile-violations.ts` — `publishCapabilityViolation()` helper with rate limiting
- `backend/electron/tile-ipc.ts` — all rejection paths wired to `handleViolation()` (throws in TILE_STRICT mode, publishes violation event always)
- `backend/electron/tile-api.d.ts` — static typings for `window.app` surface
- `backend/electron/tile-strict.test.ts` — tests for violation event shape, rate limiting, TILE_STRICT throw contract
- `docs/tile-api.md` — documented TILE_STRICT, violation topic, and .d.ts reference

---

## 5. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Silent breakage from uninventoried shim | medium | high | Phase 1 violation logging |
| Table allowlist too restrictive | medium | medium | Add to manifest during migration |
| Pubsub topic allowlist rejects topics | medium | medium | Verify during audit |
| `api.context.setMode` semantic drift | medium | high | Port v1 preload signatures exactly; unit tests |
| Manual flows break despite tests | medium | medium | Extra QA for groups/editor |
| Cross-tile `getExtKey` polyfill breaks | high | medium | Deprecate first, then remove |

---

## 6. Testing Strategy

### Unit tests (`tile-capability-enforcement.test.ts`)
- `tile:datastore:add-item` rejects without `datastore` cap
- Rejects without table in allowlist
- `tile:datastore:tag-item` requires items+tags+item_tags
- `tile:shortcuts:register` rejects without `shortcuts`
- `tile:context:set` rejects if key not in write allowlist
- `tile:features:*` rejects non-builtin tiles

### Integration tests (`tile-capability-enforcement.spec.ts`)
Launch test tile with narrow manifest, verify allowed/denied paths.

### Contract tests
For every `api.*` in tile-preload:
1. IPC channel exists in tile-ipc.ts
2. Handler calls `getGrantForToken` first
3. Handler has capability check

### Capability-violation monitor
Phase 1 logging becomes Phase 4 test assertion: zero `[tile-compat] shim` logs in full Playwright run.

---

## 7. Deliverables by Phase

| Phase | Artifact | Location |
|---|---|---|
| 1 | Audit script | `scripts/audit-tile-caps.js` |
| 1 | Usage matrix | `docs/tile-preload-trimming-matrix.md` |
| 1 | Violation logger | `tile-preload.ts` |
| 2 | Strict handlers | `tile-ipc.ts` |
| 2 | `TileCapabilities` extensions | `tile-manifest.ts` |
| 2 | Strict preload surfaces | `tile-preload.ts` (alongside shims) |
| 2 | Unit tests | `tile-capability-enforcement.test.ts` |
| 3 | Per-feature migrations | `features/<feature>/` |
| 3 | Manifest updates | `features/<feature>/manifest.json` |
| 4 | Shim removal | `tile-preload.ts` (-300 lines) |
| 4 | Hard-fail stubs | `tile-preload.ts` |
| 4 | API reference | `docs/tile-api.md` |
| 5 | Strict-mode env flag | `tile-ipc.ts` + `config.ts` |
| 5 | Capability typings | `tile-api.d.ts` (generated) |

---

## 8. Effort Summary

- Phase 1: 1-2 days
- Phase 2: 3-5 days
- Phase 3: 2-4 weeks (one PR per feature, incremental)
- Phase 4: 1-2 days
- Phase 5: ongoing, low effort

**Total realistic: ~4-6 engineer-weeks.**
