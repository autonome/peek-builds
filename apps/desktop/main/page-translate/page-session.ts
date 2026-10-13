/**
 * One translation session per page window: a pure transition function plus a small driver that
 * carries out its effects against the page (the injected `content-script.ts` translator) and the
 * engine.
 *
 * Phases: idle → collecting → translating ⇄ translated → restoring → idle, and closed (terminal).
 *
 * - `collecting`: the translator is injected and `collect()` returns the first batch.
 * - `translating`: a batch is with the engine; its results are applied, then `drain()` asks for
 *   the next batch.
 * - `translated`: nothing is pending; `drain()` is polled for content the page adds later.
 * - `restoring`: `restore()` puts the original text back; a failure falls back to a reload.
 *
 * Every request carries the session's `run` number. Showing the original, navigating, closing
 * and failing all start a new run, so a reply from an older run (an engine result that arrives
 * after the user chose "show original", a batch from a page that has since navigated) is
 * dropped instead of touching the page.
 */

import {
  callSource,
  injectionSource,
  type TranslationResult,
  type WorkItem,
} from './content-script.js';

export type SessionPhase = 'idle' | 'collecting' | 'translating' | 'translated' | 'restoring' | 'closed';

export interface SessionState {
  phase: SessionPhase;
  /** Bumped whenever outstanding work must be abandoned; replies from another run are ignored. */
  run: number;
  from: string | null;
  to: string | null;
  /** Units applied to the page in this run. */
  applied: number;
  error: string | null;
}

export type SessionEvent =
  | { type: 'translate'; from: string; to: string }
  | { type: 'batch'; run: number; items: WorkItem[] }
  | { type: 'translated'; run: number; results: TranslationResult[] }
  | { type: 'poll'; run: number }
  | { type: 'show-original' }
  | { type: 'restored'; run: number }
  | { type: 'navigated' }
  | { type: 'will-close' }
  | { type: 'failed'; run: number; error: string };

export type SessionEffect =
  | { type: 'collect'; run: number; pageLang: string }
  | { type: 'translate'; run: number; from: string; to: string; items: WorkItem[] }
  | { type: 'apply'; run: number; results: TranslationResult[] }
  | { type: 'drain'; run: number }
  | { type: 'schedule-poll'; run: number }
  | { type: 'cancel'; run: number }
  | { type: 'restore'; run: number }
  | { type: 'reload' };

export interface Transition {
  state: SessionState;
  effects: SessionEffect[];
}

export const INITIAL_SESSION_STATE: SessionState = {
  phase: 'idle',
  run: 0,
  from: null,
  to: null,
  applied: 0,
  error: null,
};

const ACTIVE: ReadonlySet<SessionPhase> = new Set(['collecting', 'translating', 'translated']);

function hasRun(event: SessionEvent): event is Extract<SessionEvent, { run: number }> {
  return 'run' in event;
}

/** Pure transition function. Events that do not apply in the current phase change nothing. */
export function transition(state: SessionState, event: SessionEvent): Transition {
  const same: Transition = { state, effects: [] };
  if (state.phase === 'closed') return same;
  if (hasRun(event) && event.run !== state.run) return same;

  if (event.type === 'will-close') {
    return { state: { ...state, phase: 'closed', run: state.run + 1 }, effects: [{ type: 'cancel', run: state.run }] };
  }

  if (event.type === 'navigated') {
    if (state.phase === 'idle') return same;
    // The document that held the translator and its saved originals is gone; nothing to restore.
    return {
      state: { ...INITIAL_SESSION_STATE, run: state.run + 1 },
      effects: [{ type: 'cancel', run: state.run }],
    };
  }

  switch (state.phase) {
    case 'idle': {
      if (event.type !== 'translate') return same;
      const run = state.run + 1;
      return {
        state: { phase: 'collecting', run, from: event.from, to: event.to, applied: 0, error: null },
        effects: [{ type: 'collect', run, pageLang: event.from }],
      };
    }

    case 'restoring': {
      if (event.type === 'restored') return { state: { ...state, phase: 'idle' }, effects: [] };
      if (event.type === 'failed') {
        return { state: { ...state, phase: 'idle', run: state.run + 1, error: event.error }, effects: [{ type: 'reload' }] };
      }
      return same;
    }

    default: {
      if (!ACTIVE.has(state.phase)) return same;
      const from = state.from as string;
      const to = state.to as string;
      switch (event.type) {
        case 'batch':
          if (state.phase === 'translating') return same;
          if (event.items.length === 0) {
            return { state: { ...state, phase: 'translated' }, effects: [{ type: 'schedule-poll', run: state.run }] };
          }
          return {
            state: { ...state, phase: 'translating' },
            effects: [{ type: 'translate', run: state.run, from, to, items: event.items }],
          };
        case 'translated':
          if (state.phase !== 'translating') return same;
          return {
            // Back to collecting: the next batch is being asked for.
            state: { ...state, phase: 'collecting', applied: state.applied + event.results.length },
            effects: [
              { type: 'apply', run: state.run, results: event.results },
              { type: 'drain', run: state.run },
            ],
          };
        case 'poll':
          if (state.phase !== 'translated') return same;
          return { state: { ...state, phase: 'collecting' }, effects: [{ type: 'drain', run: state.run }] };
        case 'show-original':
        case 'failed': {
          const run = state.run + 1;
          return {
            state: { ...state, phase: 'restoring', run, error: event.type === 'failed' ? event.error : null },
            effects: [
              { type: 'cancel', run: state.run },
              { type: 'restore', run },
            ],
          };
        }
        default:
          return same;
      }
    }
  }
}

/** Runs a script in the page's isolated world and resolves to its value. */
export interface SessionPage {
  run(script: string): Promise<unknown>;
  reload(): void;
}

export interface EngineRequest {
  from: string;
  to: string;
  segments: string[];
  isHTML: boolean;
  signal: AbortSignal;
}

/** Translates segments in order; resolves to one translation per segment. */
export interface SessionEngine {
  translate(req: EngineRequest): Promise<string[]>;
}

export interface SessionOptions {
  page: SessionPage;
  engine: SessionEngine;
  /** Delay between `drain()` polls while translated. */
  pollMs?: number;
  /** Units per batch inside the page. */
  batchSize?: number;
  onChange?: (state: SessionState) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PageSession {
  state(): SessionState;
  dispatch(event: SessionEvent): void;
  /** Resolves once no effect is running. */
  idle(): Promise<void>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPageSession(opts: SessionOptions): PageSession {
  const pollMs = opts.pollMs ?? 1500;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state = INITIAL_SESSION_STATE;
  const aborts = new Map<number, AbortController>();
  const timers = new Map<number, unknown>();
  let chain: Promise<void> = Promise.resolve();

  function abortFor(run: number): AbortController {
    let c = aborts.get(run);
    if (!c) {
      c = new AbortController();
      aborts.set(run, c);
    }
    return c;
  }

  function cancel(run: number): void {
    aborts.get(run)?.abort();
    aborts.delete(run);
    if (timers.has(run)) {
      clearTimer(timers.get(run));
      timers.delete(run);
    }
  }

  function dispatch(event: SessionEvent): void {
    const t = transition(state, event);
    if (t.state !== state) {
      state = t.state;
      opts.onChange?.(state);
    }
    // A cancel takes effect before dispatch returns, so the engine sees the abort at once. The
    // other effects of one transition run in order; separate transitions do not wait on each
    // other, so nothing is queued behind the engine call being cancelled.
    for (const e of t.effects) if (e.type === 'cancel') cancel(e.run);
    const rest = t.effects.filter((e) => e.type !== 'cancel');
    if (rest.length) {
      const p = rest.reduce<Promise<void>>((acc, e) => acc.then(() => perform(e)), Promise.resolve());
      chain = Promise.all([chain, p]).then(() => undefined);
    }
  }

  async function perform(e: SessionEffect): Promise<void> {
    try {
      switch (e.type) {
        case 'collect': {
          await opts.page.run(injectionSource({ pageLang: e.pageLang, batchSize: opts.batchSize }));
          const items = await opts.page.run(callSource('collect'));
          dispatch({ type: 'batch', run: e.run, items: (items as WorkItem[] | null) ?? [] });
          return;
        }
        case 'drain': {
          if (e.run !== state.run) return;
          const items = await opts.page.run(callSource('drain'));
          dispatch({ type: 'batch', run: e.run, items: (items as WorkItem[] | null) ?? [] });
          return;
        }
        case 'translate': {
          if (e.run !== state.run) return;
          const signal = abortFor(e.run).signal;
          const results: TranslationResult[] = [];
          for (const isHTML of [true, false]) {
            const group = e.items.filter((i) => i.isHTML === isHTML);
            if (!group.length) continue;
            const out = await opts.engine.translate({
              from: e.from,
              to: e.to,
              segments: group.map((i) => i.text),
              isHTML,
              signal,
            });
            if (signal.aborted) return;
            if (!Array.isArray(out) || out.length !== group.length) {
              throw new Error(`engine returned ${Array.isArray(out) ? out.length : 'no'} results for ${group.length} segments`);
            }
            group.forEach((item, i) => results.push({ id: item.id, text: out[i] }));
          }
          dispatch({ type: 'translated', run: e.run, results });
          return;
        }
        case 'apply':
          if (e.run !== state.run) return;
          await opts.page.run(callSource('apply', e.results));
          return;
        case 'schedule-poll': {
          const handle = setTimer(() => {
            timers.delete(e.run);
            dispatch({ type: 'poll', run: e.run });
          }, pollMs);
          timers.set(e.run, handle);
          return;
        }
        case 'cancel':
          cancel(e.run);
          return;
        case 'restore':
          await opts.page.run(callSource('restore'));
          dispatch({ type: 'restored', run: e.run });
          return;
        case 'reload':
          opts.page.reload();
          return;
      }
    } catch (err) {
      if ('run' in e) dispatch({ type: 'failed', run: e.run, error: message(err) });
    }
  }

  return {
    state: () => state,
    dispatch,
    async idle() {
      // Effects can schedule further effects; settle until the chain stops growing.
      for (;;) {
        const c = chain;
        await c;
        if (c === chain) return;
      }
    },
  };
}
