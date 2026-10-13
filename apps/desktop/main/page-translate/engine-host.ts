/**
 * Main-process side of the translation engine: starts the engine process on the first request,
 * matches replies to requests by id, forwards `AbortSignal`s as `cancel` messages, and stops the
 * process after it has been idle for `idleMs`. Satisfies `page-session.ts SessionEngine`.
 *
 * The process itself is behind the `spawn` port. `electronSpawn` forks
 * `engine-worker-main.js` as an Electron `utilityProcess`; the unit test passes a
 * `child_process.fork` spawner because `utilityProcess` does not exist under
 * `ELECTRON_RUN_AS_NODE`.
 */

import { fileURLToPath } from 'node:url';

import type { EngineMode, EngineResources, EngineToHost, HostToEngine, TranslateMessage } from './engine-protocol.js';
import type { EngineRequest, SessionEngine } from './page-session.js';

/** Five minutes: a model takes ~60 ms to build again, so a cold restart is cheap and ~330 MB is freed. */
export const DEFAULT_ENGINE_IDLE_MS = 5 * 60 * 1000;

export const ENGINE_WORKER_PATH = fileURLToPath(new URL('./engine-worker-main.js', import.meta.url));

export interface EngineProcess {
  postMessage(msg: HostToEngine): void;
  onMessage(fn: (msg: EngineToHost) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

export type EngineSpawner = (modulePath: string) => EngineProcess;

export class EngineHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineHostError';
  }
}

/** Spawns the engine as an Electron `utilityProcess`; the child inherits main's environment. */
export async function electronSpawner(): Promise<EngineSpawner> {
  const { utilityProcess } = await import('electron');
  return (modulePath) => {
    const child = utilityProcess.fork(modulePath, [], {
      serviceName: 'Peek translation engine',
      env: { ...process.env },
      stdio: 'inherit',
    });
    return {
      postMessage: (msg) => child.postMessage(msg),
      onMessage: (fn) => child.on('message', (m: EngineToHost) => fn(m)),
      onExit: (fn) => child.on('exit', (code: number) => fn(code)),
      kill: () => {
        child.kill();
      },
    };
  };
}

export interface EngineHostOptions {
  spawn: EngineSpawner;
  modulePath?: string;
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Resolves the files a request needs (`engine-resources.ts`); each translate message then
   * carries them. A rejection fails the request with the error's code (an `EngineHostError`
   * keeps its own, anything else becomes `resources-failed`). Omitted for the stub engine.
   */
  resources?: (from: string, to: string, signal: AbortSignal) => Promise<EngineResources>;
}

export interface EngineHost extends SessionEngine {
  /** Whether an engine process is currently alive. */
  running(): boolean;
  /** The engine the running process reported, or null before it is ready. */
  mode(): EngineMode | null;
  /** Stops the process and fails anything outstanding with `engine-disposed`. */
  dispose(): void;
}

interface Pending {
  resolve(t: string[]): void;
  reject(err: Error): void;
  cleanup(): void;
}

export function createEngineHost(opts: EngineHostOptions): EngineHost {
  const modulePath = opts.modulePath ?? ENGINE_WORKER_PATH;
  const idleMs = opts.idleMs ?? DEFAULT_ENGINE_IDLE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let proc: EngineProcess | null = null;
  let ready = false;
  let readyMode: EngineMode | null = null;
  let outbox: HostToEngine[] = [];
  let nextId = 1;
  let idleTimer: unknown = null;
  const pending = new Map<number, Pending>();

  function send(msg: HostToEngine) {
    if (!proc) return;
    if (ready) proc.postMessage(msg);
    else outbox.push(msg);
  }

  function settle(id: number): Pending | undefined {
    const p = pending.get(id);
    if (!p) return undefined;
    pending.delete(id);
    p.cleanup();
    if (pending.size === 0) armIdle();
    return p;
  }

  function armIdle() {
    disarmIdle();
    if (!proc) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (pending.size === 0) stop();
    }, idleMs);
  }

  function disarmIdle() {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  }

  function failAll(code: string, message: string) {
    for (const id of [...pending.keys()]) settle(id)?.reject(new EngineHostError(code, message));
  }

  function stop() {
    const p = proc;
    proc = null;
    ready = false;
    readyMode = null;
    outbox = [];
    disarmIdle();
    p?.kill();
  }

  function start(): EngineProcess {
    const p = opts.spawn(modulePath);
    proc = p;
    p.onMessage((msg) => {
      if (proc !== p) return;
      if (msg.type === 'ready') {
        ready = true;
        readyMode = msg.mode;
        const queued = outbox;
        outbox = [];
        for (const m of queued) p.postMessage(m);
        return;
      }
      if (msg.type === 'result') settle(msg.id)?.resolve(msg.translations);
      else if (msg.type === 'error') settle(msg.id)?.reject(new EngineHostError(msg.code, msg.message));
    });
    p.onExit((code) => {
      if (proc !== p) return;
      proc = null;
      ready = false;
      readyMode = null;
      outbox = [];
      disarmIdle();
      failAll('engine-exited', `translation engine exited (code ${code})`);
    });
    return p;
  }

  return {
    translate(req: EngineRequest): Promise<string[]> {
      if (req.signal.aborted) return Promise.reject(new EngineHostError('aborted', 'request cancelled'));
      if (req.segments.length === 0) return Promise.resolve([]);
      disarmIdle();
      // With a resolver the process starts once the files are known, so a request that fails
      // for want of models never spawns one.
      if (!proc && !opts.resources) start();
      const id = nextId++;
      return new Promise<string[]>((resolve, reject) => {
        const onAbort = () => {
          if (!pending.has(id)) return;
          send({ type: 'cancel', id });
          settle(id)?.reject(new EngineHostError('aborted', 'request cancelled'));
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          resolve,
          reject,
          cleanup: () => req.signal.removeEventListener('abort', onAbort),
        });
        const message: TranslateMessage = { type: 'translate', id, from: req.from, to: req.to, segments: req.segments, isHTML: req.isHTML };
        if (!opts.resources) {
          send(message);
          return;
        }
        opts.resources(req.from, req.to, req.signal).then(
          (resources) => {
            if (!pending.has(id)) return;
            if (!proc) start();
            send({ ...message, resources });
          },
          (err: unknown) => {
            const failure = err instanceof EngineHostError ? err : new EngineHostError('resources-failed', err instanceof Error ? err.message : String(err));
            settle(id)?.reject(failure);
          },
        );
      });
    },
    running: () => proc !== null,
    mode: () => readyMode,
    dispose() {
      const had = proc !== null;
      stop();
      if (had || pending.size > 0) failAll('engine-disposed', 'translation engine stopped');
    },
  };
}
