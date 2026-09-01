# Peek workers — features that run without a machine

A **worker** is a Peek feature that runs on remote compute instead of inside the Electron app:
no window, no display, no user present, no local `datastore.sqlite`. It fetches, polls, waits,
and writes; an agent can call its commands and read the results. The point is the work that a
sleeping laptop stalls — a feed that should have been polled at 3am, an API that should have
been checked hourly, a task queue an agent wants to reach when no desktop is running.

This is a design document. Nothing here is built. It describes what a worker is, what it can and
cannot do, which existing pieces it reuses, and which pieces do not exist yet.

## Contents

1. [What already exists, and what a worker actually changes](#1-what-already-exists-and-what-a-worker-actually-changes)
2. [What a worker is](#2-what-a-worker-is)
3. [The manifest](#3-the-manifest)
4. [Lifecycle](#4-lifecycle)
5. [The API surface a worker gets, and what it loses](#5-the-api-surface-a-worker-gets-and-what-it-loses)
6. [How a worker reaches Peek data](#6-how-a-worker-reaches-peek-data)
7. [How a worker's writes get back to devices](#7-how-a-workers-writes-get-back-to-devices)
8. [How an agent addresses and invokes a worker](#8-how-an-agent-addresses-and-invokes-a-worker)
9. [What the runtime has to provide](#9-what-the-runtime-has-to-provide)
10. [Runtime evaluation](#10-runtime-evaluation)
11. [Recommendation](#11-recommendation)
12. [Deliberately out of scope](#12-deliberately-out-of-scope)
13. [Open questions](#13-open-questions)

---

## 1. What already exists, and what a worker actually changes

The load-bearing observation is that a feature never touches Electron directly. It touches
`window.app`, and every method on `window.app` is a message.

`apps/desktop/main/tile-preload.cts` `buildAPI()` builds that object and exposes it through
`contextBridge.exposeInMainWorld('app', api)`. Every capability method on it is one line of the
same shape: an `ipcRenderer.send` or `ipcRenderer.invoke` on a channel named
`tile:<domain>:<verb>`, carrying an opaque capability token minted for that tile. More than
thirty domains exist today — `tile:datastore:*`, `tile:pubsub:*`, `tile:network:*`,
`tile:window:*`, `tile:commands:*`, `tile:settings:*`, and the rest.

On the other side, `apps/desktop/main/tile-ipc-gate.ts` `registerTileIpc()` / `runPipeline()` is
the single chokepoint every one of those frames passes through: it checks that the channel is
registered, that the sending renderer is the one the token was bound to, that the payload
matches a schema, that the manifest granted the capability the channel requires, that the tile's
lifecycle state permits the call, and that the sender's role is allowed on the channel. Handlers
then live in `apps/desktop/main/tile-ipc.ts` with per-operation enforcement in the
`tile-*-enforcement.ts` modules.

That is a capability-scoped RPC protocol. Electron supplies the transport and nothing else.

So a worker runtime does not reimplement Peek. It reimplements **one transport and one host**:

- the transport under `window.app` — instead of `ipcRenderer` to a local main process, a client
  to the remote Peek backend;
- the host that loads the feature module and runs it — instead of a `BrowserWindow` navigating
  to `peek://<id>/background.html`, a plain JS runtime importing `background.js`.

Everything else is already transport-agnostic in shape: the manifest schema
(`apps/desktop/main/tile-manifest.ts` `TileManifest`, `validateTileManifest()`), the capability
grant (`resolveCapabilities()` → `CapabilityGrant`), the command dispatch protocol (pubsub topic
`cmd:execute:<name>`), and the ready/shutdown lifecycle (`apps/desktop/main/tile-lifecycle.ts`
over the FSM in `tile-fsm.ts`).

What does **not** exist today, and is the honest size of this project:

- **No feature has ever run outside a Chromium renderer.** Every tile, including every one whose
  manifest calls it `background`, is a full `BrowserWindow` created by
  `apps/desktop/main/tile-launcher.ts` `createTileBrowserWindow()` — hidden (`show: false`),
  sandboxed, but a renderer. There is no `utilityProcess`, no `worker_threads`, no child-process
  path in `apps/desktop/main/`. "Lazy" defers *when* the window is created, never *whether*
  (`apps/desktop/main/tile-lazy.ts` `loadLazyTile()` calls the same `launchTile()`).
- **`apps/desktop/main/headless-policy.ts` is not prior art.** It sets the macOS activation
  policy so test runs do not steal focus. A full UI is running. It shares a word and nothing
  else, and this document avoids the word for that reason.
- **Nothing has been designed for this before.** The idea is old: `notes/design-vision.md` wants
  "a decentralized compute option for running your scripts outside of your clients and syncing
  the data" and has a one-line `## Cloud Vision` section; `archive/peek-todo.md` and
  `archive/TODO.md` carry "agent mode: explore running application logic in a headless node"
  under "Server Backend". Neither was ever expanded. `notes/extensibility.md`, which is the
  closest thing to a prior extension-architecture document, does not mention remote or
  server-side execution at all. So there is nothing here to contradict, and equally nothing to
  build on.
- **The remote backend has never been proven end to end.** `handoff-mcp.md` records phase 1 of
  `docs/mcp-remote-backend-design.md` as landed on `main` with the two halves never having
  talked over a real socket — every test stubs one side. Everything in §6 below leans on that
  seam, so its first real exercise is a prerequisite, not a detail.

---

## 2. What a worker is

A worker is a feature whose manifest declares a `worker` entry point instead of (or alongside)
its tiles, and whose granted capabilities are the subset that means anything with no display.

Concretely, from a feature author's point of view:

| | Desktop feature | Worker |
|---|---|---|
| Entry point | `tiles: [{ id: "background", url: "background.html" }]` | `worker: { url: "background.js" }` |
| Host | hidden `BrowserWindow`, `tile-preload.cts` injects `window.app` | JS runtime, host module injects `globalThis.app` |
| Transport under the API | `ipcRenderer` → `tile-ipc.ts` | HTTPS/WebSocket → `apps/server` |
| Data | local `datastore.sqlite` via `tile:datastore:*` | `/mcp/*` on `apps/server` (§6) |
| Capability enforcement | `tile-ipc-gate.ts` `runPipeline()` | server-side, bound to the grant credential |
| Invoked by | command palette, shortcut, pubsub | agent, schedule, pubsub (§8) |
| Lives as long as | the app session | the schedule, or a wake (§4) |

The `feeds` feature is the honest test case, and it is close. `apps/desktop/features/feeds/`
declares `network`, `datastore` (`items`, `item_events`), `pubsub` and `commands`; its
`background.js` polls on a `setInterval`, `fetch`es each feed, and writes entries with
`api.datastore.addItemEvent()`. Four things stop it being portable as written, and sorting them
by who pays is most of §9:

1. It calls `DOMParser` to parse the feed XML. That is a browser API, not a JS-language one, and
   §10 finds it absent from every candidate runtime — so this one the feature pays, by bundling
   an XML parser.
2. It imports `peek://cmd/nouns.js` — a cross-feature ES module over the `peek://` scheme.
3. It calls `api.shortcuts.register('Option+Shift+F', …)` and `api.window.open(…)`. Both are
   meaningless with no display (§5).
4. It calls bare `fetch(url)`, not `api.network.fetch(url)` — so its declared
   `network: { domains: ["*"] }` capability is decorative in the current host, because the
   renderer's own `fetch` is gated by the `background.html` CSP rather than by the manifest.
   A worker host that wants the manifest to mean anything must intercept the global.

---

## 3. The manifest

**Decision: extend the existing manifest, do not invent a second one.**
`apps/desktop/main/tile-manifest.ts` already validates a v3 manifest — `validateTileManifest()`,
`parseManifestFile()`, `resolveCapabilities()` — with limits (`MAX_TILES_PER_MANIFEST`,
`MAX_NETWORK_DOMAINS`, `MAX_DATASTORE_TABLES`), privileged capabilities
(`PRIVILEGED_CAPABILITIES` = `filesystem`) and builtin-only ones (`BUILTIN_ONLY_CAPABILITIES` =
`sync`). A worker manifest is that manifest with one new top-level key:

```json
{
  "manifestVersion": 3,
  "id": "feeds",
  "worker": {
    "url": "worker.js",
    "schedule": "every 15m",
    "wake": ["item:created"]
  },
  "capabilities": {
    "datastore": { "tables": ["items", "item_events"] },
    "network": { "domains": ["*"] },
    "pubsub": { "scopes": ["global"], "topics": ["item:created", "feeds:*"] },
    "commands": true
  },
  "commands": [
    { "name": "refresh feeds", "description": "Refresh all feeds",
      "action": { "type": "execute" } }
  ]
}
```

- `worker.url` is a **JavaScript module**, not an HTML file. `background.html` exists in the
  desktop model only because a `BrowserWindow` needs a document to navigate to; it does nothing
  but `import extension from './background.js'`, `await api.initialize()`, call `init()`, and
  register `api.onShutdown()`. A worker host does those four things itself.
- `worker.schedule` and `worker.wake` are the two ways a worker starts (§4). At least one is
  required; a worker with neither can never run.
- `capabilities` is unchanged in shape and meaning. The set that is *grantable* to a worker is
  smaller (§5), and enforcement moves from `tile-ipc-gate.ts` to the server (§6), but an author
  writes the same block.
- `tiles` and `worker` may both appear. That is the intended migration path for `feeds`: keep
  the reader window on the desktop, move the polling to a worker, and let the manifest describe
  one feature with two places it runs.

One thing the current schema would have to give up for workers: `TileCommand.action.type` has
three values (`'window' | 'publish' | 'execute'`). `'window'` is meaningless in a worker and
must be rejected at validation time rather than failing at dispatch.

---

## 4. Lifecycle

The desktop lifecycle is an explicit FSM — `apps/desktop/main/tile-fsm.ts` holds the transition
table, `tile-lifecycle.ts` drives it, and `tile-ipc-gate.ts` refuses calls made in the wrong
state. A worker keeps the same states and the same rule that capability calls are only legal in
`READY`; what changes is who supplies the triggers.

| Desktop | Worker |
|---|---|
| `REGISTERED` — in `registry.json`, no window | installed, no instance running |
| `LOADING` — `launchTile()` created the window, `loadURL` in flight | runtime cold-started, module imported, `init()` not returned |
| `READY` — renderer sent `tile:lifecycle:ready` | host resolved `init()` |
| shutdown — `shutdownTile()` sends `tile:lifecycle:shutdown`, waits `TILE_SHUTDOWN_GRACE_MS` (500ms) for the `api.onShutdown()` callback, then closes the window | host calls the registered shutdown callback, waits the same grace, then lets the instance exit |

**Three ways a worker instance starts:**

- **Scheduled** — `worker.schedule`. The runtime wakes the worker, `init()` runs, the work
  happens, the instance goes away. This is the common case and the one that pays for the whole
  design.
- **Woken by an event** — `worker.wake` lists pubsub topics. This is the same idea as
  `TileEntry.lazyEvents` and `apps/desktop/main/tile-lazy.ts` `installLoadOnDispatchHook()`,
  which intercepts a publish, boots the tile, waits for ready, then lets the publish continue.
- **Called by an agent** — a `cmd:execute:<name>` for a command the worker declares. Identical
  mechanism to the wake case; `tile-lazy.ts` already treats command dispatch and event wake as
  one hook.

**The consequence authors must be told about: a worker is not a process that stays up.** The
desktop model quietly guarantees that `init()` runs once and module-level state survives for the
session, which is why `feeds` can hold `pollTimer` in a module variable and `timers` can hold
live countdowns in memory. A worker that cold-starts per invocation loses all of that.

**Decision: workers are stateless between invocations, and any state that must survive lives in
the Peek store.** Not because long-lived instances are impossible on every candidate runtime,
but because assuming them makes a worker unportable between runtimes (§9) and because Peek
already has exactly one correct place to put durable state. `feeds` illustrates that this is
cheap: its poll cursor is already `metadata.lastPolledAt` on the feed item, and `pollTimer` is
the only thing it holds in memory — which a schedule replaces outright.

The rule this implies, and which a worker linter should enforce: **`setInterval` is not the way a
worker repeats.** `worker.schedule` is. A `setInterval` in a worker either does nothing (the
instance is torn down before it fires) or silently pins an instance that should have exited.

---

## 5. The API surface a worker gets, and what it loses

`window.app` has around forty namespaces. Sorting them by whether they mean anything with no
display, no local disk and no user:

**Granted.** These are the worker surface:

| Namespace | Notes |
|---|---|
| `api.datastore` | The subset backed by `/mcp/*` — see §6. Not the full ~50 methods. |
| `api.network` | `fetch`, gated on `capabilities.network.domains`. |
| `api.pubsub` / `api.publish` / `api.subscribe` | Over a duplex channel to the backend (§8). `SELF` scope is meaningless and collapses to a no-op. |
| `api.commands` | `register` / `unregister`. This is how an agent calls in (§8). |
| `api.settings` | Feature settings; already a store read. |
| `api.log` | Goes to the runtime's log sink, not a renderer console. |
| `api.initialize` / `api.onShutdown` | Kept, and supplied by the host rather than the manifest's HTML. |

**Absent.** `api.window`, `api.shortcuts`, `api.izui`, `api.escape`, `api.theme`,
`api.darkMode`, `api.screen`, `api.dialogs`, `api.nav`, `api.modes`, `api.context`,
`api.adblocker`, `api.chromeExtensions`, `api.session`, `api.filesystem`, `api.shell`,
`api.quit` / `api.restart`, `api.app`, `api.backup`, `api.profiles`, `api.features`, `api.mcp`,
`api.sync`.

**Decision: absent namespaces are absent, not stubbed.** `typeof api.window === 'undefined'`.

The alternative — a stub that resolves `{ success: false, error: 'no display' }` — is worse for
the same reason `docs/mcp-remote-backend-design.md` §7.1 refuses a stale cache: a feature that
gets a plausible negative answer keeps going and does the wrong thing, while a feature that gets
a `TypeError` on the first call fails at the point of the mistake. It also makes the failure
visible to static analysis: a worker linter can flag `api.window.` in a module the manifest
declares as a worker entry point, before it is ever deployed.

The two that will actually be missed, and the answer for each:

- **`api.window.open`** — a worker cannot open a window, but it can ask a desktop to. Publishing
  a topic the desktop's copy of the feature subscribes to is the honest shape, and it already
  works: `TileCommand.action.type: 'publish'` exists, and `tile-lazy.ts` `handleCommandDispatch()`
  short-circuits `'window'`-type commands into `window:reopen-request`. A worker that wants a
  window publishes and moves on; whether a desktop is listening is not its problem.
- **`api.shortcuts.register`** — no answer, and none is needed. A global hotkey is a property of
  a machine with a keyboard. The manifest's `shortcuts` block stays valid and is simply not
  granted to the worker half of a feature.

`api.filesystem` deserves a separate note: it is the one capability already in
`PRIVILEGED_CAPABILITIES` in `tile-manifest.ts`, requiring explicit user approval. Denying it to
workers outright is the conservative call — a worker's filesystem is a scratch disk on a machine
the user does not own, so a feature reading `~/Documents` on the desktop and something unrelated
on a worker is a trap, not a feature.

---

## 6. How a worker reaches Peek data

**Decision: a worker's `api.datastore` is `remote-store.js` against the `/mcp/*` API on
`apps/server`, authenticated with an `mcp_grants` credential. Not MCP, and not a third path.**

The pieces exist. `apps/desktop/features/mcp-server/store/index.js` `openStore()` selects an
implementation from config: `sqlite-store.js` against a local `datastore.sqlite`, or
`remote-store.js` when a remote URL is set. `remote-store.js` is an HTTP client against
`apps/server`'s `/mcp/*` routes, holds no local state, and — per its own header comment — has no
cache, no read-through and no write queue, so an unreachable server is a thrown error naming the
server rather than an empty result. The routes it calls are registered in `apps/server/index.js`
with business logic in `apps/server/mcp-items.js`: `GET /mcp/items`, `/mcp/items/search`,
`/mcp/items/resolve`, `/mcp/items/:idOrPrefix`, `/mcp/session`, `/mcp/tags`, `/mcp/whoami`, and
the writes `POST /mcp/items`, `PATCH`/`DELETE /mcp/items/:id`, `POST /mcp/items/:id/tags`,
`DELETE /mcp/items/:id/tags/:name`, `POST /mcp/items/:id/events`,
`POST /mcp/tasks/:id/complete`.

**Why this and not remote MCP.** MCP is a protocol for an *agent* to talk to a *tool provider*.
A worker is not an agent; it is application code that needs a store. Wrapping its every read in
JSON-RPC tool calls adds a protocol layer, a session, and a tool-schema round trip to something
that already has a typed store interface (`store/types.js` `PeekStore`) with an HTTP
implementation already written against it. `docs/mcp-remote-backend-design.md` §1 makes exactly
this argument for exactly this reason — phase A "removes the requirement" of a local install for
"a scheduled agent and a cloud session", and only "the phone case genuinely needs" MCP over HTTP,
because a phone cannot spawn a child process. A worker is the scheduled-agent case, not the
phone case.

MCP remains the right answer for the *other* direction — an agent calling *into* a worker (§8).

**What this choice costs, stated plainly:**

- **A worker's datastore is a subset.** `api.datastore` in `tile-preload.cts` exposes roughly
  fifty methods — addresses, visits, content, tags, item visits, frecency queries, generic
  `getRow`/`setRow`/`getTable`. `PeekStore` in `store/types.js` has seventeen, two of which are
  `describe()` and `close()` — so fifteen actual store operations. Everything outside those
  fifteen either does not exist remotely or would have to be added to `/mcp/*` first.
  **This is the largest single gap in the design.** In particular `getRow` / `setRow` /
  `getTable` — the generic table access `docs/api.md` documents and several features use — has
  no `/mcp/*` equivalent, so a feature that keeps state in a custom table cannot be a worker
  without one being added.
- **Item events are the sharpest edge of that subset, and `feeds` falls off it.** Measured by
  `tools/feeds-worker-spike/run.mjs`. The tile API has `addItemEvent`, `getItemEvent`,
  `queryItemEvents`, `deleteItemEvent` and `deleteItemEvents`; `/mcp/*` has one write route and no
  read route. `POST /mcp/items/:id/events` reaches `recordEvent()` in `apps/server/mcp-items.js`,
  which puts the event's type name in the row's `content` column, hardcodes `value` to 0 and
  stamps `occurredAt` with the server's clock — so a feed entry's link, publication time and
  metadata have to travel as one JSON string in `metadata.notes`, and the row's own `occurredAt`
  is the write time rather than the publication time. Reading them back is only possible by
  fetching the parent item with `?events=N`, one request per item, and `fetchEvents()` caps the
  result at 20 however many are asked for. `pollFeed()` in `apps/desktop/features/feeds/background.js`
  deduplicates by reading its last 100 entries and skipping guids it already has; against this API
  it sees 20. Confirmed against the deployed server with a 25-entry feed: the first poll writes
  25, and **every poll after it writes the 5 it cannot see, indefinitely**.

  Cleanup is worse than absent. There is no route that deletes an item event, so
  `unsubscribeFeed()` throws before it reaches the feed item — and `deleteItem()` in
  `apps/server/db.js` is a soft delete that sets `deletedAt` on the item and never touches
  `item_events`, so the rows survive the item that owned them with no way to reach them again
  through this API. A worker polling on a schedule therefore grows the table without bound and
  cannot clean up after itself.

  **A worker that touches item events needs `/mcp/*` routes that do not exist yet** — at minimum a
  paged event read, a create that preserves `content` and `occurredAt`, and a delete. Unlike the
  generic-table gap, this one is hit by a bundled feature that already ships.
- **`api.network` and `api.datastore` diverge in where they are enforced.** On the desktop both
  are checked by `tile-ipc-gate.ts` against the manifest grant. For a worker, datastore scope
  and the readonly bit are properties of the *credential*, enforced server-side — that is the
  decision in `docs/mcp-remote-backend-design.md` §4.1, and §4.2 explains why a client-side
  check is not sufficient. Network domains have no server in the path at all and can only be
  enforced by the worker host intercepting `fetch`.
- **Item ids are server ids.** `apps/server/db.js` `saveItem()` mints its own id and stores the
  desktop's in `syncId`. A worker sees server ids; the desktop UI shows local ones. The
  `peek-mcp-init` skill template already carries this warning for remote MCP sessions and a
  worker author needs the same one.
- **Some fields are local-only.** `favicon`, `visitCount` and `lastVisitAt` are named as staying
  local in `docs/mcp-remote-backend-design.md` §9; `docs/sync-coverage-gaps.md` is the standing
  inventory. A worker cannot read or write them.
- **Images are refused.** `create_item` with `type: 'image'` against the remote store is an
  explicit error (§9 of the same document). A worker cannot produce image items.
- **The store itself is proven; the worker path over it is not.** `tools/socket-proof.mjs`,
  `tools/socket-proof-ambiguous.mjs` and `tools/socket-proof-scaffolded.mjs` drive
  `remote-store.js` against a deployed `apps/server` over a real socket, so credential
  resolution, header shape and error mapping are no longer open. What has not been exercised is a
  *feature* on top of that store — the seam this section's other bullets describe — and
  `tools/feeds-worker-spike/run.mjs` is the harness for it.

**Credential.** The same `mcp_grants` bearer token, minted by `POST /admin/mcp-grants` and
resolved by hash, carrying one `scopeTag`, one `readonly` bit and one `profile_id`. A worker gets
its own grant — never a device credential, never a shared one — so it is revocable individually
and its blast radius is its scope tag. The unexpanded-`${VAR}` guard `remote-store.js` already
implements matters more for a worker than for a local child process, because a worker's
environment is configured once in a deploy and never seen by a human again.

**That credential is not adequate as it stands, and its replacement has its own document.**
`scopeTag` plus `readonly` plus `profileId` is the whole authorization vocabulary on `/mcp/*`,
while the same feature running on the desktop is checked per call against the tables, topics and
domains its manifest declared. A worker would therefore hold a *less* bounded credential on rented
compute than it holds on the user's own machine. `docs/workers-capabilities.md` works out what it
should hold instead — what makes the reference unforgeable, how the manifest's declaration becomes
the attenuation, how delegation and revocation work, and what has to change in `remote-store.js`,
`PeekStore` and `apps/server` for "the credential is the authority" to be true rather than
aspirational. Its conclusion is a narrower grant record rather than a signed token scheme, and it
gives the reasoning.

---

## 7. How a worker's writes get back to devices

This has a short answer, and the short answer is the reason §6 chose the store it did.

`docs/sync.md`: "The server acts as the source of truth. All clients push and pull data via the
server's REST API." A worker writes through `/mcp/*` into the same per-user, per-profile
database the desktop syncs against. `apps/desktop/main/sync.ts` `pullFromServer()` →
`mergeServerItem()` finds no local row with that `syncId` and inserts one — so the item appears
on the laptop at the next sync with no new machinery.

The failure modes are inherited, not new, and all three are already written down:

- **The tag race.** `docs/mcp-remote-backend-design.md` §7.2: `apps/server/db.js` `saveItem()`
  deletes and re-inserts an item's whole tag set on the `syncId`-matched push path, so a tag
  added remotely in the window between one sync's pull and its push is dropped. `syncAll()`
  pulls before it pushes, which covers the common case; the remaining window is accepted and
  narrowed rather than fixed. A worker that tags things — which is most of what a useful worker
  does — sits directly in that window, and does so unattended, so it hits it more often than a
  human at an MCP session would. This is the one inherited risk that a worker meaningfully
  worsens.
- **Push failures are not retried.** `docs/sync.md` "Known Limitations": a failed push is logged,
  but `lastSyncTime` still advances, so the item is not picked up next cycle. This is a desktop
  bug, not a worker one, but a worker makes it likelier to matter because it increases the volume
  of server-side writes a desktop must reconcile.
- **Local-only fields.** `docs/sync-coverage-gaps.md` is the inventory. Nothing in this design
  changes a `"sync": false` decision.

**What a worker must not do: write to a local store.** There is no local store. This is stated
because the failure it prevents is silent — a worker that keeps a poll cursor in a runtime-local
KV instead of on the item is correct until the runtime reschedules it elsewhere, and then it
re-fetches everything or nothing.

---

## 8. How an agent addresses and invokes a worker

Three things an agent wants: find out what workers exist, call one, get the result.

**Invocation reuses the protocol the command palette already uses.** A command is not a
main-process callback registry — `api.commands.register()` in `tile-preload.cts` subscribes the
tile to the pubsub topic `cmd:execute:<name>`, and when a message arrives with
`{ expectResult: true, resultTopic: '<topic>' }` it runs the handler and publishes the return
value (or `{ error }`) to `resultTopic`. That is already a request/response protocol over a
message bus, with a correlation id in all but name.

So a worker invocation is: publish `cmd:execute:<name>` with the parameters and a `resultTopic`,
wait for the reply. The runtime's job is to deliver that publish to a worker instance, cold-starting
one if none is live — which is exactly what `tile-lazy.ts` `installLoadOnDispatchHook()` does
locally today.

**The agent-facing surface is MCP, and this is where MCP belongs.** An agent should not learn a
Peek-specific pubsub protocol. `docs/mcp-remote-backend-design.md` §1 already names phase 2:
`POST /mcp/rpc` on `apps/server`, JSON-RPC over streamable HTTP, grant token as bearer, consumed
natively by Claude Code as `{"type": "http", "url": …, "headers": {"Authorization": …}}` with no
local process. A worker's commands become tools on that endpoint:

- `list_workers` → the installed workers in the grant's scope and their declared commands, from
  the same manifest `commands` block the palette reads.
- `call_worker(worker, command, params)` → publish `cmd:execute:<command>`, wait on the
  `resultTopic`, return the result.

This is additive to phase 2 rather than a separate server. It also means the grant credential
does double duty: the same token that scopes what data a worker can touch scopes which workers an
agent can call.

**Addressing.** A worker is addressed as `<feature id>` within a grant's scope — not a URL, not a
runtime-assigned instance id. The instance is the runtime's business; two invocations may or may
not hit the same one, and per §4 nothing may depend on which.

**What this does not solve, and should not pretend to:** a long-running worker call. An agent's
tool call has a timeout; a worker that polls forty feeds does not fit inside one. The shape that
works is the one Peek already has — the command returns immediately, the work publishes progress,
and the results are items the agent reads back through the store. A `call_worker` that blocks for
four minutes is a design error, not a runtime limitation.

---

## 9. What the runtime has to provide

Derived from §2–§8, and from what real features do. Not a feature table — the things whose
absence makes a worker either impossible or unportable.

**Hard requirements.**

1. **ES modules, with a resolver for cross-feature imports.** `feeds/background.js` opens with
   `import { registerNoun } from 'peek://cmd/nouns.js'`. Bundling at install time is the obvious
   answer and turns this into a build-step requirement rather than a runtime one — but it has to
   be decided, because "just run the file" does not work for a real feature.
2. **`fetch`, interceptable.** Outbound HTTP is most of the point. It must also be replaceable by
   the host, or `capabilities.network.domains` means nothing (§2).
3. **A scheduler the runtime owns.** `worker.schedule` has to be honoured by something durable —
   not a `setInterval` inside the instance, which per §4 is the thing workers give up.
4. **A duplex channel to the backend.** Pubsub is not request/response: a worker both publishes
   and subscribes, and `cmd:execute:<name>` arrives unsolicited. Long-poll, SSE or WebSocket —
   the shape matters, the mechanism does not.
5. **Cold start fast enough to sit under an agent's tool call.** §8's `call_worker` boots an
   instance if none is live. Sub-second is fine; ten seconds is not.
6. **Secret storage for the grant credential** that is not the feature bundle.

**Soft requirements — wanted, not required.**

7. **Some browser-shaped globals.** `DOMParser` in `feeds` is the concrete case, and it is
   instructive that *none* of the runtimes in §10 has it — it is not in the Workers API surface
   and it is not a Node API either. So this is a tax the feature pays, not the runtime: `feeds`
   as a worker bundles an XML parser. Enumerating the rest is a survey nobody has done, and the
   real answer is a compatibility list produced by trying to port the six features whose
   manifests declare `network` — `entities`, `features-manager`, `feeds`, `lex`, `websearch`,
   `wonderwall` — since those are the ones that were already reaching outward.
8. **Concurrency control per worker.** Two instances of a polling worker racing produce duplicate
   items. Peek's `syncId` dedup absorbs some of this; a runtime that can guarantee one instance
   per worker removes the question.

**Explicit non-requirements**, and each one is a deliberate narrowing that widens the runtime
field:

- **No persistent local storage.** State lives in the Peek store (§4, §7).
- **No filesystem.** Not granted (§5).
- **No inbound HTTP listener.** Workers are reached through the backend, not addressed directly
  (§8). A worker with a public URL is an attack surface with no compensating benefit.
- **No long-lived process.** Assumed absent so that a runtime which cannot provide one is not
  excluded.

---

## 10. Runtime evaluation

Three candidates, judged against §9 rather than against each other's feature lists.

**Sourcing.** Every platform claim below was fetched on 2026-08-18 and carries its URL. Where a
page states a "last updated" date it is given, because these numbers move. Anything that could
not be found on a fetched page is marked **not published** rather than guessed. No claim here
comes from recall.

### 10.1 celld

Sources: `https://celld.dev/`, `/docs`, `/docs/cloudflare-compat`, `/docs/limitations`,
`/docs/security`, all fetched 2026-08-18. No page carried a date. Repository:
`https://github.com/denoland/celld`, Apache-2.0.

What it is, in its own words: "self-hosted, distributed Durable Objects." From `/docs`: "celld
is a stateful distributed system. It runs server-side JavaScript on your machines. It keeps all
shared data in an S3-compatible or Google Cloud Storage bucket that you own. **The JavaScript
API is the same API that Cloudflare Workers and Durable Objects supply.**" The unit is a "cell"
— "a small server with a name and a private SQLite database" — one V8 isolate per cell, one
thread per cell, so "two requests to the same cell never run at the same instant."

Against §9: ES modules yes (deploys via `celld deploy`, using esbuild for Worker code). Outbound
network yes — a cell "serves HTTP, holds WebSocket connections, sets alarms, and makes outbound
connections"; no numeric outbound limit is **not published**. Scheduler: durable alarms, the
Cloudflare `setAlarm()`/`alarm()` API. **No cron** — `/docs/cloudflare-compat` puts "cron
triggers" under "Not planned" ("platform surface; celld has its own durable alarms") and states
"No scheduled (cron), queue, tail, or email handlers." Duplex channel: WebSockets, with a caveat
from `/docs/limitations` that matters here — "An outbound Durable Object WebSocket keeps its
cell resident, and the connection does not continue when the cell moves to a different node."
Cold start: the landing page self-reports "Wake a hibernated cell: ~4 ms" and "Durable write
latency (region-local): ~90 ms"; these are the vendor's own benchmarks, not guarantees.
Persistent state: per-cell SQLite replicated to the operator's bucket. R2 and KV are "not
planned"; D1 is "planned."

Maturity is the problem, and the site is candid about it. `/docs/limitations` opens "The
boundaries of the current alpha:" and lists, verbatim: "A fleet runs one application deployment.
There is no multi-tenant scheduler, no account service, or managed ingress"; "celld requires an
S3-compatible bucket or a Google Cloud Storage bucket, also on a laptop. There is no local
filesystem mode"; "The peer HTTP protocol does not terminate TLS. Run the fleet on a private
network or an encrypted overlay"; "Windows is not available, and Intel Macs get no prebuilt
binaries"; "celld has no central placement controller, so it does not rebalance the fleet when a
node joins"; "Updates are manual." `/docs/security` states "celld is an alpha. It is **not safe
for hostile multi-tenant use**" and "The operator API does not authenticate its requests." An
example release tag of `v0.0.1` is given on the install page; no dated release history was
opened.

One inconsistency worth recording rather than resolving: the landing page claims "Resident cells
/ 8 GB node: 2,500" and "~$0.02" per resident cell-month, while `/docs` says "One 8 GB node
holds 1,000 resident cells, so one resident cell costs approximately $0.05 each month." The site
disagrees with itself by 2.5×. Cost comparisons on the landing page are celld's own marketing
against Cloudflare's list price, not an independent measurement.

### 10.2 Cloudflare Workers and Durable Objects

Sources: `https://developers.cloudflare.com/workers/platform/limits/` (last updated Jul 28,
2026), `/durable-objects/platform/limits/` (Jun 1, 2026), `/durable-objects/api/alarms/`
(Apr 21, 2026), `/durable-objects/api/namespace/`, `/workers/runtime-apis/nodejs/`, fetched
2026-08-18.

Against §9, the numbers that decide things:

- **CPU time.** Workers paid: 5 minutes maximum per HTTP request, 30 seconds by default; free
  10 ms. Cron Triggers on paid: 30 seconds for intervals under an hour, 15 minutes at an hour or
  more. Durable Objects, SQLite-backed: "30 seconds (default) / configurable to 5 minutes of
  active CPU time," with the footnote that matters for §4 — "Each incoming HTTP request or
  WebSocket message resets the remaining available CPU time to 30 seconds… If you consume more
  than 30 seconds of compute between incoming network requests, there is a heightened chance
  that the individual Durable Object is evicted and reset."
- **Wall time.** No limit for an HTTP request while the client is connected; `waitUntil()`
  extends 30s past the response. Cron Trigger, Queue consumer, and **Durable Object alarm
  handler: 15 minutes.** A polling worker is almost all I/O wait, so this is the budget that
  actually binds, and 15 minutes is generous for it.
- **Memory.** 128 MB per isolate, "including the JavaScript heap and WebAssembly allocations…
  per-isolate, not per-invocation."
- **Subrequests.** Free 50 per invocation; paid 10,000. **Simultaneous** outgoing connections
  per request: 6 on both plans, covering `fetch()`, KV, R2, TCP `connect()` and outbound
  WebSockets, counted only while headers are pending. A forty-feed poll is fine serially and
  needs a concurrency cap of six if parallelised.
- **Code size.** 3 MB compressed free, 10 MB paid; startup time limit 1 second. A bundled
  feature is nowhere near either.
- **Alarms.** "Each Durable Object is able to schedule a single alarm at a time by calling
  `setAlarm()`." At-least-once execution, automatically retried when `alarm()` throws,
  "exponential backoff starting at a 2 second delay from the first failure with up to 6 retries
  allowed." Alarms survive eviction: "if the Durable Object wakes up after being inactive, the
  constructor is invoked before the alarm handler," and a handler may "be re-instantiated on
  another machine" and "run from the beginning." **A maximum scheduling distance into the future
  is not published.** The docs draw the distinction this design needs: "A Worker can have up to
  three Cron Triggers configured at once, but it can have an unlimited amount of Durable
  Objects, each of which can have an alarm set."
- **Addressing.** `idFromName(name)` "creates a unique DurableObjectId which refers to an
  individual instance"; `getByName(name)` returns a stub. A stable name is the address, which is
  exactly the addressing model §8 asks for.
- **Storage.** SQLite-backed DO: 10 GB per object; 2 MB max row/string/BLOB; 100 columns per
  table; 100 KB max statement. Soft throughput limit of 1,000 requests per second per object.
- **What runs.** Not arbitrary Node. `nodejs_compat` provides "a subset of Node.js APIs," some
  full implementations, "a few partially supported," with unenv polyfills that raise
  `[unenv] <method> is not implemented yet!` for the gaps.

The relevant repo history: `notes/cloudflare-vs-railway-evaluation.md` (last modified 2026-02-02)
evaluated moving **`apps/server`** to Cloudflare and concluded "Stay on Railway for now, but
architect for future portability," rating the database migration "HIGH" complexity because
`better-sqlite3` is synchronous and file-based and does not map onto `this.ctx.storage.sql`.
`notes/server-portability-plan.md` is the follow-on adapter plan.

**That conclusion does not transfer to workers, and the reason is worth stating so the two
documents do not look contradictory.** It was a verdict about a component whose entire substance
is a SQLite database. A worker holds no database at all — §4 makes it stateless and §6 puts its
state behind an HTTP client. The single named blocker is absent by construction.

### 10.3 A plain container

Taken as Fly.io Machines, as one container-shaped platform with published numbers. Sources:
`https://fly.io/docs/machines/overview/` and `https://fly.io/docs/about/pricing/`, fetched
2026-08-18; neither page showed a date.

"Fly Machines are fast-launching VMs with a simple REST API." Creating one takes "maybe low
double digit seconds" (registry fetch plus root filesystem build); starting an already-created,
stopped Machine "usually takes well under a second." Machines "Stop automatically when a program
exits" and can "Stop or start quickly, either manually or automatically based on traffic" — the
phrase "scale to zero" does not appear, but the behaviour is described. Ephemeral storage by
default, "a blank slate on every startup," with Fly Volumes for persistence at "$0.15/GB per
month of provisioned capacity," charged whether attached or not. Compute is per-second against a
CPU/RAM preset; `shared-cpu-1x` at 256 MB is "$0.0028" per hour, "$2.02" per month. A stopped
Machine still bills its root filesystem at "$0.15" per GB per 30 days.

Against §9 a container clears every hard requirement trivially — arbitrary Node, no CPU cap, any
scheduler, any socket. What it does not supply is the three things it would then have to grow:

- **A scheduler.** `worker.schedule` becomes a cron daemon or an external trigger service that
  someone has to build, monitor, and make durable across restarts.
- **A wake path.** §8's `call_worker` on a stopped Machine pays the start cost, and §4's
  cold-start-per-invocation model means paying it often.
- **Isolation between features.** This is the real one. Peek features are installable from
  atproto (`apps/desktop/main/atproto-source.ts` resolves an `at://` URI to a
  `space.peek.feature.release` record and installs the bundle through `feature-installer.ts`
  `installFromBundle()`). Running two users' third-party feature code in one container is not
  isolation; running one container per feature per user turns a $2/month preset into a bill that
  scales with installs, and reintroduces the cold-start problem at every one of them.

A container is the right answer for a component that is one trusted program with a database.
That is `apps/server`, which is why it is on Railway. It is the wrong shape for many small
untrusted programs that mostly sleep.

### 10.4 Summary

| §9 requirement | celld | Cloudflare Workers + DO | Container (Fly Machines) |
|---|---|---|---|
| ES modules + bundle step | yes (`celld deploy`, esbuild) | yes | yes |
| Outbound `fetch` | yes; limits not published | yes; 6 simultaneous, 10k subrequests paid | yes, unrestricted |
| Durable scheduler | alarms; **no cron** | DO alarms, unlimited objects, at-least-once + retry | must be built |
| Duplex channel | WebSocket; breaks on cell move | WebSocket, incl. hibernation | trivial |
| Cold start | "~4 ms" self-reported | 1s startup ceiling, isolates | "well under a second" from stopped |
| Isolation for untrusted code | **"not safe for hostile multi-tenant use"** | isolate-per-tenant, the platform's premise | not provided |
| `DOMParser` and browser globals | no | no | no |
| Operational maturity | alpha, `v0.0.1`, manual updates, unauthenticated operator API | GA, published limits | GA |
| Ownership | self-hosted, own bucket, Apache-2.0 | vendor, lock-in on DOs | portable |

---

## 11. Recommendation

**Build against the Cloudflare Workers and Durable Objects *API* as the worker runtime contract.
Deploy on Cloudflare first. Keep celld as the self-hosted escape hatch, and say so in writing
now rather than discovering later that the code cannot move.**

The distinction between the API and the vendor is the whole recommendation, and it is available
only because celld exists: "The JavaScript API is the same API that Cloudflare Workers and
Durable Objects supply." Targeting that API is not a bet on one company. It is a bet on one
interface with a GA implementation and an Apache-2.0 self-hosted one, which is a materially
better position than either alone.

Concretely:

- **One Durable Object per installed worker**, addressed by `getByName()` on a name derived from
  the grant and the feature id. That gives §8 its addressing model, §9.8 its
  one-instance-at-a-time guarantee (a DO serialises its own requests), and §4 its lifecycle for
  free.
- **`worker.schedule` compiles to `setAlarm()`, not to a cron trigger.** Cron is capped at three
  per Worker and celld does not implement it at all; DO alarms are per-object, unbounded in
  count, at-least-once with automatic retry, and survive eviction. The at-least-once semantics
  are the reason §4 insists on state living in the Peek store: an alarm handler that may "run
  from the beginning on the other machine" must be safe to run twice.
- **The 15-minute alarm-handler wall-clock budget is the design constraint to publish to worker
  authors**, together with the 30-second-CPU-between-network-requests eviction warning. Both are
  generous for polling and both are hard walls for anything that computes.
- **The duplex channel of §9.4 is a WebSocket from the DO to `apps/server`.** The celld caveat —
  an outbound WebSocket pins a cell and does not survive migration — is survivable precisely
  because §4 already forbids depending on instance continuity: a dropped socket is a
  reconnection, not lost state.

**Not a plain container**, for §10.3's third reason. Isolation between untrusted features is not
a thing to add to a container later; it is the thing an isolate runtime is.

**Not celld first**, for one reason stated in celld's own documentation: "It is not safe for
hostile multi-tenant use," alongside an operator API that "does not authenticate its requests,"
a peer protocol that does not terminate TLS, and manual updates. A worker holds a bearer
credential scoped to a user's entire Peek store. That is not the payload to put on an alpha
whose security page says this. Nothing here says celld is the wrong destination — it is the
right one for `notes/design-vision.md`'s "decentralized compute option for running your scripts
outside of your clients," and it is why the API contract is worth honouring from day one. It is
the wrong *first* deployment.

**What this recommendation is not.** It is not a claim that Peek should move to Cloudflare.
`notes/cloudflare-vs-railway-evaluation.md`'s decision to keep `apps/server` on Railway stands
untouched, and the architecture here depends on it: the worker is a client of `apps/server`
(§6), not a replacement for it. A worker fleet on Cloudflare talking to a Hono server on Railway
is the intended shape, not a transitional one.

---

## 12. Deliberately out of scope

- **Converting any real feature.** This document is the prerequisite for that work, not the start
  of it.
- **A worker marketplace or distribution story.** `apps/desktop/main/atproto-source.ts` already
  fetches a `space.peek.feature.release` record and installs the bundle through
  `feature-installer.ts` `installFromBundle()`, which is source-agnostic. That is the obvious
  path for distributing workers too, and it is a separate design.
- **Multi-user or multi-tenant workers.** One grant, one user, one profile — matching the
  `mcp_grants` model exactly.
- **Running the *desktop* headless.** Different problem, and the naming collision with
  `headless-policy.ts` is reason enough to keep them apart.
- **Changing any `"sync": false` decision** (`docs/sync-coverage-gaps.md`).
- **A worker calling another worker.** Pubsub makes it look free; the failure modes (cycles,
  cold-start storms, unbounded fan-out) are not, and nothing needs it yet.

---

## 13. Open questions

1. **The generic-table gap — answered in the companion document.** `docs/workers-capabilities.md`
   §6 finds the fork was mis-framed: `getRow` / `setRow` / `getTable` reach a *fixed* schema of
   shared tables rather than feature-owned ones (`createTables` in `tile-manifest.ts` is declared
   and never consulted), so the question splits in two. Per-worker private state wants
   `feature_settings`, which is already keyed by feature id and therefore self-confining, ported to
   `apps/server`. Shared tables get individual routes gated on `capabilities.datastore.tables`,
   added on demand. **What is left open** is the schema cost — `apps/server` has five tables
   against the desktop's twenty, and each one a worker needs is a migration plus a sync decision
   plus a row in `docs/sync-coverage-gaps.md`.

2. **Where `capabilities.network.domains` is enforced for a worker.** On the desktop it is
   checked in `tile-ipc.ts`'s `tile:network:fetch` handler against the grant — and `feeds`
   already routes around it by calling the renderer's own `fetch`. A worker host has no
   privileged position unless it replaces the `fetch` global before importing the module.
   `docs/workers-capabilities.md` §3.3 records this as the one capability whose enforcement sits
   irreducibly on the untrusted side. **Settled by:** deciding whether the host shadows `fetch`
   (and whether a feature can get the real one back), or whether network gating for workers moves
   to an egress proxy, or whether it is abandoned and `network` becomes an install-time disclosure
   rather than a runtime gate.

   One input, measured. `installNetworkGuard()` in `tools/feeds-worker-spike/worker-api.mjs`
   replaces `globalThis.fetch` before the feature is imported, checks the hostname against
   `capabilities.network.domains`, and throws on a miss. It is about twenty lines, it logged every
   request `feeds` made, and the feature did not notice. So shadowing works and is cheap. What it
   does not do is *hold*: on Node the feature can reach the network through `node:http` and
   `node:https` without touching `fetch` at all, so the guard is only a boundary if the runtime
   also withholds those modules. Shadowing is a guard-rail against a mistake, not a boundary
   against an author — which is the same conclusion
   `docs/workers-capabilities.md` §3.3 reaches, now with the cost of the guard-rail known.

3. **Who approves a worker install, and what stops a worker exfiltrating.** A desktop feature
   runs on a machine the user controls, behind a capability gate the user consented to at
   install. A worker runs on rented compute holding a credential scoped to the user's store, with
   a `network` capability that can reach anywhere. `notes/extensibility.md` already raised
   "exfiltration-proofing for sensitive access" as unresolved for local extensions; a worker
   sharpens it considerably. `docs/workers-capabilities.md` §2.1 records what a credential design
   does and does not contribute: it can stop a worker exfiltrating its credential, and it cannot
   stop a worker misusing what it legitimately holds.

   **Settled.** Third-party features can be workers. Publisher verification is what makes that
   safe, and it already exists: `apps/desktop/main/atproto-verify.ts` verifies a publisher's
   commit signature against the key active at the commit's `rev` via the PLC audit log, walks the
   MST to the record, and re-hashes every block, with no unverified fallback. Provenance, not the
   credential, is the defence against a hostile author.

   The first version is nonetheless **bundled features only**, in the manner of
   `BUILTIN_ONLY_CAPABILITIES` in `tile-manifest.ts`, with third-party workers layered on after.
   This is a staging decision, not a narrower trust model, and the difference matters for what
   gets built: the server-side capability vocabulary in `docs/workers-capabilities.md` §5.3 is
   **earned**, because third-party workers are the destination. Building it against bundled-only
   workers is paying early for a threat that is accepted, not designing for one that was never
   accepted.

4. **Whether cross-feature imports are bundled or resolved — settled: bundled.** Both were built
   and run. `tools/feeds-worker-spike/peek-hooks.mjs` resolves `peek://` live through
   `module.registerHooks()`, and resolution itself is a non-issue: `peek://cmd/nouns.js` resolved
   to `apps/desktop/renderer/cmd/nouns.js` in about 2ms, and the hook is forty lines.

   What decides it is not cost but binding. `apps/desktop/renderer/cmd/nouns.js` evaluates
   `const api = window.app` once, at its own first import, and holds it for the life of the
   module. Two instances of `feeds/background.js` importing the same specifier get one cached
   module instance, so the second instance's `registerNoun()` calls landed on the *first*
   instance's API object — measured, not inferred: after the second `init()`, the first API object
   held six noun subscriptions and the second held none. A host that runs more than one feature,
   or one feature twice, cannot give them separate API objects while a shared module captures a
   global. Bundling per install gives each deployment its own copy of the graph and removes the
   sharing entirely.

   The staleness that argued for live resolution is real but is the smaller problem, and it has
   an ordinary answer: a `cmd` update reaches deployed workers by rebundling them, which is a
   deploy, which is a thing a fleet already has to do. Live resolution also does not survive
   packaging — `electron-builder.yml` sets `asar: true`, and stock Node cannot read inside
   `app.asar`, so a live resolver would need the unpacked tree or `original-fs`. **The `peek://`
   module graph is a versioned dependency.**

5. **Whether the worker API object is `window.app`-shaped at all — settled: same shape, and §5's
   absent-not-stubbed rule holds.** `feeds/background.js` was imported unmodified and run under
   both answers, in `tools/feeds-worker-spike/run.mjs`.

   The shared code is real. `parseFeed()`, `parseRSS()`, `parseAtom()`, `pollFeed()`,
   `pollAllFeeds()`, `getFeeds()`, `getEntries()`, `subscribeFeed()` all ran untouched against an
   API object that was the desktop shape minus `window` and `shortcuts`. A deliberately different
   object would have bought nothing here and cost the port.

   The split is not between the two halves of the feature, though — it is between the feature's
   *lifecycle* and its *work*. `init()` is the only thing that needs the absent namespaces, and it
   dies at `api.shortcuts.register`, having already registered the noun and the `refresh feeds`
   command and not yet reached its `item:created` subscription or its timer. `uninit()` dies the
   same way at `api.shortcuts.unregister`. Every entry point a scheduled worker actually calls is
   clean. So the port is: keep the object, drop `init()`/`uninit()`, and let the manifest's
   `worker.schedule` name the exported function to run.

   Absent beats stubbed, and the run shows why. With the namespaces stubbed to no-ops `init()`
   returned successfully and installed a 900000ms interval and a 5000ms timeout — a worker
   holding itself alive for fifteen minutes to do nothing, with no error anywhere to say the
   shortcut it registered will never fire. With them absent the failure is a `TypeError` naming
   the namespace, at the line responsible. The cost of absence is that the failure is *partial*:
   `init()` had already half-registered before it threw, and a host that catches and continues
   gets a feature in an undefined state. A worker runtime should treat a throw out of the
   lifecycle as fatal to the instance rather than recoverable.

   `DOMParser` needed a shim and one sufficed: `linkedom`, already a dependency of both the root
   and `apps/desktop`, parsed a real RSS feed and a real Atom feed with no change to
   `parseFeed()`, including the escaped-namespace `dc\:creator` selector and Atom's
   `link[rel="alternate"]` href. The one thing the host must inject beyond the API object is
   `globalThis.window`, because both `background.js` and `nouns.js` read `window.app` at import
   time — §5's `globalThis.app` alone fails on the module's first line.

6. **The tag race at unattended write volume.** `docs/mcp-remote-backend-design.md` §7.2 accepts
   a window in which a remotely-added tag is dropped by a desktop push, on the reasoning that
   `syncAll()` pulls before it pushes and the exposure is small. A worker tagging items on a
   schedule, with nobody watching, samples that window far more often than a human at an MCP
   session does. **Settled by:** measuring it once a worker exists, against the mitigations that
   section already names (stamping `items.updatedAt` on tag routes; set-difference instead of
   delete-and-reinsert on the push path).

7. **Cold-start budget for `call_worker` — the bootstrap is cheap, the poll is not, and the
   reason is the store round trips.** Measured by `tools/feeds-worker-spike/run.mjs` on Linux,
   Node 24.

   Bootstrap is not the problem. Process launch through the feature's module graph being imported
   and ready — Node's own startup, `linkedom`, `remote-store.js`, the `peek://` resolver, and both
   `background.js` and `nouns.js` — is **~145ms** with no server in the path. That is unbundled,
   from source, with a live resolver; a bundle can only be faster.

   The poll is where the budget goes, and it does not sit flat. Measured against the deployed
   `apps/server` over a 25-entry feed with 5 new entries to write: **process launch to first
   completed poll is 955–1208ms over four runs**, of which the poll itself is 522–599ms. A single
   `/mcp/*` request costs ~50–60ms from this box, and the `describe()` at open costs ~200ms.

   That per-request figure is the whole story, because `pollFeed()` issues one `GET /mcp/items`,
   one `GET /mcp/items/:id?events=N`, one `PATCH /mcp/items/:id`, and **one
   `POST /mcp/items/:id/events` per new entry**, serially, in a `for` loop. Five new entries cost
   eight requests. Thirty would cost thirty-three, roughly 1.8 seconds of pure round trip, and the
   count grows with entries and again with the number of feeds subscribed.

   Two consequences for §8. A worker whose work is one write fits inside a tool call comfortably.
   A worker whose work is a fan-out of writes does not, and no amount of runtime tuning changes
   that, because the cost is in the API shape rather than the boot. Either `/mcp/*` grows a batch
   write, or `call_worker` is fire-and-read-back for anything that writes per item — which is most
   of what a scheduled worker does.

   These are one box against one deployment; the shape is the finding, not the milliseconds.

8. **Who operates the fleet.** celld runs "one application deployment" per fleet with the
   operator's own bucket; Cloudflare is an account with a bill. Whether a Peek user brings their
   own compute, or a hosted Peek runs everyone's workers, changes the isolation requirements in
   §10.3 and §11 and the credential model in §6. This design assumes the hosted case because it
   is the stricter one, but the assumption is not settled.

9. **Nothing in §6 has been proven over a real socket.** Restating `handoff-mcp.md` here because
   it is a precondition rather than a caveat: `remote-store.js` and `apps/server`'s `/mcp/*`
   routes have never talked to each other outside tests that stub one side. **Settled by:** the
   end-to-end run that document already names as its first next step — deploy, mint a grant,
   scaffold a project, confirm a scoped session lists and writes items. No worker work should
   start before that passes.
