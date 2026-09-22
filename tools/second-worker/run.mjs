/**
 * Runs `worker.js` the way `tools/hello-worker/run.mjs` runs its own worker,
 * extended with the five host operations that one never exercised:
 * `installGlobals`, `ensureSchedule`, `cancelSchedule`, `openChannel`, and a
 * `RunContext` second parameter (docs/worker-runtime-portability.md §4.4,
 * §4.6). Read together with that document's §4, this file is the sketch
 * there, made to actually run — one named function per operation, and a
 * `runWorker()` that is the document's `WorkerHost.run()`.
 *
 * A deliberate simplification against a real Node adapter
 * (docs/worker-runtime-portability.md §4.5, §5.1): a real resident host
 * forks a fresh OS process per run, because a long-lived process leaks one
 * module-registry entry per run otherwise (import() caches by specifier
 * forever, with no way to evict an entry). This script instead re-imports
 * worker.js under a cache-busting specifier (`?run=N`) and exits after three
 * runs, so the leak never has anywhere to accumulate. It still gets a fresh
 * module graph per run — `runWorker()` proves it, the same way conformance
 * assertion 4 does — but it is not the shape a long-lived supervisor should
 * copy, which is why `declaration.isolation` below says `shared-process`
 * rather than `process-per-run`: everything here runs in one OS process, and
 * the module-graph freshness is a narrower guarantee than that label
 * promises.
 *
 * Nothing here is durable. `ensureSchedule` is an in-process `setInterval`;
 * `openChannel` is an in-process message queue nothing outside this process
 * delivers to, with the same honesty `tools/feeds-worker-spike/worker-api.mjs`
 * states about its own pubsub stub; the store is always the in-memory one
 * (`tools/feeds-worker-spike/memory-store.mjs`). This script proves the host
 * shape, not a deployment — same posture as `tools/hello-worker`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { installNetworkGuard, networkLog } from '../feeds-worker-spike/worker-api.mjs';
import { openMemoryStore } from '../feeds-worker-spike/memory-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));

// ---- makeFetch --------------------------------------------------------
// Guard-rail only (docs/worker-runtime-portability.md §6.7): a module that
// reached for node:http instead of fetch would go straight around this.
// Installed once, before any run, matching every target in §5.6.
const domains = manifest.capabilities?.network?.domains ?? [];
installNetworkGuard(domains);

// ---- installGlobals -----------------------------------------------------
/** §4.4: globals the module graph reads at import time. */
function installGlobals({ app }) {
  globalThis.app = app;
  globalThis.window = globalThis.window ?? {};
  globalThis.window.app = app;
}

// ---- loadWorkerModule -----------------------------------------------------
let runCounter = 0;
/**
 * §4.4: must return a module graph no other live run shares (§4.5). The
 * cache-busting specifier forces Node to re-evaluate worker.js's top-level
 * code — including the `capturedApi` line worker.js exports — on every call,
 * rather than handing back the cached instance from the first import.
 */
async function loadWorkerModule() {
  runCounter += 1;
  const url = pathToFileURL(path.join(HERE, manifest.worker.url)).href;
  return import(`${url}?run=${runCounter}`);
}

// ---- ensureSchedule / cancelSchedule ------------------------------------
/**
 * §4.4: durable scheduling, in reality owned by the platform (a Durable
 * Object alarm, a systemd timer). This is neither — it is an in-process
 * interval standing in for the "resident supervisor" §5.1 says a bare Node
 * target needs, so it proves nothing about catch-up or persistence across a
 * restart. What it does prove: the host can turn one schedule into repeated
 * calls to `runWorker()`, each with its own `scheduledFor`, which is all
 * §4.2 asks of it.
 */
function ensureSchedule(intervalMs, onDue) {
  const timer = setInterval(() => onDue(Date.now()), intervalMs);
  return { cancel: () => clearInterval(timer) };
}

function cancelSchedule(handle) {
  handle.cancel();
}

// ---- openChannel -----------------------------------------------------
/**
 * §4.4: the duplex channel of docs/workers-design.md §9.4. Nothing outside
 * this process delivers to it — the same honesty
 * tools/feeds-worker-spike/worker-api.mjs's pubsub comment states about
 * itself — so `deliver()` is a harness-only escape hatch standing in for a
 * real inbound transport (a WebSocket frame, an SSE event), and `publish()`
 * only logs rather than reaching a server.
 */
function openChannel(onMessage) {
  return {
    deliver: (message) => onMessage(message),
    async publish(topic, message) {
      console.log(`[channel] publish "${topic}"`, JSON.stringify(message));
    },
    async close() {},
  };
}

// ---- log -----------------------------------------------------
function log(record) {
  console.log(`[${record.level}] [${record.worker}]`, ...record.args);
}

// ---- declares -----------------------------------------------------
/**
 * docs/worker-runtime-portability.md §4.3's AdapterDeclaration, filled in
 * honestly for what this script actually is rather than what a production
 * Node adapter would declare.
 */
const declaration = {
  name: 'second-worker-dev-loopback',
  scheduler: {
    atLeastOnce: true,
    retriesOnFailure: 'none',
    catchesUpMissedRuns: false,
    minIntervalMs: 1,
    precisionMs: 50,
  },
  run: {
    maxWallClockMs: 'unbounded',
    maxCpuMs: 'unbounded',
    memoryMb: 'unbounded',
    singleFlight: true, // one setInterval callback and one channel delivery at a time, by construction
    maxOutboundConcurrency: 'unbounded',
    clockAdvancesWithoutIo: true,
  },
  network: { enforcement: 'guard-rail' },
  install: { codeLoad: 'runtime' },
  isolation: 'shared-process', // see the file comment: cache-busting, not fork-per-run
};

// ---- WorkerHost.run -----------------------------------------------------
/**
 * §4.4's inbound half, implemented once and called by every trigger source
 * below — the schedule and the channel alike, matching §3's "one host,
 * shared" shape even inside this single-file spike.
 */
async function runWorker(trigger, { channel, store }) {
  const startedAt = Date.now();
  const deadline = startedAt + 5000; // an arbitrary floor, well under Cloudflare's 15 minutes (§6.6)
  const abortController = new AbortController();
  const waits = [];

  const api = {
    log: (...args) => log({ level: 'info', worker: manifest.id, args }),
    datastore: {
      async describe() {
        return store.describe();
      },
    },
    async publish(topic, message) {
      return channel.publish(topic, message);
    },
    // Deliberately absent, not stubbed: window, shortcuts, commands, settings —
    // this manifest grants only datastore and network.
  };

  installGlobals({ app: api });
  const mod = await loadWorkerModule();
  const entry = mod[manifest.worker.entry] ?? mod.default;

  // §4.5 / §8 assertion 4, live: does this run's freshly imported module
  // graph hold *this run's* api object, or a stale one from an earlier run
  // that the module registry never released?
  if (mod.capturedApi === api) {
    api.log('worker.js captured this run’s own api object at import time — fresh module graph confirmed (§4.5)');
  } else {
    api.log(
      'WARNING: worker.js captured a different api object than this run installed — module graph was reused (§4.5 violated)'
    );
  }

  const ctx = {
    trigger,
    deadline,
    signal: abortController.signal,
    waitUntil(p) {
      waits.push(p);
    },
  };

  const deadlineTimer = setTimeout(() => abortController.abort(), Math.max(0, deadline - Date.now()));
  try {
    const value = await entry(api, ctx);
    await Promise.all(waits); // §6.6: no platform waitUntil here, so the host awaits instead of dropping it
    return { ok: true, value, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// ---- driver -----------------------------------------------------
async function main() {
  console.log(`declares: ${JSON.stringify(declaration, null, 2)}\n`);

  const store = await openMemoryStore();
  const results = [];

  const channel = openChannel(async (message) => {
    const result = await runWorker(
      { kind: 'command', name: message.name, params: message.params, resultTopic: message.resultTopic },
      { channel, store }
    );
    results.push(result);
    return result;
  });

  let firesLeft = 2;
  await new Promise((resolve) => {
    const handle = ensureSchedule(500, async (scheduledFor) => {
      results.push(await runWorker({ kind: 'schedule', scheduledFor }, { channel, store }));
      firesLeft -= 1;
      if (firesLeft === 0) {
        cancelSchedule(handle);
        resolve();
      }
    });
  });

  await channel.deliver({ name: 'ping', params: { at: Date.now() }, resultTopic: 'second-worker:ping-result' });
  await channel.close();

  console.log('\n--- results');
  for (const [i, r] of results.entries()) {
    console.log(`  run ${i + 1}: ${r.ok ? 'ok' : 'FAILED'} in ${r.ms}ms` + (r.ok ? '' : `: ${r.error.message}`));
  }
  console.log('\n--- network');
  console.log(`  manifest allows: ${domains.join(', ') || '(nothing)'}`);
  for (const n of networkLog) console.log(`  ${n.allowed ? 'allow' : 'DENY '}  ${n.host}  ${n.url}`);

  const failed = results.some((r) => !r.ok);
  console.log(failed ? '\nsecond-worker: at least one run FAILED (see above).' : '\nsecond-worker ok.');
  process.exit(failed ? 1 : 0);
}

await main();
