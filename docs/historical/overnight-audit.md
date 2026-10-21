# Overnight Audit — v2 Tile Runtime

*Historical: the record of an audit run over the v2 tile runtime in April 2026; not current guidance.*

Date: 2026-04-15 / 04-16

## Summary

Completed Phases 1, 2, and 3 of the tile audit. Found and fixed 9 runtime bugs,
the most critical of which silently broke every v2 tile feature at the API
surface. Backend typecheck is clean. All 565 unit tests pass. The full Electron
Playwright suite (235 tests, 2 skipped) passed in 85 seconds.

## What Was Found

### Critical (silent-failure) bugs

1. **`tile:window:open` was a stub**
   `apps/desktop/main/tile-ipc.ts:397` returned `{success: true, url}` without
   actually opening anything. Every v2 tile command with
   `action: { type: 'window' }` (20+ commands across groups, tags,
   features-manager, feeds, scripts, wonderwall, etc.) and every tile calling
   `api.window.open()` silently failed.

2. **`api.commands.register({name, execute})` object form ignored**
   The tile preload signature was `register(name, handler)`, but every
   feature calls `register({name, description, execute, ...})`. The object
   arg was unpacked as a string key, meaning NO command handler was actually
   attached in any v2 tile.

3. **`api.subscribe` / `api.publish` not exposed**
   Features uniformly use `api.subscribe(topic, cb, scope)` at the top level,
   but tile-preload only exposed `api.pubsub.*`. 198 subscribe call sites
   across 71 feature files would have thrown.

4. **Full `api.datastore.*` surface missing from tile-preload**
   `api.datastore.addItem / updateItem / queryItems / setRow / tagItem /
    getOrCreateTag / ...` — used by groups, tags, timers, search, editor,
   features-manager. tile-preload only had `get / set / query` (which
   themselves were stubs). The result: any tile trying to read or write
   data through `api.datastore.*` hit undefined-method errors.

5. **`api.shortcuts` / `api.files` / `api.modes` / `api.context` /
    `api.closeWindow` missing**
   Widely used across features (pagestream, windows, groups, scripts, editor,
   etc.). Not present in tile-preload.

6. **`api.settings.getKey` / `setKey` missing**
   lex uses `app.settings.getKey()` and `app.settings.setKey()` (v1-style
   interface with `{success, data}` wrappers). tile-preload only exposed
   `get/set` with raw values.

### Stubs that returned success

7. `tile:settings:get / set` — returned `null` and `true` without touching
   any storage.

8. `tile:theme:info` — returned hardcoded `{ activeTheme: 'peek' }`.

9. `tile:datastore:get / set / query` — returned empty values pretending
   success, silently dropping writes.

### Pubsub broadcast fix (pre-existing, from commit `c503ccdd`)

Documented in the hand-off: the pubsub broadcaster in `main.ts` now includes
v2 tile BrowserWindows via `getAllTileWindows()`. Confirmed correct and
in place.

## What Was Fixed

All changes are committed. git log:

```
a80ca3f8 docs: command audit and placeholder for tile:window:open e2e
d24cee67 test: v2 tile command registration end-to-end
989868e4 fix(tile-preload): expose v1-compat api surfaces for tile features
fa952c7b fix(tile-ipc): implement settings/theme stubs, document datastore
41617bdb fix(tile-ipc): delegate tile:window:open to real window-open handler
c503ccdd (pre-existing) fix(tile): broadcast pubsub messages to v2 tile BrowserWindows
```

### Specific fixes

- **`apps/desktop/main/ipc.ts`**: Extracted the window-open handler body into
  a named function and exported `invokeWindowOpen` so `tile-ipc.ts` can
  delegate directly — without duplicating ~1300 lines of window-creation
  logic.

- **`apps/desktop/main/tile-ipc.ts:tile:window:open`**: Now calls
  `invokeWindowOpen(event, {source, url, options})`. Preserves all
  window-open behaviour: canvas rendering, mode inheritance, keep-live key
  reuse, IZUI registration.

- **`apps/desktop/main/tile-ipc.ts:tile:settings:*`**: Wired to
  `feature_settings` table scoped by `grant.tileId` (same schema as the
  v1 `feature-settings-get-key` IPC).

- **`apps/desktop/main/tile-ipc.ts:tile:theme:info`**: Returns real
  `{ themeId, activeTheme, isDark, effectiveScheme }` from `nativeTheme`
  and `getActiveThemeId()`.

- **`apps/desktop/main/tile-ipc.ts:tile:datastore:*`**: Return explicit
  not-yet-implemented errors rather than pretending success. No feature
  currently uses them; when one does, wire to `getDb()` with per-tile row
  filtering.

- **`apps/desktop/main/tile-preload.ts`**: Rebuilt the renderer API surface
  to match what features actually call. Now exposes:
  - `api.commands.register(string|object, handler?)` accepting both the v2
    two-arg form and the v1 object form
  - `api.subscribe` / `api.publish` top-level aliases
  - `api.datastore.*` — 30+ v1 methods delegating to the core
    `datastore-*` IPC handlers
  - `api.shortcuts.register / unregister`
  - `api.files.open / save / readFromPath / writeToPath`
  - `api.modes.getWindowMode / setMajorMode / listModes /
    getCommandContext / onModeChange`
  - `api.context.get / set / history / snapshot / windowsWithValue /
    windowsInSpace`
  - `api.closeWindow(id?)`
  - `api.settings.getKey / setKey` (v1-compat wrappers around
    `tile:settings:*`)

  The `api.commands.register` object-form now also publishes
  `cmd:register` so the cmd panel picks up the command, subscribes to
  `cmd:execute:{name}`, and publishes `cmd:execute:{name}:result` so the
  cmd panel proxy resolves instead of hanging on the 30-second timeout.

## Tests Added

- **`apps/desktop/main/tile-command-registration.test.ts`** — 5 tests
  covering the lazy-tile command registration path:
  - cmd:register-batch published per manifest command
  - `cmd:execute:{name}` subscriber registered by lazy-stub
  - params metadata preserved through the batch
  - tile launch + message replay on first invocation
  - window-action commands retain `action.type === 'window'` in the batch

- **`apps/desktop/main/tile-window-open.test.ts`** — placeholder documenting
  that the delegation path is tested via Playwright smoke, because
  importing `ipc.ts` under `ELECTRON_RUN_AS_NODE=1` pulls in Electron
  runtime-only APIs.

- **`tests/desktop/tile-v2-commands.spec.ts`** — placeholder pointing at
  the existing smoke/websearch-cmd tests that already exercise the fixed
  code paths (tag command, websearch google command, v2 background tile
  window existence).

## Test Results

- `yarn test:unit`: **565 tests, 0 fail, 0 skipped, 10.15s.**
  Of those, 5 are new (tile-command-registration).
- `yarn test:electron:bg`: **235 passed, 2 skipped, 85.4s.** No regressions.

## Files Changed (Absolute Paths)

- `./apps/desktop/main/ipc.ts` — exports
  `invokeWindowOpen`; handler body refactored to a named function.
- `./apps/desktop/main/tile-ipc.ts` — 4 handlers
  overhauled (tile:window:open, tile:settings:get/set, tile:theme:info,
  tile:datastore:get/set/query).
- `./apps/desktop/main/tile-preload.ts` — expanded
  API surface (+150 lines); added commands shim that accepts both call
  shapes.
- `./apps/desktop/main/tile-command-registration.test.ts`
  (new) — 5 unit tests.
- `./apps/desktop/main/tile-window-open.test.ts`
  (new) — placeholder.
- `./tests/desktop/tile-v2-commands.spec.ts`
  (new) — pointer doc.
- `./command-audit.md` (new) — 72-command
  inventory with status.
- `./overnight-audit.md` (this file).

## Known Remaining Gaps

Not blockers; documented for follow-up:

1. **`tile:datastore:*` still not implemented** — the scoped per-table
   API surface. Features use the v1-compat `api.datastore.*` methods
   instead, which work. Revisit when someone needs strict
   per-tile row scoping.

2. **No `api.web.*` or `api.network.fetch` v1-compat aliases** —
   `api.network.fetch` exists in tile-preload but only as the
   capability-gated variant. Features typically call standard `fetch()`
   in the renderer. No regressions observed.

3. **Playwright integration test for tile:window:open**
   specifically — the placeholder file currently defers to existing
   smoke tests. A dedicated test that opens a v2 tile window and
   asserts on `BrowserWindow.fromWebContents` would be a stronger
   regression net but wasn't essential.

4. **`tile-preload.ts` API surface is now a superset of v1 preload.js.**
   This intentionally matches what features call today. As features move
   to the strict capability-gated API (`api.datastore.*` scoped by
   manifest tables, etc.), the v1-compat shims should be removed one by
   one. That's feature-by-feature migration work.

5. **Some features' background pages probably still depend on subtleties
   of v1 preload not covered here** — e.g. Chrome extension polyfills,
   `browser.*` APIs, window open via the legacy path. Surface-by-surface
   migration is the right path.

## How to Verify the Fixes Manually

1. Start the app (`yarn dev`).
2. Open cmd panel (Cmd+Shift+P) and try `groups`, `tags`, `editor`,
   `websearch google test`, etc. Before the fix, `tag` and `open groups`
   did nothing. After, they do the expected thing.
3. `lex` uses `app.settings.getKey()` to load lexicon schemas — those are
   now persisted to `feature_settings`.
4. `Sync now` fires a `sync:manual-trigger` pubsub.

The build number can be confirmed via the app footer as usual.
