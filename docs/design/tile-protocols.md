# Tile APIs as Web Tiles protocols

Status: proposal under review. Nothing here is built.

## Decided

- **Direction (2026-10-20).** Tile APIs move from `window.app` to Web Tiles protocols, one API
  at a time, with core surfaces staying on `window.app`. A tile written this way can run in any
  Web Tiles host, and a new API is declared in one place instead of three.

## Problem

Every API a tile can call is wired by hand in three places:

- `main/tile-preload.cts`: one `api.<namespace>` object, one wrapper per method, each repeating
  the `validationPromise` wait and passing `tileToken` (see `api.atproto` for a typical one).
- `main/tile-ipc.ts`: one `registerTileIpc('tile:<namespace>:<method>', ...)` handler per method,
  each repeating the token and capability check and calling `handleViolation()` on failure.
- `packages/capabilities/index.js`: the capability's validation, plus `BUILTIN_ONLY_CAPABILITIES`
  or `PRIVILEGED_CAPABILITIES` when it is restricted, and the generated CommonJS copy
  (`codegen.js`, `check-freshness.js`).

`tile-preload.cts` holds about forty namespaces built this way. Adding one means editing all three,
and the result exists only inside Peek: a tile written against `window.app` runs nowhere else,
and Peek cannot run a tile written for any other host.

## What Web Tiles now provides

The DASL Web Tiles spec (https://dasl.ing/tiles.html) gained a general mechanism for host APIs in
July 2026, after `docs/architecture.md` "Peek tiles vs webtil.es / DASL Tiles" was written against
the 2026-02-11 draft:

- **Protocols** (https://dasl.ing/tiles-protocols.html). A tile loads a host API with
  `await import('/.well-known/web-tiles/<name>.js')`. A host that does not provide `<name>` fails
  the import, and the tile carries on without it. Which protocols exist, and who may use them, is
  left entirely to the host.
- **Messages.** In a web context, protocol modules talk to the host over `postMessage` as
  `{ action, payload }`, with tile-to-host actions prefixed `tiles-protocol-up-` and host-to-tile
  actions prefixed `tiles-protocol-down-`. Payloads are structured clones.
- **`data`** (https://dasl.ing/tp-data.html, `@dasl/tile-server` 2.1.0 `public/data.js`): a
  generic two-way channel, exporting `listen()`, `sendData(payload)`, `addDataHandler(handler)`
  and `removeDataHandler(handler)`.
- **`store`** (tp-editable, for tiles that edit themselves) is reserved with no spec text or code.
- **Not built:** chat channels, intents (tiles calling each other), origins derived from a tile's
  content hash. **Rejected:** permission prompts. The tile manifest has no field for the
  protocols a tile uses.

## Proposal

Each Peek tile API becomes a protocol: a module at `/.well-known/web-tiles/<name>.js`, served by
the host, that a tile imports instead of reading `window.app.<name>`.

1. **One registration per protocol.** A protocol is declared once in the main process: its name,
   the capability that gates it, and its methods as handlers. From that declaration the host
   derives the IPC channels, the token and capability checks, and the module it serves. Adding an
   API touches one file.
2. **Capabilities stay the gate.** A protocol whose capability the tile was not granted is not
   served to that tile: its import fails exactly as it would in a host that lacks the protocol.
   That keeps Peek's model (`capabilities` in the manifest, user approval for privileged ones,
   built-in-only ones) inside the latitude the spec gives hosts, and gives tiles one code path for
   "not available" whatever the reason.
3. **The transport stays IPC inside Peek.** A Peek tile's protocol module calls the main process
   through the preload, as now. The `tiles-protocol-up-` / `-down-` `postMessage` form is what a
   protocol module speaks when the tile runs in another host, and what Peek speaks when it hosts a
   Web Tile (step 5).
4. **`window.app` stays during the move.** Each namespace keeps working while its protocol exists
   alongside it; features move namespace by namespace, and a namespace's `window.app` copy is
   removed once nothing uses it.
5. **Peek can host Web Tiles.** Running a third-party tile needs an isolated origin per tile with
   the spec's CSP and sandbox, its resources served from its record, and the `data` protocol
   answered. Peek's own protocols are then offered to it under the same capability rules.

## First protocol: `atproto`

`api.atproto` moves first:

- It is small (`request`, `sessionInfo`, `uploadBlob`) and has no subscriptions, so it exercises
  the registration, gating and serving without the harder questions events raise.
- Its main-process side already exists (`tile-ipc.ts` `tile:atproto:*`, `main/atproto-proxy.ts`).
- Its users are few and current: `features-manager/publish.js` and `lex`.
- It is the API a tile is most likely to want from a host that is not Peek.

Done looks like: `features-manager/publish.js` imports the `atproto` protocol and no longer reads
`api.atproto`; a tile without the capability gets a failed import; the existing live publish spec
(`tests/desktop-serial/atproto-live-publish.spec.ts`) passes unchanged.

## Declaring protocols in the manifest

A tile lists the protocols it uses in a `protocols` field, mapping each name to `required` or
`optional`:

```json
"protocols": { "atproto": "required", "data": "optional" }
```

- A host that lacks a `required` protocol can decline to run the tile before loading it, rather
  than the tile failing partway through. An `optional` one is imported in a `try`, as the spec's
  pattern already does.
- In Peek, the field sits beside `capabilities`. `capabilities` keeps carrying configuration
  (`network.domains`, `datastore.tables`); `protocols` names what the tile imports. A protocol
  listed without its capability being granted is served as absent.
- The same field is proposed for the MASL manifest, since Web Tiles otherwise gives a host no way
  to tell up front whether it can run a tile. Peek uses it in its own manifest whether or not the
  proposal is taken up.

## Events from host to tile

APIs that push from the host to the tile split three ways by kind:

- **Lifecycle** (`onVisible`, `onShutdown`) maps onto standard web events, `visibilitychange` and
  `pagehide`. They work in any host and need neither a protocol nor a queue. Before relying on
  them, a test confirms Electron fires them when Peek hides, shows and closes a tile's window.
- **Data events** (`pubsub` deliveries, settings changes) become handlers on a protocol module, in
  the style of `data.js` `addDataHandler()`.
- **Peek-only hooks** (`onNavigateDeferred`, `escape`) become protocols like any other and are
  absent in other hosts.

A protocol is loaded with a dynamic `import`, so a tile's handlers attach only after an `await`.
A lazy tile that attaches them late misses the event that woke it (the init-ordering rule in
`apps/desktop/CLAUDE.md`, "Lazy feature activation"). So every protocol that pushes events holds
them per tile until the tile signals ready, as `data.js` `listen()` does with
`tiles-protocol-up-data-ready`, and then delivers the queue in order. The queue belongs to the
host-side protocol registration, not to each protocol, so no protocol can omit it.

## Core surfaces

The cmd panel, page host and its overlay, HUD, settings and the background orchestrator are
built-in tiles that are never published, installed or removed on their own. They ship with Peek,
cannot be uninstalled, and keep privileges no published tile gets (`trustedBuiltin`, `api.invoke`
and the other calls reserved for them). Protocols exist so tiles can move between hosts, which
these never do, so they stay on `window.app` and nothing in this design requires moving them.
They may still import a protocol where that is simpler than the `window.app` equivalent.

## Runtime constraints

- **Serving a module is not the security gate.** A protocol module is page JavaScript, and the
  only way page JavaScript reaches the main process is through what `tile-preload.cts` exposes. So
  every protocol module calls one generic bridge in the preload, and any tile can call that bridge
  directly whatever modules it was served. The main process checks the tile's token and
  capability on every call, as `tile-ipc.ts` does today; leaving a module unserved only gives
  tiles a clean "not available". The call-time check also covers a grant revoked while the tile
  runs.
- **Two meanings of ready.** The preload sends `tile:lifecycle:ready` on the tick after it loads
  (`tile-preload.cts api.initialize()`), and `main/tile-lazy.ts` delivers the event that woke a
  lazy tile once that arrives. That is before any protocol `import` resolves. The per-protocol
  queue in "Events from host to tile" is what makes this safe: the wake event waits for the
  protocol's own ready signal rather than the preload's.
- **A refused import sticks.** A module that failed to load stays failed in that page, so a
  capability approved while a tile is open takes effect only when the tile reloads.
- **Tests that reach into `window.app`.** Eleven test files under `apps/desktop/tests` evaluate
  `window.app.*` in a page, and they move with their namespace. The move also removes a testing
  limit: `window.app` is frozen by the context bridge and cannot be stubbed from a spec, while a
  protocol module is ordinary page code that a spec can replace. That is why the publish wizard in
  `features-manager/publish.js` has no spec today.
- **Values that are synchronous today** (`api.version`, `api.platform`, `api.getTileId()`)
  become available only after an `await`, so code that reads them at the top level of a module
  reorders.
- **Core surfaces stay on `window.app`.** See "Core surfaces" below.
- **Startup cost.** Each protocol a tile imports is one more `peek://` request and module
  evaluation when its window opens. Unmeasured; it matters most for lazy tiles opened by a
  hotkey, which already feel slow (Peek `9e6e91de`).

## Open questions
- **Serving path.** A tile loaded from its own host, `peek://<tile-id>/`, resolves
  `/.well-known/web-tiles/<name>.js` to `peek://<tile-id>/.well-known/web-tiles/<name>.js`, so
  `main/protocol.ts handleProtocolRequest()` knows which tile is asking from the host alone and
  can gate by that tile's grant. It currently looks for the file in the tile's own directory. A
  page loaded through the older `peek://ext/<id>/` form would resolve to
  `peek://ext/.well-known/...` instead, with no tile id in it; such pages move to their own host
  before they can use protocols.
- **Message source checks.** `@dasl/tile-server` `shuttle.js` relays `tiles-protocol-*` messages
  without checking the sender, and `data.js` posts to its parent with target origin `'*'`. When
  Peek hosts Web Tiles it checks the sender of every message itself.
