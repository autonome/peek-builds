/**
 * Owns the translation sessions of every page window: one `page-session.ts` session per window
 * id, all sharing one engine. The Electron wiring calls `translate` / `showOriginal` from the
 * feature's requests and `navigated` / `closed` from the window lifecycle; everything that
 * touches Electron sits behind the `pageFor` port so this module runs under plain Node.
 *
 * A `translate` for a window whose session is already active with another language pair shows
 * the original first and starts the new translation once the page is restored, so one command
 * changes the target language. The same pair again changes nothing. If the restore fails the
 * page is reloaded and the queued translation is dropped, because it would race the reload.
 */

import {
  createPageSession,
  type PageSession,
  type SessionEngine,
  type SessionPage,
  type SessionState,
} from './page-session.js';

/**
 * The isolated world the page translator runs in. Electron reserves 0 (the page's own world)
 * and 999 (its context-isolation world); any other id from 1 to 536870911 is free, and nothing
 * else in Peek claims one.
 */
export const TRANSLATE_WORLD_ID = 1001;

/** The part of an Electron `WebContents` a translation session needs. */
export interface TranslatableWebContents {
  isDestroyed(): boolean;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown>;
  reload(): void;
}

/** Adapts a page's `WebContents` to `page-session.ts SessionPage`, running in `TRANSLATE_WORLD_ID`. */
export function pageFromWebContents(wc: TranslatableWebContents): SessionPage {
  return {
    run(script) {
      if (wc.isDestroyed()) return Promise.reject(new Error('page is gone'));
      return wc.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD_ID, [{ code: script }]);
    },
    reload() {
      if (!wc.isDestroyed()) wc.reload();
    },
  };
}

export type TranslateOutcome = 'started' | 'queued' | 'unchanged' | 'no-page';

export interface TranslationServiceOptions {
  /** The window's web page, or null when the window has none (not a page, already closed). */
  pageFor(windowId: number): SessionPage | null;
  engine: SessionEngine;
  /** Called on every state change of a window's session. */
  onState?(windowId: number, state: SessionState): void;
  pollMs?: number;
  batchSize?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TranslationService {
  translate(windowId: number, pair: { from: string; to: string }): TranslateOutcome;
  showOriginal(windowId: number): void;
  /** The window's page navigated; its translation is gone with the old document. */
  navigated(windowId: number): void;
  /** The window is closing; its session ends and is forgotten. */
  closed(windowId: number): void;
  /** The window's session state, or null when it has never had one. */
  state(windowId: number): SessionState | null;
  /** Resolves once the window's session has no effect running. */
  idle(windowId: number): Promise<void>;
  /** Ends every session. The engine is the caller's to stop. */
  dispose(): void;
}

const ACTIVE = new Set(['collecting', 'translating', 'translated']);

interface Entry {
  session: PageSession;
  /** A translation waiting for the restore that precedes it. */
  queued: { from: string; to: string } | null;
}

export function createTranslationService(opts: TranslationServiceOptions): TranslationService {
  const entries = new Map<number, Entry>();

  function entryFor(windowId: number): Entry | null {
    const existing = entries.get(windowId);
    if (existing) return existing;
    const page = opts.pageFor(windowId);
    if (!page) return null;
    const entry: Entry = {
      queued: null,
      session: createPageSession({
        page,
        engine: opts.engine,
        pollMs: opts.pollMs,
        batchSize: opts.batchSize,
        setTimer: opts.setTimer,
        clearTimer: opts.clearTimer,
        onChange: (state) => {
          opts.onState?.(windowId, state);
          if (state.phase !== 'idle' || !entry.queued) return;
          const next = entry.queued;
          entry.queued = null;
          // A failed restore reloads the page; a translation started now would race the reload.
          if (state.error === null) entry.session.dispatch({ type: 'translate', ...next });
        },
      }),
    };
    entries.set(windowId, entry);
    return entry;
  }

  function closed(windowId: number): void {
    const entry = entries.get(windowId);
    if (!entry) return;
    entries.delete(windowId);
    entry.queued = null;
    entry.session.dispatch({ type: 'will-close' });
  }

  return {
    translate(windowId, pair) {
      const entry = entryFor(windowId);
      if (!entry) return 'no-page';
      const s = entry.session.state();
      if (s.phase === 'restoring') {
        entry.queued = { from: pair.from, to: pair.to };
        return 'queued';
      }
      if (ACTIVE.has(s.phase)) {
        if (s.from === pair.from && s.to === pair.to) return 'unchanged';
        entry.queued = { from: pair.from, to: pair.to };
        entry.session.dispatch({ type: 'show-original' });
        return 'queued';
      }
      entry.session.dispatch({ type: 'translate', from: pair.from, to: pair.to });
      return 'started';
    },
    showOriginal(windowId) {
      const entry = entries.get(windowId);
      if (!entry) return;
      entry.queued = null;
      entry.session.dispatch({ type: 'show-original' });
    },
    navigated(windowId) {
      const entry = entries.get(windowId);
      if (!entry) return;
      entry.queued = null;
      entry.session.dispatch({ type: 'navigated' });
    },
    closed,
    state(windowId) {
      return entries.get(windowId)?.session.state() ?? null;
    },
    idle(windowId) {
      return entries.get(windowId)?.session.idle() ?? Promise.resolve();
    },
    dispose() {
      for (const id of [...entries.keys()]) closed(id);
    },
  };
}
