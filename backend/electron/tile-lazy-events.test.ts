/**
 * Unit tests for tile-lazy event interceptor ("lazyEvents") behavior.
 *
 * Validates that a lazy v2 tile declaring `lazyEvents` in its manifest
 * gets loaded when any of those pubsub topics are first published, and
 * the buffered message is replayed to the real handler afterward.
 */

import { describe, it, beforeEach, before } from 'node:test';
import * as assert from 'node:assert';

import { publish, subscribe, unsubscribe, scopes, hasSubscriber } from './pubsub.js';
import {
  registerLazyTile,
  isLazyTileRegistered,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import type { TileManifestV2 } from './tile-manifest.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

// ─── Test Launcher ────────────────────────────────────────────────────

interface FakeLauncherState {
  launchCalls: TileLaunchOptions[];
  loaded: Set<string>; // `${tileId}:${entryId}`
  ready: Set<string>;
  readyCallbacks: Map<string, Array<() => void>>;
  /** Called after launchTile() to simulate tile registering its real handler */
  onLaunch?: (options: TileLaunchOptions) => void;
}

function makeFakeLauncher(state: FakeLauncherState) {
  return {
    launchTile: (options: TileLaunchOptions): TileLaunchResult | void => {
      state.launchCalls.push(options);
      const entryId = options.entryId || options.manifest.tiles[0]?.id || 'background';
      // Defer loaded+onLaunch to a microtask so it mimics real async tile boot:
      // the real tile's subscribers register AFTER the current publish loop
      // finishes iterating. Doing it synchronously would cause Map iteration
      // in pubsub to visit the newly-added subscriber within the same publish.
      queueMicrotask(() => {
        state.loaded.add(`${options.manifest.id}:${entryId}`);
        if (state.onLaunch) state.onLaunch(options);
      });
    },
    waitForTileReady: (tileId: string, entryId: string): Promise<void> => {
      const key = `${tileId}:${entryId}`;
      if (state.ready.has(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        if (!state.readyCallbacks.has(key)) {
          state.readyCallbacks.set(key, []);
        }
        state.readyCallbacks.get(key)!.push(resolve);
      });
    },
    isTileLoaded: (tileId: string, entryId: string): boolean => {
      return state.loaded.has(`${tileId}:${entryId}`);
    },
  };
}

function signalReady(state: FakeLauncherState, tileId: string, entryId: string): void {
  const key = `${tileId}:${entryId}`;
  state.ready.add(key);
  const cbs = state.readyCallbacks.get(key) || [];
  state.readyCallbacks.delete(key);
  for (const cb of cbs) cb();
}

// ─── Manifest Fixtures ────────────────────────────────────────────────

function makeManifest(id: string, lazyEvents: string[]): TileManifestV2 {
  return {
    manifestVersion: 2,
    id,
    name: id,
    builtin: true,
    tiles: [
      {
        id: 'background',
        type: 'background',
        url: 'background.html',
        lazy: true,
        lazyEvents,
      },
    ],
    capabilities: {
      pubsub: { scopes: ['self', 'global'] },
    },
  };
}

/** Wait one microtask so async subscriber callbacks run */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('tile-lazy event interceptors', () => {
  let launcherState: FakeLauncherState;

  beforeEach(() => {
    __resetTileLazyStateForTest();
    launcherState = {
      launchCalls: [],
      loaded: new Set(),
      ready: new Set(),
      readyCallbacks: new Map(),
    };
    __setTileLazyLauncherForTest(makeFakeLauncher(launcherState));
  });

  it('registers lazy tile with lazyEvents', () => {
    const manifest = makeManifest('test-tile-1', ['test1:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    assert.ok(isLazyTileRegistered('test-tile-1'));
    // Interceptor stub subscribed to the topic
    assert.ok(hasSubscriber('test1:open', 'lazy-interceptor/test-tile-1/test1:open'));
  });

  it('loads tile when a lazyEvents topic is published', async () => {
    const manifest = makeManifest('test-tile-2', ['test2:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // On launch, simulate the tile registering its real handler and signal ready.
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-2/bg', scopes.GLOBAL, 'test2:open', () => {
        /* real handler */
      });
      signalReady(launcherState, 'test-tile-2', 'background');
    };

    publish('peek://test-publisher', scopes.GLOBAL, 'test2:open', { id: 'abc' });
    // Yield for async subscriber
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should have been launched');
    assert.strictEqual(launcherState.launchCalls[0].manifest.id, 'test-tile-2');

    // Clean up
    unsubscribe('peek://test-tile-2/bg', 'test2:open');
  });

  it('replays the buffered event to the real handler after load', async () => {
    const manifest = makeManifest('test-tile-3', ['test3:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    const received: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-3/bg', scopes.GLOBAL, 'test3:open', (msg) => {
        received.push(msg);
      });
      signalReady(launcherState, 'test-tile-3', 'background');
    };

    const payload = { itemId: 'note-42', cursor: { line: 3, col: 5 } };
    publish('peek://test-publisher', scopes.GLOBAL, 'test3:open', payload);

    // Allow async load + replay
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(received.length, 1, 'real handler should receive replayed message');
    assert.deepStrictEqual(received[0], payload);

    unsubscribe('peek://test-tile-3/bg', 'test3:open');
  });

  it('subsequent events after load do not re-launch the tile', async () => {
    const manifest = makeManifest('test-tile-4', ['test4:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    const received: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-4/bg', scopes.GLOBAL, 'test4:open', (msg) => {
        received.push(msg);
      });
      signalReady(launcherState, 'test-tile-4', 'background');
    };

    publish('peek://pub', scopes.GLOBAL, 'test4:open', { n: 1 });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1);
    assert.strictEqual(received.length, 1);

    // Second publish — real handler already in place, interceptor stub unsubscribed
    publish('peek://pub', scopes.GLOBAL, 'test4:open', { n: 2 });
    for (let i = 0; i < 5; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should not be relaunched');
    assert.strictEqual(received.length, 2);
    assert.deepStrictEqual(received[1], { n: 2 });

    // Interceptor should have unsubscribed itself
    assert.strictEqual(
      hasSubscriber('test4:open', 'lazy-interceptor/test-tile-4/test4:open'),
      false
    );

    unsubscribe('peek://test-tile-4/bg', 'test4:open');
  });

  it('multiple lazyEvents topics load tile independently (first wins)', async () => {
    const manifest = makeManifest('test-tile-5', ['test5:open', 'test5:add']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // Both stubs registered
    assert.ok(hasSubscriber('test5:open', 'lazy-interceptor/test-tile-5/test5:open'));
    assert.ok(hasSubscriber('test5:add', 'lazy-interceptor/test-tile-5/test5:add'));

    const received: Array<{ topic: string; msg: unknown }> = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-5/bg', scopes.GLOBAL, 'test5:open', (msg) => {
        received.push({ topic: 'test5:open', msg });
      });
      subscribe('peek://test-tile-5/bg', scopes.GLOBAL, 'test5:add', (msg) => {
        received.push({ topic: 'test5:add', msg });
      });
      signalReady(launcherState, 'test-tile-5', 'background');
    };

    // Publish one topic — should trigger load
    publish('peek://pub', scopes.GLOBAL, 'test5:open', { kind: 'open' });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].topic, 'test5:open');

    // Now publish the other topic — tile already loaded, should go straight to real handler
    publish('peek://pub', scopes.GLOBAL, 'test5:add', { kind: 'add' });
    for (let i = 0; i < 5; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should not be relaunched');
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[1].topic, 'test5:add');

    unsubscribe('peek://test-tile-5/bg', 'test5:open');
    unsubscribe('peek://test-tile-5/bg', 'test5:add');
  });

  it('only launches once even when topic fires multiple times before ready', async () => {
    const manifest = makeManifest('test-tile-6', ['test6:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // Defer ready signal so the first event is still "loading" when #2/#3 fire.
    // Note: the fake launchTile synchronously adds to `loaded` and calls onLaunch,
    // so subsequent events see tile-loaded + real-handler-present and deliver directly.
    // We only assert that: (a) tile is launched exactly once, (b) the real handler
    // eventually sees the replayed buffered message.
    let readyTrigger: (() => void) | null = null;
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-6/bg', scopes.GLOBAL, 'test6:open', (msg) => {
        received.push(msg);
      });
      readyTrigger = () => signalReady(launcherState, 'test-tile-6', 'background');
    };

    const received: unknown[] = [];

    publish('peek://pub', scopes.GLOBAL, 'test6:open', { n: 1 });
    await flushMicrotasks();
    publish('peek://pub', scopes.GLOBAL, 'test6:open', { n: 2 });
    await flushMicrotasks();
    publish('peek://pub', scopes.GLOBAL, 'test6:open', { n: 3 });
    await flushMicrotasks();

    // First event launched the tile; subsequent events short-circuit (stub unsubscribes).
    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should launch exactly once');

    // Finish the load so the buffered replay fires.
    const trigger = readyTrigger as (() => void) | null;
    assert.ok(trigger, 'onLaunch should have captured a ready trigger');
    trigger();
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    // Real handler must have received at least the replayed n:1 (first event, buffered)
    // plus any subsequent directly-delivered events (n:2, n:3 hit the real handler
    // after the stub unsubscribed itself).
    const payloads = received.map(r => (r as { n: number }).n);
    assert.ok(payloads.includes(1), `expected n:1 in delivered payloads, got ${JSON.stringify(payloads)}`);

    unsubscribe('peek://test-tile-6/bg', 'test6:open');
  });

  it('does not register event interceptor when manifest has no lazyEvents', () => {
    const manifest: TileManifestV2 = {
      manifestVersion: 2,
      id: 'test-tile-7',
      name: 'test-tile-7',
      builtin: true,
      tiles: [
        {
          id: 'background',
          type: 'background',
          url: 'background.html',
          lazy: true,
          // no lazyEvents
        },
      ],
      capabilities: { pubsub: { scopes: ['self', 'global'] } },
    };
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // No interceptor subscribed for any arbitrary topic
    assert.strictEqual(
      hasSubscriber('editor:open', 'lazy-interceptor/test-tile-7/editor:open'),
      false
    );
  });
});

// ─── Manifest schema tests for lazyEvents ─────────────────────────────

describe('tile manifest lazyEvents validation', () => {
  let validateTileManifest: typeof import('./tile-manifest.js').validateTileManifest;

  before(async () => {
    const m = await import('./tile-manifest.js');
    validateTileManifest = m.validateTileManifest;
  });

  const base = {
    manifestVersion: 2,
    id: 't',
    name: 'T',
    capabilities: {},
  };

  it('accepts lazyEvents as an array of strings', () => {
    const errors = validateTileManifest({
      ...base,
      tiles: [
        {
          id: 'background',
          type: 'background',
          url: 'bg.html',
          lazy: true,
          lazyEvents: ['editor:open', 'editor:add'],
        },
      ],
    } as Record<string, unknown>);
    assert.strictEqual(errors.length, 0);
  });

  it('accepts omitted lazyEvents', () => {
    const errors = validateTileManifest({
      ...base,
      tiles: [{ id: 'background', type: 'background', url: 'bg.html', lazy: true }],
    } as Record<string, unknown>);
    assert.strictEqual(errors.length, 0);
  });

  it('rejects non-array lazyEvents', () => {
    const errors = validateTileManifest({
      ...base,
      tiles: [
        {
          id: 'background',
          type: 'background',
          url: 'bg.html',
          lazyEvents: 'editor:open',
        },
      ],
    } as Record<string, unknown>);
    assert.ok(errors.some(e => e.path.endsWith('.lazyEvents')));
  });

  it('rejects lazyEvents entries that are not strings', () => {
    const errors = validateTileManifest({
      ...base,
      tiles: [
        {
          id: 'background',
          type: 'background',
          url: 'bg.html',
          lazyEvents: ['editor:open', 42, ''],
        },
      ],
    } as Record<string, unknown>);
    assert.ok(errors.some(e => e.path.includes('lazyEvents[1]')));
    assert.ok(errors.some(e => e.path.includes('lazyEvents[2]')));
  });
});
