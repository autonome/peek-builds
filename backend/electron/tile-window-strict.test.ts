/**
 * Unit tests for strict `tile:window:*` capability enforcement.
 *
 * Covers the pure-helper `checkWindowAllowed` used by the
 * `tile:window:open` / `close` / `list` / `info` IPC handlers in
 * `tile-ipc.ts`. Prior to this, v2 tiles could open arbitrary windows
 * via the un-gated `window-open` channel without declaring the
 * `window` capability.
 *
 * Imports the helper from its pure module (`tile-window-enforcement`)
 * so the test does not pull in `tile-ipc`'s Electron dependencies
 * (ipcMain, BrowserWindow, etc.) and can run under plain Node.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkWindowAllowed } from './tile-window-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Token / Grant Presence ──────────────────────────────────────────

describe('checkWindowAllowed — grant presence', () => {
  it('rejects when grant is null (invalid token)', () => {
    const result = checkWindowAllowed(null, 'open', { url: 'peek://x/' });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects when grant has no window capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://x/' });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /window capability not granted/i);
    }
  });

  it('rejects when window capability is explicitly false in grant', () => {
    const grant: CapabilityGrant = {
      tileId: 'test-tile',
      capabilities: { window: false as unknown as boolean },
      denied: [],
    };
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://x/' });
    assert.strictEqual(result.ok, false);
  });
});

// ─── window: true (unrestricted) ─────────────────────────────────────

describe('checkWindowAllowed — window: true', () => {
  it('allows open with any peek:// URL when window is true', () => {
    const grant = makeGrant({ window: true });
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://anything/page.html' });
    assert.strictEqual(result.ok, true);
  });

  it('allows close of own window when window is true', () => {
    const grant = makeGrant({ window: true });
    const result = checkWindowAllowed(grant, 'close', { ownWindow: true });
    assert.strictEqual(result.ok, true);
  });

  it('allows close of other window when window is true (implies manage)', () => {
    const grant = makeGrant({ window: true });
    const result = checkWindowAllowed(grant, 'close', { ownWindow: false });
    assert.strictEqual(result.ok, true);
  });

  it('allows list / info when window is true', () => {
    const grant = makeGrant({ window: true });
    assert.strictEqual(checkWindowAllowed(grant, 'list').ok, true);
    assert.strictEqual(checkWindowAllowed(grant, 'info').ok, true);
  });
});

// ─── window.create flag ──────────────────────────────────────────────

describe('checkWindowAllowed — open requires create', () => {
  it('rejects open when create is not set', () => {
    const grant = makeGrant({ window: { query: true } });
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://x/' });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /window\.create/i);
    }
  });

  it('allows open when create is true', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://x/' });
    assert.strictEqual(result.ok, true);
  });

  it('rejects open with missing url', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'open', {});
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /url required/i);
    }
  });

  it('rejects open with empty string url', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'open', { url: '' });
    assert.strictEqual(result.ok, false);
  });
});

// ─── window.urls allowlist ───────────────────────────────────────────

describe('checkWindowAllowed — urls prefix allowlist', () => {
  it('allows a URL that matches a prefix', () => {
    const grant = makeGrant({ window: { create: true, urls: ['peek://my-tile/'] } });
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://my-tile/index.html' });
    assert.strictEqual(result.ok, true);
  });

  it('rejects a URL outside the prefix list', () => {
    const grant = makeGrant({ window: { create: true, urls: ['peek://my-tile/'] } });
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://other/index.html' });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not in window\.urls allowlist/i);
      assert.match(result.error, /peek:\/\/other/);
    }
  });

  it('allows any of multiple listed prefixes', () => {
    const grant = makeGrant({
      window: { create: true, urls: ['peek://a/', 'peek://b/', 'peek://c/'] },
    });
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://a/x' }).ok, true);
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://b/y' }).ok, true);
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://c/z' }).ok, true);
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://d/w' }).ok, false);
  });

  it('rejects every open when urls list is empty', () => {
    const grant = makeGrant({ window: { create: true, urls: [] } });
    for (const url of ['peek://x/', 'peek://y/', 'peek://anything/at-all']) {
      const result = checkWindowAllowed(grant, 'open', { url });
      assert.strictEqual(result.ok, false, `expected ${url} to be rejected by empty allowlist`);
    }
  });

  it('treats allowlist as prefix match, not exact', () => {
    const grant = makeGrant({ window: { create: true, urls: ['peek://my-tile/'] } });
    // Prefix match: trailing path is allowed.
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://my-tile/sub/path?q=1' }).ok, true);
    // Including a trailing slash in the declared prefix protects against
    // a sibling like peek://my-tile-x/ from sneaking through.
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://my-tile-x/' }).ok, false);
    // Different scheme: must not match.
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'https://my-tile/' }).ok, false);
  });
});

// ─── close semantics ─────────────────────────────────────────────────

describe('checkWindowAllowed — close', () => {
  it('allows close of own window with capability but no manage flag', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'close', { ownWindow: true });
    assert.strictEqual(result.ok, true);
  });

  it('rejects close of another window without manage flag', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'close', { ownWindow: false });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /window\.manage/i);
    }
  });

  it('allows close of another window with manage flag', () => {
    const grant = makeGrant({ window: { manage: true } });
    const result = checkWindowAllowed(grant, 'close', { ownWindow: false });
    assert.strictEqual(result.ok, true);
  });

  it('rejects close when capability is missing entirely', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkWindowAllowed(grant, 'close', { ownWindow: true });
    assert.strictEqual(result.ok, false);
  });
});

// ─── list / info require query ───────────────────────────────────────

describe('checkWindowAllowed — list/info require query', () => {
  it('rejects list without query flag', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'list');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /window\.query/i);
    }
  });

  it('allows list with query flag', () => {
    const grant = makeGrant({ window: { query: true } });
    assert.strictEqual(checkWindowAllowed(grant, 'list').ok, true);
  });

  it('rejects info without query flag', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'info');
    assert.strictEqual(result.ok, false);
  });

  it('allows info with query flag', () => {
    const grant = makeGrant({ window: { query: true } });
    assert.strictEqual(checkWindowAllowed(grant, 'info').ok, true);
  });
});

// ─── Grant-resolution interop ────────────────────────────────────────

describe('resolveCapabilities — window shape preservation', () => {
  it('expands window: true to {create, query, manage}', () => {
    const grant = resolveCapabilities('t', { window: true }, false);
    const wc = grant.capabilities.window;
    assert.ok(wc && typeof wc === 'object', 'window should be an object after resolution');
    assert.strictEqual((wc as { create: boolean }).create, true);
    assert.strictEqual((wc as { query: boolean }).query, true);
    assert.strictEqual((wc as { manage: boolean }).manage, true);
  });

  it('preserves window object (with urls) across resolution', () => {
    const urls = ['peek://a/', 'peek://b/'];
    const grant = resolveCapabilities('t', { window: { create: true, urls } }, false);
    const wc = grant.capabilities.window;
    assert.ok(wc && typeof wc === 'object', 'window should remain an object');
    assert.deepStrictEqual((wc as { urls: string[] }).urls, urls);
    assert.strictEqual((wc as { create: boolean }).create, true);
  });

  it('checkWindowAllowed honours the urls allowlist on a resolved grant', () => {
    const grant = resolveCapabilities(
      't',
      { window: { create: true, urls: ['peek://ok/'] } },
      false,
    );
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://ok/page' }).ok, true);
    assert.strictEqual(checkWindowAllowed(grant, 'open', { url: 'peek://nope/page' }).ok, false);
  });

  it('resolved grant with urls rejects non-listed URL at IPC enforcement point', () => {
    // End-to-end: a tile manifest with allowlist → resolved grant →
    // IPC handler check → rejection. Demonstrates the full chain.
    const caps: TileCapabilities = { window: { create: true, urls: ['peek://my-tile/'] } };
    const grant = resolveCapabilities('my-tile', caps, false);
    const result = checkWindowAllowed(grant, 'open', { url: 'peek://rogue/evil.html' });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /peek:\/\/rogue/);
    }
  });
});
