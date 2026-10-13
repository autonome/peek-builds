/**
 * The translation engine process, minus its entry point (`engine-worker-main.ts`). Holds the
 * request loop: one request translates at a time, in arrival order, and a `cancel` aborts a
 * running or queued request. The engine behind it is a port so the stub engine and Bergamot
 * share the loop.
 */

import type { EngineMode, EngineToHost, HostToEngine, TranslateMessage } from './engine-protocol.js';

export interface WorkerEngineRequest {
  from: string;
  to: string;
  segments: string[];
  isHTML: boolean;
  signal: AbortSignal;
}

export interface WorkerEngine {
  translate(req: WorkerEngineRequest): Promise<string[]>;
}

/** Thrown by an engine that cannot run; `code` reaches the host unchanged. */
export class EngineWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineWorkerError';
  }
}

/** Uppercases text outside tags and entities, leaving markup and ids untouched. */
export function stubTranslateText(s: string, isHTML: boolean): string {
  if (!isHTML) return s.toUpperCase();
  return s.replace(/(^|>)([^<]+)/g, (_m, p: string, t: string) =>
    p + t.replace(/&[a-z0-9#]+;|[^&]+/gi, (x) => (x[0] === '&' ? x : x.toUpperCase())),
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Deterministic engine for tests: uppercases, optionally waiting `delayMs` per segment. */
export function createStubEngine(delayMs = 0): WorkerEngine {
  return {
    async translate(req) {
      const out: string[] = [];
      for (const s of req.segments) {
        if (delayMs > 0) await sleep(delayMs, req.signal);
        if (req.signal.aborted) throw new EngineWorkerError('aborted', 'request cancelled');
        out.push(stubTranslateText(s, req.isHTML));
      }
      return out;
    },
  };
}

/** Placeholder until the Bergamot engine is wired: every request fails with a clear code. */
export function createUnavailableEngine(): WorkerEngine {
  return {
    async translate() {
      throw new EngineWorkerError('engine-unavailable', 'the Bergamot engine is not wired yet');
    },
  };
}

export interface EngineWorker {
  handle(msg: HostToEngine): void;
  /** Resolves once the queue is empty; for tests. */
  idle(): Promise<void>;
}

export function createEngineWorker(opts: {
  engine: WorkerEngine;
  mode: EngineMode;
  post: (msg: EngineToHost) => void;
}): EngineWorker {
  const queue: TranslateMessage[] = [];
  const controllers = new Map<number, AbortController>();
  let running: Promise<void> | null = null;

  function errorOf(id: number, err: unknown): EngineToHost {
    if (err instanceof EngineWorkerError) return { type: 'error', id, code: err.code, message: err.message };
    return { type: 'error', id, code: 'engine-failed', message: err instanceof Error ? err.message : String(err) };
  }

  async function pump(): Promise<void> {
    while (queue.length > 0) {
      const msg = queue.shift()!;
      const ctrl = controllers.get(msg.id)!;
      if (ctrl.signal.aborted) {
        controllers.delete(msg.id);
        opts.post({ type: 'error', id: msg.id, code: 'aborted', message: 'request cancelled' });
        continue;
      }
      try {
        const translations = await opts.engine.translate({
          from: msg.from,
          to: msg.to,
          segments: msg.segments,
          isHTML: msg.isHTML,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) {
          opts.post({ type: 'error', id: msg.id, code: 'aborted', message: 'request cancelled' });
        } else if (translations.length !== msg.segments.length) {
          opts.post({
            type: 'error',
            id: msg.id,
            code: 'engine-failed',
            message: `engine returned ${translations.length} translations for ${msg.segments.length} segments`,
          });
        } else {
          opts.post({ type: 'result', id: msg.id, translations });
        }
      } catch (err) {
        opts.post(errorOf(msg.id, err));
      } finally {
        controllers.delete(msg.id);
      }
    }
    running = null;
  }

  opts.post({ type: 'ready', mode: opts.mode });

  return {
    handle(msg) {
      if (msg.type === 'cancel') {
        controllers.get(msg.id)?.abort();
        return;
      }
      if (msg.type !== 'translate') return;
      controllers.set(msg.id, new AbortController());
      queue.push(msg);
      if (!running) running = pump();
    },
    async idle() {
      while (running) await running;
    },
  };
}
