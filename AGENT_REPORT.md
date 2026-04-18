# Phase 2.5 #3 Agent Report — createExtensionWindow migration audit

## Audit (Phase A)

Target: `createExtensionWindow()` in `backend/electron/main.ts` (line 1106).
Still uses v1 `preload.js` (`config.preloadPath`). Function creates a
BrowserWindow per extension and loads `peek://ext/{id}/background.html`.

### Call sites (6 inside main.ts, 2 inside ipc.ts)

| Site | Caller | Runtime reachability | Bucket |
|------|--------|----------------------|--------|
| main.ts:1213 | `loadEnabledExtensions()` | **DEAD** — exported but never invoked. Replaced by `loadExtensions()` (entry.ts:741). | dead code |
| main.ts:1458 | `loadExtensions()` — `externalBuiltinIds` loop | **EMPTY in practice.** Filter = `registered ∩ !CONSOLIDATED_EXTENSION_IDS ∩ enabled ∩ !v2FeatureIds`. All 35 features in `features/` are v2 (`manifestVersion: 2`) and get loaded by `loadV2Feature()` into `v2FeatureIds`, so this set is empty. | dead in practice |
| main.ts:1467 | `loadExtensions()` — `enabledExternalExts` from `extensions` DB table | Empty under normal test / dev. The `extensions` table is populated by the legacy settings UI `api.extensions.add()` — superseded by features-manager (which installs into the v2 feature registry, not this table). | dead in practice |
| main.ts:1672 | `loadDevExtension()` | Live when user passes `--load-extension` CLI flag. Dev-only. | v1 path, dev-only |
| main.ts:1747 | `reloadExtension()` | **LIVE.** Called by `ipcMain.handle('extension-reload')` (ipc.ts:1374), which is invoked by `api.extensions.reload(id)` on trustedBuiltin tiles (features-manager, test fixtures). | v1 path, live |
| ipc.ts:1287 | `ipcMain.handle('extension-window-load')` | **DEAD** — no renderer invokes this channel (grep). | dead code |
| ipc.ts:1315 | `ipcMain.handle('extension-window-reload')` | **DEAD** — no renderer invokes this channel (grep). | dead code |

### Bucket summary

- **v2-migratable builtin externals:** 0. All features are already loaded through
  `loadV2Tile()` / `launchTile()` today — `createExtensionWindow` is never
  invoked for them at runtime.
- **Chrome extensions:** 0 — Chrome extensions use a separate path
  (`backend/electron/chrome-extensions.ts` + `session.loadExtension()`), not
  `createExtensionWindow`. Out of scope as planned.
- **v1-only live callers:** 2 — `reloadExtension` (features-manager) and
  `loadDevExtension` (CLI). Both need a v2 "launch/relaunch a tile by id"
  helper that doesn't exist yet (tile-launcher has `launchTile(opts)` but no
  "find the manifest, revoke the old token, close the old window, relaunch"
  convenience).
- **Dead code:** 4 call sites (`loadEnabledExtensions`, two IPC handlers,
  + the two startup branches that are empty in practice). Safe to drop.

### Implementation choice

**Exit at audit boundary.** Migrating `reloadExtension` and `loadDevExtension`
requires:

1. A `relaunchTile(tileId)` helper in `tile-launcher.ts` that re-reads the
   manifest from disk, revokes the old token, closes the old window, and
   calls `launchTile` again.
2. A "find the tile's resident/launch entry from manifest" utility (currently
   only `loadV2Tile` does this, and it's tangled with eager/lazy branching).
3. Handling the dev-extension case where the path is registered
   transiently via `registerDevExtension` and not in the feature registry.

That's 1–2 commits of new infrastructure, not a "remove v1 call site" swap.
Given the 60-minute budget and the audit finding that `createExtensionWindow`
is effectively already replaced for the common path (startup loading), the
correct move is to (a) remove the dead-code call sites cleanly in a follow-up
and (b) defer the remaining two live v1 call sites to a dedicated Phase 2.5 #3b.

### Open items for Phase 3 / follow-up

- **Phase 2.5 #3b** — implement `relaunchTile(tileId)` in tile-launcher.ts;
  rewrite `reloadExtension()` and `loadDevExtension()` to use it; delete
  `createExtensionWindow`, `loadEnabledExtensions`, the dead IPC handlers,
  and the dead `externalBuiltinIds` / `enabledExternalExts` branches.
- Phase 3 can proceed for everything not behind `createExtensionWindow` —
  features-manager reload and CLI dev extensions are the only surfaces
  that still need v1 `preload.js`.

### Files read during audit

- `backend/electron/main.ts` — createExtensionWindow, loadExtensions, loadEnabledExtensions, reloadExtension, loadDevExtension, discoverBuiltinExtensions
- `backend/electron/ipc.ts` — extension-window-* handlers, extension-reload
- `backend/electron/tile-compat.ts` — loadV2Tile, ensureTileIpcHandlers
- `backend/electron/tile-loader.ts` — loadV2Feature, loadFeaturesFromRegistry
- `backend/electron/feature-startup.ts` — initializeFeatures
- `backend/electron/feature-installer.ts` — syncBuiltinFeatures
- `backend/electron/tile-launcher.ts` — launchTile
- `backend/electron/extensions.ts` — getExternalExtensions (reads `extensions` DB table)
- All `features/*/manifest.json` — confirmed 31 of 31 are `manifestVersion: 2`

## Validation

N/A at audit-commit. No code changes landed.
