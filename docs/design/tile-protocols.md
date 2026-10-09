# Tile APIs as Web Tiles protocols

Status: proposal. Nothing here is built.

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

## Open questions

- **Where a tile declares the protocols it uses.** In Peek's manifest only (the `capabilities`
  object already lists most of them), or also as a field proposed to the MASL manifest so any host
  can tell up front whether it can run the tile.
- **Events.** `pubsub`, `onVisible`, `onShutdown` and similar push from host to tile. Whether they
  become handlers on a protocol module (in the style of `addDataHandler`) or stay outside the
  protocol model.
- **Serving path and origin.** Feature tiles load from `peek://ext/<id>/`, so
  `/.well-known/web-tiles/<name>.js` resolves to `peek://ext/.well-known/...`, which
  `main/protocol.ts handleProtocolRequest()` currently treats as a tile named `.well-known` and
  answers 404. All feature tiles also share the `peek://ext` origin, unlike the per-tile origin the
  spec requires for Web Tiles, so step 5 needs its own origin scheme.
- **Message source checks.** `@dasl/tile-server` `shuttle.js` relays `tiles-protocol-*` messages
  without checking the sender, and `data.js` posts to its parent with target origin `'*'`. When
  Peek hosts Web Tiles it checks the sender of every message itself.
- **Trusted built-in surfaces.** `api.invoke` and the other `trustedBuiltin`-only calls serve core
  renderers, not features. Whether they become protocols at all.
