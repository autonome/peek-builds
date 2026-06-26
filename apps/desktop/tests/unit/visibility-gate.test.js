/**
 * Unit tests for renderer/lib/visibility-gate.js — createVisibilityGate().
 *
 * All tests inject a fake document so no browser/Electron env is needed.
 * Run via: node --test tests/unit/visibility-gate.test.js
 * Or as part of the full suite: yarn test:unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { createVisibilityGate } = await import(
  join(__dirname, '../../renderer/lib/visibility-gate.js')
);

// ---------------------------------------------------------------------------
// Fake document factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake document that tracks visibilitychange listeners.
 *
 * @param {boolean} startHidden - initial value for doc.hidden
 * @returns {{ doc, setHidden, emitVisibilityChange }}
 */
const makeFakeDoc = (startHidden = false) => {
  const listeners = [];

  const doc = {
    hidden: startHidden,
    addEventListener: (type, fn) => {
      if (type === 'visibilitychange') listeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  const setHidden = (val) => { doc.hidden = val; };

  const emitVisibilityChange = () => {
    for (const fn of listeners) fn();
  };

  return { doc, setHidden, emitVisibilityChange };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createVisibilityGate: visible document', () => {
  it('calls refreshFn immediately when doc is visible', () => {
    let calls = 0;
    const { doc } = makeFakeDoc(false); // not hidden
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    gated();
    assert.equal(calls, 1, 'should call refreshFn once when visible');
  });

  it('does not set dirty when visible', () => {
    let calls = 0;
    const { doc, setHidden, emitVisibilityChange } = makeFakeDoc(false);
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    gated(); // visible → runs immediately (calls=1)
    setHidden(false);
    emitVisibilityChange(); // still visible, dirty was never set
    assert.equal(calls, 1, 'visibilitychange without prior hidden event should not add a call');
  });
});

describe('createVisibilityGate: hidden document', () => {
  it('does NOT call refreshFn when doc is hidden', () => {
    let calls = 0;
    const { doc } = makeFakeDoc(true); // hidden
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    gated();
    assert.equal(calls, 0, 'should not call refreshFn when hidden');
  });

  it('sets the dirty flag when hidden (deferred call fires on show)', () => {
    let calls = 0;
    const { doc, setHidden, emitVisibilityChange } = makeFakeDoc(true);
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    gated(); // hidden → dirty=true, no call yet
    assert.equal(calls, 0);

    setHidden(false);
    emitVisibilityChange(); // becomes visible → clears dirty, calls refreshFn once
    assert.equal(calls, 1, 'deferred call should fire exactly once on becoming visible');
  });
});

describe('createVisibilityGate: multiple hidden events coalesce', () => {
  it('fires exactly ONE deferred refresh regardless of how many events arrived while hidden', () => {
    let calls = 0;
    const { doc, setHidden, emitVisibilityChange } = makeFakeDoc(true);
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    // Simulate 5 pubsub events arriving while the tile is hidden
    gated();
    gated();
    gated();
    gated();
    gated();
    assert.equal(calls, 0, 'no calls while hidden');

    setHidden(false);
    emitVisibilityChange();
    assert.equal(calls, 1, 'exactly one deferred refresh on becoming visible');
  });

  it('does not re-fire if visibilitychange fires again without new hidden events', () => {
    let calls = 0;
    const { doc, setHidden, emitVisibilityChange } = makeFakeDoc(true);
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    gated(); // dirty=true

    setHidden(false);
    emitVisibilityChange(); // fires once
    emitVisibilityChange(); // dirty was cleared; should not fire again
    assert.equal(calls, 1, 'second visibilitychange with no pending dirty should not fire');
  });
});

describe('createVisibilityGate: becomes visible then hidden again', () => {
  it('correctly defers again after a subsequent hide → show cycle', () => {
    let calls = 0;
    const { doc, setHidden, emitVisibilityChange } = makeFakeDoc(false);
    const { gated } = createVisibilityGate(() => { calls++; }, { doc });

    // Visible: run immediately
    gated();
    assert.equal(calls, 1);

    // Go hidden
    setHidden(true);
    gated(); // deferred
    gated(); // deferred (still just dirty)
    assert.equal(calls, 1, 'no extra calls while hidden');

    // Come back visible
    setHidden(false);
    emitVisibilityChange();
    assert.equal(calls, 2, 'one more call on re-appearing');

    // Another visible call
    gated();
    assert.equal(calls, 3, 'immediate call when already visible');
  });
});

describe('createVisibilityGate: destroy', () => {
  it('removes the visibilitychange listener so no call fires after destroy', () => {
    let calls = 0;
    const { doc, setHidden, emitVisibilityChange } = makeFakeDoc(true);
    const { gated, destroy } = createVisibilityGate(() => { calls++; }, { doc });

    gated(); // dirty=true
    destroy(); // removes listener, clears dirty

    setHidden(false);
    emitVisibilityChange(); // listener is gone; should not fire
    assert.equal(calls, 0, 'no call after destroy even if becoming visible with prior event');
  });
});

describe('createVisibilityGate: no document passthrough', () => {
  it('returns a passthrough (no gating) when doc lacks addEventListener', () => {
    let calls = 0;
    // Pass a doc without addEventListener — triggers the passthrough path
    const { gated } = createVisibilityGate(() => { calls++; }, { doc: null });

    gated();
    assert.equal(calls, 1, 'passthrough: refreshFn called directly when no doc');
  });
});
