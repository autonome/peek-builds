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

A **resident** tile is loaded at boot and stays live for the app session. Its
renderer process is always running. This is what `type: "background"` tiles were —
they just had the additional quirk of forced 0×0 dimensions, which is gone.

A **lazy** tile is loaded on first use. The lazy stub/replay system handles command
registration until the tile is ready.

Every tile — resident or lazy — starts **hidden**. If a tile should be visible on
launch, session restore logic shows it. That is outside the manifest.

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
    "resident": true
  }],
  "capabilities": { ... }
}
```

### Fields on `TileEntry`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `id` | string | — | required, unique within manifest |
| `url` | string | — | required, HTML file relative to tile dir |
| `resident` | boolean | false | load at startup; false = lazy |
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
    - id: home, url: home.html, width: 700, height: 500, resident: true

home.html  ← api.initialize(), register commands, showSelf() on invocation
```

The visible window IS the tile's renderer context. No second process. No
cross-process pubsub just to open a window. `showSelf()` reveals the already-loaded
window instantly — no startup cost on invocation.

---

## Lazy loading interaction

A `resident: true` tile is loaded at startup (hidden). `api.initialize()` runs
immediately; commands are registered before any user action. No lazy stub/replay
needed.

Lazy tiles (default) are loaded on first use via the load-on-dispatch hook in `main/tile-lazy.ts`. See "Lazy feature activation" in `docs/architecture.md` for the full mechanics.

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

## Tiles not yet migrated

These tiles have genuine reasons to keep their current structure. Conversion is
deferred — not blocked.

| Tile | Why deferred |
|------|-------------|
| `helpdocs` | Persistent overlay tracking `app:focus-changed`, manages separate overlay window |
| `timers` | `setInterval` tick loop must survive UI close |
| `feeds` | Background polling + `refresh feeds` command |
| `editor` | Multi-window orchestration, complex lazy event handling |
| `tags` | Complex background with pubsub + datastore interactions |
| `groups` | Context/mode management |
| `spaces` | Context/mode management |
| `peeks` | Complex multi-window |
| `scripts` | Executes user scripts — needs persistent context |
| `search` | Background indexing |
| `wonderwall` | OAuth + streaming |
| `sheets` | Multi-pane |
| `slides` | Multi-pane |
| `sync` | Background sync polling |
| `lists` | TBD |
| `dropzone` | File drop handling |
| `pagestream` | Streaming |
| `pagewidgets-sample` | Sample, low priority |
| `tag-actions` | Could be converted |
| `theme-*` | Theme-only, no window |
| `files` | Dialog-heavy |
| `features-manager` | Privileged management tile |
| `entities` | Reactive extraction |
| `windows` | Window management tile |
| `websearch` | Reactive |
| `lex` | Complex OAuth + AT Protocol flows |
