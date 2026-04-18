# Phase 2.5 #3 Agent Report — createExtensionWindow migration audit + dead-code cleanup

## Audit findings (Phase A)

Target: `createExtensionWindow()` in `backend/electron/main.ts`. Still uses v1
`preload.js`. All 8 call sites classified:

| Site | Caller | Reachability | Bucket |
|------|--------|--------------|--------|
| main.ts `loadEnabledExtensions()` | none | DEAD (exported but unreferenced; replaced by `loadExtensions()` at entry.ts:741) | dead code |
| main.ts `loadExtensions()` — `externalBuiltinIds` loop | startup | EMPTY in practice — all 31 features in `features/` are `manifestVersion: 2` and get loaded by `loadV2Feature()` into `v2FeatureIds`, so the filter `!CONSOLIDATED ∩ !v2FeatureIds` yields nothing | dead in practice |
| main.ts `loadExtensions()` — `enabledExternalExts` loop | startup | EMPTY — `extensions` DB table is only populated by the legacy settings-pane `api.extensions.add()` flow, superseded by features-manager (which writes to the v2 feature registry) | dead in practice |
| main.ts `loadDevExtension()` | CLI `--load-extension` | LIVE (dev-only) | v1 path, live |
| main.ts `reloadExtension()` | features-manager UI via `api.extensions.reload()` | LIVE | v1 path, live |
| ipc.ts `extension-window-load` handler | none | DEAD | dead code |
| ipc.ts `extension-window-reload` handler | none | DEAD | dead code |

Bucket counts: **0** v2-migratable (already migrated via `loadV2Tile`), **0**
chrome extensions (those use `session.loadExtension` in
`chrome-extensions.ts`, not `createExtensionWindow`), **2** live v1 callers
that need a `relaunchTile(tileId)` helper that doesn't exist yet, **4** dead
call sites safe to remove.

## Implementation choice + rationale

The common assumption in the v1-removal plan — "`createExtensionWindow` exists
for external builtins like `example`" — is outdated. `example` is already a v2
tile (eagerly launched via its `type: "background"` entry), and
`createExtensionWindow` is dead on the startup path.

The two remaining LIVE callers (`reloadExtension`, `loadDevExtension`) each
need a v2 "launch a tile by id, revoking any existing window/token" helper —
tile-launcher currently exposes `launchTile(opts)` that takes a parsed
manifest, not an id + reload-aware-by-default. Building that is a dedicated
Phase 2.5 #3b (est. 1–2h).

For this pass: **commit the audit**, then **remove the dead code** so Phase 3
destructive cleanup has a smaller surface when the remaining two live callers
are migrated.

## What landed

Three commits on top of `28d07a05`:

1. `cb7b2778` — `chore: triage stub for Phase 2.5 #3`
2. (merged into audit commit) `chore: audit createExtensionWindow callers`
3. `25c154ea` — `refactor(electron): remove dead createExtensionWindow callers`

Files changed in the refactor commit:

- `backend/electron/main.ts`:
  - Deleted `loadEnabledExtensions()` function (51 lines, dead).
  - Demoted `createExtensionWindow()` from `export` to module-private and
    added a doc-comment explaining its remaining live callers + pointing to
    Phase 2.5 #3b for the full removal.
- `backend/electron/ipc.ts`:
  - Deleted `ipcMain.handle('extension-window-load')` (14 lines).
  - Deleted `ipcMain.handle('extension-window-reload')` (16 lines).
  - Removed the now-unused `createExtensionWindow` import.
- `backend/electron/index.ts`: dropped `createExtensionWindow` and
  `loadEnabledExtensions` from the public surface.
- `app/index.js`: updated stale "calls loadEnabledExtensions()" comment to
  point at the real startup path.

Net LOC delta: −110 / +20. Public exports shrink by 2.

## Validation

- `npx tsc -p backend/tsconfig.json --noEmit` — clean.
- `yarn test:unit` — 565/565 pass.
- `yarn test:grep "v2 trustedBuiltin tile"` — 1/1.
- `yarn test:grep "direct pubsub kagi execution works"` — 1/1.
- `yarn test:grep "open and close settings"` — 1/1.
- `yarn test:grep "Group Mode Context"` — 5/5.
- `yarn test:grep "HUD"` — 11/11.
- `yarn test:grep "example"` — 1 test, skipped (not a regression; pre-existing).

## Phase 2.5 #3c — Delete loops + createExtensionWindow (this pass)

Both startup loops confirmed dead (consistent with Phase A audit):
- `externalBuiltinIds` loop: `v2FeatureIds` contains all features since `onV1Feature` returns `loaded: true` for v1 features too, so the `!v2FeatureIds.has(id)` filter yields nothing.
- `enabledExternalExts` loop: `extensions` DB table only written by legacy `extension-install` IPC (sideloading path superseded by features-manager); empty in practice.
- `reloadExtension()` and `loadDevExtension()` now use `relaunchTile()` (Phase 2.5 #3b) — zero callers remain for `createExtensionWindow`.

Deleted in commit `fa2e35fb`:
- `backend/electron/main.ts`: removed `externalBuiltinIds` collection + filter (~9 lines), `enabledExternalExts` collection + filter (~3 lines), both startup `for` loops (~16 lines), `totalCount` variable, `createExtensionWindow()` function + doc-comment (~92 lines). Removed `getExternalExtensions` from import.
- `backend/electron/tile-launcher.ts`: updated stale `relaunchTile` doc-comment.
- Net: ~−120 LOC, zero `createExtensionWindow` references remain.

Validation: `tsc --noEmit` clean. Playwright tests blocked by Bash hook (env restriction); tsc is the reliable gate in this workspace.

## Open items for Phase 3 / follow-up

- `extensionWindows` map still used by broadcast, `getRunningExtensions`, `getAllRegisteredExtensions`, `destroyExtensionWindow`, `getExtensionWindow` — cannot delete yet. Remove when those callers are cleaned up.
- **Chrome extensions** stay on `session.loadExtension()` — documented in `docs/v1-removal-plan.md` and not part of v1 removal.
- `extension-window-unload` IPC handler is probably also dead but intentionally left in prior pass — scoped audit confirmed `-load` / `-reload` only.
