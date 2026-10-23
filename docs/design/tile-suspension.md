# Tile suspension

Status: design, nothing implemented. Written against `main` at 3d27ef0d.

## Problem

Built-in feature tiles are lazy. `apps/desktop/main/tile-lazy.ts installLoadOnDispatchHook`
wakes a tile on `cmd:execute:<command>`, a `noun:<capability>:<name>` topic, a `lazyEvents`
topic, or a schedule topic, through `ensureTileLoaded` -> `loadLazyTile` -> `waitForTileReady`.
Once woken, nothing ever unloads it. `unloadTile` (`tile-launcher.ts`) is called only on
feature disable/uninstall (`tile-ipc.ts`), dev reload / `relaunchTile`, and app quit
(`unloadAllTiles`). There is no idle timer, eviction or TTL. A long session therefore ends with
one hidden background window and one renderer process per feature ever used.

Goal: unload a tile that has not been used for a while, and bring it back through the existing
wake path the next time anything needs it, without the user or any other tile noticing beyond
the cold-wake delay.

## What already exists and is reused

- **Unload**: `unloadTile(tileId, entryId)` sends `tile:lifecycle:shutdown` to every window of the
  entry, waits `TILE_SHUTDOWN_GRACE_MS` (500 ms, no ack), closes the windows, drops tokens, and
  `releaseTileWindow` runs `unsubscribeAll('peek://<tileId>/<entryId>')` and drives the
  lifecycle back to `registered` (SHUTDOWN, then CLEANUP_KEEP in `tile-fsm.ts`).
  A tile in `registered` is exactly a tile that was never woken. So a suspended tile needs no
  new physical state: **suspended == `registered`**, **waking == `loading`**,
  **suspending == `unloading`**.
- **Wake**: unchanged. The dispatch hook, the pending-dispatch bookkeeping and the load timeout
  in `tile-lazy.ts` already handle a tile that is `registered`.
- **Things that live in main and survive unload**, because `unloadTile` does not touch them:
  the lazy registry entry and announced commands/nouns (`registerLazyTile`), OS wake accelerators
  (`feature-shortcut-registrar.ts registerWakeShortcuts`, persisted `lazy_wake_shortcuts` rows),
  and manifest schedules (`tile-schedule.ts registerTileSchedule`; the timer lives in main so a
  sleeping tile still runs on its clock). Only `disarmLazyTile` (`tile-arm.ts`) removes them.

## Decisions

### 1. What counts as "in use" (never suspend while true)

Suspension targets the lazy tile's background entry (the entry `getBackgroundEntry` returns:
`lazy: true`, else the first). The tile is in use when any of these hold:

1. **A window of the tile is alive** in any entry: a visible one, or a hidden keepLive one.
   The background entry's home/UI windows depend on the background handlers over pubsub, so
   the background entry cannot go while a sibling window is open. Source of truth: the
   `tileWindows` registry in `tile-launcher.ts` (add a read-only accessor; `getAllTileWindows`
   and `getLoadedTileIds` exist but are not keyed by entry).
2. **A content window the tile opened is alive** (a slide playing music is a hybrid page host,
   not a tile window). Needs an opener-tile attribution on the window record; see open
   question A.
3. **A hold is active** (below): in-flight request, running job, running timer, open server.
4. **A wake is in flight**: the tile is `loading`, or a dispatch for it is pending
   (`pendingDispatchesByTile`).
5. **Activity inside the idle window**: last wake delivery, last window close, last hold
   release, last pubsub message delivered to the tile. Without the last item a tile that is
   simply subscribed to a busy topic would be suspended mid-stream; delivered-message time
   needs a hook in the pubsub broadcaster (`pubsub.ts`), which the idle clock reads.

### 2. How a tile declares it must stay (manifest flag plus runtime hold)

- **Manifest** `suspend: "never"` on the tile entry for tiles whose job is to be running
  (a server, a long-lived connection). Default is `"idle"` (eligible). Static, reviewable,
  visible in the Features Manager. `resident: true` tiles are never lazy and are out of scope.
- **Runtime hold**: `api.tile.hold(reason)` returns a release function (capability-free, scoped
  to the caller's own tile by token). The tile holds while a countdown timer runs, a fetch job
  is mid-flight, or a long operation is open. Holds are counted and carry the reason string for
  the HUD. A hold older than a cap (default 30 min) is logged and released by main, so a leaked
  hold cannot pin a tile forever.
- **Main-side implicit hold** for request/response commands: when the hook delivers a
  `cmd:execute:<name>` carrying a `resultTopic`, main holds the tile until that result topic is
  published or the 30 s proxy timeout elapses. Tiles do not need to know about this.

Rejected: inferring "in use" from open subscriptions (every tile has them, so nothing would
ever suspend); manifest-only (a timers tile is idle-eligible until the user starts a timer).

### 3. When to suspend

- **Idle timer**, per tile: suspend after `idleMs` with no activity (item 5 above) and no use
  condition true. Default 10 minutes. Rule: never less than 2x the tile's shortest schedule
  interval, otherwise a polling tile thrashes (wake, run, suspend, wake).
- **Memory pressure** shortens the idle time: while the total renderer working set (from
  `process-metrics.ts`, the same source the memory HUD uses) is above a threshold, `idleMs` drops
  to 1 minute and candidates are taken least-recently-used first, one per evaluation tick, until
  under the threshold. Pressure never overrides a use condition or a hold.
- **Setting**: one global switch ("Suspend unused features", on by default once rolled out) plus
  the idle minutes, stored with other app prefs; a per-feature override in the Features Manager
  (never / default). Off means the machine below stays in `active` and never emits suspend.

Rejected: memory-pressure only (no signal Electron exposes is as cheap or as predictable as an
idle clock, and pressure-only suspends the tile you used a minute ago); idle-only (does nothing
for a user with many tiles woken in the last ten minutes on a small machine).

### 4. What suspend means

Destroy the background window through `unloadTile`, re-wake through the existing lazy path.
Lighter options rejected, one line each: `webContents.setBackgroundThrottling` / hiding does
not free the renderer process, which is the cost being removed; freezing or discarding a
`webContents` has no supported Electron API; moving feature logic to main-process modules is a
rewrite of every tile and out of scope.

**Persistence contract.** A tile must be crash-safe: anything a user would miss is written to
the datastore at the moment it changes, not at shutdown. Suspend then loses only derived,
in-memory state. As a courtesy flush, add a second lifecycle event:

- `tile:lifecycle:suspend` (new), delivered through `api.onSuspend(async cb)` in
  `tile-preload.cts`, next to `onShutdown`. The tile acks by resolving `cb`; main waits for the
  ack with a deadline of 2 s, then closes anyway. (`onShutdown` has a 500 ms grace and no ack,
  which is too little for a flush and gives no signal that it finished.)
- A tile that registers no `onSuspend` is closed after the existing 500 ms grace.

### 5. Wake cost and correctness

What keeps working because it lives in main: wake hotkeys (including persisted,
settings-derived ones), schedules, palette entries for manifest commands and nouns, the
cold-wake path with load timeout and crash reporting. No wake-declaration backfill
(`backfillWakeDeclaration`) is re-triggered, since `lazy_wake_declared` stays set.

What can break when a tile reloads mid-session, each to be audited per tile before it is
enabled for suspension:

1. **The race that would lose messages (must fix in the design, not per tile).**
   While a tile is `suspending`, `isTileLoaded` is still true until the windows are dropped, so
   `loadLazyTile` returns immediately and the hook delivers the wake publish to a renderer that
   is shutting down. The message is lost. The suspension machine therefore owns the wake gate:
   the hook asks it first, and a wake that arrives in `suspending` is queued, delivered after
   suspend completes and a fresh load becomes ready. Shutdown has already been signalled to the
   tile, so cancelling the suspend is not offered.
2. **Init ordering.** The `apps/desktop/CLAUDE.md` rule (register wake handlers synchronously
   in `init()` before any `await`; guard handler bodies on an `initReady` promise) becomes a
   per-wake rule instead of a once-per-session one. Every lazy tile must satisfy it before
   suspension is enabled for it. `features/websearch/home.js` is the reference.
3. **Cold-wake settings race.** Fixed for slides and peeks with a `settingsLoaded` guard on the
   handler body. Any tile that reads settings from the datastore in `init()` needs the same
   guard, now on every wake, not only the first.
4. **State built from events seen while awake.** A tile that accumulates state from topics not
   in its `lazyEvents` sees only events during its awake time; after a suspend that state must
   be rebuilt from the datastore on wake. Audit target for each tile.
5. **Dynamically registered palette entries.** Commands the tile registered at run time (beyond
   the manifest's) are owned by its `peek://<tileId>/background` source; whether the command
   registry drops them when the tile's subscriptions are removed, and whether the tile re-adds
   them on wake, is unverified (open question C).
6. **Open windows pointing at a dead background.** Covered by use condition 1.
7. **Cold wake is slow.** Peek task `9e6e91de` ("opening feels slow") is the known cost of a
   cold wake for peeks and slides. Suspension makes that cost recur, so those two are last.

### 6. Where the decision lives

One owner: a new module `main/tile-suspension.ts`, split like the rest of the lifecycle code
into a pure core (`decideSuspension(state, event, now)` returning the next state and a list of
effects, no electron imports) and a thin shell that feeds it events and runs effects. It does
not add states to `tile-fsm.ts`: that table already models the physical lifecycle, and the
suspension machine only reads it and issues one effect, `unloadTile`.

Per-tile states (policy level), with the physical state each mirrors:

| Policy state | Physical (`tile-fsm.ts`) | Meaning |
|---|---|---|
| `suspended` | `registered` | no renderer; wake on demand |
| `waking` | `loading` | launch in flight |
| `active` | `ready` / `visible` | at least one use condition true |
| `idle` | `ready` / `visible` | no use condition; idle timer running |
| `suspending` | `unloading` | shutdown sent, awaiting ack or deadline |

Events: `activity`, `hold-acquired`, `hold-released`, `window-opened`, `window-closed`,
`idle-timeout`, `memory-pressure`, `suspend-requested`, `suspend-acked`, `suspend-deadline`,
`wake-requested`, `wake-ready`, `wake-failed`, `crashed`, `disabled`, `setting-changed`.

Legal transitions:

- `suspended` --wake-requested--> `waking` --wake-ready--> `active`; `waking` --wake-failed-->
  `suspended` (the existing load-error path reports it).
- `active` --(last use condition cleared)--> `idle`; `idle` --(any use condition or activity)-->
  `active`; `idle` --idle-timeout or memory-pressure--> `suspending`.
- `suspending` --suspend-acked or suspend-deadline--> `suspended`; `wake-requested` while
  `suspending` is queued and replayed on entering `suspended`. All other events are ignored.
- Any state --disabled--> `suspended` (the disable handler already calls `unloadTile`);
  any state --crashed--> `suspended` for the policy machine, while the physical machine keeps
  `crashed` (its relaunch policy stays user-initiated and is not changed here).
- `idle` and `active` never go directly to `suspended`; a suspend always passes through
  `suspending`, so the shutdown event is always sent.

The dispatch hook's drift check (`assertDispatchFsmState`) already tolerates `registered`.

### 7. Testing and observation

- **Unit tests** on the pure core, table-driven, with an injected clock: every legal transition;
  every illegal event ignored; idle timer resets on activity; holds block and a stale hold is
  released at the cap; wake during `suspending` is replayed exactly once; memory pressure picks
  the least-recently-used eligible tile and skips held ones; schedule-interval floor.
  A property test: for any event sequence, no `unloadTile` effect is emitted while a hold, a
  tile window, or a pending dispatch exists. These need no Electron, so they run in the main
  unit runner.
- **Integration**: one Playwright spec per rollout stage that wakes a tile, advances a shortened
  idle time through a test-only setting, observes the background window gone, then runs the
  tile's command and checks the result. Run with the packaged-build route in
  `apps/desktop/CLAUDE.md`, not the full gate.
- **Observation**: publish each policy transition on a `tile:suspension-changed` topic (same
  read-only-mirror shape as `tile:state-changed`) and show per-tile policy state, idle
  countdown and active holds in the memory HUD's window breakdown (track `hud-windows`).
  The HUD is also where "observe-only" mode is read.

### 8. Rollout

1. **Observe only.** Ship the machine with the effect disabled: it logs and publishes
   "would suspend" decisions for a few sessions. Gives real idle-time data to set the default
   and finds tiles that hold windows or activity unexpectedly.
2. **Read-mostly tiles with datastore-backed state**, a handful at a time: websearch,
   translate, lookups, tag-actions, entities, composer, editor background.
3. **Tiles with timers or jobs, after they take holds**: timers (a hold while any timer runs),
   feeds, reminders, connectory (schedule-woken; the interval floor applies).
4. **Last**: peeks and slides (cold-wake latency, settings-derived hotkeys, keepLive windows),
   and mcp-server (the manifest has only a background entry and one command; if the server it
   exposes lives in that renderer it must be `suspend: "never"`; unverified).

Risks: lost wake messages (section 5 item 1, the main one); user-visible cold-wake latency;
tiles whose in-memory state was never persisted; a leaked hold pinning memory (mitigated by
the cap and the HUD); thrash on short schedules (interval floor).

## Open questions needing a decision

A. **Who owns a content window?** Use condition 2 needs the window record to carry the opener
   tile. `main.ts getWindowInfo(id)` returns `{ source, params }`, so a `source` address
   probably names the opener, but whether it is the opening tile for hybrid hosts is
   unverified. If not, adding it is a small change outside this design; without it,
   a slide's music window cannot pin its tile and the safe fallback is to pin any tile that
   ever opened a keepLive window. Needs decision on whether to add the attribution.
B. **Default idle time and whether it is user-visible.** 10 minutes and a global on/off plus a
   per-feature override are proposed; whether to expose the minutes at all is a product call.
C. **Dynamic palette entries across a suspend.** Needs a read of the command registry and the
   tiles that register commands at run time; may require suspending to unregister them, or the
   tile to declare them in its manifest.
D. **Memory threshold.** One number against total renderer working set, or a share of system
   memory. Needs real HUD data from the observe-only stage.
E. **Suspend deadline of 2 s and the `onSuspend` API.** Is a new preload API acceptable, or
   should tiles be required to be fully crash-safe with the existing `onShutdown`?
F. **Should peeks and slides ever suspend** while the cold-wake delay (`9e6e91de`) stands?
