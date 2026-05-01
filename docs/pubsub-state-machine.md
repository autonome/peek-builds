# PubSub State Machine

Status: design, pre-implementation. Drafted 2026-04-23 in response to three
distinct manifestations of the same "lost publish" bug class during Phases
E/F of the tile-lifecycle FSM rollout. Layers on top of
[tile-lifecycle-fsm.md](tile-lifecycle-fsm.md) — that doc governs *when a
tile is alive*; this doc governs *what messages can flow between tiles (and
the core) in each state*.

Goal: make the class of bug "a publish was dropped somewhere in the fabric"
**impossible**. If a message is dropped, the state machine identifies
exactly which transition was invalid. Runtime enforcement + bisectable
tests derive from the machine.

## Non-goals

- Re-implementing the tile lifecycle FSM (that lives in tile-fsm.ts /
  tile-lifecycle.ts). This doc references it.
- Changing the renderer-visible API surface (`api.publish`, `api.subscribe`,
  `api.commands.register`). Semantics tighten; shape stays.
- Solving cross-machine / cross-process pubsub beyond the existing
  main-process hub. The fabric remains one hub.

## Participants

Every pubsub participant is in exactly one of these roles. Each role has a
fixed identity (source address) and a fixed set of legal capabilities.

| Role | Identity | Notes |
|---|---|---|
| **Core** | `peek://app/...` | bgWindow (`app/background.html` → `app/index.js` runs cmd registry / page / hud) + cmd panel UI window (`app/cmd/panel.html`). Both carry `trustedBuiltin`; pubsub doesn't distinguish them. First-class publisher AND subscriber; every publish must reach bgWindow. |
| **Tile** | `peek://{tileId}/{entry}` | One per tile BrowserWindow. Capability-gated via tile token. |
| **System** | `peek://system/` | Main-process code publishing on its own behalf (e.g., `tag:item-added` from datastore IPC handlers, `window:focus-changed` from app events). Not a window, not a renderer. In-process call to `publish()`; no token, no IPC hop. |
| **Webview guest** | `peek://{feature}/...` webContents inside a `<webview>` | Hosted inside tile windows. Receives broadcasts via the same pubsub forwarding path. |

### The token is the capability handle

A tile's **token is the capability handle** for all pubsub and command
operations. The token is minted on `loading → ready` and revoked on
`→ unloading` / `→ crashed` by `tile-lifecycle.ts`. This makes the token
the atomic, race-free signal of "tile is in `ready` or `visible`":

- If `validateToken(t)` returns a grant, the tile is alive.
- If it returns null, the tile is not alive — publish/subscribe rejected.

**Consequence**: the pubsub enforcement path does **not** read lifecycle
state. It validates the token and consults the grant. Token validity and
lifecycle state are kept in sync by `tile-lifecycle.ts` as the sole
owner of both. This removes a hot-path cross-module dependency between
`pubsub.ts` and `tile-lifecycle.ts`, eliminates the transition-race
question ("was the publish checked before or after the state change?"),
and keeps the pubsub FSM testable as a pure function (see §Module
layout).

**Deleted concepts**:
- `peek://{id}/lazy-stub` pseudo-source — no longer a distinct participant.
  Lazy declaration is a *state* (`registered` per the lifecycle FSM), not a
  fake source address. The load-on-dispatch hook reads lifecycle state
  directly (it lives on the lifecycle side of the boundary).
- V1 extension-host iframes — gone as of 2026-04-21.
- Legacy `IPC_CHANNELS.SUBSCRIBE` / `PUBLISH` paths — folded into tile
  pubsub. Core uses the same capability-gated path as every tile, with a
  `trustedBuiltin` grant.

## Transport layers

All paths converge at `publish()` in `pubsub.ts`. There is exactly one hub.

```
  Core/Tile renderer
         │
         ▼  api.publish / api.subscribe (from tile-preload.cts)
         │
  ipcMain.on('tile:pubsub:publish')   ──►   capability-gated validate
  ipcMain.on('tile:pubsub:subscribe')       │
                                            ▼
                                       publish() in pubsub.ts
                                            │
             ┌──────────────────────────────┼──────────────────────────────┐
             ▼                              ▼                              ▼
        in-proc callbacks           pubsubBroadcaster              (hook)
        (topics Map)                 ├─ core window (bgWindow)        pre-publish
        — subscribers registered     ├─ tile windows                  can skip/defer
          via tile:pubsub:subscribe  └─ webview guests
```

**Binding rules**:
- No component calls `webContents.send('pubsub:...')` directly. The
  broadcaster is the only sender of pubsub IPC frames.
- The broadcaster iterates **bgWindow + all tile windows + qualifying
  webview guests**. Omitting bgWindow is a bug (historical; see
  `project_bgwindow_is_core.md`).
- Main-process code that wants to publish as System uses
  `publish(SYSTEM_ADDRESS, ..., topic, data)` directly — no IPC hop.

**Broadcaster fan-out — subscriber-indexed delivery**

The broadcaster must **not** blanket-iterate every renderer on every
publish. It consults the per-topic subscriber set maintained by
`tile:pubsub:subscribe`: a window that never subscribed to topic T
never receives frames for T. This turns fan-out from O(N windows) to
O(S subscribers-of-T), typically much smaller.

This is the single biggest perf lever in the fabric — at high widget
counts (50+ tile windows, multiple webview guests each), blanket
iteration at 60Hz (e.g., for `page:scroll`-style topics) will saturate
IPC. Subscriber-indexed delivery keeps it bounded by actual interest.

For topics with genuinely many subscribers (e.g., `tag:item-added`
during bulk sync), the fan-out is still proportional to how many
renderers actually care — which is the minimum unavoidable cost.

## Topic taxonomy

Topics live in flat namespaces separated by `:`. Every topic belongs to one
of these classes. The class determines who may publish, who may subscribe,
and what capability gating applies.

| Class | Pattern | Publishers | Subscribers | Gate |
|---|---|---|---|---|
| **Command dispatch** | `cmd:execute:{name}` | Core (panel + chains), other tiles (chained execution) | Owning tile's handler (via `api.commands.register`) | Capability: tile must have `commands`. Load-on-dispatch hook may defer. |
| **Command result** | `cmd:execute:{name}:result:{uuid}` | Owning tile | Dispatcher that set `expectResult:true` | Capability: same `commands` grant (infra carve-out). |
| **Command registry** | `cmd:register`, `cmd:register-batch`, `cmd:unregister` | Tiles with valid token (= state ≥ `ready`) | Core (cmd registry) | Dynamic registrations only. `cmd:register-batch` is the bulk variant (used by noun expansion). *Declared* commands come from manifest cache (not pubsub) per tile-lifecycle-fsm.md §Invariants. |
| **Noun registry** | `noun:register-batch`, `noun:unregister` | Tiles with valid token | Core (noun registry) | Same as cmd:register. |
| **Noun dispatch** | `noun:browse:{name}`, `noun:query:{name}`, `noun:open:{name}` | Core (panel) | Noun handler tile | Capability: `commands` (nouns auto-generate commands). |
| **Lifecycle observer** | `tile:state-changed` (mirror of lifecycle transitions) | `tile-lifecycle.ts` (System) | Observers (drift detector, HUD widgets) with `lifecycle-observer` capability | Read-only observer topic. Publishers must not publish this directly. `lifecycle-observer` is a new capability declared in the tile manifest (typical grantees: drift, HUD widgets that display tile state). |
| **Domain events** | `tag:*`, `item:*`, `sync:*`, `editor:*`, `entities:*`, `page:*`, `window:*`, etc. | System (datastore IPC handlers) + tiles whose manifest declares ownership of the namespace (e.g., tags feature owns `tag:*`) | Any tile whose capability grant allows subscription to the namespace | Capability allowlist on BOTH publish and subscribe sides. Namespace ownership is a manifest field: `owns: ['tag']`. |
| **Feature-scoped** | `{feature}:{verb}` (e.g., `websearch:engine-request`) | That feature's tile(s) | That feature's tile(s) | Capability allowlist. Cross-feature publish is a violation — see §Cross-feature rule below. |
| **Settings** | `topic:core:prefs`, `settings:changed:{feature}`, `settings:navigate` | Core (settings UI) | Any tile whose capability grant allows subscription to the topic | Publishers are Core/System; subscribers pass the normal capability allowlist through the gate. |

### Cross-feature rule

A feature tile may **not** publish to another feature's topic namespace. If
A needs data from B, it calls B's registered command (`api.commands.call`
→ `cmd:execute:{b-command}` round-trip), which goes through the full
dispatch state machine. This rule exists because ad-hoc cross-feature
topics (see tasks.md: websearch bg↔home round-trip) are the most common
source of fragile pubsub.

### Topics that are NOT pubsub: private lifecycle IPC

`tile:ready` and `tile:shutdown` are **not** pubsub topics. They are
private IPC signals between a tile's preload and `tile-lifecycle.ts`:

- `tile:lifecycle:ready` — preload → main, sent once after capability
  token validated. Causes lifecycle transition `loading → ready`.
- `tile:lifecycle:shutdown` — main → preload, sent during unload grace
  window.

**Why private**: `tile:ready` is the signal that *admits a tile as a
publisher*. If it flowed through pubsub itself, the tile would be
publishing before it has been admitted — a bootstrap circularity that
either requires a carve-out or introduces a race. Private IPC removes
the circularity entirely.

Observers that need to react to lifecycle transitions (drift detector,
HUD widgets) subscribe to the mirrored `tile:state-changed` pubsub
topic, which `tile-lifecycle.ts` publishes as System after a transition
lands. One direction, after the fact.

### Deleted topics

- `cmd:request-registers` — race workaround where Core on boot asks all
  tiles to replay their cached `cmd:register` payloads. Exists only because
  subscribers could land after publishers. With the FSM's invariant that
  Core's subscribers are live before any tile reaches `ready`, this topic
  has no job. **Delete.**
- `ext:ready`, `ext:all-loaded` — v1 lifecycle handshake. Replaced entirely
  by the private `tile:lifecycle:ready` signal + cache-backed declared
  commands. **Delete.**

## Authorization rules (not state lookups)

The pubsub enforcement layer does not inspect lifecycle state. It runs
one check: `validateToken(t) → grant | null`, then consults the grant
to answer "is this (publisher, topic, op) allowed?"

Because `tile-lifecycle.ts` mints the token on `loading → ready` and
revokes it on `→ unloading` / `→ crashed`, this single check implicitly
enforces the full state-based policy. Rules:

| Publisher | Operation | Check |
|---|---|---|
| Core (`trustedBuiltin` grant) | any publish, any subscribe | always allow |
| System (in-process main) | any publish | always allow; never subscribes |
| Tile with valid token | publish to topic T | grant includes `publish` for T's class (subject to per-class rules below) |
| Tile with valid token | subscribe to topic T | grant includes `subscribe` for T's class |
| Tile with revoked/missing token | any op | reject — logged as `gate:rejected` telemetry, never silently dropped |

Per-class rules (the capability-grant shape implements these):

| Topic class | Who may publish | Who may subscribe |
|---|---|---|
| `cmd:execute:{name}` | Any with `commands` grant (dispatcher) | Only the declared owner of `{name}` |
| `cmd:execute:{name}:result:{uuid}` | Only the owner of `{name}` | Only the dispatcher that set `resultTopic` (private-by-uuid) |
| `cmd:register` / `cmd:unregister` | Any with `commands` grant | Core only |
| `noun:register-batch` / `noun:unregister` | Any with `commands` grant | Core only |
| `noun:browse:{n}` / `noun:query:{n}` / `noun:open:{n}` | Core (panel) | Owner of noun `{n}` |
| `tile:state-changed` | System only (`tile-lifecycle.ts`) | Any with `lifecycle-observer` grant |
| Domain event `{ns}:{verb}` | System OR tile with `{ns}` ownership | Any tile whose capability allowlist matches |
| Feature-scoped `{feature}:{verb}` | Only the `{feature}` tile(s) | Only the `{feature}` tile(s) (cross-feature = violation) |

**Lifecycle state is not consulted at the enforcement point.** If the
token is valid, the tile is in `ready` or `visible` by definition. The
two FSMs couple through the token's lifetime, not through shared state
reads — this is the pure-function boundary that makes the pubsub FSM
testable in isolation.

`tile:lifecycle:ready` and `tile:lifecycle:shutdown` are private IPC
(§Topics that are NOT pubsub), so they never hit this table.

### The IPC chokepoint

All `tile:*` IPC frames pass through a single main-process gate
(`tile-ipc-gate.ts`, see §Module layout). The gate runs a fixed
sequence before any handler executes:

1. **Channel allowlisted?** `registerTileIpc(channel, handler, descriptor)`
   is the only way to attach a `tile:*` listener. An unregistered
   channel receives a default handler that logs `gate:rejected` and drops.
2. **Sender identity verified?** `event.sender` (the `WebContents` that
   sent the frame) must match the `WebContents` that owns the
   `payload.token`. This closes the "forged token" hole — a tile with
   XSS cannot smuggle out another tile's leaked token because the
   sender frame wouldn't match.
3. **Payload schema valid?** Each channel descriptor declares its
   expected shape. Malformed frames log `gate:rejected` and drop.
4. **Token valid & grant consistent with channel?** The channel
   descriptor names the capabilities required; absent ones → reject.
5. **State-at-receive matches channel's expected transition window?**
   E.g., `tile:lifecycle:ready` may only arrive while the tile is in
   `loading`; arrival in any other state → reject + `gate:rejected`.
6. **Sender role allowlisted for this channel?** E.g.,
   `tile:lifecycle:ready` must come from a tile's own preload, never
   from Core or System.

Only after all six pass does the handler run. Rejections are never
silent; every drop emits `gate:rejected` with a structured reason so CI
can fail on regressions.

**Performance budget**: schema validation (step 3) uses hand-rolled
shape checks (`typeof x.foo === 'string' && Array.isArray(x.bar)`),
not a general-purpose schema library (Zod / Ajv). Total gate cost
stays under ~5μs per frame — negligible next to Electron's intrinsic
IPC serialization + cross-process handoff (~10-50μs).

This chokepoint is the main-process analog of the authorization-rules
table above — it guarantees that the rules can't be bypassed by a
handler that forgets to validate, and it adds the sender-frame check
that the pure FSM alone can't express.

## Command dispatch & result — one path

**Rule**: a command result returns to its dispatcher by publishing to the
result topic through the same capability-gated pubsub path that every
other publish uses. Specifically:

- Dispatcher publishes `cmd:execute:{name}` with `{expectResult: true,
  resultTopic: 'cmd:execute:{name}:result:{uuid}'}`.
- Handler in the owning tile publishes to that result topic when it
  completes.
- Both publishes go through `tile:pubsub:publish` → capability allowlist
  → `publish()`.

The allowlist's `cmd:execute:*` infra carve-out for tiles holding the
`commands` grant (tile-ipc.ts, landed in commit `f32063db` on
2026-04-23) is what makes result-topic publishes legal without requiring
every tile to explicitly declare every possible UUID-suffixed topic in
its manifest.

**Legacy side-channel removed (Phase 3, 2026-04-23)**: tile-preload
previously also sent a parallel `ipcRenderer.send('tile:command:result',
...)` frame that hit an unrestricted main-process publish handler
(`ipcMain.on('tile:command:result', ...)` in tile-ipc.ts). That
duplicate path predated the allowlist carve-out and bypassed the gate
entirely. Both sites are gone — one auth path, one code path, one
place to reason about who can emit a command result.

```
  Dispatcher                             Owning tile
  (Core/panel or another tile)           (capability: commands)
        │                                         │
        │   publish('cmd:execute:X',              │
        │       { ..., expectResult:true,         │
        │         resultTopic:'cmd:execute:X:     │
        │         result:<uuid>' })               │
        │ ───────────────────────────────────────►│
        │                                         │
        │                          [load-on-dispatch hook
        │                           ensures state≥ready]
        │                                         │
        │                          [handler runs]
        │                                         │
        │                          publish('cmd:execute:X:
        │                              result:<uuid>',
        │                              { data } | { error })
        │ ◄───────────────────────────────────────│
        │                                         │
  resolve proxy promise
```

**Concrete removals (done Phase 3)**:
- `ipcRenderer.send('tile:command:result', ...)` call in
  `api.commands.register` handler — removed from tile-preload.cts.
  The `tile:pubsub:publish` to `msg.resultTopic` is now the sole path.
- `ipcMain.on('tile:command:result', ...)` handler in tile-ipc.ts —
  removed.

## Scope semantics — delete

The `scope` argument (`SYSTEM=1 | SELF=2 | GLOBAL=3`) is vestigial.

Survey results (2026-04-23):
- `api.scopes.GLOBAL` — ~100 sites across `app/**`.
- `api.scopes.SYSTEM` — 4 sites (3 in `app/index.js`, 1 in
  `app/settings/settings.js`).
- `api.scopes.SELF` — **zero sites**.

Preload's `publishImpl` defaults missing scope to `SELF`, but since no
caller passes SELF and SELF delivery is restricted to same-pseudo-host
subscribers (which for a one-window core = same-window), the SELF code
path is unreachable.

**Plan** (single commit, no backcompat grace period):
- Delete the `scopes` constant and the `scopeCheck()` function in
  `pubsub.ts`. All `publish()` calls route to both in-proc callbacks
  (filtered by topic match only) and the broadcaster.
- Migrate the 4 `api.scopes.SYSTEM` sites to regular publishes on
  system-privileged topics (e.g., `topic:core:prefs`). Privilege moves
  from the scope argument onto the topic — the topic's capability
  allowlist controls who may publish and who may subscribe.
- Remove the `scope` parameter from `api.publish` and `api.subscribe`.
  Migrate all ~100 call sites in `app/**` in the same commit. No
  backcompat shim, no no-op tolerance.

## Subscribe-before-publish invariant

This is the missing rule that explains every "lost publish at boot" bug.

**Statement**: For any topic T and any publisher P, at the moment P
publishes T, every subscriber S that will ever receive T during this boot
must already be registered.

**Enforcement**:
- **Core subscribers land first.** `app/index.js` subscribes to
  `cmd:register`, `cmd:register-batch`, `noun:register-batch`, and all
  core-managed domain topics during its synchronous init, BEFORE any tile
  is transitioned to `loading`. The main process waits for bgWindow's
  `tile:lifecycle:ready` (private IPC) before any `registered → loading`
  transition for other tiles.
- **Tile publishes are gated by token existence.** A tile in `loading`
  has no token yet (the token is minted on `loading → ready`). Any
  publish attempt from a `loading` tile fails the chokepoint's token
  check and is rejected + logged as `gate:rejected`. No capability check
  is needed — there's no token to consult.
- **No replay needed.** Because subscribers exist before any publisher
  fires, `cmd:request-registers` and the `registeredPayloads` cache in
  tile-preload.cts become unnecessary. **Delete both.**

This is the single rule that kills the class of bug "only hello-world's
commands visible in the cmd panel."

## Load-on-dispatch — timeout UX

When Core dispatches `cmd:execute:X` to a tile in `registered`, the
pre-publish hook forces a `registered → loading → ready` transition before
delivering. `LAZY_LOAD_TIMEOUT_MS` (currently 10s) bounds the wait.

**On timeout** (today: reject the pending promise with an error that the
cmd panel surfaces as a spinner hang):
- Dispatcher promise rejects with a structured error.
- Core publishes `notification:show` with `{ type: 'error', title: 'Tile
  didn't load', body: 'Command \"{name}\" couldn't run because its tile
  failed to load within 10 seconds.' }`.
- Cmd panel drops back to IDLE — no lingering spinner.

**On render-process-gone during load** (transition `loading → crashed`):
- Same notification, different body (`crashed while loading`).
- Dispatcher rejects immediately — no 10s wait.

## Bypass detection

Everything routed through the FSM is enforced at the gate; rejections
emit `gate:rejected` telemetry (see §Authorization rules). The only way
for a message to escape the FSM is for code to call a lower-level
Electron API directly, sidestepping the gate entirely. The FSM cannot
prevent this — anyone writing main-process code can do anything —
so we need complementary bypass detection.

Two bypass categories:

- **Direct-send bypass** — `webContents.send('pubsub:...')` called
  outside the broadcaster. Mitigation: lint rule against
  `webContents.send` with a `pubsub:` prefix, plus a dev-mode wrap of
  `webContents.send` that throws on the same pattern.
- **Off-path window creation** — `new BrowserWindow()` with a
  `peek://{tileId}/...` URL outside the tile launcher. Mitigation: lint
  rule + dev-mode assertion that every BrowserWindow with a tile URL has
  a corresponding `registered → loading` transition. (Inherited from
  tile-lifecycle-fsm.md.)

Both are dev/CI-only assertions. Production has nothing to check —
correct code can't trip them, and incorrect code is caught at review or
in dev.

What is explicitly **not** tracked as rejection telemetry:
- Startup races (if they occur, the FSM design is wrong — fix the design,
  don't paper over it with a detector).
- Unrouted publishes (legitimate for domain events with no listeners).

**Rejection emission rate limit**: `gate:rejected` publishes are
rate-limited to one event per `(tileId, reason)` tuple per second, with
a dropped-count aggregator. A buggy or malicious tile spamming rejected
frames cannot amplify into a telemetry storm that saturates the
broadcaster.

## Module layout

Dependencies are one-way: `tile-lifecycle` → `pubsub`. `pubsub` never
imports from `tile-lifecycle`. This is what makes the pubsub FSM
testable in isolation and eliminates the race between state lookup and
state transition.

- **`backend/electron/pubsub-fsm.ts`** (pure, new) — the authorization
  matrix as a pure function: `allow({role, grant, topic, op}) →
  'allow' | {violation: reason}`. No Electron / Node imports. Topic
  classification lives here. Testable without spinning up main.
- **`backend/electron/tile-fsm.ts`** (pure, exists) — lifecycle
  transition table. Unchanged.
- **`backend/electron/pubsub.ts`** — the hub: delivery, broadcaster
  wiring, pre-publish hooks. Imports `pubsub-fsm.ts` only. Exposes
  `unsubscribeAllByPrefix(tileId)` for lifecycle cleanup.
- **`backend/electron/tile-ipc-gate.ts`** (new) — the single IPC
  chokepoint AND the rejection-telemetry surface AND the bypass
  detectors. One module owns the whole gate boundary:
  - `registerTileIpc(channel, handler, descriptor)` — the only way to
    attach a `tile:*` IPC handler. Runs the six-step validation
    sequence (see §The IPC chokepoint).
  - `emitGateRejected(reason, ctx)` — rate-limited publish of
    `gate:rejected` (one event per `(tileId, reason)` per second,
    dropped-count aggregator). Used by the gate itself.
  - `installDirectSendGuard()` + `installOffPathWindowGuard()` —
    dev-mode monkey-patches catching the two bypass categories
    (§Bypass detection). Called at app init.
  - Subsumes what Phase 2 scaffolded as `tile-ipc-sender-check.ts` —
    the sender-frame check becomes step 2 of the pipeline, not a
    separate helper module.
- **`backend/electron/tile-ipc.ts`** — individual channel handlers,
  registered via `registerTileIpc`. On `tile:pubsub:publish` /
  `tile:pubsub:subscribe`: the gate has already validated the frame, so
  the handler just calls `pubsubFsm.allow(...)` for per-topic
  authorization → publish or reject. This is where the lifecycle↔pubsub
  boundary sits.
- **`backend/electron/tile-lifecycle.ts`** — state store + token
  lifecycle. On `loading → ready`: mint token. On `→ unloading` /
  `→ crashed`: revoke token, call `pubsub.unsubscribeAllByPrefix()`.
  Publishes `tile:state-changed` for observers. Imports from
  `pubsub.ts` (one-way); never imported by it.
- **`backend/electron/tile-lazy.ts`** — load-on-dispatch pre-publish
  hook. Already lives on the lifecycle side (it triggers
  `registered → loading`). Continues to register as a pre-publish hook
  on `pubsub.ts`; the hook body calls into lifecycle.

Test boundaries:
- `pubsub-fsm.ts` — pure unit tests over the authorization matrix.
- `tile-fsm.ts` — pure unit tests over the transition table (exists).
- `tile-ipc.ts` — integration tests with real tokens + real grants.
- Lifecycle cleanup — integration test that `→ crashed` clears the
  tile's subscriptions.

## Phased implementation

1. **Phase 1 — Fix bgWindow broadcast + rename broadcaster.** Add
   bgWindow to the broadcaster iteration. Rename
   `extensionBroadcaster` → `pubsubBroadcaster` (the "extension" label
   is a stale v1 term — Peek now reserves "extension" for bundled
   Chromium extensions; features/tiles are the current vocabulary).
   This alone unblocks the "only hello-world visible" and "tile result
   doesn't reach subscribers" bugs. No semantic changes.
   **Test**: tag/untag/widget-update smoke tests go green.
2. **Phase 2 — Sender-frame cross-check (security hardening).**
   Independently shippable. In every `tile:*` handler, verify
   `event.sender` matches the `WebContents` that owns
   `payload.token`. Closes the "tile with XSS forges another tile's
   token" hole. Does not require the full IPC chokepoint (Phase 8) but
   prepares for it — this check is worth landing early because it's
   security, not cleanup.
   **Test**: new unit test that simulates a mismatched sender + valid
   token → rejected with `gate:rejected`.
3. **Phase 3 — Collapse to one command-result path.** Delete the
   `tile:command:result` IPC (preload send site + main-process
   handler). All command results flow through capability-gated pubsub
   publish of the result topic. **Test**: every test exercising command
   results stays green.
4. **Phase 4 — Private lifecycle IPC + subscribe-before-publish.**
   Split `tile:ready` / `tile:shutdown` off the pubsub bus onto private
   `tile:lifecycle:*` IPC channels handled directly in
   `tile-lifecycle.ts`. `app/index.js` wires all core subscribers
   during synchronous init; main process gates first tile
   `registered → loading` on bgWindow's private lifecycle-ready IPC.
   Add `tile:state-changed` as the public observer mirror. **Test**:
   unit test that simulates tile emitting `cmd:register` at `t=0` boot
   — subscriber in core gets it. No pubsub-level `tile:ready` topic
   remains.
5. **Phase 5 — Delete replay machinery.** Remove `cmd:request-registers`
   topic + `registeredPayloads` cache + `ensureCmdRequestRegistersListener`
   in tile-preload.cts. **Test**: cmd registry has full contents after
   cold boot without replay.
6. **Phase 6 — Delete scope.** Remove `scopes` constant from `pubsub.ts`
   + `api.scopes` surface in tile-preload. `api.publish`/`api.subscribe`
   lose their scope parameter. Migrate all ~100 call sites in `app/**`
   + the 4 SYSTEM sites in the same commit; no backcompat shim.
   **Test**: existing pubsub tests green; grep for `api.scopes` returns zero.
7. **Phase 7 — Timeout UX.** Wire notification publish on
   `LAZY_LOAD_TIMEOUT_MS` expiry and on `loading→crashed` during
   load-on-dispatch. **Test**: dispatcher to a tile whose preload throws
   → user-visible notification within 10s.
8. **Phase 8 — IPC chokepoint + bypass detectors.** Introduce
   `tile-ipc-gate.ts` as the single module owning the gate boundary:
   `registerTileIpc(channel, handler, descriptor)` with the six-step
   validation pipeline (§The IPC chokepoint); rate-limited
   `gate:rejected` rejection telemetry; dev-mode bypass detectors
   (direct `webContents.send('pubsub:...')`, off-path `new BrowserWindow`
   for tile URLs). Subsumes Phase 2's `tile-ipc-sender-check.ts` (folded
   in as step 2 of the pipeline). Migrate every existing `tile:*`
   `ipcMain.on` through `registerTileIpc`. Add ESLint rules for the two
   bypass categories. Wire rejection events so CI fails on any
   `gate:rejected` publish during test.
   **Test**: regression suite stays green; a deliberately-seeded
   bypass in a test fixture trips the detector; every `tile:*` channel
   has at least one passing + one rejecting gate test; rate limiter
   test (100 rejections with same reason → one publish).

Each phase is independently shippable and each has a narrow failure mode.

## Test plan

- **Pure FSM unit tests**: state × operation matrix — each legal op
  returns `allow`, each illegal op returns `violation`.
- **Integration**: cold boot → cmd panel has all declared commands before
  any tile window exists (manifest-cache path, already scoped by
  tile-lifecycle-fsm.md).
- **Integration**: cold boot → dispatch cmd to `registered` tile, assert
  load triggers, handler runs, result topic reaches dispatcher. No
  spinner-hang.
- **Integration**: dispatch to tile whose renderer throws during init →
  notification appears, panel returns to IDLE within 10s.
- **Regression**: the 2026-04-23 repro `tests/desktop/cmd-execute-twice.
  spec.ts` still passes. Add companion that fires 5x in a row from the
  panel UI (per tasks.md item).
- **Regression**: full desktop suite stays green after each phase.

## References

- [tile-lifecycle-fsm.md](tile-lifecycle-fsm.md) — tile state machine;
  this doc layers on top.
- `backend/electron/pubsub.ts` — the hub.
- `backend/electron/pubsub-fsm.ts` (new, Phase 8) — pure authorization
  matrix.
- `backend/electron/tile-ipc.ts` — individual `tile:*` channel handlers.
- `backend/electron/tile-ipc-gate.ts` (new, Phase 8) — single IPC
  chokepoint + rejection telemetry + bypass detectors. Owns the
  `gate:rejected` topic.
- `backend/electron/tile-preload.cts` — renderer-side publish/subscribe
  API + command registration.
- `backend/electron/main.ts:216` — broadcaster registration site
  (`setExtensionBroadcaster` → renamed to `setPubsubBroadcaster` in
  Phase 1; this is the bug site for bgWindow exclusion).
- `backend/electron/tile-lazy.ts` — pre-publish hook for
  load-on-dispatch.
- `app/background.html`, `app/index.js`, `app/cmd/background.js` — core
  renderer entry points + subscribers.
- `docs/tasks.md` Current-Priority section — bugs this machine makes
  impossible.
