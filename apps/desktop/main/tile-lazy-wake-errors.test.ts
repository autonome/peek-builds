/**
 * Unit tests for wake-failure surfacing on the feature-manager card.
 *
 * `ensureTileLoaded` (called from the command-dispatch hook, the
 * lazyEvent-dispatch hook, and the wake-declaration backfill) records a
 * failed wake into `feature-load-errors.ts`'s map instead of letting the
 * failure only be logged. The entry is sticky until a later successful
 * wake for the same tile clears it, or the tile is unregistered.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import {
  publish,
  __clearPrePublishHooksForTest,
} from './pubsub.js';
import {
  registerLazyTile,
  unregisterLazyTile,
  installLoadOnDispatchHook,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import { getFeatureLoadErrors } from './feature-load-errors.js';
import type { TileManifest } from './tile-manifest.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

// ─── Fake launchers ───────────────────────────────────────────────────

/**
 * Launcher whose `waitForTileReady` rejects immediately. No mock timers
 * needed — a rejected `waitForTileReady` makes `loadLazyTile`'s
 * `Promise.race` (and therefore `ensureTileLoaded`) reject right away,
 * well before the 10s load timeout would fire.
 */
function makeFailingLauncher() {
  return {
    launchTile: (_options: TileLaunchOptions): TileLaunchResult | void => {},
    waitForTileReady: (_tileId: string, _entryId: string): Promise<void> => {
      return Promise.reject(new Error('boom'));
    },
    isTileLoaded: (_tileId: string, _entryId: string): boolean => false,
  };
}

// ─── Manifest fixtures ─────────────────────────────────────────────────

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

function makeLazyEventManifest(id: string, topic: string): TileManifest {
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
        lazyEvents: [topic],
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

describe('tile-lazy wake-failure surfacing', () => {
  beforeEach(() => {
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
    installLoadOnDispatchHook();
  });

  it('records a load error when a command wake fails, cleared by a later successful wake', async () => {
    const tileId = 'tile-wake-cmd-1';
    const manifest = makeCommandManifest(tileId, 'wake-cmd');
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');
    __setTileLazyLauncherForTest(makeFailingLauncher());

    publish('peek://test-dispatcher', 'cmd:execute:wake-cmd', {});
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(getFeatureLoadErrors().get(tileId), 'boom');

    __setTileLazyLauncherForTest({
      isTileLoaded: () => true,
      waitForTileReady: () => Promise.resolve(),
    });

    publish('peek://test-dispatcher', 'cmd:execute:wake-cmd', {});
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(getFeatureLoadErrors().has(tileId), false);
  });

  it('records a load error when a lazyEvent wake fails', async () => {
    const tileId = 'tile-wake-event-1';
    const manifest = makeLazyEventManifest(tileId, 'wake:topic');
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');
    __setTileLazyLauncherForTest(makeFailingLauncher());

    publish('peek://test-publisher', 'wake:topic', {});
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(getFeatureLoadErrors().get(tileId), 'boom');
  });

  it('unregisterLazyTile clears a load error left by a failed wake', async () => {
    const tileId = 'tile-wake-cmd-2';
    const manifest = makeCommandManifest(tileId, 'wake-cmd-2');
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');
    __setTileLazyLauncherForTest(makeFailingLauncher());

    publish('peek://test-dispatcher', 'cmd:execute:wake-cmd-2', {});
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(getFeatureLoadErrors().get(tileId), 'boom');

    unregisterLazyTile(tileId);

    assert.strictEqual(getFeatureLoadErrors().has(tileId), false);
  });
});
