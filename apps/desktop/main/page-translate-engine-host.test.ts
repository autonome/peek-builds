/**
 * Translation engine host and process (page-translate/engine-host.ts, engine-worker.ts,
 * engine-worker-main.ts): the worker's request loop in process, the host against an in-memory
 * process, then a round trip through a real forked engine process running the stub engine.
 * `utilityProcess` does not exist under ELECTRON_RUN_AS_NODE, so the real-process tests fork
 * with `child_process`, which the entry point supports as its second channel. The test sits at
 * the top level of main/ so the shared `dist/main/*.test.js` glob runs it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { fork } from 'node:child_process';

import {
  createEngineHost,
  ENGINE_WORKER_PATH,
  EngineHostError,
  type EngineProcess,
  type EngineSpawner,
} from './page-translate/engine-host.js';
import {
  engineModeFromEnv,
  ENGINE_MODE_ENV,
  STUB_DELAY_ENV,
  type EngineToHost,
  type HostToEngine,
} from './page-translate/engine-protocol.js';
import {
  createEngineWorker,
  createStubEngine,
  stubTranslateText,
  type WorkerEngine,
} from './page-translate/engine-worker.js';
import { createBergamotEngine } from './page-translate/engine-bergamot.js';
import type { SessionEngine } from './page-translate/page-session.js';

function req(segments: string[], signal = new AbortController().signal, isHTML = false) {
  return { from: 'de', to: 'en', segments, isHTML, signal };
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof EngineHostError, `expected EngineHostError, got ${String(err)}`);
    assert.strictEqual(err.code, code);
    return true;
  });
}

describe('engine mode', () => {
  it('only PEEK_TRANSLATE_ENGINE=stub selects the stub', () => {
    assert.strictEqual(engineModeFromEnv({ [ENGINE_MODE_ENV]: 'stub' }), 'stub');
    assert.strictEqual(engineModeFromEnv({}), 'bergamot');
    assert.strictEqual(engineModeFromEnv({ [ENGINE_MODE_ENV]: 'STUB' }), 'bergamot');
  });

  it('the stub uppercases text but leaves markup and entities alone', () => {
    assert.strictEqual(stubTranslateText('Hallo', false), 'HALLO');
    assert.strictEqual(
      stubTranslateText('Ein <b data-id="3">Hund</b> &amp; Katze', true),
      'EIN <b data-id="3">HUND</b> &amp; KATZE',
    );
  });
});

describe('engine worker loop', () => {
  function harness(engine: WorkerEngine) {
    const out: EngineToHost[] = [];
    const worker = createEngineWorker({ engine, mode: 'stub', post: (m) => out.push(m) });
    return { out, worker };
  }

  it('announces ready, then answers requests in order', async () => {
    const { out, worker } = harness(createStubEngine());
    assert.deepStrictEqual(out, [{ type: 'ready', mode: 'stub' }]);
    worker.handle({ type: 'translate', id: 1, from: 'de', to: 'en', segments: ['a', 'b'], isHTML: false });
    worker.handle({ type: 'translate', id: 2, from: 'de', to: 'en', segments: ['c'], isHTML: false });
    await worker.idle();
    assert.deepStrictEqual(out.slice(1), [
      { type: 'result', id: 1, translations: ['A', 'B'] },
      { type: 'result', id: 2, translations: ['C'] },
    ]);
  });

  it('a cancel aborts the running request and skips a queued one', async () => {
    const { out, worker } = harness(createStubEngine(20));
    worker.handle({ type: 'translate', id: 1, from: 'de', to: 'en', segments: ['a', 'b', 'c'], isHTML: false });
    worker.handle({ type: 'translate', id: 2, from: 'de', to: 'en', segments: ['d'], isHTML: false });
    worker.handle({ type: 'translate', id: 3, from: 'de', to: 'en', segments: ['e'], isHTML: false });
    worker.handle({ type: 'cancel', id: 2 });
    worker.handle({ type: 'cancel', id: 1 });
    await worker.idle();
    assert.deepStrictEqual(
      out.slice(1).map((m) => (m.type === 'error' ? `${m.id}:${m.code}` : m.type === 'result' ? `${m.id}:ok` : m.type)),
      ['1:aborted', '2:aborted', '3:ok'],
    );
  });

  it('reports a wrong translation count and engine failures as errors', async () => {
    const { out, worker } = harness({ translate: async () => ['only one'] });
    worker.handle({ type: 'translate', id: 1, from: 'de', to: 'en', segments: ['a', 'b'], isHTML: false });
    await worker.idle();
    assert.strictEqual(out[1].type === 'error' && out[1].code, 'engine-failed');

    const u = harness(createBergamotEngine());
    u.worker.handle({ type: 'translate', id: 7, from: 'de', to: 'en', segments: ['a'], isHTML: false });
    await u.worker.idle();
    assert.strictEqual(u.out[1].type === 'error' && u.out[1].code, 'engine-unavailable');
  });

  it('hands the request resources to the engine', async () => {
    const seen: unknown[] = [];
    const { worker } = harness({
      translate: async (r) => {
        seen.push(r.resources);
        return r.segments;
      },
    });
    const resources = { wasmPath: '/w.wasm', steps: [{ from: 'de', to: 'en', modelName: 'm.bin', files: { model: '/m' } }] };
    worker.handle({ type: 'translate', id: 1, from: 'de', to: 'en', segments: ['a'], isHTML: false, resources });
    await worker.idle();
    assert.deepStrictEqual(seen, [resources]);
  });
});

/** An engine process that runs the worker loop in memory, delivering messages asynchronously. */
function memorySpawner(opts: { engine?: WorkerEngine; holdReady?: boolean } = {}) {
  const procs: Array<{ sent: HostToEngine[]; killed: boolean; exit(code: number): void; ready(): void }> = [];
  const spawn: EngineSpawner = () => {
    let onMsg: (m: EngineToHost) => void = () => {};
    let onExit: (c: number | null) => void = () => {};
    const held: EngineToHost[] = [];
    let released = !opts.holdReady;
    const deliver = (m: EngineToHost) => queueMicrotask(() => onMsg(m));
    let worker: ReturnType<typeof createEngineWorker> | null = null;
    const rec = {
      sent: [] as HostToEngine[],
      killed: false,
      exit: (code: number) => onExit(code),
      ready: () => {
        released = true;
        for (const m of held.splice(0)) deliver(m);
      },
    };
    procs.push(rec);
    const p: EngineProcess = {
      postMessage: (m) => {
        rec.sent.push(m);
        worker!.handle(m);
      },
      onMessage: (fn) => {
        onMsg = fn;
        worker = createEngineWorker({
          engine: opts.engine ?? createStubEngine(),
          mode: 'stub',
          post: (m) => (released ? deliver(m) : held.push(m)),
        });
      },
      onExit: (fn) => {
        onExit = fn;
      },
      kill: () => {
        rec.killed = true;
      },
    };
    return p;
  };
  return { spawn, procs };
}

describe('engine host', () => {
  it('starts the process on the first request and holds requests until it is ready', async () => {
    const m = memorySpawner({ holdReady: true });
    const host = createEngineHost({ spawn: m.spawn });
    const engine: SessionEngine = host;
    assert.strictEqual(host.running(), false);
    const p = engine.translate(req(['hallo']));
    assert.strictEqual(m.procs.length, 1);
    assert.deepStrictEqual(m.procs[0].sent, []);
    m.procs[0].ready();
    assert.deepStrictEqual(await p, ['HALLO']);
    assert.strictEqual(host.mode(), 'stub');
    host.dispose();
  });

  it('an empty request resolves without starting the process', async () => {
    const m = memorySpawner();
    const host = createEngineHost({ spawn: m.spawn });
    assert.deepStrictEqual(await host.translate(req([])), []);
    assert.strictEqual(m.procs.length, 0);
  });

  it('aborting rejects at once and tells the process to cancel', async () => {
    const m = memorySpawner({ engine: createStubEngine(50) });
    const host = createEngineHost({ spawn: m.spawn });
    const ctrl = new AbortController();
    const p = host.translate(req(['a', 'b'], ctrl.signal));
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await rejectsWith(p, 'aborted');
    assert.deepStrictEqual(m.procs[0].sent.map((s) => s.type), ['translate', 'cancel']);
    await rejectsWith(host.translate(req(['x'], ctrl.signal)), 'aborted');
    host.dispose();
  });

  it('a process exit fails what is outstanding and the next request starts a new one', async () => {
    const m = memorySpawner({ holdReady: true });
    const host = createEngineHost({ spawn: m.spawn });
    const p = host.translate(req(['a']));
    m.procs[0].exit(1);
    await rejectsWith(p, 'engine-exited');
    assert.strictEqual(host.running(), false);
    const q = host.translate(req(['b']));
    m.procs[1].ready();
    assert.deepStrictEqual(await q, ['B']);
    host.dispose();
  });

  it('stops the process once idle for idleMs, and not while a request is outstanding', async () => {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const m = memorySpawner();
    const host = createEngineHost({
      spawn: m.spawn,
      idleMs: 1000,
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { live: boolean }).live = false;
      },
    });
    assert.deepStrictEqual(await host.translate(req(['a'])), ['A']);
    const live = timers.filter((t) => t.live);
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].ms, 1000);
    const p = host.translate(req(['b']));
    assert.strictEqual(live[0].live, false, 'a new request disarms the idle timer');
    await p;
    const again = timers.filter((t) => t.live);
    assert.strictEqual(again.length, 1);
    again[0].fn();
    assert.strictEqual(m.procs[0].killed, true);
    assert.strictEqual(host.running(), false);
  });

  it('dispose kills the process and fails what is outstanding', async () => {
    const m = memorySpawner({ holdReady: true });
    const host = createEngineHost({ spawn: m.spawn });
    const p = host.translate(req(['a']));
    host.dispose();
    await rejectsWith(p, 'engine-disposed');
    assert.strictEqual(m.procs[0].killed, true);
  });
});

/** Forks the real entry point as a Node child (the test runs under ELECTRON_RUN_AS_NODE). */
function forkSpawner(env: Record<string, string>): { spawn: EngineSpawner; exits: Promise<number | null>[] } {
  const exits: Promise<number | null>[] = [];
  const spawn: EngineSpawner = (modulePath) => {
    const child = fork(modulePath, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    exits.push(new Promise((r) => child.once('exit', (code) => r(code))));
    return {
      postMessage: (msg) => child.send(msg),
      onMessage: (fn) => child.on('message', (msg) => fn(msg as EngineToHost)),
      onExit: (fn) => child.on('exit', (code) => fn(code)),
      kill: () => {
        child.kill();
      },
    };
  };
  return { spawn, exits };
}

describe('engine host with a real engine process', () => {
  it('round-trips a stub translation through the forked entry point', async () => {
    const f = forkSpawner({ [ENGINE_MODE_ENV]: 'stub' });
    const host = createEngineHost({ spawn: f.spawn, modulePath: ENGINE_WORKER_PATH });
    const out = await host.translate(req(['Ein <b data-id="1">Hund</b>', 'Katze'], undefined, true));
    assert.deepStrictEqual(out, ['EIN <b data-id="1">HUND</b>', 'KATZE']);
    assert.strictEqual(host.mode(), 'stub');
    host.dispose();
    await f.exits[0];
  });

  it('honours an abort mid-request and keeps serving afterwards', async () => {
    const f = forkSpawner({ [ENGINE_MODE_ENV]: 'stub', [STUB_DELAY_ENV]: '100' });
    const host = createEngineHost({ spawn: f.spawn });
    const ctrl = new AbortController();
    const p = host.translate(req(['a', 'b', 'c', 'd'], ctrl.signal));
    setTimeout(() => ctrl.abort(), 20);
    const t0 = Date.now();
    await rejectsWith(p, 'aborted');
    assert.ok(Date.now() - t0 < 300, 'rejects without waiting for the batch');
    assert.deepStrictEqual(await host.translate(req(['e'])), ['E']);
    host.dispose();
    await f.exits[0];
  });

  it('without the stub flag and with no engine files named, the process reports engine-unavailable', async () => {
    const f = forkSpawner({ [ENGINE_MODE_ENV]: '' });
    const host = createEngineHost({ spawn: f.spawn });
    await rejectsWith(host.translate(req(['a'])), 'engine-unavailable');
    assert.strictEqual(host.mode(), 'bergamot');
    host.dispose();
    await f.exits[0];
  });

  it('an engine process that dies fails the request with engine-exited', async () => {
    const f = forkSpawner({ [ENGINE_MODE_ENV]: 'stub', [STUB_DELAY_ENV]: '500' });
    let killChild: (() => void) | null = null;
    const host = createEngineHost({
      spawn: (path) => {
        const p = f.spawn(path);
        killChild = () => p.kill();
        return p;
      },
    });
    const pending = host.translate(req(['a']));
    setTimeout(() => killChild!(), 50);
    await rejectsWith(pending, 'engine-exited');
    await f.exits[0];
    host.dispose();
  });
});
