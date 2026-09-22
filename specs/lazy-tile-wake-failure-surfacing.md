---
enabled: true
touches: [apps/desktop/main/feature-load-errors.ts, apps/desktop/main/feature-startup.ts, apps/desktop/main/tile-lazy.ts, apps/desktop/main/feature-list-entries.ts, apps/desktop/main/tile-lazy-wake-errors.test.ts]
depends-on: []
---

# Surface lazy-tile wake failures on the feature-manager card

Peek item `45776e60`, the second half of `36b56190` (per-feature load-error surfacing). That
commit surfaces boot-time failures only: `apps/desktop/main/feature-startup.ts` keeps a
per-session `_loadErrors` map, `initializeFeatures()` fills it from
`collectLoadErrors(loadResults)`, `getFeatureLoadErrors()` exposes it, and the
`tile:features:list` handler in `tile-ipc.ts` passes it to `enrichFeatureEntries()` so each
entry carries `loadError`, which `features-manager/manage.js` renders (`textContent`) as a
`.feature-error` div. All of that stays.

A lazy tile (`tile-arm.ts` → `registerLazyTile`) only *registers* at boot and reports
`loaded: true`. Its background script is launched later by `tile-lazy.ts`
`ensureTileLoaded()`, called from `handleCommandDispatch` (the `catch` that calls
`reportDispatchFailure`), `handleLazyEventDispatch`, and `backfillWakeDeclaration`. Every one
of those catches only logs. A wake failure therefore never reaches the map and the card
stays green.

## The change

**Decision: the map moves into a new Electron-free module.** `tile-lazy.ts` must not import
`feature-startup.ts`: `feature-startup → tile-loader → tile-compat → tile-arm → tile-lazy`
already exists, so that import would close a cycle and pull `datastore`/`manifest-cache`/
`atproto-source` into every `tile-lazy` test.

1. New `apps/desktop/main/feature-load-errors.ts` (no Electron, no imports beyond types).
   One module-level `Map<string, string>` and four exports:
   `getFeatureLoadErrors(): Map<string, string>`, `setFeatureLoadError(id, message)`,
   `clearFeatureLoadError(id)`, `resetFeatureLoadErrors()`. Module comment: per-session,
   IPC-only, never written to `FeatureRegistryEntry`/`registry.json` (same reasoning as the
   `feature-list-entries.ts` header).

2. `feature-startup.ts`: delete the local `_loadErrors` and its `getFeatureLoadErrors`;
   `export { getFeatureLoadErrors } from './feature-load-errors.js'` so `tile-ipc.ts`'s
   existing import keeps working unchanged (do not edit `tile-ipc.ts`). In
   `initializeFeatures()`, replace the `_loadErrors.clear()` + loop with
   `resetFeatureLoadErrors()` followed by `setFeatureLoadError(id, error)` for each entry of
   `collectLoadErrors(loadResults)`.

3. `tile-lazy.ts` `ensureTileLoaded(tileId)`: wrap the two awaits. On success
   `clearFeatureLoadError(tileId)`. On failure `setFeatureLoadError(tileId, message)` where
   `message = err instanceof Error ? err.message : String(err)`, then rethrow so the existing
   callers' `catch` blocks (notification, `resultTopic` error, log) behave exactly as today.
   Instrumenting this one function covers both named dispatch sites and the backfill wake.
   The entry is sticky: only a later successful `ensureTileLoaded` for the same tile removes
   it. The already-loaded fast path also counts as success.

4. `unregisterLazyTile(tileId)` also calls `clearFeatureLoadError(tileId)` — a feature the
   user disables mid-session must not keep a red card it can never clear (re-enable re-arms
   and the next wake decides again). `__resetTileLazyStateForTest()` calls
   `resetFeatureLoadErrors()` so tests start clean.

5. `feature-list-entries.ts`: its header comment says the map lives in `feature-startup.ts`;
   reword it to name `feature-load-errors.ts`. No code change in that file.

Not touched: `tile-ipc.ts` (changed on main today by unrelated work), `features-manager/manage.js`
(the card already renders `loadError`; the manager refreshes on `loadFeatures()`, and live
refresh of an already-open manager is out of scope per the item).

## Tests to change

New `apps/desktop/main/tile-lazy-wake-errors.test.ts`, modelled on
`tile-lazy-timeout.test.ts` (same `beforeEach`: `__resetTileLazyStateForTest`,
`__clearPrePublishHooksForTest`, `installLoadOnDispatchHook`, `__setTileLazyLauncherForTest`;
same `makeCommandManifest` shape; same `flushMicrotasks` loop). No mock timers are needed:
a launcher whose `waitForTileReady` returns `Promise.reject(new Error('boom'))` makes
`loadLazyTile`'s `Promise.race` and therefore `ensureTileLoaded` reject immediately.

- Command wake fails → `getFeatureLoadErrors().get(tileId)` is the rejection message;
  then swap in a launcher with `isTileLoaded: () => true` and a resolving `waitForTileReady`,
  publish the same `cmd:execute:<name>` again, and the entry is gone.
- lazyEvent wake fails (manifest with `tiles[0].lazyEvents: ['wake:topic']`, publish that
  topic) → entry present; nothing else asserted.
- `unregisterLazyTile(tileId)` after a failed wake → entry gone.

Import `getFeatureLoadErrors` from `./feature-load-errors.js`. Before the change the file
does not compile (no wake-time writer exists); after it all three pass.

## Verify

The repo gate covers this fully:

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both tallies report `fail 0`, the three new tests pass, and the existing
`tile-lazy-timeout`, `tile-lazy-events`, `lazy-feature-rearm`, `tile-command-registration`
and `feature-list-entries` suites are unchanged and green.

## Working rules

Run one command per Bash call.
