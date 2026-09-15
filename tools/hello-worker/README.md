# hello-worker

The smallest possible Peek worker: a manifest whose `worker` entry names a
JavaScript module (not an HTML file), a module that says hello, and a host
script that runs it with no Electron and no window — the shape
`docs/workers-design.md` §2–§5 describes, proved on something simpler than
`feeds`. See `tools/feeds-worker-spike/` for the harness this one reuses
pieces of (`installNetworkGuard()`, `memory-store.mjs`) rather than forking.

## Files

- `manifest.json` — `manifestVersion: 3`, an `id`, a `worker: { url, entry,
  schedule }` block, and the two capabilities the worker uses (`datastore`,
  `network`). `tiles: []` because this worker has no window half.
- `worker.js` — the entry function `hello(api)`: logs a greeting through
  `api.log`, then makes one read-only call — `api.datastore.describe()`,
  mapped straight to `PeekStore.describe()` / `GET /mcp/session` — and logs
  what it returns. It only ever touches `api.log` and `api.datastore`; every
  other namespace is absent, not stubbed, so a call to e.g. `api.window`
  fails with a `TypeError` at the line responsible rather than continuing
  past a plausible-looking no-op.
- `run.mjs` — the host: reads `manifest.json`, builds the API object over
  either store mode below, holds the sync credential in a closure `worker.js`
  cannot reach, imports `worker.js`, runs its entry function once, and exits
  non-zero on any throw.

## Running it

Offline, against an in-memory store, no network:

```bash
node tools/hello-worker/run.mjs --memory
```

Against the deployed sync server:

```bash
PEEK_SYNC_URL=<the deployed server URL> node tools/hello-worker/run.mjs
```

The credential is resolved the same way `tools/feeds-worker-spike/run.mjs`
resolves one: the 0600 file at `$HOME/.config/peek/mcp-credentials.json`,
keyed `"<PEEK_SYNC_URL>#peek"`. If no usable credential resolves, the run
stops with an error naming the missing key rather than minting a grant. The
token itself is never printed, logged, or handed to `worker.js` — only
`store.describe()`'s result crosses that boundary.

## Sample output

Offline:

```
--memory: no network, the in-memory store stands in for the deployed one.
[worker] hello from hello-worker
[worker] sync server reports scope "socket-proof" (readonly: false, profile: memory, backend: memory)

--- network
  manifest allows: *

hello-worker ok.
```

Against the deployed server:

```
[worker] hello from hello-worker
[worker] sync server reports scope "peek" (readonly: false, profile: <profile id>, backend: remote)

--- network
  manifest allows: *
  allow  <server host>  https://<server host>/mcp/session

hello-worker ok.
```

The network log at the end lists every request the process made — one `GET
/mcp/session`, nothing else — which is the evidence that the run made no
writes against the deployed store.

## What this does not do

No `init()`/`onShutdown` lifecycle: `docs/workers-design.md` §4 says a worker
is stateless between invocations, and hello-worker holds no state for a
shutdown callback to tear down, so `run.mjs` imports `worker.js` and calls
its entry function directly. No pubsub, no commands, no scheduler — the
manifest's `worker.schedule` is declarative only; nothing in this directory
honors it, because there is no runtime here to honor it against (§9 of the
design document is exactly the list of what a real runtime would still have
to provide).
