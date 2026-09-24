# Worker runtime portability — one worker module, four hosts

A Peek worker (`docs/workers-design.md`) is a feature that runs on remote compute: no window, no
display, no local `datastore.sqlite`. This document settles *where that compute is allowed to be*,
and what has to be true for one worker module to run unchanged on a bare Node process, on
Cloudflare Workers plus Durable Objects, on celld, and in a container.

It supersedes `docs/workers-design.md` §11, which recommended adopting the Cloudflare Workers and
Durable Objects *API* as the worker runtime contract. §1 below says what changed and what of that
reasoning still stands. Everything else in `docs/workers-design.md` is unaffected — this document
takes §2–§9 as given and does not revisit what a worker is, what it may reach, or where its state
lives.

Documentation only. Nothing here is built. The interface in §4 is a sketch to argue against, not a
file to copy.

**Sourcing.** Claims about platforms either point at `docs/workers-design.md` §10 — whose numbers
were fetched 2026-08-18 and carry their URLs there — or are fetched fresh for this document on
**2026-09-16** and carry a URL and the page's own last-updated date where it publishes one. One
claim (§5.5, the workerd alarm restart) is neither: it was measured directly on **2026-09-22**
against a real `workerd` process rather than read off a page, and is cited by that date and the
`workerd` version used rather than a URL. Anything not established either way is marked
**unverified** and named as such rather than smoothed over.

## Contents

1. [The requirement, and why the earlier recommendation does not meet it](#1-the-requirement-and-why-the-earlier-recommendation-does-not-meet-it)
2. [Where the seam is](#2-where-the-seam-is)
3. [Three layers, only one of which is per-platform](#3-three-layers-only-one-of-which-is-per-platform)
4. [The host contract, as an interface](#4-the-host-contract-as-an-interface)
5. [What each target supplies, and what it cannot](#5-what-each-target-supplies-and-what-it-cannot)
6. [What leaks through the seam regardless](#6-what-leaks-through-the-seam-regardless)
7. [What a worker author is promised](#7-what-a-worker-author-is-promised)
8. [Conformance](#8-conformance)
9. [What this costs](#9-what-this-costs)
10. [Open questions](#10-open-questions)

---

## 1. The requirement, and why the earlier recommendation does not meet it

**Decision: Peek defines its own host contract. Cloudflare Workers plus Durable Objects, celld, a
bare Node process and a container are each an adapter behind it. Cloudflare remains the likely
first hosted target; it stops being the contract.**

`docs/workers-design.md` §11 said the opposite, and its argument was good: the Cloudflare Workers
and Durable Objects API is one interface with a GA implementation and an Apache-2.0 self-hosted one
(celld), so targeting the API rather than the vendor is a bet on an interface rather than on a
company. That is still true, and §5.4 below keeps the benefit of it.

Three things break it as a *contract*.

**It excludes the one host that already works.** A plain Node process cannot serve the Workers and
Durable Objects API. It can run a Peek worker: `tools/hello-worker/run.mjs` (on branch
`track/hello-worker`, not yet merged) is 137 lines, imports `worker.js`, builds the API object,
holds the credential in a closure, and runs the entry function. It is not a partial or degraded
host — it is a complete one for the operations it implements, and §4.6 lists exactly which
operations it does not. Making the Cloudflare API the contract means that script's replacement is
`workerd` with a Cap'n Proto config, not Node.

That is available: workerd is "a JavaScript / Wasm server runtime based on the same code that
powers Cloudflare Workers", Apache-2.0, run as `workerd serve my-config.capnp`, with prebuilt
binaries via npm requiring glibc 2.35+ and SSE4.2/CLMUL on x86-64
(`https://github.com/cloudflare/workerd`, fetched 2026-09-16). So "self-host the API" is a real
option and §5.5 treats it as a real target. But it is a second runtime with its own configuration
format, its own platform floor, and its own warning — the same README states workerd "is not a
hardened sandbox" and that possibly-malicious code "must" run "inside an appropriate secure
sandbox, such as a virtual machine." Choosing it as the *only* way to run a worker on a Linux box
is a large decision to make implicitly, by choosing a contract.

**The part of the Durable Objects API a Peek worker uses is three operations wide, and Peek has
already refused the rest.** A Durable Object's substance is its transactional per-object storage:
10 GB of SQLite that the object alone can reach. `docs/workers-design.md` §4 makes workers
stateless between invocations and §7 puts every durable byte in the Peek store, on the explicit
reasoning that a runtime-local store is correct until the runtime reschedules the worker
elsewhere. So the storage — the reason Durable Objects exist — is designed out. What is left that
a Peek worker actually needs is an alarm, a single-instance guarantee, and an address. Adopting a
large host-side API to obtain three operations, and paying for it by excluding every runtime that
is not workerd, is the wrong trade.

**A worker module never sees the Workers API anyway.** This is the load-bearing one. Feature code
calls `api.*` — the `window.app`-shaped object of `docs/workers-design.md` §5 — and exports an
entry function. It does not write `export default { fetch, scheduled }`, does not receive `env`,
does not touch `DurableObjectState`, and cannot call `ctx.waitUntil` because nothing hands it a
`ctx`. The Workers API is the vocabulary *the host* speaks to *the platform*. Declaring it the
worker contract describes a seam the worker is not on.

**What of §11 still stands**, restated rather than deleted:

- **Cloudflare first, for isolation.** `docs/workers-design.md` §10.3's third argument against a
  container is unchanged: running many users' third-party feature code in one process is not
  isolation, and an isolate runtime is the thing that is. When Peek runs third-party workers, it
  runs them somewhere that isolates by construction.
- **Schedules compile to alarms, not cron.** Unchanged and now better sourced (§6.1). Cron is
  capped at three per Worker, celld does not implement it at all, and its retry policy is not
  published; Durable Object alarms are per-object, unbounded in count, at-least-once with
  automatic retry.
- **Not celld first.** Its own documentation says it is "not safe for hostile multi-tenant use",
  with an operator API that "does not authenticate its requests" and a peer protocol that does not
  terminate TLS (`docs/workers-design.md` §10.1). A worker holds a credential scoped to a user's
  store. That has not changed.
- **Not a move of `apps/server`.** `notes/cloudflare-vs-railway-evaluation.md` stands untouched. A
  worker is a client of `apps/server`, wherever the worker runs.

**What changed.** Under the contract, Cloudflare is where the *first hosted stage* runs, and a
bare Node process is where the *first stage* runs — and those are different stages.
`docs/workers-capabilities.md` §8.1 and `docs/workers-design.md` §13.3 already settle that the
first version runs **bundled features only**, with third-party workers layered on after. Isolation
between untrusted features is a stage-two requirement. A bare Node process is sufficient for stage
one and is the only target where stage one can be exercised today, on hardware Peek already has.
Writing the contract now is what stops stage one from foreclosing stage two.

---

## 2. Where the seam is

A worker module is handed one object and exports one function. Everything else is the host's.

**What the module gets:**

- `api` — the `window.app`-shaped capability object (`docs/workers-design.md` §5): `api.datastore`,
  `api.network`, `api.pubsub` / `api.publish` / `api.subscribe`, `api.commands`, `api.settings`,
  `api.log`, `api.initialize` / `api.onShutdown`. Absent namespaces are `undefined`, never stubbed
  — the decision in §5 of that document, re-affirmed by the measurement in its §13.5, where
  stubbing let `init()` "succeed" and install a fifteen-minute interval that could never
  accomplish anything.
- Optionally a second argument carrying the run's trigger and deadline (§4.2). Optional because
  `tools/hello-worker/worker.js` takes only `api`, and that must keep working.
- The language floor: ES modules, ES2022, `fetch`, `URL`, `TextEncoder`/`TextDecoder`,
  `crypto.subtle`, `AbortController`, `structuredClone`. Not the Node standard library, not
  browser globals. §6.5 is why.

**What the host supplies around it**, and this is the whole list:

1. Getting the module's code to where it can be imported, with cross-feature imports already
   bundled (`docs/workers-design.md` §13.4 settles bundling).
2. Constructing `api` — including which namespaces exist at all, which is the manifest's grant.
3. Custody of the credential, which `api.datastore` is built over and feature code must never
   reach (`docs/workers-capabilities.md` §2.1).
4. Deciding when the entry function runs: a schedule, a wake, an agent's command.
5. The duplex channel that carries pubsub in both directions.
6. Where `api.log` goes.
7. What happens when the entry function throws.

The seam is between 0 and 1. Feature code is above it and is portable by construction, because it
cannot name anything platform-specific — there is nothing platform-specific in reach.

**The desktop is the reference implementation of `api`, and not an adapter of this contract.**
`apps/desktop/main/tile-preload.cts` `buildAPI()` builds the same shape and installs it with
`contextBridge.exposeInMainWorld('app', api)`: every method is an `ipcRenderer.invoke` or `send` on
a `tile:<domain>:<verb>` channel carrying a capability token captured in the preload's closure, with
enforcement in the main process (`tile-ipc-gate.ts` `runPipeline()`) and preload-side capability
checks as fast-fail convenience rather than as the boundary. Three things transfer directly and are
the reason the contract looks the way it does: the credential lives in a closure the feature cannot
reach; absent means absent; and every capability call is a message, so the transport underneath is
replaceable. What does not transfer is the rest of it — around forty namespaces against a worker's
seven, `api.datastore`'s roughly fifty methods against `PeekStore`'s fifteen usable ones
(`docs/workers-design.md` §6), a `trustedBuiltin` tier that has no meaning off a user's machine, and
`api.invoke()`, a raw IPC escape hatch that must not exist on any worker host. The desktop is where
the shape was learned, not a fifth adapter.

That said, the Node adapter run inside an Electron `utilityProcess`, against the local
`sqlite-store.js` instead of the remote one, is the same adapter with two substitutions — which is
what "workers run on your own laptop while it happens to be awake" would be, and is
`notes/design-vision.md`'s "decentralized compute option" in its cheapest form. Noted as a
consequence of the contract, not proposed as work: no `utilityProcess` path exists in
`apps/desktop/main/` today (`docs/workers-design.md` §1).

---

## 3. Three layers, only one of which is per-platform

The mistake to avoid is writing four hosts. There is one host, and four adapters under it.

| Layer | What it is | How many implementations |
|---|---|---|
| **Worker module** | Feature code. Imports nothing platform-specific, exports an entry function. | One per feature |
| **Worker host** | Peek code. Builds `api` from the manifest grant, imports the module, runs the entry function, enforces the lifecycle and the failure rule. | **One, shared** |
| **Platform adapter** | Supplies the primitives the host needs: module loading, a restricted `fetch`, the credential, the scheduler, the channel, the log sink. | One per target |

**Decision: the adapter boundary sits below the host, not below the worker.** The logic that turns
a manifest into an `api` object — which namespaces exist, which datastore methods the grant permits
(`docs/workers-capabilities.md` §5.1), how a `{success, data}` envelope is built over a throwing
`PeekStore` — is written once and is identical everywhere. If it were written per platform it would
drift per platform, and the drift would be silent and capability-relevant, which is the same
argument `docs/workers-capabilities.md` §3.1 makes for moving `resolveCapabilities()` into a shared
package, and the same failure `apps/server/schema.json` already demonstrated against
`packages/schema/v1.json`.

This is what makes the count of adapters tolerable, and it collapses further:

- **Bare Node and a container are one adapter.** A container running Node differs from a Linux box
  running Node in how the process is supervised and where the schedule comes from, not in anything
  the host can observe. Two targets, one adapter, two declarations (§4.3).
- **Cloudflare and celld are one adapter.** This is the surviving value of the superseded
  recommendation: celld's "JavaScript API is the same API that Cloudflare Workers and Durable
  Objects supply" (`docs/workers-design.md` §10.1), so one adapter written against that API
  deploys to both. Under the old stance this identity was the contract; under this one it is a
  two-for-one on a single adapter, which is most of the benefit at none of the cost.

So: four targets, two adapters, one host. Five targets and three adapters if workerd-on-your-own-box
is counted separately, and §5.5 argues it should not be — it is the Cloudflare adapter with a
different deployment.

---

## 4. The host contract, as an interface

One named operation per thing a host must have. The shape is a sketch; the operation list is the
decision.

### 4.1 What a worker exports

```ts
/** The only thing a feature author writes. `ctx` is optional: a worker that
 *  ignores it — as tools/hello-worker/worker.js does — stays valid. */
export type WorkerEntry = (api: WorkerApi, ctx?: RunContext) => Promise<unknown>;
```

The manifest names it: `worker: { url: "worker.js", entry: "hello" }`, falling back to the default
export. That is already what `tools/hello-worker/manifest.json` declares and what its host resolves
(`mod[manifest.worker.entry] ?? mod.default`).

### 4.2 What a run carries

```ts
interface RunContext {
  /** Why this run happened. A worker may branch on it; nothing requires it to. */
  readonly trigger:
    | { kind: 'schedule'; scheduledFor: number }   // epoch ms the run was due, not when it began
    | { kind: 'wake'; topic: string; message: unknown }
    | { kind: 'command'; name: string; params: unknown; resultTopic?: string };

  /** Epoch ms after which the adapter may kill this run. The floor across
   *  targets is 15 minutes (§6.1); a worker that needs more is not portable. */
  readonly deadline: number;

  /** Aborted at the deadline, and on shutdown. Passed to api.network.fetch by
   *  the host so a doomed run stops issuing requests. */
  readonly signal: AbortSignal;

  /** Keep the instance alive for work not awaited by the entry function.
   *  On adapters with no such concept this is `await`-equivalent (§6.6). */
  waitUntil(p: Promise<unknown>): void;
}
```

`scheduledFor` rather than "now" is deliberate: a run retried after a failure, or caught up after a
machine was off, must be able to tell what it was *for*. A worker that stamps `Date.now()` instead
writes a different answer on a retry than on the original, which is exactly the kind of difference
at-least-once delivery turns into duplicate data.

### 4.3 What an adapter declares

Some differences cannot be abstracted away, so the contract makes them **declared** instead. An
adapter states its semantics; the conformance suite (§8) verifies the declaration is true; the host
publishes it to worker authors and refuses schedules it cannot honour.

```ts
interface AdapterDeclaration {
  readonly name: string;

  scheduler: {
    /** May the same nominal run happen more than once? */
    atLeastOnce: boolean;
    /** Automatic retries after the entry function throws. */
    retriesOnFailure: number | 'none' | 'unspecified';
    /** Does a run due while the host was down happen late, or not at all? */
    catchesUpMissedRuns: boolean;
    minIntervalMs: number;
    /** How far from the nominal time a run may land. */
    precisionMs: number;
  };

  run: {
    maxWallClockMs: number;
    maxCpuMs: number | 'unbounded';
    memoryMb: number | 'unbounded';
    /** Does the platform guarantee one run of a given worker at a time? */
    singleFlight: boolean;
    /** Simultaneous outbound connections. */
    maxOutboundConcurrency: number | 'unbounded';
    /** Does Date.now() advance during synchronous execution? (§6.2) */
    clockAdvancesWithoutIo: boolean;
  };

  network: {
    /** 'guard-rail' — the module can route around it from inside the process.
     *  'egress-control' — it cannot. Nothing here is 'egress-control' yet. */
    enforcement: 'guard-rail' | 'egress-control';
  };

  install: {
    /** Can a newly installed worker's code be loaded without a redeploy? */
    codeLoad: 'runtime' | 'deploy';
  };

  isolation: 'isolate-per-worker' | 'process-per-run' | 'shared-process';
}
```

### 4.4 What an adapter must implement

```ts
interface PlatformAdapter {
  readonly declares: AdapterDeclaration;

  /** Return the worker's module namespace, bundled (docs/workers-design.md §13.4).
   *  MUST return a namespace not shared with any other live run — see §4.5. */
  loadWorkerModule(ref: WorkerRef): Promise<Record<string, unknown>>;

  /** A fetch restricted to the manifest's network.domains. The host installs the
   *  result as globalThis.fetch before importing the module, because real features
   *  call bare fetch() rather than api.network.fetch (docs/workers-design.md §2). */
  makeFetch(domains: string[], signal: AbortSignal): typeof fetch;

  /** Globals the module graph reads at import time — globalThis.app, and
   *  globalThis.window, which docs/workers-design.md §13.5 measured as required
   *  because both background.js and nouns.js read window.app on their first line. */
  installGlobals(globals: Record<string, unknown>): void;

  /** The grant credential, from the platform's secret storage. Returned to the
   *  host and to nothing else; the host puts it in a closure and never on any
   *  object the module can reach (docs/workers-capabilities.md §2.1). */
  readCredential(ref: WorkerRef): Promise<string>;

  /** Durable scheduling. The adapter owns persistence: a schedule survives the
   *  host process, the instance, and the machine. */
  ensureSchedule(ref: WorkerRef, spec: string): Promise<void>;
  cancelSchedule(ref: WorkerRef): Promise<void>;

  /** The duplex channel of docs/workers-design.md §9.4: pubsub out, pubsub and
   *  cmd:execute:<name> in. Long-poll, SSE or WebSocket — the adapter picks. */
  openChannel(ref: WorkerRef, onMessage: (m: ChannelMessage) => void): Promise<Channel>;

  /** Where api.log goes. */
  log(record: { level: 'info' | 'warn' | 'error'; worker: string; args: unknown[] }): void;
}

interface Channel {
  publish(topic: string, message: unknown): Promise<void>;
  close(): Promise<void>;
}
```

And the inbound half — what the adapter calls when a trigger arrives:

```ts
/** Implemented once, by the shared host. An adapter calls this and nothing else. */
interface WorkerHost {
  run(ref: WorkerRef, trigger: RunContext['trigger']): Promise<RunResult>;
}

type RunResult =
  | { ok: true; value: unknown; ms: number }
  /** A throw out of the entry function is fatal to the instance and never
   *  recovered in place — docs/workers-design.md §13.5 measured why: a caught
   *  throw leaves a half-registered feature in an undefined state. Whether the
   *  *run* is retried is the adapter's declared policy, not the host's choice. */
  | { ok: false; error: Error; ms: number };
```

### 4.5 One rule that is not obvious and is not negotiable

**`loadWorkerModule()` must return a module graph that no other live run shares.**

This falls out of a measurement already in the repo. `docs/workers-design.md` §13.4: 
`apps/desktop/renderer/cmd/nouns.js` evaluates `const api = window.app` once, at its own first
import, and holds it for the life of the module. Two runs importing the same specifier get one
cached module instance, so the second run's `registerNoun()` calls landed on the *first* run's API
object — after the second `init()`, the first API object held six noun subscriptions and the second
held none.

Bundling per install (settled there) removes sharing *between features*. It does not remove sharing
between two runs of the same feature in one process, because `import()` caches by URL. So each
adapter answers this explicitly:

- **Cloudflare / celld:** free. One isolate per Durable Object, and the object is the worker.
- **Node / container:** not free. Either one process per run — which is what
  `tools/hello-worker/run.mjs` does, by exiting — or a per-run cache-busting specifier
  (`import(url + '?run=' + n)`), which works and grows the module registry for the life of the
  process with no way to release it. A resident Node host therefore forks per run; the alternative
  is a leak that a long-lived host cannot survive.

An adapter that can do neither must declare `isolation: 'shared-process'` and may host exactly one
worker run at a time.

### 4.6 `tools/hello-worker/run.mjs`, read as an implementation

The script (on `track/hello-worker`) is an adapter and a host fused into one file, which is the
right shape for a proof and the wrong one for a fleet. Against §4.4:

| Operation | In `run.mjs` |
|---|---|
| `loadWorkerModule` | **Yes.** `await import(pathToFileURL(...).href)`, then `mod[manifest.worker.entry] ?? mod.default`. Unbundled, single-file; the §4.5 rule holds only because the process exits after one run. |
| `makeFetch` | **Yes**, as `installNetworkGuard(domains)` from `tools/feeds-worker-spike/worker-api.mjs` — replaces `globalThis.fetch`, checks the hostname against `capabilities.network.domains`, throws on a miss, and logs every request. No `signal`. |
| `readCredential` | **Yes.** The 0600 `$HOME/.config/peek/mcp-credentials.json`, keyed `"<url>#peek"`, normalized through `normalizeCredentialKey()`. Stops rather than minting a grant when none resolves. |
| Credential custody | **Yes**, and it is the part most worth copying: the token goes into `openRemoteStore({ remoteUrl, credential })`, which captures it as `token` in a closure only `request()` reads, and `buildHelloApi({ store })` closes over the *store*, never the token. Nothing on `api` carries it. |
| `log` | **Yes**, as `console.log` with a `[worker]` prefix. |
| `run` / failure rule | **Yes.** One run, `await entry(api)`, and any throw exits non-zero — the §4.4 fatal rule, in its smallest form. |
| `installGlobals` | **No.** It passes `api` as a parameter and sets no globals. Sufficient for `worker.js`, which takes `api` as an argument; insufficient for any real feature, because `docs/workers-design.md` §13.5 measured that `background.js` and `nouns.js` read `window.app` at import time. |
| `ensureSchedule` / `cancelSchedule` | **No.** `manifest.json` declares `"schedule": "every 15m"` and nothing honours it. Its own README says so. |
| `openChannel` | **No.** No pubsub, no commands, no `cmd:execute:<name>`. |
| `RunContext` | **No.** No trigger, no deadline, no `AbortSignal`, no `waitUntil`. |
| `declares` | **No.** No declaration, so nothing downstream can know its semantics. |
| Capability-shaped `api` | **Partially.** `buildHelloApi()` hand-writes `log` and a one-method `datastore`; it does not build from the grant, and the manifest's `datastore: {}` is not consulted. §3's shared host is exactly this logic, written once and driven by the grant. |

So: six of eleven, and the five missing ones are the five that need a runtime rather than a script.
That is the honest measure of how far a worker has actually got.

### 4.7 `tools/second-worker`, read as the next implementation

`tools/second-worker` (this branch) is the case §8 argues for: not a bigger worker, but
`hello-worker`'s shape extended with a manifest that denies a network domain, a schedule that fires
twice, and a channel that delivers one command. Its `worker.js` reads `ctx`; its `run.mjs` supplies
the five operations §4.6 found missing, each in a function named after the operation it implements:

| Operation | In `tools/second-worker/run.mjs` |
|---|---|
| `installGlobals` | **Yes.** Sets `globalThis.app` and `globalThis.window.app` before every import — the exact pair §4.4's own comment names as required. |
| `ensureSchedule` / `cancelSchedule` | **Yes, non-durably.** An in-process `setInterval` standing in for the "resident supervisor" §5.1 says a bare Node target needs; it produces two distinct `RunContext`s with two distinct `scheduledFor` values, which is what §4.2 asks of a schedule, but it does not survive the process and proves nothing about restart durability — unlike the workerd alarm measured in §5.5, nothing here is written to disk. |
| `openChannel` | **Yes, simulated.** A `deliver()` escape hatch stands in for a real inbound transport, matching the honesty `tools/feeds-worker-spike/worker-api.mjs`'s own pubsub comment states about itself: nothing outside the process delivers to it. One command is delivered this way, dispatched through the same `runWorker()` the schedule uses. |
| `RunContext` | **Yes**, as the second parameter — see the decision below. Exercises `trigger` (branching on `kind`), `deadline` (logged), and `waitUntil` (wraps the command's result publish). `signal` is constructed and passed but not read by the worker or wired into the network guard — both named as gaps in `tools/second-worker/README.md`. |
| `declares` | **Yes.** A filled-in `AdapterDeclaration` (§4.3), honest about what this script is: `isolation: 'shared-process'`, not `'process-per-run'`, because every run happens in one OS process. |
| §4.5 fresh module graph | **Verified live, not just claimed.** `worker.js` exports `capturedApi`, captured at its own import time; `runWorker()` compares it against the `api` object it just installed and logs a warning if they differ. Checked by hand during development: removing the cache-busting specifier in `loadWorkerModule()` flips every run after the first to the warning, confirming the check catches the exact failure §4.5 is written against (`docs/workers-design.md` §13.4's `nouns.js` measurement) rather than passing regardless. |

**Decision: `RunContext` is a second parameter to the entry function, not a namespace on `api`.**
Open question 4 asked this; writing `tools/second-worker/worker.js` settled it, for a reason that
only surfaced once a worker had to actually read `ctx.trigger` and `ctx.waitUntil`. `api`'s contract
is presence-means-granted: a namespace exists exactly when the manifest's grant permits it, and
absence is a `TypeError` at the call site (§2, §7). `ctx`'s fields are not gated by any grant —
every worker gets a trigger, a deadline and a `waitUntil` regardless of what its manifest declares.
Folding them into `api` as `api.run.*` would put two different kinds of fact behind one object's
presence rule: "what this worker may do" and "why this run is happening." `onCommand()` in
`tools/second-worker/worker.js` makes the distinction concrete — it reads `ctx.trigger.name` and
`ctx.trigger.resultTopic`, which exist because of *this run's cause*, next to `api.publish`, which
exists because of the *manifest's grant*. A worker author asking "can I do X" and "why am I running"
would be asking both of an `api.run.*` object that answers "present" for a different reason each
time. The second parameter keeps that boundary legible instead of asking one object to mean both
things. See `tools/second-worker/README.md`'s "What this settles" for the fuller argument.

---

## 5. What each target supplies, and what it cannot

Facts without a URL here come from `docs/workers-design.md` §10, fetched 2026-08-18. Facts with a
URL were fetched 2026-09-16 for this document.

### 5.1 Bare Node process on a Linux box

| Operation | Answer |
|---|---|
| `loadWorkerModule` | Yes, at runtime, from a file a moment ago downloaded. `import()` of a `file://` URL. Live `peek://` resolution also works — `module.registerHooks()`, ~2ms, forty lines (§13.4) — and is not used, because bundling is settled. |
| `makeFetch` | Yes; measured at about twenty lines, and the feature did not notice (§13.2). **Guard-rail only:** a module can reach the network through `node:http` without touching `fetch`. |
| `installGlobals` | Yes, unrestricted. |
| `readCredential` | Yes: a 0600 file, or the environment. |
| `ensureSchedule` | **Cannot, from inside the process.** This is the target's defining gap. The schedule has to come from the OS (a systemd timer, cron) or from a resident supervisor. §6.1 has the semantics. |
| `openChannel` | Yes — but only while a process is running, which a per-run process is not. Receiving a wake or a command therefore requires a **resident supervisor**: a process that holds the channel and forks a run per message. That supervisor is the host; the worker instance is still stateless. |
| `log` | Yes: stdout, journald. |
| Isolation | **None.** Two features in one process share globals, prototypes and the module registry. A bare Node host cannot safely run third-party feature code, which is the whole of why this is a stage-one target (§1). |
| Budgets | Unbounded wall clock, CPU and memory. Which makes it the one target where exceeding the portable floor is invisible until the worker moves. |

### 5.2 Cloudflare Workers plus Durable Objects

| Operation | Answer |
|---|---|
| `loadWorkerModule` | **Deploy-time only.** `eval()` and `new Function` are refused — "For security reasons, the following are not allowed: `eval()` [and] `new Function`" (`https://developers.cloudflare.com/workers/runtime-apis/web-standards/`, last updated Apr 23 2026). A module has to be in the deployed bundle, so `loadWorkerModule` is a lookup in a build-time map, and **installing a worker is a deploy**. |
| `makeFetch` | Yes, and the shadow holds better here than anywhere: `node:http` is not present unless `nodejs_compat` is enabled, and enabling it puts the escape back. Still a guard-rail, not egress control. |
| `installGlobals` | Yes. |
| `readCredential` | Yes: a secret binding on `env`, read by the host and never placed on `api`. |
| `ensureSchedule` | Yes, and best in class: Durable Object alarms, one per object, unbounded objects, at-least-once with automatic retry (exponential backoff from 2s, up to 6 retries), surviving eviction. Cron exists and is capped at three per Worker. |
| `openChannel` | Yes: WebSocket, including hibernation. |
| `log` | Yes. |
| Isolation | `isolate-per-worker`. The platform's premise, and the reason it is the stage-two target. |
| Budgets | 15 minutes wall clock for an alarm handler; 30s CPU default, configurable to 5 minutes; **128 MB** memory per isolate; **6 simultaneous outbound connections**; 10,000 subrequests paid. |
| Cannot | Load code at runtime. `DOMParser` — absent from the web-standards list on the page above, matching §10's finding that no candidate has it. Arbitrary Node APIs: `nodejs_compat` is "a subset", with unenv polyfills that raise `[unenv] <method> is not implemented yet!`. Advance its own clock without I/O (§6.2). |

The install gap deserves naming rather than a footnote. Peek installs features from atproto —
`apps/desktop/main/atproto-source.ts` resolves an `at://` URI and `feature-installer.ts`
`installFromBundle()` installs the bundle. On Node that same bundle is importable a second later. On
Cloudflare it is a deploy, and a per-user, per-feature deploy is a different operational shape
entirely. The mechanism that exists for this is Workers for Platforms dispatch namespaces;
whether it fits, and what it costs, is **unverified** — nothing was fetched about it for this
document, and it is §10.1.

### 5.3 celld

Per `docs/workers-design.md` §10.1 (sources fetched 2026-08-18): the same JavaScript API as
Cloudflare, so the same adapter. Differences that matter to the contract:

| Operation | Answer |
|---|---|
| `ensureSchedule` | Alarms, yes. **Cron, no** — "cron triggers" are under "Not planned", and there are "No scheduled (cron), queue, tail, or email handlers." Since the contract compiles schedules to alarms anyway, this costs nothing. |
| `openChannel` | WebSocket, with a caveat: "An outbound Durable Object WebSocket keeps its cell resident, and the connection does not continue when the cell moves to a different node." Survivable because nothing may depend on instance continuity — a dropped socket is a reconnect. |
| `loadWorkerModule` | Deploy-time, via `celld deploy` (esbuild). Same install shape as Cloudflare, and a fleet that "runs one application deployment" makes the per-install question sharper, not softer. |
| Isolation | **Declared unsafe for the case that needs it:** "not safe for hostile multi-tenant use", operator API unauthenticated, peer protocol does not terminate TLS, updates manual, alpha at `v0.0.1`. |
| Ownership | Self-hosted, operator's own bucket, Apache-2.0. Which is the entire point of keeping it in the set. |

### 5.4 A container

Everything in §5.1, plus a supervisor that is always there, minus nothing — and then the three
things `docs/workers-design.md` §10.3 already names have to be built: a scheduler, a wake path, and
isolation between features. The first two the contract absorbs (they are `ensureSchedule` and
`openChannel`, and the Node adapter needs them anyway). The third it does not: a container's
isolation boundary is the container, so isolating features means one container per feature per
user, which turns a $2/month preset into a bill that scales with installs and reintroduces cold
start at every one of them.

Container and bare Node share an adapter and differ in their declaration: a container is
`process-per-run` with a supervisor that is reliably resident, so `openChannel` is practical and
`catchesUpMissedRuns` depends on the scheduler chosen rather than on whether a laptop was shut.

### 5.5 workerd on your own machine — the fifth target, and why it is not a fifth adapter

workerd is the Workers runtime as a standalone Apache-2.0 binary: `workerd serve my-config.capnp`,
prebuilt via npm, glibc 2.35+ and SSE4.2/CLMUL on x86-64
(`https://github.com/cloudflare/workerd`, fetched 2026-09-16). It is also the runtime under local
development — "Miniflare, a simulator that executes your Worker code using the same runtime used in
production, `workerd`" — where bindings "connect to local resource simulations", are "not connected
to the Cloudflare network", and Durable Objects "currently will always run locally"
(`https://developers.cloudflare.com/workers/local-development/`, last updated Aug 20 2026).

So it is a genuine way to run the Cloudflare adapter on hardware Peek owns, and it is the answer to
"what if Cloudflare is not acceptable but celld is too alpha". One limit resolved, one standing:

- **A pending Durable Object alarm survives a standalone workerd restart.** Measured directly,
  2026-09-22, `workerd` 1.20260922.1 (`npx workerd`, prebuilt Linux binary), against a
  single-object config with `durableObjectStorage = (localDisk = ...)`: an alarm was set 30 seconds
  out, the process was killed with `SIGKILL` while it was still pending, restarted immediately, and
  left completely untouched — no request of any kind — until 26 seconds past the alarm's due time.
  The first request made after that point read back `alarm()` having already run, timestamped
  1,790,067,587,294ms — 3ms after the 1,790,067,587,291ms the alarm was originally set for, and
  strictly before the request that observed it. Because nothing touched the object between the
  restart and the observation, the alarm did not run lazily in response to being read; `workerd`'s
  own scheduler tracked and fired it while nothing was asking. The `<uniqueKey>/<id>.sqlite` file
  the object's storage produces on disk is what makes this possible: the alarm timestamp is part of
  the durable object's own storage, which `localDisk` writes to a real file, so a restart reads the
  same file back rather than starting from nothing. This answers the question this document opened
  with only as far as "one object, one process, one restart" — nothing here tests a second node, a
  crash mid-write, or many objects, and celld's own replication story (per-cell SQLite mirrored to
  the operator's bucket) is a different durability mechanism this experiment says nothing about.
  Within that scope: self-hosting the Cloudflare adapter on a Linux box is a real option for
  scheduling, not only a development convenience.
- **"workerd is not a hardened sandbox"**, per its own README, with malicious code requiring "an
  appropriate secure sandbox, such as a virtual machine". So it does not inherit Cloudflare's
  isolation answer for stage two by running the same code. Unaffected by the measurement above.

It counts as a deployment of the Cloudflare adapter, with its own declaration.

### 5.6 The contract against the targets, in one table

`cannot` means the platform does not provide it and the adapter must obtain it elsewhere or the
target is unusable for that operation.

| Operation | Bare Node | Cloudflare + DO | celld | Container |
|---|---|---|---|---|
| `loadWorkerModule` | yes, at runtime | **deploy-time only** (no `eval`/`new Function`) | deploy-time only | yes, at runtime |
| `makeFetch` | yes, guard-rail (`node:http` escapes) | yes, guard-rail (tighter without `nodejs_compat`) | yes, guard-rail | yes, guard-rail |
| `installGlobals` | yes | yes | yes | yes |
| `readCredential` | yes (0600 file / env) | yes (secret binding) | yes | yes |
| `ensureSchedule` | **cannot** — OS timer or resident supervisor | yes, DO alarms | yes, alarms; **no cron** | **cannot** — must be built |
| `openChannel` | only with a resident supervisor | yes, WebSocket + hibernation | yes; breaks on cell move | yes |
| `log` | yes | yes | yes | yes |
| §4.5 fresh module graph | fork per run, or leak the registry | free (isolate per object) | free | fork per run |
| Isolation for untrusted code | **none** | isolate-per-worker | **declared unsafe** | **not provided** |
| `DOMParser` | no (shim: `linkedom`, measured) | no | no | no (shim available) |

---

## 6. What leaks through the seam regardless

A contract that claimed to hide these would be lying, and a worker author who believed it would
write something that works on one target and corrupts data on another.

### 6.1 Scheduler semantics — the sharp one

Four schedulers, four sets of semantics:

- **Durable Object alarms** (Cloudflare, celld): at-least-once, automatically retried when
  `alarm()` throws, "exponential backoff starting at a 2 second delay from the first failure with
  up to 6 retries allowed", surviving eviction, with the handler possibly "re-instantiated on
  another machine" and run "from the beginning". A maximum scheduling distance into the future is
  **not published**. (`docs/workers-design.md` §10.2, fetched 2026-08-18.)
- **Cloudflare cron triggers**: capped at three per Worker; executes on UTC. The retry story is
  murkier than the alarm's and is worth stating precisely, because the difference is the reason the
  contract does not use cron. The cron triggers page documents a `noRetry` field that is "true when
  the scheduled handler calls `controller.noRetry()`"
  (`https://developers.cloudflare.com/workers/configuration/cron-triggers/`, last updated Sep 4
  2026), so the platform has a retry concept for scheduled invocations — but neither that page nor
  the scheduled-handler page (`https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/`,
  last updated Sep 4 2026) states the default policy, and the latter does not document
  `noRetry()` at all among `controller.cron`, `controller.scheduledTime` and `controller.type`.
  Both fetched 2026-09-16. **So: retries exist, the default is not published.** An alarm's policy
  is published; a cron's is not. That asymmetry alone settles which one a portable contract builds
  on.
- **systemd timers** (bare Node, container): `Persistent=true` stores when the service was last
  triggered and, on reactivation, "the service unit is triggered immediately if it would have been
  triggered at least once during the time when the timer was inactive" — catch-up, but it defaults
  to false and applies only to `OnCalendar=`. `AccuracySec=` defaults to **1 minute** and coalesces
  events; `RandomizedDelaySec=` defaults to 0. Overlap is refused rather than queued: "if the unit
  to activate is already active at the time the timer elapses it is not restarted, but simply left
  running." The page says nothing about retrying a run that failed — a failed run is a failed unit,
  and any retry comes from the service's own `Restart=`, which is a different mechanism with
  different semantics. (`https://man7.org/linux/man-pages/man5/systemd.timer.5.html`, fetched
  2026-09-16.)
- **A resident supervisor's own timer** (bare Node, container): whatever it implements. Nothing
  durable unless it persists its next-run time somewhere that survives the process, which means it
  has re-implemented the durable part badly or delegated it.

Three differences no abstraction removes: **at-least-once versus at-most-once**, **catch-up versus
skip**, and **precision** (milliseconds for an alarm, a minute for a systemd timer by default).

**Decision: the contract promises at-least-once and promises nothing about catch-up or precision.**
At-least-once is the strictest common denominator that is honest — an adapter that in fact never
retries (a systemd timer) still satisfies "may run more than once", because a worker written for
at-least-once is correct under at-most-once. The reverse is not true, and would produce duplicate
items the first time a worker moved to Cloudflare. Every worker is therefore written to be safe run
twice for the same `scheduledFor`, which is the same rule `docs/workers-design.md` §4 already
derived from state living in the Peek store.

### 6.2 The clock does not advance the same way

On Workers, "APIs that return timers, including `performance.now()` and `Date.now()`, only advance
or increment after I/O occurs" — a Spectre mitigation — and `performance.timeOrigin` "returns 0"
(`https://developers.cloudflare.com/workers/runtime-apis/performance/`, last updated Apr 23 2026,
fetched 2026-09-16). So a worker timing a loop measures 0. On Node it measures the loop.

The trap is in the same page: in local development with Wrangler "timers increment normally". The
divergence is therefore invisible in the place a developer would look for it, which is why §8 makes
it a probe run against a real deployment rather than a rule in a document.

### 6.3 Installing a worker is a file on one target and a deploy on another

§5.2. `install.codeLoad` is declared rather than hidden, because the difference is not one the host
can paper over: a runtime-load adapter can install a worker between two invocations, and a
deploy-load adapter cannot install one at all without a deployment pipeline that has a copy of the
bundle.

### 6.4 Concurrency and single-flight

A Durable Object serialises its own requests, so `singleFlight: true` comes free. Node and a
container get nothing, and two overlapping runs of a polling worker produce duplicate items —
absorbed in part by Peek's `syncId` dedup (`docs/workers-design.md` §9.8), not eliminated.

**The contract promises nothing here**, so every worker must be idempotent regardless. An adapter
that can offer single-flight declares it and workers get a cheaper failure mode on that target
without being allowed to depend on it.

### 6.5 The language floor, and what happens below it

`DOMParser` is absent from every target (§5.6), so it is a tax the feature pays: `linkedom` — already
a dependency of the root and `apps/desktop` — parsed real RSS and Atom with no change to
`parseFeed()` (`docs/workers-design.md` §13.5). `node:` builtins are the mirror image: present and
unrestricted on Node and in a container, a documented subset on Workers where unenv polyfills throw
`[unenv] <method> is not implemented yet!`, and unavailable in the parts of the surface that make
the network guard a guard at all (§5.2).

**A worker that imports `node:*` is not portable, and nothing at runtime will tell it so** — it will
work perfectly on the target where it was written. This is the strongest argument for the linter
`docs/workers-design.md` §5 already proposes for `api.window.`: the same pass rejects `node:`
imports and bare `setInterval` in a module the manifest declares as a worker entry point, before
anything is deployed.

### 6.6 Budgets

15 minutes wall clock and 128 MB are Cloudflare's, and therefore the fleet's, because a portable
worker is bounded by its tightest target. Node and a container have no such bound, so a worker
written there can exceed the floor silently. `RunContext.deadline` exists so that the bound is
visible on *every* target: the Node adapter enforces the declared budget rather than inheriting the
absence of one, and a worker that would have run for twenty minutes fails on the box where it was
written instead of the first time it is moved.

`waitUntil` degrades the other way: where the platform has no such concept the host awaits the
promise before finishing the run, which is slower and never wrong.

### 6.7 Where the network capability is enforced, on every target

Nowhere well. The guard is `installNetworkGuard()`'s shape on all four: replace `globalThis.fetch`
before importing the module, check the hostname against `capabilities.network.domains`, throw on a
miss. It is cheap and it works — twenty lines, every request logged, the feature did not notice.
It does not *hold*: on Node the module reaches `node:http`; on Workers it can if `nodejs_compat` is
on. This is `docs/workers-capabilities.md` §3.3's finding — the one capability whose enforcement
sits irreducibly on the untrusted side — and the contract does not fix it. It makes it declared
(`network.enforcement`), so that the day an adapter routes egress through a proxy, the difference
is legible rather than assumed.

---

## 7. What a worker author is promised

The whole of it, in the form an author needs.

**Promised on every target:**

- The entry function runs with an `api` object containing exactly the namespaces the manifest's
  grant permits. Anything else is `undefined`, and touching it is a `TypeError` at the line
  responsible.
- It runs at or after `ctx.trigger.scheduledFor`, and before `ctx.deadline`.
- Anything written through `api.datastore` reaches the same per-user, per-profile database the
  desktop syncs against, and appears on a device at its next sync.
- `api.log` output is retrievable.
- A throw out of the entry function ends the run. Nothing continues past it.
- The credential is not reachable from feature code, on any target.

**Not promised, and an author who assumes any of these has written a worker that works on one
target:**

- **That a run happens exactly once.** It may happen twice for one `scheduledFor`.
- **That a missed run is caught up.** It may simply not have happened.
- **That the schedule is precise.** A minute of slack is within spec.
- **That two runs do not overlap.**
- **That anything survives between runs.** Module-level state, a timer, an open socket: gone. The
  Peek store is the only memory.
- **That `Date.now()` advances during computation.** Measure elapsed time across I/O or not at all.
- **That `setInterval` does anything.** It either never fires or pins an instance that should have
  exited (`docs/workers-design.md` §4).
- **That more than six outbound requests can be in flight**, or that unbounded memory is available,
  or that a run may take longer than fifteen minutes.
- **That `node:` builtins exist.** They are not part of the floor.
- **That the network capability confines it.** It is a guard-rail. The confinement that exists is
  the credential's scope, server-side (`docs/workers-capabilities.md` §3.2).

---

## 8. Conformance

A target counts as a supported one when a new adapter passes the suite. The suite has two kinds of
check, and the split is the design:

- **Assertions** are identical on every target. They are the contract. An adapter that fails one is
  not an adapter.
- **Declarations** are where targets legitimately differ. The adapter states its semantics in
  `AdapterDeclaration` and the suite checks that the statement is *true*, not that it matches some
  preferred answer. A systemd timer that declares `catchesUpMissedRuns: false` passes; one that
  declares `true` and does not, fails.

**Assertions:**

1. **Load and run.** `tools/hello-worker` runs to completion and returns the session from
   `api.datastore.describe()`.
2. **Absent is absent.** A probe worker reads `api.window`, `api.shortcuts` and `api.filesystem`
   and reports `typeof`. All three must be `'undefined'`; no stub, no rejecting promise.
3. **The credential is unreachable.** A probe worker walks `api` recursively — own and inherited
   properties, function `toString()` included — and reports any string matching the credential the
   harness minted. The count must be zero. This is `docs/workers-capabilities.md` §8.1 item 1 turned
   into something that fails a build.
4. **Fresh module graph per run.** Two runs of a worker whose bundled dependency captures
   `window.app` at import time. Each run's captured object must be its own. This is §4.5, and the
   measurement in `docs/workers-design.md` §13.4 is the failure it is written against.
5. **The network guard denies.** A manifest allowing one domain, a worker fetching another; the
   fetch must throw and the run must fail.
6. **A throw is fatal.** A worker that throws mid-entry produces `{ok: false}` and no further
   execution of that instance.
7. **Statelessness.** A worker increments a module-level counter and writes it through
   `api.datastore`. Across two runs, the store must show the worker's own persisted value, never a
   surviving in-memory one.
8. **The deadline bites.** A worker that sleeps past `ctx.deadline` is aborted, on every target,
   including the ones with no platform-imposed budget (§6.6).

**Declarations to verify:**

9. `scheduler.atLeastOnce` / `retriesOnFailure` — a worker that throws on a scheduled run; count
   the runs the store records.
10. `scheduler.catchesUpMissedRuns` — stop the host across a due time, restart, observe.
11. `scheduler.precisionMs` — record the distribution of `actual − scheduledFor` over several runs.
12. `run.singleFlight` — two triggers at once; count concurrent runs.
13. `run.clockAdvancesWithoutIo` — a busy loop reporting `Date.now()` deltas. **Must run against a
    real deployment**, since local Wrangler does not reproduce the pinning (§6.2).
14. `network.enforcement` — a worker that tries `node:http` after the guard is installed. Reaching
    the network means `guard-rail`, and that is a legal answer; declaring `egress-control` while
    reaching it is a failure.
15. `install.codeLoad` — install a worker and invoke it without redeploying.

**What `tools/hello-worker` proves, and what it does not.** It proves assertions 1 and 2 on one
target, and it demonstrates 3 by construction (the credential enters `openRemoteStore()` and the
API object closes over the store, not the token) without testing it. It proves the host shape is
real on a plain Node process with no Electron: a manifest with a JS entry point, an API object built
from grants, one authenticated read against a deployed server, a network log showing that one
request and no other.

It does not prove: anything about a schedule (its `"every 15m"` is declarative and nothing honours
it), anything about pubsub or command dispatch, anything about a second run, anything about
concurrency, anything about the network guard *denying* — its manifest allows `*`, so the guard has
never said no in this worker — and anything at all about a target other than Node. It also runs an
entry function that never touches `window.app`, so §4.5's sharpest requirement is untested by it.

The next case after hello-world is therefore not a bigger worker. It is the same worker with a
manifest that denies, a schedule that fires twice, and a channel that delivers one command —
`tools/second-worker` (§4.7). It closes most of that list: assertion 4 (fresh module graph,
verified live rather than by construction), the network guard actually denying a real fetch attempt
rather than never being asked to, a schedule producing two distinct `RunContext`s, and one command
dispatched through a channel with `ctx.waitUntil` used for the result. `tools/second-worker/README.md`
states what even it does not prove — a target other than one Node process, `ctx.deadline` actually
biting, `ctx.signal` reaching a network call, and any durability at all for its schedule or channel,
all of which stay open for whatever exercises a second target.

---

## 9. What this costs

A design that only lists benefits has not been thought about.

- **Peek now owns an interface.** It has to be versioned, documented and kept honest as adapters are
  written, and the first two adapters will teach it things that change it. Adopting the Cloudflare
  API avoided all of that work by inheriting someone else's interface, complete with their
  documentation and their compatibility guarantees. That is a real cost and it is paid in
  perpetuity.
- **The contract will drift toward the first adapter.** Whatever the Node host finds easy will look
  like the natural shape, and the Cloudflare adapter will discover the places where it was not. The
  only defence is writing the second adapter before the first one has too much weight — which is an
  argument for keeping the conformance suite ahead of the adapters, not behind them.
- **A floor means giving up ceilings.** A worker on Cloudflare cannot use Durable Object SQLite,
  WebSocket hibernation, Queues, or anything else that would make it better there, because using
  them makes it unportable. Peek has already decided against DO storage for its own reasons (§1), so
  the immediate loss is small — but the rule is a standing tax on every future platform feature, and
  there is no mechanism that stops a worker author reaching past the floor on the target they
  happen to be using. A linter catches the known cases (§6.5). It will not catch the next one.
- **Two adapter families is two, not one.** The old recommendation's real economy was that celld and
  Cloudflare are one implementation. That economy survives (§3), but the Node/container family is
  genuinely new code — a supervisor, a scheduler binding, a fork-per-run loop, a channel client —
  none of which the Cloudflare API would have required writing.
- **The isolation problem is deferred, not solved.** A bare Node process has no isolation and the
  contract does not give it any. That is acceptable only because stage one is bundled features
  only. If that staging decision is ever revisited — if a third-party worker is allowed to run
  before the Cloudflare adapter exists — this document's argument collapses and §11's original
  recommendation is the right one again.
- **"Runs unchanged" is a claim the suite has to keep true.** The value of the whole design is that
  a worker module moves without edits. Nothing enforces that except conformance runs on every
  target, which is CI against a deployed Cloudflare account and a live Linux box, forever. An
  unmaintained suite turns the contract back into a document.

---

## 10. Open questions

1. **How a worker is installed on a deploy-load target.** §5.2. Cloudflare cannot load code at
   runtime, so a per-user, per-feature install is a deployment. Workers for Platforms dispatch
   namespaces are the mechanism that exists for this shape; whether they fit Peek's model and what
   they cost is **unverified — nothing was fetched about them for this document**. Until it is
   answered, the Cloudflare target supports a fixed set of bundled workers deployed together, which
   is exactly stage one and no further. **Settled by:** reading the Workers for Platforms docs and
   pricing against the one-grant-per-worker model.

2. ~~Whether a pending Durable Object alarm survives a standalone workerd restart.~~ **Settled,
   2026-09-22 (§5.5): yes.** An alarm set 30 seconds out fired within 3ms of its scheduled time
   after a `SIGKILL` and restart, with zero requests made to the object between the restart and the
   observation — so the firing was the runtime's own scheduler, not a side effect of being read.
   Scope: one object, one process, one restart; a second node and a crash mid-write are untested.

3. **What the Node adapter's resident supervisor actually is.** §5.1 establishes that a wake or a
   command needs a process holding the channel, and that a run needs a fresh module graph. A
   supervisor that forks per run satisfies both and pays a process launch each time — ~145ms of
   bootstrap by the measurement in `docs/workers-design.md` §13.7, which is small against the
   775–879ms that document measured for a real poll. Whether that is systemd-supervised, a single
   long-running Node process, or something the container adapter shares is undecided, and the
   schedule's durability answer depends on it.

4. ~~Whether `RunContext` is worth its second parameter.~~ **Settled (§4.7): yes, as a second
   parameter, not `api.run.*`.** `api`'s namespaces exist exactly when the manifest's grant permits
   them; `ctx`'s fields exist on every run regardless of any grant. Folding them together would ask
   one object's presence to mean two different things. `tools/second-worker/worker.js` is the
   worker this was settled by.

5. **Whether the shared host is a package or a copy.** §3 depends on the host being one
   implementation. `docs/workers-capabilities.md` §3.1 already commits `resolveCapabilities()` and
   the capability types to a shared package alongside `packages/schema` and `packages/sync`; the
   host belongs in the same place for the same reason. The cost is that a Cloudflare bundle now
   carries it, which is nothing against a 10 MB limit, and that the desktop, the server and the
   worker host share a release cadence, which is not nothing.

6. **Where the conformance suite runs, and who pays for it.** §9's last bullet is the whole risk of
   this design. A suite that needs a deployed Cloudflare account, a live Linux box and a deployed
   `apps/server` to be meaningful is a suite that will be skipped. **Settled by:** deciding which
   assertions can run against a local fake — 2, 3, 4, 6 and 8 can; 13 and 15 explicitly cannot — and
   making that split explicit, so the cheap ones can gate every commit and the expensive ones a
   release.
