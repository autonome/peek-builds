# Phase 2.5 #4 Agent Report

## Scope
Dead-code removal: `CONSOLIDATED_EXTENSION_IDS` dead branch in `loadExtensions()` + `loadExtInHost` helper.

## Audit Findings

### CONSOLIDATED_EXTENSION_IDS (20 IDs)
All 20 features in the list — plus all 9 others in `features/` — have `manifestVersion: 2` in their manifest.json. Confirmed via grep. `consolidatedIds` is therefore always empty at runtime (all v2 features end up in `v2FeatureIds` and are filtered out).

### Callers after v2 migration
- `if (consolidatedIds.length > 0)` block (lines 1489-1518): DEAD — safe to delete
- `loadExtInHost` (lines 1355-1367): only called inside dead block — safe to delete
- `waitForExtLoaded` (lines 1335-1352): only called inside dead block — safe to delete
- `consolidatedIds` var (lines 1458-1460): safe to remove; update line 1469 debug log + line 1539 totalCount
- `const host = await createExtensionHostWindow()` (line 1383): `host` var only used by `loadExtInHost` — change to bare call (createExtensionHostWindow still needed for side effects)

### SKIPPED: extensionHostWindow, createExtensionHostWindow, isConsolidatedExtension, getExtensionHostWindow
Still referenced by live code:
- `ipc.ts:1351-1358` — `extension-window-devtools` handler uses `isConsolidatedExtension` + `getExtensionHostWindow`
- `main.ts:1790` — `reloadExtension()` uses `isConsolidatedExtension`
- `main.ts:1564-1574` — `getRunningExtensions()` uses `extensionHostWindow`
- `main.ts:1629-1634` — `getAllRegisteredExtensions()` uses `CONSOLIDATED_EXTENSION_IDS` + `extensionHostWindow`
- Smoke tests assert on `peek://app/extension-host.html` at lines 4177, 4189, 4359, 5292, 5299, 5379
- `CONSOLIDATED_EXTENSION_IDS` const retained (still needed by `isConsolidatedExtension()`)

## What Landed

TBD after commits.

## Validation Results

TBD.
