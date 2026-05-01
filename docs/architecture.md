# Peek Architecture

A guide for contributors landing on the repo cold. Covers the tile model, the
three state machines that govern runtime behavior, and how Peek's tile concept
relates to the [webtil.es](https://webtil.es/) / [DASL Tiles](https://dasl.ing/tiles.html)
specification.

This document is a map. For the deep design behind any individual piece, follow
the per-topic docs linked inline.

---

## The tile model

> **A tile is a feature. Full stop.**
> A tile is an HTML file that runs in a renderer process. It can register
> commands, subscribe to events, hold state, show a UI, or stay completely
> hidden. Some tiles never show anything; some show themselves when a command
> fires; some do both.

There is no "tile type" and no "tile role" in the conceptual model. **Every
feature is a tile.** If functionality lives outside the tile model it is *core*
(`app/`), not a feature. See [docs/tiles-single-file.md](./tiles-single-file.md)
for the rationale and current manifest shape.

### One renderer mechanic, one preload, one IPC surface

Every renderer in Peek — feature tiles in `features/<id>/`, the bundled core
renderers in `app/` (the bgWindow orchestrator, the cmd panel, the HUD, the
page canvas), and the test fixture — runs through the same machinery:

- A single HTML entry point
- Loaded into a per-window Electron `BrowserWindow` with the
  [`backend/electron/tile-preload.cts`](../backend/electron/tile-preload.cts)
  preload script (CommonJS — Electron's sandbox preload rejects ESM)
- Talks to the main process exclusively over the strict `tile:*` IPC surface
- Holds a per-window **capability token** that the main process mints at
  load time and revokes at unload

The legacy era — `preload.js`, an `extensionHostWindow` that loaded multiple
features as iframes, and a parallel set of legacy IPC channels — was removed
in April 2026 ([docs/v1-removal-plan.md](./v1-removal-plan.md), Status:
DONE). The tile path is the only path.

### Manifest schema (v3)

A tile is described by a `manifest.json` at `manifestVersion: 3`. The full
TypeScript schema lives in
[`backend/electron/tile-manifest.ts`](../backend/electron/tile-manifest.ts);
the abbreviated shape is:

```json
{
  "manifestVersion": 3,
  "id": "my-tile",
  "name": "My Tile",
  "tiles": [
    {
      "id": "home",
      "url": "home.html",
      "width": 700,
      "height": 500,
      "resident": true
    }
  ],
  "capabilities": {
    "pubsub": { "scopes": ["global"], "topics": ["my-tile:*"] },
    "datastore": { "tables": ["items"] },
    "commands": true
  }
}
```

Two axes describe a tile's runtime behavior, and only one of them lives in
the manifest:

| Axis | Values | Decided in |
|------|--------|------------|
| **Residency** | `resident: true` (loaded at startup) vs lazy (loaded on demand) | manifest |
| **Visibility** | shown vs hidden | runtime — `api.window.showSelf()` / `hideSelf()` |

The legacy `type: "background" | "window" | "panel"` and the nested
`windowHints` object were both removed in `manifestVersion: 3` and the
validator now rejects them outright. Window geometry fields (`width`,
`height`, `transparent`, `alwaysOnTop`, `frame`, etc.) are flat on `TileEntry`.

### Capabilities

Each tile declares the `capabilities` it needs in its manifest. At load time
the main process resolves the request into a `CapabilityGrant` (full schema in
`tile-manifest.ts::TileCapabilities`):

| Capability | Purpose | Sub-shape |
|------------|---------|-----------|
| `pubsub` | publish/subscribe to topics | scopes (`self`/`global`/`system`) + optional topic allowlist |
| `datastore` | SQLite access | per-table allowlist |
| `network` | cross-origin fetch | per-domain allowlist |
| `window` | open/close/manage other windows | `create`/`query`/`manage` + URL-prefix allowlist |
| `filesystem` | read/write paths (privileged — built-ins only) | per-path glob allowlists |
| `shortcuts` | global/local hotkeys | optional per-key allowlist |
| `commands` | register commands in the cmd panel | boolean |
| `theme` / `sync` / `settings` / `context` / `dialogs` / `oauth` / `features` / `session` / `izui` | scoped per-API access | mostly boolean or small allowlist objects |

`sync` and `filesystem` are restricted to built-in tiles. Most capabilities
accept either `true` (broad grant) or an object form (allowlisted grant).

Bundled core renderers (cmd, hud, page, the bgWindow orchestrator, the test
fixture) carry a `trustedBuiltin: true` grant from
`createTrustedBuiltinGrant()`. Every capability check at runtime returns "ok"
without consulting the grant when this flag is set — the bypass is explicit
at every site (grep for `trustedBuiltin` to audit). Core renderers use the
same tile mechanics as feature tiles; they just skip enforcement because they
ship as part of the trusted codebase.

### The IPC chokepoint

Every `tile:*` IPC frame goes through a single main-process pipeline,
[`backend/electron/tile-ipc-gate.ts`](../backend/electron/tile-ipc-gate.ts).
Handlers cannot be registered any other way. The pipeline runs in fixed
order; failing any step emits a `gate:rejected` telemetry event and drops
the frame:

1. **Channel allowlisted?** (implicit via `registerTileIpc()` registration)
2. **Sender frame matches token owner?** (closes the "forged token via XSS" hole)
3. **Payload schema valid?** (hand-rolled shape checks — Zod/Ajv is too slow for the per-frame budget)
4. **Token valid + required capability granted?**
5. **Tile in a state that can dispatch?** (cross-check against the lifecycle FSM)
6. **Sender role allowlisted for this channel?**

In dev mode, two bypass detectors run alongside: `installDirectSendGuard()`
patches `WebContents.prototype.send` to reject any direct `pubsub:*` push
that bypasses the broadcaster, and `installOffPathWindowGuard()` patches
`BrowserWindow.prototype.loadURL` to assert any `peek://{tile}/` URL has a
matching `registered → loading` lifecycle transition. Anything that tries
to back-door a tile renders a loud assertion failure rather than a silent bug.

### The preload surface

[`tile-preload.cts`](../backend/electron/tile-preload.cts) exposes
`window.app` to the renderer. This is the entire API a tile sees. The shape
is tracked in [docs/tile-api.md](./tile-api.md); see
[docs/tile-preload-trimming-plan.md](./tile-preload-trimming-plan.md) for
the in-flight cleanup of the remaining v1-compat shims.

The preload **must** stay a `.cts` (CommonJS TypeScript) file. The backend
`tsconfig.json` uses `module: NodeNext`, which emits ESM for `.ts` files,
which Electron's sandbox preload silently rejects (no API surface, no error
thrown — just an empty `window.app`).

### The bgWindow is core, not legacy

`peek://app/background.html` (loaded as **bgWindow** via the same
`tile-preload.cts`) is the **core orchestrator** of Peek. It hosts
`app/index.js`, which initializes the cmd registry, the page canvas
controller, and the HUD via `initCmd()` / `initPage()` / `initHud()` (all
consolidated into the core renderer in April 2026). bgWindow is not a tile,
not a feature, not v1 anything. Every pubsub publish in the system must
reach it.

---

## State machines

Peek runs three explicit state machines. Each replaces a class of ad-hoc
timing code (sleeps, polling loops, `visibilitychange` listeners, retry
hacks) with a deterministic transition table. Each has its own design doc;
the summaries below describe what each FSM owns and what bug class it makes
impossible.

### 1. Tile lifecycle FSM

**Owns:** when a tile is alive.
**Lives in:** [`backend/electron/tile-lifecycle.ts`](../backend/electron/tile-lifecycle.ts) +
[`backend/electron/tile-fsm.ts`](../backend/electron/tile-fsm.ts) (pure transition table).
**Doc:** [docs/tile-lifecycle-fsm.md](./tile-lifecycle-fsm.md)

States: `unregistered → registered → loading → ready → visible` plus
`unloading` and `crashed`. The tile manifest cache is populated on
`unregistered → registered` and static declarations (commands, shortcuts,
nouns, lazyEvents) become visible to the cmd panel without the tile
running. The renderer is created on `registered → loading`, the capability
token is minted on `loading → ready`, and revoked on `→ unloading` /
`→ crashed`. There is one code path for window creation regardless of
trigger (eager-at-boot, lazy-on-dispatch, or relaunch-after-crash) — timing
controls *when*, never *how*.

This FSM replaces a year's worth of "tile loaded but its commands haven't
appeared yet" / "spinner hangs forever because the dispatch target was
never live" / "ESM-side and renderer-side disagree about whether the tile
exists" bug clusters.

### 2. PubSub state machine

**Owns:** what messages can flow between tiles in each state.
**Lives in:** [`backend/electron/pubsub.ts`](../backend/electron/pubsub.ts) +
the `tile-ipc-gate.ts` validation pipeline above.
**Doc:** [docs/pubsub-state-machine.md](./pubsub-state-machine.md)

The token is the capability handle: if `validateToken(t)` returns a grant,
the tile is alive and the publish/subscribe is allowed against the granted
scopes. The pubsub path does **not** read lifecycle state — token validity
and lifecycle state are kept in sync by `tile-lifecycle.ts` as the sole
owner of both, removing a hot-path cross-module dependency and making the
race question ("was the publish checked before or after the state change?")
unaskable.

A single `pubsubBroadcaster` in main fans every publish out to all tile
windows (including bgWindow) and webview guests. Subscribe-before-publish is
guaranteed by a startup latch: no non-bgWindow tile can transition
`registered → loading` until bgWindow has signaled lifecycle ready. The
`cmd:request-registers` replay machinery that previously papered over this
race was deleted once the latch landed.

This FSM rolled out in 8 phases in April 2026 (see
[`project_pubsub_fsm_conversion_done.md`](https://example) — internal
memory). It made "a publish was dropped somewhere in the fabric" impossible
as a bug class: if a message doesn't flow, the validation pipeline says
exactly which step rejected it.

### 3. Cmd panel state machine

**Owns:** the interactive command-bar UI states.
**Lives in:** [`app/cmd/state-machine.js`](../app/cmd/state-machine.js) (pure
module — no DOM, no IPC).
**Doc:** [docs/cmd-state-machine.md](./cmd-state-machine.md)

Ten states: `IDLE`, `TYPING`, `RESULTS_OPEN`, `PARAM_MODE`, `EXECUTING`,
`OUTPUT_SELECTION`, `CHAIN_MODE`, `CHAIN_POPUP`, `ERROR`, `CLOSING`. Actions
run *before* `currentState` is updated. The pure module is unit-tested
exhaustively; the DOM adapter in `app/cmd/panel.js` is the only thing that
talks to electron / DOM.

This FSM replaces the previous "every panel.js bug fix added another
boolean flag" model. Each of the previous regression cycles (param-mode
escape, Tab-fills-vs-Enter-executes, output selection cancel) becomes a
single transition entry plus a test.

---

## Window placement

**Owns:** where every BrowserWindow lands when it's opened, reused, or
when display topology changes.
**Lives in:** [`backend/electron/window-placement.ts`](../backend/electron/window-placement.ts) — a pure module with no `screen.*` or `BrowserWindow.*` calls inside; the caller passes display state in.
**Doc:** [docs/window-placement-refactor.md](./window-placement-refactor.md) (sprint plan and rationale)

A `Placement` discriminated union (`centered`, `cursor-display-fallback`,
`edge`, `parent-centered`, `manual`) captures the *intent* for each
window. Intent is recorded once at window-open time on
`windowRegistry.params.placement` and never re-derived from flag soup
(`center: true`, explicit `x/y`, `useCanvas`, etc.). All consumers — the
URL-reuse and keepLive-reuse paths in `ipc.ts`, the fresh-open fallback,
the display-watcher second pass, and the tile open path in
`tile-ipc.ts` — call the same `computePlacement(input)` and apply its
`reposition` / `no-change` result. Stranded-rescue (<50% area on any
display) is built in for every mode. Unit-tested with synthetic display
layouts via a `fakeDisplays(...)` helper so display-switch regressions
are catchable as single failing tests, no real multi-monitor hardware
required.

---

## Peek tiles vs webtil.es / DASL Tiles

The [DASL Tiles specification](https://dasl.ing/tiles.html) (the spec
referenced from [webtil.es](https://webtil.es/)) and Peek's tiles share the
same core word and a similar instinct — composable web docs/apps that can
be embedded in arbitrary contexts and protected from data exfiltration —
but they sit at very different points in the design space. The DASL spec
is a **portable distribution format**: how a tile is identified, signed,
declared, and loaded into *any* host. Peek's tile is an **in-process
runtime contract**: how a feature lives inside the Peek desktop app.

The tables below compare them axis by axis. The spec is dated 2026-02-11
and explicitly defers several features (capabilities, IPC, composition) to
future versions, so a number of cells are honestly "not specified" rather
than "different from Peek."

### Lifecycle model

| | DASL Tiles | Peek tiles |
|---|---|---|
| Defined states | None — spec mentions tiles are "loaded into contexts" but defines no state machine | 7 explicit states (`unregistered`, `registered`, `loading`, `ready`, `visible`, `unloading`, `crashed`) |
| Transitions | None | Explicit table in `tile-fsm.ts`; enforced by `tile-lifecycle.ts` |
| Resident vs lazy | Not addressed | First-class — `resident: true` in manifest |
| Crash recovery | Not addressed | `crashed` state + auto-relaunch policy |

Peek goes considerably further here because it runs tiles as long-lived
in-process renderers, not as one-shot embeds.

### Capability / permission system

| | DASL Tiles | Peek tiles |
|---|---|---|
| Per-tile capability declarations | "tiles can be granted additional contextual access" — deferred to future spec version | Required `capabilities` object on every manifest |
| Network access | All-or-nothing: tiles are "completely cut off from network access beyond loading their own pre-declared dependencies" via CSP `default-src 'self' blob: data:` | Per-domain allowlist via `network: { domains: [...] }` |
| Storage access | Not specified | Per-table allowlist via `datastore: { tables: [...] }` |
| Privilege tiers | Not specified | `builtin` vs external; some caps (filesystem, sync) are builtin-only; `trustedBuiltin` flag for core renderers |
| User approval | Not specified | Privileged caps (currently `filesystem`) flagged `PRIVILEGED_CAPABILITIES` for explicit user approval |

Peek is more conservative on what's declared (manifest-driven allowlists)
and on what's enforced (gate pipeline runs every IPC frame). DASL is more
conservative on what's possible at all (network is locked off entirely
at the platform level).

### IPC / message-passing surface

| | DASL Tiles | Peek tiles |
|---|---|---|
| Inter-tile messaging | "A future version… will add support for chat channels… and an intent-based way for tiles to call one another." Not in current spec. | Full pubsub: `api.publish(topic, data)` / `api.subscribe(topic, cb)` |
| Host ↔ tile messaging | Not specified | `tile:*` strict IPC, gated through 6-step pipeline in `tile-ipc-gate.ts` |
| Sender authentication | N/A | Per-window capability token; sender-frame cross-check at every IPC handler |
| Topics namespace | N/A | Topic allowlist supported in `pubsub.topics` capability |

This is the largest gap. Peek's tiles are *built around* in-process
messaging; DASL Tiles, today, are essentially message-less embeds.

### Persistence / storage

| | DASL Tiles | Peek tiles |
|---|---|---|
| Storage model | Not specified | Shared SQLite `datastore` (per-tile table allowlist), per-tile `feature_settings` namespace, optional cross-tile read via `settings.readForeign` |
| Cross-tile data | Not specified | Cross-tile reads explicit (`readForeign: ['ext-id']`); cross-tile writes not exposed |
| Sync | Not specified | Built-in `sync` capability (builtin-only), shared schema across desktop/server/mobile |

### Manifest schema

| | DASL Tiles | Peek tiles |
|---|---|---|
| Format | MASL (DASL flavor); CID-addressable; AT Protocol PDS-hosted | Plain JSON in `manifest.json`; loaded from local disk (built-in or installed) |
| Required fields | `name`, `resources` (with `/` entry) | `manifestVersion: 3`, `id`, `name`, `tiles[]`, `capabilities` |
| Versioning | `prev: cid-link` for previous version; `version: 1` (CAR compat only) | `manifestVersion: 3` (schema version); `version` (semantic version of the tile) |
| Identity | CID of the tile content | String `id` unique within the install |
| Display metadata | `description`, `icons`, `screenshots`, `categories`, `background_color`, `theme_color`, `short_name` | `description`, `name`, `shortname` (no built-in icon/screenshot fields yet) |
| Sizing | `sizing: { width, height }` (advisory) | Per-tile-entry `width`/`height`/`minWidth`/`minHeight`/`alwaysOnTop`/`transparent`/etc. (concrete window geometry) |
| Multiple entry points | Not supported (a tile is one resource bundle) | `tiles: TileEntry[]` array, up to 10 per manifest |

### Origin / sandbox

| | DASL Tiles | Peek tiles |
|---|---|---|
| Origin model | Unique random origin per tile (may become CID-derived) | Custom `peek://{tileId}/{entry}` scheme |
| Sandbox flags | `allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads` | Electron `sandbox: true` + per-tile preload + `contextIsolation: true` |
| CSP | `default-src 'self' blob: data:` enforced by spec | Not enforced by the runtime today; tiles run inside the `peek://` scheme with main-process gatekeeping instead |
| COOP/COEP | `same-origin` / `same-origin` | Not applicable — single-process electron host |
| Referrer | `no-referrer` | Not applicable to in-process tiles |

DASL's sandbox model is browser-native and applies to *any* host. Peek's
sandbox is Electron-native and assumes a single trusted host (the Peek
main process) gating everything.

### Composition

| | DASL Tiles | Peek tiles |
|---|---|---|
| Tile-calls-tile | "Future version… intent-based way for tiles to call one another" | Pubsub topics + the cmd palette as a discoverable intent surface |
| Embedding tiles | The spec is fundamentally about "assembled from multiple sources to carry out complex user interface tasks" — this *is* the model | Not the model — tiles are top-level windows, not embeds. Composition is event-based, not visual |

### Terminology Peek could adopt

The DASL spec uses **"tile execution context"** for the environment that
loads a tile, and **"embedding context"** for the source that embeds it.
Peek's docs occasionally drift between "tile", "feature", "extension", and
"window"; aligning on "tile" everywhere (which the v1-removal pass largely
accomplished) and adopting "tile execution context" as the term for the
per-window renderer + preload + grant triple would tighten the vocabulary.

### Where Peek goes further than the spec

- **Lifecycle as an explicit FSM** with crash recovery and a manifest cache
  for static declarations.
- **Per-frame capability gating** on every IPC channel, not a coarse
  load-time grant.
- **Inter-tile messaging** as a first-class system, with subscribe-
  before-publish guarantees.
- **Multiple entry points per manifest** (`tiles: TileEntry[]`) supporting
  resident orchestrators alongside lazy UI windows.
- **Per-tile capability tokens** with sender-frame cross-check, defending
  against forged tokens via XSS.

### Where the spec goes further than Peek

- **Content-addressed identity** (CID) rather than string IDs that can
  collide across installs.
- **Browser-native sandbox** (sandbox flags, CSP, COOP/COEP) that works in
  any host, not just Peek.
- **Distribution as a first-class concern** — tiles are AT Protocol
  records, signed, fetchable from any PDS.
- **Display metadata** (icons, screenshots, theme colors) standardized in
  the manifest.

The two models are largely complementary: Peek's runtime contract could be
layered on top of DASL's distribution format, and DASL's distribution
format could be the install path for Peek tiles. Today the only meeting
point is the AT Protocol — Peek does install feature tiles from PDS
records, but the format is Peek's, not DASL's.

---

## Implementation conventions

A grab-bag of conventions that aren't structural but recur often enough
to bite. The state machines and lifecycle docs cover the spine; this
section covers the corners.

### bgWindow is the orchestrator

The background window (`peek://app/background.html`) is THE core
orchestrator. The cmd, hud, and page surfaces are consolidated into it.
Every published event must reach it; if you find a producer publishing
to a renderer that bgWindow doesn't observe, the routing is wrong.

### Declarative publish-type commands

Commands of `type: 'publish'` must publish a `:result` event back so the
cmd panel proxy resolves. Otherwise the panel hangs for 30 s before
timing out.

### HUD widgets

HUD widgets live in the core renderer (not a separate tile) and are
loaded via `initHud()` inside `app/index.js`. They are eager,
`alwaysOnTop: true`, and `focusable: false`.

- App focus drives hide/show via main-process `did-resign-active` /
  `did-become-active`.
- The `__hudHidden` flag plus `trackVisibleWindowFocus()` skips
  non-focusable windows so they don't override focused-window targeting.

### Cmd panel state machine

`app/cmd/state-machine.js` is a pure module with no DOM/IPC deps. Ten
states: IDLE, TYPING, RESULTS_OPEN, PARAM_MODE, EXECUTING,
OUTPUT_SELECTION, CHAIN_MODE, CHAIN_POPUP, ERROR, CLOSING. Actions run
BEFORE `currentState` is updated. See
[docs/cmd-state-machine.md](./cmd-state-machine.md) for the full spec
and test coverage notes.

### peek-card component

- Empty slot sections are hidden via `slotchange` + the `slot-empty`
  class. CSS `:empty` does not work on slot elements.
- **Card action buttons must always be visible.** Never hover-reveal
  them.

### Window open IPC

- External URLs need centered coordinates computed BEFORE canvas bounds
  adjustment (otherwise undefined `x`/`y` produce `NaN`).
- `handleExternalUrl` is exposed on the `__peek_test` global for
  Playwright.
- `window._cmdState` in the cmd panel exists for deterministic test
  waits.
- Main-process `setTimeout` bodies that reference a window or
  `webContents` must guard `isDestroyed()` — closing inside the
  deferred callback throws unhandled.
- `workspaceKey`'d tiles collapse opens — Playwright cannot get a fresh
  window when the key matches an existing one. Static manifest
  assertions are the fallback.

### Page widget panels

Page info (top-left) and entities (right-side) live in
`app/page/page.js`. The entities panel subscribes to `entities:extracted`
pubsub and falls back to DOM extraction after 2 s.

Page-host overlays (load error, etc.) belong inside `.center-column`
with `position: absolute; inset: 0`, NOT on `<body>` with
`position: fixed` — fixed-positioned overlays stretch with `show()`'s
window expansion.

### Groups UI

`promoteTagToGroup()` must only pass valid DB columns to `setRow()`.
Runtime-only props like `addressCount` cause silent SQL failures.

### Canvas page rewriting

Web URLs are rewritten on open: `https://example.com` →
`peek://app/page/index.html?url=...`. Group mode context is set on new
windows BEFORE `loadURL`; `openWindow` falls back to
`lastFocusedVisibleWindowId` when no opener is provided.

CSS gotcha: `-webkit-mask-image` on a webview clips `box-shadow` —
use `border` + `outline` instead.

### Webview / visible content area

The visible content area must NEVER resize except via direct user
interaction. Window + chrome may grow (e.g. for navbar reveal), but the
visible content stays put.

### Electron ESC handling

Electron's `before-input-event` intercepts ESC at the main-process level
and calls `e.preventDefault()`. DOM `keydown` listeners for ESC never
fire in the renderer — textarea / input keydown listeners are dead code
for ESC.

ESC is delivered via `escape-pressed` IPC → preload `_escapeCallback` →
the tile's `onEscape` handler. To handle ESC in custom UI elements,
check `document.activeElement` in the `onEscape` handler, blur/close as
needed, return `{ handled: true }`.

`escUnhandledPolicy()` is the second-phase handler; it opens the
Windows switcher at the workspace root.

### Editor pane architecture

Four panes: outline, editor (center), preview, notes/annotations.
Collapse icons MUST set `font-family: system-ui` on toggle elements;
ServerMono lacks the Unicode glyphs.

### PubSub event publishing

- Direct `tagItem()` calls do NOT publish events — UIs won't update
  reactively. Use `tagItemAndPublish()` in `ipc.ts` for any tagging that
  should trigger a UI refresh.
- Same pattern applies to any data mutation that skips the IPC handler:
  it must manually publish.
- Groups UI listens for: `tag:item-added`, `tag:item-removed`,
  `tag:created`, `item:created`, `item:deleted`, `sync:pull-completed`.
- The Tags page widget (`app/page/page.js`) also subscribes to
  `tag:item-added` / `tag:item-removed` and resolves `currentItemId` on
  the first tag event when null.

### Noun system

`features/cmd/noun-registry.js` + `features/cmd/nouns.js`. Register a
noun via `registerNoun({ name, singular, query, create, browse, ... })`
and the system auto-generates: bare command, `list {name}`,
`new {singular}`, `open {singular}`. Used by groups, tags (with
`skipBare`), and lex (singular `lex`, NSID-filtered query). Prefer
nouns over registering many individual commands — avoids command
registry pollution.

### Sync architecture

- Device IDs are raw UUIDs (no `desktop-` / `mobile-` / `extension-`
  prefixes).
- `_sync` metadata lives inside the item `metadata` JSON:
  `{ _sync: { createdBy, createdAt, modifiedBy, modifiedAt } }`.
- `syncSource` was removed from desktop Electron, server, and
  `sync/sync.js`; it still exists in iOS `lib.rs` and Tauri `sync.rs`
  pending refactor.
- Push filter: `syncedAt === 0` OR `updatedAt > syncedAt`.
- E2E sync tests use `E2E_TEST=true` to bypass auth.

### "Extension" is a smell when used for tiles

Real Chrome MV3 extensions live in `chrome-extensions/` and keep the
"extension" name. Anywhere else, "extension" used as a synonym for
tile / feature is a leftover from v1 and should be renamed.

---

## See also

- [docs/tiles-single-file.md](./tiles-single-file.md) — the "single-file
  tile" model and the manifest target shape
- [docs/tile-api.md](./tile-api.md) — the `window.app` surface
- [docs/tile-preload-trimming-plan.md](./tile-preload-trimming-plan.md) —
  in-flight cleanup of v1-compat shims in the preload
- [docs/tile-lifecycle-fsm.md](./tile-lifecycle-fsm.md) — lifecycle FSM
  design
- [docs/pubsub-state-machine.md](./pubsub-state-machine.md) — pubsub FSM
  design
- [docs/cmd-state-machine.md](./cmd-state-machine.md) — cmd panel FSM
  design
- [docs/v1-removal-plan.md](./v1-removal-plan.md) — historical record of
  the v1 removal (DONE 2026-04-24)
