/**
 * PubSub messaging system for cross-process communication (Electron main process)
 *
 * Handles:
 * - Topic-based publish/subscribe
 * - Scope-based message filtering (SYSTEM, SELF, GLOBAL)
 * - Extension window broadcasting (via callback)
 *
 * NOTE: The scope/topic logic is mirrored in app/lib/pubsub.js (the shared
 * renderer-layer PubSub engine). This file stays separate because the main
 * process acts as an IPC hub and cannot import ES modules from app/lib/.
 * If you change scope semantics here, update app/lib/pubsub.js too.
 */

// Message scopes
export const scopes = {
  SYSTEM: 1,
  SELF: 2,
  GLOBAL: 3
} as const;

export type Scope = typeof scopes[keyof typeof scopes];

// System address for privileged subscribers
const SYSTEM_ADDRESS = 'peek://system/';

// Topic subscribers: topic -> Map<source, callback>
const topics = new Map<string, Map<string, (msg: unknown) => void>>();

// Callback for broadcasting to extension windows
let extensionBroadcaster: ((topic: string, msg: unknown, source: string) => void) | null = null;

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
 * Extract pseudo-host from a peek:// URL
 * e.g., 'peek://app/foo.html' -> 'app'
 */
function getPseudoHost(str: string): string {
  return str.split('/')[2] || '';
}

/**
 * Check if a subscriber should receive a message based on scope
 */
function scopeCheck(pubSource: string, subSource: string, scope: Scope): boolean {
  // System address receives everything
  if (subSource === SYSTEM_ADDRESS) {
    return true;
  }
  // GLOBAL scope sends to everyone
  if (scope === scopes.GLOBAL) {
    return true;
  }
  // SELF scope only sends to same pseudo-host
  if (getPseudoHost(subSource) === getPseudoHost(pubSource)) {
    return true;
  }
  return false;
}

/**
 * Set the callback for broadcasting to extension windows
 * This is called from the main process to inject the window broadcasting logic
 */
export function setExtensionBroadcaster(
  broadcaster: (topic: string, msg: unknown, source: string) => void
): void {
  extensionBroadcaster = broadcaster;
}

/**
 * Publish a message to a topic.
 *
 * If a pre-publish hook matches `topic`, its result is consulted before
 * any subscriber runs. An async hook (returning a Promise) defers
 * delivery until the promise resolves; a `'skip'` result aborts the
 * publish entirely. See `registerPrePublishHook` for the mechanism.
 */
export function publish(source: string, scope: Scope, topic: string, msg: unknown): void {
  // Track session stats — counted once per publish call regardless of
  // whether a hook defers/skips delivery. Stats reflect publish intent.
  sessionStats.messagesPublished++;
  sessionStats.topicsUsed.add(topic);

  const hook = findPrePublishHook(topic);
  if (!hook) {
    deliver(source, scope, topic, msg);
    return;
  }

  let result: PrePublishHookResult | Promise<PrePublishHookResult>;
  try {
    result = hook(topic, msg);
  } catch (err) {
    console.error(`[pubsub] pre-publish hook threw for ${topic}:`, err);
    deliver(source, scope, topic, msg);
    return;
  }

  if (result && typeof (result as Promise<PrePublishHookResult>).then === 'function') {
    (result as Promise<PrePublishHookResult>).then(
      (val) => {
        if (val === 'skip') return;
        deliver(source, scope, topic, msg);
      },
      (err) => {
        // Hook failed mid-flight — best-effort deliver anyway so a
        // broken loader can't hang every matching publish forever.
        console.error(`[pubsub] pre-publish hook rejected for ${topic}:`, err);
        deliver(source, scope, topic, msg);
      },
    );
    return;
  }

  if (result === 'skip') return;
  deliver(source, scope, topic, msg);
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

function deliver(source: string, scope: Scope, topic: string, msg: unknown): void {
  // Route to traditional subscribers (via IPC callbacks)
  if (topics.has(topic)) {
    const t = topics.get(topic)!;
    for (const [subSource, cb] of t) {
      if (scopeCheck(source, subSource, scope)) {
        sessionStats.messagesDelivered++;
        cb(msg);
      }
    }
  }

  // Route to extension windows (GLOBAL scope only)
  if (scope === scopes.GLOBAL && extensionBroadcaster) {
    extensionBroadcaster(topic, msg, source);
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
 * Subscribe to a topic
 */
export function subscribe(
  source: string,
  scope: Scope,
  topic: string,
  cb: (msg: unknown) => void
): void {
  if (!topics.has(topic)) {
    topics.set(topic, new Map([[source, cb]]));
  } else {
    const subscribers = topics.get(topic)!;
    subscribers.set(source, cb);
  }
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
