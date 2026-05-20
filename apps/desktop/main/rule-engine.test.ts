/**
 * Unit tests for rule-engine.ts (Stage 2 of peek MCP plan 3d7d9239).
 *
 * Three test groups mirror the module's three layers:
 *   - evaluatePredicate — pure predicate evaluation matrix
 *   - topicMatches — exact + trailing-wildcard match
 *   - createRuleEngine — dispatcher behavior with a fake pubsub
 *
 * Runs under Electron-as-node like the rest of the backend unit
 * suite. No SQL: the engine accepts an injected `listEnabledRules`,
 * so tests just hand it an array.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  evaluatePredicate,
  topicMatches,
  isWildcardTopic,
  createRuleEngine,
  type RuleEnginePubsub,
  type RuleLike,
} from './rule-engine.js';

// ─── Predicate ──────────────────────────────────────────────────────

describe('evaluatePredicate: empty / trivial', () => {
  it('empty {} matches anything', () => {
    assert.strictEqual(evaluatePredicate({}, { x: 1 }), true);
    assert.strictEqual(evaluatePredicate({}, null), true);
    assert.strictEqual(evaluatePredicate({}, 42), true);
  });

  it('throws on array predicate', () => {
    assert.throws(() => evaluatePredicate([1, 2], {}), /array/);
  });
});

describe('evaluatePredicate: shorthand $eq', () => {
  it('matches when field equals value', () => {
    assert.strictEqual(evaluatePredicate({ tagName: 'todo' }, { tagName: 'todo' }), true);
  });
  it('rejects when field differs', () => {
    assert.strictEqual(evaluatePredicate({ tagName: 'todo' }, { tagName: 'done' }), false);
  });
  it('rejects when field is missing', () => {
    assert.strictEqual(evaluatePredicate({ tagName: 'todo' }, {}), false);
  });
});

describe('evaluatePredicate: dotted path', () => {
  it('navigates nested objects', () => {
    assert.strictEqual(
      evaluatePredicate({ 'item.url': 'https://x.dev' }, { item: { url: 'https://x.dev' } }),
      true,
    );
  });
  it('returns undefined on broken path (no match)', () => {
    assert.strictEqual(
      evaluatePredicate({ 'item.url': 'x' }, { item: null }),
      false,
    );
  });
});

describe('evaluatePredicate: operators', () => {
  it('$eq', () => {
    assert.strictEqual(evaluatePredicate({ x: { $eq: 1 } }, { x: 1 }), true);
    assert.strictEqual(evaluatePredicate({ x: { $eq: 1 } }, { x: 2 }), false);
  });
  it('$ne', () => {
    assert.strictEqual(evaluatePredicate({ x: { $ne: 1 } }, { x: 2 }), true);
    assert.strictEqual(evaluatePredicate({ x: { $ne: 1 } }, { x: 1 }), false);
  });
  it('$in', () => {
    assert.strictEqual(evaluatePredicate({ x: { $in: [1, 2] } }, { x: 2 }), true);
    assert.strictEqual(evaluatePredicate({ x: { $in: [1, 2] } }, { x: 3 }), false);
  });
  it('$exists', () => {
    assert.strictEqual(evaluatePredicate({ x: { $exists: true } }, { x: 1 }), true);
    assert.strictEqual(evaluatePredicate({ x: { $exists: true } }, {}), false);
    assert.strictEqual(evaluatePredicate({ x: { $exists: false } }, {}), true);
  });
  it('$startsWith / $endsWith / $contains', () => {
    assert.strictEqual(evaluatePredicate({ s: { $startsWith: 'foo' } }, { s: 'foobar' }), true);
    assert.strictEqual(evaluatePredicate({ s: { $startsWith: 'foo' } }, { s: 'barfoo' }), false);
    assert.strictEqual(evaluatePredicate({ s: { $endsWith: 'bar' } }, { s: 'foobar' }), true);
    assert.strictEqual(evaluatePredicate({ s: { $contains: 'oob' } }, { s: 'foobar' }), true);
    assert.strictEqual(evaluatePredicate({ s: { $contains: 'zzz' } }, { s: 'foobar' }), false);
  });
  it('string ops return false on non-string actuals (no throw)', () => {
    assert.strictEqual(evaluatePredicate({ s: { $startsWith: 'foo' } }, { s: 42 }), false);
    assert.strictEqual(evaluatePredicate({ s: { $contains: 'x' } }, {}), false);
  });
});

describe('evaluatePredicate: combinators', () => {
  it('$and', () => {
    const p = { $and: [{ a: 1 }, { b: 2 }] };
    assert.strictEqual(evaluatePredicate(p, { a: 1, b: 2 }), true);
    assert.strictEqual(evaluatePredicate(p, { a: 1, b: 3 }), false);
  });
  it('$or', () => {
    const p = { $or: [{ a: 1 }, { b: 2 }] };
    assert.strictEqual(evaluatePredicate(p, { a: 1, b: 9 }), true);
    assert.strictEqual(evaluatePredicate(p, { a: 9, b: 2 }), true);
    assert.strictEqual(evaluatePredicate(p, { a: 9, b: 9 }), false);
  });
  it('$not', () => {
    assert.strictEqual(evaluatePredicate({ $not: { a: 1 } }, { a: 2 }), true);
    assert.strictEqual(evaluatePredicate({ $not: { a: 1 } }, { a: 1 }), false);
  });
  it('nested combinators', () => {
    const p = { $and: [{ kind: 'url' }, { $or: [{ host: 'x.dev' }, { host: 'y.dev' }] }] };
    assert.strictEqual(evaluatePredicate(p, { kind: 'url', host: 'x.dev' }), true);
    assert.strictEqual(evaluatePredicate(p, { kind: 'url', host: 'z.dev' }), false);
    assert.strictEqual(evaluatePredicate(p, { kind: 'page', host: 'x.dev' }), false);
  });
});

describe('evaluatePredicate: error cases', () => {
  it('throws on unknown top-level operator', () => {
    assert.throws(() => evaluatePredicate({ $bogus: 1 }, {}), /unknown predicate operator/);
  });
  it('throws on unknown field operator', () => {
    assert.throws(() => evaluatePredicate({ x: { $bogus: 1 } }, { x: 1 }), /unknown predicate operator/);
  });
  it('throws on mixed operator + literal keys in a clause', () => {
    assert.throws(() => evaluatePredicate({ x: { $eq: 1, foo: 2 } }, { x: 1 }), /mixed/);
  });
  it('throws on $and with non-array', () => {
    assert.throws(() => evaluatePredicate({ $and: { a: 1 } }, {}), /\$and/);
  });
});

describe('evaluatePredicate: literal-object equality', () => {
  it('matches when nested object structurally equals expected', () => {
    assert.strictEqual(
      evaluatePredicate({ meta: { kind: 'url', host: 'x' } }, { meta: { kind: 'url', host: 'x' } }),
      true,
    );
    assert.strictEqual(
      evaluatePredicate({ meta: { kind: 'url', host: 'x' } }, { meta: { kind: 'url', host: 'y' } }),
      false,
    );
  });
});

// ─── Topic matcher ──────────────────────────────────────────────────

describe('topicMatches', () => {
  it('exact match', () => {
    assert.strictEqual(topicMatches('tag:added', 'tag:added'), true);
    assert.strictEqual(topicMatches('tag:added', 'tag:removed'), false);
  });
  it('trailing wildcard matches one segment', () => {
    assert.strictEqual(topicMatches('page:*', 'page:loaded'), true);
  });
  it('trailing wildcard matches multiple segments', () => {
    assert.strictEqual(topicMatches('page:*', 'page:nav:back'), true);
  });
  it('wildcard does NOT match the bare prefix', () => {
    assert.strictEqual(topicMatches('page:*', 'page:'), false);
    assert.strictEqual(topicMatches('page:*', 'page'), false);
  });
  it('wildcard does NOT match a different namespace', () => {
    assert.strictEqual(topicMatches('page:*', 'tag:added'), false);
  });
  it('isWildcardTopic', () => {
    assert.strictEqual(isWildcardTopic('page:*'), true);
    assert.strictEqual(isWildcardTopic('page:loaded'), false);
  });
});

// ─── Dispatcher ─────────────────────────────────────────────────────

interface FakeMsg { source: string; topic: string; msg: unknown }

function makeFakePubsub(): RuleEnginePubsub & {
  published: FakeMsg[];
  subs: Map<string, Map<string, (m: unknown) => void>>;
  emit(topic: string, msg: unknown): void;
} {
  const subs = new Map<string, Map<string, (m: unknown) => void>>();
  const published: FakeMsg[] = [];
  return {
    published,
    subs,
    publish(source: string, topic: string, msg: unknown) {
      published.push({ source, topic, msg });
      // Deliver to subscribers — real pubsub does this; tests rely on
      // it to model end-to-end loops.
      const m = subs.get(topic);
      if (m) for (const [, cb] of m) cb(msg);
    },
    subscribe(source: string, topic: string, cb: (m: unknown) => void) {
      let m = subs.get(topic);
      if (!m) { m = new Map(); subs.set(topic, m); }
      m.set(source, cb);
    },
    unsubscribe(source: string, topic: string) {
      const m = subs.get(topic);
      if (!m) return false;
      return m.delete(source);
    },
    /** Test helper: deliver an event to all subscribers of `topic`. */
    emit(topic: string, msg: unknown) {
      const m = subs.get(topic);
      if (!m) return;
      for (const [, cb] of m) cb(msg);
    },
  };
}

function makeRule(o: Partial<RuleLike> = {}): RuleLike {
  return {
    id: 'r1',
    featureId: 'f',
    topic: 'tag:added',
    match: {},
    scriptId: 'script-1',
    config: {},
    enabled: true,
    ordering: 0,
    ...o,
  };
}

describe('rule-engine: dispatcher subscribes to concrete topics', () => {
  it('rebuild() subscribes to each unique concrete topic', () => {
    const pubsub = makeFakePubsub();
    const rules = [
      makeRule({ id: 'a', topic: 'tag:added' }),
      makeRule({ id: 'b', topic: 'tag:removed' }),
      makeRule({ id: 'c', topic: 'tag:added' }),  // duplicate topic
    ];
    createRuleEngine({ pubsub, listEnabledRules: () => rules });
    assert.ok(pubsub.subs.has('tag:added'));
    assert.ok(pubsub.subs.has('tag:removed'));
    // also rules:changed is subscribed
    assert.ok(pubsub.subs.has('rules:changed'));
  });

  it('does NOT subscribe to wildcard rule topics (Stage 2 limitation)', () => {
    const pubsub = makeFakePubsub();
    createRuleEngine({
      pubsub,
      listEnabledRules: () => [makeRule({ id: 'w', topic: 'page:*' })],
    });
    assert.strictEqual(pubsub.subs.has('page:*'), false);
    assert.strictEqual(pubsub.subs.has('page'), false);
  });
});

describe('rule-engine: dispatch fires scripts:execute', () => {
  it('publishes scripts:execute with the rule scriptId, event, and config', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [makeRule({
        scriptId: 'tag-swap',
        config: { activeTag: 'todo', completedTag: 'done' },
      })],
    });
    engine.dispatch('tag:added', { tagName: 'todo', itemId: 'item-1' });

    const exec = pubsub.published.find(p => p.topic === 'scripts:execute:tag-swap');
    assert.ok(exec, 'scripts:execute was published');
    assert.deepStrictEqual(exec.msg, {
      scriptId: 'tag-swap',
      context: {
        event: { tagName: 'todo', itemId: 'item-1' },
        config: { activeTag: 'todo', completedTag: 'done' },
        ruleId: 'r1',
        featureId: 'f',
      },
    });
  });

  it('skips when predicate does not match', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [makeRule({ match: { tagName: 'todo' } })],
    });
    engine.dispatch('tag:added', { tagName: 'other' });
    assert.strictEqual(pubsub.published.filter(p => p.topic === 'scripts:execute:tag-swap').length, 0);
  });

  it('skips disabled rules at fire time (filtered, not unsubscribed)', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [makeRule({ enabled: false })],
    });
    engine.dispatch('tag:added', { tagName: 'todo' });
    assert.strictEqual(
      pubsub.published.filter(p => p.topic.startsWith('scripts:execute:')).length,
      0,
    );
  });

  it('orders by rule.ordering ascending', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [
        makeRule({ id: 'late', scriptId: 's-late', ordering: 5 }),
        makeRule({ id: 'early', scriptId: 's-early', ordering: 1 }),
      ],
    });
    engine.dispatch('tag:added', {});
    const execs = pubsub.published.filter(p => p.topic.startsWith('scripts:execute:'));
    assert.strictEqual(execs.length, 2);
    assert.strictEqual(execs[0].topic, 'scripts:execute:s-early');
    assert.strictEqual(execs[1].topic, 'scripts:execute:s-late');
  });

  it('fires for the right rules when topic has multiple subscribers', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [
        makeRule({ id: 'a', topic: 'tag:added', scriptId: 's-a' }),
        makeRule({ id: 'b', topic: 'tag:added', scriptId: 's-b' }),
        makeRule({ id: 'c', topic: 'tag:removed', scriptId: 's-c' }),
      ],
    });
    engine.dispatch('tag:added', {});
    const topics = pubsub.published
      .filter(p => p.topic.startsWith('scripts:execute:'))
      .map(p => p.topic)
      .sort();
    assert.deepStrictEqual(topics, ['scripts:execute:s-a', 'scripts:execute:s-b']);
  });
});

describe('rule-engine: rules:changed triggers rebuild', () => {
  it('subscribing to a new rule\'s topic happens after rules:changed fires', () => {
    const pubsub = makeFakePubsub();
    let rules: RuleLike[] = [makeRule({ topic: 'tag:added' })];
    createRuleEngine({ pubsub, listEnabledRules: () => rules });
    assert.ok(pubsub.subs.has('tag:added'));
    assert.strictEqual(pubsub.subs.has('tag:removed'), false);

    rules = [makeRule({ topic: 'tag:removed' })];
    pubsub.emit('rules:changed', {});

    assert.ok(pubsub.subs.has('tag:removed'));
    // old subscription removed
    const oldSubs = pubsub.subs.get('tag:added');
    assert.ok(!oldSubs || oldSubs.size === 0);
  });
});

describe('rule-engine: end-to-end via real subscription path', () => {
  it('publish→dispatch via the subscribed callback fires scripts:execute', () => {
    const pubsub = makeFakePubsub();
    createRuleEngine({
      pubsub,
      listEnabledRules: () => [makeRule({
        topic: 'tag:added',
        match: { tagName: 'todo' },
        scriptId: 'tag-swap',
      })],
    });
    pubsub.emit('tag:added', { tagName: 'todo', itemId: 'i1' });
    assert.ok(pubsub.published.some(p => p.topic === 'scripts:execute:tag-swap'));
  });
});

describe('rule-engine: recursion cap', () => {
  it('beyond maxDepth, emits rules:loop-detected and drops the deepest fire', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [makeRule({ topic: 'loop:tick', scriptId: 'noop' })],
      maxDepth: 3,
    });

    // Simulate a "script" that re-publishes the same event on every
    // scripts:execute — fake pubsub.publish delivers synchronously, so
    // the engine's own subscription on loop:tick re-enters dispatch.
    pubsub.subscribe('test-script', 'scripts:execute:noop', () => {
      pubsub.publish('test-script', 'loop:tick', {});
    });

    engine.dispatch('loop:tick', {});

    const loopHits = pubsub.published.filter(p => p.topic === 'rules:loop-detected');
    assert.ok(loopHits.length >= 1, 'rules:loop-detected was emitted');
  });
});

describe('rule-engine: stop()', () => {
  it('unsubscribes from all topics', () => {
    const pubsub = makeFakePubsub();
    const engine = createRuleEngine({
      pubsub,
      listEnabledRules: () => [
        makeRule({ topic: 'a' }),
        makeRule({ topic: 'b' }),
      ],
    });
    engine.stop();
    const aSubs = pubsub.subs.get('a');
    const bSubs = pubsub.subs.get('b');
    assert.ok(!aSubs || aSubs.size === 0);
    assert.ok(!bSubs || bSubs.size === 0);
  });
});
