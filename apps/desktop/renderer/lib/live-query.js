import { createVisibilityGate } from 'peek://app/lib/visibility-gate.js';

/**
 * liveQuery — keep a derived view in sync with pubsub events.
 *
 * The reactive pattern across feature browsers (spaces, groups,
 * tags, entities…) is:
 *
 *   1. on init, run a query and render
 *   2. subscribe to N pubsub topics
 *   3. on any of those topics, re-run the same query and re-render
 *      (debounced so a burst of events coalesces)
 *
 * Open-coded, this is ~12 lines of nearly identical setup per
 * feature, easy to drift on (forget a topic, drop a debounce, leak
 * subscriptions). `liveQuery` collapses the pattern to one call.
 *
 * Public surface:
 *
 *   const handle = liveQuery({
 *     api,                    // window.app
 *     topics: [...],          // pubsub topics that trigger refresh
 *     query: async () => ...,  // (optional) async data source
 *     onUpdate: (data) => ..., // (optional) called with query result
 *     debounceMs: 150,         // coalesce bursts; default 150ms
 *     runImmediately: true,    // run once on construction; default true
 *     doc,                     // optional: injected document for testing
 *   });
 *
 *   handle.refresh()  // manually trigger (not visibility-gated)
 *   handle.destroy()  // unsubscribe and stop pending timers
 *
 * Either `query` or `onUpdate` must be supplied (or both). When only
 * `onUpdate` is given, it's called with no args — useful for the
 * "subscribe-then-rerender-from-existing-state" shape (e.g. the
 * spaces home page, where the renderer reads its own DOM state).
 *
 * `query` is awaited; its result is passed to `onUpdate`. If `query`
 * throws, the error is logged and `onUpdate` is not called.
 *
 * Consumers must already have every topic in their manifest's
 * pubsub.topics allowlist — the `manifest-subscribe-drift` test
 * enforces this.
 *
 * Visibility gating: pubsub-driven refreshes (scheduleRun) are
 * deferred when document.hidden is true. The first refresh after the
 * tile becomes visible again drains the deferred call. The initial
 * runImmediately load and handle.refresh() are NOT gated — they run
 * unconditionally so newly opened tiles always populate their data.
 */
export const liveQuery = ({
  api,
  topics,
  query,
  onUpdate,
  debounceMs = 150,
  runImmediately = true,
  doc,
} = {}) => {
  if (!api?.pubsub?.subscribe) {
    throw new Error('[liveQuery] api.pubsub.subscribe required');
  }
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new Error('[liveQuery] topics[] required');
  }
  if (!query && !onUpdate) {
    throw new Error('[liveQuery] either query or onUpdate required');
  }

  let destroyed = false;
  let timer = null;
  const unsubs = [];

  const runOnce = async () => {
    if (destroyed) return;
    try {
      const data = query ? await query() : undefined;
      if (destroyed) return;
      if (onUpdate) onUpdate(data);
    } catch (err) {
      console.error('[liveQuery] refresh failed:', err);
    }
  };

  // Gate the pubsub-driven refresh path so hidden tiles don't churn.
  // runOnce() itself (used for runImmediately and handle.refresh()) is
  // intentionally not gated — tiles must load data on open and on demand.
  const { gated: gatedRun, destroy: destroyGate } = createVisibilityGate(runOnce, { doc });

  const scheduleRun = () => {
    if (destroyed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; gatedRun(); }, debounceMs);
  };

  for (const topic of topics) {
    const unsub = api.pubsub.subscribe(topic, scheduleRun);
    if (typeof unsub === 'function') unsubs.push(unsub);
  }

  if (runImmediately) runOnce();

  return {
    refresh: runOnce,
    destroy: () => {
      destroyed = true;
      destroyGate();
      if (timer !== null) { clearTimeout(timer); timer = null; }
      for (const u of unsubs) {
        try { u(); } catch { /* swallow */ }
      }
      unsubs.length = 0;
    },
  };
};
