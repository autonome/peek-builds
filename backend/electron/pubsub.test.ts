/**
 * Unit tests for PubSub module
 */

import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';

let pubsub: typeof import('./pubsub.js');

describe('PubSub Module Tests', () => {
  before(async () => {
    pubsub = await import('./pubsub.js');
  });

  describe('subscribe and publish', () => {
    it('should deliver message to subscriber', () => {
      let received: unknown = null;
      pubsub.subscribe('peek://test/a', pubsub.scopes.GLOBAL, 'test:basic', (msg) => {
        received = msg;
      });
      pubsub.publish('peek://test/b', pubsub.scopes.GLOBAL, 'test:basic', { data: 42 });
      assert.deepStrictEqual(received, { data: 42 });
      pubsub.unsubscribe('peek://test/a', 'test:basic');
    });

    it('should deliver to multiple subscribers', () => {
      let count = 0;
      pubsub.subscribe('peek://test/s1', pubsub.scopes.GLOBAL, 'test:multi', () => { count++; });
      pubsub.subscribe('peek://test/s2', pubsub.scopes.GLOBAL, 'test:multi', () => { count++; });
      pubsub.publish('peek://test/pub', pubsub.scopes.GLOBAL, 'test:multi', {});
      assert.strictEqual(count, 2);
      pubsub.unsubscribe('peek://test/s1', 'test:multi');
      pubsub.unsubscribe('peek://test/s2', 'test:multi');
    });

    it('should not throw when publishing with no subscribers', () => {
      assert.doesNotThrow(() => {
        pubsub.publish('peek://test/x', pubsub.scopes.GLOBAL, 'test:nosub', {});
      });
    });

    it('should replace callback when same source subscribes again', () => {
      let first = false;
      let second = false;
      pubsub.subscribe('peek://test/dup', pubsub.scopes.GLOBAL, 'test:replace', () => { first = true; });
      pubsub.subscribe('peek://test/dup', pubsub.scopes.GLOBAL, 'test:replace', () => { second = true; });
      pubsub.publish('peek://test/x', pubsub.scopes.GLOBAL, 'test:replace', {});
      assert.strictEqual(first, false);
      assert.strictEqual(second, true);
      pubsub.unsubscribe('peek://test/dup', 'test:replace');
    });
  });

  describe('scope filtering', () => {
    it('GLOBAL scope delivers to all subscribers', () => {
      let received = false;
      pubsub.subscribe('peek://other/sub', pubsub.scopes.GLOBAL, 'test:scope:global', () => { received = true; });
      pubsub.publish('peek://test/pub', pubsub.scopes.GLOBAL, 'test:scope:global', {});
      assert.strictEqual(received, true);
      pubsub.unsubscribe('peek://other/sub', 'test:scope:global');
    });

    it('SELF scope delivers only to same pseudo-host', () => {
      let sameHost = false;
      let diffHost = false;
      pubsub.subscribe('peek://app/sub1', pubsub.scopes.GLOBAL, 'test:scope:self', () => { sameHost = true; });
      pubsub.subscribe('peek://other/sub2', pubsub.scopes.GLOBAL, 'test:scope:self', () => { diffHost = true; });
      pubsub.publish('peek://app/pub', pubsub.scopes.SELF, 'test:scope:self', {});
      assert.strictEqual(sameHost, true);
      assert.strictEqual(diffHost, false);
      pubsub.unsubscribe('peek://app/sub1', 'test:scope:self');
      pubsub.unsubscribe('peek://other/sub2', 'test:scope:self');
    });

    it('SYSTEM address receives all scopes', () => {
      let received = false;
      const sysAddr = pubsub.getSystemAddress();
      pubsub.subscribe(sysAddr, pubsub.scopes.GLOBAL, 'test:scope:sys', () => { received = true; });
      pubsub.publish('peek://test/pub', pubsub.scopes.SELF, 'test:scope:sys', {});
      assert.strictEqual(received, true);
      pubsub.unsubscribe(sysAddr, 'test:scope:sys');
    });
  });

  describe('unsubscribe', () => {
    it('should remove subscriber and stop delivery', () => {
      let count = 0;
      pubsub.subscribe('peek://test/unsub', pubsub.scopes.GLOBAL, 'test:unsub', () => { count++; });
      pubsub.publish('peek://test/x', pubsub.scopes.GLOBAL, 'test:unsub', {});
      assert.strictEqual(count, 1);
      pubsub.unsubscribe('peek://test/unsub', 'test:unsub');
      pubsub.publish('peek://test/x', pubsub.scopes.GLOBAL, 'test:unsub', {});
      assert.strictEqual(count, 1); // No additional delivery
    });

    it('should return false for non-existent subscription', () => {
      assert.strictEqual(pubsub.unsubscribe('peek://test/nope', 'test:nonexistent'), false);
    });
  });

  describe('unsubscribeAll', () => {
    it('should remove all subscriptions for a source', () => {
      let a = 0, b = 0;
      pubsub.subscribe('peek://test/all', pubsub.scopes.GLOBAL, 'test:all:a', () => { a++; });
      pubsub.subscribe('peek://test/all', pubsub.scopes.GLOBAL, 'test:all:b', () => { b++; });
      pubsub.unsubscribeAll('peek://test/all');
      pubsub.publish('peek://test/x', pubsub.scopes.GLOBAL, 'test:all:a', {});
      pubsub.publish('peek://test/x', pubsub.scopes.GLOBAL, 'test:all:b', {});
      assert.strictEqual(a, 0);
      assert.strictEqual(b, 0);
    });
  });

  describe('hasSubscriber', () => {
    it('should return true when subscriber exists', () => {
      pubsub.subscribe('peek://test/has', pubsub.scopes.GLOBAL, 'test:has', () => {});
      assert.strictEqual(pubsub.hasSubscriber('test:has'), true);
      pubsub.unsubscribe('peek://test/has', 'test:has');
    });

    it('should return false when no subscribers', () => {
      assert.strictEqual(pubsub.hasSubscriber('test:no:sub:exists'), false);
    });

    it('should return false after unsubscribe', () => {
      pubsub.subscribe('peek://test/gone', pubsub.scopes.GLOBAL, 'test:gone', () => {});
      pubsub.unsubscribe('peek://test/gone', 'test:gone');
      assert.strictEqual(pubsub.hasSubscriber('test:gone'), false);
    });

    it('should filter by source when provided', () => {
      pubsub.subscribe('peek://test/src1', pubsub.scopes.GLOBAL, 'test:has:src', () => {});
      assert.strictEqual(pubsub.hasSubscriber('test:has:src', 'peek://test/src1'), true);
      assert.strictEqual(pubsub.hasSubscriber('test:has:src', 'peek://test/other'), false);
      pubsub.unsubscribe('peek://test/src1', 'test:has:src');
    });

    it('should exclude subscribers by prefix', () => {
      pubsub.subscribe('lazy-stub/foo', pubsub.scopes.GLOBAL, 'test:has:excl', () => {});
      // Only stub subscriber — should return false when excluding stubs
      assert.strictEqual(pubsub.hasSubscriber('test:has:excl', undefined, 'lazy-stub/'), false);
      // Add a real subscriber
      pubsub.subscribe('peek://ext/real/', pubsub.scopes.GLOBAL, 'test:has:excl', () => {});
      assert.strictEqual(pubsub.hasSubscriber('test:has:excl', undefined, 'lazy-stub/'), true);
      pubsub.unsubscribe('lazy-stub/foo', 'test:has:excl');
      pubsub.unsubscribe('peek://ext/real/', 'test:has:excl');
    });
  });
});
