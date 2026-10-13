---
enabled: true
touches: [apps/desktop/main/tile-launcher.ts, apps/desktop/main/tile-launcher.test.ts]
depends-on: []
---

# Closing one of two windows on one tile entry leaves the other registered and running

Peek item `621e283f` (its remaining half: "No active tile found" while the feature is running).
`apps/desktop/main/tile-launcher.ts` tracks tile windows per `${tileId}:${entryId}` key, but
more than one live window can share a key: every `api.window.open('peek://search/home.html?q=…')`
from `renderer/cmd/panel.js` builds a new window through `createTileBrowserWindow` (the
`window-open` handler in `ipc.ts`), each one executing `tileWindows.set(key, win)`.

## What the code does now

`tile-launcher.ts`:

- `tileWindows: Map<string, BrowserWindow>`, last write wins; `tileWindowsAll: Set<BrowserWindow>`
  holds every live window; `readyTiles: Set<string>` holds ready keys.
- Three per-window handlers clean up by key, unconditionally, with no check that the closing
  window is the one the key points at or that it is the last window for the key:
  - `createTileBrowserWindow`'s `win.on('closed')`: tileLifecycle SHUTDOWN then CLEANUP_KEEP (unless
    UNREGISTERED or CRASHED), `tileWindows.delete(key)`, `readyTiles.delete(key)`,
    `unsubscribeAll(\`peek://${tileId}/${entryId}\`)`, plus per-window `tileWindowsAll.delete(win)`,
    `revokeToken(token)`, `tileWindowInfo.delete(win.id)`.
  - `createTileBrowserWindow`'s `webContents.on('render-process-gone')`: the same, with
    `RENDER_GONE` instead of SHUTDOWN/CLEANUP_KEEP, then an optional `tile:crashed` publish.
  - `registerTrustedBuiltinWindow`'s `win.on('closed')`: the same deletes and `unsubscribeAll`, no
    lifecycle transitions.
- `shutdownTile` / `unloadTile` act only on the window `tileWindows.get(key)` returns, so other
  windows for the key are never signalled or closed; `relaunchTile`'s `existingWin` check goes
  through the same lookup.

Consequences when window A and later window B share a key and A closes first: `getTileWindow`
returns null and `isTileLoaded` returns false while B is alive; the entry's tileLifecycle record
(keyed per entry in `tile-lifecycle.ts`) drops to REGISTERED, so `feature-devtools-target.ts
pickDevtoolsEntries()` answers "No active tile found" and a lazy wake may launch a third window;
and `unsubscribeAll` removes B's subscriptions, because pubsub (`pubsub.ts`) keys subscriptions by
source address only and both windows share `peek://<tileId>/<entryId>`.

## What changes

`tile-launcher.ts`:

- Replace `tileWindows` with a per-key list of live windows in open order
  (`Map<string, BrowserWindow[]>`, or equivalent). `getTileWindow` returns the most recently
  opened live window for the key (today's "last write wins" answer); `isTileLoaded` is true while
  any live window remains for the key. `tileWindowsAll` stays as is.
- Extract the shared close cleanup into one exported function, e.g.
  `releaseTileWindow(tileId, entryId, win, reason: 'closed' | 'crashed' | 'builtin-closed')`,
  called from all three handlers. Per-window work always runs (`tileWindowsAll.delete(win)`, remove
  `win` from the key's list, `revokeToken(token)` stays in the handler since the token is
  per-window, `tileWindowInfo.delete(win.id)`). Per-entry work runs only when `win` was the last
  live window for the key: `readyTiles.delete(key)`, `unsubscribeAll(source)`, and the lifecycle
  transitions for that reason. It returns whether the entry's per-entry cleanup ran, so tests can
  assert it.
- A crash of one window while a sibling is live: per-window cleanup only, no `RENDER_GONE`
  transition, and the `tile:crashed` publish still fires (it reports that window's crash). Log the
  crash as today.
- `shutdownTile` signals and closes every live window for the key, not just the latest.
  `unloadTile` removes every window for the key from the registry. `relaunchTile`'s dedupe keeps
  using `getTileWindow`, which still answers whether anything is live.
- `__setTileWindowForTest` appends to the key's list; `__clearTileStateForTest` clears it.
  Update the block comment above the registry, which today describes the last-write-wins shape as
  harmless for keyed lookups.

Out of scope: pubsub keying (two windows still share one subscription slot per topic, the later
subscribe winning); `ipc.ts`'s `window-open` handler; the devtools affordance logic in
`feature-devtools-target.ts`.

## Tests to change

`apps/desktop/main/tile-launcher.test.ts`: add a `describe` block (e.g.
`'tile window registry: several windows on one entry'`) using `makeFakeWin()`,
`__setTileWindowForTest` and `__clearTileStateForTest` in `beforeEach`, calling
`releaseTileWindow` directly:

1. With windows A then B on one key, releasing A leaves `getTileWindow` returning B,
   `isTileLoaded` true, and reports that per-entry cleanup did not run.
2. Releasing B after A reports per-entry cleanup ran, and `isTileLoaded` is false.
3. With A then B, releasing B (the latest) makes `getTileWindow` return A.
4. With A then B, a `'crashed'` release of A leaves the entry's lifecycle state unchanged.
5. `shutdownTile` with two live windows on one key sends the shutdown signal to both and closes both
   through the configured close hook.

Existing cases in that file must still pass unchanged.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both tallies report `fail 0` and the five new cases pass. Also run
`yarn workspace @peek/desktop test:grep "devtools affordance"` and
`yarn workspace @peek/desktop test:grep "lazy"` and record each pass/fail count under
`**Result**` in the handoff; compare any failure against `apps/desktop/tests/gate-baseline.md`
before calling it a regression.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
