/**
 * Entry point of the translation engine process. Under Electron it runs as a
 * `utilityProcess` and talks over `process.parentPort`; under a plain Node `child_process.fork`
 * (the main-process unit test) it talks over `process.send`. The engine is chosen by
 * `PEEK_TRANSLATE_ENGINE` (`stub` selects the uppercasing stub engine).
 */

import { engineModeFromEnv, STUB_DELAY_ENV, type EngineToHost, type HostToEngine } from './engine-protocol.js';
import { createBergamotEngine } from './engine-bergamot.js';
import { createEngineWorker, createStubEngine } from './engine-worker.js';

interface ParentPortLike {
  on(event: 'message', fn: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

let post: (msg: EngineToHost) => void;
let listen: (fn: (msg: HostToEngine) => void) => void;

if (parentPort) {
  post = (msg) => parentPort.postMessage(msg);
  listen = (fn) => parentPort.on('message', (e) => fn(e.data as HostToEngine));
} else if (process.send) {
  post = (msg) => process.send!(msg);
  listen = (fn) => process.on('message', (m) => fn(m as HostToEngine));
  // A forked child outlives a vanished parent unless it leaves with the channel.
  process.on('disconnect', () => process.exit(0));
} else {
  throw new Error('engine-worker-main: no parent channel (run as a utility process or a forked child)');
}

const mode = engineModeFromEnv(process.env);
const engine = mode === 'stub' ? createStubEngine(Number(process.env[STUB_DELAY_ENV]) || 0) : createBergamotEngine();
const worker = createEngineWorker({ engine, mode, post });
listen((msg) => worker.handle(msg));
