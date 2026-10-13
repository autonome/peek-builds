# Single-File Tiles

## A tile is a feature. Full stop.

A tile is an HTML file that runs in a renderer process. It can register commands,
subscribe to events, hold state, show a UI, or stay completely hidden. Some tiles
never show anything. Some show themselves when a command fires. Some do all of it.

There is no "tile role" and no "tile type" in the conceptual model. **Every feature
is a tile.** If functionality lives outside the tile model it is core (`app/`), not a
feature. The old `type: "background"` / `type: "window"` distinction was never a
meaningful conceptual split — it was a launcher implementation detail leaking into
the manifest format.

---

## Two axes: residency and visibility

Tiles have two independent runtime properties:

| Axis | Values | Who decides |
|------|--------|-------------|
| **Residency** | resident (loaded at startup) vs lazy (loaded on demand) | manifest (`resident: true`) |
| **Visibility** | shown vs hidden | runtime (tile calls `showSelf()` / `hideSelf()`) |

Only residency belongs in the manifest. Visibility is a runtime choice.

`resident: true` is still a supported manifest value — a resident tile is loaded at
boot and stays live for the app session, its renderer process always running. This
is what `type: "background"` tiles were, minus the forced 0×0 dimensions. But no
shipped feature manifest sets it: `isLazyTileManifest` in `apps/desktop/main/tile-arm.ts`
treats the absence of a resident entry (plus commands or `lazyEvents`) as the signal
to arm the tile lazily via `armLazyTile`, and the whole built-in fleet is lazy in
practice. `resident: true` survives only in tests and fixtures.

A **lazy** tile is loaded on first use. The lazy stub/replay system handles command
registration until the tile is ready.

Neither axis is how a tile stays warm after its window closes — that's `keepLive`.
A tile entry with `keepLive: true` is hidden rather than destroyed on close
(`_registerWindow` in `apps/desktop/main/tile-launcher.ts` reads the flag), so the
renderer and its in-memory state survive and `showSelf()` reveals the same window
again instead of reloading it. Residency controls when a tile's renderer starts;
`keepLive` controls what closing its window does to that renderer — independent
axes, same as residency and visibility.

Every tile — resident or lazy — starts **hidden**. A tile becomes visible by calling
`showSelf()` itself (from a command, a lazy wake, or session-restore logic), or, for
a feature with no background tile at all, by a manifest command's declarative
`action: { type: "window" }`, which the launcher opens directly.

---

## Manifest shape (target)

```json
{
  "manifestVersion": 3,
  "id": "my-tile",
  "name": "My Tile",
  "tiles": [{
    "id": "home",
    "url": "home.html",
    "width": 700,
    "height": 500,
    "keepLive": true
  }],
  "capabilities": { ... }
}
```

### Fields on `TileEntry`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `id` | string | — | required, unique within manifest |
| `url` | string | — | required, HTML file relative to tile dir |
| `resident` | boolean | false | load at startup; false = lazy. Supported, but no shipped feature manifest sets it — see "Two axes" above |
| `keepLive` | boolean | false | hide instead of destroy on close; renderer and state survive, `showSelf()` reveals the same window again |
| `width` | number | 800 | window width |
| `height` | number | 600 | window height |
| `minWidth` | number | — | |
| `minHeight` | number | — | |
| `alwaysOnTop` | boolean | false | |
| `transparent` | boolean | false | |
| `focusable` | boolean | true | |
| `frame` | boolean | true | |
| `resizable` | boolean | true | |
| `role` | string | — | IZUI role |
| `key` | string | — | dedup key |
| `title` | string | manifest.name | window title |
| `lazy` | boolean | false | explicit lazy flag (legacy compat) |
| `lazyEvents` | string[] | — | topics that trigger lazy load |

**No `type` field.** The old `type: "window" | "background" | "panel"` was
removed in `manifestVersion: 3`. Use `resident: true` to mark a tile that
must be loaded at startup; omit it (or set `lazy: true`) for lazy-loaded
tiles. `type: "window"` and `type: "panel"` were no-ops — drop them.

**No `windowHints` nested object.** Window properties are flat on `TileEntry`.
This removes one level of indirection for the common case. The validator
rejects `windowHints` outright in `manifestVersion: 3`.

---

## Migration from manifestVersion 2 → 3

The v1-removal milestone bumped `manifestVersion` from 2 to 3 and dropped
the legacy `type` / `windowHints` compat fields in lockstep. To migrate a
v2 manifest:

1. Bump `manifestVersion` to `3`.
2. Replace `type: "background"` with `resident: true` (drop `type` either
   way — `type: "window"`/`"panel"` were no-ops).
3. Hoist every `windowHints` inner field up to the tile entry directly,
   then delete the `windowHints` object.

`manifestVersion: 2` is now treated as a legacy/v1 manifest by the
detector — there is no compat layer. Re-installing a v2 feature without
migration will fail validation.

---

## `api.window.showSelf()` / `api.window.hideSelf()`

Any tile can show or hide its own BrowserWindow by calling these methods. **No
capability required.** The tile's token is the authority — it can only affect the
window it runs in.

```js
const api = window.app;
await api.initialize();

api.commands.register({
  name: 'my tile',
  execute: () => api.window.showSelf()
});

api.onShutdown(() => { /* cleanup */ });
```

IPC channels: `tile:window:show-self` / `tile:window:hide-self`.

These differ from `api.window.show(id)` / `api.window.hide(id)` which affect
arbitrary windows and require `window.manage` capability. `showSelf`/`hideSelf`
are token-scoped and require no capability grant.

---

## The single-file authoring model

### Before (two files, two renderer processes)

```
manifest.json
  tiles:
    - id: background, type: background, url: background.html
    - id: home,       type: window,     url: home.html

background.html  ← boilerplate: await api.initialize(); import background.js
background.js    ← registers commands that open home.html
home.html        ← the actual UI (opened by commands)
```

### After (one file, one renderer process)

```
manifest.json
  tiles:
    - id: home, url: home.html, width: 700, height: 500

home.html  ← api.initialize(), register commands, showSelf() on invocation
```

The visible window IS the tile's renderer context. No second process. No
cross-process pubsub just to open a window. `showSelf()` reveals the already-loaded
window instantly — no startup cost on invocation.

---

## Lazy loading interaction

Every built-in tile is lazy in practice: loaded on first use via the load-on-dispatch
hook in `main/tile-lazy.ts`, armed at boot by `armLazyTile` (`main/tile-arm.ts`). See
"Lazy feature activation" in `docs/architecture.md` for the full mechanics.

A `resident: true` tile is loaded at startup (hidden) instead — `api.initialize()`
runs immediately, commands are registered before any user action, no lazy
stub/replay needed — but the path is unused: no shipped feature manifest sets
`resident: true`, and `isLazyTileManifest` (`main/tile-arm.ts`) arms anything without
a resident entry lazily by default.

---

## Runtime changes

### `tile-manifest.ts`

- `TileEntry` carries `resident?: boolean` and flat window fields
  (`width`, `height`, etc.). The legacy `type?: 'window' | 'background' |
  'panel'` field and the `windowHints?: TileWindowHints` nested object
  were removed in `manifestVersion: 3`.
- `validateTileManifest` rejects both `tile.type` and `tile.windowHints`
  outright — there is no normalization layer.
- `detectManifestVersion` recognises `manifestVersion: 3` as v2 (the
  current schema); `manifestVersion: 2` is now classified as v1 (legacy).

### `tile-launcher.ts`

- Window options come from the entry's flat fields; `TileWindowOverrides`
  exposes the same subset to `windowOverrides`.
- `show: false` is the default for all tiles.

### `tile-compat.ts`

- Residency decision: `t.resident === true` (no `type` fallback).
- Eager launch reads the resident entry directly.

### `tile-ipc.ts`

- Added `tile:window:show-self` handler. Validates token; shows the tile's own
  window. No capability check.
- Added `tile:window:hide-self` handler. Validates token; hides the tile's own
  window. No capability check.

### `tile-preload.cts`

- Added `api.window.showSelf()` and `api.window.hideSelf()`.

### `tile-api.d.ts`

- Added type declarations for `showSelf()` and `hideSelf()` on `TileWindow`.

---

## Tiles converted (proof-of-concept)

| Tile | Before | After | Notes |
|------|--------|-------|-------|
| `hello-world` | background.html (stub) + home.html | home.html only | home.html does init; `hello` command calls `showSelf()` |
| `widget-demo` | background.html + background.js + sheet.html | sheet.html + sheet.js | sheet.html inlines init; commands call `showSelf()` |
| `mcp-server` | background.html + background.js | background.html (inline) | No UI; background.js inlined into background.html |

---

## Other tiles already meeting the model

No separate background tile, and no `background.*` files on disk.

| Tile | Shape | Notes |
|------|-------|-------|
| `groups` | `home.html` only | |
| `websearch` | `home.html` only, lazy (`lazyEvents: ["page:search-engine-discovered"]`) | |
| `lists` | `home.html` only, `keepLive: true` | stays warm across close instead of reloading |
| `lex` | `home.html` + `chain-form.html` (panel) | two UI tiles, neither is a background tile |
| `dropzone` | `tiles: []` | window opens via the `dropzone` command's declarative `action: { type: "window" }` |
| `sync` | `tiles: []` | `sync:manual-trigger` is handled in core, `apps/desktop/main/ipc.ts`, not by a feature tile |

---

## Single-tile headless features (background.html stub, no UI page)

Already one renderer process — no separate UI tile to fold in — but the renderer is
still `background.html` importing `background.js` rather than the inlined
`mcp-server` shape (`background.html` with its script inline).

| Tile | Notes |
|------|-------|
| `peeks` | wakes on `cli:peek-open` / `peeks:settings-changed` |
| `slides` | wakes on `cli:slide-open` / `slides:settings-changed` |
| `files` | file/format commands (CSV, save, open) |
| `pagewidgets-sample` | page-widget registration API demo |
| `debug` | wakes on the `peek debug` / `peek devtools` commands |
| `todo` | wakes on `cmd:execute:todo`, `cmd:execute:todos`, `cmd:execute:done` and `cmd:execute:complete` |

---

## Tiles not yet migrated

These tiles have genuine reasons to keep their current structure: a background tile
plus one or more UI tiles. Conversion is deferred — not blocked.

| Tile | Why deferred |
|------|-------------|
| `timers` | `setInterval` tick loop must survive UI close |
| `feeds` | Background polling + `refresh feeds` command |
| `editor` | Multi-window orchestration, complex lazy event handling |
| `tags` | Complex background with pubsub + datastore interactions |
| `spaces` | Context/mode management, plus a transparent always-on-top border tile |
| `scripts` | Executes user scripts — needs persistent context |
| `search` | Background indexing |
| `wonderwall` | OAuth + streaming |
| `sheets` | Multi-pane |
| `pagestream` | Streaming |
| `tag-actions` | Could be converted |
| `features-manager` | Privileged management tile, three UI tiles (manage/browse/publish) |
| `entities` | Reactive extraction |
| `windows` | Window management tile |
| `composer` | Background wakes on `composer:open`, opens a separate compose window |
| `example` | Sample background + gallery window pattern |
| `pubsub-repro` | Deliberately separate background + window tiles — that's what it reproduces |

`theme-basic`, `theme-peek`, and `theme-shichijuni` are pure theme manifests (no
`tiles` key, no `manifestVersion`) — not tiles, so they don't belong in a migration
table at all.
