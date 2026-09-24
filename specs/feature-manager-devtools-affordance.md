---
enabled: true
touches: [apps/desktop/main/feature-devtools-target.ts, apps/desktop/main/feature-devtools-target.test.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/feature-list-entries.ts, apps/desktop/main/feature-list-entries.test.ts, apps/desktop/features/features-manager/manage.js, apps/desktop/features/features-manager/manifest.json, apps/desktop/tests/desktop/features-manager-persistence.spec.ts]
depends-on: []
---

# Make the feature-manager DevTools affordance track the tile's real running state

Peek item `621e283f`. The DevTools button on every feature-manager card is enabled
unconditionally, and clicking it on a feature whose tile is not live answers
`No active tile found for <id>:background. The feature may not be loaded yet.` The item
also reports the same error after the feature had apparently been loaded, and reports the
failure as intermittent — so the enable/disable question cannot be settled without first
making "is this feature running" a single derived fact instead of two independent guesses.

## Where the two guesses live today

`apps/desktop/main/tile-ipc.ts`, handler `tile:features:devtools-open`: `entryId` defaults
to the literal `'background'`; the handler tries `getTileWindow(featureId, entryId)`
(`tile-launcher.ts`, a `tileId:entryId` singleton map), then scans every
`webContents.getAllWebContents()` entry for a URL — or a non-main frame URL — starting
`peek://<featureId>/`, then returns the "No active tile found" error. Three consequences:

- A feature with no `background` entry in its manifest (`websearch`, `compose`, `lists`,
  `groups`, `lex`, `hello-world`, …) can only ever be reached by the URL scan.
- The scan's second pass (`mainFrame.framesInSubtree`) `break`s out of the whole loop after
  the first webContents that matches a subframe, so a feature hosted in several subframes
  gets one of them.
- The card has no input at all: `manage.js` `createFeatureCard()` builds `openDevtoolsBtn`
  with no `disabled` assignment, so the affordance is enabled for a feature that is merely
  installed.

Meanwhile `apps/desktop/main/tile-lifecycle.ts` already owns the authoritative per-entry
state (`STATES` from `tile-fsm.ts`: `registered`/`loading`/`ready`/`visible`/`unloading`/
`crashed`), fed by `feature-startup.ts` `fireFsmTriggerForFeature()` (INSTALL per manifest
tile entry), `tile-launcher.ts` `createTileBrowserWindow()` (LOAD), `signalTileReady()`
(TILE_READY) and the window `closed` / `render-process-gone` handlers (SHUTDOWN /
CLEANUP_KEEP / RENDER_GONE) — and mirrors every transition onto the System pubsub topic
`tile:state-changed`. That is the deterministic signal this work must use. No `setTimeout`,
no retry loop, no polling gate.

## The change

**1. New Electron-free `apps/desktop/main/feature-devtools-target.ts`.** Imports only
`STATES` from `./tile-fsm.js` (pure, no Electron), so it compiles and runs under the
`electron --test dist/main/*.test.js` runner. Exports:

- `RUNNING_STATES` — `[STATES.READY, STATES.VISIBLE]`. A `loading` entry has a window but
  has not signalled ready; devtools on it is a race, so it does not count as running.
- `liveDevtoolsEntries(entryIds, probe)` where `probe(entryId)` answers
  `{ state: string; hasWindow: boolean }`. Returns
  `{ live: string[]; drift: string[] }`: `live` is every entry whose state is in
  `RUNNING_STATES` **and** which has a live window; `drift` is every entry whose state is in
  `RUNNING_STATES` with **no** window. Drift is reported, never silently folded into "not
  running" — the item asks for the state confusion to be identified rather than papered over.
- `pickDevtoolsEntries(requestedEntryId, live, drift, featureId)` returning
  `{ entries: string[] }` or `{ error: string }`:
  - a `requestedEntryId` that is in `live` → `{ entries: [requested] }`;
  - a `requestedEntryId` that is not live → an error naming the requested entry and the
    live ones;
  - no request and `live` contains `'background'` → `{ entries: ['background'] }`;
  - no request and `live` is non-empty → `{ entries: live }` (every live entry, matching the
    old scan's "open all matching contexts" behaviour);
  - `live` empty and `drift` non-empty → a distinct error naming the drifting entries and
    saying the lifecycle state claims ready while no window exists. This is the message that
    tells a future reader which of the item's two hypotheses was true;
  - both empty → the existing `No active tile found for <featureId>:<entry>. The feature may
    not be loaded yet.` wording, with the entries considered appended.

**2. `tile-ipc.ts` grows one private helper and uses it in two handlers.**
`featureEntryLiveness(featureId)` reads the manifest tile entry ids from
`manifestCache.get(featureId)?.manifest?.tiles` (the same cache the list handler already
joins on), probes each with `tileLifecycle.getState(featureId, entryId)` and
`getTileWindow(featureId, entryId)` (non-null and `!isDestroyed()`), and returns the
`liveDevtoolsEntries` result.

- `tile:features:devtools-open` calls it, then `pickDevtoolsEntries`, then
  `openDevTools({ mode: 'detach' })` on each picked entry's window, returning
  `{ success: true, message }` naming the entries opened. The existing URL/subframe scan
  stays as a fallback, reached only when there is no manifest-cache row for the feature or
  when `live` is empty — webview-hosted tile contexts (HUD widgets, page-canvas guests) are
  not in `tileWindows` and would otherwise lose their only route. The scan's second pass
  loses the outer `break` so every matching webContents is opened, matching the first pass.
- `tile:features:list` calls it per visible entry and hands a
  `Map<featureId, string[]>` of live entry ids to `enrichFeatureEntries`.

**3. `feature-list-entries.ts`:** `FeatureListEntry` gains
`liveEntries?: string[]` (per-session, IPC-only, never persisted to `registry.json` — same
rule as `loadError`, stated in the field comment). `enrichFeatureEntries(entries, rows,
loadErrors?, liveEntries?)` joins it exactly the way `loadErrors` is joined, including for
entries with no cache row. Absent argument → field absent, so every existing caller is
unaffected.

**4. `features-manager/manage.js`:** the DevTools button gets
`className = 'feature-devtools-btn'`, its `disabled` set from whether the feature has any
live entry, a `title` explaining why when disabled ("<name> isn't running"), and a first-line
guard in its click handler that returns early when not running (the same shape as the locked
builtin toggle, because a click on a `peek-button`'s padding still reaches the host
listener). Two module-level maps keep the state live without a re-render:
`liveEntriesByFeature` (seeded from each entry's `liveEntries` on every `loadFeatures()`)
and `devtoolsButtonsByFeature` (rebuilt in `render()`). A subscription to
`tile:state-changed` updates the set for `msg.tileId` — add `msg.entryId` when `msg.to` is
`ready` or `visible`, remove it otherwise — and toggles only that feature's button. The
feature-manager manifest adds `tile:state-changed` to `capabilities.pubsub.topics`; a
consumer tile must list every topic it subscribes to or delivery is silently dropped.

## What stays

- `tile-lifecycle.ts`, `tile-fsm.ts`, `tile-launcher.ts` and `tile-lazy.ts` are not edited.
  The FSM already models this; the work is to read it, not to extend it.
- `feature-load-errors.ts` and the `loadError` card display from `ea72d7e1` — untouched, and
  the red-card path stays independent of the new `liveEntries` field.
- `tile:features:dev-reload`'s own scan. It reloads rather than attaches and already degrades
  to a `success: true` "no active tiles" message; changing it is out of scope.
- The `devtoolsOpen(featureId, entryId?)` signature in `tile-preload.cts` and
  `tile-api.d.ts`, and the `features.devtools` capability gate.

## Tests to add or change

New `apps/desktop/main/feature-devtools-target.test.ts` (main-process unit runner), against
`liveDevtoolsEntries` + `pickDevtoolsEntries` with a stub probe:

- A feature whose only live entry is `home` (no `background` entry declared at all) resolves
  to `['home']` — the case the current handler's `'background'` default cannot express.
- `background` live alongside a live `home` resolves to `['background']`.
- An explicit `entryId` that is live resolves to exactly that entry; one that is not live
  errors and the message names the live entries.
- States `registered`, `loading`, `unloading` and `crashed` do not count as live.
- A `ready` entry with no window produces the drift error, not the "may not be loaded yet"
  error — asserted on the distinct message.
- Nothing live and nothing drifting produces the "No active tile found" error.

`apps/desktop/main/feature-list-entries.test.ts`: extend the `enrichFeatureEntries` describe
with a live-entries join — present for a feature with a cache row, present for a feature
without one, and absent when the argument is omitted (existing cases must stay green
unchanged).

`apps/desktop/tests/desktop/features-manager-persistence.spec.ts` — two tests, each with the
phrase `devtools affordance` in its title so one grep runs both. They use the existing
`openManager()` helper in that file, plus the main-process test hooks used by
`tests/desktop/windows-lazy-wake.spec.ts` (`__peek_test.publishCmdExecute('windows')` and
`__peek_test.waitForTileState('windows', 'ready', …)`). `windows` is the subject because that
spec already pins it as non-resident at boot.

- `devtools affordance is disabled for a lazy feature that has not been woken` — open the
  manager, wait for the `windows` card, assert its `.feature-devtools-btn` reports
  `disabled === true`.
- `devtools affordance enables after the tile wakes and resolves success on repeated clicks`
  — arm `waitForTileState`, publish `cmd:execute:windows`, await ready, then
  `waitForFunction` on the same button reporting `disabled === false` (this is the assertion
  that the `tile:state-changed` subscription works without a manager reload), then call
  `window.app.features.devtoolsOpen('windows')` from the manager page five times in the same
  test and assert `{ success: true }` every time — intermittency shows up as one of the five
  failing. Assert the IPC result, not a visible DevTools window: detached DevTools is not
  observable headless. Close what was opened in an `afterAll` via the app's main-process
  evaluate hook (`closeDevTools()` on every webContents reporting
  `isDevToolsOpened()`), so a run on a real display does not leak DevTools windows into the
  rest of the suite.

## Verify

The repo gate is the desktop unit runners plus the Playwright desktop project. Inner loop:

```
yarn workspace @peek/desktop test:grep "devtools affordance"
yarn workspace @peek/desktop test:unit
```

Then the full gate before declaring done:

```
yarn test:desktop:electron
```

Done when: both new Playwright tests pass and the rest of
`features-manager-persistence.spec.ts` is unchanged and green; the new
`feature-devtools-target` unit cases pass; `feature-list-entries`, `tile-lifecycle`,
`tile-lazy-wake-errors` and `windows-lazy-wake` are unchanged and green; and every runner
reports `fail 0`. Record the per-runner counts in the handoff's `**Result**` section.

## Working rules

Run one command per Bash call.
