/**
 * Unit tests for window-registry.ts pending-window state.
 *
 * Ships the Pending half of the WindowRef union without producing pending
 * refs in production yet. These tests pin down the internal contract —
 * synthetic ID allocation, pending registration, the dual lookup path —
 * so the eventual session-restore-as-pending wiring can rely on it.
 *
 * Pure pending paths only: tests do not exercise BrowserWindow.fromId
 * because there's no main process under ELECTRON_RUN_AS_NODE.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  _resetForTests,
  getAllWindowRefs,
  getWindowRef,
  realize,
  registerPendingWindow,
} from './window-registry.js';
import type { WindowDescriptor } from './window-registry.js';

function makeDescriptor(url = 'https://example.com/'): WindowDescriptor {
  return {
    url,
    key: undefined,
    title: 'Example',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    source: 'peek://test/',
    params: {},
    zOrder: 0,
    focused: false,
  };
}

describe('window-registry: pending windows', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('allocates synthetic IDs from the top of the safe-integer range', () => {
    const ref = registerPendingWindow(makeDescriptor());
    assert.strictEqual(ref.kind, 'pending');
    assert.strictEqual(ref.id, Number.MAX_SAFE_INTEGER);
  });

  it('allocates a fresh ID per registration', () => {
    const a = registerPendingWindow(makeDescriptor('https://a/'));
    const b = registerPendingWindow(makeDescriptor('https://b/'));
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(a.id, Number.MAX_SAFE_INTEGER);
    assert.strictEqual(b.id, Number.MAX_SAFE_INTEGER - 1);
  });

  it('synthetic IDs sort above any realistic Electron ID', () => {
    const ref = registerPendingWindow(makeDescriptor());
    // Electron auto-allocates from 1; even after a long-running process
    // we won't approach 2^52. Any synthetic ID should be > 2^52.
    assert.ok(ref.id > 2 ** 52);
  });

  it('getWindowRef(syntheticId) returns the pending ref', () => {
    const ref = registerPendingWindow(makeDescriptor('https://x/'));
    const looked = getWindowRef(ref.id);
    assert.ok(looked);
    assert.strictEqual(looked.kind, 'pending');
    if (looked.kind === 'pending') {
      assert.strictEqual(looked.descriptor.url, 'https://x/');
    }
  });

  it('getWindowRef(unknownId) returns null', () => {
    assert.strictEqual(getWindowRef(999999999), null);
  });

  it('getAllWindowRefs includes pending refs in registration order', () => {
    const a = registerPendingWindow(makeDescriptor('https://a/'));
    const b = registerPendingWindow(makeDescriptor('https://b/'));
    const all = getAllWindowRefs();
    // We can't assert positions absolutely because live refs (none in
    // this env) would precede pending. Filter to pending and check order.
    const pending = all.filter(r => r.kind === 'pending');
    assert.strictEqual(pending.length, 2);
    assert.strictEqual(pending[0].id, a.id);
    assert.strictEqual(pending[1].id, b.id);
  });

  it('realize() rejects on pending refs when no realizer is registered', async () => {
    const ref = registerPendingWindow(makeDescriptor());
    await assert.rejects(realize(ref), /no realizer registered/);
  });

  it('_resetForTests clears pending state and resets the ID counter', () => {
    const a = registerPendingWindow(makeDescriptor());
    assert.strictEqual(a.id, Number.MAX_SAFE_INTEGER);
    _resetForTests();
    assert.strictEqual(getWindowRef(a.id), null);
    const b = registerPendingWindow(makeDescriptor());
    assert.strictEqual(b.id, Number.MAX_SAFE_INTEGER);
  });
});
