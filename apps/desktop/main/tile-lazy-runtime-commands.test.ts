/**
 * A command a lazy tile registered at run time (not in its manifest) stays in the palette while the
 * tile is suspended, so running it must wake the tile. A failing launcher makes the wake attempt
 * observable: a wake that was tried records a load error for the tile.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import { publish, __clearPrePublishHooksForTest } from './pubsub.js';
import {
  registerLazyTile,
  unregisterLazyTile,
  installLoadOnDispatchHook,
  noteRuntimeCommand,
  forgetRuntimeCommand,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import { getFeatureLoadErrors } from './feature-load-errors.js';
import type { TileManifest } from './tile-manifest.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

const failingLauncher = {
  launchTile: (_options: TileLaunchOptions): TileLaunchResult | void => {},
  waitForTileReady: (): Promise<void> => Promise.reject(new Error('boom')),
  isTileLoaded: (): boolean => false,
};

function manifest(id: string): TileManifest {
  return {
    manifestVersion: 3,
    id,
    name: id,
    builtin: true,
    tiles: [{ id: 'background', url: 'background.html', lazy: true }],
    commands: [{ name: `${id}-declared`, description: 'declared', action: { type: 'execute' } }],
    capabilities: { pubsub: { scopes: ['self', 'global'] } },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

async function run(name: string): Promise<void> {
  publish('peek://test-dispatcher', `cmd:execute:${name}`, {});
  await settle();
}

describe('tile-lazy run-time commands wake a suspended tile', () => {
  beforeEach(() => {
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
    installLoadOnDispatchHook();
    __setTileLazyLauncherForTest(failingLauncher);
  });

  it('a command the tile registered at run time wakes it', async () => {
    registerLazyTile(manifest('rt-wake'), '/fake/path', '/fake/preload.cjs');
    noteRuntimeCommand('rt-wake', 'rt-wake-dynamic');
    await run('rt-wake-dynamic');
    assert.strictEqual(getFeatureLoadErrors().get('rt-wake'), 'boom');
  });

  it('a command nobody registered does not wake any tile', async () => {
    registerLazyTile(manifest('rt-none'), '/fake/path', '/fake/preload.cjs');
    await run('rt-none-unknown');
    assert.strictEqual(getFeatureLoadErrors().has('rt-none'), false);
  });

  it('a command the tile unregistered no longer wakes it', async () => {
    registerLazyTile(manifest('rt-forget'), '/fake/path', '/fake/preload.cjs');
    noteRuntimeCommand('rt-forget', 'rt-forget-dynamic');
    forgetRuntimeCommand('rt-forget', 'rt-forget-dynamic');
    await run('rt-forget-dynamic');
    assert.strictEqual(getFeatureLoadErrors().has('rt-forget'), false);
  });

  it('only the owner can forget a command', async () => {
    registerLazyTile(manifest('rt-owner'), '/fake/path', '/fake/preload.cjs');
    noteRuntimeCommand('rt-owner', 'rt-owner-dynamic');
    forgetRuntimeCommand('someone-else', 'rt-owner-dynamic');
    await run('rt-owner-dynamic');
    assert.strictEqual(getFeatureLoadErrors().get('rt-owner'), 'boom');
  });

  it('a command from a tile that is not lazy is not tracked', async () => {
    noteRuntimeCommand('rt-eager', 'rt-eager-dynamic');
    await run('rt-eager-dynamic');
    assert.strictEqual(getFeatureLoadErrors().has('rt-eager'), false);
  });

  it('disabling the tile forgets its run-time commands', async () => {
    registerLazyTile(manifest('rt-disable'), '/fake/path', '/fake/preload.cjs');
    noteRuntimeCommand('rt-disable', 'rt-disable-dynamic');
    unregisterLazyTile('rt-disable');
    await run('rt-disable-dynamic');
    assert.strictEqual(getFeatureLoadErrors().has('rt-disable'), false);
  });
});
