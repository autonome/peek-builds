/**
 * Unit tests for strict `tile:settings:get-foreign` capability enforcement.
 *
 * Covers the pure helper `checkSettingsForeignAllowed` used by the
 * `tile:settings:get-foreign` IPC handler in `tile-ipc.ts`. Imports from
 * the pure module (`tile-settings-foreign-enforcement`) so the test does
 * not pull in `tile-ipc`'s Electron dependencies and can run under plain
 * Node.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkSettingsForeignAllowed } from './tile-settings-foreign-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkSettingsForeignAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkSettingsForeignAllowed(null, 'lex');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when foreignExtId is empty string', () => {
    const grant = makeGrant({ settings: { readForeign: ['lex'] } });
    const result = checkSettingsForeignAllowed(grant, '');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /foreignExtId is required/i);
    }
  });

  it('rejects when grant has no settings capability at all', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkSettingsForeignAllowed(grant, 'lex');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /settings capability not granted/i);
    }
  });
});

// ─── Self-read always permitted ─────────────────────────────────────

describe('checkSettingsForeignAllowed — self-reads', () => {
  it('permits self-read even without a readForeign list (settings:true)', () => {
    const grant = makeGrant({ settings: true });
    const result = checkSettingsForeignAllowed(grant, grant.tileId);
    assert.strictEqual(result.ok, true);
  });

  it('permits self-read with object settings', () => {
    const grant = makeGrant({ settings: { readForeign: [] } });
    const result = checkSettingsForeignAllowed(grant, grant.tileId);
    assert.strictEqual(result.ok, true);
  });
});

// ─── settings: true (no foreign reads) ──────────────────────────────

describe('checkSettingsForeignAllowed — settings: true (no readForeign)', () => {
  it('rejects foreign read when settings is plain true', () => {
    const grant = makeGrant({ settings: true });
    const result = checkSettingsForeignAllowed(grant, 'lex');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /readForeign capability not granted/i);
    }
  });
});

// ─── settings.readForeign allowlist ─────────────────────────────────

describe('checkSettingsForeignAllowed — settings.readForeign allowlist', () => {
  it('allows a foreign id that appears in the readForeign allowlist', () => {
    const grant = makeGrant({ settings: { readForeign: ['lex', 'editor'] } });
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'lex').ok, true);
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'editor').ok, true);
  });

  it('rejects a foreign id not in the readForeign allowlist', () => {
    const grant = makeGrant({ settings: { readForeign: ['lex'] } });
    const result = checkSettingsForeignAllowed(grant, 'rogue');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /rogue/);
      assert.match(result.error, /not in settings\.readForeign allowlist/i);
    }
  });

  it('rejects every foreign id when readForeign is empty', () => {
    const grant = makeGrant({ settings: { readForeign: [] } });
    // Even empty allowlist fails because the resolveCapabilities grant
    // also strips empty-array readForeign — but we explicitly check both.
    const result = checkSettingsForeignAllowed(grant, 'lex');
    assert.strictEqual(result.ok, false);
  });

  it('treats "*" as blanket foreign-read access', () => {
    const grant = makeGrant({ settings: { readForeign: ['*'] } });
    for (const id of ['lex', 'editor', 'groups', 'spaces']) {
      assert.strictEqual(checkSettingsForeignAllowed(grant, id).ok, true, `expected ${id} allowed under *`);
    }
  });
});

// ─── settingsForeign top-level fallback ─────────────────────────────

describe('checkSettingsForeignAllowed — settingsForeign fallback', () => {
  it('allows via settingsForeign when settings is plain true', () => {
    const grant = makeGrant({
      settings: true,
      settingsForeign: ['lex'],
    });
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'lex').ok, true);
  });

  it('rejects via settingsForeign when id not listed', () => {
    const grant = makeGrant({
      settings: true,
      settingsForeign: ['lex'],
    });
    const result = checkSettingsForeignAllowed(grant, 'editor');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /editor/);
    }
  });

  it('settings.readForeign takes precedence over settingsForeign when both present', () => {
    // readForeign wins because resolveForeignList checks it first.
    const grant = makeGrant({
      settings: { readForeign: ['lex'] },
      settingsForeign: ['editor'], // should be ignored
    });
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'lex').ok, true);
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'editor').ok, false);
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — settings shape preservation', () => {
  it('preserves settings: true across resolution', () => {
    const grant = resolveCapabilities('t', { settings: true }, false);
    assert.strictEqual(grant.capabilities.settings, true);
  });

  it('preserves settings.readForeign array across resolution', () => {
    const grant = resolveCapabilities(
      't',
      { settings: { readForeign: ['lex', 'editor'] } },
      false,
    );
    const s = grant.capabilities.settings;
    assert.ok(s && typeof s === 'object', 'settings should remain an object');
    assert.deepStrictEqual((s as { readForeign: string[] }).readForeign, ['lex', 'editor']);
  });

  it('preserves settingsForeign sibling across resolution', () => {
    const grant = resolveCapabilities(
      't',
      { settings: true, settingsForeign: ['lex'] },
      false,
    );
    assert.deepStrictEqual(grant.capabilities.settingsForeign, ['lex']);
  });

  it('drops empty settingsForeign array at resolution', () => {
    const grant = resolveCapabilities(
      't',
      { settings: true, settingsForeign: [] },
      false,
    );
    assert.strictEqual(grant.capabilities.settingsForeign, undefined);
  });

  it('end-to-end: resolved grant enforces allowlist at IPC enforcement point', () => {
    const caps: TileCapabilities = { settings: { readForeign: ['lex'] } };
    const grant = resolveCapabilities('features-manager', caps, false);
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'lex').ok, true);
    assert.strictEqual(checkSettingsForeignAllowed(grant, 'rogue').ok, false);
  });
});
