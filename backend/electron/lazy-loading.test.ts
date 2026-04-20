/**
 * Unit tests for lazy extension loading patterns.
 *
 * These test the pubsub-level behavior of lazy stubs and interceptors
 * by simulating the same subscribe/unsubscribe/publish patterns used
 * in main.ts, without requiring Electron or extension host windows.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

let pubsub: typeof import('./pubsub.js');

describe('Lazy Loading Patterns', () => {
  before(async () => {
    pubsub = await import('./pubsub.js');
  });

  describe('command stub buffering pattern', () => {
    // Simulates the registerLazyCommand pattern from main.ts

    it('should buffer message and replay after load', async () => {
      const topic = 'cmd:execute:test-stub-1';
      const stubSource = 'lazy-stub/test-stub-1';
      let replayed: unknown = null;
      let loadTriggered = false;
      let pendingMsg: unknown = null;

      // Simulate the lazy stub
      pubsub.subscribe(stubSource, pubsub.scopes.GLOBAL, topic, async (msg: unknown) => {
        pendingMsg = msg;
        loadTriggered = true;

        // Simulate async extension load
        await Promise.resolve();

        // Unsubscribe stub
        pubsub.unsubscribe(stubSource, topic);

        // Subscribe the "real" handler
        pubsub.subscribe('peek://test/', pubsub.scopes.GLOBAL, topic, (m: unknown) => {
          replayed = m;
        });

        // Replay buffered message
        pubsub.publish(stubSource, pubsub.scopes.GLOBAL, topic, pendingMsg);
      });

      // Invoke the command
      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, topic, { arg: 'hello' });
      assert.strictEqual(loadTriggered, true);

      // Wait for async replay
      await Promise.resolve();
      await Promise.resolve();

      assert.deepStrictEqual(replayed, { arg: 'hello' });

      // Cleanup
      pubsub.unsubscribe('peek://test/', topic);
    });

    it('concurrent invocations should buffer latest message only', async () => {
      const topic = 'cmd:execute:test-stub-2';
      const stubSource = 'lazy-stub/test-stub-2';
      let replayed: unknown = null;
      let loadCount = 0;
      let pendingMsg: unknown = null;
      let alreadyLoading = false;

      // Resolve function to control when "load" completes
      let resolveLoad: () => void;
      const loadPromise = new Promise<void>(r => { resolveLoad = r; });

      pubsub.subscribe(stubSource, pubsub.scopes.GLOBAL, topic, async (msg: unknown) => {
        const wasLoading = alreadyLoading;
        pendingMsg = msg;

        if (wasLoading) {
          // Second invocation during load — just buffer, don't load again
          return;
        }

        alreadyLoading = true;
        loadCount++;

        // Simulate async extension load
        await loadPromise;

        pubsub.unsubscribe(stubSource, topic);

        // Subscribe the "real" handler
        pubsub.subscribe('peek://test2/', pubsub.scopes.GLOBAL, topic, (m: unknown) => {
          replayed = m;
        });

        // Replay buffered message (latest wins)
        pubsub.publish(stubSource, pubsub.scopes.GLOBAL, topic, pendingMsg);
      });

      // First invocation
      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, topic, { version: 1 });
      // Second invocation while loading
      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, topic, { version: 2 });

      assert.strictEqual(loadCount, 1, 'Should only trigger load once');

      // Complete the load
      resolveLoad!();
      await Promise.resolve();
      await Promise.resolve();

      assert.deepStrictEqual(replayed, { version: 2 }, 'Should replay latest message');

      // Cleanup
      pubsub.unsubscribe('peek://test2/', topic);
    });

    it('per-command stub sources should be independent', () => {
      const stub1 = 'lazy-stub/cmd-a';
      const stub2 = 'lazy-stub/cmd-b';
      let a = false, b = false;

      pubsub.subscribe(stub1, pubsub.scopes.GLOBAL, 'cmd:execute:cmd-a', () => { a = true; });
      pubsub.subscribe(stub2, pubsub.scopes.GLOBAL, 'cmd:execute:cmd-b', () => { b = true; });

      // Unsubscribing one shouldn't affect the other
      pubsub.unsubscribe(stub1, 'cmd:execute:cmd-a');

      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, 'cmd:execute:cmd-b', {});
      assert.strictEqual(b, true, 'cmd-b stub should still work');

      pubsub.unsubscribe(stub2, 'cmd:execute:cmd-b');
    });
  });

  describe('event interceptor buffering pattern', () => {
    it('should buffer and replay event after load', async () => {
      const topic = 'test:editor:open';
      const interceptorSource = `lazy-interceptor/${topic}`;
      let replayed: unknown = null;
      let pendingMsg: unknown = null;

      pubsub.subscribe(interceptorSource, pubsub.scopes.GLOBAL, topic, async (msg: unknown) => {
        pendingMsg = msg;

        // Simulate async load
        await Promise.resolve();

        pubsub.unsubscribe(interceptorSource, topic);

        // Subscribe the "real" handler
        pubsub.subscribe('peek://editor/', pubsub.scopes.GLOBAL, topic, (m: unknown) => {
          replayed = m;
        });

        pubsub.publish(interceptorSource, pubsub.scopes.GLOBAL, topic, pendingMsg);
      });

      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, topic, { file: 'test.txt' });

      await Promise.resolve();
      await Promise.resolve();

      assert.deepStrictEqual(replayed, { file: 'test.txt' });

      pubsub.unsubscribe('peek://editor/', topic);
    });

    it('concurrent events should buffer latest', async () => {
      const topic = 'test:editor:add';
      const interceptorSource = `lazy-interceptor/${topic}`;
      let replayed: unknown = null;
      let pendingMsg: unknown = null;
      let alreadyLoading = false;

      let resolveLoad: () => void;
      const loadPromise = new Promise<void>(r => { resolveLoad = r; });

      pubsub.subscribe(interceptorSource, pubsub.scopes.GLOBAL, topic, async (msg: unknown) => {
        const wasLoading = alreadyLoading;
        pendingMsg = msg;

        if (wasLoading) return;
        alreadyLoading = true;

        await loadPromise;

        pubsub.unsubscribe(interceptorSource, topic);

        pubsub.subscribe('peek://editor2/', pubsub.scopes.GLOBAL, topic, (m: unknown) => {
          replayed = m;
        });

        pubsub.publish(interceptorSource, pubsub.scopes.GLOBAL, topic, pendingMsg);
      });

      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, topic, { file: 'a.txt' });
      pubsub.publish('peek://cmd/', pubsub.scopes.GLOBAL, topic, { file: 'b.txt' });

      resolveLoad!();
      await Promise.resolve();
      await Promise.resolve();

      assert.deepStrictEqual(replayed, { file: 'b.txt' }, 'Should replay latest event');

      pubsub.unsubscribe('peek://editor2/', topic);
    });

    it('per-topic interceptor sources should be independent', () => {
      const src1 = 'lazy-interceptor/topic-x';
      const src2 = 'lazy-interceptor/topic-y';
      let x = false, y = false;

      pubsub.subscribe(src1, pubsub.scopes.GLOBAL, 'topic-x', () => { x = true; });
      pubsub.subscribe(src2, pubsub.scopes.GLOBAL, 'topic-y', () => { y = true; });

      pubsub.unsubscribe(src1, 'topic-x');

      pubsub.publish('peek://test/', pubsub.scopes.GLOBAL, 'topic-y', {});
      assert.strictEqual(y, true);

      pubsub.unsubscribe(src2, 'topic-y');
    });
  });

  describe('hasSubscriber verification pattern', () => {
    it('should detect when all command subscribers are present', () => {
      const topics = ['cmd:execute:a', 'cmd:execute:b', 'cmd:execute:c'];
      for (const t of topics) {
        pubsub.subscribe(`peek://test/${t}`, pubsub.scopes.GLOBAL, t, () => {});
      }

      const allPresent = topics.every(t => pubsub.hasSubscriber(t));
      assert.strictEqual(allPresent, true);

      for (const t of topics) {
        pubsub.unsubscribe(`peek://test/${t}`, t);
      }
    });

    it('should detect missing subscribers', () => {
      pubsub.subscribe('peek://test/x', pubsub.scopes.GLOBAL, 'cmd:execute:present', () => {});

      assert.strictEqual(pubsub.hasSubscriber('cmd:execute:present'), true);
      assert.strictEqual(pubsub.hasSubscriber('cmd:execute:missing'), false);

      pubsub.unsubscribe('peek://test/x', 'cmd:execute:present');
    });

    it('should work with zero expected topics', () => {
      const topics: string[] = [];
      const allPresent = topics.every(t => pubsub.hasSubscriber(t));
      assert.strictEqual(allPresent, true); // vacuous truth
    });
  });
});
