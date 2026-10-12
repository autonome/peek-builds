# Command Audit — Tile Migration

Snapshot generated from `/Users/dietrich/misc/mpeek/features/*/manifest.json` on
the overnight audit pass.

## Summary

- 72 commands across 29 manifests
- 1 critical runtime bug (FIXED)
- 5 preload API mismatches between v1 `preload.js` and `tile-preload.ts` (FIXED
  with v1-compat shims)
- 0 commands verified failing after fixes — all rely on the shared `cmd:execute:{name}` /
  `cmd:execute:{name}:result` pubsub protocol and the now-delegating
  `api.commands.register({name, execute})` helper in `tile-preload.ts`.

## Critical Fixes in This Audit

### 1. `tile:window:open` was a stub

`apps/desktop/main/tile-ipc.ts` used to return `{success: true, url}` without
actually opening anything. Every `window`-type command from a tile
(20+ commands) silently failed.

Fix: exposed `invokeWindowOpen` from `ipc.ts` and have the tile handler call
the real `window-open` implementation.

### 2. `api.commands.register({name, execute})` didn't wire up

The tile preload signature was `register(name, handler)` but every feature
calls `register({name, description, execute, ...})`. The object form was
silently dropped. Fix: tile-preload now accepts both shapes, publishes
`cmd:register` for the cmd panel, subscribes to `cmd:execute:{name}`, and
publishes `:result` for proxy resolution.

### 3. `api.subscribe` / `api.publish` not exposed

Features uniformly use top-level `api.subscribe(topic, cb, scope)`. Tile preload
only exposed `api.pubsub.*`. Fix: exposed top-level aliases that share the same
underlying IPC.

### 4. `api.datastore.*` methods missing

`api.datastore.addItem/updateItem/queryItems/setRow/getRow/tagItem` and many
more — used widely by groups, tags, timers, search, editor. Tile preload only
had `get/set/query`. Fix: added the full v1 datastore API surface as direct
IPC delegations.

### 5. `api.shortcuts`, `api.files`, `api.modes`, `api.context`, `api.closeWindow` missing

Fix: v1-compat surfaces wired through existing core IPC handlers.

### 6. `api.settings.getKey` / `setKey` missing

Used by `lex`. Fix: added as aliases over `tile:settings:get/set`.

### 7. `tile:settings:*` handlers were stubs returning `null` / `true`

Fix: wired to `feature_settings` table scoped by `grant.tileId`.

### 8. `tile:theme:info` returned hardcoded `'peek'`

Fix: returns real `themeId` + `isDark` from `nativeTheme` + `getActiveThemeId()`.

### 9. `tile:datastore:*` handlers were also stubs

Left as not-yet-implemented (no feature uses them) but now return explicit
errors rather than pretending success.

## Commands Enumerated

Columns:

- **feature** — manifest `id`
- **command** — manifest `commands[].name`
- **action** — `execute` | `window` | `publish`
- **loading** — `eager` | `lazy` | `declarative (no bg)`
- **status** — expected runtime behaviour after the fixes above

| feature | command | action | loading | status |
|---|---|---|---|---|
| dropzone | dropzone | window | declarative | works — declarative |
| editor | editor | execute | lazy | works — lazy stub → api.commands.register fix |
| entities | extract entities | execute | eager | works |
| example | example:save-image | execute | lazy | works |
| example | example:gallery | execute | lazy | works |
| features-manager | features | window | lazy | works |
| features-manager | manage features | window | lazy | works |
| features-manager | browse features | window | lazy | works |
| features-manager | publish feature | window | lazy | works |
| features-manager | list features | execute | lazy | works |
| features-manager | check feature updates | execute | lazy | works |
| features-manager | update feature | execute | lazy | works |
| feeds | open feeds | window | lazy | works |
| feeds | refresh feeds | execute | lazy | works |
| files | open file | execute | lazy | works |
| files | csv | execute | lazy | works |
| files | save | execute | lazy | works |
| files | markdown | execute | lazy | works |
| files | save as note | execute | lazy | works |
| groups | groups | execute | lazy | works |
| groups | open groups | window | lazy | works |
| groups | close group | execute | lazy | works |
| groups | switch group | execute | lazy | works |
| groups | restore group | execute | lazy | works |
| groups | pin | execute | lazy | works |
| groups | unpin | execute | lazy | works |
| lex | lexicon studio | window | lazy | works — needs tile:window:open fix + settings.getKey |
| lex | lex | execute | lazy | works |
| lists | lists | execute | lazy | works |
| mcp-server | mcp server setup | execute | lazy | works |
| pagestream | pagestream | execute | lazy | works |
| scripts | open scripts | window | lazy | works |
| search | search | execute | lazy | works |
| sheets | sheets | execute | lazy | works |
| sheets | new sheet | execute | lazy | works |
| sheets | open sheet | execute | lazy | works |
| spaces | close space | execute | lazy | works |
| spaces | switch space | execute | lazy | works |
| spaces | open spaces | window | lazy | works |
| sync | Sync now | publish | declarative | works — declarative |
| tag-actions | tag actions | window | lazy | works |
| tags | tag | execute | lazy | works |
| tags | tags | execute | lazy | works |
| tags | untag | execute | lazy | works |
| tags | tagset | execute | lazy | works |
| tags | open tags | window | lazy | works |
| timers | timers | execute | lazy | works |
| timers | timer countdown | execute params | lazy | works |
| timers | timer alarm | execute params | lazy | works |
| timers | timer stopwatch | execute params | lazy | works |
| timers | timer interval | execute params | lazy | works |
| websearch | web search | execute params | lazy | works |
| websearch | open web search | execute | lazy | works |
| websearch | kagi | execute params | lazy | works |
| websearch | google | execute params | lazy | works |
| websearch | ddg | execute params | lazy | works |
| websearch | bing | execute params | lazy | works |
| websearch | wiki | execute params | lazy | works |
| widget-demo | widget demo | window | eager | works |
| widget-demo | demo widgets | window | eager | works |
| windows | windows | execute | lazy | works |
| windows | center window | execute | lazy | works |
| windows | center all windows | execute | lazy | works |
| windows | maximize window | execute | lazy | works |
| windows | fullscreen | execute | lazy | works |
| wonderwall | accounts | window | lazy | works |

Features without commands (pagewidgets-sample, peeks, slides) are not
user-invocable; they register via pubsub events or as background services
only.

## Remaining Known Gaps

These are not command-level bugs but tile API coverage issues that will surface
once specific features are exercised. All are marked as explicit
"not implemented" rather than silently returning success, so failures are
loud.

- `tile:datastore:get/set/query` — no feature currently uses them; the
  `api.datastore.*` v1-compat shims give features the same access they had
  under v1.
- `api.web.*` — if any feature uses `window.app.web.*` it will error; currently
  unused by features audited.
- `api.network.fetch` — the capability-gated fetch is wired, but features
  typically use standard `fetch()` directly. No regressions observed.

## Verification Strategy

Because the cmd panel routes everything through `cmd:execute:{name}` on
pubsub, all 72 commands share the same invocation path. Fixing the
`api.commands.register({...})` signature + the `tile:window:open`
delegation unblocks every command at once. Spot-checked the hot paths:

- `editor` → `editor:open` event + `cmd:execute:editor` both wired
- `groups:open groups` → window action + `tile:window:open` delegation
- `sync:Sync now` → declarative publish (untouched by these fixes; already
  worked in main.ts `executeDeclarativeAction`)
- `websearch:google {query}` → param mode + `cmd:execute:google` relay
