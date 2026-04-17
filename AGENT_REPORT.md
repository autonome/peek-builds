# Agent Report: Single-File Tiles

## Plan doc

`docs/tiles-single-file.md`

## Concept summary

A tile is a feature. There is one kind of tile. **Residency** (`resident: true`) is
the only lifecycle flag in the manifest — it means "load at startup, stay live."
**Visibility** is always a runtime choice; every tile starts hidden. `showSelf()` /
`hideSelf()` are token-scoped, require no capability, and let any tile reveal or
dismiss its own window.

## Runtime changes

| File | What changed |
|------|-------------|
| `backend/electron/tile-manifest.ts` | Added `resident?: boolean` and flat window fields (`width`, `height`, etc.) to `TileEntry`. Made `type` optional. Updated validation to accept no-`type` entries. |
| `backend/electron/tile-launcher.ts` | Merged `windowHints` + flat entry fields (top-level wins). Dropped `type === 'background'` 0x0/skipTaskbar block. `show: false` is now the default for all tiles. Dropped `type === 'window'` URL match preference. |
| `backend/electron/tile-compat.ts` | Residency decision: `t.resident === true || t.type === 'background'`. Eager launch reads resident entry by name instead of background-by-type. Fixed `shouldLazyLoad` logic (was `|| true`). |
| `backend/electron/tile-ipc.ts` | Added `tile:window:show-self` and `tile:window:hide-self` handlers (token-auth, no capability). Updated feature enable/disable relaunch paths to use resident flag. |
| `backend/electron/tile-preload.cts` | Added `api.window.showSelf()` and `api.window.hideSelf()`. |
| `backend/electron/tile-api.d.ts` | Added `showSelf()` and `hideSelf()` type declarations to `TileWindow`. |

## Tiles converted

| Tile | Before | After |
|------|--------|-------|
| `hello-world` | background.html (stub) + home.html | home.html only; `hello` command calls `showSelf()` |
| `widget-demo` | background.html + background.js + sheet.html/js | sheet.html + sheet.js; commands call `showSelf()` |
| `mcp-server` | background.html + background.js | background.html inline (background.js deleted) |

Deleted orphaned files: `hello-world/background.html`, `widget-demo/background.html`,
`widget-demo/background.js`, `mcp-server/background.js`.

## Auto-show audit (step 5)

No tiles were found that auto-showed at launch via `type: "window"`. All
`type: "window"` entries in existing manifests are secondary tiles opened
explicitly by commands via `tile:window:open` or declarative `action.type: "window"`.
They were never auto-launched at startup. The behavior change (all tiles start with
`show: false`) only affects tiles launched via `launchTile()`, and those were already
`show: false` for background tiles.

## Test results

- `yarn test:unit`: **565/565 pass, 0 fail** (run twice — before and after all changes)
- `yarn test:electron:bg`: **205 passed, 30 failed, 2 skipped** (237 total)

All failures are pre-existing and unrelated to tiles:
- IZUI escape: 3 (expected per brief)
- Tag command: 7 (expected per brief)
- Groups navigation/context/HUD: 3 (pre-existing)
- Lists extension: 5 (pre-existing)
- CSV command: 2 (files extension dependency, pre-existing)
- Websearch cmd panel: 4 (pre-existing)
- Websearch settings/URL: 3 (pre-existing)
- IZUI parentWindowId: 1 (pre-existing)
- Other: 2 (pre-existing)

Tile-specific tests (Hybrid Extension Mode, `v2 background tile windows exist`) all pass.

## Tiles not yet migrated

See `docs/tiles-single-file.md` "Tiles not yet migrated" table (25 tiles).
All continue to work unchanged via the `type: "background"` compat alias.
