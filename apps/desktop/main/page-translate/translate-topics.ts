/**
 * The pubsub face of page translation, kept free of Electron so it runs under plain Node.
 * `translate-main.ts` supplies the real pubsub, service and engine.
 *
 * Topics:
 * - `translate:page {windowId, from, to}` asks for the window's page to be translated.
 * - `translate:show-original {windowId}` puts the page's own text back.
 * - `translate:state {windowId, phase, from, to, applied, error}` is published on every change
 *   of a window's session, and once with `error: 'no-page'` when a request names a window
 *   that has no web page, so a requester is never left waiting.
 */

import type { SessionEngine, SessionState } from './page-session.js';
import type { TranslationService } from './translation-service.js';

export const TRANSLATE_PAGE_TOPIC = 'translate:page';
export const TRANSLATE_SHOW_ORIGINAL_TOPIC = 'translate:show-original';
export const TRANSLATE_STATE_TOPIC = 'translate:state';

export interface TranslateStatePayload {
  windowId: number;
  phase: SessionState['phase'];
  from: string | null;
  to: string | null;
  applied: number;
  error: string | null;
}

export function statePayload(windowId: number, state: SessionState): TranslateStatePayload {
  return {
    windowId,
    phase: state.phase,
    from: state.from,
    to: state.to,
    applied: state.applied,
    error: state.error,
  };
}

export interface TopicPorts {
  subscribe(topic: string, cb: (msg: unknown) => void): void;
  unsubscribe(topic: string): void;
  publish(topic: string, msg: unknown): void;
}

function windowIdOf(msg: unknown): number | null {
  const id = (msg as { windowId?: unknown } | null)?.windowId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

function languageOf(msg: unknown, key: 'from' | 'to'): string | null {
  const v = (msg as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v) ? v : null;
}

/** Subscribes the request topics to `service`. Returns a function that unsubscribes them. */
export function installTranslateTopics(service: TranslationService, ports: TopicPorts): () => void {
  ports.subscribe(TRANSLATE_PAGE_TOPIC, (msg) => {
    const windowId = windowIdOf(msg);
    const from = languageOf(msg, 'from');
    const to = languageOf(msg, 'to');
    if (windowId === null || from === null || to === null || from === to) return;
    if (service.translate(windowId, { from, to }) === 'no-page') {
      ports.publish(TRANSLATE_STATE_TOPIC, {
        windowId,
        phase: 'idle',
        from,
        to,
        applied: 0,
        error: 'no-page',
      } satisfies TranslateStatePayload);
    }
  });
  ports.subscribe(TRANSLATE_SHOW_ORIGINAL_TOPIC, (msg) => {
    const windowId = windowIdOf(msg);
    if (windowId !== null) service.showOriginal(windowId);
  });
  return () => {
    ports.unsubscribe(TRANSLATE_PAGE_TOPIC);
    ports.unsubscribe(TRANSLATE_SHOW_ORIGINAL_TOPIC);
  };
}

/** An engine that also can be stopped; `engine-host.ts EngineHost` is one. */
export interface DisposableEngine extends SessionEngine {
  dispose(): void;
}

export interface LazyEngine extends SessionEngine {
  /** Stops the engine if it was ever created; later requests fail. */
  dispose(): void;
}

/**
 * Wraps an engine that is built asynchronously (the Electron spawner is imported lazily) so the
 * build happens once, on the first request, and never after `dispose`.
 */
export function lazyEngine(build: () => Promise<DisposableEngine>): LazyEngine {
  let built: Promise<DisposableEngine> | null = null;
  let disposed = false;
  return {
    async translate(req) {
      if (disposed) throw new Error('translation engine is disposed');
      built ??= build();
      let engine: DisposableEngine;
      try {
        engine = await built;
      } catch (err) {
        built = null;
        throw err;
      }
      if (disposed) throw new Error('translation engine is disposed');
      return engine.translate(req);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      built?.then(
        (e) => e.dispose(),
        () => {},
      );
    },
  };
}
