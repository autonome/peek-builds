# Building a Peek feature

A **feature** is a directory under `apps/desktop/features/` holding a `manifest.json` and the
HTML/JS/CSS it declares. The manifest names one or more **tiles**; each tile is a page Peek
loads in its own sandboxed `BrowserWindow`, with `apps/desktop/main/tile-preload.cts` as its
preload. That preload is the only way in: it exposes `window.app`, and what `window.app` will
actually do for a given tile is decided by the capabilities that tile's manifest declared.

There are about three dozen features in the tree. Every UI surface in Peek is a tile — the
command panel, settings, browser pages — so building a feature is the same job as building
anything else here.

Related reading: `docs/architecture.md` for the whole system, `docs/tile-api.md` for the full
`window.app` reference, `docs/tiles-single-file.md` for the tile model.

---

## Start by copying `hello-world`

`apps/desktop/features/hello-world/` is the smallest self-contained feature: three files, no
imports outside its own directory, enabled by default. Copy the directory, rename it, and
change the `id`.

```
apps/desktop/features/hello-world/
  manifest.json   35 lines — what the feature is and what it may do
  home.html      261 lines — the tile page: markup plus one module script
  home.css       209 lines — local styling, on the theme variables
```

**`manifest.json`** — the whole file:

```json
{
  "manifestVersion": 3,
  "id": "hello-world",
  "shortname": "hello-world",
  "name": "Hello World",
  "description": "Tutorial and diagnostic tile for tile authors",
  "version": "1.0.0",
  "builtin": true,
  "tiles": [
    { "id": "home", "url": "home.html", "width": 700, "height": 900, "title": "Hello World" }
  ],
  "capabilities": {
    "pubsub": {
      "scopes": ["global", "system"],
      "topics": ["hello:ping", "item:created", "item:deleted"]
    },
    "datastore": { "tables": ["items"] },
    "commands": true
  },
  "commands": [
    {
      "name": "hello world",
      "description": "Open Hello World tile (tutorial + debug)",
      "action": { "type": "execute" }
    }
  ]
}
```

One tile, `home`, served at `peek://hello-world/home.html`. It may publish and subscribe on
three topics, read the `items` table, and register commands. It declares one command, so Peek
arms the tile lazily and boots it the first time someone runs `hello world` from the command
panel.

**`home.html`** carries a CSP in its `<head>` and one `<script type="module">` at the bottom:

```html
<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline';">
```

```js
const api = window.app;
await api.initialize();

api.commands.register({
  name: 'hello world',
  description: 'Open Hello World tile',
  execute: async () => {
    await api.window.showSelf();
    return { output: 'Hello World shown', mimeType: 'text/plain' };
  }
});

api.pubsub.subscribe('item:created', (msg) => { /* … */ });
api.pubsub.publish('hello:ping', { ts: Date.now() });
await api.datastore.queryItems({});
```

That is the shape of every tile page: grab `window.app`, `await api.initialize()`, register what
you handle, then do work. The real file wraps each of those calls in a logged `try`/`catch` and
prints the result into a Debug Info tab — it doubles as a live probe of the tile API, so when
something in `window.app` looks broken, open `hello world` and read its trace rather than
guessing. Replace that diagnostic scaffolding with your own logic; keep the first four lines.

**`home.css`** starts with `@import url('peek://theme/variables.css');` and styles everything
through `var(--base00…--base0F)` and `var(--theme-font-*)`, so the tile follows the active
theme. Do that rather than hard-coding colours.

### The ordinary shape: a background tile with commands

`hello-world` has no background tile and no settings. `apps/desktop/features/todo/` is the
smallest feature with the layout most features actually use — read its `README.md` first, it
documents its own files:

```
apps/desktop/features/todo/
  manifest.json      four commands, and every topic the tile subscribes to
  background.html    the tile page: imports background.js and calls api.initialize()
  background.js      the command handlers
  todo-items.js      the pure decisions, unit-tested at tests/unit/todo-items.test.js
  config.js          id and labels
```

`background.html` is boilerplate, and worth copying verbatim:

```html
<script type="module">
  import extension from './background.js';
  const api = window.app;
  await api.initialize();
  if (extension.init) await extension.init();
  api.onShutdown(() => { if (extension.uninit) extension.uninit(); });
</script>
```

`background.js` exports `{ id, init, uninit, … }` and `init()` subscribes one handler per
declared command:

```js
api.pubsub.subscribe('cmd:execute:todo', async (msg) => {
  const result = await handleTodo(msg.search?.trim() || msg.data?.text || '');
  if (msg.expectResult && msg.resultTopic) {
    api.pubsub.publish(msg.resultTopic, result || { success: true });
  }
});
```

Two things to copy from that: a command declared in the manifest arrives as a publish on
`cmd:execute:<name>`, and you answer by publishing to `msg.resultTopic` when the caller asked
for a result. `todo` registers nothing at runtime — its manifest declares all four commands —
and it keeps its decisions in a separate module with no `window.app` in it, which is what makes
them unit-testable.

---

## The manifest

The schema lives in `packages/capabilities/index.js`, which `apps/desktop/main/tile-manifest.ts`
re-exports wholesale. Three functions matter:

- `detectManifestVersion(json)` — returns `'tile'` or `'legacy'`.
- `validateTileManifest(json)` — returns a list of `{ path, message }`; empty means valid.
- `parseManifestFile(path)` in `tile-manifest.ts` — the only filesystem entry point. A missing
  file returns null silently; a JSON syntax error or a validation failure is logged and returns
  null.

**Schema v3 is `"manifestVersion": 3`.** A manifest is treated as a tile manifest if
`manifestVersion` is `3`, or — with the field absent or some other number — if `tiles` is an
array and `capabilities` is an object. `manifestVersion: 2` is legacy, and every loader refuses
it: `tile-loader.ts` reports "has a legacy manifest (manifestVersion < 3)",
`feature-installer.ts` rejects local installs, `manifest-cache.ts` refuses to cache it. Set the
field to `3` and move on.

Two keys are rejected outright as removed in v3: `tiles[].type` (use `resident: true`) and
`tiles[].windowHints` (put the window fields directly on the tile entry).

### Top-level fields

Validated — a failure here means the feature does not load:

| Field | Required | Shape | Notes |
|---|---|---|---|
| `id` | yes | non-empty string | The URL host and the feature's identity. `manifest-cache.ts` requires it to equal the directory-derived feature id. |
| `name` | yes | non-empty string | Display name; the window-title fallback. |
| `tiles` | yes | array, at most 10 | See below. |
| `capabilities` | yes | object | May be empty, but the key must be present. |
| `commands` | no | array | Each entry needs `name` and an `action` object. |
| `shortcuts` | no | array | Each needs `keys` plus exactly one of `command` or `wakeTopic`. |
| `rules` | no | array | `{ topic, scriptId }` plus optional `match`, `config`, `display`, `enabled`, `ordering`; reconciled into the `rules` table by `feature-startup.ts syncManifestRules`. |

Read by the code but not validated: `manifestVersion`, `version` (defaults to `0.0.0`),
`description`, `shortname`, `builtin`, `settingsSchema`, `defaults`, `nouns`,
`wakeShortcutsFromSettings`.

`"builtin": true` is load-bearing, not decoration: `resolveCapabilities` in
`packages/capabilities/index.js` denies `filesystem` and `sync` to anything that is not builtin,
and strips the `system` pubsub scope from it.

There is no top-level `pubsub` key (it is `capabilities.pubsub`), no `entries` key (tile entries
live in `tiles[]`), and no `enabled`/`disabled` key — see "Enabling and disabling" below.

### `tiles[]`

Validated: `id` (required, unique within the manifest) and `url` (required), plus `lazyEvents`
if present (array of non-empty strings). The rest is typed in
`packages/capabilities/index.d.ts` as `TileEntry` and read by
`apps/desktop/main/tile-launcher.ts createTileBrowserWindow`:

| Key | Effect |
|---|---|
| `resident: true` | Launch this tile eagerly at startup. |
| `lazy: true` | Marks which entry a wake should launch. Does **not** by itself make the feature lazy. |
| `lazyEvents: [...]` | Topics that wake this tile. |
| `keepLive: true` | Hide rather than destroy the window when it is dismissed. |
| `width`, `height` | Defaults 800 × 600. |
| `minWidth`, `minHeight` | Minimum size. |
| `frame: true` | Opt into OS chrome; tiles are frameless by default. |
| `transparent`, `alwaysOnTop` | `alwaysOnTop` is ignored in headless runs. |
| `focusable`, `resizable` | Default true; set `false` to opt out. |
| `title` | Falls back to `name`. |
| `role` | Defaults to `'workspace'`; `'overlay'` for full-screen overlays. |
| `key` | Collapses repeat opens onto one window. |

### `capabilities`

Anything a tile can do beyond rendering itself is gated. `resolveCapabilities(tileId, requested,
isBuiltin)` turns the declared block into a grant, and each namespace is enforced in main by its
own module. Unknown keys are ignored rather than rejected, so a typo fails silently — check
against this list:

| Key | Declared as | Enforced in |
|---|---|---|
| `pubsub` | `{ scopes: ('self'\|'global'\|'system')[], topics?: string[] }` | `tile-ipc.ts`, `tile:pubsub:publish` |
| `datastore` | `{ tables: string[], createTables?: boolean }` (max 20 tables) | `tile-datastore-scope.ts` |
| `network` | `{ domains: string[] }` (max 50) | `tile-network-enforcement.ts` |
| `window` | `true` or `{ create?, query?, manage?, urls? }` | `tile-window-enforcement.ts` |
| `commands` | `true` | `tile-ipc.ts` |
| `shortcuts` | `true` or `{ keys?: string[] }` | `tile-shortcuts-enforcement.ts` |
| `settings` | `true` or `{ readForeign?: string[] }` | `tile-ipc.ts`, `tile-settings-foreign-enforcement.ts` |
| `context` | `true` or `{ read?, write?, modes?, queryWindows? }` | `tile-context-enforcement.ts` |
| `dialogs` | `true` or `{ types?: ('save'\|'open')[] }` | `tile-dialogs-enforcement.ts` |
| `features` | `true` or `{ read?, install?, manage?, update?, dev?, publish?, devtools?, browse?, sources? }` | `tile-features-enforcement.ts` |
| `oauth` | `true` or `{ providers?: string[] }` | `tile-oauth-enforcement.ts` |
| `session` | `true` | `tile-session-enforcement.ts` |
| `izui` | `true` | `tile-izui-enforcement.ts` |
| `theme` | `true` | `tile-ipc.ts` |
| `rules` | `true` | `tile-ipc-gate.ts` |
| `filesystem` | `{ read?, write? }` — builtin only | `tile-ipc.ts` |
| `sync` | `true` — builtin only | `tile-sync-enforcement.ts` |

`api.escape` is deliberately ungated.

### `capabilities.pubsub.topics`

**List every topic the tile subscribes to, not only the ones it publishes.** A consumer that
forgets is the classic silent failure here, and it is caught at test time rather than at
runtime: `apps/desktop/main/manifest-subscribe-drift.test.ts` walks every `.js` file under
`apps/desktop/features/`, extracts literal `subscribe('…')` topics and `liveQuery({ topics: […] })`
arrays, and fails if one is not covered by that feature's `capabilities.pubsub.topics`. It runs
in the main-process unit runner, so an undeclared subscribe breaks the gate. Note it reads `.js`
files only — a topic subscribed from an inline `<script>` in an `.html` file is not audited, so
check those by hand.

Publishes are enforced at runtime instead: `tile-ipc.ts`'s `tile:pubsub:publish` handler drops
a publish whose topic matches no pattern and records a violation. Patterns support an exact
match, a `prefix:*` suffix wildcard, and a leading `*`. Omitting `topics` entirely disables
filtering. The command infrastructure topics (`cmd:register`, `cmd:register-batch`,
`cmd:unregister`, `cmd:execute:*`, `noun:*`) are exempt for any tile holding the `commands`
capability.

### `commands[]` and `shortcuts[]`

A command needs `name` and `action`; optionally `description`, `scope` (`'global'`, `'window'`,
`'page'`), `modes[]`, `accepts[]`, `produces[]`, and `params[]` of
`{ name, type, required?, description?, tag? }`. `action.type` is `'execute'` (publish
`cmd:execute:<name>` and let the tile answer), `'window'` (open a URL — no tile code needed, see
`apps/desktop/features/dropzone/manifest.json`), or `'publish'` (fire a topic).

A shortcut is `{ keys, command }` or `{ keys, wakeTopic, wakeArgs }`, optionally `global`.
`apps/desktop/main/feature-shortcut-registrar.ts registerWakeShortcuts` registers these OS
accelerators at startup with no renderer running, so a hotkey can wake a sleeping tile. Manifest
shortcuts are **fresh-profile defaults only** — once a tile has declared its own set via
`api.shortcuts.declareWakeShortcuts(list)`, the persisted rows win.

---

## How a tile loads

1. `apps/desktop/main/tile-loader.ts` reads the manifest (cache first, disk parse as fallback).
2. `tile-compat.ts loadTile()` hands off to `tile-arm.ts loadOrArmFeatureTile()`, which calls
   `registerTilePath(id, path)` so `peek://<id>/…` resolves.
3. That function then picks one of three paths — see the next section.
4. `tile-launcher.ts launchTile()` resolves the entry, calls
   `resolveCapabilities(…)` for the grant, mints a one-time token with `tile-tokens.ts
   generateToken(…)`, creates the window via `createTileBrowserWindow(spec)`, and loads
   `peek://<manifest.id>/<entry.url>`.
5. The window is a `BrowserWindow` of its own — `sandbox: true`, `contextIsolation: true`,
   `nodeIntegration: false` — created hidden, with the tile id, entry id and token passed in as
   `additionalArguments`. Every tile has its own web contents; nothing is hosted in a shared
   window or an iframe.
6. `tile-preload.cts` reads those arguments, calls `tile:validate-token`, and gets the grant
   back. That grant is what `window.app` gates itself on. The preload never reads the manifest.
7. The page calls `api.initialize()`, which signals `tile:lifecycle:ready`, and
   `tile-launcher.ts signalTileReady()` marks the tile live.

`docs/tile-lifecycle-fsm.md` documents the state machine (`unregistered → registered → loading →
ready → visible → unloading`, plus `crashed`); its state and transition tables match
`apps/desktop/main/tile-fsm.ts`, though its own status line and phase plan predate the
implementation.

Tile URLs are `peek://<tile-id>/<path>`, handled by `apps/desktop/main/protocol.ts`, which also
applies the per-origin CSP. The shared protocol hosts are `peek://app/` (core renderer, including
`peek://app/components/`), `peek://theme/`, `peek://node_modules/` and a few others.

### Resident, lazy, or on demand

`apps/desktop/main/tile-arm.ts isLazyTileManifest(manifest)` decides, and the rule is not the one
you would guess from the tile flags:

- **Resident** — some entry has `resident: true`. Launched eagerly at startup.
- **Lazy** — no entry is resident, *and* the manifest has commands or some entry has
  `lazyEvents`. Armed, not launched.
- **On demand** — neither. Only the path is registered; the tile opens when something navigates
  to its URL.

So a feature becomes lazy by *declaring commands*, not by setting a flag. `lazy: true` on an
entry only picks which entry a wake launches (`tile-lazy.ts` uses
`tiles.find(t => t.lazy === true) ?? tiles[0]`). Nothing shipped under `apps/desktop/features/`
currently sets `resident: true`; lazy is the norm, and it cut fixed boot from six windows to two.

**Waking.** `tile-lazy.ts installLoadOnDispatchHook()` installs one pre-publish hook that
intercepts `cmd:execute:<name>` for any command in the tile's manifest, and any topic in an
entry's `lazyEvents[]`. On a match it calls `ensureTileLoaded` → `waitForTileReady`, then
delivers the held publish to the now-live handler. A manifest shortcut publishes its wake topic
through the same hook, which is how a hotkey starts a tile that was not running.

**The init-ordering rule.** Register every wake handler — `api.commands.register`, and
`api.pubsub.subscribe` for each `lazyEvents` topic — synchronously, before your async setup.
`api.initialize()` sends `tile:lifecycle:ready` on a `setTimeout(…, 0)` macrotask, and the
deferred publish that woke the tile is delivered as soon as that fires. A handler registered
after a later `await` can miss it — and the publish it misses is the one the user is waiting on.
Register first, then guard the handler *bodies* on a promise that resolves once setup is done:

```js
const api = window.app;
let resolveInitReady;
const initReady = new Promise((r) => { resolveInitReady = r; });

await api.initialize();
api.pubsub.subscribe('page:search-engine-discovered', handleDiscovered);  // sync, before any await
initCommands();                                                          // sync
currentSettings = await loadSettings();                                  // awaits come after
resolveInitReady();

async function handleDiscovered(msg) {
  await initReady;   // the body waits; the registration did not
  // …
}
```

`apps/desktop/features/websearch/home.js` is the reference implementation.
`apps/desktop/features/slides/background.js` shows the same fix applied to a settings read: its
handler was registered in time but read bundled defaults because the wake arrived before
`loadSettings()` resolved.

### Enabling and disabling

Nothing in the manifest says "enabled". `apps/desktop/main/feature-installer.ts
syncBuiltinFeatures()` scans `apps/desktop/features/*/manifest.json` at every startup, skips
invalid or non-tile manifests, and registers anything new with `userApproved: true` and no
disabled flag — so a feature you add to the tree is on by default. Disabling is user state:
`disabled` on a `FeatureRegistryEntry` in `apps/desktop/main/feature-registry.ts`, persisted to
`registry.json`, mirrored to `manifest_cache.disabledAt`, and honoured by `tile-loader.ts`. The
toggle is the Features Manager UI (`apps/desktop/features/features-manager/`).

---

## The `window.app` API

`buildAPI()` in `apps/desktop/main/tile-preload.cts` builds the object and
`contextBridge.exposeInMainWorld('app', api)` exposes it. It is frozen by the context bridge —
you cannot monkey-patch it from the page. `apps/desktop/main/tile-api.d.ts` is the typed
contract; `docs/tile-api.md` is the full reference, organised by capability. **Read
`docs/tile-api.md` rather than the list below** — this is only the part a first feature needs.

Always available: `api.version`, `api.getTileId()`, `api.getTileEntry()`, `api.platform`,
`api.initialize()`, `api.onShutdown()`, `api.onVisible()`, `api.log()`, `api.escape`.

Ranked by how much the shipped features actually use them:

| Namespace | For | Most-used calls |
|---|---|---|
| `pubsub` | All messaging. The default pattern here. | `publish(topic, data)`, `subscribe(topic, fn)` → unsubscribe |
| `datastore` | Items, tags, events, tables. | `addItem(type, opts)`, `queryItems(filter)`, `getOrCreateTag(name)`, `tagItem(itemId, tagId)`, `getItemsByTag(…)` |
| `window` | Open, close, show, position, list. | `open(url, options)`, `close()`, `showSelf()`, `list()` |
| `settings` | This feature's settings. | `get(key)`, `set(key, value)` |
| `features` | List and manage installed features. | |
| `context` | Per-window key/value context. | |
| `commands` | Register palette commands at runtime. | `register({ name, description, execute })`, `unregister(name)` |
| `session` | Session state. | |
| `shortcuts` | Keyboard shortcuts. | `register(keys, fn)`, `declareWakeShortcuts(list)` |
| `escape` | ESC handling. | |

Also present, each gated by its capability: `theme`, `rules`, `dialogs`, `izui`, `filesystem`,
`files`, `network`, `oauth`, `atproto`, `sync`, `profiles`, `modes`, `adblocker`, `permissions`,
`darkMode`, `screen`, `chromeExtensions`, `backup`, `shell`, `app`, `nav`, `debugFlags`, `mcp`,
and `api.invoke(channel, data)` as a raw IPC escape hatch.

Most datastore and settings calls resolve to `{ success, data?, error? }` — check `success`
rather than assuming the value. Use `api.pubsub.publish` / `api.pubsub.subscribe`, not the
top-level aliases. Two caveats when reading the reference: the `datastore` section of
`docs/tile-api.md` describes `addItem`/`tagItem` as removed stubs, but they are live and in use
by shipped features; `tile-api.d.ts` types `publish`/`subscribe` as throwing shims, and they do
not throw. Where prose and code disagree, `tile-preload.cts` wins. `api.closeWindow` genuinely
does throw — use `api.window.close()`.

---

## UI: use the `<peek-*>` components

Tile UI ships on the shared Lit component library in `apps/desktop/renderer/components/` — 26
custom elements, documented in that directory's `README.md`. Do not hand-roll button, card,
input or modal CSS: the `--peek-*` geometry tokens in `apps/desktop/renderer/components/tokens.css`
are `:host`-scoped, so a plain tile document cannot read them at `:root`, but each component
re-declares them inside its own shadow root. Using the component gets the right geometry for
free; approximating it drifts.

The ones you will reach for first: `peek-button`, `peek-input`, `peek-select`, `peek-card`,
`peek-grid` with `peek-grid-item` and `peek-grid-toolbar`, `peek-list` with `peek-list-item`,
`peek-dialog`, `peek-switch`, `peek-dropdown`, `peek-tabs`.

**The `lit` importmap is required.** Component source imports from the bare specifier `lit`,
which a tile document resolves only if its `<head>` declares an importmap. Without it every
component import fails silently and the elements stay un-upgraded — plain `HTMLElement`, no
shadow root, no error thrown, rendering as inert unstyled tags. Copy this block verbatim from
`apps/desktop/features/windows/windows.html`:

```html
<script type="importmap">
{
  "imports": {
    "lit": "peek://node_modules/lit/index.js",
    "lit/": "peek://node_modules/lit/",
    "lit-html": "peek://node_modules/lit-html/lit-html.js",
    "lit-html/": "peek://node_modules/lit-html/",
    "lit-element": "peek://node_modules/lit-element/lit-element.js",
    "lit-element/": "peek://node_modules/lit-element/",
    "@lit/reactive-element": "peek://node_modules/@lit/reactive-element/reactive-element.js",
    "@lit/reactive-element/": "peek://node_modules/@lit/reactive-element/"
  }
}
</script>
```

Then import the components you use:

```html
<script type="module">
  import 'peek://app/components/peek-card.js';
  import 'peek://app/components/peek-grid.js';
  import 'peek://app/components/peek-input.js';
</script>
```

`peek://app/components/index.js` pulls in all of them at once.

`apps/desktop/features/windows/` is the reference baseline — a real on-system surface built from
`<peek-card>`, `<peek-grid>` and `<peek-input>`. `apps/desktop/renderer/settings/` is **not**:
it is bespoke CSS that only looks close.

---

## Features worth reading

| Read | For |
|---|---|
| `apps/desktop/features/hello-world/home.html` | The minimum viable tile, plus a live probe of the tile API. |
| `apps/desktop/features/todo/` | The ordinary shape: lazy background tile, manifest-declared commands, `resultTopic` replies, pure logic split out and unit-tested. |
| `apps/desktop/features/websearch/home.js` | The lazy-wake init ordering done right, with an `initReady` guard. |
| `apps/desktop/features/windows/windows.html` | The `<peek-*>` baseline and the importmap, verbatim. |
| `apps/desktop/features/slides/background.js` | Settings: load, hot-reload on `slides:settings-changed`, and guarding a wake handler on `settingsLoaded`. Schema in `settings-schema.json`. |
| `apps/desktop/features/tag-actions/background.js` | A 73-line lazy tile woken by a rules-engine topic. The smallest complete handler in the tree. |
| `apps/desktop/features/dropzone/manifest.json` | A declarative `action: { type: "window" }` command with `tiles: []` — a feature with no tile code at all. |
| `apps/desktop/features/theme-basic/` | A theme: `type: "theme"`, base16 `variables`, light and dark `colorSchemes`. See `docs/themes.md`. |
| `apps/desktop/features/example/background.js` | An older `export default` shape with runtime `api.commands.register` and its own datastore table. Useful contrast; not the current idiom. |
| `apps/desktop/features/pubsub-repro/` | Producer and consumer of the same topic pair across two tiles. It is a test repro, so read it for the topic wiring only. |

---

## Gotchas

- **`tile-preload.cts` must stay `.cts`.** The backend `tsconfig.json` emits ESM for `.ts`, and
  Electron's sandboxed preload silently rejects ESM: `window.app` comes up empty and the entire
  tile API vanishes with no error. Never rename or convert it.
- **An undeclared subscribe topic fails silently at runtime** and breaks the gate at test time.
  Declare it in `capabilities.pubsub.topics`.
- **A missing importmap leaves `<peek-*>` elements inert**, with nothing thrown.
- **Register wake handlers before your awaits**, or the tile misses the publish that woke it.
- **A typo in a capability key is ignored, not reported.** Check it against the table above.
- **Prefer pubsub** over directed `webContents.send`; reach for the latter only when you see a
  broadcast-then-filter smell.
- `apps/desktop/CLAUDE.md` holds the operational rules for this app — testing, profiles, and the
  lazy-activation history in more detail.

---

## History

What this document described before it was rewritten no longer exists. In the older model a
handful of built-in features shared one host window as iframes while the rest got windows of
their own, feature directories sat in a top-level `features` directory, and pages were addressed
under an `ext` URL host. Every surface is now a tile in its own window under
`apps/desktop/features/`, addressed at `peek://<tile-id>/`, with capabilities granted per
manifest; there is no shared host window and no consolidation list.

Two remnants are still visible and are not patterns to copy:
`apps/desktop/main/protocol.ts` maps the legacy `ext` URL host so saved session URLs keep
resolving, and several older features declare `ext:`-prefixed lifecycle topics
(`ext:ready`, `ext:<id>:shutdown`) in their manifests.
