/**
 * Unit tests for PubSub module
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';

let pubsub: typeof import('./pubsub.js');

describe('PubSub Module Tests', () => {
  before(async () => {
    pubsub = await import('./pubsub.js');
  });

  describe('subscribe and publish', () => {
    it('should deliver message to subscriber', () => {
      let received: unknown = null;
      pubsub.subscribe('peek://test/a', 'test:basic', (msg) => {
        received = msg;
      });
      pubsub.publish('peek://test/b', 'test:basic', { data: 42 });
      assert.deepStrictEqual(received, { data: 42 });
      pubsub.unsubscribe('peek://test/a', 'test:basic');
    });

    it('should deliver to multiple subscribers', () => {
      let count = 0;
      pubsub.subscribe('peek://test/s1', 'test:multi', () => { count++; });
      pubsub.subscribe('peek://test/s2', 'test:multi', () => { count++; });
      pubsub.publish('peek://test/pub', 'test:multi', {});
      assert.strictEqual(count, 2);
      pubsub.unsubscribe('peek://test/s1', 'test:multi');
      pubsub.unsubscribe('peek://test/s2', 'test:multi');
    });

    it('should not throw when publishing with no subscribers', () => {
      assert.doesNotThrow(() => {
        pubsub.publish('peek://test/x', 'test:nosub', {});
      });
    });

    it('should replace callback when same source subscribes again', () => {
      let first = false;
      let second = false;
      pubsub.subscribe('peek://test/dup', 'test:replace', () => { first = true; });
      pubsub.subscribe('peek://test/dup', 'test:replace', () => { second = true; });
      pubsub.publish('peek://test/x', 'test:replace', {});
      assert.strictEqual(first, false);
      assert.strictEqual(second, true);
      pubsub.unsubscribe('peek://test/dup', 'test:replace');
    });
  });

  describe('unsubscribe', () => {
    it('should remove subscriber and stop delivery', () => {
      let count = 0;
      pubsub.subscribe('peek://test/unsub', 'test:unsub', () => { count++; });
      pubsub.publish('peek://test/x', 'test:unsub', {});
      assert.strictEqual(count, 1);
      pubsub.unsubscribe('peek://test/unsub', 'test:unsub');
      pubsub.publish('peek://test/x', 'test:unsub', {});
      assert.strictEqual(count, 1); // No additional delivery
    });

    it('should return false for non-existent subscription', () => {
      assert.strictEqual(pubsub.unsubscribe('peek://test/nope', 'test:nonexistent'), false);
    });
  });

  describe('unsubscribeAll', () => {
    it('should remove all subscriptions for a source', () => {
      let a = 0, b = 0;
      pubsub.subscribe('peek://test/all', 'test:all:a', () => { a++; });
      pubsub.subscribe('peek://test/all', 'test:all:b', () => { b++; });
      pubsub.unsubscribeAll('peek://test/all');
      pubsub.publish('peek://test/x', 'test:all:a', {});
      pubsub.publish('peek://test/x', 'test:all:b', {});
      assert.strictEqual(a, 0);
      assert.strictEqual(b, 0);
    });
  });

  describe('hasSubscriber', () => {
    it('should return true when subscriber exists', () => {
      pubsub.subscribe('peek://test/has', 'test:has', () => {});
      assert.strictEqual(pubsub.hasSubscriber('test:has'), true);
      pubsub.unsubscribe('peek://test/has', 'test:has');
    });

    it('should return false when no subscribers', () => {
      assert.strictEqual(pubsub.hasSubscriber('test:no:sub:exists'), false);
    });

    it('should return false after unsubscribe', () => {
      pubsub.subscribe('peek://test/gone', 'test:gone', () => {});
      pubsub.unsubscribe('peek://test/gone', 'test:gone');
      assert.strictEqual(pubsub.hasSubscriber('test:gone'), false);
    });

    it('should filter by source when provided', () => {
      pubsub.subscribe('peek://test/src1', 'test:has:src', () => {});
      assert.strictEqual(pubsub.hasSubscriber('test:has:src', 'peek://test/src1'), true);
      assert.strictEqual(pubsub.hasSubscriber('test:has:src', 'peek://test/other'), false);
      pubsub.unsubscribe('peek://test/src1', 'test:has:src');
    });

    it('should exclude subscribers by prefix', () => {
      pubsub.subscribe('lazy-stub/foo', 'test:has:excl', () => {});
      // Only stub subscriber — should return false when excluding stubs
      assert.strictEqual(pubsub.hasSubscriber('test:has:excl', undefined, 'lazy-stub/'), false);
      // Add a real subscriber
      pubsub.subscribe('peek://real/', 'test:has:excl', () => {});
      assert.strictEqual(pubsub.hasSubscriber('test:has:excl', undefined, 'lazy-stub/'), true);
      pubsub.unsubscribe('lazy-stub/foo', 'test:has:excl');
      pubsub.unsubscribe('peek://real/', 'test:has:excl');
    });
  });

  describe('setPubsubBroadcaster', () => {
    it('publishes invoke the registered broadcaster with topic/msg/source', () => {
      const calls: Array<{ topic: string; msg: unknown; source: string }> = [];
      pubsub.setPubsubBroadcaster((topic, msg, source) => {
        calls.push({ topic, msg, source });
      });
      pubsub.publish('peek://tile-foo/entry', 'test:broadcaster:fanout', { n: 1 });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].topic, 'test:broadcaster:fanout');
      assert.deepStrictEqual(calls[0].msg, { n: 1 });
      assert.strictEqual(calls[0].source, 'peek://tile-foo/entry');
      // Tear down so other tests aren't affected.
      pubsub.setPubsubBroadcaster(() => {});
    });

    it('broadcaster receives a v2-tile publish of cmd:execute:*:result so bgWindow-subscriber dispatchers can resolve', () => {
      // This is the Phase-1 regression guard. A v2 tile publishes a command
      // result topic. The main.ts broadcaster callback is responsible for
      // forwarding this to bgWindow (core), which is where the dispatcher
      // that set `resultTopic` lives. If the broadcaster is not invoked
      // for publishes, bgWindow never resolves the pending result promise
      // and tag/untag/widget-update smoke tests time out at 10s.
      const received: Array<{ topic: string; source: string }> = [];
      pubsub.setPubsubBroadcaster((topic, _msg, source) => {
        received.push({ topic, source });
      });
      pubsub.publish(
        'peek://tags/background',
        'cmd:execute:tag:result:abc-123',
        { ok: true },
      );
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].topic, 'cmd:execute:tag:result:abc-123');
      assert.strictEqual(received[0].source, 'peek://tags/background');
      pubsub.setPubsubBroadcaster(() => {});
    });
  });

  // ─── Phase 6: scope is gone ──────────────────────────────────────
  //
  // Regression guard for Phase 6 (see docs/pubsub-state-machine.md §Phased
  // implementation item 6). Scope (SYSTEM / SELF / GLOBAL) was removed
  // entirely — no runtime filter, no exported constants, no 4-argument
  // publish/subscribe shape. Privilege moved onto the topic name +
  // capability grant (topic allowlist in tile-ipc.ts).
  describe('Phase 6: scope is gone', () => {
    it('pubsub module does not export `scopes` or `Scope`', () => {
      const exports = Object.keys(pubsub as unknown as Record<string, unknown>);
      assert.ok(!exports.includes('scopes'), `pubsub exports scopes: ${exports.join(',')}`);
      // Type-only exports don't appear on the runtime module object, but
      // this assertion also guards against an accidental runtime re-export.
      assert.strictEqual(
        (pubsub as unknown as Record<string, unknown>).scopes,
        undefined,
      );
    });

    it('publish accepts (source, topic, msg) — 3 arguments, no scope slot', () => {
      // Function.length returns the arity (count of required args before
      // any default / rest). pubsub.publish is declared with exactly
      // three required parameters after Phase 6.
      assert.strictEqual(pubsub.publish.length, 3);
    });

    it('subscribe accepts (source, topic, cb) — 3 arguments, no scope slot', () => {
      assert.strictEqual(pubsub.subscribe.length, 3);
    });

    it('every subscriber receives every matching publish regardless of source', () => {
      // Pre-Phase-6 SELF scope would have filtered out delivery between
      // different pseudo-hosts. With scope deleted, cross-host delivery
      // is the default.
      let crossHost = 0;
      pubsub.subscribe('peek://app/x', 'phase6:xhost', () => { crossHost++; });
      pubsub.publish('peek://other/y', 'phase6:xhost', {});
      assert.strictEqual(crossHost, 1);
      pubsub.unsubscribe('peek://app/x', 'phase6:xhost');
    });
  });
});
