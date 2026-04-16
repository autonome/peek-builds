/**
 * Unit tests for strict `tile:shortcuts:*` capability enforcement.
 *
 * Covers the pure-helper `checkShortcutAllowed` used by the
 * `tile:shortcuts:register` and `tile:shortcuts:unregister` IPC
 * handlers in `tile-ipc.ts`. See §HIGH bypass #2 in the security
 * audit — prior to this, tiles could register global hotkeys via
 * the v1-compat `registershortcut` channel without declaring the
 * `shortcuts` capability.
 *
 * Imports the helper from its pure module (`tile-shortcuts-enforcement`)
 * so the test does not pull in `tile-ipc`'s Electron dependencies
 * (ipcMain, BrowserWindow, etc.) and can run under plain Node.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkShortcutAllowed } from './tile-shortcuts-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkShortcutAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkShortcutAllowed(null, 'Alt+Q');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no shortcuts capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkShortcutAllowed(grant, 'Alt+Q');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /shortcuts capability not granted/i);
    }
  });

  it('rejects when shortcuts capability is explicitly false in grant', () => {
    // Construct a grant manually with shortcuts: false (normally
    // resolveCapabilities would omit the field, but defensive code
    // should still reject this shape).
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { shortcuts: false as unknown as boolean },
      denied: [],
    };
    const result = checkShortcutAllowed(grant, 'Alt+Q');
    assert.strictEqual(result.ok, false);
  });
});

// ─── Shortcuts: true (unrestricted) ──────────────────────────────────

describe('checkShortcutAllowed — shortcuts: true', () => {
  it('allows any shortcut when shortcuts is true', () => {
    const grant = makeGrant({ shortcuts: true });
    for (const shortcut of ['Alt+Q', 'Ctrl+Shift+P', 'F1', 'CommandOrControl+K']) {
      const result = checkShortcutAllowed(grant, shortcut);
      assert.strictEqual(result.ok, true, `expected ${shortcut} to be allowed`);
    }
  });
});

// ─── Shortcuts: { keys: [...] } (allowlist) ──────────────────────────

describe('checkShortcutAllowed — shortcuts.keys allowlist', () => {
  it('allows a shortcut that appears in the keys allowlist', () => {
    const grant = makeGrant({ shortcuts: { keys: ['Alt+Q', 'Alt+W'] } });
    const result = checkShortcutAllowed(grant, 'Alt+Q');
    assert.strictEqual(result.ok, true);
  });

  it('allows all keys in the allowlist', () => {
    const keys = ['Alt+Q', 'Ctrl+K', 'F1'];
    const grant = makeGrant({ shortcuts: { keys } });
    for (const k of keys) {
      const result = checkShortcutAllowed(grant, k);
      assert.strictEqual(result.ok, true, `expected ${k} to be allowed`);
    }
  });

  it('rejects a shortcut not in the keys allowlist', () => {
    const grant = makeGrant({ shortcuts: { keys: ['Alt+Q'] } });
    const result = checkShortcutAllowed(grant, 'Alt+X');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not in capability keys allowlist/i);
      assert.match(result.error, /Alt\+X/);
    }
  });

  it('rejects every shortcut when keys list is empty', () => {
    const grant = makeGrant({ shortcuts: { keys: [] } });
    for (const shortcut of ['Alt+Q', 'Ctrl+K']) {
      const result = checkShortcutAllowed(grant, shortcut);
      assert.strictEqual(result.ok, false, `expected ${shortcut} to be rejected by empty allowlist`);
    }
  });

  it('treats shortcut matching as exact string match', () => {
    const grant = makeGrant({ shortcuts: { keys: ['Alt+Q'] } });
    // Case and whitespace differences should not match.
    assert.strictEqual(checkShortcutAllowed(grant, 'alt+q').ok, false);
    assert.strictEqual(checkShortcutAllowed(grant, 'Alt + Q').ok, false);
    assert.strictEqual(checkShortcutAllowed(grant, 'Alt+Q ').ok, false);
    assert.strictEqual(checkShortcutAllowed(grant, 'Alt+Q').ok, true);
  });

  it('allows any shortcut when object form omits keys', () => {
    // shortcuts: {} behaves like shortcuts: true (no allowlist).
    const grant = makeGrant({ shortcuts: {} });
    assert.strictEqual(checkShortcutAllowed(grant, 'Alt+Q').ok, true);
    assert.strictEqual(checkShortcutAllowed(grant, 'Ctrl+Anything').ok, true);
  });
});

// ─── Unregister-parity ───────────────────────────────────────────────

describe('checkShortcutAllowed — unregister parity', () => {
  // The `tile:shortcuts:unregister` handler uses the same pure check as
  // register (per the task spec: "Unregister mirrors same validations").
  // These tests document that expectation.

  it('rejects unregister with missing capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkShortcutAllowed(grant, 'Alt+Q');
    assert.strictEqual(result.ok, false);
  });

  it('rejects unregister for shortcut outside allowlist', () => {
    const grant = makeGrant({ shortcuts: { keys: ['Alt+Q'] } });
    const result = checkShortcutAllowed(grant, 'Alt+X');
    assert.strictEqual(result.ok, false);
  });

  it('allows unregister for shortcut inside allowlist', () => {
    const grant = makeGrant({ shortcuts: { keys: ['Alt+Q'] } });
    const result = checkShortcutAllowed(grant, 'Alt+Q');
    assert.strictEqual(result.ok, true);
  });

  it('allows unregister when shortcuts: true (unrestricted)', () => {
    const grant = makeGrant({ shortcuts: true });
    const result = checkShortcutAllowed(grant, 'any-shortcut-whatsoever');
    assert.strictEqual(result.ok, true);
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — shortcuts shape preservation', () => {
  it('preserves shortcuts: true across resolution', () => {
    const grant = resolveCapabilities('t', { shortcuts: true }, false);
    assert.strictEqual(grant.capabilities.shortcuts, true);
  });

  it('preserves shortcuts object (with keys) across resolution', () => {
    const keys = ['Alt+Q', 'Alt+W'];
    const grant = resolveCapabilities('t', { shortcuts: { keys } }, false);
    const sc = grant.capabilities.shortcuts;
    assert.ok(sc && typeof sc === 'object', 'shortcuts should remain an object');
    assert.deepStrictEqual((sc as { keys: string[] }).keys, keys);
  });

  it('checkShortcutAllowed honours the allowlist on a resolved grant', () => {
    const grant = resolveCapabilities(
      't',
      { shortcuts: { keys: ['Alt+Q'] } },
      false,
    );
    assert.strictEqual(checkShortcutAllowed(grant, 'Alt+Q').ok, true);
    assert.strictEqual(checkShortcutAllowed(grant, 'Alt+X').ok, false);
  });

  it('resolved grant with keys rejects non-listed shortcut at IPC enforcement point', () => {
    // End-to-end: a tile manifest with allowlist → resolved grant →
    // IPC handler check → rejection. Demonstrates the full chain.
    const caps: TileCapabilities = { shortcuts: { keys: ['Alt+Q'] } };
    const grant = resolveCapabilities('my-tile', caps, false);
    const result = checkShortcutAllowed(grant, 'Alt+Rogue');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Alt\+Rogue/);
    }
  });
});
