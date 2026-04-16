/**
 * Unit tests for the tile settings defaults helpers.
 *
 * These tests cover the two pure helpers the `tile:settings:get` fallback
 * relies on:
 *
 *   1. `resolveSettingDefault(manifest, key)` — flat + dotted-path lookup
 *      against `manifest.defaults`. The IPC handler calls this after a
 *      DB miss so tiles see the declared schema default instead of null.
 *   2. `loadSchemaDefaults(tilePath, settingsSchemaRelPath)` — reads the
 *      `defaults` object from a schema file on disk.
 *
 * The four IPC-level scenarios called out in the settings-audit task
 * (stored value, manifest default, neither, per-tile scoping) are
 * exercised at the helper layer — the handler itself is a thin adapter
 * over these two functions plus the datastore.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveSettingDefault,
  loadSchemaDefaults,
} from './tile-settings-defaults.js';
import type { TileManifestV2 } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeManifest(
  id: string,
  defaults?: Record<string, unknown>,
  settingsSchema?: string
): TileManifestV2 {
  return {
    manifestVersion: 2,
    id,
    name: id,
    tiles: [],
    capabilities: {},
    settingsSchema,
    defaults,
  };
}

// ─── resolveSettingDefault ───────────────────────────────────────────

describe('resolveSettingDefault — null / empty inputs', () => {
  it('returns undefined when manifest is null', () => {
    assert.strictEqual(resolveSettingDefault(null, 'foo'), undefined);
  });

  it('returns undefined when manifest is undefined', () => {
    assert.strictEqual(resolveSettingDefault(undefined, 'foo'), undefined);
  });

  it('returns undefined when manifest has no defaults', () => {
    const m = makeManifest('t1');
    assert.strictEqual(resolveSettingDefault(m, 'foo'), undefined);
  });

  it('returns undefined for empty-string key', () => {
    const m = makeManifest('t1', { foo: 'bar' });
    assert.strictEqual(resolveSettingDefault(m, ''), undefined);
  });

  it('returns undefined for a key with no default', () => {
    const m = makeManifest('t1', { foo: 'bar' });
    assert.strictEqual(resolveSettingDefault(m, 'missing'), undefined);
  });
});

describe('resolveSettingDefault — flat keys', () => {
  it('returns the default for a flat key', () => {
    const m = makeManifest('t1', { greeting: 'Hello World' });
    assert.strictEqual(resolveSettingDefault(m, 'greeting'), 'Hello World');
  });

  it('returns the default for a flat key whose value is a boolean', () => {
    const m = makeManifest('t1', { enabled: false });
    assert.strictEqual(resolveSettingDefault(m, 'enabled'), false);
  });

  it('returns the default for a flat key whose value is a number', () => {
    const m = makeManifest('t1', { count: 4 });
    assert.strictEqual(resolveSettingDefault(m, 'count'), 4);
  });

  it('returns the default for a flat key whose value is an object', () => {
    // e.g. editor schema exposes `defaults.prefs = { vimMode: false, ... }`
    // and tiles call `api.settings.get('prefs')` to fetch the whole object.
    const prefs = { vimMode: false, vimSettings: { wrap: false, lineNumbers: true } };
    const m = makeManifest('t1', { prefs });
    assert.deepStrictEqual(resolveSettingDefault(m, 'prefs'), prefs);
  });

  it('distinguishes a declared null default from an undeclared key', () => {
    const m = makeManifest('t1', { foo: null });
    assert.strictEqual(resolveSettingDefault(m, 'foo'), null);
    assert.strictEqual(resolveSettingDefault(m, 'bar'), undefined);
  });
});

describe('resolveSettingDefault — dotted paths', () => {
  it('walks a single level of nesting', () => {
    const m = makeManifest('t1', { prefs: { vimMode: true } });
    assert.strictEqual(resolveSettingDefault(m, 'prefs.vimMode'), true);
  });

  it('walks multiple levels of nesting', () => {
    const m = makeManifest('t1', {
      prefs: { vimSettings: { wrap: false, lineNumbers: true } },
    });
    assert.strictEqual(
      resolveSettingDefault(m, 'prefs.vimSettings.lineNumbers'),
      true
    );
    assert.strictEqual(
      resolveSettingDefault(m, 'prefs.vimSettings.wrap'),
      false
    );
  });

  it('returns undefined when a segment is missing', () => {
    const m = makeManifest('t1', { prefs: { vimMode: true } });
    assert.strictEqual(
      resolveSettingDefault(m, 'prefs.missing'),
      undefined
    );
  });

  it('returns undefined when walking past a non-object', () => {
    const m = makeManifest('t1', { prefs: 'not-an-object' });
    assert.strictEqual(
      resolveSettingDefault(m, 'prefs.vimMode'),
      undefined
    );
  });

  it('prefers flat key over dotted walk when both could match', () => {
    // If a default is literally stored under the dotted key, return that.
    const m = makeManifest('t1', {
      'prefs.vimMode': 'flat-wins',
      prefs: { vimMode: 'nested' },
    });
    assert.strictEqual(
      resolveSettingDefault(m, 'prefs.vimMode'),
      'flat-wins'
    );
  });
});

describe('resolveSettingDefault — per-tile isolation', () => {
  it("one tile's default does not leak to another tile's manifest", () => {
    // Two independent manifests with the same key but different defaults.
    // Resolution is a pure function of the manifest argument, so swapping
    // the manifest swaps the default — no shared registry to leak through.
    const a = makeManifest('tile.a', { greeting: 'hello from A' });
    const b = makeManifest('tile.b', { greeting: 'hello from B' });

    assert.strictEqual(resolveSettingDefault(a, 'greeting'), 'hello from A');
    assert.strictEqual(resolveSettingDefault(b, 'greeting'), 'hello from B');
  });

  it('a tile without a default does not inherit another tile\'s default', () => {
    const withDefault = makeManifest('tile.a', { greeting: 'hello from A' });
    const withoutDefault = makeManifest('tile.b'); // no defaults block

    assert.strictEqual(
      resolveSettingDefault(withDefault, 'greeting'),
      'hello from A'
    );
    assert.strictEqual(
      resolveSettingDefault(withoutDefault, 'greeting'),
      undefined
    );
  });
});

// ─── loadSchemaDefaults ──────────────────────────────────────────────

describe('loadSchemaDefaults', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-settings-defaults-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when settingsSchemaRelPath is undefined', () => {
    assert.strictEqual(loadSchemaDefaults(tmpDir, undefined), null);
  });

  it('returns null when the schema file does not exist', () => {
    assert.strictEqual(loadSchemaDefaults(tmpDir, 'missing.json'), null);
  });

  it('returns null when the schema file has no defaults block', () => {
    const file = 'schema-nodefaults.json';
    fs.writeFileSync(
      path.join(tmpDir, file),
      JSON.stringify({ prefs: { type: 'object' } })
    );
    assert.strictEqual(loadSchemaDefaults(tmpDir, file), null);
  });

  it('returns null when the schema file is not valid JSON', () => {
    const file = 'schema-bad.json';
    fs.writeFileSync(path.join(tmpDir, file), '{ not-valid-json');
    assert.strictEqual(loadSchemaDefaults(tmpDir, file), null);
  });

  it('returns the parsed defaults object when present', () => {
    const file = 'schema-ok.json';
    const defaults = {
      prefs: {
        vimMode: false,
        vimSettings: { wrap: false, lineNumbers: true },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, file),
      JSON.stringify({ prefs: { type: 'object' }, defaults })
    );

    const loaded = loadSchemaDefaults(tmpDir, file);
    assert.deepStrictEqual(loaded, defaults);
  });

  it('ignores a non-object defaults block (array)', () => {
    const file = 'schema-array-defaults.json';
    fs.writeFileSync(
      path.join(tmpDir, file),
      JSON.stringify({ defaults: ['a', 'b'] })
    );
    assert.strictEqual(loadSchemaDefaults(tmpDir, file), null);
  });
});

// ─── Handler-level scenarios ─────────────────────────────────────────

/**
 * The `tile:settings:get` handler is a thin adapter. On DB miss it calls
 * `resolveSettingDefault(getTileManifest(grant.tileId), args.key)`.
 *
 * We simulate the handler's fallback branch here by driving the helper
 * directly with the shape `getTileManifest` would return. This covers
 * the four scenarios called out in the task:
 *
 *   1. Returns stored value when set
 *      (DB hit — helper is never called; exercised in datastore tests)
 *   2. Returns manifest default when not set
 *   3. Returns null-equivalent when neither set nor default
 *   4. Default is scoped per-tile
 */
describe('tile:settings:get fallback — handler-level scenarios', () => {
  it('scenario 2: returns the manifest default when the key has no stored value', () => {
    const manifest = makeManifest('editor', {
      prefs: { vimMode: false, vimSettings: { wrap: false, lineNumbers: true } },
    });
    const fallback = resolveSettingDefault(manifest, 'prefs');
    assert.deepStrictEqual(fallback, {
      vimMode: false,
      vimSettings: { wrap: false, lineNumbers: true },
    });
  });

  it('scenario 3: returns undefined (→ handler returns null) when neither set nor default', () => {
    const manifest = makeManifest('editor', { prefs: { vimMode: false } });
    const fallback = resolveSettingDefault(manifest, 'unknown');
    // Handler converts undefined → null so the IPC contract stays { value: null }.
    assert.strictEqual(fallback, undefined);
    const handlerShape = { value: fallback === undefined ? null : fallback };
    assert.deepStrictEqual(handlerShape, { value: null });
  });

  it('scenario 4: per-tile defaults do not cross-pollinate', () => {
    // Two tiles in the wild — resolving for one must never pick up the other's
    // default. The helper takes the manifest explicitly, so this is a
    // structural guarantee, not a convention.
    const editor = makeManifest('editor', {
      prefs: { vimMode: true },
    });
    const example = makeManifest('example', {
      prefs: { galleryColumns: 4 },
    });

    // Editor asks for `prefs.vimMode` → true (its own default)
    assert.strictEqual(
      resolveSettingDefault(editor, 'prefs.vimMode'),
      true
    );
    // Example asks for `prefs.vimMode` → undefined (it has no such default)
    assert.strictEqual(
      resolveSettingDefault(example, 'prefs.vimMode'),
      undefined
    );
    // Example asks for `prefs.galleryColumns` → 4 (its own default)
    assert.strictEqual(
      resolveSettingDefault(example, 'prefs.galleryColumns'),
      4
    );
    // Editor asks for `prefs.galleryColumns` → undefined
    assert.strictEqual(
      resolveSettingDefault(editor, 'prefs.galleryColumns'),
      undefined
    );
  });
});
