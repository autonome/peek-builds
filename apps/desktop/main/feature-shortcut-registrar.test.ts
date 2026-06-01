/**
 * Unit tests for feature-shortcut-registrar.ts.
 *
 * The registrar is the main-side bridge that lets a LAZY tile own a
 * global hotkey: for each manifest-declared `{ keys, command }` it
 * registers an OS accelerator whose callback PUBLISHES
 * `cmd:execute:<command>` on the System address. That publish flows
 * through the load-on-dispatch hook to wake the tile.
 *
 * These tests exercise that wiring with NO Electron and NO timers via
 * `__setFeatureShortcutRegistrarDepsForTest`, which swaps the real
 * shortcuts/pubsub deps for spies. We assert:
 *   - the global accelerator is registered with the right keys, the
 *     `peek://<id>/lazy-shortcut` source, and a callback;
 *   - invoking that callback publishes `cmd:execute:<command>` on the
 *     stubbed System address;
 *   - a `global: false` shortcut is skipped;
 *   - a manifest with no shortcuts is a no-op.
 *
 * Runs under Electron's Node host (via `yarn test:unit`).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import {
  registerManifestShortcuts,
  lazyShortcutSource,
  __setFeatureShortcutRegistrarDepsForTest,
} from './feature-shortcut-registrar.js';
import type { TileManifest } from './tile-manifest.js';

// ─── Spy harness ─────────────────────────────────────────────────────

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

function installSpies(registerReturns: Error | undefined = undefined): void {
  registerCalls = [];
  publishCalls = [];
  __setFeatureShortcutRegistrarDepsForTest({
    registerGlobalShortcut: (keys: string, source: string, callback: () => void) => {
      registerCalls.push({ keys, source, callback });
      return registerReturns;
    },
    unregisterShortcutsForAddress: () => {},
    publish: (source: string, topic: string, msg: unknown) => {
      publishCalls.push({ source, topic, msg });
    },
    getSystemAddress: () => STUB_SYSTEM_ADDRESS,
  });
}

/** Minimal TileManifest-shaped object mirroring features/windows/manifest.json. */
function makeWindowsManifest(): TileManifest {
  return {
    id: 'windows',
    shortcuts: [{ keys: 'CommandOrControl+Shift+W', command: 'windows' }],
  } as unknown as TileManifest;
}

describe('feature-shortcut-registrar', () => {
  beforeEach(() => {
    installSpies();
  });

  afterEach(() => {
    // Restore the real shortcuts/pubsub deps so no spy leaks across files.
    __setFeatureShortcutRegistrarDepsForTest(null);
  });

  it('lazyShortcutSource builds the per-tile source address', () => {
    assert.strictEqual(lazyShortcutSource('windows'), 'peek://windows/lazy-shortcut');
  });

  it('registers the windows manifest global shortcut with keys + lazy-shortcut source + callback', () => {
    registerManifestShortcuts(makeWindowsManifest());

    assert.strictEqual(registerCalls.length, 1, 'exactly one accelerator registered');
    const call = registerCalls[0];
    assert.strictEqual(call.keys, 'CommandOrControl+Shift+W');
    assert.strictEqual(call.source, 'peek://windows/lazy-shortcut');
    assert.strictEqual(typeof call.callback, 'function');
  });

  it('the registered callback publishes cmd:execute:<command> on the System address', () => {
    registerManifestShortcuts(makeWindowsManifest());
    assert.strictEqual(publishCalls.length, 0, 'no publish before the hotkey fires');

    // Fire the accelerator callback — the keypress's sole job.
    registerCalls[0].callback();

    assert.strictEqual(publishCalls.length, 1, 'exactly one publish on hotkey');
    assert.deepStrictEqual(publishCalls[0], {
      source: STUB_SYSTEM_ADDRESS,
      topic: 'cmd:execute:windows',
      msg: {},
    });
  });

  it('skips a shortcut with global: false', () => {
    const manifest = {
      id: 'thing',
      shortcuts: [
        { keys: 'Ctrl+Alt+Z', command: 'zap', global: false },
        { keys: 'Ctrl+Alt+Y', command: 'yank' },
      ],
    } as unknown as TileManifest;

    registerManifestShortcuts(manifest);

    // Only the global (non-opt-out) shortcut is taken by the OS registrar.
    assert.strictEqual(registerCalls.length, 1);
    assert.strictEqual(registerCalls[0].keys, 'Ctrl+Alt+Y');
    assert.strictEqual(registerCalls[0].source, 'peek://thing/lazy-shortcut');

    registerCalls[0].callback();
    assert.deepStrictEqual(publishCalls, [
      { source: STUB_SYSTEM_ADDRESS, topic: 'cmd:execute:yank', msg: {} },
    ]);
  });

  it('is a no-op for a manifest with no shortcuts', () => {
    const noShortcuts = { id: 'quiet' } as unknown as TileManifest;
    registerManifestShortcuts(noShortcuts);
    assert.strictEqual(registerCalls.length, 0);

    const emptyShortcuts = { id: 'quiet', shortcuts: [] } as unknown as TileManifest;
    registerManifestShortcuts(emptyShortcuts);
    assert.strictEqual(registerCalls.length, 0);

    assert.strictEqual(publishCalls.length, 0);
  });

  it('skips malformed shortcut entries (missing keys or command)', () => {
    const manifest = {
      id: 'mixed',
      shortcuts: [
        { keys: 'Ctrl+1' }, // no command
        { command: 'two' }, // no keys
        { keys: 'Ctrl+3', command: 'three' }, // valid
      ],
    } as unknown as TileManifest;

    registerManifestShortcuts(manifest);

    assert.strictEqual(registerCalls.length, 1);
    assert.strictEqual(registerCalls[0].keys, 'Ctrl+3');
  });
});
