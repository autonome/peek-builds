/**
 * Unit tests for the extended strict `tile:window:*` ops.
 *
 * Covers the new ops added alongside the original open/close/list/info/
 * exists/show/hide/set-ignore-mouse surface:
 *   - center / center-all / maximize / fullscreen / set-overlay-focus-target /
 *     set-visible-on-all-workspaces — gated by `window.manage`.
 *   - get-focused-visible-id — gated by `window.query` (read).
 *
 * Imports the pure helper from `tile-window-enforcement.js` so the
 * test runs under plain Node without Electron deps.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { checkWindowAllowed } from './tile-window-enforcement.js';
import type { WindowOp } from './tile-window-enforcement.js';
import { resolveCapabilities } from './tile-manifest.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

function makeGrant(caps: TileCapabilities, builtin = false): CapabilityGrant {
  return resolveCapabilities('test-tile', caps, builtin);
}

// ─── Extended manage-gated ops ───────────────────────────────────────

describe('checkWindowAllowed — extended manage-gated ops', () => {
  const manageOps: WindowOp[] = [
    'center',
    'center-all',
    'maximize',
    'fullscreen',
    'set-overlay-focus-target',
    'set-visible-on-all-workspaces',
  ];

  it('rejects each op when grant is null (invalid token)', () => {
    for (const op of manageOps) {
      const result = checkWindowAllowed(null, op);
      assert.strictEqual(result.ok, false, `op=${op}`);
      if (!result.ok) {
        assert.match(result.error, /invalid token/i, `op=${op}`);
      }
    }
  });

  it('rejects each op when no window capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    for (const op of manageOps) {
      const result = checkWindowAllowed(grant, op);
      assert.strictEqual(result.ok, false, `op=${op}`);
    }
  });

  it('rejects each op when only create is set (no manage)', () => {
    const grant = makeGrant({ window: { create: true } });
    for (const op of manageOps) {
      const result = checkWindowAllowed(grant, op);
      assert.strictEqual(result.ok, false, `op=${op}`);
      if (!result.ok) {
        assert.match(result.error, /window\.manage/i, `op=${op}`);
      }
    }
  });

  it('rejects each op when only query is set (no manage)', () => {
    const grant = makeGrant({ window: { query: true } });
    for (const op of manageOps) {
      const result = checkWindowAllowed(grant, op);
      assert.strictEqual(result.ok, false, `op=${op}`);
    }
  });

  it('allows each op when manage is true', () => {
    const grant = makeGrant({ window: { manage: true } });
    for (const op of manageOps) {
      assert.strictEqual(checkWindowAllowed(grant, op).ok, true, `op=${op}`);
    }
  });

  it('allows each op when window: true (implies manage)', () => {
    const grant = makeGrant({ window: true });
    for (const op of manageOps) {
      assert.strictEqual(checkWindowAllowed(grant, op).ok, true, `op=${op}`);
    }
  });
});

// ─── get-focused-visible-id requires query ──────────────────────────

describe('checkWindowAllowed — get-focused-visible-id requires query', () => {
  it('rejects when grant is null', () => {
    const result = checkWindowAllowed(null, 'get-focused-visible-id');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /invalid token/i);
    }
  });

  it('rejects without window capability', () => {
    const grant = makeGrant({ pubsub: { scopes: ['self'] } });
    const result = checkWindowAllowed(grant, 'get-focused-visible-id');
    assert.strictEqual(result.ok, false);
  });

  it('rejects with only manage (no query)', () => {
    const grant = makeGrant({ window: { manage: true } });
    const result = checkWindowAllowed(grant, 'get-focused-visible-id');
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /window\.query/i);
    }
  });

  it('rejects with only create (no query)', () => {
    const grant = makeGrant({ window: { create: true } });
    const result = checkWindowAllowed(grant, 'get-focused-visible-id');
    assert.strictEqual(result.ok, false);
  });

  it('allows with query flag', () => {
    const grant = makeGrant({ window: { query: true } });
    assert.strictEqual(checkWindowAllowed(grant, 'get-focused-visible-id').ok, true);
  });

  it('allows with window: true (implies query)', () => {
    const grant = makeGrant({ window: true });
    assert.strictEqual(checkWindowAllowed(grant, 'get-focused-visible-id').ok, true);
  });
});
