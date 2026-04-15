/**
 * Unit tests for v2 tile command registration end-to-end plumbing.
 *
 * Validates that:
 * 1. registerLazyTile() publishes cmd:register-batch for each command
 * 2. When cmd:execute:{name} fires, the stub loads the tile
 * 3. The buffered message is replayed to the real handler
 * 4. Commands with params are registered with their params metadata
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import { publish, subscribe, unsubscribe, scopes, hasSubscriber } from './pubsub.js';
import {
  registerLazyTile,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import type { TileManifestV2, TileCommand } from './tile-manifest.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

// ─── Test Launcher ────────────────────────────────────────────────────

interface FakeLauncherState {
  launchCalls: TileLaunchOptions[];
  loaded: Set<string>;
  ready: Set<string>;
  readyCallbacks: Map<string, Array<() => void>>;
  onLaunch?: (options: TileLaunchOptions) => void;
}

function makeFakeLauncher(state: FakeLauncherState) {
  return {
    launchTile: (options: TileLaunchOptions): TileLaunchResult | void => {
      state.launchCalls.push(options);
      const entryId = options.entryId || options.manifest.tiles[0]?.id || 'background';
      queueMicrotask(() => {
        state.loaded.add(`${options.manifest.id}:${entryId}`);
        if (state.onLaunch) state.onLaunch(options);
      });
    },
    waitForTileReady: (tileId: string, entryId: string): Promise<void> => {
      const key = `${tileId}:${entryId}`;
      if (state.ready.has(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        if (!state.readyCallbacks.has(key)) state.readyCallbacks.set(key, []);
        state.readyCallbacks.get(key)!.push(resolve);
      });
    },
    isTileLoaded: (tileId: string, entryId: string): boolean =>
      state.loaded.has(`${tileId}:${entryId}`),
  };
}

function signalReady(state: FakeLauncherState, tileId: string, entryId: string): void {
  const key = `${tileId}:${entryId}`;
  state.ready.add(key);
  const cbs = state.readyCallbacks.get(key) || [];
  state.readyCallbacks.delete(key);
  for (const cb of cbs) cb();
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function makeManifestWithCommands(id: string, commands: TileCommand[]): TileManifestV2 {
  return {
    manifestVersion: 2,
    id,
    name: id,
    builtin: true,
    tiles: [
      { id: 'background', type: 'background', url: 'background.html', lazy: true },
    ],
    capabilities: { pubsub: { scopes: ['self', 'global'] }, commands: true },
    commands,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('tile command registration', () => {
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

  it('publishes cmd:register-batch for each manifest command', () => {
    const registered: unknown[] = [];
    subscribe('test-observer', scopes.GLOBAL, 'cmd:register-batch', (msg: unknown) => {
      registered.push(msg);
    });

    const manifest = makeManifestWithCommands('cmd-test-1', [
      { name: 'foo', description: 'Foo command', action: { type: 'execute' } },
      { name: 'bar', description: 'Bar command', action: { type: 'execute' } },
    ]);

    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // Expect one batch per command (tile-lazy publishes per command)
    assert.strictEqual(registered.length, 2, 'expected one batch publish per command');

    const names = registered
      .flatMap((m: unknown) => (m as { commands: Array<{ name: string }> }).commands.map(c => c.name))
      .sort();
    assert.deepStrictEqual(names, ['bar', 'foo']);

    unsubscribe('test-observer', 'cmd:register-batch');
  });

  it('registers subscriber for cmd:execute:{name} for each command', () => {
    const manifest = makeManifestWithCommands('cmd-test-2', [
      { name: 'baz', action: { type: 'execute' } },
    ]);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // lazy-stub subscribes to cmd:execute:baz
    assert.ok(
      hasSubscriber('cmd:execute:baz', 'lazy-stub/baz'),
      'lazy-stub/baz should be subscribed to cmd:execute:baz'
    );
  });

  it('preserves params metadata in cmd:register-batch', () => {
    const received: unknown[] = [];
    subscribe('test-observer-2', scopes.GLOBAL, 'cmd:register-batch', (msg: unknown) => {
      received.push(msg);
    });

    const manifest = makeManifestWithCommands('cmd-test-3', [
      {
        name: 'search',
        description: 'Search something',
        action: { type: 'execute' },
        params: [{ name: 'query', required: true }],
      } as TileCommand,
    ]);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    assert.strictEqual(received.length, 1);
    const batch = received[0] as { commands: Array<{ name: string; params?: unknown[] }> };
    assert.strictEqual(batch.commands[0].name, 'search');
    assert.ok(Array.isArray(batch.commands[0].params));
    assert.strictEqual((batch.commands[0].params as Array<{ name: string }>)[0].name, 'query');

    unsubscribe('test-observer-2', 'cmd:register-batch');
  });

  it('loads tile and replays message when command is invoked', async () => {
    const manifest = makeManifestWithCommands('cmd-test-4', [
      { name: 'doit', action: { type: 'execute' } },
    ]);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    // Simulate the tile registering its real handler on launch.
    const realHandlerReceived: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://cmd-test-4/bg', scopes.GLOBAL, 'cmd:execute:doit', (msg: unknown) => {
        realHandlerReceived.push(msg);
      });
      signalReady(launcherState, 'cmd-test-4', 'background');
    };

    // Invoke the command — lazy stub intercepts, loads, replays
    publish('test-caller', scopes.GLOBAL, 'cmd:execute:doit', { payload: 42 });

    // Wait for microtasks and the async replay
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should be launched once');
    assert.strictEqual(realHandlerReceived.length, 1, 'real handler should receive the replay');
    assert.deepStrictEqual(realHandlerReceived[0], { payload: 42 });

    unsubscribe('peek://cmd-test-4/bg', 'cmd:execute:doit');
  });

  it('window-action commands still get registered in cmd batch', () => {
    const received: unknown[] = [];
    subscribe('test-observer-3', scopes.GLOBAL, 'cmd:register-batch', (msg: unknown) => {
      received.push(msg);
    });

    const manifest = makeManifestWithCommands('cmd-test-5', [
      {
        name: 'open window',
        description: 'Open a window',
        action: { type: 'window', url: 'peek://cmd-test-5/home.html' },
      } as TileCommand,
    ]);
    registerLazyTile(manifest, '/fake/path', '/fake/preload.js');

    assert.strictEqual(received.length, 1);
    const batch = received[0] as { commands: Array<{ name: string; action?: { type: string } }> };
    assert.strictEqual(batch.commands[0].name, 'open window');
    assert.strictEqual(batch.commands[0].action?.type, 'window');

    unsubscribe('test-observer-3', 'cmd:register-batch');
  });
});
