/**
 * Rule Engine — Stage 2 of peek MCP plan 3d7d9239.
 *
 * Subscribes to the pubsub bus on behalf of every enabled rule in the
 * `rules` table; on a matching event, evaluates the rule's JSON
 * predicate against the payload and publishes `scripts:execute` so the
 * scripts feature runs the named script.
 *
 * Three layers, each independently testable:
 *
 *   1. `evaluatePredicate(predicate, payload)` — pure function. The
 *      predicate language is a JSON object: top-level keys are field
 *      paths (dotted, e.g. `item.url`), values are either a plain
 *      value (shorthand `$eq`) or an operator object. Boolean
 *      combinators `$and` / `$or` / `$not` short-circuit.
 *   2. `topicMatches(ruleTopic, eventTopic)` — pure function. Exact
 *      match, or `prefix:*` style trailing wildcard (one segment or
 *      many — `page:*` matches `page:loaded`, `page:nav:back`, …).
 *   3. The dispatcher (`createRuleEngine`) — wires the rule index to
 *      pubsub. Stage 2 supports concrete-topic subscriptions only;
 *      wildcard rules are persisted but not dispatched (TODO below).
 *
 * Recursion: scripts that publish events can re-enter the dispatcher.
 * A per-publish depth counter caps recursion at MAX_DEPTH; exceeding
 * it emits `rules:loop-detected` telemetry and drops the deepest fire.
 */

// ─── Predicate language ─────────────────────────────────────────────

const SUPPORTED_OPS = new Set([
  '$eq', '$ne', '$in', '$exists',
  '$startsWith', '$endsWith', '$contains',
  '$and', '$or', '$not',
]);

function getPath(payload: unknown, path: string): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  const parts = path.split('.');
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function evalOperator(op: string, expected: unknown, actual: unknown): boolean {
  switch (op) {
    case '$eq':
      return actual === expected;
    case '$ne':
      return actual !== expected;
    case '$in':
      return Array.isArray(expected) && expected.includes(actual);
    case '$exists':
      return (actual !== undefined) === Boolean(expected);
    case '$startsWith':
      return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected);
    case '$endsWith':
      return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected);
    case '$contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    default:
      throw new Error(`unknown predicate operator: ${op}`);
  }
}

/**
 * Evaluate a JSON predicate against a payload. Throws on unknown
 * operators so typos are caught loudly at register time (callers can
 * choose to wrap-and-log if they prefer). Empty `{}` matches anything.
 */
export function evaluatePredicate(predicate: unknown, payload: unknown): boolean {
  // `null` / non-object predicates: only match an identical payload.
  if (predicate === null) return payload === null;
  if (typeof predicate !== 'object') return predicate === payload;

  // Arrays are not valid predicates at the top level.
  if (Array.isArray(predicate)) {
    throw new Error('predicate must be an object, not an array');
  }

  for (const [key, value] of Object.entries(predicate)) {
    if (key === '$and') {
      if (!Array.isArray(value)) throw new Error('$and expects an array');
      if (!value.every(p => evaluatePredicate(p, payload))) return false;
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(value)) throw new Error('$or expects an array');
      if (!value.some(p => evaluatePredicate(p, payload))) return false;
      continue;
    }
    if (key === '$not') {
      if (evaluatePredicate(value, payload)) return false;
      continue;
    }
    if (key.startsWith('$')) {
      throw new Error(`unknown predicate operator at top level: ${key}`);
    }

    // Field clause. Value is either a plain value (shorthand $eq) or
    // an operator object.
    const actual = getPath(payload, key);
    if (isPlainObject(value)) {
      // Detect: are the keys all operators, or is it a literal nested
      // object we should compare structurally? Keep the rule simple:
      // if ANY top-level key starts with `$`, treat the whole object
      // as operators (and reject mixed). Otherwise compare by deep
      // equality (JSON-stringified).
      const keys = Object.keys(value);
      const hasOp = keys.some(k => k.startsWith('$'));
      if (hasOp) {
        for (const opKey of keys) {
          if (!opKey.startsWith('$')) {
            throw new Error(`mixed operator and literal keys in clause for "${key}"`);
          }
          if (!SUPPORTED_OPS.has(opKey)) {
            throw new Error(`unknown predicate operator: ${opKey}`);
          }
          if (!evalOperator(opKey, (value as Record<string, unknown>)[opKey], actual)) {
            return false;
          }
        }
      } else {
        // Structural equality.
        if (JSON.stringify(actual) !== JSON.stringify(value)) return false;
      }
    } else {
      // Plain value — shorthand for $eq.
      if (actual !== value) return false;
    }
  }
  return true;
}

// ─── Topic matcher ──────────────────────────────────────────────────

/**
 * Match a rule's topic against a published event topic.
 *
 * Supported forms:
 *   - exact: `tag:added` matches `tag:added`
 *   - trailing wildcard: `page:*` matches `page:loaded`, `page:nav:back`, …
 *
 * The wildcard always lives at the end; embedded wildcards are not
 * supported (and would silently never match — callers should validate
 * at register time if they care).
 */
export function topicMatches(ruleTopic: string, eventTopic: string): boolean {
  if (ruleTopic === eventTopic) return true;
  if (!ruleTopic.endsWith(':*')) return false;
  const prefix = ruleTopic.slice(0, -1); // keep the trailing colon
  return eventTopic.startsWith(prefix) && eventTopic.length > prefix.length;
}

export function isWildcardTopic(topic: string): boolean {
  return topic.endsWith(':*');
}

// ─── Dispatcher ─────────────────────────────────────────────────────

/**
 * Minimal pubsub surface — kept abstract so tests can pass a fake
 * without dragging in the real module. Mirrors `pubsub.ts`'s shape.
 */
export interface RuleEnginePubsub {
  publish(source: string, topic: string, msg: unknown): void;
  subscribe(source: string, topic: string, cb: (msg: unknown) => void): void;
  unsubscribe(source: string, topic: string): boolean;
}

/**
 * Minimal datastore surface — exposes only what the engine needs.
 * `listRules` mirrors rules.ts:listRules; we accept it as an injected
 * function so the engine module has no SQL dependency at import time.
 */
export interface RuleEngineDeps {
  pubsub: RuleEnginePubsub;
  /** Returns every enabled rule. Filters can be applied by the caller. */
  listEnabledRules: () => RuleLike[];
  /** Publish source identity for the engine itself. */
  source?: string;
  /** Override telemetry topic prefix; defaults to `rules:`. */
  telemetryPrefix?: string;
  /** Override the script-invocation topic prefix; defaults to
   *  `scripts:execute:` so each script gets its own concrete topic
   *  (`scripts:execute:<scriptId>`). Per-script topics let lazy
   *  features wake only when their own script fires, instead of every
   *  scripts:execute publish loading every script-owning feature. */
  scriptsExecuteTopicPrefix?: string;
  /** Recursion cap. Default 8. */
  maxDepth?: number;
}

/** Subset of the Rule shape the engine needs. */
export interface RuleLike {
  id: string;
  featureId: string;
  topic: string;
  match: Record<string, unknown>;
  scriptId: string;
  config: Record<string, unknown>;
  enabled: boolean;
  ordering: number;
}

const DEFAULT_MAX_DEPTH = 8;

export interface RuleEngine {
  /**
   * Rebuild the topic→rules index from `listEnabledRules()` and
   * reconcile pubsub subscriptions: subscribe to any newly-needed
   * concrete topic, unsubscribe from topics whose rules have all gone
   * away.
   */
  rebuild(): void;
  /**
   * Test seam: invoke the dispatcher synchronously as if `topic` was
   * published with `payload`. Used by unit tests and by tracing tools.
   */
  dispatch(topic: string, payload: unknown): void;
  /** Stop the engine — unsubscribe from everything. */
  stop(): void;
}

export function createRuleEngine(deps: RuleEngineDeps): RuleEngine {
  const source = deps.source ?? 'rule-engine';
  const scriptsExecuteTopicPrefix = deps.scriptsExecuteTopicPrefix ?? 'scripts:execute:';
  const telemetryPrefix = deps.telemetryPrefix ?? 'rules:';
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Index: concrete topic → ordered rule list. Wildcard rules go in a
  // separate list and are NOT subscribed; they're documented as future
  // work. Their topicMatches() behavior is still tested so when we
  // wire wildcard subscription, we already trust the matcher.
  const concreteIndex = new Map<string, RuleLike[]>();
  const wildcardRules: RuleLike[] = [];
  const subscribedTopics = new Set<string>();
  let depth = 0;

  function fireRule(rule: RuleLike, payload: unknown): void {
    let matched: boolean;
    try {
      matched = evaluatePredicate(rule.match, payload);
    } catch (err) {
      // Bad predicate — log + skip. A malformed rule shouldn't break
      // dispatch for siblings.
      console.warn(`[rule-engine] predicate eval threw for rule ${rule.id}:`, err);
      return;
    }
    if (!matched) return;

    deps.pubsub.publish(source, scriptsExecuteTopicPrefix + rule.scriptId, {
      scriptId: rule.scriptId,
      context: { event: payload, config: rule.config, ruleId: rule.id, featureId: rule.featureId },
    });
  }

  function dispatch(topic: string, payload: unknown): void {
    if (depth >= maxDepth) {
      try {
        deps.pubsub.publish(source, `${telemetryPrefix}loop-detected`, {
          topic, depth, maxDepth,
        });
      } catch {
        // telemetry must never throw out of the engine
      }
      return;
    }

    const concreteHits = concreteIndex.get(topic);
    const wildcardHits = wildcardRules.filter(r => topicMatches(r.topic, topic));

    // Combine + sort by ordering. Skip disabled rules at fire time so
    // hot-toggling enabled flips reflect immediately on the next event
    // without needing an index rebuild.
    const all = [...(concreteHits ?? []), ...wildcardHits]
      .filter(r => r.enabled)
      .sort((a, b) => a.ordering - b.ordering);

    if (all.length === 0) return;

    depth++;
    try {
      for (const r of all) fireRule(r, payload);
    } finally {
      depth--;
    }
  }

  function rebuild(): void {
    const rules = deps.listEnabledRules();
    const nextConcrete = new Map<string, RuleLike[]>();
    const nextWildcard: RuleLike[] = [];
    const wantedTopics = new Set<string>();

    for (const r of rules) {
      if (isWildcardTopic(r.topic)) {
        nextWildcard.push(r);
        continue;
      }
      const list = nextConcrete.get(r.topic) ?? [];
      list.push(r);
      nextConcrete.set(r.topic, list);
      wantedTopics.add(r.topic);
    }

    // Subscribe to newly-needed concrete topics.
    for (const t of wantedTopics) {
      if (subscribedTopics.has(t)) continue;
      deps.pubsub.subscribe(source, t, (msg) => dispatch(t, msg));
      subscribedTopics.add(t);
    }

    // Unsubscribe from concrete topics no rule wants any more.
    for (const t of Array.from(subscribedTopics)) {
      if (!wantedTopics.has(t)) {
        deps.pubsub.unsubscribe(source, t);
        subscribedTopics.delete(t);
      }
    }

    concreteIndex.clear();
    for (const [t, list] of nextConcrete) concreteIndex.set(t, list);
    wildcardRules.length = 0;
    wildcardRules.push(...nextWildcard);
  }

  function stop(): void {
    for (const t of subscribedTopics) deps.pubsub.unsubscribe(source, t);
    subscribedTopics.clear();
    concreteIndex.clear();
    wildcardRules.length = 0;
  }

  // Listen for rules:changed so register/unregister IPC writes are
  // reflected without a full reboot. The handler is intentionally
  // minimal — the index rebuild is cheap (single SELECT + map work)
  // and easier to reason about than incremental delta application.
  deps.pubsub.subscribe(source, 'rules:changed', () => {
    try { rebuild(); }
    catch (err) { console.error('[rule-engine] rebuild after rules:changed failed:', err); }
  });

  // Initial population.
  rebuild();

  return { rebuild, dispatch, stop };
}
