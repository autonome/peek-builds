/**
 * Unit tests for the generic persisted lazy-wake-shortcut registry
 * (STEP 3a of the lazy-feature workstream, peek task 921b54b3).
 *
 * Two layers are exercised here, both WITHOUT Electron / timers:
 *
 *   1. Datastore (real node:sqlite against a temp DB file, the same
 *      pattern as datastore.test.ts): `setWakeShortcuts` snapshot
 *      (replace-all) semantics + `getWakeShortcuts` / `getAllWakeShortcuts`.
 *
 *   2. Registrar (`feature-shortcut-registrar.ts`) via the spy-injection
 *      seam `__setFeatureShortcutRegistrarDepsForTest`: boot-replay
 *      precedence (persisted rows beat manifest defaults), the registered
 *      callback publishes `wakeTopic` with `{ args }`, command-style
 *      manifest entries still map to `cmd:execute:<command>` (regression
 *      guard for windows), the declare-wake live re-register sequence
 *      (unregister the tile's prior group then register the new set), and
 *      teardown unregisters `lazyShortcutSource(tileId)`.
 *
 * Runs under Electron's Node host (via `yarn test:unit`).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  registerWakeShortcuts,
  registerWakeShortcutList,
  manifestShortcutsToWake,
  lazyShortcutSource,
  unregisterManifestShortcuts,
  wakeDeclarationBackfillNeeded,
  __setFeatureShortcutRegistrarDepsForTest,
} from './feature-shortcut-registrar.js';
import type { TileManifest } from './tile-manifest.js';
import type { WakeShortcut } from './datastore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Spy harness (registrar) ─────────────────────────────────────────

interface RegisterCall {
  keys: string;
  source: string;
  callback: () => void;
}
interface PublishCall {
  source: string;
  topic: string;
  msg: unknown;
}

const STUB_SYSTEM_ADDRESS = 'peek://system/stub';

let registerCalls: RegisterCall[];
let publishCalls: PublishCall[];
let unregisterCalls: string[];
let persistedFake: Map<string, WakeShortcut[]>;
let declaredFake: Set<string>;
let featureSettingsFake: Set<string>;

function installSpies(): void {
  registerCalls = [];
  publishCalls = [];
  unregisterCalls = [];
  persistedFake = new Map();
  declaredFake = new Set();
  featureSettingsFake = new Set();
  __setFeatureShortcutRegistrarDepsForTest({
    registerGlobalShortcut: (keys: string, source: string, callback: () => void) => {
      registerCalls.push({ keys, source, callback });
      return undefined;
    },
    unregisterShortcutsForAddress: (address: string) => {
      unregisterCalls.push(address);
    },
    publish: (source: string, topic: string, msg: unknown) => {
      publishCalls.push({ source, topic, msg });
    },
    getSystemAddress: () => STUB_SYSTEM_ADDRESS,
    getWakeShortcuts: (ownerTileId: string) => persistedFake.get(ownerTileId) ?? [],
    hasDeclaredWakeShortcuts: (ownerTileId: string) => declaredFake.has(ownerTileId),
    hasFeatureSettings: (ownerTileId: string) => featureSettingsFake.has(ownerTileId),
  });
}

/**
 * A settings-derived lazy feature manifest (peeks/slides shape): a single
 * STATIC default shortcut + the `wakeShortcutsFromSettings` flag that marks the
 * real hotkeys as renderer-declared-from-settings.
 */
function makeSettingsDerivedManifest(withFlag = true): TileManifest {
  return {
    id: 'slides',
    wakeShortcutsFromSettings: withFlag,
    settingsSchema: './settings-schema.json',
    shortcuts: [{ keys: 'Option+Up', wakeTopic: 'cli:slide-open', wakeArgs: ['Up'] }],
  } as unknown as TileManifest;
}

function makeWindowsManifest(): TileManifest {
  return {
    id: 'windows',
    shortcuts: [{ keys: 'CommandOrControl+Shift+W', command: 'windows' }],
  } as unknown as TileManifest;
}

function makePeeksManifest(): TileManifest {
  // wakeTopic-style static default (the new topic form).
  return {
    id: 'peeks',
    shortcuts: [
      { keys: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
      { keys: 'Alt+1', wakeTopic: 'peeks:open', wakeArgs: [1] },
    ],
  } as unknown as TileManifest;
}

// ─── Datastore tests (real DB) ───────────────────────────────────────

describe('lazy_wake_shortcuts datastore accessors', () => {
  const TEST_DB_PATH = path.join(__dirname, `lazy-wake-test-${process.pid}.db`);
  let datastore: typeof import('./datastore.js');

  before(async () => {
    try { fs.unlinkSync(TEST_DB_PATH); } catch { /* fresh */ }
    datastore = await import('./datastore.js');
    datastore.initDatabase(TEST_DB_PATH);
  });

  after(() => {
    try { datastore.closeDatabase?.(); } catch { /* best effort */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    datastore.setWakeShortcuts('peeks', []);
    datastore.setWakeShortcuts('slides', []);
  });

  it('persists and reads back wake shortcuts for a tile, parsing wakeArgs JSON', () => {
    datastore.setWakeShortcuts('peeks', [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
      { accelerator: 'Alt+1', wakeTopic: 'peeks:open', wakeArgs: [1, 'x'] },
    ]);
    const rows = datastore.getWakeShortcuts('peeks');
    assert.strictEqual(rows.length, 2);
    const byAccel = new Map(rows.map((r) => [r.accelerator, r]));
    assert.deepStrictEqual(byAccel.get('Alt+0'), { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] });
    assert.deepStrictEqual(byAccel.get('Alt+1'), { accelerator: 'Alt+1', wakeTopic: 'peeks:open', wakeArgs: [1, 'x'] });
  });

  it('setWakeShortcuts has replace-all semantics: a second smaller call drops the missing rows', () => {
    datastore.setWakeShortcuts('peeks', [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
      { accelerator: 'Alt+1', wakeTopic: 'peeks:open', wakeArgs: [1] },
      { accelerator: 'Alt+2', wakeTopic: 'peeks:open', wakeArgs: [2] },
    ]);
    assert.strictEqual(datastore.getWakeShortcuts('peeks').length, 3);

    // Re-declare with fewer rows — the dropped ones must be gone.
    datastore.setWakeShortcuts('peeks', [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
    ]);
    const rows = datastore.getWakeShortcuts('peeks');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].accelerator, 'Alt+0');

    // Empty list clears entirely.
    datastore.setWakeShortcuts('peeks', []);
    assert.strictEqual(datastore.getWakeShortcuts('peeks').length, 0);
  });

  it('hasDeclaredWakeShortcuts distinguishes declared-empty from never-declared', () => {
    // 'never-declared-tile' has had no setWakeShortcuts call.
    assert.strictEqual(datastore.hasDeclaredWakeShortcuts('never-declared-tile'), false);

    // beforeEach already called setWakeShortcuts('peeks', []) → declared, empty.
    assert.strictEqual(datastore.hasDeclaredWakeShortcuts('peeks'), true);
    assert.strictEqual(datastore.getWakeShortcuts('peeks').length, 0);

    // Declaring a non-empty set keeps it declared.
    datastore.setWakeShortcuts('peeks', [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
    ]);
    assert.strictEqual(datastore.hasDeclaredWakeShortcuts('peeks'), true);

    // Re-declaring empty (user cleared all) STAYS declared — marker persists.
    datastore.setWakeShortcuts('peeks', []);
    assert.strictEqual(datastore.hasDeclaredWakeShortcuts('peeks'), true);
    assert.strictEqual(datastore.getWakeShortcuts('peeks').length, 0);
  });

  it('getAllWakeShortcuts groups rows by owner tile', () => {
    datastore.setWakeShortcuts('peeks', [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
    ]);
    datastore.setWakeShortcuts('slides', [
      { accelerator: 'Alt+Left', wakeTopic: 'slides:edge', wakeArgs: ['left'] },
      { accelerator: 'Alt+Right', wakeTopic: 'slides:edge', wakeArgs: ['right'] },
    ]);
    const all = datastore.getAllWakeShortcuts();
    assert.strictEqual(all.get('peeks')?.length, 1);
    assert.strictEqual(all.get('slides')?.length, 2);
  });
});

// ─── Registrar boot-replay + live re-register tests (spies) ──────────

describe('feature-shortcut-registrar wake replay', () => {
  beforeEach(() => {
    installSpies();
  });
  afterEach(() => {
    __setFeatureShortcutRegistrarDepsForTest(null);
  });

  it('manifestShortcutsToWake maps command-style to cmd:execute:<command> with no args', () => {
    const wake = manifestShortcutsToWake(makeWindowsManifest().shortcuts);
    assert.deepStrictEqual(wake, [
      { accelerator: 'CommandOrControl+Shift+W', wakeTopic: 'cmd:execute:windows', wakeArgs: [] },
    ]);
  });

  it('manifestShortcutsToWake maps topic-style entries with their args', () => {
    const wake = manifestShortcutsToWake(makePeeksManifest().shortcuts);
    assert.deepStrictEqual(wake, [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
      { accelerator: 'Alt+1', wakeTopic: 'peeks:open', wakeArgs: [1] },
    ]);
  });

  it('boot replay: with NO persisted rows, registers the manifest defaults', () => {
    // windows: no persisted rows → manifest static shortcut.
    registerWakeShortcuts('windows', makeWindowsManifest());

    assert.strictEqual(registerCalls.length, 1, 'one accelerator from manifest default');
    assert.strictEqual(registerCalls[0].keys, 'CommandOrControl+Shift+W');
    assert.strictEqual(registerCalls[0].source, lazyShortcutSource('windows'));

    // Regression: command-style still publishes cmd:execute:<command>.
    registerCalls[0].callback();
    assert.deepStrictEqual(publishCalls, [
      { source: STUB_SYSTEM_ADDRESS, topic: 'cmd:execute:windows', msg: { args: [] } },
    ]);
  });

  it('boot replay: persisted rows take precedence over manifest defaults', () => {
    // peeks has DECLARED user customizations that differ from the manifest.
    declaredFake.add('peeks');
    persistedFake.set('peeks', [
      { accelerator: 'Alt+9', wakeTopic: 'peeks:open', wakeArgs: [9] },
    ]);

    registerWakeShortcuts('peeks', makePeeksManifest());

    // Only the persisted row registered — NOT the manifest's Alt+0/Alt+1.
    assert.strictEqual(registerCalls.length, 1, 'persisted set, not manifest defaults');
    assert.strictEqual(registerCalls[0].keys, 'Alt+9');
    assert.strictEqual(registerCalls[0].source, lazyShortcutSource('peeks'));

    // The callback publishes the persisted wakeTopic with { args }.
    registerCalls[0].callback();
    assert.deepStrictEqual(publishCalls, [
      { source: STUB_SYSTEM_ADDRESS, topic: 'peeks:open', msg: { args: [9] } },
    ]);
  });

  it('boot replay: DECLARED-EMPTY registers nothing (user cleared all hotkeys), NOT the manifest defaults', () => {
    // The user declared their wake set but it is empty — the declared
    // marker is set, persisted rows are empty. The manifest's Alt+0/Alt+1
    // defaults must NOT be resurrected.
    declaredFake.add('peeks');
    persistedFake.set('peeks', []);

    registerWakeShortcuts('peeks', makePeeksManifest());

    assert.strictEqual(registerCalls.length, 0, 'declared-empty → register nothing');
    assert.strictEqual(publishCalls.length, 0);
  });

  it('boot replay: NEVER-DECLARED falls back to manifest defaults (fresh profile)', () => {
    // No declared marker, no persisted rows — fresh profile. The manifest's
    // static defaults are the source.
    assert.strictEqual(declaredFake.has('peeks'), false);
    assert.strictEqual((persistedFake.get('peeks') ?? []).length, 0);

    registerWakeShortcuts('peeks', makePeeksManifest());

    assert.strictEqual(registerCalls.length, 2, 'both manifest defaults registered');
    assert.deepStrictEqual(registerCalls.map((c) => c.keys), ['Alt+0', 'Alt+1']);
  });

  it('a registered wake callback publishes its topic with { args: wakeArgs } on the System address', () => {
    const list: WakeShortcut[] = [
      { accelerator: 'Alt+Left', wakeTopic: 'slides:edge', wakeArgs: ['left'] },
    ];
    registerWakeShortcutList('slides', list);

    assert.strictEqual(registerCalls.length, 1);
    assert.strictEqual(registerCalls[0].keys, 'Alt+Left');
    assert.strictEqual(registerCalls[0].source, lazyShortcutSource('slides'));
    assert.strictEqual(publishCalls.length, 0, 'no publish before the hotkey fires');

    registerCalls[0].callback();
    assert.deepStrictEqual(publishCalls, [
      { source: STUB_SYSTEM_ADDRESS, topic: 'slides:edge', msg: { args: ['left'] } },
    ]);
  });

  it('live re-register: unregistering the tile group then registering the new set (declare-wake composition)', () => {
    // First set.
    registerWakeShortcutList('peeks', [
      { accelerator: 'Alt+0', wakeTopic: 'peeks:open', wakeArgs: [0] },
    ]);
    assert.strictEqual(registerCalls.length, 1);

    // This mirrors the IPC handler's live-re-register: drop prior group, then register new.
    unregisterManifestShortcuts('peeks'); // unregisterShortcutsForAddress(lazyShortcutSource('peeks'))
    registerWakeShortcutList('peeks', [
      { accelerator: 'Alt+5', wakeTopic: 'peeks:open', wakeArgs: [5] },
      { accelerator: 'Alt+6', wakeTopic: 'peeks:open', wakeArgs: [6] },
    ]);

    assert.deepStrictEqual(unregisterCalls, [lazyShortcutSource('peeks')], 'prior group unregistered exactly once');
    // 1 from first set + 2 from the new set.
    assert.strictEqual(registerCalls.length, 3);
    assert.deepStrictEqual(registerCalls.slice(1).map((c) => c.keys), ['Alt+5', 'Alt+6']);
  });

  it('teardown unregisters the lazyShortcutSource(tileId) group', () => {
    unregisterManifestShortcuts('peeks');
    assert.deepStrictEqual(unregisterCalls, [lazyShortcutSource('peeks')]);
  });

  it('empty persisted AND empty manifest is a no-op', () => {
    registerWakeShortcuts('quiet', { id: 'quiet' } as unknown as TileManifest);
    assert.strictEqual(registerCalls.length, 0);
    assert.strictEqual(publishCalls.length, 0);
  });
});

// ─── Wake-declaration backfill (migrated-profile self-heal) ──────────
//
// Repro for the prod-profile dead-hotkeys bug: a user whose saved hotkey
// prefix (e.g. `Option+Shift+`) differs from the manifest static default
// (`Option+Up`) gets ONLY the default registered at boot, because the lazy
// tile that would declare the real, settings-derived set never boots (the
// user never presses the default). `wakeDeclarationBackfillNeeded` decides
// whether to break that deadlock by waking the tile once at boot.
describe('wake-declaration backfill (migrated-profile self-heal)', () => {
  beforeEach(() => {
    installSpies();
  });
  afterEach(() => {
    __setFeatureShortcutRegistrarDepsForTest(null);
  });

  it('MIGRATED profile (settings saved, never declared, settings-derived flag) → backfill needed', () => {
    // THE BUG: feature_settings present (user configured a non-default prefix),
    // but lazy_wake_* never declared (settings predate the lazy-wake system).
    // Boot-replay would register only the manifest default → user's real keys
    // dead. This MUST request a one-time wake so the tile declares its real set.
    featureSettingsFake.add('slides'); // user has configured slides
    // declaredFake intentionally does NOT contain 'slides' (never declared)
    assert.strictEqual(
      wakeDeclarationBackfillNeeded('slides', makeSettingsDerivedManifest()),
      true,
    );
  });

  it('already-declared profile → no backfill (heals once, then stays lazy)', () => {
    featureSettingsFake.add('slides');
    declaredFake.add('slides'); // declared at least once → persisted set authoritative
    assert.strictEqual(
      wakeDeclarationBackfillNeeded('slides', makeSettingsDerivedManifest()),
      false,
    );
  });

  it('fresh profile (no saved settings) → no backfill (manifest defaults + first press bootstrap it lazily)', () => {
    // featureSettingsFake empty → not a configured/migrated profile.
    assert.strictEqual(declaredFake.has('slides'), false);
    assert.strictEqual(
      wakeDeclarationBackfillNeeded('slides', makeSettingsDerivedManifest()),
      false,
    );
  });

  it('static-shortcut feature without the flag → never backfills, even with saved settings', () => {
    // windows: a fixed `CommandOrControl+Shift+W` command shortcut, never calls
    // declareWakeShortcuts. Waking it would NOT set the declared marker, so it
    // would re-fire every boot — the flag gate prevents that.
    featureSettingsFake.add('windows');
    assert.strictEqual(
      wakeDeclarationBackfillNeeded('windows', makeWindowsManifest()),
      false,
    );
  });

  it('flag set but renderer somehow cleared all hotkeys (declared-empty) → no backfill', () => {
    // declared-empty is still "declared" — the user's explicit empty set wins;
    // do not resurrect via a wake.
    featureSettingsFake.add('slides');
    declaredFake.add('slides');
    persistedFake.set('slides', []);
    assert.strictEqual(
      wakeDeclarationBackfillNeeded('slides', makeSettingsDerivedManifest()),
      false,
    );
  });
});
