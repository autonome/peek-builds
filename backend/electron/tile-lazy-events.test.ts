/**
 * Unit tests for tile-lazy dispatch-hook behavior ("lazyEvents").
 *
 * Phase E replaced the per-topic stub subscriber pattern with a single
 * pre-publish hook on the pubsub bus. These tests verify the
 * behaviors that matter end-to-end: tile launches on first matching
 * topic, messages reach the real handler, subsequent events don't
 * re-launch, concurrent publishes during load are handled cleanly.
 */

import { describe, it, beforeEach, before } from 'node:test';
import * as assert from 'node:assert';

import {
  publish, subscribe, unsubscribe,
  __clearPrePublishHooksForTest,
} from './pubsub.js';
import {
  registerLazyTile,
  isLazyTileRegistered,
  installLoadOnDispatchHook,
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

describe('tile-lazy load-on-dispatch (lazyEvents)', () => {
  let launcherState: FakeLauncherState;

  beforeEach(() => {
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
    installLoadOnDispatchHook();
    launcherState = {
      launchCalls: [],
      loaded: new Set(),
      ready: new Set(),
      readyCallbacks: new Map(),
    };
    __setTileLazyLauncherForTest(makeFakeLauncher(launcherState));
  });

  it('registers lazy tile', () => {
    const manifest = makeManifest('test-tile-1', ['test1:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');
    assert.ok(isLazyTileRegistered('test-tile-1'));
  });

  it('loads tile when a declared lazyEvent topic is published', async () => {
    const manifest = makeManifest('test-tile-2', ['test2:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // On launch, simulate the tile registering its real handler and signaling ready.
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-2/bg', 'test2:open', () => {
        /* real handler */
      });
      signalReady(launcherState, 'test-tile-2', 'background');
    };

    publish('peek://test-publisher', 'test2:open', { id: 'abc' });

    // The dispatch hook defers delivery until load+ready. Yield enough
    // microtasks for: launch → microtask that sets loaded + onLaunch →
    // waitForTileReady resolution → hook continuation → deliver.
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should have been launched');
    assert.strictEqual(launcherState.launchCalls[0].manifest.id, 'test-tile-2');

    unsubscribe('peek://test-tile-2/bg', 'test2:open');
  });

  it('the real handler receives the deferred message after load', async () => {
    const manifest = makeManifest('test-tile-3', ['test3:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    const received: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-3/bg', 'test3:open', (msg) => {
        received.push(msg);
      });
      signalReady(launcherState, 'test-tile-3', 'background');
    };

    const payload = { itemId: 'note-42', cursor: { line: 3, col: 5 } };
    publish('peek://test-publisher', 'test3:open', payload);
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(received.length, 1, 'real handler should receive the deferred message');
    assert.deepStrictEqual(received[0], payload);

    unsubscribe('peek://test-tile-3/bg', 'test3:open');
  });

  it('subsequent events after load do not re-launch the tile', async () => {
    const manifest = makeManifest('test-tile-4', ['test4:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    const received: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-4/bg', 'test4:open', (msg) => {
        received.push(msg);
      });
      signalReady(launcherState, 'test-tile-4', 'background');
    };

    publish('peek://pub', 'test4:open', { n: 1 });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1);
    assert.strictEqual(received.length, 1);

    // Second publish — tile already loaded + ready; hook sees that and
    // continues synchronously. No second launch.
    publish('peek://pub', 'test4:open', { n: 2 });
    for (let i = 0; i < 5; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should not be relaunched');
    assert.strictEqual(received.length, 2);
    assert.deepStrictEqual(received[1], { n: 2 });

    unsubscribe('peek://test-tile-4/bg', 'test4:open');
  });

  it('multiple lazyEvents on one tile share a single launch', async () => {
    const manifest = makeManifest('test-tile-5', ['test5:open', 'test5:add']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    const received: Array<{ topic: string; msg: unknown }> = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-5/bg', 'test5:open', (msg) => {
        received.push({ topic: 'test5:open', msg });
      });
      subscribe('peek://test-tile-5/bg', 'test5:add', (msg) => {
        received.push({ topic: 'test5:add', msg });
      });
      signalReady(launcherState, 'test-tile-5', 'background');
    };

    // First topic triggers load.
    publish('peek://pub', 'test5:open', { kind: 'open' });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].topic, 'test5:open');

    // Second topic: tile is already loaded, goes straight to real handler.
    publish('peek://pub', 'test5:add', { kind: 'add' });
    for (let i = 0; i < 5; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should not be relaunched');
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[1].topic, 'test5:add');

    unsubscribe('peek://test-tile-5/bg', 'test5:open');
    unsubscribe('peek://test-tile-5/bg', 'test5:add');
  });

  it('concurrent fires during load: one launch, every message is delivered', async () => {
    const manifest = makeManifest('test-tile-6', ['test6:open']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // Defer ready so we can fire multiple publishes while still loading.
    let readyTrigger: (() => void) | null = null;
    const received: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://test-tile-6/bg', 'test6:open', (msg) => {
        received.push(msg);
      });
      readyTrigger = () => signalReady(launcherState, 'test-tile-6', 'background');
    };

    publish('peek://pub', 'test6:open', { n: 1 });
    await flushMicrotasks();
    publish('peek://pub', 'test6:open', { n: 2 });
    await flushMicrotasks();
    publish('peek://pub', 'test6:open', { n: 3 });
    await flushMicrotasks();

    // All three hooks are awaiting waitForTileReady; none resolved yet.
    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should launch exactly once');

    // Resolve readiness — the three deferred publishes all fan out.
    readyTrigger!();
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    const payloads = received.map(r => (r as { n: number }).n).sort();
    assert.deepStrictEqual(payloads, [1, 2, 3],
      `expected all three deferred publishes to reach the real handler, got ${JSON.stringify(payloads)}`);

    unsubscribe('peek://test-tile-6/bg', 'test6:open');
  });

  it('topic not declared anywhere bypasses the hook entirely', async () => {
    // Register a tile with a specific lazyEvent topic — an unrelated
    // publish must not go through the dispatch hook (no launch, no defer).
    const manifest = makeManifest('test-tile-7', ['test7:only-this-topic']);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    const received: unknown[] = [];
    subscribe('peek://unrelated', 'unrelated:topic', (msg) => {
      received.push(msg);
    });

    publish('peek://pub', 'unrelated:topic', { x: 1 });
    // No awaits needed — unmatched topics deliver synchronously.
    // But give the loop a tick just to be safe for any microtask work.
    await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 0, 'unrelated publish should not trigger a launch');
    assert.strictEqual(received.length, 1);

    unsubscribe('peek://unrelated', 'unrelated:topic');
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
