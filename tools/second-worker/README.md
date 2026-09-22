# second-worker

The case after `tools/hello-worker`, per `docs/worker-runtime-portability.md` §8: not a bigger
worker, but the same shape extended with a manifest that denies a network domain, a schedule that
fires twice, and a channel that delivers one command. Between them, this worker and its host turn
four of the five operations that document's §4.6 named unimplemented in `hello-worker` —
`installGlobals`, `ensureSchedule`, `cancelSchedule`, `openChannel` — into code a real run
exercises, and the fifth, `RunContext`, into the second parameter `worker.js` actually reads.

See `docs/worker-runtime-portability.md` §4 for the interface this follows and §4.6 for the table
this worker fills in the rest of.

## Files

- `manifest.json` — grants `datastore` and `network: { domains: ["allowed.example"] }`. The
  narrow domain list is the point: `worker.js` deliberately fetches a different host to prove the
  guard denies it.
- `worker.js` — the entry function `second(api, ctx)`. Branches on `ctx.trigger.kind`: a
  `"schedule"` trigger reads the store and probes the denied domain; a `"command"` trigger logs the
  command and publishes an acknowledgement through `ctx.waitUntil`. Exports `capturedApi`, read at
  the module's own import time (mirroring `apps/desktop/renderer/cmd/nouns.js`'s first line) so the
  host can check whether the module graph was actually fresh this run.
- `run.mjs` — host and adapter fused into one file, the same shape `tools/hello-worker/run.mjs`
  is. One named function per `docs/worker-runtime-portability.md` §4.4 operation
  (`installGlobals`, `loadWorkerModule`, `ensureSchedule`/`cancelSchedule`, `openChannel`, `log`),
  a `declares` object per §4.3, and `runWorker()` as the §4.4 `WorkerHost.run()`. Drives three runs:
  two off an in-process `setInterval` standing in for a schedule, one off a simulated inbound
  channel message.

## Running it

```bash
node tools/second-worker/run.mjs
```

No flags, no credential, no network: the store is always the in-memory one
(`tools/feeds-worker-spike/memory-store.mjs`), and the one real network attempt the worker makes is
to a domain the manifest does not grant, which the guard denies before any DNS lookup happens.

## Sample output

```
[info] [second-worker] worker.js captured this run's own api object at import time — fresh module graph confirmed (§4.5)
[info] [second-worker] run start: trigger="schedule", deadline in 4998ms
[info] [second-worker] store backend "memory", scheduled for 2026-09-22T08:53:42.126Z
[info] [second-worker] network guard denied as declared: network capability does not cover denied.example (manifest allows: allowed.example)
...
[info] [second-worker] run start: trigger="command", deadline in 4999ms
[info] [second-worker] command "ping" received, params={"at":1790067222630}
[channel] publish "second-worker:ping-result" {"name":"ping","ok":true}
[info] [second-worker] result published on "second-worker:ping-result"

--- results
  run 1: ok in 3ms
  run 2: ok in 3ms
  run 3: ok in 2ms

--- network
  manifest allows: allowed.example
  DENY   denied.example  https://denied.example/config
  DENY   denied.example  https://denied.example/config

second-worker ok.
```

The "fresh module graph confirmed" line is not decorative: temporarily importing `worker.js` by a
fixed specifier instead of the cache-busted one in `loadWorkerModule()` flips it to `WARNING:
... module graph was reused (§4.5 violated)` on runs 2 and 3, while everything else keeps
"succeeding" — which is exactly the silent failure mode `docs/workers-design.md` §13.4 measured in
`nouns.js` and the reason §4.5 is not an optional recommendation. That regression check was run by
hand while writing this worker and is not wired into any test; see "What this does not do."

## What this settles

**The per-run context object earns its place as a second parameter, not a namespace on `api`.**
`docs/worker-runtime-portability.md` open question 4 asked this; writing `worker.js` settled it
empirically, for a reason that surfaced only once the worker had to actually read `ctx.trigger`,
`ctx.deadline` and `ctx.waitUntil`: `api`'s contract is "presence of a namespace means the manifest
granted it" (§2, §7 — absent is absent, never stubbed). `ctx`'s fields are not gated by the
manifest at all; every worker gets a trigger, a deadline and a `waitUntil`, regardless of what it
declared. Hanging them off `api` as `api.run.*` would put two different kinds of fact behind the
same object — "what you may do" and "why you are running right now" — and the second run this
worker makes shows why that matters concretely: `onCommand()` reads `ctx.trigger.name` and
`ctx.trigger.resultTopic`, values that exist only because *this* run is a command delivery, not
because the manifest grants anything about commands. A worker author checking `typeof api.commands`
to ask "can I register a command handler" and `ctx.trigger.kind` to ask "is this run a command"
would be asking the same-shaped question of two objects that mean different things by "present."
Keeping them separate keeps that distinction legible. `docs/worker-runtime-portability.md` §10 open
question 4 is updated with this reasoning.

## What this proves, and what it does not

Proves: `installGlobals` populating `window.app` before import, a schedule producing two distinct
`RunContext`s with two distinct `scheduledFor` values, a channel delivering one command trigger
with `ctx.waitUntil` used for the resulting publish, the network guard denying a real fetch
attempt, and the module graph being fresh on every run — the sharpest thing `hello-worker` left
unproven (its entry function never touches `window.app`).

Does not prove: anything about a *target* other than a single Node process (§5.1's "resident
supervisor" is simulated by one `setInterval`, not built); anything about `ctx.deadline` actually
biting (5 seconds, never approached); anything about `ctx.signal` reaching a network call (this
guard, from `tools/feeds-worker-spike/worker-api.mjs`, does not accept one — wiring the abort
signal into `installNetworkGuard()` is unbuilt); an *uncaught* network denial failing a run, which
is conformance assertion 5's job with a probe worker built for exactly that, not this one's
(`worker.js` catches the denial deliberately, the way a real feature would); and durability of any
kind — every schedule and channel here disappears with the process, which is the honest answer for
what a bare Node target can offer without an OS-level scheduler or a resident process (§5.1).
