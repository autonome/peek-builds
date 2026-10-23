/**
 * PubSub messaging system for cross-process communication (Electron main process)
 *
 * Handles:
 * - Topic-based publish/subscribe
 * - Renderer window broadcasting (via callback)
 *
 * Scope (SYSTEM / SELF / GLOBAL) was removed in Phase 6 of the pubsub
 * state-machine plan (see docs/pubsub-state-machine.md). Every subscriber
 * now receives every publish whose topic it subscribed to; privilege is
 * enforced by capability grants (topic allowlists) and by topic naming,
 * not by a runtime scope filter.
 */

// System address for privileged subscribers
const SYSTEM_ADDRESS = 'peek://system/';

// Topic subscribers: topic -> Map<source, callback>
// (a list per source: only the system address ever holds more than one)
const topics = new Map<string, Map<string, Array<(msg: unknown) => void>>>();

// Callback for broadcasting to renderer windows (bgWindow, tile windows, webview guests)
let pubsubBroadcaster: ((topic: string, msg: unknown, source: string) => void) | null = null;

/**
 * Pre-publish hooks let a module intercept publish calls before delivery.
 * Return value / resolved value controls what happens next:
 *   - `undefined` / `'continue'` — proceed with normal delivery
 *   - `'skip'` — drop this publish; no subscriber runs, no extension broadcast
 *   - `Promise` — deliver is deferred until the promise resolves; the
 *     promise's resolved value is then interpreted the same way
 *
 * Matched in registration order — first hook whose predicate returns true
 * wins (so more-specific hooks should register first, or the predicate
 * itself should be selective). Multiple hooks for the same topic aren't
 * composed; that path is load-on-dispatch only today.
 *
 * Rationale: lets the tile lifecycle module enforce "load the owning tile
 * before a `cmd:execute:X` or declared lazyEvent topic reaches its
 * handler" without every caller having to know about tile state, and
 * without littering the pubsub registry with per-command stub subscribers.
 */
export type PrePublishHookResult = void | 'continue' | 'skip';
export type PrePublishHook = (topic: string, msg: unknown) => PrePublishHookResult | Promise<PrePublishHookResult>;
export type PrePublishHookPredicate = (topic: string) => boolean;

const prePublishHooks: Array<{ predicate: PrePublishHookPredicate; hook: PrePublishHook }> = [];

// Session stats tracking
const sessionStats = {
  messagesPublished: 0,
  messagesDelivered: 0,
  topicsUsed: new Set<string>(),  // topics that had at least one publish this session
};

/**
 * Set the callback for broadcasting to renderer windows
 * This is called from the main process to inject the window broadcasting logic
 */
export function setPubsubBroadcaster(
  broadcaster: (topic: string, msg: unknown, source: string) => void
): void {
  pubsubBroadcaster = broadcaster;
}

/**
 * Publish a message to a topic.
 *
 * If a pre-publish hook matches `topic`, its result is consulted before
 * any subscriber runs. An async hook (returning a Promise) defers
 * delivery until the promise resolves; a `'skip'` result aborts the
 * publish entirely. See `registerPrePublishHook` for the mechanism.
 */
export function publish(source: string, topic: string, msg: unknown): void {
  // Track session stats — counted once per publish call regardless of
  // whether a hook defers/skips delivery. Stats reflect publish intent.
  sessionStats.messagesPublished++;
  sessionStats.topicsUsed.add(topic);

  const hook = findPrePublishHook(topic);
  if (!hook) {
    deliver(source, topic, msg);
    return;
  }

  let result: PrePublishHookResult | Promise<PrePublishHookResult>;
  try {
    result = hook(topic, msg);
  } catch (err) {
    console.error(`[pubsub] pre-publish hook threw for ${topic}:`, err);
    deliver(source, topic, msg);
    return;
  }

  if (result && typeof (result as Promise<PrePublishHookResult>).then === 'function') {
    (result as Promise<PrePublishHookResult>).then(
      (val) => {
        if (val === 'skip') return;
        deliver(source, topic, msg);
      },
      (err) => {
        // Hook failed mid-flight — best-effort deliver anyway so a
        // broken loader can't hang every matching publish forever.
        console.error(`[pubsub] pre-publish hook rejected for ${topic}:`, err);
        deliver(source, topic, msg);
      },
    );
    return;
  }

  if (result === 'skip') return;
  deliver(source, topic, msg);
}

function findPrePublishHook(topic: string): PrePublishHook | null {
  for (const { predicate, hook } of prePublishHooks) {
    try {
      if (predicate(topic)) return hook;
    } catch (err) {
      console.error('[pubsub] pre-publish predicate threw:', err);
    }
  }
  return null;
}

function deliver(source: string, topic: string, msg: unknown): void {
  // Route to traditional subscribers (via IPC callbacks) — every subscriber
  // on this topic receives the message. Scope filtering was removed in
  // Phase 6; privilege is enforced by capability grants and topic naming.
  if (topics.has(topic)) {
    const t = topics.get(topic)!;
    // Snapshot so a callback that unsubscribes (itself or another) mid-delivery
    // does not skip the next one.
    for (const cbs of [...t.values()]) {
      for (const cb of [...cbs]) {
        sessionStats.messagesDelivered++;
        cb(msg);
      }
    }
  }

  // Route to renderer windows. In Phase 5 this was gated on GLOBAL scope;
  // with scope gone, every publish routes to the broadcaster so tile
  // windows and bgWindow subscribers see the event.
  if (pubsubBroadcaster) {
    pubsubBroadcaster(topic, msg, source);
  }
}

/**
 * Register a pre-publish hook. Returns an unsubscribe function.
 *
 * `predicate` runs on every publish; keep it fast (no I/O, no
 * allocation where avoidable). Only when it returns true does `hook`
 * run. See `PrePublishHook` for result semantics.
 */
export function registerPrePublishHook(
  predicate: PrePublishHookPredicate,
  hook: PrePublishHook,
): () => void {
  const entry = { predicate, hook };
  prePublishHooks.push(entry);
  return () => {
    const idx = prePublishHooks.indexOf(entry);
    if (idx >= 0) prePublishHooks.splice(idx, 1);
  };
}

/** @internal Test hook: clear all registered pre-publish hooks. */
export function __clearPrePublishHooksForTest(): void {
  prePublishHooks.length = 0;
}

/**
 * Subscribe to a topic.
 *
 * Callbacks from the system address stack: every one runs, in registration
 * order, because several main-process modules can each watch the same topic.
 * Any other source keeps a single callback per topic, so a renderer that
 * reloads and subscribes again replaces its old callback instead of doubling it.
 *
 * Returns a disposer that removes only this callback (a no-op if it was already
 * removed or replaced).
 */
export function subscribe(
  source: string,
  topic: string,
  cb: (msg: unknown) => void
): () => void {
  let subscribers = topics.get(topic);
  if (!subscribers) {
    subscribers = new Map();
    topics.set(topic, subscribers);
  }
  const existing = subscribers.get(source);
  if (existing && source === SYSTEM_ADDRESS) {
    existing.push(cb);
  } else {
    subscribers.set(source, [cb]);
  }
  return () => {
    const current = topics.get(topic)?.get(source);
    if (!current) return;
    const idx = current.indexOf(cb);
    if (idx < 0) return;
    current.splice(idx, 1);
    if (current.length === 0) topics.get(topic)!.delete(source);
  };
}

/**
 * Unsubscribe from a topic
 */
export function unsubscribe(source: string, topic: string): boolean {
  if (!topics.has(topic)) {
    return false;
  }
  const subscribers = topics.get(topic)!;
  return subscribers.delete(source);
}

/**
 * Unsubscribe from all topics for a source
 */
export function unsubscribeAll(source: string): void {
  for (const [, subscribers] of topics) {
    subscribers.delete(source);
  }
}

/**
 * Unsubscribe every topic-subscription whose source key starts with `prefix`.
 *
 * Tiles use a per-window source address of `peek://{tileId}/{entry}`. When a
 * tile window closes (or is disabled / uninstalled), its subscriptions must be
 * removed from the main-process registry to prevent handler leaks. Pass the
 * tile prefix `peek://{tileId}/` to clear every entry-level subscription at
 * once.
 *
 * Returns the number of subscriptions removed.
 */
export function unsubscribeAllByPrefix(prefix: string): number {
  if (!prefix) return 0;
  let removed = 0;
  for (const [, subscribers] of topics) {
    for (const key of subscribers.keys()) {
      if (key.startsWith(prefix)) {
        subscribers.delete(key);
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Check if a topic has subscribers
 * If source is provided, checks for that specific source.
 * If excludePrefix is provided, checks for any subscriber whose key
 * does NOT start with that prefix.
 */
export function hasSubscriber(topic: string, source?: string, excludePrefix?: string): boolean {
  const subscribers = topics.get(topic);
  if (!subscribers) return false;
  if (source) return subscribers.has(source);
  if (excludePrefix) {
    for (const key of subscribers.keys()) {
      if (!key.startsWith(excludePrefix)) return true;
    }
    return false;
  }
  return subscribers.size > 0;
}

/**
 * Get the system address constant
 */
export function getSystemAddress(): string {
  return SYSTEM_ADDRESS;
}

/**
 * Get pubsub session statistics
 */
export function getStats(): {
  topicsRegistered: number;
  topicsUsedThisSession: number;
  messagesPublished: number;
  messagesDelivered: number;
} {
  return {
    topicsRegistered: topics.size,
    topicsUsedThisSession: sessionStats.topicsUsed.size,
    messagesPublished: sessionStats.messagesPublished,
    messagesDelivered: sessionStats.messagesDelivered,
  };
}
