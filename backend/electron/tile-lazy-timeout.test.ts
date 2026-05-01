/**
 * Unit tests for tile-lazy load-on-dispatch failure UX (Phase 7).
 *
 * Exercises the two user-visible failure paths when a lazy tile can't
 * accept a dispatched command:
 *   1. Load timeout — waitForTileReady never resolves; the 10s timer
 *      fires; a `notification:show` publish surfaces the failure and
 *      the caller's result topic is published with `{error}` so the
 *      cmd panel proxy promise settles immediately.
 *   2. Crashed during load — `tile:state-changed` fires a
 *      `loading → crashed` transition while a dispatch is still in
 *      flight; pending dispatches reject immediately (no 10s wait).
 *
 * See docs/pubsub-state-machine.md §Load-on-dispatch — timeout UX.
 */

import { describe, it, beforeEach, before, after } from 'node:test';
import * as assert from 'node:assert';

import {
  publish, subscribe, unsubscribe,
  getSystemAddress,
  __clearPrePublishHooksForTest,
} from './pubsub.js';
import {
  registerLazyTile,
  installLoadOnDispatchHook,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import type { TileManifest } from './tile-manifest.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

// ─── Fake launcher that never reaches ready ──────────────────────────

interface FakeLauncherState {
  launchCalls: TileLaunchOptions[];
  loaded: Set<string>;
  /**
   * Unresolved ready promises — the whole point is that we never resolve
   * these so the load timeout fires. Each `waitForTileReady` call
   * returns a fresh pending promise.
   */
  pendingReady: Array<(value: void) => void>;
}

function makeFakeLauncher(state: FakeLauncherState) {
  return {
    launchTile: (options: TileLaunchOptions): TileLaunchResult | void => {
      state.launchCalls.push(options);
      const entryId = options.entryId || options.manifest.tiles[0]?.id || 'background';
      queueMicrotask(() => {
        state.loaded.add(`${options.manifest.id}:${entryId}`);
      });
    },
    waitForTileReady: (_tileId: string, _entryId: string): Promise<void> => {
      // Return a promise that intentionally never resolves. The timeout
      // inside tile-lazy's `loadLazyTile` is responsible for racing this.
      return new Promise<void>((resolve) => {
        state.pendingReady.push(resolve);
      });
    },
    isTileLoaded: (tileId: string, entryId: string): boolean => {
      return state.loaded.has(`${tileId}:${entryId}`);
    },
  };
}

// ─── Manifest fixture ─────────────────────────────────────────────────

function makeCommandManifest(id: string, cmdName: string): TileManifest {
  return {
    manifestVersion: 3,
    id,
    name: id,
    builtin: true,
    tiles: [
      {
        id: 'background',
        url: 'background.html',
        lazy: true,
      },
    ],
    commands: [
      {
        name: cmdName,
        description: `${cmdName} description`,
        action: { type: 'execute' },
      },
    ],
    capabilities: {
      pubsub: { scopes: ['self', 'global'] },
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('tile-lazy load-on-dispatch timeout UX (Phase 7)', () => {
  let launcherState: FakeLauncherState;
  // Collected notification:show publishes.
  const notifications: Array<{
    type?: string;
    title?: string;
    body?: string;
    context?: { tileId?: string; cmdName?: string; reason?: string };
  }> = [];
  const notifySource = 'peek://tile-lazy-timeout-test/notify-observer';

  before(() => {
    subscribe(notifySource, 'notification:show', (msg: unknown) => {
      notifications.push(msg as typeof notifications[number]);
    });
  });

  after(() => {
    unsubscribe(notifySource, 'notification:show');
  });

  beforeEach(() => {
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
    installLoadOnDispatchHook();
    launcherState = {
      launchCalls: [],
      loaded: new Set(),
      pendingReady: [],
    };
    __setTileLazyLauncherForTest(makeFakeLauncher(launcherState));
    notifications.length = 0;
  });

  it('publishes a structured notification and resolves the resultTopic with error on load timeout', async () => {
    const manifest = makeCommandManifest('tile-timeout-1', 'slow-cmd');
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    // Collect whatever comes back on the resultTopic so we can assert
    // the proxy's promise settles (rather than hanging 30s).
    const resultTopic = 'cmd:execute:slow-cmd:result:unit-test-1';
    let resultPayload: unknown = null;
    subscribe('peek://test-dispatcher/result', resultTopic, (msg) => {
      resultPayload = msg;
    });

    // Use node:test's mock timers so we can jump past LAZY_LOAD_TIMEOUT_MS
    // (10000ms) without waiting 10 real seconds.
    const { mock } = await import('node:test');
    mock.timers.enable({ apis: ['setTimeout'] });

    try {
      publish('peek://test-dispatcher', 'cmd:execute:slow-cmd', {
        expectResult: true,
        resultTopic,
      });

      // Let the hook register the pending dispatch and kick off the
      // (pending, never-resolving) launch.
      for (let i = 0; i < 5; i++) await flushMicrotasks();
      assert.strictEqual(launcherState.launchCalls.length, 1,
        'tile should have been launched');

      // Fire the load timer. reportDispatchFailure runs in the same tick,
      // so both the notification and the resultTopic publish happen
      // synchronously before the timeout handler's reject propagates.
      mock.timers.tick(11000);
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    } finally {
      mock.timers.reset();
    }

    // Notification assertions — structured error shape the plan spec'd.
    assert.strictEqual(notifications.length, 1,
      `expected exactly one notification:show publish, got ${notifications.length}`);
    const n = notifications[0];
    assert.strictEqual(n.type, 'error');
    assert.ok(n.title && n.title.toLowerCase().includes("didn't load"),
      `notification title should signal load failure, got: ${n.title}`);
    assert.ok(n.body && n.body.includes('slow-cmd'),
      `notification body should name the command, got: ${n.body}`);
    assert.ok(n.body && /10000|10 second/.test(n.body),
      `notification body should mention the timeout duration, got: ${n.body}`);
    assert.strictEqual(n.context?.tileId, 'tile-timeout-1');
    assert.strictEqual(n.context?.cmdName, 'slow-cmd');
    assert.strictEqual(n.context?.reason, 'timeout');

    // Proxy promise settlement — resultTopic must have been published
    // with a structured error payload, so the cmd panel's subscribe
    // resolves immediately instead of hanging on its 30s fallback timer.
    assert.ok(resultPayload,
      'resultTopic should have been published (dispatcher promise hung otherwise)');
    const rp = resultPayload as { error?: string };
    assert.ok(typeof rp.error === 'string' && rp.error.length > 0,
      `resultTopic payload should carry an error message, got: ${JSON.stringify(rp)}`);

    unsubscribe('peek://test-dispatcher/result', resultTopic);
  });

  it('rejects pending dispatches immediately when the tile transitions loading → crashed', async () => {
    const manifest = makeCommandManifest('tile-crash-2', 'crashy-cmd');
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');

    const resultTopic = 'cmd:execute:crashy-cmd:result:unit-test-2';
    let resultPayload: unknown = null;
    subscribe('peek://test-dispatcher/result', resultTopic, (msg) => {
      resultPayload = msg;
    });

    // Kick off the dispatch — the hook will register a pending entry
    // against `tile-crash-2` and begin awaiting waitForTileReady (which
    // never resolves in this fixture).
    publish('peek://test-dispatcher', 'cmd:execute:crashy-cmd', {
      expectResult: true,
      resultTopic,
    });
    for (let i = 0; i < 5; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1);

    // Simulate the `loading → crashed` transition. The tile-lifecycle
    // engine publishes `tile:state-changed` as System when a render
    // process crashes during load; the crash observer in tile-lazy
    // subscribes to that topic and drains pending dispatches. Publish
    // directly here so we don't depend on wiring a real BrowserWindow.
    publish(getSystemAddress(), 'tile:state-changed', {
      tileId: 'tile-crash-2',
      entryId: 'background',
      from: 'loading',
      to: 'crashed',
      trigger: 'RENDER_GONE',
      ts: Date.now(),
    });

    // Observer runs synchronously under the publish; a microtask flush
    // covers any async subscribe handlers elsewhere.
    for (let i = 0; i < 3; i++) await flushMicrotasks();

    assert.strictEqual(notifications.length, 1,
      `expected one notification, got ${notifications.length}`);
    const n = notifications[0];
    assert.strictEqual(n.type, 'error');
    assert.ok(n.body && n.body.toLowerCase().includes('crashed'),
      `crashed-path body should mention 'crashed', got: ${n.body}`);
    assert.strictEqual(n.context?.reason, 'crashed');
    assert.strictEqual(n.context?.tileId, 'tile-crash-2');
    assert.strictEqual(n.context?.cmdName, 'crashy-cmd');

    assert.ok(resultPayload,
      'resultTopic should have been published on crash (pending dispatch otherwise still hung)');
    const rp = resultPayload as { error?: string };
    assert.ok(typeof rp.error === 'string' && rp.error.length > 0,
      `crashed-path resultTopic payload should carry an error, got: ${JSON.stringify(rp)}`);

    unsubscribe('peek://test-dispatcher/result', resultTopic);
  });
});
