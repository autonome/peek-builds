/**
 * Unit tests for tile command registration plumbing.
 *
 * Phase E rewrote the dispatch machinery — per-command stubs are gone,
 * replaced by a single dispatch hook. These tests cover what survives:
 *
 *   1. `registerLazyTile` publishes `cmd:register-batch` so the cmd
 *      panel can list declared commands without loading the tile.
 *   2. Commands with params preserve their params metadata in the
 *      announcement.
 *   3. When `cmd:execute:{name}` fires for a lazy tile, the dispatch
 *      hook loads the tile and the message reaches its real handler.
 *   4. Window-action commands still appear in the announcement.
 *   5. Declared nouns are announced via `noun:register-batch`, and a
 *      `noun:<capability>:<name>` publish wakes the tile.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import {
  publish, subscribe, unsubscribe,
  __clearPrePublishHooksForTest,
} from './pubsub.js';
import {
  registerLazyTile,
  installLoadOnDispatchHook,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import type { TileManifest, TileCommand } from './tile-manifest.js';
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

function makeManifestWithCommands(id: string, commands: TileCommand[]): TileManifest {
  return {
    manifestVersion: 3,
    id,
    name: id,
    builtin: true,
    tiles: [
      { id: 'background', url: 'background.html', lazy: true },
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

  it('publishes cmd:register-batch announcing every manifest command', () => {
    const registered: unknown[] = [];
    subscribe('test-observer', 'cmd:register-batch', (msg: unknown) => {
      registered.push(msg);
    });

    const manifest = makeManifestWithCommands('cmd-test-1', [
      { name: 'foo', description: 'Foo command', action: { type: 'execute' } },
      { name: 'bar', description: 'Bar command', action: { type: 'execute' } },
    ]);

    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    // Phase E emits one batch per tile, not per command.
    assert.strictEqual(registered.length, 1, 'expected a single batch publish per tile');
    const batch = registered[0] as { commands: Array<{ name: string }> };
    const names = batch.commands.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['bar', 'foo']);

    unsubscribe('test-observer', 'cmd:register-batch');
  });

  it('preserves params metadata in cmd:register-batch', () => {
    const received: unknown[] = [];
    subscribe('test-observer-2', 'cmd:register-batch', (msg: unknown) => {
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
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    assert.strictEqual(received.length, 1);
    const batch = received[0] as { commands: Array<{ name: string; params?: unknown[] }> };
    assert.strictEqual(batch.commands[0].name, 'search');
    assert.ok(Array.isArray(batch.commands[0].params));
    assert.strictEqual((batch.commands[0].params as Array<{ name: string }>)[0].name, 'query');

    unsubscribe('test-observer-2', 'cmd:register-batch');
  });

  it('loads tile and delivers message when cmd:execute fires', async () => {
    const manifest = makeManifestWithCommands('cmd-test-4', [
      { name: 'doit', action: { type: 'execute' } },
    ]);
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    const realHandlerReceived: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://cmd-test-4/bg', 'cmd:execute:doit', (msg: unknown) => {
        realHandlerReceived.push(msg);
      });
      signalReady(launcherState, 'cmd-test-4', 'background');
    };

    publish('test-caller', 'cmd:execute:doit', { payload: 42 });

    // Dispatch hook is async — yield enough microtasks for load,
    // ready-signal, hook continuation, and delivery.
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should be launched once');
    assert.strictEqual(realHandlerReceived.length, 1, 'real handler should receive the deferred message');
    assert.deepStrictEqual(realHandlerReceived[0], { payload: 42 });

    unsubscribe('peek://cmd-test-4/bg', 'cmd:execute:doit');
  });

  it('window-action commands are announced in the batch and skip tile load on dispatch', async () => {
    const received: unknown[] = [];
    subscribe('test-observer-3', 'cmd:register-batch', (msg: unknown) => {
      received.push(msg);
    });

    const windowOpenReceived: unknown[] = [];
    subscribe('test-window-observer', 'window:reopen-request', (msg: unknown) => {
      windowOpenReceived.push(msg);
    });

    const manifest = makeManifestWithCommands('cmd-test-5', [
      {
        name: 'open-window',
        description: 'Open a window',
        action: { type: 'window', url: 'peek://cmd-test-5/home.html' },
      } as TileCommand,
    ]);
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    assert.strictEqual(received.length, 1);
    const batch = received[0] as { commands: Array<{ name: string; action?: { type: string } }> };
    assert.strictEqual(batch.commands[0].name, 'open-window');
    assert.strictEqual(batch.commands[0].action?.type, 'window');

    // Firing the command should publish window:reopen-request and NOT
    // load the tile (declarative window actions bypass tile boot).
    publish('test-caller', 'cmd:execute:open-window', {});
    for (let i = 0; i < 3; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 0, 'declarative window action must not load the tile');
    assert.strictEqual(windowOpenReceived.length, 1, 'window:reopen-request should be published');

    unsubscribe('test-observer-3', 'cmd:register-batch');
    unsubscribe('test-window-observer', 'window:reopen-request');
  });

  it('announces declared nouns via noun:register-batch without loading the tile', () => {
    const received: unknown[] = [];
    subscribe('test-noun-observer', 'noun:register-batch', (msg: unknown) => {
      received.push(msg);
    });

    const manifest: TileManifest = {
      ...makeManifestWithCommands('noun-test-1', []),
      nouns: [{ name: 'widgets', singular: 'widget', capabilities: ['query', 'create'], produces: 'application/json' }],
    };
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    assert.strictEqual(received.length, 1);
    const batch = received[0] as { nouns: Array<Record<string, unknown>> };
    assert.strictEqual(batch.nouns.length, 1);
    assert.strictEqual(batch.nouns[0].name, 'widgets');
    assert.strictEqual(batch.nouns[0].singular, 'widget');
    assert.strictEqual(batch.nouns[0].hasQuery, true);
    assert.strictEqual(batch.nouns[0].hasCreate, true);
    assert.strictEqual(batch.nouns[0].hasBrowse, false);
    assert.strictEqual(batch.nouns[0].hasOpen, false);
    assert.strictEqual(launcherState.launchCalls.length, 0);

    unsubscribe('test-noun-observer', 'noun:register-batch');
  });

  it('a declared noun capability topic wakes the tile and reaches its handler', async () => {
    const manifest: TileManifest = {
      ...makeManifestWithCommands('noun-test-2', []),
      nouns: [{ name: 'widgets', singular: 'widget', capabilities: ['create'] }],
    };
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    const realHandlerReceived: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://noun-test-2/bg', 'noun:create:widgets', (msg: unknown) => {
        realHandlerReceived.push(msg);
      });
      signalReady(launcherState, 'noun-test-2', 'background');
    };

    // A capability the noun does not declare does not wake the tile.
    publish('test-caller', 'noun:query:widgets', {});
    for (let i = 0; i < 3; i++) await flushMicrotasks();
    assert.strictEqual(launcherState.launchCalls.length, 0);

    publish('test-caller', 'noun:create:widgets', { search: 'blue' });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'tile should be launched once');
    assert.deepStrictEqual(realHandlerReceived, [{ search: 'blue' }]);

    unsubscribe('peek://noun-test-2/bg', 'noun:create:widgets');
  });
});
