/**
 * Unit tests for LIVE arm/disarm of lazy features on enable/disable
 * (peek task d432d39a — "Re-enabling a lazy builtin mid-session should
 * arm wake hooks live (no restart)").
 *
 * Boot skips disabled features entirely, so a re-enabled lazy tile is NOT
 * in the lazy registry and has NO wake accelerators — just flipping the
 * registry `disabled` flag left its global hotkeys and command-palette
 * entries dead until the next app launch. `armLazyTile` (tile-compat) is the
 * single per-feature arming path now shared by BOTH boot (`loadTile`) and the
 * live re-enable (`tile:features:enable`); `disarmLazyTile` is its symmetric
 * teardown used by disable/remove. These tests exercise the REAL arm/disarm
 * product code via two injection seams:
 *
 *   - `__setFeatureShortcutRegistrarDepsForTest` — spies on the OS-global
 *     accelerator (un)registration + the persisted/declared/feature-settings
 *     queries, so we can assert wake shortcuts arm on enable and tear down on
 *     disable without Electron's globalShortcut.
 *   - `__setTileLazyLauncherForTest` — fakes the tile launcher so the
 *     load-on-dispatch route (and the settings-derived backfill wake) can be
 *     observed without creating real BrowserWindows.
 *
 * The load-on-dispatch hook itself is a single global pre-publish hook
 * installed once at boot and never torn down; what `armLazyTile`/`disarmLazyTile`
 * replay/retract is the PER-TILE registry entry (which commands/lazyEvents the
 * hook matches) plus the OS accelerators. These tests assert both halves.
 *
 * Runs as a main-process unit test (electron --test).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import {
  publish, subscribe, unsubscribe,
  __clearPrePublishHooksForTest,
} from './pubsub.js';
import {
  installLoadOnDispatchHook,
  isLazyTileRegistered,
  getLazyTileIds,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import {
  armLazyTile,
  disarmLazyTile,
  isLazyTileManifest,
  loadOrArmFeatureTile,
  type AnnotatedTile,
  type TileCompatConfig,
} from './tile-arm.js';
import {
  lazyShortcutSource,
  __setFeatureShortcutRegistrarDepsForTest,
} from './feature-shortcut-registrar.js';
import type { TileManifest } from './tile-manifest.js';
import type { WakeShortcut } from './datastore.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

// ─── Registrar spy harness (OS accelerators) ─────────────────────────

interface RegisterCall { keys: string; source: string; }
let registerCalls: RegisterCall[];
let unregisterCalls: string[];
let persistedFake: Map<string, WakeShortcut[]>;
let declaredFake: Set<string>;
let featureSettingsFake: Set<string>;

function installRegistrarSpies(): void {
  registerCalls = [];
  unregisterCalls = [];
  persistedFake = new Map();
  declaredFake = new Set();
  featureSettingsFake = new Set();
  __setFeatureShortcutRegistrarDepsForTest({
    registerGlobalShortcut: (keys: string, source: string) => {
      registerCalls.push({ keys, source });
      return undefined;
    },
    unregisterShortcutsForAddress: (address: string) => {
      unregisterCalls.push(address);
    },
    publish: () => { /* swallow the wake publish — not under test here */ },
    getSystemAddress: () => 'peek://system/stub',
    getWakeShortcuts: (id: string) => persistedFake.get(id) ?? [],
    hasDeclaredWakeShortcuts: (id: string) => declaredFake.has(id),
    hasFeatureSettings: (id: string) => featureSettingsFake.has(id),
  });
}

// ─── Launcher spy harness (tile windows / backfill wake) ─────────────

interface FakeLauncherState {
  launchCalls: TileLaunchOptions[];
  loaded: Set<string>;
  ready: Set<string>;
  readyCallbacks: Map<string, Array<() => void>>;
  onLaunch?: (options: TileLaunchOptions) => void;
}
let launcherState: FakeLauncherState;

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

// ─── Manifest fixtures ───────────────────────────────────────────────

/** windows-style: a fixed command shortcut, NO settings-derived flag. */
function makeWindowsManifest(): TileManifest {
  return {
    manifestVersion: 3,
    id: 'windows',
    name: 'windows',
    builtin: true,
    tiles: [{ id: 'background', url: 'background.html', lazy: true }],
    commands: [{ name: 'windows', description: 'Window switcher', action: { type: 'execute' } }],
    shortcuts: [{ keys: 'CommandOrControl+Shift+W', command: 'windows' }],
    capabilities: { pubsub: { scopes: ['self', 'global'] } },
  } as unknown as TileManifest;
}

/** slides-style: lazyEvent-driven + settings-derived wake hotkeys. */
function makeSlidesManifest(): TileManifest {
  return {
    manifestVersion: 3,
    id: 'slides',
    name: 'slides',
    builtin: true,
    wakeShortcutsFromSettings: true,
    tiles: [{ id: 'background', url: 'background.html', lazy: true, lazyEvents: ['cli:slide-open'] }],
    shortcuts: [{ keys: 'Option+Up', wakeTopic: 'cli:slide-open', wakeArgs: ['Up'] }],
    capabilities: { pubsub: { scopes: ['self', 'global'] } },
  } as unknown as TileManifest;
}

/** resident (eager) tile — launched, never lazy-armed. */
function makeResidentManifest(): TileManifest {
  return {
    manifestVersion: 3,
    id: 'resident-feat',
    name: 'resident-feat',
    builtin: true,
    tiles: [{ id: 'main', url: 'main.html', resident: true }],
    capabilities: { pubsub: { scopes: ['self', 'global'] } },
  } as unknown as TileManifest;
}

const COMPAT_CONFIG: TileCompatConfig = { tilePreloadPath: '/fake/tile-preload.cjs' };

function annotate(manifest: TileManifest): AnnotatedTile {
  return { id: manifest.id, path: `/fake/${manifest.id}`, manifest };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('lazy feature live arm/disarm (enable/disable, peek d432d39a)', () => {
  beforeEach(() => {
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
    installLoadOnDispatchHook();
    installRegistrarSpies();
    launcherState = { launchCalls: [], loaded: new Set(), ready: new Set(), readyCallbacks: new Map() };
    __setTileLazyLauncherForTest(makeFakeLauncher(launcherState));
  });

  afterEach(() => {
    __setFeatureShortcutRegistrarDepsForTest(null);
    __setTileLazyLauncherForTest(null);
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
  });

  it('isLazyTileManifest matches both the static-command and lazyEvent shapes', () => {
    assert.strictEqual(isLazyTileManifest(makeWindowsManifest()), true, 'windows: commands, no resident → lazy');
    assert.strictEqual(isLazyTileManifest(makeSlidesManifest()), true, 'slides: lazyEvents, no resident → lazy');
    // A resident tile is NOT lazy.
    const resident = {
      manifestVersion: 3, id: 'r', name: 'r',
      tiles: [{ id: 'main', url: 'main.html', resident: true }],
      capabilities: {},
    } as unknown as TileManifest;
    assert.strictEqual(isLazyTileManifest(resident), false);
  });

  it('loadOrArmFeatureTile (the shared boot+enable path) arms a lazy manifest', () => {
    // The enable IPC handler and boot both funnel through this — a lazy
    // manifest must end up armed (wake accelerator + lazy registration), with
    // no resident launch.
    const result = loadOrArmFeatureTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);
    assert.strictEqual(result, null, 'lazy arm returns no launch result');
    assert.ok(isLazyTileRegistered('windows'));
    assert.strictEqual(registerCalls.length, 1, 'wake accelerator registered');
    assert.strictEqual(launcherState.launchCalls.length, 0, 'lazy path does not launch a window');
  });

  it('a resident manifest routes to the eager branch, not the lazy one', () => {
    // The decision that keeps loadOrArmFeatureTile from lazy-arming a resident
    // tile. The eager `launchTile` side itself needs a real BrowserWindow, so it
    // is exercised by boot in the full gate rather than headless here.
    assert.strictEqual(isLazyTileManifest(makeResidentManifest()), false);
  });

  it('enable arms a static-command tile (windows): wake accelerator + lazy registration', () => {
    armLazyTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);

    assert.ok(isLazyTileRegistered('windows'), 'tile entered the lazy registry');
    assert.strictEqual(registerCalls.length, 1, 'one OS accelerator registered');
    assert.strictEqual(registerCalls[0].keys, 'CommandOrControl+Shift+W');
    assert.strictEqual(registerCalls[0].source, lazyShortcutSource('windows'));
    // Static-hotkey tile (no wakeShortcutsFromSettings) must NOT trigger a
    // backfill wake — that would re-spawn it on every enable cycle.
    assert.strictEqual(launcherState.launchCalls.length, 0, 'no backfill wake for a static-hotkey tile');
  });

  it('enable arms a settings-derived tile (slides): registers the declared set, no re-backfill once declared', () => {
    // Profile that has already declared its real settings-derived set.
    declaredFake.add('slides');
    persistedFake.set('slides', [
      { accelerator: 'Option+Shift+Up', wakeTopic: 'cli:slide-open', wakeArgs: ['Up'] },
    ]);
    featureSettingsFake.add('slides');

    armLazyTile(annotate(makeSlidesManifest()), COMPAT_CONFIG);

    assert.ok(isLazyTileRegistered('slides'));
    assert.strictEqual(registerCalls.length, 1, 'persisted declared row registered (not the manifest default)');
    assert.strictEqual(registerCalls[0].keys, 'Option+Shift+Up');
    // Already declared → no migrated-profile backfill wake.
    assert.strictEqual(launcherState.launchCalls.length, 0, 'declared profile does not re-wake');
  });

  it('enable on a MIGRATED settings-derived profile triggers a one-time backfill wake', async () => {
    // Settings saved (configured profile) but never declared (predates lazy-wake).
    featureSettingsFake.add('slides');
    // declaredFake intentionally empty.
    launcherState.onLaunch = () => signalReady(launcherState, 'slides', 'background');

    armLazyTile(annotate(makeSlidesManifest()), COMPAT_CONFIG);
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.ok(isLazyTileRegistered('slides'));
    assert.strictEqual(launcherState.launchCalls.length, 1, 'migrated profile woke the tile once to declare its real set');
    assert.strictEqual(launcherState.launchCalls[0].manifest.id, 'slides');
  });

  it('enable re-arms the load-on-dispatch route: the lazyEvent wakes the tile live', async () => {
    armLazyTile(annotate(makeSlidesManifest()), COMPAT_CONFIG);
    launcherState.onLaunch = () => signalReady(launcherState, 'slides', 'background');

    publish('peek://hotkey', 'cli:slide-open', { args: ['Up'] });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'lazyEvent published post-enable woke the tile');
    assert.strictEqual(launcherState.launchCalls[0].manifest.id, 'slides');
  });

  it('disable tears down wake accelerators + lazy registration live', () => {
    armLazyTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);
    assert.ok(isLazyTileRegistered('windows'));

    disarmLazyTile('windows');

    assert.strictEqual(isLazyTileRegistered('windows'), false, 'removed from the lazy registry');
    assert.deepStrictEqual(unregisterCalls, [lazyShortcutSource('windows')], 'OS accelerator group unregistered exactly once');
  });

  it('disable publishes cmd:unregister for each announced command (palette entries drop)', () => {
    const dropped: string[] = [];
    subscribe('peek://test-cmd-observer', 'cmd:unregister', (msg: unknown) => {
      const m = msg as { name?: string };
      if (typeof m?.name === 'string') dropped.push(m.name);
    });

    armLazyTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);
    disarmLazyTile('windows');

    unsubscribe('peek://test-cmd-observer', 'cmd:unregister');
    assert.deepStrictEqual(dropped, ['windows'], 'the windows command was unregistered from the palette');
  });

  it('disable removes the load-on-dispatch route: the lazyEvent no longer wakes the tile', async () => {
    armLazyTile(annotate(makeSlidesManifest()), COMPAT_CONFIG);
    disarmLazyTile('slides');

    publish('peek://hotkey', 'cli:slide-open', { args: ['Up'] });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 0, 'a disabled tile is not woken by its former lazyEvent');
  });

  it('idempotent across repeated disable/enable cycles: registry + accelerators stay consistent', () => {
    // Two full cycles.
    armLazyTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);
    disarmLazyTile('windows');
    armLazyTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);
    disarmLazyTile('windows');

    assert.strictEqual(isLazyTileRegistered('windows'), false, 'ends disabled after even cycles');
    // Each disarm unregistered the group exactly once — no leaked/duplicate teardown.
    assert.deepStrictEqual(unregisterCalls, [lazyShortcutSource('windows'), lazyShortcutSource('windows')]);
    // A trailing enable leaves exactly one registry entry, not duplicates.
    armLazyTile(annotate(makeWindowsManifest()), COMPAT_CONFIG);
    assert.deepStrictEqual(getLazyTileIds().filter(id => id === 'windows'), ['windows']);
  });

  it('disarm is safe when nothing was armed (never-enabled / resident-only tile)', () => {
    assert.doesNotThrow(() => disarmLazyTile('never-armed'));
    assert.strictEqual(isLazyTileRegistered('never-armed'), false);
    // unregisterShortcutsForAddress is still called (harmless no-op at the OS layer).
    assert.deepStrictEqual(unregisterCalls, [lazyShortcutSource('never-armed')]);
  });

  it('teardown of one tile leaves a co-registered tile sharing a topic still routable', async () => {
    // Two settings-derived tiles share the same lazyEvent topic; disarming one
    // must NOT drop the shared topic from the dispatch predicate.
    const slidesA = makeSlidesManifest();
    const slidesB = { ...makeSlidesManifest(), id: 'slides2', name: 'slides2' } as TileManifest;
    armLazyTile(annotate(slidesA), COMPAT_CONFIG);
    armLazyTile(annotate(slidesB), COMPAT_CONFIG);

    disarmLazyTile('slides');
    assert.strictEqual(isLazyTileRegistered('slides'), false);
    assert.ok(isLazyTileRegistered('slides2'), 'the sibling tile is still registered');

    // The shared topic still wakes the surviving tile.
    launcherState.onLaunch = () => signalReady(launcherState, 'slides2', 'background');
    publish('peek://hotkey', 'cli:slide-open', { args: ['Up'] });
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'surviving tile still routable on the shared topic');
    assert.strictEqual(launcherState.launchCalls[0].manifest.id, 'slides2');
  });
});
