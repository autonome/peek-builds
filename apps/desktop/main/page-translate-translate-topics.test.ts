/**
 * Translation topics (page-translate/translate-topics.ts): the pubsub request handlers against a
 * fake service, the state payload, and the lazily built engine. Sits at the top level of main/
 * so the shared `dist/main/*.test.js` glob runs it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { INITIAL_SESSION_STATE, type EngineRequest } from './page-translate/page-session.js';
import type { TranslateOutcome, TranslationService } from './page-translate/translation-service.js';
import {
  installTranslateTopics,
  lazyEngine,
  statePayload,
  TRANSLATE_PAGE_TOPIC,
  TRANSLATE_SHOW_ORIGINAL_TOPIC,
  TRANSLATE_STATE_TOPIC,
  type DisposableEngine,
} from './page-translate/translate-topics.js';

function fakeService(outcome: TranslateOutcome = 'started') {
  const calls: Array<[string, ...unknown[]]> = [];
  const service: TranslationService = {
    translate: (id, pair) => {
      calls.push(['translate', id, pair]);
      return outcome;
    },
    showOriginal: (id) => {
      calls.push(['showOriginal', id]);
    },
    navigated: (id) => {
      calls.push(['navigated', id]);
    },
    closed: (id) => {
      calls.push(['closed', id]);
    },
    state: () => null,
    idle: () => Promise.resolve(),
    dispose: () => {
      calls.push(['dispose']);
    },
  };
  return { service, calls };
}

function fakePorts() {
  const handlers = new Map<string, (msg: unknown) => void>();
  const published: Array<[string, unknown]> = [];
  return {
    handlers,
    published,
    ports: {
      subscribe: (topic: string, cb: (msg: unknown) => void) => {
        handlers.set(topic, cb);
      },
      unsubscribe: (topic: string) => {
        handlers.delete(topic);
      },
      publish: (topic: string, msg: unknown) => {
        published.push([topic, msg]);
      },
    },
    send(topic: string, msg: unknown) {
      const h = handlers.get(topic);
      assert.ok(h, `no handler for ${topic}`);
      h(msg);
    },
  };
}

const REQ = (signal = new AbortController().signal): EngineRequest => ({
  from: 'de',
  to: 'en',
  segments: ['Hallo'],
  isHTML: false,
  signal,
});

describe('translate topics', () => {
  it('translate:page reaches the service with the window and pair', () => {
    const { service, calls } = fakeService();
    const p = fakePorts();
    installTranslateTopics(service, p.ports);
    p.send(TRANSLATE_PAGE_TOPIC, { windowId: 7, from: 'de', to: 'en' });
    assert.deepStrictEqual(calls, [['translate', 7, { from: 'de', to: 'en' }]]);
    assert.deepStrictEqual(p.published, []);
  });

  it('accepts script subtags such as zh-Hans', () => {
    const { service, calls } = fakeService();
    const p = fakePorts();
    installTranslateTopics(service, p.ports);
    p.send(TRANSLATE_PAGE_TOPIC, { windowId: 3, from: 'zh-Hans', to: 'en' });
    assert.deepStrictEqual(calls, [['translate', 3, { from: 'zh-Hans', to: 'en' }]]);
  });

  it('ignores malformed requests', () => {
    const { service, calls } = fakeService();
    const p = fakePorts();
    installTranslateTopics(service, p.ports);
    for (const msg of [
      null,
      'de',
      {},
      { windowId: '7', from: 'de', to: 'en' },
      { windowId: 0, from: 'de', to: 'en' },
      { windowId: 1.5, from: 'de', to: 'en' },
      { windowId: 7, from: 'de' },
      { windowId: 7, from: 'de', to: 'en"; alert(1)' },
      { windowId: 7, from: 'en', to: 'en' },
    ]) {
      p.send(TRANSLATE_PAGE_TOPIC, msg);
    }
    p.send(TRANSLATE_SHOW_ORIGINAL_TOPIC, { windowId: -1 });
    p.send(TRANSLATE_SHOW_ORIGINAL_TOPIC, undefined);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(p.published, []);
  });

  it('answers a request for a window with no page with a no-page state', () => {
    const { service } = fakeService('no-page');
    const p = fakePorts();
    installTranslateTopics(service, p.ports);
    p.send(TRANSLATE_PAGE_TOPIC, { windowId: 9, from: 'es', to: 'en' });
    assert.deepStrictEqual(p.published, [
      [TRANSLATE_STATE_TOPIC, { windowId: 9, phase: 'idle', from: 'es', to: 'en', applied: 0, error: 'no-page' }],
    ]);
  });

  it('translate:show-original reaches the service', () => {
    const { service, calls } = fakeService();
    const p = fakePorts();
    installTranslateTopics(service, p.ports);
    p.send(TRANSLATE_SHOW_ORIGINAL_TOPIC, { windowId: 4 });
    assert.deepStrictEqual(calls, [['showOriginal', 4]]);
  });

  it('the returned function unsubscribes both topics', () => {
    const { service } = fakeService();
    const p = fakePorts();
    const off = installTranslateTopics(service, p.ports);
    assert.strictEqual(p.handlers.size, 2);
    off();
    assert.strictEqual(p.handlers.size, 0);
  });

  it('statePayload carries the window id and the public fields only', () => {
    const state = { ...INITIAL_SESSION_STATE, phase: 'translated' as const, run: 5, from: 'de', to: 'en', applied: 12 };
    assert.deepStrictEqual(statePayload(2, state), {
      windowId: 2,
      phase: 'translated',
      from: 'de',
      to: 'en',
      applied: 12,
      error: null,
    });
  });
});

describe('lazyEngine', () => {
  function countingBuild() {
    let builds = 0;
    let disposes = 0;
    const build = async (): Promise<DisposableEngine> => {
      builds++;
      return {
        translate: async (req) => req.segments.map((s) => s.toUpperCase()),
        dispose: () => {
          disposes++;
        },
      };
    };
    return { build, builds: () => builds, disposes: () => disposes };
  }

  it('builds nothing until the first request, then builds once', async () => {
    const b = countingBuild();
    const engine = lazyEngine(b.build);
    assert.strictEqual(b.builds(), 0);
    const [a, c] = await Promise.all([engine.translate(REQ()), engine.translate(REQ())]);
    assert.deepStrictEqual(a, ['HALLO']);
    assert.deepStrictEqual(c, ['HALLO']);
    await engine.translate(REQ());
    assert.strictEqual(b.builds(), 1);
  });

  it('dispose stops a built engine and fails later requests', async () => {
    const b = countingBuild();
    const engine = lazyEngine(b.build);
    await engine.translate(REQ());
    engine.dispose();
    await Promise.resolve();
    assert.strictEqual(b.disposes(), 1);
    await assert.rejects(engine.translate(REQ()), /disposed/);
    engine.dispose();
    await Promise.resolve();
    assert.strictEqual(b.disposes(), 1);
  });

  it('dispose before any request builds nothing', async () => {
    const b = countingBuild();
    const engine = lazyEngine(b.build);
    engine.dispose();
    await assert.rejects(engine.translate(REQ()), /disposed/);
    assert.strictEqual(b.builds(), 0);
  });

  it('dispose while the build is in flight stops the engine once built', async () => {
    const b = countingBuild();
    const engine = lazyEngine(b.build);
    const pending = engine.translate(REQ());
    engine.dispose();
    await assert.rejects(pending, /disposed/);
    assert.strictEqual(b.disposes(), 1);
  });

  it('a failed build is retried on the next request', async () => {
    let attempts = 0;
    const engine = lazyEngine(async () => {
      attempts++;
      if (attempts === 1) throw new Error('spawn failed');
      return { translate: async () => ['ok'], dispose: () => {} };
    });
    await assert.rejects(engine.translate(REQ()), /spawn failed/);
    assert.deepStrictEqual(await engine.translate(REQ()), ['ok']);
    assert.strictEqual(attempts, 2);
  });
});
